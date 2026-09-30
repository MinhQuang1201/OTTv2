import type { GameSession, MoveResult, StartGameOptions } from "../contract";
import type { GameSnapshot, Position, SessionErrorView } from "../../shared/model/game";
import { OnlineLobbyGateway } from "../online/OnlineLobbyGateway";
import type { PlayhtmlGameClientLike, PlayhtmlSpectatorAllocation } from "../online/globals";
import { normalizeOnlineState, type OnlineRawState, type OnlineStateMessage } from "../online/normalizeOnlineState";
import { createRuntimeBridge, type RuntimeBridge } from "../online/runtimeBridge";

export interface SpectatorSessionDependencies {
  readonly gateway?: OnlineLobbyGateway;
  readonly runtime?: RuntimeBridge;
  readonly clientFactory?: (options: Record<string, unknown>) => PlayhtmlGameClientLike;
  readonly now?: () => number;
  readonly performanceNow?: () => number;
  readonly setInterval?: (handler: () => void, timeout: number) => ReturnType<typeof globalThis.setInterval>;
  readonly clearInterval?: (handle: ReturnType<typeof globalThis.setInterval>) => void;
  readonly setTimeout?: (handler: () => void, timeout: number) => ReturnType<typeof globalThis.setTimeout>;
  readonly clearTimeout?: (handle: ReturnType<typeof globalThis.setTimeout>) => void;
  readonly tickMs?: number;
  readonly host?: string;
  /** App-managed sessions leave shared runtime disposal to their lifecycle owner. */
  readonly disposeRuntime?: boolean;
}

const initialSnapshot: GameSnapshot = Object.freeze({
  mode: "spectator",
  phase: "idle",
  boardRevision: 0,
  viewer: { role: "spectator" as const },
  viewerSeat: null,
  capabilities: { canMove: false, canLeaveGame: false, canSpectate: true },
  spectatorCount: 0,
  turn: null,
  board: [],
  players: {},
  connection: "offline",
  pendingMove: false,
  aiThinking: false,
  roomId: null,
  waitingRooms: [],
  publicMatches: [],
  result: null,
  events: [],
  error: null,
});

const error = (code: SessionErrorView["code"], message: string, retryable = false): SessionErrorView => ({ code, message, retryable });
const ticketRequestCancelled = Symbol("ticket-request-cancelled");

function isValidSpectatorAllocation(value: unknown): value is PlayhtmlSpectatorAllocation {
  if (!value || typeof value !== "object") return false;
  const allocation = value as Record<string, unknown>;
  return typeof allocation.allocationId === "string" && allocation.allocationId.trim().length > 0 &&
    typeof allocation.room === "string" && allocation.room.trim().length > 0 &&
    typeof allocation.ticket === "string" && allocation.ticket.trim().length > 0;
}

export class SpectatorSession implements GameSession {
  private readonly gateway: OnlineLobbyGateway;
  private readonly runtime: RuntimeBridge;
  private readonly clientFactory: NonNullable<SpectatorSessionDependencies["clientFactory"]>;
  private readonly now: () => number;
  private readonly performanceNow: () => number;
  private readonly setIntervalFn: NonNullable<SpectatorSessionDependencies["setInterval"]>;
  private readonly clearIntervalFn: NonNullable<SpectatorSessionDependencies["clearInterval"]>;
  private readonly setTimeoutFn: NonNullable<SpectatorSessionDependencies["setTimeout"]>;
  private readonly clearTimeoutFn: NonNullable<SpectatorSessionDependencies["clearTimeout"]>;
  private readonly tickMs: number;
  private readonly host: string;
  private readonly disposeRuntime: boolean;
  private readonly listeners = new Set<() => void>();
  private clientUnsubscribers: Array<() => void> = [];
  private snapshot: GameSnapshot = initialSnapshot;
  private client: PlayhtmlGameClientLike | null = null;
  private clockTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private lastClockSamplePerf: number | null = null;
  private currentRawState: OnlineRawState | null = null;
  private lastServerRevision = -1;
  private disposed = false;
  private allocationId: string | null = null;
  private roomId: string | null = null;
  private connectionGeneration = 0;
  private clientBindingGeneration = 0;
  private attachedGeneration = -1;
  private hasClosed = false;
  private allocation: PlayhtmlSpectatorAllocation | null = null;
  private inFlightTicketRequest: Promise<unknown> | null = null;
  private ticketRequestEpoch = 0;
  private ticketRetryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private cancelTicketRetry: (() => void) | null = null;
  private startGeneration = 0;
  private startQueue: Promise<void> | null = null;
  private runtimeBound = false;

  constructor(deps: SpectatorSessionDependencies = {}) {
    this.gateway = deps.gateway ?? new OnlineLobbyGateway();
    this.runtime = deps.runtime ?? createRuntimeBridge();
    this.clientFactory = deps.clientFactory ?? ((options) => {
      const Client = globalThis.PlayhtmlGameClient;
      if (!Client) throw new Error("PlayHTML game client is unavailable");
      return new Client(options as any);
    });
    this.now = deps.now ?? (() => Date.now());
    this.performanceNow = deps.performanceNow ?? (() => performance.now());
    this.setIntervalFn = deps.setInterval ?? globalThis.setInterval.bind(globalThis);
    this.clearIntervalFn = deps.clearInterval ?? globalThis.clearInterval.bind(globalThis);
    this.setTimeoutFn = deps.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimeoutFn = deps.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
    this.tickMs = deps.tickMs ?? 250;
    this.host = deps.host ?? globalThis.OTT_PLAYHTML_HOST ?? "";
    this.disposeRuntime = deps.disposeRuntime ?? true;
  }

  getSnapshot(): GameSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }

  getLegalMoves(_from: Position): readonly Position[] {
    return [];
  }

  async move(_from: Position, _to: Position): Promise<MoveResult> {
    return {
      accepted: false,
      error: error("invalid_move", "Khán giả không thể đi quân.", false),
    };
  }

  async leave(): Promise<void> {
    if (this.disposed) return;
    if (this.snapshot.phase !== "finished") {
      this.cleanupTransport();
      this.snapshot = Object.freeze({
        ...this.snapshot,
        phase: "finished",
        connection: "offline",
        pendingMove: false,
      });
      this.publish();
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.startGeneration += 1;
    try {
      this.cleanupTransport();
    } finally {
      this.listeners.clear();
      if (this.disposeRuntime && typeof this.runtime?.dispose === "function") {
        try {
          await this.runtime.dispose();
        } finally {
          this.runtimeBound = false;
        }
      } else {
        this.runtimeBound = false;
      }
    }
  }

  async start(options: StartGameOptions): Promise<void> {
    if (options.mode !== "spectator") {
      throw new Error(`Unsupported mode for SpectatorSession: ${options.mode}`);
    }
    if (this.disposed) return;
    const startGeneration = ++this.startGeneration;
    const resetRuntime = this.runtimeBound;
    this.cleanupTransport();
    const startOperation = async () => {
      if (resetRuntime && this.disposeRuntime && typeof this.runtime?.dispose === "function") {
        try {
          await this.runtime.dispose();
        } finally {
          this.runtimeBound = false;
        }
      }
      return this.startInternal(options, startGeneration);
    };
    const operation = this.startQueue
      ? this.startQueue.catch(() => undefined).then(startOperation)
      : startOperation();
    let tracked!: Promise<void>;
    tracked = operation.catch(() => undefined);
    this.startQueue = tracked;
    void tracked.then(() => {
      if (this.startQueue === tracked) this.startQueue = null;
    });
    return operation;
  }

  private async startInternal(options: StartGameOptions, startGeneration: number): Promise<void> {
    if (this.disposed || startGeneration !== this.startGeneration) return;
    const providedAllocation = "allocation" in options ? options.allocation : null;
    if (!isValidSpectatorAllocation(providedAllocation)) {
      this.snapshot = Object.freeze({
        ...initialSnapshot,
        phase: "error",
        connection: "offline",
        error: error("room_unavailable", "Thông tin phòng xem trận không hợp lệ.", false),
      });
      this.publish();
      return;
    }

    if (!this.host.trim()) {
      this.snapshot = Object.freeze({
        ...initialSnapshot,
        phase: "error",
        connection: "offline",
        error: error("online_unavailable", "PlayHTML host is unavailable.", true),
      });
      this.publish();
      return;
    }
    const connectionStartGeneration = ++this.connectionGeneration;
    this.allocation = providedAllocation;
    this.allocationId = providedAllocation.allocationId.trim();
    this.roomId = providedAllocation.room.trim();
    this.hasClosed = false;
    this.attachedGeneration = -1;
    this.lastServerRevision = -1;

    this.snapshot = Object.freeze({
      ...initialSnapshot,
      phase: "playing",
      roomId: this.roomId,
      connection: "connecting",
    });
    this.publish();

    try {
      this.runtimeBound = true;
      await this.runtime.bootstrap({ host: this.host, room: this.roomId, party: "main" });
    } catch {
      this.runtimeBound = false;
      if (this.disposed || startGeneration !== this.startGeneration || connectionStartGeneration !== this.connectionGeneration || this.allocation !== providedAllocation) return;
      this.snapshot = Object.freeze({
        ...this.snapshot,
        phase: "error",
        connection: "offline",
        error: error("online_unavailable", "Không thể kết nối phòng xem trận.", true),
      });
      this.publish();
      return;
    }

    if (this.disposed || startGeneration !== this.startGeneration || connectionStartGeneration !== this.connectionGeneration || this.allocation !== providedAllocation) return;
    await this.attachValidatedAllocation(providedAllocation, connectionStartGeneration);
  }

  private async attachValidatedAllocation(allocation: PlayhtmlSpectatorAllocation, startGeneration: number): Promise<void> {
    if (this.disposed || startGeneration !== this.connectionGeneration || allocation !== this.allocation || !this.roomId) return;
    const currentGeneration = ++this.connectionGeneration;
    try {
      if (!this.client) {
        this.client = this.clientFactory({
          connectionFactory: () => this.runtime.connectionFactory(),
          playhtmlHost: this.host,
        });
        this.bindClient(this.client);
      }
      const client = this.client as PlayhtmlGameClientLike & {
        attachSpectator?: (alloc: PlayhtmlSpectatorAllocation) => Promise<unknown>;
        spectate?: (ticket: string) => boolean;
        send?: (type: string, payload?: unknown) => boolean;
      };
      await this.attachClient(client, allocation);
    } catch (cause) {
      if (currentGeneration !== this.connectionGeneration || this.disposed) return;
      if (this.isTerminalTicketError(cause)) this.failTerminal();
      else this.failConnection("Không thể gửi yêu cầu xem trận.", true);
      return;
    }

    if (currentGeneration === this.connectionGeneration && !this.disposed) {
      this.attachedGeneration = currentGeneration;
      this.snapshot = Object.freeze({ ...this.snapshot, connection: "online", error: null });
      this.publish();
    }
  }

  private async attachClient(
    client: PlayhtmlGameClientLike & {
      attachSpectator?: (alloc: PlayhtmlSpectatorAllocation) => Promise<unknown>;
      spectate?: (ticket: string) => boolean;
      send?: (type: string, payload?: unknown) => boolean;
    },
    allocation: PlayhtmlSpectatorAllocation,
  ): Promise<void> {
    if (typeof client.attachSpectator === "function") {
      if (await client.attachSpectator(allocation) !== true) throw new Error("Spectator attach was not accepted");
      return;
    }
    if (typeof client.spectate === "function") {
      if (client.spectate(allocation.ticket) !== true) throw new Error("Spectator command was not accepted");
      return;
    }
    if (typeof client.send === "function") {
      if (client.send("spectate", { roomId: allocation.room, ticket: allocation.ticket }) !== true) throw new Error("Spectator command was not accepted");
      return;
    }
    throw new Error("Spectator client API is unavailable");
  }

  private async connectWithTicket(): Promise<void> {
    if (this.disposed || !this.allocationId || !this.roomId) return;
    const currentGeneration = ++this.connectionGeneration;

    let ticketAllocation: unknown;
    try {
      ticketAllocation = await this.requestTicket();
    } catch (cause) {
      if (cause === ticketRequestCancelled) return;
      if (currentGeneration !== this.connectionGeneration || this.disposed) return;
      if (this.isTerminalTicketError(cause)) {
        this.failTerminal();
      } else {
        this.failConnection("Không thể kết nối phòng xem trận.", true);
      }
      return;
    }

    if (currentGeneration !== this.connectionGeneration || this.disposed) return;

    const ticketObject = ticketAllocation && typeof ticketAllocation === "object" ? ticketAllocation as Record<string, unknown> : null;
    const ticketRoom = typeof ticketObject?.room === "string" ? ticketObject.room : undefined;
    if (
      !ticketObject ||
      ticketObject.allocationId !== this.allocationId ||
      ticketRoom !== this.roomId ||
      typeof ticketObject.ticket !== "string" ||
      !ticketObject.ticket.trim()
    ) {
      this.failTerminal();
      return;
    }

    if (!this.client) {
      try {
        this.client = this.clientFactory({
          connectionFactory: () => this.runtime.connectionFactory(),
          playhtmlHost: this.host,
        });
        this.bindClient(this.client);
      } catch {
        this.failConnection("Không thể khởi tạo kết nối.", true);
        return;
      }
    }

    const client = this.client as PlayhtmlGameClientLike & {
      attachSpectator?: (alloc: PlayhtmlSpectatorAllocation) => Promise<unknown>;
      spectate?: (ticket: string) => boolean;
      send?: (type: string, payload?: unknown) => boolean;
    };

    try {
      await this.attachClient(client, ticketObject as unknown as PlayhtmlSpectatorAllocation);
    } catch (cause) {
      if (currentGeneration !== this.connectionGeneration || this.disposed) return;
      if (this.isTerminalTicketError(cause)) this.failTerminal();
      else this.failConnection("Không thể gửi yêu cầu xem trận.", true);
      return;
    }

    if (currentGeneration === this.connectionGeneration && !this.disposed) {
      this.attachedGeneration = currentGeneration;
      this.snapshot = Object.freeze({
        ...this.snapshot,
        phase: this.snapshot.phase === "error" ? "playing" : this.snapshot.phase,
        connection: "online",
        error: null,
      });
      this.publish();
    }
  }

  private requestTicket(): Promise<unknown> {
    if (this.inFlightTicketRequest) return this.inFlightTicketRequest;
    const requestEpoch = this.ticketRequestEpoch;
    const allocationId = this.allocationId;
    const request = (async () => {
      let attempts = 0;
      while (attempts < 3) {
        attempts++;
        if (requestEpoch !== this.ticketRequestEpoch || this.disposed || allocationId !== this.allocationId) throw ticketRequestCancelled;
        try {
          return await this.gateway.getSpectatorTicket(allocationId!);
        } catch (cause) {
          if (requestEpoch !== this.ticketRequestEpoch || this.disposed || allocationId !== this.allocationId) throw ticketRequestCancelled;
          if (this.isTerminalTicketError(cause) || attempts >= 3) throw cause;
          if (!await this.waitForTicketRetry(requestEpoch, Math.min(50 * Math.pow(2, attempts - 1), 500))) throw ticketRequestCancelled;
        }
      }
      throw new Error("Spectator ticket request failed");
    })();
    this.inFlightTicketRequest = request;
    void request.then(() => {
      if (this.inFlightTicketRequest === request) this.inFlightTicketRequest = null;
    }, () => {
      if (this.inFlightTicketRequest === request) this.inFlightTicketRequest = null;
    });
    return request;
  }

  private waitForTicketRetry(requestEpoch: number, delay: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (allowed: boolean) => {
        if (settled) return;
        settled = true;
        if (this.ticketRetryTimer !== null) {
          try { this.clearTimeoutFn(this.ticketRetryTimer); } catch { /* continue invalidation */ }
          this.ticketRetryTimer = null;
        }
        if (this.cancelTicketRetry === finish) this.cancelTicketRetry = null;
        resolve(allowed && requestEpoch === this.ticketRequestEpoch && !this.disposed);
      };
      this.cancelTicketRetry = () => finish(false);
      this.ticketRetryTimer = this.setTimeoutFn(() => finish(true), delay);
    });
  }

  private isTerminalTicketError(cause: unknown): boolean {
    const err = cause as { status?: unknown; code?: unknown; error?: unknown; message?: unknown } | null;
    const status = typeof err?.status === "number" ? err.status : undefined;
    const code = typeof err?.code === "string" ? err.code : typeof err?.error === "string" ? err.error : undefined;
    const message = typeof err?.message === "string" ? err.message : "";
    return status === 404 || status === 409 || status === 410 ||
      code === "room_unavailable" || code === "not_found" || code === "allocation_not_found" || code === "not_available" || code === "room_closed" ||
      code === "spectate_rejected" ||
      message === "room_unavailable" || message === "not_found" || message === "not_available" || message === "room_closed" || message === "spectate_rejected" || message === "Phòng không khả dụng";
  }

  private failConnection(message: string, retryable: boolean): void {
    this.cleanupTransport();
    this.snapshot = Object.freeze({ ...this.snapshot, phase: "error", connection: "offline", error: error("online_unavailable", message, retryable) });
    this.publish();
  }

  private failTerminal(): void {
    this.cleanupTransport();
    this.snapshot = Object.freeze({
      ...this.snapshot,
      phase: "error",
      connection: "offline",
      error: error("room_unavailable", "Trận đấu không còn khả dụng.", false),
    });
    this.publish();
  }

  private cleanupTransport(): void {
    this.connectionGeneration += 1;
    this.clientBindingGeneration += 1;
    this.attachedGeneration = -1;
    this.hasClosed = false;
    this.ticketRequestEpoch += 1;
    this.cancelTicketRetry?.();
    this.cancelTicketRetry = null;
    this.ticketRetryTimer = null;
    this.inFlightTicketRequest = null;
    this.currentRawState = null;
    this.lastServerRevision = -1;
    this.lastClockSamplePerf = null;
    if (this.clockTimer !== null) {
      try { this.clearIntervalFn(this.clockTimer); } catch { /* continue transport cleanup */ }
    }
    this.clockTimer = null;
    const unsubscribers = this.clientUnsubscribers;
    this.clientUnsubscribers = [];
    for (const unsubscribe of unsubscribers) {
      try { unsubscribe(); } catch { /* continue transport cleanup */ }
    }
    const client = this.client;
    this.client = null;
    try { client?.close(); } catch { /* continue transport cleanup */ }
    this.allocation = null;
    this.allocationId = null;
    this.roomId = null;
  }

  private bindClient(client: PlayhtmlGameClientLike): void {
    const bindingGeneration = ++this.clientBindingGeneration;
    const isCurrentSource = () => !this.disposed && this.client === client && this.clientBindingGeneration === bindingGeneration;
    const bind = (name: string, callback: (payload?: unknown) => void) => {
      const unsubscribe = client.on(name, callback);
      if (typeof unsubscribe === "function") this.clientUnsubscribers.push(unsubscribe);
    };

    bind("open", () => {
      if (!isCurrentSource()) return;
      if (this.disposed || this.snapshot.phase === "finished" || this.snapshot.error?.code === "room_unavailable") return;
      if (this.hasClosed) {
        this.hasClosed = false;
        this.lastServerRevision = -1;
        void this.connectWithTicket();
      } else if (this.attachedGeneration === this.connectionGeneration) {
        this.snapshot = Object.freeze({ ...this.snapshot, connection: "online" });
        this.publish();
      }
    });

    bind("close", () => {
      if (!isCurrentSource()) return;
      if (this.disposed || this.snapshot.phase === "finished" || this.snapshot.error?.code === "room_unavailable") return;
      this.hasClosed = true;
      this.connectionGeneration += 1;
      this.attachedGeneration = -1;
      this.stopClockState();
      this.snapshot = Object.freeze({ ...this.snapshot, connection: "reconnecting" });
      this.publish();
    });

    bind("reconnecting", () => {
      if (!isCurrentSource()) return;
      if (this.disposed || this.snapshot.phase === "finished" || this.snapshot.error?.code === "room_unavailable") return;
      this.stopClockState();
      this.snapshot = Object.freeze({ ...this.snapshot, connection: "reconnecting" });
      this.publish();
    });

    bind("state", (payload) => {
      if (!isCurrentSource()) return;
      this.applyState(payload);
    });

    bind("error", (payload) => {
      if (!isCurrentSource()) return;
      if (this.disposed || this.snapshot.phase === "finished") return;
      let errStr: string | undefined;
      let code: string | undefined;
      let status: number | undefined;

      if (typeof payload === "string") {
        errStr = payload;
      } else if (payload && typeof payload === "object") {
        const errCandidate = payload as Record<string, unknown>;
        if (typeof errCandidate.status === "number") status = errCandidate.status;
        if (typeof errCandidate.code === "string") code = errCandidate.code;
        if (typeof errCandidate.error === "string") errStr = errCandidate.error;
        else if (typeof errCandidate.message === "string") errStr = errCandidate.message;
      }

      const isTerminal =
        status === 404 ||
        status === 409 ||
        status === 410 ||
        code === "room_unavailable" ||
        code === "not_found" ||
        code === "allocation_not_found" ||
        code === "not_available" ||
        code === "room_closed" ||
        code === "spectate_rejected" ||
        errStr === "room_unavailable" ||
        errStr === "not_found" ||
        errStr === "allocation_not_found" ||
        errStr === "not_available" ||
        errStr === "room_closed" ||
        errStr === "Phòng không khả dụng" ||
        errStr === "spectate_rejected";

      if (isTerminal) {
        this.failTerminal();
        return;
      } else {
        this.failConnection("Lỗi kết nối phòng xem trận.", true);
        return;
      }
      this.publish();
    });
  }

  private applyState(payload: unknown): void {
    if (this.disposed || this.snapshot.phase === "finished" || !payload || typeof payload !== "object") return;
    if (this.attachedGeneration !== this.connectionGeneration) return;

    const raw = payload as OnlineStateMessage;
    const incomingRoom = raw.roomId ?? (raw as any).room;
    if (!incomingRoom || incomingRoom !== this.roomId) return;
    if (!raw.viewer || raw.viewer.role !== "spectator" || (raw.viewer as any).seat !== undefined || raw.you !== undefined) return;
    if (typeof raw.revision !== "number" || raw.revision < this.lastServerRevision) return;
    if (raw.revision === this.lastServerRevision) {
      const spectatorCountChanged = raw.spectatorCount !== undefined && raw.spectatorCount !== this.snapshot.spectatorCount;
      const statusChanged = raw.status !== undefined && raw.status !== this.snapshot.phase;
      const playersChanged = Boolean(
        raw.players && (
          (raw.players.A?.connected !== undefined && raw.players.A.connected !== this.snapshot.players.A?.connected) ||
          (raw.players.B?.connected !== undefined && raw.players.B.connected !== this.snapshot.players.B?.connected)
        )
      );
      if (!spectatorCountChanged && !statusChanged && !playersChanged) return;
    }

    const normalized = normalizeOnlineState(raw, this.now());
    if (!normalized) return;

    const nextSnapshot = Object.freeze({
      ...normalized.snapshot,
      mode: "spectator",
      viewer: { role: "spectator" as const },
      viewerSeat: null,
      capabilities: { canMove: false, canLeaveGame: false, canSpectate: true },
      connection: "online",
      roomId: this.roomId,
    });
    this.lastServerRevision = raw.revision;
    this.currentRawState = normalized.rawState;
    this.lastClockSamplePerf = this.performanceNow();
    this.snapshot = nextSnapshot;

    if (nextSnapshot.phase === "finished") {
      this.cleanupTransport();
      this.publish();
      return;
    }

    this.ensureClockTimer();
    this.publish();
  }

  private ensureClockTimer(): void {
    if (this.clockTimer !== null || !this.currentRawState || this.snapshot.connection !== "online") return;
    this.clockTimer = this.setIntervalFn(() => this.tickClocks(), this.tickMs);
  }

  private stopClockState(): void {
    this.lastClockSamplePerf = null;
    this.currentRawState = null;
    if (this.clockTimer !== null) {
      try { this.clearIntervalFn(this.clockTimer); } catch { /* continue connection transition */ }
      this.clockTimer = null;
    }
  }

  private tickClocks(): void {
    if (!this.currentRawState || this.snapshot.phase !== "playing" || this.snapshot.connection !== "online") return;
    const runningSeat = this.currentRawState.clock.runningSeat;
    if (!runningSeat || this.lastClockSamplePerf === null) return;

    const elapsed = Math.max(0, this.performanceNow() - this.lastClockSamplePerf);
    const playerA = this.snapshot.players.A;
    const playerB = this.snapshot.players.B;
    if (!playerA || !playerB) return;

    const remainingA = runningSeat === "A"
      ? Math.max(0, this.currentRawState.clock.remainingMs.A - elapsed)
      : this.currentRawState.clock.remainingMs.A;
    const remainingB = runningSeat === "B"
      ? Math.max(0, this.currentRawState.clock.remainingMs.B - elapsed)
      : this.currentRawState.clock.remainingMs.B;

    this.snapshot = Object.freeze({
      ...this.snapshot,
      players: {
        A: { ...playerA, remainingMs: remainingA },
        B: { ...playerB, remainingMs: remainingB },
      },
    });
    this.publish();
  }
}
