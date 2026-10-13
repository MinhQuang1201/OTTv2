import type { Database } from "better-sqlite3";

export type JobKind = "build" | "match";
export type JobStatus = "queued" | "claimed" | "completed" | "failed" | "cancelled";
export type JobAttemptStatus = "active" | "completed" | "failed" | "fenced";

export interface JobRecord {
  id: string;
  kind: JobKind;
  target_id: string;
  status: JobStatus;
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
  status: JobAttemptStatus;
  diagnostic: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface ClaimedJob {
  jobId: string;
  kind: JobKind;
  targetId: string;
  attemptNo: number;
  leaseToken: string;
  leaseOwner: string;
  leaseUntil: string;
  heartbeatAt: string;
  maxAttempts: number;
}

export interface EnqueueJobParams {
  kind: JobKind;
  targetId: string;
  maxAttempts?: number;
  id?: string | null;
}

export interface ClaimNextJobParams {
  workerId?: string;
  leaseDurationMs?: number;
  allowedKinds?: JobKind[] | null;
}

export interface HeartbeatJobParams {
  jobId: string;
  leaseToken: string;
  attemptNo: number;
  extendDurationMs?: number;
}

export interface ReleaseJobParams {
  jobId: string;
  leaseToken: string;
  attemptNo: number;
  reason?: string;
}

export interface RecoveredJobOutcome {
  jobId: string;
  kind: JobKind;
  targetId: string;
  attemptNo: number;
  action: "requeued" | "failed";
}

export interface JobQueue {
  enqueueJob(params: EnqueueJobParams): JobRecord;
  claimNextJob(params?: ClaimNextJobParams): ClaimedJob | null;
  heartbeatJob(params: HeartbeatJobParams): boolean;
  releaseJob(params: ReleaseJobParams): boolean;
  recoverExpiredJobs(): RecoveredJobOutcome[];
  getJob(jobId: string): JobRecord | null;
  getJobByTarget(kind: JobKind, targetId: string): JobRecord | null;
  getJobAttempts(jobId: string): JobAttemptRecord[];
}

export interface CreateJobQueueOptions {
  defaultLeaseDurationMs?: number;
  defaultHeartbeatIntervalMs?: number;
  defaultMaxAttempts?: number;
}

export function createJobQueue(db: Database, options?: CreateJobQueueOptions): JobQueue;
