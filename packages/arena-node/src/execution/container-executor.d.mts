/**
 * Type declarations for ContainerExecutor
 */

import type { BotPort } from "../../../arena/src/ports/index.d.mts";
import type { ArtifactStore } from "../artifacts/artifact-store.d.mts";

export interface ContainerRunLimits {
  readonly network: string;
  readonly user: string;
  readonly capDrop: readonly string[];
  readonly securityOpt: readonly string[];
  readonly readOnlyRoot: boolean;
  readonly tmpfsScratch: string;
  readonly memoryBytes: number;
  readonly memoryFlag: string;
  readonly memorySwapFlag: string;
  readonly pidsLimit: number;
  readonly cpus: string;
  readonly stdoutMaxLineBytes: number;
  readonly stdoutMaxTotalBytes: number;
  readonly stderrMaxTotalBytes: number;
  readonly startupTimeoutMs: number;
  readonly graceStopMs: number;
}

export interface ContainerBuildLimits {
  readonly network: string;
  readonly user: string;
  readonly capDrop: readonly string[];
  readonly securityOpt: readonly string[];
  readonly readOnlyRoot: boolean;
  readonly tmpfsScratch: string;
  readonly memoryBytes: number;
  readonly memoryFlag: string;
  readonly memorySwapFlag: string;
  readonly pidsLimit: number;
  readonly cpus: string;
  readonly buildTimeoutMs: number;
  readonly maxLogBytes: number;
}

export interface ContainerRuntimeProbe {
  readonly available: boolean;
  readonly verified: boolean;
  readonly dockerVersion: string | null;
  readonly serverOs: string | null;
  readonly serverArch: string | null;
  readonly imageId: string | null;
  readonly imageDigest: string | null;
  readonly image?: string;
  readonly supportedProfiles: readonly string[];
  readonly unsupportedProfiles: readonly string[];
  readonly reason?: string;
}

export const CONTAINER_EXECUTOR_REVISION: string;
export const PINNED_RUNNER_IMAGE: string;
export const PINNED_RUNNER_IMAGE_ID: string;
export const PINNED_BASE_IMAGE_DIGEST: string;
export const DEFAULT_CONTAINER_RUN_LIMITS: ContainerRunLimits;
export const DEFAULT_CONTAINER_BUILD_LIMITS: ContainerBuildLimits;

export function validateContainerName(name: string): boolean;
export function generateContainerName(role: "bot" | "build", contextId: string, attempt?: number): string;
export function getIsolationProfileCapabilities(): Record<string, { available: boolean; reason?: string }>;
export function probeContainerRuntime(options?: {
  image?: string;
  expectedImageId?: string;
  verifiedTargetHost?: boolean;
  hostVerificationProof?: any;
  commandRunner?: any;
}): ContainerRuntimeProbe;
export function buildDockerRunArgs(params: any): string[];

export function createContainerBot(options: {
  botId: string;
  profileId: string;
  artifactStore?: ArtifactStore;
  artifactDigest?: string;
  expectedManifest?: any;
  sourcePath?: string;
  sourceContent?: string | Buffer;
  rawSourceTestOnly?: boolean;
  image?: string;
  clock?: { nowMs(): number };
  limits?: ContainerRunLimits;
  commandRunner?: any;
  attempt?: number;
  onStderr?: (chunk: string) => void;
}): BotPort & { readonly botId: string; readonly containerName: string | null; readonly hasExited: boolean };

export function createContainerBuildService(options: {
  artifactStore: ArtifactStore;
  image?: string;
  limits?: ContainerBuildLimits;
  commandRunner?: any;
}): {
  readonly artifactStore: ArtifactStore;
  build(request: any): Promise<any>;
  getManifest(artifactDigest: string): Promise<any>;
};
