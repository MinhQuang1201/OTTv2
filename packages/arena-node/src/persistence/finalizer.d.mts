/**
 * packages/arena-node/src/persistence/finalizer.d.mts
 *
 * TypeScript definitions for SQLite match finalizer.
 */

import type { Database } from "better-sqlite3";
import type {
  MatchCompletionEnvelope,
  FinalizedMatch
} from "../../../arena/src/contracts/index.d.mts";
import {
  FinalizerConflictError,
  StaleLeaseError,
  MatchValidationError
} from "../../../arena/src/application/finalize-match.d.mts";

export { FinalizerConflictError, StaleLeaseError, MatchValidationError };

export interface MatchFinalizer {
  finalizeMatch(envelope: MatchCompletionEnvelope): FinalizedMatch;
}

export interface MatchFinalizerOptions {
  computeDigest?: (val: string) => string;
}

export declare function createMatchFinalizer(
  db: Database,
  options?: MatchFinalizerOptions
): MatchFinalizer;
