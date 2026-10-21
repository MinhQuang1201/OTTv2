/**
 * packages/arena/src/application/create-tournament.mjs
 *
 * Task 13 (Milestone M4): Pure application usecase for tournament creation.
 *
 * Coordinates:
 * - Tournament entry validation
 * - Double Round-Robin schedule computation
 * - Delegation to transactional tournament repository
 * - Idempotency handling
 *
 * Strictly NO direct database imports (pure application layer).
 */

import {
  generateDoubleRoundRobinSchedule,
  validateTournamentEntries
} from "../domain/round-robin.mjs";

export class TournamentValidationError extends Error {
  constructor(message, code = "TOURNAMENT_VALIDATION_ERROR") {
    super(message);
    this.name = "TournamentValidationError";
    this.code = code;
  }
}

/**
 * Creates the CreateTournament application usecase.
 *
 * @param {object} dependencies
 * @param {object} dependencies.tournamentRepo
 * @param {Function} [dependencies.scheduleGenerator]
 */
export function createTournamentUseCase(dependencies) {
  if (!dependencies || !dependencies.tournamentRepo) {
    throw new TypeError("createTournamentUseCase requires dependencies.tournamentRepo");
  }

  const {
    tournamentRepo,
    scheduleGenerator = generateDoubleRoundRobinSchedule
  } = dependencies;

  return {
    async execute(input, options = {}) {
      if (!input || typeof input !== "object") {
        throw new TournamentValidationError("Tournament input must be a non-null object");
      }

      if (!input.name || typeof input.name !== "string" || input.name.trim().length === 0) {
        throw new TournamentValidationError("Tournament name is mandatory and non-empty");
      }

      if (!Array.isArray(input.entries)) {
        throw new TournamentValidationError("Tournament entries must be an array");
      }

      if (input.entries.length < 2) {
        throw new TournamentValidationError(
          `Tournament requires at least 2 distinct bots, got ${input.entries.length}`
        );
      }

      // Validate pairings and schedule upfront using actual domain schedule generator
      let schedule;
      try {
        schedule = scheduleGenerator(input.entries);
      } catch (err) {
        throw new TournamentValidationError(`Invalid tournament entries for pairing: ${err.message}`);
      }

      return await tournamentRepo.createTournament(
        {
          ...input,
          schedule
        },
        options
      );
    }
  };
}
