import type { Database } from "better-sqlite3";
import type {
  TournamentEntryInput,
  CreateTournamentInput,
  CreateTournamentOptions
} from "../../../arena/src/application/create-tournament.d.mts";

export interface TournamentRecord {
  id: string;
  name: string;
  status: "pending" | "active" | "completed" | "cancelled";
  ruleset_json: string;
  policy_json: string;
  point_scheme: "3-1-0";
  ranked: number;
  created_at: string;
  totalMatches?: number;
  completedMatches?: number;
}

export interface TournamentEntryRecord {
  tournament_id: string;
  bot_id: string;
  bot_version_id: string;
  profile_id: string;
  profile_revision: string;
  artifact_digest: string | null;
  registered_at: string;
}

export interface TournamentStandingRecord {
  tournament_id: string;
  bot_id: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  updated_at: string;
  rank?: number;
}

export interface TournamentRepository {
  createTournament(input: CreateTournamentInput & { schedule?: unknown[] }, options?: CreateTournamentOptions): TournamentRecord;
  getTournament(tournamentId: string): TournamentRecord | undefined;
  getTournamentEntries(tournamentId: string): TournamentEntryRecord[];
  getTournamentMatches(tournamentId: string): unknown[];
  getTournamentStandings(tournamentId: string): TournamentStandingRecord[];
  retryMatch(tournamentId: string, scheduleIndex: number): unknown;
}

export function createTournamentRepository(
  db: Database,
  options?: {
    scheduleGenerator?: (entries: readonly unknown[]) => unknown[];
    validateEntries?: (entries: readonly unknown[]) => string[];
  }
): TournamentRepository;
