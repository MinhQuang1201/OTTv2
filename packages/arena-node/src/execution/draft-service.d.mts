/**
 * packages/arena-node/src/execution/draft-service.d.mts
 */

import type { Database } from "better-sqlite3";
import type { ProfileRegistry } from "./profile-registry.d.mts";

export type DraftIsolationMode = "container" | "trusted-process";

export interface DraftCompileResult {
  status: "ok" | "failed";
  logs: string;
}

export interface DraftExecutionResult {
  legal?: boolean;
  move?: {
    from: { x: number; y: number };
    to: { x: number; y: number };
  };
  comment?: string | null;
  elapsedMs?: number;
  error?: string;
}

export interface DraftRunResult {
  status: "success" | "compile_error" | "execution_error" | "unavailable";
  isolation?: DraftIsolationMode;
  error?: string;
  details?: Record<string, unknown>;
  compile?: DraftCompileResult;
  execution?: DraftExecutionResult;
  nextState?: object;
}

export interface DraftServiceOptions {
  profileRegistry: ProfileRegistry;
  containerExecutor?: object | null;
  trustedLocalMode?: boolean;
  tempBaseDir?: string;
  maxConcurrentDrafts?: number;
  compileTimeoutMs?: number;
  startTimeoutMs?: number;
  turnTimeoutMs?: number;
  maxOutputBytes?: number;
}

export interface DraftService {
  runDraft(params: {
    db: Database;
    authorId: string;
    authorRole?: string;
    isAdmin?: boolean;
    botId: string;
    source: string;
    profileId: string;
    mapId?: string;
  }): Promise<DraftRunResult>;
}

export class OwnershipMismatchError extends Error {
  readonly code: "OWNERSHIP_MISMATCH";
}

export class ConcurrencyLimitError extends Error {
  readonly code: "CONCURRENCY_LIMIT_EXCEEDED";
  readonly statusCode: 429;
}

export function createDraftService(options: DraftServiceOptions): DraftService;
