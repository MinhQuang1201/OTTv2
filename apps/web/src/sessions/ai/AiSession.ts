import type { GameSession, MoveResult, StartGameOptions } from "../contract";
import type { GameEventView, GameSnapshot, Position, Seat } from "../../shared/model/game";
import { LocalSession, type LocalSessionDependencies } from "../local/LocalSession";
import type { CoreMoveChooser } from "../core/gameCoreBridge";
import { DEFAULT_AI_LEVEL, type AiLevel } from "../../shared/model/aiLevel";
import { createAiEngine, type AiEngine } from "./aiEngine";

export interface AiScheduler {
  readonly setTimeout: (handler: () => void, timeout: number) => ReturnType<typeof globalThis.setTimeout>;
  readonly clearTimeout: (handle: ReturnType<typeof globalThis.setTimeout>) => void;
}

export interface AiSessionDependencies {
  readonly local?: LocalSessionDependencies;
  readonly scheduler?: AiScheduler;
  readonly chooseMove?: CoreMoveChooser;
  readonly engine?: AiEngine;
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
  private engine: AiEngine | null;
  private level: AiLevel = DEFAULT_AI_LEVEL;
  private readonly listeners = new Set<() => void>();
  private snapshot: GameSnapshot;
  private humanSeat: Seat = "A";
  private aiSeat: Seat = "B";
  private aiThinking = false;
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private disposed = false;
  private runId = 0;
  private unsubscribeLocal: (() => void) | null = null;

  constructor(deps: AiSessionDependencies = {}) {
    this.local = new LocalSession(deps.local);
    this.scheduler = deps.scheduler ?? schedulerDefaults;
    this.chooseMove = deps.chooseMove;
    this.delayMs = deps.delayMs ?? 320;
    this.engine = deps.engine ?? null;
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
    this.level = options.level ?? DEFAULT_AI_LEVEL;
    const currentTurn = options.practice?.coreState.turn ?? "A";
    this.humanSeat = options.humanSeat ?? currentTurn;
    this.aiSeat = this.humanSeat === "A" ? "B" : "A";
    const names: [string, string] = this.humanSeat === "A"
      ? [options.playerName.trim() || "Người chơi", "Máy"]
      : ["Máy", options.playerName.trim() || "Người chơi"];
    await this.local.start({ mode: "local", playerNames: names, practice: options.practice });
    if (this.local.getSnapshot().phase === "error") {
      this.aiThinking = false;
      this.snapshot = this.decorate(this.local.getSnapshot());
      this.publish();
      return;
    }
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
    this.engine?.dispose();
    this.engine = null;
    this.unsubscribeLocal?.();
    this.unsubscribeLocal = null;
    this.local.dispose();
    this.listeners.clear();
  }

  private decorate(snapshot: GameSnapshot): GameSnapshot {
    const viewerSeat = snapshot.phase === "playing" || snapshot.phase === "finished" ? this.humanSeat : null;
    return Object.freeze({
      ...snapshot,
      mode: "ai" as const,
      viewer: viewerSeat === null ? null : { role: "player" as const, seat: viewerSeat },
      viewerSeat,
      capabilities: viewerSeat === null ? { canMove: false, canLeaveGame: false, canSpectate: false } : { canMove: true, canLeaveGame: false, canSpectate: false },
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
    const run = this.runId;
    if (this.disposed || !this.aiThinking || this.snapshot.phase !== "playing" || this.snapshot.turn !== this.aiSeat) {
      this.aiThinking = false;
      this.snapshot = this.decorate(this.local.getSnapshot());
      if (!this.disposed) this.publish();
      return;
    }
    let move;
    if (this.chooseMove) {
      move = this.local.chooseMove(this.aiSeat, this.chooseMove);
    } else {
      this.engine ??= createAiEngine();
      const engine = this.engine;
      const level = this.level;
      move = await this.local.chooseMoveAsync(this.aiSeat, (state, seat) => engine.choose(state, seat, level));
    }
    if (this.disposed || run !== this.runId) return;
    // A lost or rejected answer must not leave the AI seat stuck on its turn.
    if (!move) move = this.inlineMove();
    let result = move ? await this.local.move(move.from, move.to) : null;
    if (this.disposed || run !== this.runId) return;
    if (result && !result.accepted) {
      const fallback = this.inlineMove();
      if (fallback) result = await this.local.move(fallback.from, fallback.to);
    }
    this.aiThinking = false;
    this.snapshot = this.decorate(this.local.getSnapshot());
    if (!this.disposed) this.publish();
  }

  private inlineMove() {
    const ai = globalThis.OTT_AI;
    if (!ai) return null;
    const level = this.level;
    return this.local.chooseMove(this.aiSeat, (state, seat) => ai.chooseMove(state, seat, { level }));
  }

  private cancelAi(): void {
    this.runId += 1;
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
