export type TournamentStatus = "registration" | "in_progress" | "completed" | "cancelled";
export type MatchStatus = "scheduled" | "in_progress" | "completed" | "bye";
export type MatchResult = "win_a" | "win_b" | "draw" | "bye";

export interface TournamentOrganizer {
  readonly organizerId: string;
  readonly name: string;
}

export interface TournamentParticipant {
  readonly participantId: string;
  readonly name: string;
  status: "registered" | "active" | "withdrawn";
}

export interface HumanTournamentMatch {
  readonly matchId: string;
  readonly scheduleIndex: number;
  readonly roundNumber: number;
  readonly participantAId: string;
  readonly participantBId: string | null;
  status: MatchStatus;
  result: MatchResult | null;
  winnerParticipantId: string | null;
  allocationId: string | null;
  alias: string | null;
  seatAInviteToken: string | null;
  seatBInviteToken: string | null;
}

export interface HumanTournamentRound {
  readonly roundNumber: number;
  readonly matches: HumanTournamentMatch[];
  readonly byes: string[];
}

export interface HumanTournamentStanding {
  readonly rank: number;
  readonly participantId: string;
  readonly name: string;
  readonly status: string;
  readonly matchesPlayed: number;
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
  readonly byes: number;
  readonly points: number;
  readonly buchholz: number;
  readonly sonnebornBerger: number;
}

export interface HumanTournamentAggregate {
  readonly tournamentId: string;
  readonly name: string;
  readonly organizer: TournamentOrganizer;
  readonly formatId: string;
  readonly requestedRounds?: number;
  readonly mapId: string;
  status: TournamentStatus;
  participants: TournamentParticipant[];
  rounds: HumanTournamentRound[];
  currentRoundNumber: number;
  roundCount: number;
  readonly createdAt: number;
  completedAt: number | null;
  _initialOrganizerSecret?: string;
}

export const TOURNAMENT_STATUS: {
  readonly REGISTRATION: "registration";
  readonly IN_PROGRESS: "in_progress";
  readonly COMPLETED: "completed";
  readonly CANCELLED: "cancelled";
};

export const MATCH_STATUS: {
  readonly SCHEDULED: "scheduled";
  readonly IN_PROGRESS: "in_progress";
  readonly COMPLETED: "completed";
  readonly BYE: "bye";
};

export const MATCH_RESULT: {
  readonly WIN_A: "win_a";
  readonly WIN_B: "win_b";
  readonly DRAW: "draw";
  readonly BYE: "bye";
};

export function hashSecret(str: string): Promise<string>;

export function verifyOrganizer(tournament: HumanTournamentAggregate, organizerSecret?: string | null): Promise<boolean>;

export function createHumanTournament(options: {
  tournamentId: string;
  name: string;
  organizer: TournamentOrganizer;
  formatId: string;
  requestedRounds?: number;
  mapId?: string;
  organizerSecret?: string;
}): Promise<HumanTournamentAggregate>;

export function registerParticipant(
  tournament: HumanTournamentAggregate,
  participant: { participantId: string; name: string; participantSecret?: string }
): Promise<{
  tournament: HumanTournamentAggregate;
  participant: TournamentParticipant;
  participantSecret: string;
}>;

export function startTournament(
  tournament: HumanTournamentAggregate,
  options?: { organizerSecret?: string }
): Promise<HumanTournamentAggregate>;

export function assignMatchProvisioning(
  tournament: HumanTournamentAggregate,
  matchId: string,
  provisioning: {
    allocationId?: string;
    alias?: string;
    seatAInviteToken?: string;
    seatBInviteToken?: string;
  }
): HumanTournamentMatch;

export function getParticipantMatchAccess(
  tournament: HumanTournamentAggregate,
  matchId: string,
  participantId: string,
  participantSecret: string
): Promise<{
  matchId: string;
  roundNumber: number;
  seat: "A" | "B";
  allocationId: string | null;
  alias: string | null;
  inviteToken: string | null;
  opponentId: string | null;
}>;

export function recordMatchResult(
  tournament: HumanTournamentAggregate,
  options: {
    matchId: string;
    result: MatchResult;
    winnerParticipantId?: string | null;
    organizerSecret?: string;
    skipOrganizerVerification?: boolean;
  }
): Promise<HumanTournamentMatch>;

export function canAdvanceRound(tournament: HumanTournamentAggregate): boolean;

export function advanceRound(
  tournament: HumanTournamentAggregate,
  options?: { organizerSecret?: string }
): Promise<{
  tournamentCompleted: boolean;
  currentRoundNumber: number;
  standings?: HumanTournamentStanding[];
  matches?: HumanTournamentMatch[];
}>;

export function getStandings(tournament: HumanTournamentAggregate): HumanTournamentStanding[];
