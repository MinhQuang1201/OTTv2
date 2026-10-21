import type { GameSession, MoveResult, StartGameOptions } from "../contract";
import type { GameEventView, GameSnapshot, Position, ResultReason, Seat, SessionErrorView } from "../../shared/model/game";
import { getGameCoreBridge, type CoreState } from "../core/gameCoreBridge";
import { OnlineLobbyGateway } from "./OnlineLobbyGateway";
import type { PlayhtmlAllocation, PlayhtmlGameClientLike } from "./globals";
import { normalizeOnlineState, type OnlineRawState, type OnlineStateMessage, type NormalizedOnlineState } from "./normalizeOnlineState";
import { createRuntimeBridge, type RuntimeBridge } from "./runtimeBridge";
import { isPermanentRoomError, onlineErrorMessage } from "./onlineErrors";
import { normalizeRoomCode } from "./roomCode";
import { resumeStore as defaultResumeStore, type ResumeStore } from "./resumeStore";

export interface OnlineSessionDependencies {
  readonly gateway?: OnlineLobbyGateway;
  readonly runtime?: RuntimeBridge;
  readonly clientFactory?: (options: Record<string, unknown>) => PlayhtmlGameClientLike;
  readonly controlRequest?: (action: string, body?: unknown) => Promise<unknown>;
  readonly now?: () => number;
  readonly performanceNow?: () => number;
  readonly setInterval?: (handler: () => void, timeout: number) => ReturnType<typeof globalThis.setInterval>;
  readonly clearInterval?: (handle: ReturnType<typeof globalThis.setInterval>) => void;
  readonly tickMs?: number;
  readonly setTimeout?: (handler: () => void, timeout: number) => ReturnType<typeof globalThis.setTimeout>;
  readonly clearTimeout?: (handle: ReturnType<typeof globalThis.setTimeout>) => void;
  /** How long to wait for the first authoritative snapshot after an attach before retrying. */
  readonly attachTimeoutMs?: number;
  /** Fresh-ticket retries after an unanswered attach before the session fails with a retryable error. */
  readonly maxAttachRetries?: number;
  readonly resumeStore?: ResumeStore;
  readonly host?: string;
  /** App-managed sessions leave shared runtime disposal to their lifecycle owner. */
  readonly disposeRuntime?: boolean;
}

const initialSnapshot: GameSnapshot = Object.freeze({
  mode: "online", phase: "idle", boardRevision: 0, viewer: null, viewerSeat: null, capabilities: { canMove: false, canLeaveGame: false, canSpectate: false }, spectatorCount: 0, turn: null, board: [], players: {}, connection: "unavailable", pendingMove: false, aiThinking: false, roomId: null, waitingRooms: [], publicMatches: [], result: null, events: [], error: null,
});

const error = (code: SessionErrorView["code"], message: string, retryable = false): SessionErrorView => ({ code, message, retryable });

export const DEFAULT_ATTACH_TIMEOUT_MS = 8_000;
export const DEFAULT_MAX_ATTACH_RETRIES = 2;

function rawCoreState(state: OnlineRawState): CoreState {
  return { turn: state.turn, winner: state.winner, reason: state.reason, eliminatedPlayer: null, clock: state.clock, pieces: state.pieces };
}

export class OnlineSession implements GameSession {
  private readonly gateway: OnlineLobbyGateway;
  private readonly runtime: RuntimeBridge;
  private readonly clientFactory: NonNullable<OnlineSessionDependencies["clientFactory"]>;
  private readonly controlRequestFn: ((action: string, body?: unknown) => Promise<unknown>) | null;
  private readonly now: () => number;
  private readonly performanceNow: () => number;
  private readonly setIntervalFn: NonNullable<OnlineSessionDependencies["setInterval"]>;
  private readonly clearIntervalFn: NonNullable<OnlineSessionDependencies["clearInterval"]>;
  private readonly tickMs: number;
  private readonly setTimeoutFn: NonNullable<OnlineSessionDependencies["setTimeout"]>;
  private readonly clearTimeoutFn: NonNullable<OnlineSessionDependencies["clearTimeout"]>;
  private readonly attachTimeoutMs: number;
  private readonly maxAttachRetries: number;
  private readonly resumeStore: ResumeStore;
  private readonly host: string;
  private readonly disposeRuntime: boolean;
  private readonly listeners = new Set<() => void>();
  private snapshot: GameSnapshot = initialSnapshot;
  private client: PlayhtmlGameClientLike | null = null;
  private allocation: PlayhtmlAllocation | null = null;
  private rawState: OnlineRawState | null = null;
  private serverRevision = -1;
  private lastFingerprint = "";
  private boardRevision = 0;
  private nextEventId = 1;
  private eventIds = new Set<number>();
  private receivedAt = 0;
  private clockTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private attachTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private attachRetries = 0;
  private receivedState = false;
  private playerName = "";
  private roomAlias: string | null = null;
  private clientUnsubscribers: Array<() => void> = [];
  private lifecycleGeneration = 0;
  private clientBindingGeneration = 0;
  private disposed = false;

  constructor(deps: OnlineSessionDependencies = {}) {
    this.gateway = deps.gateway ?? new OnlineLobbyGateway();
    this.runtime = deps.runtime ?? createRuntimeBridge();
    this.clientFactory = deps.clientFactory ?? ((options) => {
      const Constructor = globalThis.PlayhtmlGameClient;
      if (!Constructor) throw new Error("PlayHTML game client is unavailable");
      return new Constructor(options as any);
    });
    this.controlRequestFn = deps.controlRequest ?? (
      typeof (this.gateway as any).resumeRoom === "function" || typeof (this.gateway as any).controlRequest === "function"
        ? async (action: string, body?: unknown) => {
            if (action === "resume") {
              const candidate = body as { allocationId?: string; resumeCredential?: string } | undefined;
              if (typeof candidate?.allocationId === "string" && typeof candidate?.resumeCredential === "string") {
                // The server rotates the credential on every resume; keep the saved game in step.
                const resumed = await this.gateway.resumeRoom(candidate.allocationId, candidate.resumeCredential);
                this.rememberAllocation(resumed);
                return resumed;
              }
            }
            if (typeof (this.gateway as any).controlRequest === "function") {
              return (this.gateway as any).controlRequest(action, body);
            }
            throw new Error(`Unsupported control action: ${action}`);
          }
        : null
    );
    this.now = deps.now ?? (() => Date.now());
    this.performanceNow = deps.performanceNow ?? (() => typeof performance !== "undefined" ? performance.now() : Date.now());
    this.setIntervalFn = deps.setInterval ?? ((handler, timeout) => globalThis.setInterval(handler, timeout));
    this.clearIntervalFn = deps.clearInterval ?? ((handle) => globalThis.clearInterval(handle));
    this.tickMs = deps.tickMs ?? 250;
    this.setTimeoutFn = deps.setTimeout ?? ((handler, timeout) => globalThis.setTimeout(handler, timeout));
    this.clearTimeoutFn = deps.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle));
    this.attachTimeoutMs = deps.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS;
    this.maxAttachRetries = deps.maxAttachRetries ?? DEFAULT_MAX_ATTACH_RETRIES;
    this.resumeStore = deps.resumeStore ?? defaultResumeStore;
    this.host = deps.host ?? globalThis.OTT_PLAYHTML_HOST ?? globalThis.OTT_PLAYHTML_CONTROL_ENDPOINT ?? "";
    this.disposeRuntime = deps.disposeRuntime ?? true;
  }

  getSnapshot = (): GameSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async start(options: StartGameOptions): Promise<void> {
    if (this.disposed || options.mode !== "online") return;
    this.cleanupTransport();
    this.resetRoomState();
    const generation = ++this.lifecycleGeneration;
    if (!this.gateway.available) {
      this.fail(error("online_unavailable", "Online hiện không khả dụng."));
      return;
    }
    this.snapshot = Object.freeze({ ...this.snapshot, phase: "preparing", connection: "connecting", error: null });
    this.publish();
    this.playerName = options.playerName;
    const previousAlias = options.intent === "resume" ? this.resumeStore.read()?.alias ?? null : null;
    try {
      const rawOptions = options as any;
      const isExplicitInvite = rawOptions.intent === "invite" && typeof rawOptions.inviteToken === "string";
      const isRoomIdInvite = options.intent === "join" && normalizeRoomCode(options.roomId).startsWith("inv_");
      const allocation = options.intent === "create"
        ? await this.gateway.createRoom(options.playerName)
        : options.intent === "resume"
          ? await this.gateway.resumeRoom(options.allocationId, options.resumeCredential)
          : isExplicitInvite
            ? await this.gateway.claimSeatInvite(rawOptions.inviteToken, rawOptions.playerName)
            : isRoomIdInvite
              ? await this.gateway.claimSeatInvite(normalizeRoomCode(options.roomId), options.playerName)
              : await this.gateway.joinRoom(options.playerName, options.roomId);
      if (!this.isCurrentGeneration(generation)) return;
      this.roomAlias = allocation.alias ?? previousAlias;
      await this.attach(allocation, generation);
    } catch (cause) {
      if (!this.isCurrentGeneration(generation)) return;
      if (options.intent === "resume" && isPermanentRoomError(cause)) this.resumeStore.clear();
      this.fail(error("connection_failed", onlineErrorMessage(cause, "Không thể kết nối phòng online."), true));
    }
  }

  /** Opens a fresh client for `allocation` and arms the watchdog that waits for the first snapshot. */
  private async attach(allocation: PlayhtmlAllocation, generation: number): Promise<void> {
    this.allocation = allocation;
    this.rememberAllocation(allocation);
    if (!this.host) throw new Error("PlayHTML host is unavailable");
    const client = this.clientFactory({
      connectionFactory: () => this.runtime.connectionFactory(),
      playhtmlBootstrap: (config: { host: string; room: string }) => this.runtime.bootstrap(config),
      playhtmlHost: this.host,
      ...(this.controlRequestFn ? { controlRequest: this.controlRequestFn } : {}),
    });
    if (!this.isCurrentGeneration(generation)) return;
    this.client = client;
    this.bindClient(client, generation);
    if (await client.attachAllocation(allocation) !== true) throw new Error("Online attach was not accepted");
    if (!this.isCurrentGeneration(generation) || this.receivedState) return;
    this.armAttachWatchdog(generation);
  }

  private armAttachWatchdog(generation: number): void {
    this.clearAttachWatchdog();
    this.attachTimer = this.setTimeoutFn(() => {
      this.attachTimer = null;
      void this.retryUnansweredAttach(generation);
    }, this.attachTimeoutMs);
  }

  private clearAttachWatchdog(): void {
    if (this.attachTimer === null) return;
    try { this.clearTimeoutFn(this.attachTimer); } catch { /* the timer is already gone */ }
    this.attachTimer = null;
  }

  /** An attach that never gets a snapshot must not leave the player stuck: retry with a fresh ticket, then fail visibly. */
  private async retryUnansweredAttach(generation: number): Promise<void> {
    if (!this.isCurrentGeneration(generation) || this.receivedState) return;
    const current = this.allocation;
    if (!current || this.attachRetries >= this.maxAttachRetries) {
      this.fail(error("connection_failed", onlineErrorMessage("attach_timeout", "Không kết nối được vào phòng."), true));
      return;
    }
    this.attachRetries += 1;
    this.detachClient();
    try {
      const fresh = await this.gateway.resumeRoom(current.allocationId, current.resumeCredential);
      if (!this.isCurrentGeneration(generation) || this.receivedState) return;
      await this.attach(fresh, generation);
    } catch (cause) {
      if (!this.isCurrentGeneration(generation)) return;
      if (isPermanentRoomError(cause)) this.resumeStore.clear();
      this.fail(error("connection_failed", onlineErrorMessage(cause, "Không kết nối được vào phòng."), true));
    }
  }

  /** Saves what a later page load needs to offer "Vào lại" for this game. */
  private rememberAllocation(allocation: PlayhtmlAllocation): void {
    if (allocation.alias) this.roomAlias = allocation.alias;
    this.resumeStore.write({
      allocationId: allocation.allocationId,
      room: allocation.room,
      seat: allocation.seat,
      resumeCredential: allocation.resumeCredential,
      alias: this.roomAlias,
      playerName: this.playerName,
      savedAt: this.now(),
    });
  }

  getLegalMoves(from: Position): readonly Position[] {
    if (this.disposed || !this.rawState || this.snapshot.phase !== "playing" || !this.snapshot.viewerSeat || this.rawState.turn !== this.snapshot.viewerSeat) return [];
    const piece = this.rawState.pieces.find((item) => item.player === this.snapshot.viewerSeat && item.x === from.x && item.y === from.y);
    if (!piece) return [];
    try { return getGameCoreBridge().getLegalMoves(rawCoreState(this.rawState), piece.id); } catch { return []; }
  }

  async move(from: Position, to: Position): Promise<MoveResult> {
    if (this.disposed || !this.client || this.snapshot.phase !== "playing") return { accepted: false, error: error("invalid_move", "Ván đấu chưa sẵn sàng.") };
    let sent = false;
    try { sent = this.client.move(from, to); } catch { sent = false; }
    if (!sent) return { accepted: false, error: error("invalid_move", "Không thể gửi nước đi.") };
    this.snapshot = Object.freeze({ ...this.snapshot, pendingMove: true });
    this.publish();
    return { accepted: true };
  }

  async leave(): Promise<void> {
    if (this.disposed) return;
    this.resumeStore.clear();
    const client = this.client;
    try { client?.leave(); } catch { /* a closed transport is already left */ }
    // Closing destroys the provider synchronously; without this wait the server only sees a
    // dropped socket and treats a deliberate leave as a disconnect with a 60 s grace.
    try { await client?.flush?.(1_000); } catch { /* close anyway */ }
    if (this.disposed) return;
    this.cleanupTransport();
    this.stopClockTimer();
    if (this.snapshot.phase !== "finished") {
      const winner: Seat | null = this.snapshot.viewerSeat === "A" ? "B" : this.snapshot.viewerSeat === "B" ? "A" : null;
      this.snapshot = Object.freeze({ ...this.snapshot, phase: "finished", turn: null, result: { winner, reason: "leave" as const }, pendingMove: false, connection: "offline" });
      this.publish();
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cleanupTransport();
    this.listeners.clear();
    if (this.disposeRuntime && typeof this.runtime?.dispose === "function") {
      await this.runtime.dispose();
    }
  }

  private bindClient(client: PlayhtmlGameClientLike, lifecycleGeneration: number): void {
    const bindingGeneration = ++this.clientBindingGeneration;
    const isCurrentSource = () => !this.disposed && this.client === client && lifecycleGeneration === this.lifecycleGeneration && bindingGeneration === this.clientBindingGeneration;
    const bind = (name: string, callback: (payload?: unknown) => void) => {
      const unsubscribe = client.on(name, (payload) => {
        if (!isCurrentSource()) return;
        callback(payload);
      });
      if (typeof unsubscribe === "function") this.clientUnsubscribers.push(unsubscribe);
    };
    bind("open", () => this.setConnection("online"));
    bind("close", () => this.setConnection(this.snapshot.phase === "playing" || this.snapshot.phase === "waiting" ? "reconnecting" : "offline"));
    bind("reconnecting", () => this.setConnection("reconnecting"));
    bind("resumed", () => this.setConnection("online"));
    bind("joined", (payload) => {
      const message = payload as Record<string, unknown> | undefined;
      this.snapshot = Object.freeze({ ...this.snapshot, phase: "waiting", connection: "online", roomId: typeof message?.roomId === "string" ? message.roomId : this.allocation?.room ?? null, viewer: null, viewerSeat: null, capabilities: { canMove: false, canLeaveGame: false, canSpectate: false }, error: null });
      this.publish();
    });
    bind("state", (payload) => this.applyState(payload));
    bind("gameover", (payload) => this.applyGameover(payload));
    bind("left", () => { void this.leave(); });
    bind("error", (payload) => {
      const err = payload as Record<string, unknown> | undefined;
      // Recoverable command rejections: the move was not applied and the session stays valid.
      const recoverable = ["stale_revision", "rate_limited"];
      if (recoverable.includes(err?.error as string) || recoverable.includes(err?.code as string)) {
        if (this.snapshot.pendingMove) {
          this.snapshot = Object.freeze({ ...this.snapshot, pendingMove: false });
          this.publish();
        }
        return;
      }
      this.fail(error(this.snapshot.phase === "playing" ? "connection_failed" : "room_unavailable", onlineErrorMessage(payload, "Kết nối online gặp lỗi."), true));
    });
  }

  private applyState(payload: unknown): void {
    if (this.disposed || this.snapshot.phase === "finished" || !this.client || !payload || typeof payload !== "object") return;
    const message = payload as OnlineStateMessage;
    if (!Number.isInteger(message.revision) || message.revision < this.serverRevision) return;
    const isReconnecting = this.snapshot.connection === "reconnecting" || this.snapshot.connection === "connecting";
    const viewerNeedsUpdate = !this.snapshot.viewer || (message.you && this.snapshot.viewerSeat !== message.you);
    if (message.revision === this.serverRevision && !isReconnecting && !viewerNeedsUpdate && this.rawState !== null) {
      const prevA = this.snapshot.players.A?.connected;
      const nextA = message.players?.A?.connected !== false;
      const prevB = this.snapshot.players.B?.connected;
      const nextB = message.players?.B?.connected !== false;
      const prevSpec = this.snapshot.spectatorCount;
      const nextSpec = message.spectatorCount ?? 0;
      if (prevA === nextA && prevB === nextB && prevSpec === nextSpec) {
        return;
      }
    }
    const normalized = normalizeOnlineState(message, this.performanceNow(), this.boardRevision);
    if (!normalized) return;
    this.receivedState = true;
    this.clearAttachWatchdog();
    if (normalized.boardFingerprint !== this.lastFingerprint) this.boardRevision = Math.max(this.boardRevision + 1, normalized.serverRevision);
    this.lastFingerprint = normalized.boardFingerprint;
    this.serverRevision = normalized.serverRevision;
    this.rawState = normalized.rawState;
    this.receivedAt = normalized.receivedAt;
    const newEvents = normalized.snapshot.events.filter((item) => !this.eventIds.has(item.id)).map((item) => {
      this.eventIds.add(item.id);
      this.nextEventId = Math.max(this.nextEventId, item.id + 1);
      return item;
    });
    const resultEvents = [...this.snapshot.events, ...newEvents];
    this.snapshot = Object.freeze({ ...normalized.snapshot, roomAlias: this.roomAlias, boardRevision: this.boardRevision, events: resultEvents, pendingMove: false, connection: "online" });
    if (this.snapshot.phase === "finished") {
      this.resumeStore.clear();
      this.cleanupTransport();
      this.snapshot = Object.freeze({ ...this.snapshot, connection: "offline" });
    } else {
      this.startClockTimer();
    }
    this.publish();
  }

  private applyGameover(payload: unknown): void {
    if (payload && typeof payload === "object" && (payload as Record<string, unknown>).state) this.applyState(payload);
    if (this.snapshot.phase === "finished") return;
    const value = payload as Record<string, unknown> | undefined;
    const winner = value?.winner === "A" || value?.winner === "B" ? value.winner : this.snapshot.result?.winner ?? null;
    const reason = value?.reason as ResultReason | undefined;
    if (reason !== "goal" && reason !== "elimination" && reason !== "no_moves" && reason !== "timeout" && reason !== "disconnect_timeout" && reason !== "leave") return;
    const event: GameEventView = { id: this.nextEventId++, type: "win", winner: winner ?? "A", reason };
    this.snapshot = Object.freeze({ ...this.snapshot, phase: "finished", turn: null, result: { winner, reason }, events: [...this.snapshot.events, event], pendingMove: false });
    this.resumeStore.clear();
    this.cleanupTransport();
    this.snapshot = Object.freeze({ ...this.snapshot, connection: "offline" });
    this.publish();
  }

  private startClockTimer(): void {
    if (this.clockTimer !== null) return;
    this.clockTimer = this.setIntervalFn(() => this.publishDisplayClock(), this.tickMs);
  }

  private publishDisplayClock(): void {
    if (!this.rawState || this.snapshot.connection !== "online" || this.snapshot.phase !== "playing") return;
    const elapsed = Math.max(0, Math.floor(this.performanceNow() - this.receivedAt));
    const runningSeat = this.rawState.clock.runningSeat;
    const remainingMs = { A: this.rawState.clock.remainingMs.A, B: this.rawState.clock.remainingMs.B };
    if (runningSeat) remainingMs[runningSeat] = Math.max(0, remainingMs[runningSeat] - elapsed);
    this.snapshot = Object.freeze({ ...this.snapshot, players: { A: this.snapshot.players.A ? { ...this.snapshot.players.A, remainingMs: remainingMs.A } : undefined, B: this.snapshot.players.B ? { ...this.snapshot.players.B, remainingMs: remainingMs.B } : undefined } });
    this.publish();
  }

  private setConnection(connection: GameSnapshot["connection"]): void {
    if (this.disposed) return;
    if (connection !== "online") {
      this.stopClockTimer();
      this.rawState = null;
    }
    this.snapshot = Object.freeze({ ...this.snapshot, connection });
    if (connection === "online" && this.snapshot.phase === "playing") this.startClockTimer();
    this.publish();
  }

  private fail(sessionError: SessionErrorView): void {
    if (this.disposed) return;
    this.cleanupTransport();
    this.snapshot = Object.freeze({ ...this.snapshot, phase: "error", connection: "unavailable", viewer: null, viewerSeat: null, capabilities: { canMove: false, canLeaveGame: false, canSpectate: false }, error: sessionError, pendingMove: false });
    this.publish();
  }

  private stopClockTimer(): void {
    if (this.clockTimer !== null) {
      try { this.clearIntervalFn(this.clockTimer); } catch { /* continue transport cleanup */ }
      this.clockTimer = null;
    }
  }

  private cleanupTransport(): void {
    this.lifecycleGeneration += 1;
    this.stopClockTimer();
    this.allocation = null;
    this.rawState = null;
    this.receivedAt = 0;
    this.detachClient();
  }

  /** Drops the current client without ending the session lifecycle (used for attach retries). */
  private detachClient(): void {
    this.clientBindingGeneration += 1;
    this.clearAttachWatchdog();
    const unsubscribers = this.clientUnsubscribers;
    this.clientUnsubscribers = [];
    for (const unsubscribe of unsubscribers) {
      try { unsubscribe(); } catch { /* continue transport cleanup */ }
    }
    const client = this.client;
    this.client = null;
    try { client?.close(); } catch { /* continue transport cleanup */ }
  }

  private resetRoomState(): void {
    this.allocation = null;
    this.rawState = null;
    this.serverRevision = -1;
    this.lastFingerprint = "";
    this.boardRevision = 0;
    this.nextEventId = 1;
    this.eventIds.clear();
    this.receivedAt = 0;
    this.attachRetries = 0;
    this.receivedState = false;
    this.roomAlias = null;
    this.snapshot = initialSnapshot;
  }

  private isCurrentGeneration(generation: number): boolean {
    return !this.disposed && generation === this.lifecycleGeneration;
  }

  private publish(): void {
    if (this.disposed) return;
    for (const listener of [...this.listeners]) listener();
  }
}
