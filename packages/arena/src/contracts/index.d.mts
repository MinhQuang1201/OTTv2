/**
 * Shared type definitions and runtime declarations for Arena AI contracts v1.
 */

export type Seat = "A" | "B";

export type PieceType = "dam" | "la" | "keo";

export interface Position {
  x: number;
  y: number;
}

export interface CorePiece {
  id: string;
  player: Seat;
  type: PieceType;
  x: number;
  y: number;
}

export interface CoreClock {
  remainingMs: Record<Seat, number>;
  runningSeat: Seat | null;
}

export interface CoreState {
  turn: Seat | null;
  winner: Seat | null;
  reason: string | null;
  eliminatedPlayer: Seat | null;
  clock: CoreClock;
  pieces: CorePiece[];
}

export interface CoreMove {
  pieceId: string;
  from: Position;
  to: Position;
}

export type CoreEvent =
  | { type: "move"; pieceId: string; from: Position; to: Position }
  | { type: "capture"; pieceId: string; capturedId: string; capturedType: PieceType; from: Position; to: Position }
  | { type: "win"; winner: Seat; reason: "goal" | "elimination" | "no_moves"; eliminatedPlayer: Seat | null };

export type CoreMoveResult =
  | { ok: true; error: null; state: CoreState; events: readonly CoreEvent[] }
  | { ok: false; error: string; state: null; events: readonly [] };

export interface WirePiece {
  id: string;
  owner: Seat;
  type: PieceType;
  x: number;
  y: number;
}

export interface WireMove {
  from: Position;
  to: Position;
}

export interface BotTurn {
  protocolVersion: 1;
  type: "turn";
  requestId: string;
  matchId: string;
  rulesetId: string;
  rulesetHash: string;
  boardWidth: number;
  boardHeight: number;
  ply: number;
  turn: Seat;
  timeRemainingMs: number;
  turnTimeLimitMs: number;
  board: readonly WirePiece[];
  legalMoves: readonly WireMove[];
}

export interface BotAction {
  protocolVersion: 1;
  requestId: string;
  move: WireMove;
  comment?: string;
}

export interface BotStartContext {
  matchId: string;
  seat: Seat;
  rulesetId: string;
  rulesetHash: string;
  initialTimeMs: number;
  turnTimeLimitMs: number;
}

export type WinReason = "goal" | "elimination" | "no_moves";
export type DrawReason = "max_plies";
export type ForfeitReason =
  | "turn_timeout"
  | "total_timeout"
  | "crash"
  | "protocol_error"
  | "illegal_move"
  | "output_limit";

export interface ArenaWinResult {
  outcome: "win";
  winner: Seat;
  loser: Seat;
  reason: WinReason;
  acceptedPlies: number;
}

export interface ArenaDrawResult {
  outcome: "draw";
  winner: null;
  loser: null;
  reason: DrawReason;
  acceptedPlies: number;
}

export interface ArenaForfeitResult {
  outcome: "forfeit";
  winner: Seat;
  loser: Seat;
  reason: ForfeitReason;
  acceptedPlies: number;
}

export type ArenaMatchResult = ArenaWinResult | ArenaDrawResult | ArenaForfeitResult;

export interface RunFailure {
  kind: "infrastructure_error";
  code: string;
  retryable: boolean;
}

export interface MatchPolicy {
  matchPolicyVersion: "arena-policy-v1";
  maxPlies: 400;
  initialTimeMs: number;
  turnTimeLimitMs: number;
  clockBoundary: "strict_less_than_budget";
  clockSource: "referee_monotonic";
}

export interface RulesetSnapshot {
  rulesetId: string;
  boardWidth: number;
  boardHeight: number;
  files: string;
  types: readonly PieceType[];
  beats: Record<string, string>;
  goals: Record<Seat, Position>;
  initialSetup: {
    A: readonly { type: PieceType; x: number; y: number }[];
    B: readonly { type: PieceType; x: number; y: number }[];
  };
  movement: {
    deltas: readonly [number, number][];
    maxDistance: number;
  };
  winConditions: readonly string[];
}

export interface ReplayParticipant {
  botId: string;
  botVersionId?: string;
  name?: string;
  sourceDigest?: string;
  artifactDigest?: string;
  profileId?: string;
  isFunctionBot?: boolean;
}

export interface AcceptedMoveRecord {
  seat: Seat;
  pieceId: string;
  from: Position;
  to: Position;
  capturedPieceId: string | null;
  capturedPieceType: PieceType | null;
  elapsedMs: number;
  remainingMs: number;
  events: readonly CoreEvent[];
  comment?: string;
}

/**
 * Authoritative move input to the journal port; contains the cloned post-move core state.
 * Persisted lastMove in ReplayFrame retains AcceptedMoveRecord only.
 */
export interface AcceptedMoveInput extends AcceptedMoveRecord {
  coreState: CoreState;
}

/**
 * Technical event input issued by controller; does NOT require sequence or ply numbers.
 * The journal assigns continuous seq and maps the current ply upon recording.
 */
export interface TechnicalEventInput {
  type: "start" | "technical_pause" | "fault" | "warning" | "infrastructure_error";
  message: string;
  detail?: unknown;
}

export interface TechnicalEvent extends TechnicalEventInput {
  seq: number;
  ply: number;
}

export interface ReplayEvent {
  seq: number;
  ply: number;
  type: "init" | "move" | "capture" | "technical" | "terminal";
  payload: unknown;
}

export interface ReplayInit {
  matchId: string;
  engineRevision: string;
  engineGitRevision: string | null;
  rulesetId: string;
  rulesetHash: string;
  rulesetSnapshot: RulesetSnapshot;
  matchPolicy: MatchPolicy;
  participants: Record<Seat, ReplayParticipant>;
  initialCoreState: CoreState;
}

export interface ReplayFrame {
  ply: number;
  coreState: CoreState;
  lastMove: AcceptedMoveRecord | null;
}

export interface ReplayDocument {
  schemaVersion: 1;
  matchId: string;
  engineRevision: string;
  engineGitRevision: string | null;
  rulesetId: string;
  rulesetHash: string;
  rulesetSnapshot: RulesetSnapshot;
  matchPolicy: MatchPolicy;
  participants: Record<Seat, ReplayParticipant>;
  initialCoreState: CoreState;
  frames: readonly ReplayFrame[];
  events: readonly ReplayEvent[];
  result: ArenaMatchResult;
  terminalCoreState: CoreState;
}

/**
 * Envelope delivered to the finalizer to atomically commit match results,
 * calculate ratings, and finalize job attempt leases.
 */
export interface MatchCompletionEnvelope {
  matchId: string;
  attemptNo: number;
  leaseToken: string;
  result: ArenaMatchResult;
  replay: ReplayDocument;
  replayDigest: string;
  completionDigest: string;
}

/**
 * Record returned upon atomic transaction commit in finalizer repository.
 */
export interface FinalizedMatch {
  matchId: string;
  settlementSeq: number;
  settledAt: string;
  result: ArenaMatchResult;
  replayDigest: string;
  completionDigest: string;
}

export interface ValidationError {
  path: string;
  code: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: readonly ValidationError[];
}

// ---------------------------------------------------------------------------
// Runtime Exports Declarations
// ---------------------------------------------------------------------------

export declare const PROTOCOL_VERSION: 1;
export declare const MAX_STDOUT_LINE_BYTES: 65536;
export declare const MAX_STDOUT_TOTAL_BYTES: 1048576;
export declare const MAX_STDERR_TOTAL_BYTES: 262144;
export declare const MAX_COMMENT_LENGTH: 2048;

export declare const SEATS: readonly Seat[];
export declare const PIECE_TYPES: readonly PieceType[];
export declare const WIN_REASONS: readonly WinReason[];
export declare const DRAW_REASONS: readonly DrawReason[];
export declare const FORFEIT_REASONS: readonly ForfeitReason[];

export declare const RULESET_ID_G_V1: "ottv2-g-default-v1";
export declare const MATCH_POLICY_VERSION: "arena-policy-v1";
export declare const DEFAULT_MATCH_POLICY: Readonly<MatchPolicy>;

export declare function generateTurnRequestId(matchId: string, seat: Seat, ply: number): string;

export declare function createWinResult(args: {
  winner: Seat;
  loser: Seat;
  reason: WinReason;
  acceptedPlies: number;
}): ArenaWinResult;

export declare function createDrawResult(args: {
  acceptedPlies: number;
}): ArenaDrawResult;

export declare function createForfeitResult(args: {
  winner: Seat;
  loser: Seat;
  reason: ForfeitReason;
  acceptedPlies: number;
}): ArenaForfeitResult;

export declare function createInfrastructureError(args: {
  code: string;
  retryable: boolean;
}): RunFailure;

export declare function createCurrentRulesetSnapshot(config: unknown): RulesetSnapshot;

export declare function canonicalize(val: unknown): unknown;
export declare function canonicalSerialize(val: unknown): string;
export declare function canonicalRulesetJson(snapshot: RulesetSnapshot): string;
export declare function canonicalMatchPolicyJson(policy: unknown): string;

export declare function validatePosition(
  pos: unknown,
  path?: string,
  boardWidth?: number,
  boardHeight?: number
): ValidationError[];

export declare function validateBotTurn(turn: unknown): ValidationResult;
export declare function validateBotAction(action: unknown, expectedRequestId?: string): ValidationResult;
export declare function validateArenaMatchResult(result: unknown): ValidationResult;
export declare function validateMatchPolicy(policy: unknown): ValidationResult;
export declare function validateRulesetSnapshot(snapshot: unknown): ValidationResult;
export declare function isSupportedEngineRuleset(snapshot: unknown): boolean;
export declare function validateReplayDocument(doc: unknown, options?: { maxBytes?: number }): ValidationResult;
