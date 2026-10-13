/**
 * packages/arena/src/application/finalize-match.mjs
 *
 * Pure application use case for match finalization.
 * Implements envelope validation, cryptographic digest verification, and delegation
 * to the transactional finalization repository.
 *
 * Strictly NO Node built-ins (node:crypto, node:fs, etc.).
 */

import { canonicalSerialize, validateMatchCompletionEnvelope } from "../contracts/index.mjs";

export class FinalizerConflictError extends Error {
  constructor(message = "Match already settled with conflicting completion") {
    super(message);
    this.name = "FinalizerConflictError";
    this.code = "FINALIZER_CONFLICT";
  }
}

export class StaleLeaseError extends Error {
  constructor(message = "Match job lease is stale, expired, or overtaken", details = {}) {
    super(message);
    this.name = "StaleLeaseError";
    this.code = "STALE_LEASE";
    this.details = details;
  }
}

export class MatchValidationError extends Error {
  constructor(message = "Match completion validation failed", code = "MATCH_VALIDATION_ERROR") {
    super(message);
    this.name = "MatchValidationError";
    this.code = code;
  }
}

/**
 * Normalizes and extracts canonical payload used to compute the completion digest.
 * Excludes attemptNo and leaseToken to ensure canonical idempotency across worker retry attempts.
 *
 * @param {{ matchId: string, result: unknown, replayDigest: string }} payload
 * @returns {{ matchId: string, result: unknown, replayDigest: string }}
 */
export function computeCompletionPayload({ matchId, result, replayDigest }) {
  if (!matchId || !result || !replayDigest) {
    throw new MatchValidationError("Missing required fields for completion payload", "INVALID_COMPLETION_PAYLOAD");
  }
  return {
    matchId,
    result,
    replayDigest
  };
}

/**
 * Computes completion digest from canonical payload and injected computeDigest function.
 *
 * @param {unknown} payload
 * @param {(val: string) => string} computeDigest
 * @returns {string}
 */
export function computeCompletionDigest(payload, computeDigest) {
  if (typeof computeDigest !== "function") {
    throw new TypeError("computeDigest function must be provided to computeCompletionDigest");
  }
  const normalized =
    payload && typeof payload === "object" && "matchId" in payload && "replayDigest" in payload
      ? computeCompletionPayload(payload)
      : payload;
  const serialized = canonicalSerialize(normalized);
  return computeDigest(serialized);
}

/**
 * Factory for match finalization use case.
 *
 * @param {{
 *   finalizerRepo?: { finalizeMatch: (envelope: unknown) => Promise<unknown> | unknown },
 *   finalizationRepo?: { finalizeMatch: (envelope: unknown) => Promise<unknown> | unknown },
 *   computeDigest: (val: string) => string,
 *   validator?: (envelope: unknown) => { ok: boolean, errors: readonly { message: string, path: string }[] }
 * }} dependencies
 */
export function createFinalizeMatchUseCase(dependencies) {
  if (!dependencies || typeof dependencies !== "object") {
    throw new TypeError("createFinalizeMatchUseCase requires dependencies object");
  }

  const finalizerRepo = dependencies.finalizationRepo || dependencies.finalizerRepo;
  if (!finalizerRepo || typeof finalizerRepo.finalizeMatch !== "function") {
    throw new TypeError("dependencies must include finalizerRepo or finalizationRepo with finalizeMatch function");
  }

  const { computeDigest, validator = validateMatchCompletionEnvelope } = dependencies;
  if (typeof computeDigest !== "function") {
    throw new TypeError("dependencies must include computeDigest function");
  }

  return {
    async finalizeMatch(envelope) {
      if (!envelope || typeof envelope !== "object") {
        throw new MatchValidationError("Match completion envelope must be a non-null object", "INVALID_ENVELOPE");
      }

      // 1. Structural schema validation
      const validation = validator(envelope);
      if (!validation.ok) {
        const msg = validation.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
        throw new MatchValidationError(`Invalid match completion envelope: ${msg}`, "INVALID_ENVELOPE");
      }

      // 2. Cryptographic Replay Digest verification
      const serializedReplay = canonicalSerialize(envelope.replay);
      const computedReplayDigest = computeDigest(serializedReplay);
      if (computedReplayDigest !== envelope.replayDigest) {
        throw new MatchValidationError(
          `Replay digest mismatch: expected ${computedReplayDigest}, got ${envelope.replayDigest}`,
          "REPLAY_DIGEST_MISMATCH"
        );
      }

      // 3. Cryptographic Completion Digest verification
      const completionPayload = computeCompletionPayload(envelope);
      const computedCompletionDigest = computeCompletionDigest(completionPayload, computeDigest);
      if (computedCompletionDigest !== envelope.completionDigest) {
        throw new MatchValidationError(
          `Completion digest mismatch: expected ${computedCompletionDigest}, got ${envelope.completionDigest}`,
          "COMPLETION_DIGEST_MISMATCH"
        );
      }

      // 4. Delegate to atomic finalization repository
      return await finalizerRepo.finalizeMatch(envelope);
    }
  };
}
