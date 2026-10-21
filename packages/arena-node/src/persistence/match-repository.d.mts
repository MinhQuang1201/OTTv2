import type { Database } from "better-sqlite3";
import type { IdempotencyConflictError, NotFoundError, OwnershipError } from "./bot-repository.mjs";
import type { CoreState, MatchPolicy, RulesetSnapshot } from "../../../arena/src/contracts/index.d.mts";

export { IdempotencyConflictError, NotFoundError, OwnershipError };

export class MatchValidationError extends Error {
  code: string;
  constructor(message: string, code?: string);
}

export type MatchKind = "ranked" | "practice";

export interface MatchParticipantRecord {
  match_id: string;
  seat: "A" | "B";
  bot_id: string;
  bot_version_id: string;
  artifact_digest: string | null;
  profile_id: string;
  profile_revision: string;
}

export interface MatchRecord {
  id: string;
  kind: MatchKind;
  ladder_id: string;
  ruleset_json: string;
  policy_json: string;
  profile_json: string;
  initial_state_json: string;
  status: "pending" | "active" | "completed" | "cancelled" | "error";
  tournament_id: string | null;
  schedule_index: number | null;
  settled_at: string | null;
  settlement_seq: number | null;
  created_at: string;
  participants: {
    A: MatchParticipantRecord;
    B: MatchParticipantRecord;
  };
}

export interface ParticipantSpec {
  botVersionId: string;
  botId?: string;
}

export interface ParticipantWithSeatSpec extends ParticipantSpec {
  seat: "A" | "B";
}

export interface CreateMatchArgs {
  id?: string;
  kind: MatchKind;
  ladderId: string;
  rulesetJson?: string;
  ruleset?: RulesetSnapshot | unknown;
  policyJson?: string;
  policy?: MatchPolicy | unknown;
  profileJson?: string;
  profile?: unknown;
  initialStateJson?: string;
  initialState?: CoreState | unknown;
  status?: string;
  tournamentId?: string | null;
  scheduleIndex?: number | null;
  participants:
    | { A: ParticipantSpec; B: ParticipantSpec }
    | [ParticipantWithSeatSpec, ParticipantWithSeatSpec];
}

export interface MatchResultRecord {
  match_id: string;
  result_json: string;
  replay_json: string;
  replay_digest: string;
  completion_digest: string;
  winning_attempt: number | null;
  finalized_at: string;
}

export interface BotRatingRecord {
  ladder_id: string;
  bot_id: string;
  rating: number;
  rated_games: number;
  wins: number;
  draws: number;
  losses: number;
  updated_at: string | null;
}

export interface TournamentRecord {
  id: string;
  name: string;
  status: "pending" | "active" | "completed" | "cancelled";
  ruleset_json: string;
  policy_json: string;
  point_scheme: "3-1-0";
  ranked: number;
  created_at: string;
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
}

export interface MatchFilter {
  ladderId?: string;
  status?: string;
  kind?: MatchKind;
  tournamentId?: string;
  limit?: number;
  offset?: number;
}

export interface MatchRepository {
  createMatch(
    args: CreateMatchArgs,
    options?: { idempotencyKey?: string; actorId?: string }
  ): MatchRecord;
  getMatch(matchId: string): MatchRecord | undefined;
  listMatches(filter?: MatchFilter): MatchRecord[];
  getMatchParticipants(
    matchId: string
  ): Record<"A" | "B", MatchParticipantRecord>;
  getMatchResult(matchId: string): MatchResultRecord | undefined;
  getBotRating(ladderId: string, botId: string): BotRatingRecord;
  getTournament(id: string): TournamentRecord | undefined;
  getTournamentStandings(tournamentId: string): TournamentStandingRecord[];
}

export function createMatchRepository(db: Database): MatchRepository;
