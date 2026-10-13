/**
 * Execution Profile Registry for Arena AI protocol v1.
 * Manages language execution profiles (Python, FunctionBot), probes executable availability
 * using fixed argument lists and timeouts (strictly shell=false), and instantiates trusted BotPorts.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { createProcessBot } from "./process-bot.mjs";
import { createFunctionBot } from "../../../arena/src/adapters/function-bot.mjs";

const DEFAULT_PROBE_TIMEOUT_MS = 2000;

/**
 * Safely probes an executable with fixed arguments and a timeout.
 * Strictly shell=false.
 * @param {string} executable
 * @param {string[]} [args=["--version"]]
 * @param {number} [timeoutMs=2000]
 * @returns {{ ok: boolean, status: number | null, stdout: string, stderr: string, code?: string, error?: string, timedOut?: boolean }}
 */
export function probeExecutable(executable, args = ["--version"], timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  if (typeof executable !== "string" || executable.trim().length === 0) {
    return { ok: false, status: null, stdout: "", stderr: "", code: "INVALID_EXECUTABLE", error: "Executable must be a non-empty string" };
  }
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
    return { ok: false, status: null, stdout: "", stderr: "", code: "INVALID_ARGS", error: "Args must be an array of strings" };
  }

  try {
    const res = spawnSync(executable, args, {
      shell: false,
      windowsHide: true,
      timeout: timeoutMs,
      encoding: "utf8"
    });

    if (res.error) {
      const isTimeout = res.error.code === "ETIMEDOUT" || Boolean(res.error.timedOut);
      return {
        ok: false,
        status: res.status,
        stdout: res.stdout || "",
        stderr: res.stderr || "",
        code: res.error.code || (isTimeout ? "ETIMEDOUT" : "ERROR"),
        error: res.error.message,
        timedOut: isTimeout
      };
    }

    return {
      ok: res.status === 0,
      status: res.status,
      stdout: res.stdout || "",
      stderr: res.stderr || "",
      code: res.status === 0 ? undefined : "NON_ZERO_EXIT"
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      stdout: "",
      stderr: "",
      code: err.code || "SPAWN_FAILED",
      error: err.message
    };
  }
}

/**
 * Resolves the candidate Python executable name or path according to environment and platform.
 * Priority:
 * 1. options.pythonExecutable
 * 2. process.env.OTT_ARENA_PYTHON
 * 3. Windows: ["python", "python3"]
 * 4. POSIX: ["python3", "python"]
 *
 * @param {object} [options]
 * @returns {{ executable: string, source: "explicit" | "env" | "platform_default", candidates: string[] }}
 */
export function resolvePythonExecutable(options = {}) {
  if (options.pythonExecutable && typeof options.pythonExecutable === "string") {
    return {
      executable: options.pythonExecutable,
      source: "explicit",
      candidates: [options.pythonExecutable]
    };
  }

  const envExe = process.env.OTT_ARENA_PYTHON;
  if (envExe && typeof envExe === "string" && envExe.trim().length > 0) {
    return {
      executable: envExe.trim(),
      source: "env",
      candidates: [envExe.trim()]
    };
  }

  const isWin = process.platform === "win32";
  const candidates = isWin ? ["python", "python3"] : ["python3", "python"];

  // Probe candidates to find the first working binary
  for (const cand of candidates) {
    const probe = probeExecutable(cand, ["--version"], 1500);
    if (probe.ok) {
      return {
        executable: cand,
        source: "platform_default",
        candidates
      };
    }
  }

  // Fallback to first default candidate even if not yet probed
  return {
    executable: candidates[0],
    source: "platform_default",
    candidates
  };
}

/**
 * Creates an execution profile registry.
 * @param {object} [options]
 * @param {string} [options.pythonExecutable]
 * @param {number} [options.probeTimeoutMs=2000]
 */
export function createProfileRegistry(options = {}) {
  const probeTimeoutMs = options.probeTimeoutMs || DEFAULT_PROBE_TIMEOUT_MS;
  const customPython = options.pythonExecutable;

  const profiles = new Map();

  // Built-in Python profile
  profiles.set("python", {
    id: "python",
    language: "python",
    revision: "python-trusted-v1",
    probe() {
      const resolution = resolvePythonExecutable({ pythonExecutable: customPython });
      for (const candidate of resolution.candidates) {
        const probeRes = probeExecutable(candidate, ["--version"], probeTimeoutMs);
        if (probeRes.ok) {
          const rawVer = (probeRes.stdout || probeRes.stderr || "").trim();
          return {
            available: true,
            executable: candidate,
            version: rawVer,
            revision: "python-trusted-v1"
          };
        }
      }
      return {
        available: false,
        executable: resolution.executable,
        version: null,
        error: "python_not_found"
      };
    },
    createBot(sourcePath, botOptions = {}) {
      if (!fs.existsSync(sourcePath)) {
        const err = new Error(`Bot source file does not exist: ${sourcePath}`);
        err.kind = "infrastructure_error";
        err.code = "missing_bot_source";
        err.retryable = false;
        throw err;
      }

      const probeInfo = this.probe();
      if (!probeInfo.available) {
        const err = new Error(`Python runtime is not available (probed '${probeInfo.executable}')`);
        err.kind = "infrastructure_error";
        err.code = "runtime_unavailable";
        err.retryable = false;
        throw err;
      }

      const resolvedPath = path.resolve(sourcePath);
      const cwd = botOptions.cwd || path.dirname(resolvedPath);

      return createProcessBot({
        botId: botOptions.botId || `python-${path.basename(sourcePath, ".py")}`,
        executable: probeInfo.executable,
        args: ["-u", resolvedPath], // -u: unbuffered stdin/stdout binary streams
        cwd,
        env: botOptions.env,
        clock: botOptions.clock,
        graceMs: botOptions.graceMs,
        maxStdoutLineBytes: botOptions.maxStdoutLineBytes,
        maxStdoutTotalBytes: botOptions.maxStdoutTotalBytes,
        maxStderrTotalBytes: botOptions.maxStderrTotalBytes,
        onStderr: botOptions.onStderr
      });
    }
  });

  return {
    listProfiles() {
      return Array.from(profiles.values()).map((p) => ({
        id: p.id,
        language: p.language,
        revision: p.revision
      }));
    },

    getProfile(id) {
      return profiles.get(id) || null;
    },

    registerProfile(profileDef) {
      if (!profileDef || typeof profileDef.id !== "string") {
        throw new Error("Profile definition must include a string id");
      }
      profiles.set(profileDef.id, profileDef);
    },

    probeProfile(id) {
      const p = profiles.get(id);
      if (!p) {
        return { available: false, error: `unknown_profile:${id}` };
      }
      return typeof p.probe === "function" ? p.probe() : { available: true };
    },

    probeAll() {
      const results = {};
      for (const [id, p] of profiles.entries()) {
        results[id] = typeof p.probe === "function" ? p.probe() : { available: true };
      }
      return results;
    },

    resolveBot(botSpec, botOptions = {}) {
      if (typeof botSpec !== "string" || botSpec.trim().length === 0) {
        throw new Error("botSpec must be a non-empty string");
      }

      const spec = botSpec.trim();

      // 1. Built-in FunctionBot: "first-legal"
      if (spec === "first-legal") {
        return createFunctionBot({
          botId: botOptions.botId || "first-legal",
          chooseFn: (turn) => {
            if (!turn.legalMoves || turn.legalMoves.length === 0) {
              throw new Error("No legal moves available in turn payload");
            }
            return turn.legalMoves[0];
          }
        });
      }

      // 2. Profile-based bots: "<profile>:<path>"
      const colonIdx = spec.indexOf(":");
      if (colonIdx === -1) {
        throw new Error(`Unsupported bot specification "${spec}". Expected "first-legal" or "<profile>:<path>"`);
      }

      const profileId = spec.slice(0, colonIdx);
      const sourceSubpath = spec.slice(colonIdx + 1);

      if (!sourceSubpath || sourceSubpath.trim().length === 0) {
        throw new Error(`Invalid bot specification "${spec}": missing source path after prefix`);
      }

      const profile = profiles.get(profileId);
      if (!profile) {
        throw new Error(`Unknown bot profile "${profileId}" in spec "${spec}". Available profiles: ${Array.from(profiles.keys()).join(", ")}`);
      }

      const cwd = botOptions.cwd || process.cwd();
      const resolvedSourcePath = path.isAbsolute(sourceSubpath)
        ? path.normalize(sourceSubpath)
        : path.resolve(cwd, sourceSubpath);

      if (typeof profile.probe === "function") {
        const probeRes = profile.probe();
        if (probeRes && !probeRes.available) {
          const err = new Error(`Bot profile "${profileId}" runtime is unavailable: ${probeRes.error || "not found"}`);
          err.kind = "infrastructure_error";
          err.code = "runtime_unavailable";
          err.retryable = false;
          throw err;
        }
      }

      if (typeof profile.createBot !== "function") {
        const err = new Error(`Profile "${profileId}" does not support createBot`);
        err.kind = "infrastructure_error";
        err.code = "runtime_unavailable";
        err.retryable = false;
        throw err;
      }

      return profile.createBot(resolvedSourcePath, botOptions);
    }
  };
}
