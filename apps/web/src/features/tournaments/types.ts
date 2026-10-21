export interface TournamentParticipantView {
  readonly id: string;
  readonly name: string;
}

export interface TournamentMatchView {
  readonly matchId: string;
  readonly roundNumber: number;
  readonly scheduleIndex: number;
  readonly participantA: TournamentParticipantView;
  readonly participantB: TournamentParticipantView | null;
  readonly status: "scheduled" | "in_progress" | "completed" | "bye";
  readonly result: "win_a" | "win_b" | "draw" | "bye" | null;
  readonly winnerParticipantId: string | null;
  readonly alias: string | null;
  readonly allocationId: string | null;
}

export interface TournamentStandingView {
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

export interface HumanTournamentSummary {
  readonly tournamentId: string;
  readonly name: string;
  readonly organizer: {
    readonly organizerId: string;
    readonly name: string;
  };
  readonly formatId: string;
  readonly status: "registration" | "in_progress" | "completed" | "cancelled";
  readonly currentRoundNumber: number;
  readonly roundCount: number;
  readonly participantCount: number;
  readonly currentRoundMatches: readonly TournamentMatchView[];
  readonly standings: readonly TournamentStandingView[];
  readonly completedAt: number | null;
}
