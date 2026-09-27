import type { GameSession, MoveResult, StartGameOptions } from "../contract";
import type { GameEventView, GameSnapshot, Position, Seat } from "../../shared/model/game";
import { LocalSession, type LocalSessionDependencies } from "../local/LocalSession";
import type { CoreMoveChooser } from "../core/gameCoreBridge";

export interface AiScheduler {
  readonly setTimeout: (handler: () => void, timeout: number) => ReturnType<typeof globalThis.setTimeout>;
  readonly clearTimeout: (handle: ReturnType<typeof globalThis.setTimeout>) => void;
}

export interface AiSessionDependencies {
  readonly local?: LocalSessionDependencies;
  readonly scheduler?: AiScheduler;
  readonly chooseMove?: CoreMoveChooser;
  readonly delayMs?: number;
}

const schedulerDefaults: AiScheduler = {
  setTimeout: (handler, timeout) => globalThis.setTimeout(handler, timeout),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

const failed = (message: string): MoveResult => ({
  accepted: false,
  error: { code: "session_failed", message, retryable: false },
});

export class AiSession implements GameSession {
  private readonly local: LocalSession;
  private readonly scheduler: AiScheduler;
  private readonly chooseMove?: CoreMoveChooser;
  private readonly delayMs: number;
  private readonly listeners = new Set<() => void>();
  private snapshot: GameSnapshot;
  private humanSeat: Seat = "A";
  private aiSeat: Seat = "B";
  private aiThinking = false;
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private disposed = false;
  private unsubscribeLocal: (() => void) | null = null;

  constructor(deps: AiSessionDependencies = {}) {
    this.local = new LocalSession(deps.local);
    this.scheduler = deps.scheduler ?? schedulerDefaults;
    this.chooseMove = deps.chooseMove;
    this.delayMs = deps.delayMs ?? 320;
    this.snapshot = this.decorate(this.local.getSnapshot());
    this.unsubscribeLocal = this.local.subscribe(() => {
      this.snapshot = this.decorate(this.local.getSnapshot());
      this.publish();
    });
  }

  getSnapshot = (): GameSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async start(options: StartGameOptions): Promise<void> {
    if (this.disposed || options.mode !== "ai") return;
    this.cancelAi();
    this.humanSeat = options.humanSeat ?? "A";
    this.aiSeat = this.humanSeat === "A" ? "B" : "A";
    const names: [string, string] = this.humanSeat === "A"
      ? [options.playerName.trim() || "Người chơi", "Máy"]
      : ["Máy", options.playerName.trim() || "Người chơi"];
    await this.local.start({ mode: "local", playerNames: names });
    this.aiThinking = this.local.getSnapshot().turn === this.aiSeat;
    this.snapshot = this.decorate(this.local.getSnapshot());
    this.publish();
    this.scheduleIfNeeded();
  }

  getLegalMoves(from: Position): readonly Position[] {
    if (this.disposed || this.aiThinking || this.snapshot.phase !== "playing" || this.snapshot.turn !== this.humanSeat) return [];
    return this.local.getLegalMoves(from);
  }

  async move(from: Position, to: Position): Promise<MoveResult> {
    if (this.disposed || this.snapshot.phase !== "playing") return failed("Ván đấu không còn hoạt động.");
    if (this.aiThinking || this.snapshot.turn !== this.humanSeat) return failed("Chưa tới lượt của bạn.");
    const result = await this.local.move(from, to);
    if (!result.accepted) return result;
    if (this.local.getSnapshot().phase !== "finished") {
      this.aiThinking = true;
      this.snapshot = this.decorate(this.local.getSnapshot());
      this.publish();
      this.scheduleIfNeeded();
    }
    return result;
  }

  async leave(): Promise<void> {
    if (this.disposed) return;
    this.cancelAi();
    await this.local.leave();
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelAi();
    this.disposed = true;
    this.unsubscribeLocal?.();
    this.unsubscribeLocal = null;
    this.local.dispose();
    this.listeners.clear();
  }

  private decorate(snapshot: GameSnapshot): GameSnapshot {
    return Object.freeze({
      ...snapshot,
      mode: "ai" as const,
      viewerSeat: this.humanSeat,
      aiThinking: this.aiThinking,
      pendingMove: snapshot.pendingMove || this.aiThinking,
    });
  }

  private scheduleIfNeeded(): void {
    if (this.disposed || this.timer !== null || !this.aiThinking || this.snapshot.phase !== "playing" || this.snapshot.turn !== this.aiSeat) return;
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      void this.runAiMove();
    }, this.delayMs);
  }

  private async runAiMove(): Promise<void> {
    if (this.disposed || !this.aiThinking || this.snapshot.phase !== "playing" || this.snapshot.turn !== this.aiSeat) {
      this.aiThinking = false;
      this.snapshot = this.decorate(this.local.getSnapshot());
      if (!this.disposed) this.publish();
      return;
    }
    const move = this.local.chooseMove(this.aiSeat, this.chooseMove);
    if (!move) {
      this.aiThinking = false;
      this.snapshot = this.decorate(this.local.getSnapshot());
      this.publish();
      return;
    }
    const result = await this.local.move(move.from, move.to);
    this.aiThinking = false;
    this.snapshot = this.decorate(this.local.getSnapshot());
    if (!this.disposed) this.publish();
    if (!result.accepted && this.snapshot.phase === "playing") this.scheduleIfNeeded();
  }

  private cancelAi(): void {
    if (this.timer !== null) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = null;
    }
    this.aiThinking = false;
    if (!this.disposed) this.snapshot = this.decorate(this.local.getSnapshot());
  }

  private publish(): void {
    if (this.disposed) return;
    for (const listener of [...this.listeners]) listener();
  }
}
