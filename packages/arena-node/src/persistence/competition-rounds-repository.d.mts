import type { Database } from "better-sqlite3";
import type { TournamentRepository } from "./tournament-repository.d.mts";
import type {
  CompetitionPhase,
  CompetitionEntryRecord,
  AdvancePhaseOptions
} from "./competition-repository.d.mts";

export type CompetitionMode = "ranked" | "practice";

export interface ExtendedCompetitionRecord {
  id: string;
  name: string;
  description: string;
  phase: CompetitionPhase;
  capacity: number;
  ranked: boolean;
  tournamentId: string | null;
  createdAt: string;
  formatId: string;
  mapId: string;
  mapRevision: number;
  mode: CompetitionMode;
  roundCount: number;
  currentRound: number;
  isExtended: boolean;
  configuration: ExtendedCompetitionConfiguration;
}

export const DEFAULT_COMPETITION_CONFIG: {
  readonly mapId: string;
  readonly formatId: string;
  readonly mode: CompetitionMode;
};

export const CATALOG_MODES: readonly {
  readonly id: CompetitionMode;
  readonly name: string;
}[];

export interface CompetitionRoundPairing {
  scheduleIndex: number;
  botAId: string;
  botBId: string;
}

export interface CompetitionRoundRecord {
  roundNumber: number;
  tournamentId: string;
  status: "running" | "completed";
  pairings: CompetitionRoundPairing[];
  byes: string[];
  warnings: string[];
  createdAt: string;
  completedAt: string | null;
}

export interface ExtendedCompetitionStanding {
  botId: string;
  botName: string;
  points: number;
  wins: number;
  draws: number;
  losses: number;
  played: number;
  byeCount: number;
  seatBalance: number;
}

export interface ExtendedCompetitionConfiguration {
  formatId: string;
  mapId: string;
  mapRevision: number;
  mode: CompetitionMode;
  roundCount: number;
  currentRound: number;
}

export interface ExtendedCompetitionDetails {
  competition: ExtendedCompetitionRecord;
  entries: CompetitionEntryRecord[];
  configuration: ExtendedCompetitionConfiguration;
  rounds: CompetitionRoundRecord[];
  standings: ExtendedCompetitionStanding[];
}

export interface CreateExtendedCompetitionInput {
  id?: string;
  name: string;
  description?: string;
  capacity?: number;
  ranked?: boolean;
  formatId?: string;
  mapId?: string;
  roundCount?: number;
  mode?: CompetitionMode;
}

export interface CreateExtendedCompetitionOptions {
  actorId?: string;
  idempotencyKey?: string;
}

export interface CompetitionCatalogMap {
  id: string;
  revision: number;
  name: string;
  description: string;
  initialState: unknown;
}

export interface CompetitionCatalogFormat {
  id: string;
  name: string;
  description: string;
}

export interface CompetitionCatalogMode {
  id: "ranked" | "practice";
  name: string;
}

export interface CompetitionCatalog {
  maps: CompetitionCatalogMap[];
  formats: CompetitionCatalogFormat[];
  modes: CompetitionCatalogMode[];
  defaults: {
    mapId: string;
    formatId: string;
    mode: "ranked" | "practice";
  };
}

export interface CompetitionRoundsRepository {
  isExtendedCompetition(competitionId: string): boolean;
  getCompetitionCatalog(): CompetitionCatalog;
  createExtendedCompetition(
    input: CreateExtendedCompetitionInput,
    options?: CreateExtendedCompetitionOptions
  ): ExtendedCompetitionRecord;
  getExtendedCompetition(competitionId: string): ExtendedCompetitionRecord | null;
  getExtendedCompetitionDetails(competitionId: string): ExtendedCompetitionDetails | null;
  advanceExtendedPhase(
    competitionId: string,
    expectedPhase: CompetitionPhase,
    options?: AdvancePhaseOptions
  ): ExtendedCompetitionRecord;
  nextRound(
    competitionId: string,
    expectedRound: number,
    options?: AdvancePhaseOptions
  ): ExtendedCompetitionRecord;
  retryCompetitionMatch(competitionId: string, scheduleIndex: number): { ok: boolean };
}

export function createCompetitionRoundsRepository(
  db: Database,
  options?: {
    tournamentRepo?: TournamentRepository;
    mapsDomain?: unknown;
    formatsDomain?: unknown;
  }
): CompetitionRoundsRepository;
