import type { GameSession, MoveResult, StartGameOptions } from "../contract";
import type { GameSnapshot, Position, SessionErrorView } from "../../shared/model/game";
import { OnlineLobbyGateway } from "../online/OnlineLobbyGateway";
import type { PlayhtmlGameClientLike } from "../online/globals";
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
  readonly tickMs?: number;
  readonly host?: string;
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

export class SpectatorSession implements GameSession {
  private readonly gateway: OnlineLobbyGateway;
  private readonly runtime: RuntimeBridge;
  private readonly clientFactory: NonNullable<SpectatorSessionDependencies["clientFactory"]>;
  private readonly now: () => number;
  private readonly performanceNow: () => number;
  private readonly setIntervalFn: NonNullable<SpectatorSessionDependencies["setInterval"]>;
  private readonly clearIntervalFn: NonNullable<SpectatorSessionDependencies["clearInterval"]>;
  private readonly tickMs: number;
  private readonly host: string;
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
  private attachedGeneration = -1;
  private hasClosed = false;

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
    this.tickMs = deps.tickMs ?? 250;
    this.host = deps.host ?? (globalThis.OTT_PLAYHTML_HOST || "http://127.0.0.1:8787");
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
      this.snapshot = Object.freeze({
        ...this.snapshot,
        phase: "finished",
        pendingMove: false,
      });
      this.publish();
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.connectionGeneration += 1;
    this.attachedGeneration = -1;
    this.hasClosed = false;
    if (this.clockTimer !== null) this.clearIntervalFn(this.clockTimer);
    this.clockTimer = null;
    for (const unsubscribe of this.clientUnsubscribers) unsubscribe();
    this.clientUnsubscribers = [];
    try {
      this.client?.close();
    } catch {
      // ignore close errors
    }
    this.client = null;
    this.listeners.clear();
    if (typeof this.runtime?.dispose === "function") {
      await this.runtime.dispose();
    }
  }

  async start(options: StartGameOptions): Promise<void> {
    if (this.disposed) return;
    if (options.mode !== "spectator") {
      throw new Error(`Unsupported mode for SpectatorSession: ${options.mode}`);
    }
    if (
      !options.allocationId ||
      typeof options.allocationId !== "string" ||
      !options.allocationId.trim() ||
      !options.roomId ||
      typeof options.roomId !== "string" ||
      !options.roomId.trim()
    ) {
      this.snapshot = Object.freeze({
        ...initialSnapshot,
        phase: "error",
        connection: "offline",
        error: error("room_unavailable", "Thông tin phòng xem trận không hợp lệ.", false),
      });
      this.publish();
      return;
    }

    this.allocationId = options.allocationId.trim();
    this.roomId = options.roomId.trim();
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
      await this.runtime.bootstrap({ host: this.host, room: this.roomId, party: "main" });
    } catch {
      this.snapshot = Object.freeze({
        ...this.snapshot,
        phase: "error",
        connection: "offline",
        error: error("online_unavailable", "Không thể kết nối phòng xem trận.", true),
      });
      this.publish();
      return;
    }

    await this.connectWithTicket();
  }

  private async connectWithTicket(): Promise<void> {
    if (this.disposed || !this.allocationId || !this.roomId) return;
    const currentGeneration = ++this.connectionGeneration;

    let ticketAllocation;
    let attempts = 0;
    const maxAttempts = 3;
    while (attempts < maxAttempts) {
      attempts++;
      try {
        ticketAllocation = await this.gateway.getSpectatorTicket(this.allocationId);
        break;
      } catch (err: any) {
        if (currentGeneration !== this.connectionGeneration || this.disposed) return;
        const status = typeof err?.status === "number" ? err.status : undefined;
        const code = typeof err?.code === "string" ? err.code : (typeof err?.error === "string" ? err.error : undefined);
        const msg = typeof err?.message === "string" ? err.message : "";
        const isTerminal =
          status === 404 ||
          status === 409 ||
          status === 410 ||
          code === "room_unavailable" ||
          code === "not_found" ||
          code === "allocation_not_found" ||
          code === "not_available" ||
          code === "room_closed" ||
          msg === "room_unavailable" ||
          msg === "not_found" ||
          msg === "not_available" ||
          msg === "room_closed" ||
          msg === "Phòng không khả dụng";

        if (isTerminal || attempts >= maxAttempts) {
          this.snapshot = Object.freeze({
            ...this.snapshot,
            phase: "error",
            connection: "offline",
            error: isTerminal
              ? error("room_unavailable", "Trận đấu không còn khả dụng.", false)
              : error("online_unavailable", "Không thể kết nối phòng xem trận.", true),
          });
          this.publish();
          return;
        }

        const backoffMs = Math.min(50 * Math.pow(2, attempts - 1), 500);
        await new Promise((r) => setTimeout(r, backoffMs));
        if (currentGeneration !== this.connectionGeneration || this.disposed) return;
      }
    }

    if (currentGeneration !== this.connectionGeneration || this.disposed) return;

    const ticketRoom = ticketAllocation?.room ?? (ticketAllocation as any)?.roomId;
    if (
      !ticketAllocation ||
      ticketAllocation.allocationId !== this.allocationId ||
      ticketRoom !== this.roomId ||
      typeof ticketAllocation.ticket !== "string" ||
      !ticketAllocation.ticket.trim()
    ) {
      this.snapshot = Object.freeze({
        ...this.snapshot,
        phase: "error",
        connection: "offline",
        error: error("room_unavailable", "Trận đấu không còn khả dụng.", false),
      });
      this.publish();
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
        this.snapshot = Object.freeze({
          ...this.snapshot,
          phase: "error",
          connection: "offline",
          error: error("online_unavailable", "Không thể khởi tạo kết nối.", true),
        });
        this.publish();
        return;
      }
    }

    const client = this.client as PlayhtmlGameClientLike & {
      attachSpectator?: (alloc: unknown) => Promise<unknown>;
      spectate?: (ticket: string) => boolean;
      send?: (type: string, payload?: unknown) => boolean;
    };

    try {
      if (typeof client.attachSpectator === "function") {
        await client.attachSpectator(ticketAllocation);
      } else if (typeof client.spectate === "function") {
        client.spectate(ticketAllocation.ticket);
      } else if (typeof client.send === "function") {
        client.send("spectate", { roomId: this.roomId, ticket: ticketAllocation.ticket });
      }
    } catch {
      if (currentGeneration !== this.connectionGeneration || this.disposed) return;
      this.snapshot = Object.freeze({
        ...this.snapshot,
        phase: "error",
        connection: "offline",
        error: error("online_unavailable", "Không thể gửi yêu cầu xem trận.", true),
      });
      this.publish();
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

  private bindClient(client: PlayhtmlGameClientLike): void {
    const bind = (name: string, callback: (payload?: unknown) => void) => {
      const unsubscribe = client.on(name, callback);
      if (typeof unsubscribe === "function") this.clientUnsubscribers.push(unsubscribe);
    };

    bind("open", () => {
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
      if (this.disposed || this.snapshot.phase === "finished" || this.snapshot.error?.code === "room_unavailable") return;
      this.hasClosed = true;
      this.connectionGeneration += 1;
      this.attachedGeneration = -1;
      this.snapshot = Object.freeze({ ...this.snapshot, connection: "reconnecting" });
      this.publish();
    });

    bind("reconnecting", () => {
      if (this.disposed || this.snapshot.phase === "finished" || this.snapshot.error?.code === "room_unavailable") return;
      this.snapshot = Object.freeze({ ...this.snapshot, connection: "reconnecting" });
      this.publish();
    });

    bind("state", (payload) => {
      this.applyState(payload);
    });

    bind("error", (payload) => {
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
        this.snapshot = Object.freeze({
          ...this.snapshot,
          phase: "error",
          connection: "offline",
          error: error("room_unavailable", "Trận đấu không còn khả dụng.", false),
        });
      } else {
        this.snapshot = Object.freeze({
          ...this.snapshot,
          phase: "error",
          error: error("online_unavailable", "Lỗi kết nối phòng xem trận.", true),
        });
      }
      this.publish();
    });
  }

  private applyState(payload: unknown): void {
    if (this.disposed || !payload || typeof payload !== "object") return;
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

    this.lastServerRevision = raw.revision;
    this.currentRawState = normalized.rawState;
    this.lastClockSamplePerf = this.performanceNow();

    this.snapshot = Object.freeze({
      ...normalized.snapshot,
      mode: "spectator",
      viewer: { role: "spectator" as const },
      viewerSeat: null,
      capabilities: { canMove: false, canLeaveGame: false, canSpectate: true },
      connection: "online",
      roomId: this.roomId,
    });

    this.ensureClockTimer();
    this.publish();
  }

  private ensureClockTimer(): void {
    if (this.clockTimer !== null || !this.currentRawState) return;
    this.clockTimer = this.setIntervalFn(() => this.tickClocks(), this.tickMs);
  }

  private tickClocks(): void {
    if (!this.currentRawState || this.snapshot.phase !== "playing") return;
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
