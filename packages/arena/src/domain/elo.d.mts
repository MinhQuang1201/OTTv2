import type { ArenaMatchResult, Seat } from "../contracts/index.d.mts";

export type EloOutcome = "win" | "draw" | "loss";
export type EloScore = 0 | 0.5 | 1;
export type TournamentPoints = 0 | 1 | 3;

export interface EloParticipantResult {
  before: number;
  after: number;
  delta: number;
  K: number;
  score: number;
}

export interface EloSettlementResult {
  A: EloParticipantResult;
  B: EloParticipantResult;
}

export interface ComputeEloInput {
  ratingA: number;
  ratingB: number;
  ratedGamesA: number;
  ratedGamesB: number;
  outcomeForA?: EloOutcome;
  result?: ArenaMatchResult;
}

export declare const INITIAL_RATING: 1200;
export declare const K_PROVISIONAL: 32;
export declare const K_ESTABLISHED: 16;
export declare const K_THRESHOLD_GAMES: 30;

export declare function kFactor(ratedGames: number): 32 | 16;
export declare function expectedScore(myRating: number, opponentRating: number): number;
export declare function eloScore(outcome: EloOutcome): EloScore;
export declare function tournamentPoints(outcome: EloOutcome): TournamentPoints;
export declare function resultToEloScore(result: ArenaMatchResult, seat: Seat): EloScore;
export declare function resultToTournamentPoints(result: ArenaMatchResult, seat: Seat): TournamentPoints;
export declare function computeEloResult(params: ComputeEloInput): EloSettlementResult;
