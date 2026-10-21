import type { Database } from "better-sqlite3";
import type { JobQueue, ClaimedJob } from "../persistence/job-queue.d.mts";
import type { ArtifactStore } from "../artifacts/artifact-store.d.mts";
import type { ContainerRunLimits, ContainerRuntimeProbe } from "../execution/container-executor.d.mts";
import type { ProfileRegistry } from "../execution/profile-registry.d.mts";
import type { LiveFrameStore } from "../persistence/live-frame-store.d.mts";

export interface BotFactoryContext {
  match: unknown;
  clock: unknown;
  supervisorSignal: AbortSignal;
}

export type BotFactory = (
  seat: "A" | "B",
  participant: unknown,
  context: BotFactoryContext
) => Promise<unknown> | unknown;

export interface JobWorkerOptions {
  workerId: string;
  db: Database;
  jobQueue: JobQueue;
  matchRepo: unknown;
  finalizer?: unknown;
  botVersionService?: unknown;
  botFactory?: BotFactory;
  artifactStore?: ArtifactStore | null;
  profileRegistry?: ProfileRegistry | null;
  liveFrameStore?: LiveFrameStore | null;
  getEngine?: () => unknown;
  getClock?: () => unknown;
  getJournal?: () => unknown;
  getEngineFingerprint?: () => string;
  computeDigest?: (val: string) => string;
  heartbeatIntervalMs?: number;
  leaseDurationMs?: number;
  pollIntervalMs?: number;
  allowedKinds?: string[] | null;
}

export interface WorkerExecutionOutcome {
  executed: boolean;
  claim: ClaimedJob | null;
  result?: unknown;
  error?: unknown;
}

export interface WorkerStatus {
  workerId: string;
  state: "idle" | "running" | "stopping";
  currentJob: ClaimedJob | null;
}

export interface JobWorker {
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<WorkerExecutionOutcome>;
  getStatus(): WorkerStatus;
}

export function createJobWorker(options: JobWorkerOptions): JobWorker;

export interface ProfileBotContainerExecutor {
  image?: string;
  commandRunner?: unknown;
  limits?: ContainerRunLimits;
  probe?: () => ContainerRuntimeProbe;
}

export function createProfileBotFactory(options: {
  artifactStore: ArtifactStore;
  profileRegistry: ProfileRegistry;
  containerExecutor?: ProfileBotContainerExecutor | null;
}): BotFactory;
