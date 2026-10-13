/**
 * domain/elo.mjs
 *
 * Pure Elo rating computation and tournament points mapping for OTTv2 Arena.
 *
 * Policy (arena-policy-v1):
 *   - Initial rating: 1200
 *   - K per bot based on ratedGames BEFORE the settled match:
 *       ratedGames < 30  → K = 32
 *       ratedGames >= 30 → K = 16
 *   - Elo score: win = 1 / draw = 0.5 / loss = 0
 *   - Expected score: E = 1 / (1 + 10^((opponentRating - myRating) / 400))
 *   - Both expected scores computed from the SAME pre-settlement ratings.
 *   - No numeric rounding — store REAL; UI rounds for display.
 *   - Asymmetric K allowed → non-zero-sum is valid.
 *   - Tournament points (separate): win = 3 / draw = 1 / loss = 0.
 *
 * No DB, process, clock, or Node built-in imports. Pure module.
 */

import { validateArenaMatchResult } from "../contracts/validation.mjs";

export const INITIAL_RATING = 1200;
export const K_PROVISIONAL = 32;
export const K_ESTABLISHED = 16;
export const K_THRESHOLD_GAMES = 30;

// ---------------------------------------------------------------------------
// Internal validation helpers
// ---------------------------------------------------------------------------

/** @param {unknown} v @param {string} name */
function assertNumeric(v, name) {
  if (typeof v !== "number") {
    throw new TypeError(`${name} must be a numeric value, got ${typeof v}`);
  }
}

/** @param {unknown} v @param {string} name */
function assertFiniteRating(v, name) {
  assertNumeric(v, name);
  if (!Number.isFinite(v)) {
    throw new RangeError(`${name} must be a finite number, got ${v}`);
  }
}

/** @param {unknown} v @param {string} name */
function assertNonNegativeInteger(v, name) {
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new TypeError(`${name} must be a non-negative integer, got ${v}`);
  }
  if (v < 0) {
    throw new RangeError(`${name} must be non-negative, got ${v}`);
  }
}

/**
 * Compute K factor for a bot with the given ratedGames count before this match.
 * @param {number} ratedGames
 * @returns {32 | 16}
 */
export function kFactor(ratedGames) {
  assertNonNegativeInteger(ratedGames, "ratedGames");
  return ratedGames < K_THRESHOLD_GAMES ? K_PROVISIONAL : K_ESTABLISHED;
}

// ---------------------------------------------------------------------------
// Exported: expectedScore
// ---------------------------------------------------------------------------

/**
 * Compute expected Elo score for a player with `myRating` facing `opponentRating`.
 *
 * @param {number} myRating       Pre-settlement rating of this player.
 * @param {number} opponentRating Pre-settlement rating of the opponent.
 * @returns {number} Expected score in [0, 1].
 */
export function expectedScore(myRating, opponentRating) {
  assertNumeric(myRating, "myRating");
  assertFiniteRating(myRating, "myRating");
  assertNumeric(opponentRating, "opponentRating");
  assertFiniteRating(opponentRating, "opponentRating");
  return 1 / (1 + Math.pow(10, (opponentRating - myRating) / 400));
}

// ---------------------------------------------------------------------------
// Exported: eloScore — map outcome to Elo score (1 / 0.5 / 0)
// ---------------------------------------------------------------------------

const ELO_SCORE_MAP = Object.freeze({ win: 1, draw: 0.5, loss: 0 });

/**
 * Convert a match outcome string into the numeric Elo score for this player.
 * Separate from tournament points; "win" here maps to 1, not 3.
 *
 * @param {"win"|"draw"|"loss"} outcome
 * @returns {0 | 0.5 | 1}
 */
export function eloScore(outcome) {
  if (!Object.prototype.hasOwnProperty.call(ELO_SCORE_MAP, outcome)) {
    throw new TypeError(
      `Invalid score outcome '${outcome}'; must be 'win', 'draw', or 'loss'`
    );
  }
  return ELO_SCORE_MAP[outcome];
}

// ---------------------------------------------------------------------------
// Exported: tournamentPoints — separate 3/1/0 mapper for double-RR standings
// ---------------------------------------------------------------------------

const TOURNAMENT_POINTS_MAP = Object.freeze({ win: 3, draw: 1, loss: 0 });

/**
 * Convert a match outcome into tournament points (Double Round-Robin: 3/1/0).
 * These numbers are independent of Elo score values and must not be confused.
 *
 * @param {"win"|"draw"|"loss"} outcome
 * @returns {0 | 1 | 3}
 */
export function tournamentPoints(outcome) {
  if (!Object.prototype.hasOwnProperty.call(TOURNAMENT_POINTS_MAP, outcome)) {
    throw new TypeError(
      `Invalid tournament outcome '${outcome}'; must be 'win', 'draw', or 'loss'`
    );
  }
  return TOURNAMENT_POINTS_MAP[outcome];
}

// ---------------------------------------------------------------------------
// Exported: resultToEloScore / resultToTournamentPoints
// ---------------------------------------------------------------------------

/**
 * Convert structured ArenaMatchResult to Elo score for the given seat.
 * Validates result with existing structured result validator.
 * Forfeits are scored identically to wins/losses (1 for winner, 0 for loser).
 *
 * @param {import("../contracts/index.d.mts").ArenaMatchResult} result
 * @param {"A"|"B"} seat
 * @returns {0 | 0.5 | 1}
 */
export function resultToEloScore(result, seat) {
  const validation = validateArenaMatchResult(result);
  if (!validation.ok) {
    throw new Error(`Invalid ArenaMatchResult: ${JSON.stringify(validation.errors)}`);
  }
  if (seat !== "A" && seat !== "B") {
    throw new TypeError(`Invalid seat '${seat}'; must be 'A' or 'B'`);
  }
  if (result.outcome === "draw") {
    return eloScore("draw");
  }
  if (result.winner === seat) {
    return eloScore("win");
  }
  return eloScore("loss");
}

/**
 * Convert structured ArenaMatchResult to tournament points for the given seat.
 * Validates result with existing structured result validator.
 * Double RR policy: 3-1-0. Forfeit treated like win/loss (3 for winner, 0 for loser).
 *
 * @param {import("../contracts/index.d.mts").ArenaMatchResult} result
 * @param {"A"|"B"} seat
 * @returns {0 | 1 | 3}
 */
export function resultToTournamentPoints(result, seat) {
  const validation = validateArenaMatchResult(result);
  if (!validation.ok) {
    throw new Error(`Invalid ArenaMatchResult: ${JSON.stringify(validation.errors)}`);
  }
  if (seat !== "A" && seat !== "B") {
    throw new TypeError(`Invalid seat '${seat}'; must be 'A' or 'B'`);
  }
  if (result.outcome === "draw") {
    return tournamentPoints("draw");
  }
  if (result.winner === seat) {
    return tournamentPoints("win");
  }
  return tournamentPoints("loss");
}

// ---------------------------------------------------------------------------
// Exported: computeEloResult — atomic Elo settlement for one match
// ---------------------------------------------------------------------------

/**
 * Compute Elo rating changes for both participants of a single ranked match.
 *
 * K is selected per bot using ratedGames count IMMEDIATELY BEFORE this match
 * (pre-settlement snapshot). Both expected scores are derived from the same
 * pre-settlement ratings (ratingA, ratingB) — NOT from any intermediate value.
 *
 * Ratings are stored as REAL (no rounding). UI rounds for display.
 * Asymmetric K values produce non-zero-sum deltas; this is by design.
 *
 * @param {{
 *   ratingA:      number,  // Pre-settlement Elo rating of seat A
 *   ratingB:      number,  // Pre-settlement Elo rating of seat B
 *   ratedGamesA:  number,  // Rated game count for seat A before this match (integer >= 0)
 *   ratedGamesB:  number,  // Rated game count for seat B before this match (integer >= 0)
 *   outcomeForA?: "win"|"draw"|"loss",  // Match outcome from A's perspective
 *   result?:      import("../contracts/index.d.mts").ArenaMatchResult // Structured match result
 * }} params
 *
 * @returns {{
 *   A: { before: number, after: number, delta: number, K: number, score: number },
 *   B: { before: number, after: number, delta: number, K: number, score: number }
 * }}
 */
export function computeEloResult(params) {
  if (!params || typeof params !== "object") {
    throw new TypeError("computeEloResult requires a parameters object");
  }

  const { ratingA, ratingB, ratedGamesA, ratedGamesB, outcomeForA, result } = params;

  // Validate ratings
  assertNumeric(ratingA, "ratingA");
  assertFiniteRating(ratingA, "ratingA");
  assertNumeric(ratingB, "ratingB");
  assertFiniteRating(ratingB, "ratingB");

  // Validate game counts
  assertNonNegativeInteger(ratedGamesA, "ratedGamesA");
  assertNonNegativeInteger(ratedGamesB, "ratedGamesB");

  // Resolve scores
  let scoreA;
  let scoreB;

  if (result !== undefined) {
    scoreA = resultToEloScore(result, "A");
    scoreB = resultToEloScore(result, "B");
    if (outcomeForA !== undefined) {
      const expectedScoreA = eloScore(outcomeForA);
      if (scoreA !== expectedScoreA) {
        throw new Error(
          `outcomeForA '${outcomeForA}' contradicts result outcome (score ${scoreA} vs ${expectedScoreA})`
        );
      }
    }
  } else if (outcomeForA !== undefined) {
    scoreA = eloScore(outcomeForA);
    scoreB = eloScore(outcomeForA === "win" ? "loss" : outcomeForA === "loss" ? "win" : "draw");
  } else {
    throw new TypeError("computeEloResult requires either 'outcomeForA' or 'result'");
  }

  // Compute K factors per bot independently using pre-settlement game counts
  const kA = kFactor(ratedGamesA);
  const kB = kFactor(ratedGamesB);

  // Expected scores — both derived from the same pre-settlement ratings
  const eA = expectedScore(ratingA, ratingB);
  const eB = expectedScore(ratingB, ratingA);

  // Elo deltas (stored as REAL, no rounding)
  const deltaA = kA * (scoreA - eA);
  const deltaB = kB * (scoreB - eB);

  return {
    A: {
      before: ratingA,
      after: ratingA + deltaA,
      delta: deltaA,
      K: kA,
      score: scoreA
    },
    B: {
      before: ratingB,
      after: ratingB + deltaB,
      delta: deltaB,
      K: kB,
      score: scoreB
    }
  };
}
