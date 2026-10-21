import type { BotPort } from "../../../arena/src/ports/index.d.mts";
import type { ProcessBotOptions } from "./process-bot.d.mts";

export interface ProbeResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  code?: string;
  error?: string;
  timedOut?: boolean;
}

export interface ProfileResolution {
  executable: string;
  source: "explicit" | "env" | "platform_default";
  candidates: string[];
}

export interface ProfileDefinition {
  id: string;
  language: string;
  revision: string;
  entryName?: string;
  probe?(): {
    available: boolean;
    executable?: string | null;
    javacExecutable?: string;
    javaExecutable?: string;
    jarExecutable?: string;
    version?: string | null;
    revision?: string;
    error?: string;
  };
  compile?(options: {
    buildDir: string;
    sourceFilePath: string;
    compilerOptions?: readonly string[];
    timeoutMs?: number;
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
  createBot?(sourcePath: string, botOptions?: Partial<ProcessBotOptions>): BotPort;
}

export interface ProfileSummary {
  id: string;
  language: string;
  revision: string;
}

export interface ProfileRegistryOptions {
  pythonExecutable?: string;
  nodeExecutable?: string;
  cppExecutable?: string;
  javacExecutable?: string;
  javaExecutable?: string;
  jarExecutable?: string;
  probeTimeoutMs?: number;
}

export interface ProfileRegistry {
  listProfiles(): ProfileSummary[];
  getProfile(id: string): ProfileDefinition | null;
  registerProfile(profileDef: ProfileDefinition): void;
  probeProfile(id: string): { available: boolean; executable?: string | null; version?: string | null; revision?: string; error?: string };
  probeAll(): Record<string, { available: boolean; executable?: string | null; version?: string | null; revision?: string; error?: string }>;
  resolveBot(botSpec: string, botOptions?: Partial<ProcessBotOptions>): BotPort;
}

export declare function probeExecutable(
  executable: string,
  args?: string[],
  timeoutMs?: number
): ProbeResult;

export declare function resolvePythonExecutable(options?: {
  pythonExecutable?: string;
}): ProfileResolution;

export declare function resolveNodeExecutable(options?: {
  nodeExecutable?: string;
}): ProfileResolution;

export declare function resolveCppExecutable(options?: {
  cppExecutable?: string;
}): ProfileResolution;

export declare function parseJavaMajorVersion(versionStr: string): number | null;

export declare function resolveJavaExecutables(options?: {
  javacExecutable?: string;
  javaExecutable?: string;
  jarExecutable?: string;
}): {
  javac: string;
  java: string;
  jar: string;
  candidates: {
    javac: string[];
    java: string[];
    jar: string[];
  };
};

export declare function createProfileRegistry(options?: ProfileRegistryOptions): ProfileRegistry;
