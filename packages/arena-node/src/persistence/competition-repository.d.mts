import type { Database } from "better-sqlite3";
import type { TournamentRepository } from "./tournament-repository.d.mts";

export type CompetitionPhase = "registration" | "preparation" | "locked" | "running" | "completed";
export type EntryStatus = "pending" | "accepted" | "declined";

export interface CompetitionRecord {
  id: string;
  name: string;
  description: string;
  phase: CompetitionPhase;
  capacity: number;
  ranked: boolean;
  tournamentId: string | null;
  createdAt: string;
}

export interface CompetitionEntryRecord {
  userId: string;
  username: string;
  status: EntryStatus;
  botId: string | null;
  botName: string | null;
  botVersionId: string | null;
  versionNo: number | null;
  buildStatus: string | null;
}

export interface CreateCompetitionInput {
  id?: string;
  name: string;
  description?: string;
  capacity?: number;
  ranked?: boolean;
}

export interface CreateCompetitionOptions {
  actorId?: string;
  idempotencyKey?: string;
}

export interface AdvancePhaseOptions {
  tournamentId?: string;
  ladderId?: string;
  rulesetJson?: unknown;
  policyJson?: unknown;
  initialStateJson?: unknown;
  schedule?: unknown[];
}

export interface CompetitionRepository {
  createCompetition(input: CreateCompetitionInput, options?: CreateCompetitionOptions): CompetitionRecord;
  getCompetition(competitionId: string): CompetitionRecord | null;
  listCompetitions(options?: { limit?: number; offset?: number }): CompetitionRecord[];
  getCompetitionWithEntries(competitionId: string): { competition: CompetitionRecord; entries: CompetitionEntryRecord[] } | null;
  registerEntry(competitionId: string, userId: string): CompetitionEntryRecord;
  reviewEntry(competitionId: string, userId: string, accepted: boolean): CompetitionEntryRecord;
  submitBotVersion(competitionId: string, userId: string, botVersionId: string): CompetitionEntryRecord;
  advancePhase(competitionId: string, expectedPhase: CompetitionPhase, options?: AdvancePhaseOptions): CompetitionRecord;
  retryCompetitionMatch(competitionId: string, scheduleIndex: number): { ok: boolean };
}

export function createCompetitionRepository(
  db: Database,
  options?: {
    tournamentRepo?: TournamentRepository;
  }
): CompetitionRepository;
