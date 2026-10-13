export interface TournamentEntryObject {
  botId?: string;
  id?: string;
  botVersionId?: string;
  [key: string]: unknown;
}

export type TournamentEntry = string | TournamentEntryObject;

export interface ScheduledDoubleRoundRobinMatch {
  scheduleIndex: number;
  round: number;
  leg: 1 | 2;
  botAId: string;
  botBId: string;
  seatA: string;
  seatB: string;
  botAVersionId?: string;
  botBVersionId?: string;
}

export declare function validateTournamentEntries(
  entries: readonly TournamentEntry[]
): string[];

export declare function calculateDoubleRoundRobinMatchCount(
  botCount: number
): number;

export declare function generateDoubleRoundRobinSchedule(
  entries: readonly TournamentEntry[],
  options?: Record<string, unknown>
): ScheduledDoubleRoundRobinMatch[];

export declare const createDoubleRoundRobinSchedule: typeof generateDoubleRoundRobinSchedule;
