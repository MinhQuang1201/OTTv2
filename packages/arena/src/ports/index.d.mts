/**
 * Interface ports for Arena AI referee, engine, bot, clock, journal, finalizer, and artifact storage.
 */

import type {
  Seat,
  Position,
  CoreState,
  CoreMove,
  CoreMoveResult,
  BotStartContext,
  BotTurn,
  BotAction,
  ReplayInit,
  AcceptedMoveInput,
  TechnicalEventInput,
  ArenaMatchResult,
  ReplayDocument,
  MatchCompletionEnvelope,
  FinalizedMatch
} from "../contracts/index.d.mts";

export interface EnginePort {
  createInitialState(): CoreState;
  cloneState(state: CoreState): CoreState;
  allMoves(state: CoreState, seat: Seat): readonly CoreMove[];
  applyMove(state: CoreState, seat: Seat, from: Position, to: Position): CoreMoveResult;
  detectWinner(state: CoreState): {
    winner: Seat | null;
    reason: string | null;
    eliminatedPlayer: Seat | null;
  };
}

export interface BotPort {
  readonly botId?: string;
  start(context: BotStartContext): Promise<void>;
  requestMove(turn: BotTurn, signal: AbortSignal): Promise<BotAction>;
  stop(): Promise<void>; // idempotent, including partial startup
  getReceiptTime?(action: BotAction): number | null;
  consumeFault?(): { code: string; message: string } | null;
  getFault?(): { code: string; message: string } | null;
}

export interface ClockPort {
  nowMs(): number; // monotonic time
  schedule(delayMs: number, callback: () => void): unknown;
  cancel(handle: unknown): void;
}

export interface JournalPort {
  init(input: ReplayInit): void;
  acceptedMove(input: AcceptedMoveInput): void;
  technicalEvent(input: TechnicalEventInput): void;
  finish(result: ArenaMatchResult, terminalState: CoreState): ReplayDocument;
}

export interface ArtifactPort {
  resolveArtifact(digest: string): Promise<{ digest: string; path: string; bytes: number } | null>;
  storeArtifact(kind: "source" | "build", content: Uint8Array): Promise<{ digest: string; path: string; bytes: number }>;
  verifyDigest(digest: string, content: Uint8Array): boolean;
}

export interface FinalizationRepositoryPort {
  finalizeMatch(envelope: MatchCompletionEnvelope): Promise<FinalizedMatch>;
}
