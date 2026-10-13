/**
 * packages/arena/src/application/finalize-match.d.mts
 *
 * TypeScript declarations for match finalization application use case.
 */

import type {
  MatchCompletionEnvelope,
  FinalizedMatch,
  ValidationResult
} from "../contracts/index.d.mts";

export declare class FinalizerConflictError extends Error {
  code: "FINALIZER_CONFLICT";
  constructor(message?: string);
}

export declare class StaleLeaseError extends Error {
  code: "STALE_LEASE";
  details: Record<string, unknown>;
  constructor(message?: string, details?: Record<string, unknown>);
}

export declare class MatchValidationError extends Error {
  code: string;
  constructor(message?: string, code?: string);
}

export interface CompletionPayload {
  matchId: string;
  result: unknown;
  replayDigest: string;
}

export declare function computeCompletionPayload(params: CompletionPayload): CompletionPayload;

export declare function computeCompletionDigest(
  payload: unknown,
  computeDigest: (val: string) => string
): string;

export interface FinalizerRepositoryPort {
  finalizeMatch(envelope: MatchCompletionEnvelope): Promise<FinalizedMatch> | FinalizedMatch;
}

export interface FinalizeMatchUseCaseDependencies {
  finalizerRepo?: FinalizerRepositoryPort;
  finalizationRepo?: FinalizerRepositoryPort;
  computeDigest: (val: string) => string;
  validator?: (envelope: unknown) => ValidationResult;
}

export interface FinalizeMatchUseCase {
  finalizeMatch(envelope: MatchCompletionEnvelope): Promise<FinalizedMatch>;
}

export declare function createFinalizeMatchUseCase(
  dependencies: FinalizeMatchUseCaseDependencies
): FinalizeMatchUseCase;
