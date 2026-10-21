import type {
  TournamentEntry,
  StandingInput,
  HistoryRecord,
  PairRoundResult
} from "./index.d.mts";

export interface PairSwissRoundInput {
  entries: readonly TournamentEntry[];
  roundNumber: number;
  roundCount: number;
  standings?: readonly StandingInput[];
  history?: readonly HistoryRecord[];
}

export declare function normalizeSwissEntries(
  entries: readonly TournamentEntry[]
): Array<{ botId: string; botVersionId?: string }>;

export declare function makePairKey(a: string, b: string): string;

export declare function pairSwissRound(options: PairSwissRoundInput): PairRoundResult;
