/**
 * packages/arena-node/src/persistence/bot-version-service.d.mts
 *
 * TypeScript declarations for BotVersionService (Task 9).
 */

import type { Database } from "better-sqlite3";
import type { ArtifactStore } from "../artifacts/artifact-store.d.mts";
import type { BuildService } from "../execution/build-service.d.mts";
import type { ProfileRegistry } from "../execution/profile-registry.d.mts";
import type { BotVersionRecord } from "./bot-repository.d.mts";

export { IdempotencyConflictError, NotFoundError, OwnershipError } from "./bot-repository.d.mts";

export class StaleLeaseError extends Error {
  code: "STALE_LEASE";
  details: { jobId?: string; attemptNo?: number; leaseToken?: string };
  constructor(message?: string, details?: { jobId?: string; attemptNo?: number; leaseToken?: string });
}

export class ProfileUnavailableError extends Error {
  code: "PROFILE_UNAVAILABLE";
  profileId: string | null;
  constructor(message?: string, profileId?: string | null);
}

export class PayloadTooLargeError extends Error {
  code: "PAYLOAD_TOO_LARGE";
  bytes: number;
  maxBytes: number;
  constructor(message?: string, bytes?: number, maxBytes?: number);
}

export class BotVersionNotReadyError extends Error {
  code: "BOT_VERSION_NOT_READY";
  status: string;
  constructor(message?: string, status?: string);
}

export interface JobRecord {
  id: string;
  kind: "build" | "match";
  target_id: string;
  status: "queued" | "claimed" | "completed" | "failed" | "cancelled";
  attempt_no: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_until: string | null;
  heartbeat_at: string | null;
  max_attempts: number;
  created_at: string;
}

export interface JobAttemptRecord {
  job_id: string;
  attempt_no: number;
  lease_token: string;
  status: "active" | "completed" | "failed" | "fenced";
  diagnostic: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface UploadBotVersionInput {
  botId: string;
  sourceContent: string | Buffer | Uint8Array;
  profileId: string;
  profileRevision?: string;
  versionId?: string;
  jobId?: string;
  filename?: string;
}

export interface UploadBotVersionOptions {
  actorId: string;
  idempotencyKey: string;
}

export interface UploadBotVersionResult {
  botVersion: BotVersionRecord;
  job: JobRecord;
  isReplay: boolean;
}

export interface ClaimBuildJobParams {
  jobId: string;
  leaseOwner?: string;
  leaseDurationMs?: number;
}

export interface ClaimBuildJobResult {
  jobId: string;
  attemptNo: number;
  leaseToken: string;
  leaseUntil: string;
  targetId: string;
}

export interface CompleteBuildJobParams {
  jobId: string;
  attemptNo: number;
  leaseToken: string;
  success: boolean;
  artifactDigest?: string | null;
  buildLog?: string | null;
  diagnostic?: string | null;
}

export interface CompleteBuildJobResult {
  job: JobRecord;
  botVersion: BotVersionRecord;
}

export interface ProcessBuildJobParams {
  jobId: string;
  leaseOwner?: string;
  leaseDurationMs?: number;
}

export interface ProcessBuildJobResult {
  lease: ClaimBuildJobResult;
  buildResult: any;
  botVersion: BotVersionRecord;
  job: JobRecord;
}

export interface BotVersionServiceOptions {
  db: Database;
  artifactStore: ArtifactStore;
  buildService?: BuildService | null;
  profileRegistry?: ProfileRegistry | null;
  maxSourceBytes?: number;
}

export interface BotVersionService {
  uploadBotVersion(
    input: UploadBotVersionInput,
    options: UploadBotVersionOptions
  ): Promise<UploadBotVersionResult>;

  claimBuildJob(params: ClaimBuildJobParams): ClaimBuildJobResult;

  completeBuildJob(params: CompleteBuildJobParams): Promise<CompleteBuildJobResult>;

  processBuildJob(params: ProcessBuildJobParams): Promise<ProcessBuildJobResult>;

  verifyBotVersionArtifact(botVersionId: string): Promise<{
    botVersion: BotVersionRecord;
    artifact: { digest: string; path: string; bytes: number };
  }>;

  validateBotVersionForMatch(botVersionId: string): Promise<boolean>;

  getBotVersion(botVersionId: string): BotVersionRecord | undefined;

  getBuildJob(jobId: string): JobRecord | undefined;

  getBuildJobForVersion(botVersionId: string): JobRecord | undefined;

  listJobAttempts(jobId: string): JobAttemptRecord[];
}

export function createBotVersionService(options: BotVersionServiceOptions): BotVersionService;
