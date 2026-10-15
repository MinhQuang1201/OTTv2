import type {
  HumanTournamentAggregate,
  HumanTournamentMatch,
  HumanTournamentStanding,
  MatchResult,
  TournamentOrganizer,
} from "../domain/human-tournaments/human-tournament.d.mts";

export interface HumanTournamentLobbyGateway {
  createRoom(hostName: string): Promise<{ allocationId: string; room: string; alias?: string; seat: "A" }>;
  createSeatInvite(
    allocationId: string,
    seat: "A" | "B",
    inviteeName?: string
  ): Promise<{ inviteToken: string; expiresAt: number; seat: "A" | "B"; allocationId: string }>;
}

export class HumanTournamentService {
  constructor(options?: {
    store?: Map<string, HumanTournamentAggregate>;
    lobbyGateway?: HumanTournamentLobbyGateway | null;
  });

  createTournament(options: {
    tournamentId: string;
    name: string;
    organizer: TournamentOrganizer;
    formatId: string;
    requestedRounds?: number;
    mapId?: string;
  }): Promise<HumanTournamentAggregate>;

  getTournament(tournamentId: string): Promise<HumanTournamentAggregate>;

  registerPlayer(
    tournamentId: string,
    participant: { participantId: string; name: string }
  ): Promise<HumanTournamentAggregate>;

  startTournament(
    tournamentId: string,
    options?: { organizerId?: string }
  ): Promise<HumanTournamentAggregate>;

  provisionRoundMatches(
    tournament: HumanTournamentAggregate,
    roundNumber: number
  ): Promise<void>;

  getPlayerMatchAccess(
    tournamentId: string,
    matchId: string,
    participantId: string
  ): Promise<{
    matchId: string;
    roundNumber: number;
    seat: "A" | "B";
    allocationId: string | null;
    alias: string | null;
    inviteToken: string | null;
    opponentId: string | null;
    opponentName: string | null;
  }>;

  recordResult(
    tournamentId: string,
    options: {
      matchId: string;
      result: MatchResult;
      winnerParticipantId?: string | null;
      organizerId?: string;
    }
  ): Promise<{
    match: HumanTournamentMatch;
    canAdvance: boolean;
  }>;

  advanceRound(
    tournamentId: string,
    options?: { organizerId?: string }
  ): Promise<{
    tournamentCompleted: boolean;
    currentRoundNumber: number;
    standings?: HumanTournamentStanding[];
    matches?: HumanTournamentMatch[];
  }>;

  getTournamentDetails(tournamentId: string): Promise<{
    tournamentId: string;
    name: string;
    organizer: TournamentOrganizer;
    formatId: string;
    status: string;
    currentRoundNumber: number;
    roundCount: number;
    participantCount: number;
    currentRoundMatches: Array<{
      matchId: string;
      roundNumber: number;
      scheduleIndex: number;
      participantA: { id: string; name: string };
      participantB: { id: string; name: string } | null;
      status: string;
      result: MatchResult | null;
      winnerParticipantId: string | null;
      alias: string | null;
      allocationId: string | null;
    }>;
    standings: HumanTournamentStanding[];
    completedAt: number | null;
  }>;
}
