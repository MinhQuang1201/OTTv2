export type FormatId = "single-round-robin" | "double-round-robin" | "swiss";

export interface FormatDescriptor {
  readonly id: FormatId;
  readonly name: string;
  readonly description: string;
}

export interface TournamentEntryObject {
  botId?: string;
  id?: string;
  botVersionId?: string;
  [key: string]: unknown;
}

export type TournamentEntry = string | TournamentEntryObject;

export interface StandingInput {
  botId: string;
  points?: number;
  wins?: number;
  draws?: number;
  losses?: number;
  played?: number;
  byeCount?: number;
  seatBalance?: number;
  [key: string]: unknown;
}

export interface HistoryRecord {
  roundNumber?: number;
  botAId: string;
  botBId: string;
  [key: string]: unknown;
}

export interface RoundMatchPairing {
  scheduleIndex: number;
  botAId: string;
  botBId: string;
  botAVersionId?: string;
  botBVersionId?: string;
}

export interface PairRoundResult {
  pairings: RoundMatchPairing[];
  byes: string[];
  warnings: string[];
}

export interface PairRoundInput {
  formatId: FormatId | string;
  entries: readonly TournamentEntry[];
  roundNumber: number;
  roundCount: number;
  standings?: readonly StandingInput[];
  history?: readonly HistoryRecord[];
}

export declare const FORMAT_IDS: {
  readonly SINGLE_ROUND_ROBIN: "single-round-robin";
  readonly DOUBLE_ROUND_ROBIN: "double-round-robin";
  readonly SWISS: "swiss";
};

export declare const FORMAT_DESCRIPTORS: readonly FormatDescriptor[];

export declare function listFormats(): FormatDescriptor[];

export declare function getFormat(formatId: string): FormatDescriptor | undefined;

export declare function getRoundCount(
  formatId: string,
  participantCount: number,
  requestedRounds?: number
): number;

export declare function pairRound(options: PairRoundInput): PairRoundResult;
