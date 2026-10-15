import type {
  EnginePort,
  BotPort,
  ClockPort,
  JournalPort
} from "../ports/index.d.mts";

import type {
  CoreState,
  Position,
  PieceType,
  MatchPolicy,
  RulesetSnapshot,
  ReplayParticipant,
  ArenaMatchResult,
  RunFailure,
  Seat
} from "../contracts/index.d.mts";

export interface AcceptedMoveCallbackEvent {
  ply: number;
  seat: Seat;
  move: {
    from: Position;
    to: Position;
  };
  frame: {
    ply: number;
    seat: Seat;
    move: {
      from: Position;
      to: Position;
    };
    capturedPieceId: string | null;
    capturedPieceType: PieceType | null;
    elapsedMs: number;
    remainingMs: number;
    clock: CoreState["clock"];
    comment?: string;
    state: CoreState;
  };
}

export interface HeadlessMatchControllerOptions {
  matchId: string;
  engine: EnginePort;
  botA: BotPort;
  botB: BotPort;
  clock: ClockPort;
  journal: JournalPort;
  policy?: MatchPolicy;
  rulesetSnapshot: RulesetSnapshot;
  rulesetHash: string;
  engineRevision: string;
  engineGitRevision?: string | null;
  participants?: Record<Seat, ReplayParticipant>;
  initialState?: CoreState;
  supervisorSignal?: AbortSignal;
  onAcceptedMove?: (event: AcceptedMoveCallbackEvent) => void;
}

export interface HeadlessMatchController {
  run(): Promise<ArenaMatchResult | RunFailure>;
}

export declare function createHeadlessMatchController(
  options: HeadlessMatchControllerOptions
): HeadlessMatchController;
