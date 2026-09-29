import type { GameSession, MoveResult, StartGameOptions } from "../contract";
import type { GameEventView, GameSnapshot, Position, ResultReason, Seat, SessionErrorView } from "../../shared/model/game";
import { getGameCoreBridge, type CoreState } from "../core/gameCoreBridge";
import { OnlineLobbyGateway } from "./OnlineLobbyGateway";
import type { PlayhtmlAllocation, PlayhtmlGameClientLike } from "./globals";
import { normalizeOnlineState, type OnlineRawState, type OnlineStateMessage, type NormalizedOnlineState } from "./normalizeOnlineState";
import { createRuntimeBridge, type RuntimeBridge } from "./runtimeBridge";

export interface OnlineSessionDependencies {
  readonly gateway?: OnlineLobbyGateway;
  readonly runtime?: RuntimeBridge;
  readonly clientFactory?: (options: Record<string, unknown>) => PlayhtmlGameClientLike;
  readonly now?: () => number;
  readonly performanceNow?: () => number;
  readonly setInterval?: (handler: () => void, timeout: number) => ReturnType<typeof globalThis.setInterval>;
  readonly clearInterval?: (handle: ReturnType<typeof globalThis.setInterval>) => void;
  readonly tickMs?: number;
  readonly host?: string;
}

const initialSnapshot: GameSnapshot = Object.freeze({
  mode: "online", phase: "idle", boardRevision: 0, viewer: null, viewerSeat: null, capabilities: { canMove: false, canLeaveGame: false, canSpectate: false }, spectatorCount: 0, turn: null, board: [], players: {}, connection: "unavailable", pendingMove: false, aiThinking: false, roomId: null, waitingRooms: [], publicMatches: [], result: null, events: [], error: null,
});

const error = (code: SessionErrorView["code"], message: string, retryable = false): SessionErrorView => ({ code, message, retryable });

function clientMessage(payload: unknown, fallback: string): string {
  return payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).message === "string" ? (payload as Record<string, string>).message : fallback;
}

function rawCoreState(state: OnlineRawState): CoreState {
  return { turn: state.turn, winner: state.winner, reason: state.reason, eliminatedPlayer: null, clock: state.clock, pieces: state.pieces };
}

export class OnlineSession implements GameSession {
  private readonly gateway: OnlineLobbyGateway;
  private readonly runtime: RuntimeBridge;
  private readonly clientFactory: NonNullable<OnlineSessionDependencies["clientFactory"]>;
  private readonly now: () => number;
  private readonly performanceNow: () => number;
  private readonly setIntervalFn: NonNullable<OnlineSessionDependencies["setInterval"]>;
  private readonly clearIntervalFn: NonNullable<OnlineSessionDependencies["clearInterval"]>;
  private readonly tickMs: number;
  private readonly host: string;
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
  private clientUnsubscribers: Array<() => void> = [];
  private disposed = false;

  constructor(deps: OnlineSessionDependencies = {}) {
    this.gateway = deps.gateway ?? new OnlineLobbyGateway();
    this.runtime = deps.runtime ?? createRuntimeBridge();
    this.clientFactory = deps.clientFactory ?? ((options) => {
      const Constructor = globalThis.PlayhtmlGameClient;
      if (!Constructor) throw new Error("PlayHTML game client is unavailable");
      return new Constructor(options as any);
    });
    this.now = deps.now ?? (() => Date.now());
    this.performanceNow = deps.performanceNow ?? (() => typeof performance !== "undefined" ? performance.now() : Date.now());
    this.setIntervalFn = deps.setInterval ?? ((handler, timeout) => globalThis.setInterval(handler, timeout));
    this.clearIntervalFn = deps.clearInterval ?? ((handle) => globalThis.clearInterval(handle));
    this.tickMs = deps.tickMs ?? 250;
    this.host = deps.host ?? globalThis.OTT_PLAYHTML_HOST ?? globalThis.OTT_PLAYHTML_CONTROL_ENDPOINT ?? "";
  }

  getSnapshot = (): GameSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async start(options: StartGameOptions): Promise<void> {
    if (this.disposed || options.mode !== "online") return;
    if (!this.gateway.available) {
      this.fail(error("online_unavailable", "Online hiện không khả dụng."));
      return;
    }
    this.snapshot = Object.freeze({ ...this.snapshot, phase: "preparing", connection: "connecting", error: null });
    this.publish();
    try {
      this.allocation = options.intent === "create"
        ? await this.gateway.createRoom(options.playerName)
        : await this.gateway.joinRoom(options.playerName, options.roomId);
      if (this.disposed) return;
      if (!this.host) throw new Error("PlayHTML host is unavailable");
      this.client = this.clientFactory({
        connectionFactory: () => this.runtime.connectionFactory(),
        playhtmlBootstrap: (config: { host: string; room: string }) => this.runtime.bootstrap(config),
        playhtmlHost: this.host,
      });
      this.bindClient(this.client);
      await this.client.attachAllocation(this.allocation);
      if (this.disposed) return;
    } catch (cause) {
      this.fail(error("connection_failed", clientMessage(cause, "Không thể kết nối phòng online."), true));
    }
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
    try { this.client?.leave(); } catch { /* a closed transport is already left */ }
    if (this.snapshot.phase !== "finished") {
      const winner: Seat | null = this.snapshot.viewerSeat === "A" ? "B" : this.snapshot.viewerSeat === "B" ? "A" : null;
      this.snapshot = Object.freeze({ ...this.snapshot, phase: "finished", turn: null, result: { winner, reason: "leave" as const }, pendingMove: false, connection: "offline" });
      this.publish();
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.clockTimer !== null) this.clearIntervalFn(this.clockTimer);
    this.clockTimer = null;
    for (const unsubscribe of this.clientUnsubscribers) unsubscribe();
    this.clientUnsubscribers = [];
    try { this.client?.close(); } catch { /* ignore close errors */ }
    this.client = null;
    this.listeners.clear();
    if (typeof this.runtime?.dispose === "function") {
      await this.runtime.dispose();
    }
  }

  private bindClient(client: PlayhtmlGameClientLike): void {
    const bind = (name: string, callback: (payload?: unknown) => void) => {
      const unsubscribe = client.on(name, callback);
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
    bind("error", (payload) => this.fail(error(this.snapshot.phase === "playing" ? "connection_failed" : "room_unavailable", clientMessage(payload, "Kết nối online gặp lỗi."), true)));
  }

  private applyState(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const message = payload as OnlineStateMessage;
    if (!Number.isInteger(message.revision) || message.revision <= this.serverRevision) return;
    const normalized = normalizeOnlineState(message, this.performanceNow(), this.boardRevision);
    if (!normalized) return;
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
    this.snapshot = Object.freeze({ ...normalized.snapshot, boardRevision: this.boardRevision, events: resultEvents, pendingMove: false, connection: "online" });
    this.startClockTimer();
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
    this.publish();
  }

  private startClockTimer(): void {
    if (this.clockTimer !== null) return;
    this.clockTimer = this.setIntervalFn(() => this.publishDisplayClock(), this.tickMs);
  }

  private publishDisplayClock(): void {
    if (!this.rawState || this.snapshot.connection !== "online" || this.snapshot.phase === "finished") return;
    const elapsed = Math.max(0, Math.floor(this.performanceNow() - this.receivedAt));
    const runningSeat = this.rawState.clock.runningSeat;
    const remainingMs = { A: this.rawState.clock.remainingMs.A, B: this.rawState.clock.remainingMs.B };
    if (runningSeat) remainingMs[runningSeat] = Math.max(0, remainingMs[runningSeat] - elapsed);
    this.snapshot = Object.freeze({ ...this.snapshot, players: { A: this.snapshot.players.A ? { ...this.snapshot.players.A, remainingMs: remainingMs.A } : undefined, B: this.snapshot.players.B ? { ...this.snapshot.players.B, remainingMs: remainingMs.B } : undefined } });
    this.publish();
  }

  private setConnection(connection: GameSnapshot["connection"]): void {
    if (this.disposed) return;
    this.snapshot = Object.freeze({ ...this.snapshot, connection });
    this.publish();
  }

  private fail(sessionError: SessionErrorView): void {
    if (this.disposed) return;
    this.snapshot = Object.freeze({ ...this.snapshot, phase: "error", connection: "unavailable", viewer: null, viewerSeat: null, capabilities: { canMove: false, canLeaveGame: false, canSpectate: false }, error: sessionError, pendingMove: false });
    this.publish();
  }

  private publish(): void {
    if (this.disposed) return;
    for (const listener of [...this.listeners]) listener();
  }
}
