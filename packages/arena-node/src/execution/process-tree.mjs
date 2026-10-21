/**
 * Process tree termination and process liveness utilities.
 * Implements forceful tree termination using Windows taskkill (/T /F) and POSIX process groups (SIGKILL),
 * strictly without shell interpolation.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";

/**
 * Environment variable carrying a per-bot random marker. Descendants inherit it, which lets Linux
 * find processes that left the bot's process group (setsid / detached) after their parent exited.
 * Best effort for trusted profiles only: a process that scrubs its environment is not found.
 */
export const PROCESS_TREE_MARKER_ENV = "OTT_ARENA_PROCESS_TREE";

export function createProcessTreeMarker() {
  return randomUUID();
}

/**
 * Lists PIDs whose environment carries `marker`, by scanning /proc. Returns [] where /proc is absent.
 * @param {string} marker
 * @returns {number[]}
 */
export function findMarkedPids(marker) {
  if (typeof marker !== "string" || marker.length === 0) return [];
  let entries;
  try {
    entries = fs.readdirSync("/proc");
  } catch (_) {
    return [];
  }
  const needle = `${PROCESS_TREE_MARKER_ENV}=${marker}`;
  const found = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      if (fs.readFileSync(`/proc/${entry}/environ`, "utf8").split("\0").includes(needle)) found.push(pid);
    } catch (_) {}
  }
  return found;
}

/**
 * Checks whether a process with the given PID is currently alive.
 * @param {number} pid - Integer process identifier
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * Queries descendant child process IDs for a given parent PID on Windows.
 * @param {number} parentPid
 * @returns {number[]}
 */
export function getWindowsDescendantPids(parentPid) {
  if (!Number.isInteger(parentPid) || parentPid <= 0) return [];
  const found = new Set();

  function queryDirectChildren(pId) {
    // Primary query: WMIC process where (ParentProcessId=...)
    try {
      const res = spawnSync("wmic", ["process", "where", `ParentProcessId=${pId}`, "get", "ProcessId"], {
        shell: false,
        windowsHide: true,
        encoding: "utf8"
      });
      if (res.status === 0 && res.stdout) {
        const lines = res.stdout.trim().split(/\r?\n/).slice(1);
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && /^\d+$/.test(trimmed)) {
            const childPid = parseInt(trimmed, 10);
            if (childPid > 0 && !found.has(childPid)) {
              found.add(childPid);
              queryDirectChildren(childPid);
            }
          }
        }
        return;
      }
    } catch (_) {}

    // Fallback query: PowerShell CIM instance
    try {
      const psRes = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${pId} } | ForEach-Object { $_.ProcessId }`
        ],
        {
          shell: false,
          windowsHide: true,
          encoding: "utf8"
        }
      );
      if (psRes.status === 0 && psRes.stdout) {
        const lines = psRes.stdout.trim().split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && /^\d+$/.test(trimmed)) {
            const childPid = parseInt(trimmed, 10);
            if (childPid > 0 && !found.has(childPid)) {
              found.add(childPid);
              queryDirectChildren(childPid);
            }
          }
        }
      }
    } catch (_) {}
  }

  queryDirectChildren(parentPid);
  return Array.from(found);
}

/**
 * Forcefully terminates the process tree rooted at `pid`.
 * Windows: uses taskkill /pid <PID> /T /F, and handles orphaned descendants if root has already exited.
 * POSIX: uses process group kill SIGKILL (-pid); with `marker`, also kills processes carrying it (Linux /proc),
 * including descendants that started their own session.
 *
 * SIGKILL is delivered asynchronously, so callers that must observe the tree gone should wait on the
 * returned marked PIDs (see waitForProcessesExit).
 *
 * @param {number} pid - Positive integer PID from child_process.spawn
 * @param {{ marker?: string }} [options]
 * @returns {number[]} PIDs found via `marker` and signalled (always [] on Windows)
 */
export function killProcessTree(pid, { marker } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new TypeError("PID must be a positive integer");
  }

  if (process.platform === "win32") {
    // 1. Try taskkill /pid <PID> /T /F first
    let taskkillSuccess = false;
    try {
      const res = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore"
      });
      taskkillSuccess = res.status === 0;
    } catch (_) {}

    // 2. If taskkill failed or root already exited, find and kill all descendant processes
    const descendantPids = getWindowsDescendantPids(pid);
    for (const dPid of descendantPids) {
      if (isProcessAlive(dPid)) {
        try {
          spawnSync("taskkill", ["/pid", String(dPid), "/T", "/F"], {
            shell: false,
            windowsHide: true,
            stdio: "ignore"
          });
        } catch (_) {}
      }
    }
  } else {
    // POSIX process group termination
    try {
      process.kill(-pid, "SIGKILL");
    } catch (grpErr) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (_) {}
    }
    const markedPids = findMarkedPids(marker);
    for (const markedPid of markedPids) {
      try {
        process.kill(-markedPid, "SIGKILL");
      } catch (_) {}
      try {
        process.kill(markedPid, "SIGKILL");
      } catch (_) {}
    }
    return markedPids;
  }
  return [];
}

/**
 * Resolves once none of `pids` is alive, or after `timeoutMs`.
 * @param {number[]} pids
 * @param {number} [timeoutMs=500]
 * @returns {Promise<void>}
 */
export async function waitForProcessesExit(pids, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(isProcessAlive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
