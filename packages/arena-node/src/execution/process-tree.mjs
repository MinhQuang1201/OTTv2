/**
 * Process tree termination and process liveness utilities.
 * Implements forceful tree termination using Windows taskkill (/T /F) and POSIX process groups (SIGKILL),
 * strictly without shell interpolation.
 */

import { spawnSync } from "node:child_process";

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
 * POSIX: uses process group kill SIGKILL (-pid).
 *
 * @param {number} pid - Positive integer PID from child_process.spawn
 * @returns {void}
 */
export function killProcessTree(pid) {
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
  }
}
