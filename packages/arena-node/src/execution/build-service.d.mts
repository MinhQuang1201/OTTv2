import type { ArtifactStore } from "../artifacts/artifact-store.d.mts";

export declare const MAX_BUILD_LOG_BYTES: number;
export declare const DEFAULT_BUILD_DEADLINE_MS: number;
export declare const EXECUTOR_REVISION: string;

export interface BuildCacheKeyParams {
  sourceDigest: string;
  profileId: string;
  profileRevision?: string;
  compilerVersion?: string;
  compilerOptions?: readonly string[];
  executor?: string;
}

export declare function computeBuildCacheKey(params: BuildCacheKeyParams): string;

export interface BuildManifest {
  schemaVersion: number;
  artifactDigest: string;
  sourceDigest: string;
  profileId: string;
  profileRevision: string;
  compilerVersion: string;
  compilerOptions: string[];
  executor: string;
  builtAt: string;
  status: "READY" | "FAILED";
  entrypoint: string;
  bytes: number;
}

export interface BuildRequest {
  sourceContent?: string | Uint8Array;
  sourcePath?: string;
  profileId: string;
  compilerOptions?: readonly string[];
  signal?: AbortSignal;
}

export interface BuildResult {
  status: "READY" | "FAILED";
  artifactDigest: string | null;
  manifest: BuildManifest | null;
  logs: string;
  durationMs: number;
  error?: string;
}

export interface CompilerHandler {
  profileId?: string;
  profileRevision?: string;
  compilerVersion?: string;
  entryName?: string;
  compile(options: {
    buildDir: string;
    sourceFilePath: string;
    sourceContent: Uint8Array;
    compilerOptions: readonly string[];
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{
    status: number;
    stdout: string;
    stderr: string;
    entrypoint?: string;
    timedOut?: boolean;
    aborted?: boolean;
    error?: string;
  }> | {
    status: number;
    stdout: string;
    stderr: string;
    entrypoint?: string;
    timedOut?: boolean;
    aborted?: boolean;
    error?: string;
  };
}

export interface BuildServiceOptions {
  artifactStore: ArtifactStore;
  compilers?: Record<string, CompilerHandler>;
  profileRegistry?: {
    getProfile(profileId: string): CompilerHandler | undefined;
  };
  buildDeadlineMs?: number;
}

export interface BuildService {
  readonly artifactStore: ArtifactStore;
  build(request: BuildRequest): Promise<BuildResult>;
  getManifest(artifactDigest: string): Promise<Record<string, unknown> | null>;
}

export declare function createBuildService(options: BuildServiceOptions): BuildService;
