/**
 * ProcessBot adapter for Arena AI protocol v1.
 * Spawns child process bots with shell=false, sanitized environment, and private working directory.
 * Implements BotPort with AbortSignal support, receipt monotonic timestamping, and graceful/tree termination.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { createNdjsonChannel } from "./ndjson-channel.mjs";
import {
  killProcessTree,
  isProcessAlive,
  createProcessTreeMarker,
  waitForProcessesExit,
  PROCESS_TREE_MARKER_ENV
} from "./process-tree.mjs";

const DEFAULT_GRACE_MS = 250;

/**
 * Returns a sanitized baseline environment containing only safe system and runtime paths.
 */
export function getDefaultSanitizedEnv() {
  const safeKeys = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOME",
    "LANG",
    "LC_ALL",
    "COMSPEC",
    "ComSpec"
  ];

  const env = {};
  for (const key of safeKeys) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}

/**
 * Creates a BotPort adapter backed by an isolated child process.
 * @param {object} options
 * @param {string} options.botId - Unique bot identifier
 * @param {string} options.executable - Absolute path or binary name to execute
 * @param {string[]} [options.args=[]] - Fixed argument list
 * @param {string} [options.cwd] - Private working directory (must exist)
 * @param {Record<string, string>} [options.env] - Additional sanitized environment variables
 * @param {object} [options.clock] - Referee clock port for monotonic timestamps
 * @param {number} [options.graceMs=250] - Shutdown grace period in ms before tree SIGKILL / taskkill
 * @param {number} [options.maxStdoutLineBytes] - Per-line stdout cap
 * @param {number} [options.maxStdoutTotalBytes] - Cumulative match stdout cap
 * @param {number} [options.maxStderrTotalBytes] - Cumulative match stderr cap
 * @returns {import("../../ports/index.d.mts").BotPort & { readonly botId: string, readonly pid: number | null }}
 */
export function createProcessBot(options) {
  if (!options || typeof options !== "object") {
    throw new Error("ProcessBot options must be an object");
  }

  const {
    botId,
    executable,
    args = [],
    cwd = process.cwd(),
    env = {},
    clock = { nowMs: () => performance.now() },
    graceMs = DEFAULT_GRACE_MS,
    maxStdoutLineBytes,
    maxStdoutTotalBytes,
    maxStderrTotalBytes,
    onStderr
  } = options;

  if (typeof botId !== "string" || botId.length === 0) {
    throw new Error("ProcessBot requires a non-empty string botId");
  }
  if (typeof executable !== "string" || executable.length === 0) {
    throw new Error("ProcessBot requires a non-empty string executable");
  }
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
    throw new Error("ProcessBot args must be an array of strings");
  }

  let child = null;
  let channel = null;
  let started = false;
  let stopped = false;
  let hasExited = false;
  let exitCode = null;
  let exitSignal = null;
  let exitPromise = null;
  let stopPromise = null;
  let spawnPid = null;

  const actionReceiptTimes = new WeakMap();
  // Inherited by descendants so stop() can find ones that left the process group (see process-tree.mjs).
  const treeMarker = createProcessTreeMarker();

  return {
    get botId() {
      return botId;
    },

    get pid() {
      return spawnPid;
    },

    get hasExited() {
      return hasExited;
    },

    getReceiptTime(action) {
      if (action && typeof action === "object" && actionReceiptTimes.has(action)) {
        return actionReceiptTimes.get(action);
      }
      return null;
    },

    getFault() {
      if (channel) {
        const cf = channel.getFault();
        if (cf) return cf;
      }
      if (hasExited && !stopped) {
        return {
          code: "crash",
          message: `Process exited prematurely (code ${exitCode}, signal ${exitSignal})`
        };
      }
      return null;
    },

    consumeFault() {
      if (channel) {
        const cf = channel.consumeFault();
        if (cf) return cf;
      }
      if (hasExited && !stopped) {
        return {
          code: "crash",
          message: `Process exited prematurely (code ${exitCode}, signal ${exitSignal})`
        };
      }
      return null;
    },

    triggerFaultForTest(errObj) {
      if (channel && typeof channel.triggerFault === "function") {
        channel.triggerFault(errObj);
      }
    },

    async start(context) {
      if (stopped) return;
      if (started) return; // Idempotent

      // Ensure private cwd exists
      if (!fs.existsSync(cwd)) {
        const err = new Error(`ProcessBot cwd does not exist: ${cwd}`);
        err.kind = "infrastructure_error";
        err.code = "missing_cwd";
        err.retryable = false;
        throw err;
      }

      // Prepare sanitized environment: safe baseline merged with provided variables
      const processEnv = {
        ...getDefaultSanitizedEnv(),
        ...env,
        [PROCESS_TREE_MARKER_ENV]: treeMarker
      };

      await new Promise((resolve, reject) => {
        let settled = false;
        let startupTimer = null;

        function cleanupStartupTimer() {
          if (startupTimer !== null) {
            clearTimeout(startupTimer);
            startupTimer = null;
          }
        }

        startupTimer = setTimeout(() => {
          if (!settled) {
            settled = true;
            try {
              if (child?.pid) killProcessTree(child.pid, { marker: treeMarker });
              else child?.kill();
            } catch (_) {}
            if (stopped) {
              resolve();
              return;
            }
            const err = new Error(`ProcessBot '${botId}' startup timed out after 5000ms`);
            err.kind = "infrastructure_error";
            err.code = "startup_timeout";
            err.retryable = false;
            reject(err);
          }
        }, 5000);

        try {
          child = spawn(executable, args, {
            cwd,
            env: processEnv,
            shell: false, // Strictly no shell
            stdio: ["pipe", "pipe", "pipe"],
            detached: process.platform !== "win32", // New process group on POSIX
            windowsHide: true
          });
        } catch (spawnErr) {
          settled = true;
          cleanupStartupTimer();
          const infraErr = new Error(`Failed to spawn bot '${botId}': ${spawnErr.message}`);
          infraErr.kind = "infrastructure_error";
          infraErr.code = spawnErr.code === "ENOENT" ? "spawn_enoent" : (spawnErr.code === "EACCES" ? "spawn_eacces" : "spawn_failed");
          infraErr.retryable = false;
          reject(infraErr);
          return;
        }

        spawnPid = child.pid || null;

        exitPromise = new Promise((resExit) => {
          child.once("close", (code, sig) => {
            hasExited = true;
            exitCode = code;
            exitSignal = sig;
            resExit({ code, sig });
          });
        });

        // Persistent error listener: handle early spawn errors and late child errors
        child.on("error", (err) => {
          if (!settled) {
            settled = true;
            cleanupStartupTimer();
            const infraErr = new Error(`Failed to spawn bot '${botId}': ${err.message}`);
            infraErr.kind = "infrastructure_error";
            infraErr.code = err.code === "ENOENT" ? "spawn_enoent" : (err.code === "EACCES" ? "spawn_eacces" : "spawn_failed");
            infraErr.retryable = false;
            reject(infraErr);
          } else {
            if (channel && typeof channel.triggerFault === "function") {
              channel.triggerFault({
                code: "crash",
                message: `Child process error after spawn: ${err.message}`
              });
            }
          }
        });

        child.once("spawn", () => {
          cleanupStartupTimer();
          if (!settled) {
            settled = true;
            spawnPid = child.pid;

            // Stop called while startup was pending: never mark started=true
            if (stopped) {
              started = false;
              try {
                if (spawnPid) killProcessTree(spawnPid, { marker: treeMarker });
              } catch (_) {}
              resolve();
              return;
            }

            started = true;

            channel = createNdjsonChannel({
              stdout: child.stdout,
              stderr: child.stderr,
              stdin: child.stdin,
              clock,
              maxStdoutLineBytes,
              maxStdoutTotalBytes,
              maxStderrTotalBytes,
              onStderr
            });

            resolve();
          }
        });
      });
    },

    async requestMove(turn, signal) {
      if (!started || stopped || hasExited) {
        if (!started) {
          throw new Error(`ProcessBot ${botId} called requestMove before start`);
        }
        const err = new Error(`Bot ${botId} process has already terminated (code ${exitCode}, signal ${exitSignal})`);
        err.code = "crash";
        throw err;
      }
      if (signal?.aborted) {
        const abortErr = new Error(`Request aborted for bot ${botId}`);
        abortErr.name = "AbortError";
        throw abortErr;
      }

      // Delegate request to the streaming channel
      const action = await channel.sendRequest(turn, { signal });
      if (action && typeof action === "object" && typeof action.receivedAtMs === "number") {
        actionReceiptTimes.set(action, action.receivedAtMs);
      }
      return action;
    },

    async stop() {
      if (stopPromise) return stopPromise;

      stopPromise = (async () => {
        stopped = true;

        if (!child || !spawnPid) {
          if (channel) await channel.close();
          return;
        }

        // 1. Gracefully close stdin input
        try {
          if (child.stdin && !child.stdin.destroyed) {
            child.stdin.end();
          }
        } catch (_) {}

        // 2. Allow grace timer for normal process exit
        if (!hasExited && exitPromise) {
          let graceTimer = null;
          const timeoutP = new Promise((resolve) => {
            graceTimer = setTimeout(resolve, graceMs);
          });

          try {
            await Promise.race([exitPromise, timeoutP]);
          } finally {
            if (graceTimer !== null) clearTimeout(graceTimer);
          }
        }

        // 3. Forceful termination: kill root process and all descendant processes
        let markedPids = [];
        try {
          markedPids = killProcessTree(spawnPid, { marker: treeMarker });
        } catch (_) {}
        await waitForProcessesExit(markedPids);

        // 4. Await process exit
        if (!hasExited && exitPromise) {
          let exitTimer = null;
          const exitTimeoutP = new Promise((resolve) => {
            exitTimer = setTimeout(resolve, 500);
          });
          try {
            await Promise.race([exitPromise, exitTimeoutP]);
          } finally {
            if (exitTimer !== null) clearTimeout(exitTimer);
          }
        }

        // 5. Close channel and detach stream listeners
        if (channel) {
          await channel.close();
        }
      })();

      return stopPromise;
    }
  };
}
