import type {
  GameSession,
  MoveResult,
  ReplayPlaybackFacade,
  ReplayPlaybackView,
  ReplaySpeed,
  StartGameOptions,
} from "../contract";
import type { GameSnapshot, Position } from "../../shared/model/game";
import type { ReplayDocument } from "../../../../../packages/arena/src/contracts/index.d.mts";
import { validateReplayDocument } from "../../../../../packages/arena/src/contracts/index.mjs";
import { createReplaySnapshot, deepFreeze, INITIAL_REPLAY_SNAPSHOT } from "./replaySnapshot";

export interface ReplaySessionDependencies {
  readonly setTimeout?: (handler: () => void, timeout: number) => ReturnType<typeof globalThis.setTimeout>;
  readonly clearTimeout?: (handle: ReturnType<typeof globalThis.setTimeout>) => void;
  readonly baseIntervalMs?: number;
}

export const INITIAL_PLAYBACK_VIEW: ReplayPlaybackView = deepFreeze({
  cursor: 0,
  maxCursor: 0,
  isPlaying: false,
  speed: 1,
  result: null,
  isAtStart: true,
  isAtEnd: true,
  currentPly: 0,
  totalPlies: 0,
  lastMove: null,
});

export class ReplaySession implements GameSession, ReplayPlaybackFacade {
  private document: ReplayDocument | null = null;
  private cursor = 0;
  private maxCursor = 0;
  private isPlaying = false;
  private speed: ReplaySpeed = 1;
  private boardRevision = 0;
  private playbackGeneration = 0;
  private playbackTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private disposed = false;
  private snapshot: GameSnapshot = INITIAL_REPLAY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();

  private readonly setTimeoutFn: (handler: () => void, timeout: number) => ReturnType<typeof globalThis.setTimeout>;
  private readonly clearTimeoutFn: (handle: ReturnType<typeof globalThis.setTimeout>) => void;
  private readonly baseIntervalMs: number;

  constructor(deps: ReplaySessionDependencies = {}) {
    this.setTimeoutFn = deps.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimeoutFn = deps.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
    this.baseIntervalMs = deps.baseIntervalMs ?? 1000;
  }

  getSnapshot = (): GameSnapshot => this.snapshot;

  getDocument = (): ReplayDocument | null => (this.document ? structuredClone(this.document) : null);

  getPlayback = (): ReplayPlaybackView => {
    if (!this.document) {
      return INITIAL_PLAYBACK_VIEW;
    }
    const isAtStart = this.cursor === 0;
    const isAtEnd = this.cursor === this.maxCursor;
    const currentFrame = this.document.frames[this.cursor];
    const lastMove = currentFrame?.lastMove ?? null;
    const result = isAtEnd ? this.document.result : null;

    const clonedLastMove = lastMove ? deepFreeze(structuredClone(lastMove)) : null;
    const clonedResult = result ? deepFreeze(structuredClone(result)) : null;
    const clonedParticipants = this.document.participants
      ? deepFreeze(structuredClone(this.document.participants))
      : undefined;

    return deepFreeze({
      cursor: this.cursor,
      maxCursor: this.maxCursor,
      isPlaying: this.isPlaying,
      speed: this.speed,
      result: clonedResult,
      isAtStart,
      isAtEnd,
      currentPly: this.cursor,
      totalPlies: this.maxCursor,
      lastMove: clonedLastMove,
      participants: clonedParticipants,
    });
  };

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async start(options: StartGameOptions): Promise<void> {
    if (this.disposed) return;

    if (options.mode !== "replay") {
      this.snapshot = Object.freeze({
        ...INITIAL_REPLAY_SNAPSHOT,
        phase: "error",
        error: {
          code: "invalid_input" as const,
          message: `Unsupported mode for ReplaySession: ${options.mode}`,
          retryable: false,
        },
      });
      this.publish();
      return;
    }

    this.clearPlaybackTimer();
    this.isPlaying = false;

    let clonedDoc: ReplayDocument;
    try {
      clonedDoc = structuredClone(options.document);
    } catch (err) {
      this.document = null;
      this.cursor = 0;
      this.maxCursor = 0;
      this.snapshot = Object.freeze({
        ...INITIAL_REPLAY_SNAPSHOT,
        phase: "error",
        error: {
          code: "session_failed" as const,
          message: `Failed to clone replay document: ${String(err)}`,
          retryable: false,
        },
      });
      this.publish();
      return;
    }

    const validation = validateReplayDocument(clonedDoc);
    if (!validation.ok) {
      this.document = null;
      this.cursor = 0;
      this.maxCursor = 0;
      this.snapshot = Object.freeze({
        ...INITIAL_REPLAY_SNAPSHOT,
        phase: "error",
        error: {
          code: "session_failed" as const,
          message: `Invalid replay document: ${validation.errors.map((e) => e.message).join("; ")}`,
          retryable: false,
        },
      });
      this.publish();
      return;
    }

    this.document = clonedDoc;
    this.maxCursor = clonedDoc.result.acceptedPlies;
    this.cursor = 0;
    this.speed = 1;
    this.boardRevision += 1;
    this.snapshot = createReplaySnapshot(this.document, this.cursor, this.boardRevision);
    this.publish();
  }

  getLegalMoves = (_from: Position): readonly Position[] => [];

  move = async (_from: Position, _to: Position): Promise<MoveResult> => ({
    accepted: false,
    error: {
      code: "invalid_move" as const,
      message: "Không thể đi quân trong chế độ xem lại.",
      retryable: false,
    },
  });

  seek = (cursor: number): void => {
    if (this.disposed || !this.document) return;
    if (typeof cursor !== "number" || !Number.isFinite(cursor)) return;

    const clamped = Math.max(0, Math.min(this.maxCursor, Math.round(cursor)));
    const changed = clamped !== this.cursor;

    this.clearPlaybackTimer();
    this.cursor = clamped;

    if (changed) {
      this.boardRevision += 1;
      this.snapshot = createReplaySnapshot(this.document, this.cursor, this.boardRevision);
    }

    if (this.isPlaying) {
      if (this.cursor >= this.maxCursor) {
        this.isPlaying = false;
      } else {
        this.scheduleNextTick();
      }
    }

    this.publish();
  };

  play = (): void => {
    if (this.disposed || !this.document) return;
    if (this.cursor >= this.maxCursor) {
      return;
    }
    if (this.isPlaying) return;

    this.isPlaying = true;
    this.scheduleNextTick();
    this.publish();
  };

  pause = (): void => {
    if (this.disposed) return;
    if (!this.isPlaying && this.playbackTimer === null) return;

    this.isPlaying = false;
    this.clearPlaybackTimer();
    this.publish();
  };

  step = (direction: number | "next" | "prev" = 1): void => {
    if (this.disposed || !this.document) return;
    const delta = direction === "prev" ? -1 : direction === "next" ? 1 : typeof direction === "number" && Number.isFinite(direction) ? direction : 1;
    this.pause();
    this.seek(this.cursor + delta);
  };

  setSpeed = (speed: ReplaySpeed): void => {
    if (this.disposed) return;
    if (speed !== 0.5 && speed !== 1 && speed !== 2 && speed !== 4) return;
    if (this.speed === speed) return;

    this.speed = speed;
    if (this.isPlaying) {
      this.clearPlaybackTimer();
      this.scheduleNextTick();
    }
    this.publish();
  };

  leave = async (): Promise<void> => {
    if (this.disposed) return;
    this.pause();
    this.clearPlaybackTimer();
  };

  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.isPlaying = false;
    this.clearPlaybackTimer();
    this.listeners.clear();
  };

  private scheduleNextTick(): void {
    this.clearPlaybackTimer();
    if (this.disposed || !this.isPlaying || !this.document || this.cursor >= this.maxCursor) {
      this.isPlaying = false;
      return;
    }

    const generation = this.playbackGeneration;
    const delayMs = Math.round(this.baseIntervalMs / this.speed);

    this.playbackTimer = this.setTimeoutFn(() => {
      this.playbackTimer = null;
      if (this.disposed || generation !== this.playbackGeneration || !this.isPlaying) {
        return;
      }
      this.advanceTick();
    }, delayMs);
  }

  private advanceTick(): void {
    const doc = this.document;
    if (this.disposed || !this.isPlaying || !doc) return;

    const nextCursor = this.cursor + 1;
    if (nextCursor >= this.maxCursor) {
      this.cursor = this.maxCursor;
      this.isPlaying = false;
      this.clearPlaybackTimer();
      this.boardRevision += 1;
      this.snapshot = createReplaySnapshot(doc, this.cursor, this.boardRevision);
      this.publish();
      return;
    }

    this.cursor = nextCursor;
    this.boardRevision += 1;
    this.snapshot = createReplaySnapshot(doc, this.cursor, this.boardRevision);
    this.publish();
    this.scheduleNextTick();
  }

  private clearPlaybackTimer(): void {
    this.playbackGeneration += 1;
    if (this.playbackTimer !== null) {
      this.clearTimeoutFn(this.playbackTimer);
      this.playbackTimer = null;
    }
  }

  private publish(): void {
    if (this.disposed) return;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}
