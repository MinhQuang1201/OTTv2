import type { GameSession, MoveResult, StartGameOptions } from "../contract";
import type { GameEventView, GameSnapshot, Position, Seat, SessionErrorView } from "../../shared/model/game";
import { getGameCoreBridge, type CoreState, type GameCoreBridge } from "../core/gameCoreBridge";
import { normalizeCoreEvents, normalizeCoreState } from "../core/normalizeCoreState";

export interface LocalSessionDependencies {
  readonly now?: () => number;
  readonly setInterval?: (handler: () => void, timeout: number) => ReturnType<typeof globalThis.setInterval>;
  readonly clearInterval?: (handle: ReturnType<typeof globalThis.setInterval>) => void;
  readonly tickMs?: number;
  readonly bridge?: GameCoreBridge;
}

const failed = (message = "Phiên chơi không khả dụng."): SessionErrorView => ({ code: "session_failed", message, retryable: false });
const invalid = (message = "Nước đi không hợp lệ."): SessionErrorView => ({ code: "invalid_move", message, retryable: false });

export class LocalSession implements GameSession {
  private snapshot: GameSnapshot = normalizeCoreState({ turn: null, winner: null, reason: null, eliminatedPlayer: null, clock: { remainingMs: { A: 0, B: 0 }, runningSeat: null }, pieces: [] }, { mode: "local", phase: "idle", connection: "offline" });
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly setIntervalFn: NonNullable<LocalSessionDependencies["setInterval"]>;
  private readonly clearIntervalFn: NonNullable<LocalSessionDependencies["clearInterval"]>;
  private readonly tickMs: number;
  private readonly bridge: GameCoreBridge;
  private state: CoreState | null = null;
  private names: [string, string] = ["Người chơi Đỏ", "Người chơi Xanh"];
  private timer: ReturnType<typeof globalThis.setInterval> | null = null;
  private lastNow = 0;
  private nextEventId = 1;
  private boardRevision = 0;
  private disposed = false;

  constructor(deps: LocalSessionDependencies = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.setIntervalFn = deps.setInterval ?? ((handler, timeout) => globalThis.setInterval(handler, timeout));
    this.clearIntervalFn = deps.clearInterval ?? ((handle) => globalThis.clearInterval(handle));
    this.tickMs = deps.tickMs ?? 250;
    this.bridge = deps.bridge ?? getGameCoreBridge();
  }

  getSnapshot = (): GameSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async start(options: StartGameOptions): Promise<void> {
    if (this.disposed || options.mode !== "local") return;
    this.clearTimer();
    this.names = [options.playerNames[0].trim() || "Người chơi Đỏ", options.playerNames[1].trim() || "Người chơi Xanh"];
    try {
      this.state = this.bridge.createInitialState();
      this.lastNow = this.now();
      this.boardRevision = 1;
      this.nextEventId = 1;
      this.snapshot = this.makeSnapshot("playing", "A", "offline", [], false);
      this.timer = this.setIntervalFn(() => this.tick(), this.tickMs);
      this.publish();
    } catch {
      this.failSession();
    }
  }

  getLegalMoves(from: Position): readonly Position[] {
    if (this.disposed || !this.state || this.state.winner || this.snapshot.phase !== "playing") return [];
    const piece = this.state.pieces.find((candidate) => candidate.x === from.x && candidate.y === from.y && candidate.player === this.state?.turn);
    if (!piece) return [];
    try { return this.bridge.getLegalMoves(this.state, piece.id); } catch { return []; }
  }

  async move(from: Position, to: Position): Promise<MoveResult> {
    if (this.disposed || !this.state || this.snapshot.phase !== "playing") return { accepted: false, error: failed("Ván đấu không còn hoạt động.") };
    this.tick(false);
    if (!this.state || this.snapshot.phase !== "playing") return { accepted: false, error: failed("Hết thời gian.") };
    const player = this.state.turn;
    if (!player) return { accepted: false, error: invalid() };
    let result;
    try { result = this.bridge.applyMove(this.state, player, from, to); } catch { return { accepted: false, error: failed() }; }
    if (!result.ok || !result.state) return { accepted: false, error: invalid(result.error ?? undefined) };
    this.state = result.state;
    if (this.state.winner) this.clearTimer();
    const events = normalizeCoreEvents(result.events, this.nextEventId);
    this.nextEventId += events.length;
    this.boardRevision += 1;
    this.snapshot = this.makeSnapshot(this.state.winner ? "finished" : "playing", this.state.winner ? null : this.state.turn, "offline", [...this.snapshot.events, ...events], false);
    this.publish();
    return { accepted: true };
  }

  async leave(): Promise<void> {
    if (this.disposed || !this.state || this.snapshot.phase === "finished") return;
    const winner: Seat = this.state.turn === "A" ? "B" : "A";
    const event: GameEventView = { id: this.nextEventId++, type: "win", winner, reason: "leave" };
    this.state = { ...this.state, winner, reason: "leave", clock: { ...this.state.clock, runningSeat: null } };
    this.clearTimer();
    this.boardRevision += 1;
    this.snapshot = this.makeSnapshot("finished", null, "offline", [...this.snapshot.events, event], false);
    this.publish();
  }

  dispose(): void {
    this.clearTimer();
    this.disposed = true;
    this.listeners.clear();
  }

  private tick(publish = true): void {
    if (!this.state || this.disposed) return;
    const now = this.now();
    const elapsed = Math.max(0, Math.floor(now - this.lastNow));
    this.lastNow = now;
    if (elapsed === 0) return;
    let result;
    try { result = this.bridge.elapseClock(this.state, elapsed); } catch { this.failSession(); return; }
    if (!result.state) { this.failSession(); return; }
    this.state = result.state;
    const events = normalizeCoreEvents(result.events, this.nextEventId);
    this.nextEventId += events.length;
    if (events.length) this.boardRevision += 1;
    this.snapshot = this.makeSnapshot(this.state.winner ? "finished" : "playing", this.state.winner ? null : this.state.turn, "offline", [...this.snapshot.events, ...events], false);
    if (this.state.winner) this.clearTimer();
    if (publish) this.publish();
  }

  private makeSnapshot(phase: GameSnapshot["phase"], viewerSeat: Seat | null, connection: GameSnapshot["connection"], events: readonly GameEventView[], pendingMove: boolean): GameSnapshot {
    return normalizeCoreState(this.state!, {
      mode: "local",
      phase,
      viewerSeat,
      connection,
      playerNames: { A: this.names[0], B: this.names[1] },
      playerCounts: { A: this.bridge.countByType(this.state!, "A"), B: this.bridge.countByType(this.state!, "B") },
      boardRevision: this.boardRevision,
      events,
      pendingMove,
    });
  }

  private clearTimer(): void {
    if (this.timer !== null) { this.clearIntervalFn(this.timer); this.timer = null; }
  }

  private failSession(): void {
    this.clearTimer();
    this.snapshot = Object.freeze({ ...this.snapshot, phase: "error", error: Object.freeze(failed()) });
    this.publish();
  }

  private publish(): void {
    if (this.disposed) return;
    for (const listener of [...this.listeners]) listener();
  }
}
