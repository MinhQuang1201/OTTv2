import type {
  EnginePort,
  BotPort,
  ClockPort,
  JournalPort
} from "../ports/index.d.mts";

import type {
  CoreState,
  MatchPolicy,
  RulesetSnapshot,
  ReplayParticipant,
  ArenaMatchResult,
  RunFailure,
  Seat
} from "../contracts/index.d.mts";

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
}

export interface HeadlessMatchController {
  run(): Promise<ArenaMatchResult | RunFailure>;
}

export declare function createHeadlessMatchController(
  options: HeadlessMatchControllerOptions
): HeadlessMatchController;
