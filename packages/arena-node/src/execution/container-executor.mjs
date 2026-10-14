/**
 * ContainerExecutor for Arena AI protocol v1 — Task 19 (Milestone M6a)
 * Implements BotPort and build isolation backed by dedicated OCI Linux container runtime (Docker/runc).
 * Enforces strict kernel/runtime restrictions:
 * - Network disabled (--network none)
 * - Non-root execution (-u 10001:10001)
 * - Dropped capabilities (--cap-drop ALL)
 * - No new privileges (--security-opt no-new-privileges:true)
 * - Read-only root filesystem (--read-only)
 * - Bounded tmpfs private scratch (--tmpfs /tmp/scratch:rw,nosuid,size=64m)
 * - Memory limit (256 MiB run, 512 MiB build, zero swap)
 * - Bounded PID limit (32 run, 64 build)
 * - CPU limits (1.0 run, 2.0 build)
 * - Output stream bounds (64 KiB line, 1 MiB total)
 * - Strictly no socket/DB/secret env mounts
 * - Server-generated validated attempt container names
 * - Content-addressed build artifacts verified by digest
 * - Fail-closed: NEVER falls back to host execution on container failure.
 */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createNdjsonChannel } from "./ndjson-channel.mjs";
import { killProcessTree, isProcessAlive } from "./process-tree.mjs";
import { computeSha256 } from "../artifacts/artifact-store.mjs";

export const CONTAINER_EXECUTOR_REVISION = "oci-container-linux-v1";
export const PINNED_RUNNER_IMAGE = "ottv2-arena-runner:local";
export const PINNED_RUNNER_IMAGE_ID = "sha256:1aa51999f9abee74e6a8a368eb496c88a913a7e1dd53ec53df15f5df12298a54";
export const PINNED_BASE_IMAGE_DIGEST = "sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c";

export const DEFAULT_CONTAINER_RUN_LIMITS = Object.freeze({
  network: "none",
  user: "10001:10001",
  capDrop: ["ALL"],
  securityOpt: ["no-new-privileges:true"],
  readOnlyRoot: true,
  tmpfsScratch: "/tmp/scratch:rw,nosuid,uid=10001,gid=10001,size=64m",
  memoryBytes: 268435456, // 256 MiB
  memoryFlag: "256m",
  memorySwapFlag: "256m",
  pidsLimit: 32,
  cpus: "1.0",
  stdoutMaxLineBytes: 65536, // 64 KiB
  stdoutMaxTotalBytes: 1048576, // 1 MiB
  stderrMaxTotalBytes: 262144, // 256 KiB
  startupTimeoutMs: 5000,
  graceStopMs: 250
});

export const DEFAULT_CONTAINER_BUILD_LIMITS = Object.freeze({
  network: "none",
  user: "10001:10001",
  capDrop: ["ALL"],
  securityOpt: ["no-new-privileges:true"],
  readOnlyRoot: true,
  tmpfsScratch: "/tmp/scratch:rw,nosuid,uid=10001,gid=10001,size=128m",
  memoryBytes: 536870912, // 512 MiB
  memoryFlag: "512m",
  memorySwapFlag: "512m",
  pidsLimit: 64,
  cpus: "2.0",
  buildTimeoutMs: 30000,
  maxLogBytes: 1048576 // 1 MiB
});

/**
 * Validates container name syntax against safe docker naming rules:
 * Must be <= 64 characters, match ^arena-(bot|build)-[a-zA-Z0-9_.-]+-[0-9]+-[a-f0-9]{8}$
 */
export function validateContainerName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 64) {
    return false;
  }
  const regex = /^arena-(bot|build)-[a-zA-Z0-9_.-]{1,40}-[0-9]+-[a-f0-9]{4,16}$/;
  return regex.test(name);
}

/**
 * Server-generated, validated attempt container name.
 */
export function generateContainerName(role, contextId, attempt = 0) {
  if (role !== "bot" && role !== "build") {
    throw new Error(`Invalid container role '${role}': must be 'bot' or 'build'`);
  }
  const safeContext = String(contextId || "default")
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 36);
  const randHex = crypto.randomBytes(4).toString("hex");
  const name = `arena-${role}-${safeContext}-${attempt}-${randHex}`;
  if (!validateContainerName(name)) {
    throw new Error(`Generated invalid container name: '${name}'`);
  }
  return name;
}

/**
 * Returns supported and unsupported profiles under container isolation.
 * Python and Node are scoped first.
 * Java and C++ are reported as unavailable until separate untrusted toolchains are verified.
 */
export function getIsolationProfileCapabilities() {
  return {
    python: {
      language: "python",
      version: "3.12.15",
      available: true,
      compiler: "python3 -m py_compile",
      runtime: "python3 -u"
    },
    node: {
      language: "javascript",
      version: "22.23.2",
      available: true,
      compiler: "node --check",
      runtime: "node"
    },
    cpp: {
      language: "cpp",
      available: false,
      reason: "untrusted_compiler_unprovisioned"
    },
    java: {
      language: "java",
      available: false,
      reason: "untrusted_compiler_unprovisioned"
    }
  };
}

/**
 * Probes container runtime availability and verifies pinned runner image.
 * Differentiates unavailable / available / verified states.
 * Local Desktop acceptance is NOT dedicated deployment host evidence.
 */
export function probeContainerRuntime(options = {}) {
  const customRunner = options.commandRunner;

  try {
    let versionRes;
    if (customRunner?.spawnSync) {
      versionRes = customRunner.spawnSync("docker", ["version", "--format", "{{json .}}"]);
    } else {
      versionRes = spawnSync("docker", ["version", "--format", "{{json .}}"], {
        shell: false,
        windowsHide: true,
        timeout: 4000,
        encoding: "utf8"
      });
    }

    if (!versionRes || versionRes.status !== 0 || !versionRes.stdout) {
      return {
        available: false,
        verified: false,
        dockerVersion: null,
        serverOs: null,
        serverArch: null,
        imageId: null,
        imageDigest: null,
        supportedProfiles: [],
        unsupportedProfiles: ["python", "node", "cpp", "java"],
        reason: "docker_daemon_unavailable"
      };
    }

    let parsedVersion;
    try {
      parsedVersion = JSON.parse(versionRes.stdout.trim());
    } catch (_) {
      // FAIL CLOSED: do NOT fake Linux/28.0+ on malformed JSON
      return {
        available: false,
        verified: false,
        dockerVersion: null,
        serverOs: null,
        serverArch: null,
        imageId: null,
        imageDigest: null,
        supportedProfiles: [],
        unsupportedProfiles: ["python", "node", "cpp", "java"],
        reason: "malformed_docker_version_output"
      };
    }

    const serverOs = parsedVersion?.Server?.Os;
    const serverArch = parsedVersion?.Server?.Arch;
    const dockerVersion = parsedVersion?.Server?.Version || parsedVersion?.Client?.Version;

    if (!serverOs || !dockerVersion) {
      return {
        available: false,
        verified: false,
        dockerVersion: dockerVersion || null,
        serverOs: serverOs || null,
        serverArch: serverArch || null,
        imageId: null,
        imageDigest: null,
        supportedProfiles: [],
        unsupportedProfiles: ["python", "node", "cpp", "java"],
        reason: "missing_docker_server_version"
      };
    }

    if (serverOs.toLowerCase() !== "linux") {
      return {
        available: false,
        verified: false,
        dockerVersion,
        serverOs,
        serverArch: serverArch || null,
        imageId: null,
        imageDigest: null,
        supportedProfiles: [],
        unsupportedProfiles: ["python", "node", "cpp", "java"],
        reason: `non_linux_server_os:${serverOs}`
      };
    }

    // Verify pinned runner image & reject image digest drift BEFORE execution
    const image = options.image || PINNED_RUNNER_IMAGE;
    const expectedImageId = options.expectedImageId !== undefined
      ? options.expectedImageId
      : (options.image && options.image.startsWith("sha256:") ? options.image : PINNED_RUNNER_IMAGE_ID);

    let inspectRes;
    if (customRunner?.spawnSync) {
      inspectRes = customRunner.spawnSync("docker", ["inspect", "--format", "{{.Id}}", image]);
    } else {
      inspectRes = spawnSync("docker", ["inspect", "--format", "{{.Id}}", image], {
        shell: false,
        windowsHide: true,
        timeout: 4000,
        encoding: "utf8"
      });
    }

    if (!inspectRes || inspectRes.status !== 0 || !inspectRes.stdout || !inspectRes.stdout.trim()) {
      return {
        available: false,
        verified: false,
        dockerVersion,
        serverOs,
        serverArch,
        imageId: null,
        imageDigest: null,
        supportedProfiles: [],
        unsupportedProfiles: ["python", "node", "cpp", "java"],
        reason: `pinned_image_missing:${image}`
      };
    }

    const imageId = inspectRes.stdout.trim();

    if (expectedImageId && imageId !== expectedImageId) {
      return {
        available: false,
        verified: false,
        dockerVersion,
        serverOs,
        serverArch,
        imageId,
        imageDigest: imageId,
        supportedProfiles: [],
        unsupportedProfiles: ["python", "node", "cpp", "java"],
        reason: `image_digest_drift: expected ${expectedImageId}, found ${imageId}`
      };
    }

    // Bare boolean options.verifiedTargetHost is strictly rejected:
    // verified must be evidence-bound to dedicated host acceptance token/proof.
    // Local desktop is never target-host verified.
    const isDedicatedHostVerified = Boolean(
      options.hostVerificationProof &&
      typeof options.hostVerificationProof === "object" &&
      options.hostVerificationProof.verified === true &&
      options.hostVerificationProof.environment === "dedicated-linux"
    );

    const profiles = getIsolationProfileCapabilities();

    return {
      available: true,
      verified: isDedicatedHostVerified,
      dockerVersion,
      serverOs,
      serverArch,
      imageId,
      imageDigest: imageId,
      image,
      supportedProfiles: ["python", "node"],
      unsupportedProfiles: ["cpp", "java"]
    };
  } catch (err) {
    return {
      available: false,
      verified: false,
      dockerVersion: null,
      serverOs: null,
      serverArch: null,
      imageId: null,
      imageDigest: null,
      supportedProfiles: [],
      unsupportedProfiles: ["python", "node", "cpp", "java"],
      reason: `probe_error:${err.message}`
    };
  }
}

/**
 * Builds the exact command line argument list for docker run with strict isolation.
 */
export function buildDockerRunArgs(params) {
  const {
    containerName,
    image,
    sourceHostPath,
    containerMountPath = "/bot/entrypoint",
    runtimeCommand,
    runtimeArgs = [],
    limits = DEFAULT_CONTAINER_RUN_LIMITS
  } = params;

  if (!validateContainerName(containerName)) {
    throw new Error(`Invalid container name for docker run: '${containerName}'`);
  }

  const args = [
    "run",
    "-i", // Interactive stdio
    "--rm", // Remove container when done
    "--name", containerName,
    "--network", limits.network || "none",
    "--cap-drop", (limits.capDrop && limits.capDrop[0]) || "ALL",
    "--security-opt", (limits.securityOpt && limits.securityOpt[0]) || "no-new-privileges:true",
    "--read-only",
    "--tmpfs", limits.tmpfsScratch || "/tmp/scratch:rw,nosuid,size=64m",
    "--memory", limits.memoryFlag || "256m",
    "--memory-swap", limits.memorySwapFlag || "256m",
    "--pids-limit", String(limits.pidsLimit || 32),
    "--cpus", String(limits.cpus || "1.0"),
    "-u", limits.user || "10001:10001",
    "-w", "/tmp/scratch"
  ];

  // Read-only mount of ONLY the source file / directory
  if (sourceHostPath) {
    const normHostPath = path.resolve(sourceHostPath).replace(/\\/g, "/");
    args.push("-v", `${normHostPath}:${containerMountPath}:ro`);
  }

  // Target image
  args.push(image);

  // Runtime command and entrypoint arguments
  if (runtimeCommand) {
    args.push(runtimeCommand);
  }
  if (Array.isArray(runtimeArgs)) {
    args.push(...runtimeArgs);
  }

  return args;
}

/**
 * Creates a BotPort adapter backed by an isolated OCI container process.
 * Fails closed without host fallback on any runtime error.
 */
export function createContainerBot(options) {
  if (!options || typeof options !== "object") {
    throw new Error("ContainerBot options must be an object");
  }

  const {
    botId,
    profileId,
    artifactStore,
    artifactDigest,
    expectedManifest,
    image = PINNED_RUNNER_IMAGE,
    clock = { nowMs: () => performance.now() },
    limits = DEFAULT_CONTAINER_RUN_LIMITS,
    commandRunner = null,
    attempt = 0,
    onStderr
  } = options;

  if (typeof botId !== "string" || botId.length === 0) {
    throw new Error("ContainerBot requires a non-empty string botId");
  }
  if (!profileId || (profileId !== "python" && profileId !== "node")) {
    const err = new Error(
      `ContainerBot does not support profile '${profileId}'. Scoped profiles: 'python', 'node'. C++/Java untrusted compiler unprovisioned.`
    );
    err.kind = "infrastructure_error";
    err.code = "unsupported_isolated_profile";
    err.retryable = false;
    throw err;
  }
  if (!artifactStore || !artifactDigest) {
    const err = new Error(
      "ContainerBot strictly requires 'artifactStore' and 'artifactDigest'. Workspace mutable source paths are prohibited."
    );
    err.kind = "infrastructure_error";
    err.code = "artifact_required";
    err.retryable = false;
    throw err;
  }

  const actionReceiptTimes = new WeakMap();
  let containerName = null;
  let attemptSnapshotDir = null;
  let child = null;
  let channel = null;
  let started = false;
  let stopped = false;
  let hasExited = false;
  let exitCode = null;
  let exitSignal = null;
  let exitPromise = null;
  let stopPromise = null;

  return {
    get botId() {
      return botId;
    },

    get containerName() {
      return containerName;
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
          message: `Container exited prematurely (code ${exitCode}, signal ${exitSignal})`
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
          message: `Container exited prematurely (code ${exitCode}, signal ${exitSignal})`
        };
      }
      return null;
    },

    async start(context) {
      if (stopped) return;
      if (started) return;

      // 0. Fail-closed: verify container runtime and image availability
      const probe = probeContainerRuntime({ image, commandRunner });
      if (!probe.available) {
        const err = new Error(`Container runtime unavailable: ${probe.reason || "daemon or image missing"}`);
        err.kind = "infrastructure_error";
        err.code = "runtime_unavailable";
        err.retryable = false;
        throw err;
      }

      // 1. Resolve immutable executable snapshot
      let resolvedSourcePath = null;

      if (artifactStore && artifactDigest) {
        // Production path: strictly resolve from store and verify digest integrity
        let resolved;
        try {
          resolved = await artifactStore.resolveArtifact(artifactDigest);
        } catch (resolveErr) {
          if (resolveErr?.code === "tamper_detected" || resolveErr?.code === "tampered_artifact") {
            const err = new Error(`Artifact integrity verification failed (tamper detected): ${resolveErr.message}`);
            err.kind = "infrastructure_error";
            err.code = "tampered_artifact";
            err.retryable = false;
            throw err;
          }
          throw resolveErr;
        }

        if (!resolved) {
          const err = new Error(`Artifact digest '${artifactDigest}' not found in artifactStore`);
          err.kind = "infrastructure_error";
          err.code = "artifact_missing";
          err.retryable = false;
          throw err;
        }

        let artifactBuffer;
        if (Buffer.isBuffer(resolved)) {
          artifactBuffer = resolved;
        } else if (typeof resolved === "string") {
          artifactBuffer = Buffer.from(resolved, "utf8");
        } else if (resolved.path && fs.existsSync(resolved.path)) {
          artifactBuffer = fs.readFileSync(resolved.path);
        } else if (resolved.buffer && Buffer.isBuffer(resolved.buffer)) {
          artifactBuffer = resolved.buffer;
        } else {
          const err = new Error(`Unresolvable artifact format for digest '${artifactDigest}'`);
          err.kind = "infrastructure_error";
          err.code = "artifact_format_error";
          err.retryable = false;
          throw err;
        }

        const actualDigest = computeSha256(artifactBuffer);
        if (actualDigest !== artifactDigest) {
          const err = new Error(
            `Artifact integrity verification failed: expected '${artifactDigest}', found '${actualDigest}'. Artifact may have been tampered with.`
          );
          err.kind = "infrastructure_error";
          err.code = "tampered_artifact";
          err.retryable = false;
          throw err;
        }

        if (expectedManifest) {
          if (expectedManifest.profileId && expectedManifest.profileId !== profileId) {
            const err = new Error(
              `Manifest profile mismatch: expected '${expectedManifest.profileId}', got '${profileId}'`
            );
            err.kind = "infrastructure_error";
            err.code = "manifest_profile_mismatch";
            err.retryable = false;
            throw err;
          }
          if (expectedManifest.artifactDigest && expectedManifest.artifactDigest !== artifactDigest) {
            const err = new Error(
              `Manifest digest mismatch: manifest specifies '${expectedManifest.artifactDigest}', got '${artifactDigest}'`
            );
            err.kind = "infrastructure_error";
            err.code = "manifest_digest_mismatch";
            err.retryable = false;
            throw err;
          }
          if (expectedManifest.executor && expectedManifest.executor !== CONTAINER_EXECUTOR_REVISION) {
            const err = new Error(
              `Manifest executor mismatch: expected '${CONTAINER_EXECUTOR_REVISION}', got '${expectedManifest.executor}'`
            );
            err.kind = "infrastructure_error";
            err.code = "manifest_executor_mismatch";
            err.retryable = false;
            throw err;
          }
          if (
            expectedManifest.image &&
            expectedManifest.image !== PINNED_RUNNER_IMAGE &&
            expectedManifest.image !== probe.imageId &&
            expectedManifest.image !== image
          ) {
            const err = new Error(
              `Manifest image mismatch: expected '${PINNED_RUNNER_IMAGE}', got '${expectedManifest.image}'`
            );
            err.kind = "infrastructure_error";
            err.code = "manifest_image_mismatch";
            err.retryable = false;
            throw err;
          }
          if (expectedManifest.sourceDigest && expectedManifest.sourceDigest !== artifactDigest) {
            const err = new Error(
              `Manifest sourceDigest mismatch: manifest specifies '${expectedManifest.sourceDigest}', got '${artifactDigest}'`
            );
            err.kind = "infrastructure_error";
            err.code = "manifest_source_digest_mismatch";
            err.retryable = false;
            throw err;
          }
        }

        // Create private per-attempt immutable snapshot directory
        containerName = generateContainerName("bot", botId, attempt);
        attemptSnapshotDir = path.join(os.tmpdir(), "arena-isolated-snapshots", containerName);
        fs.mkdirSync(attemptSnapshotDir, { recursive: true });
        const ext = profileId === "python" ? ".py" : ".mjs";
        const cleanDigest = (artifactDigest.startsWith("sha256:") ? artifactDigest.slice(7) : artifactDigest).replace(/[^a-zA-Z0-9]/g, "");
        const snapshotFile = path.join(attemptSnapshotDir, `source-${cleanDigest.slice(0, 16)}${ext}`);
        fs.writeFileSync(snapshotFile, artifactBuffer);
        try { fs.chmodSync(snapshotFile, 0o444); } catch (_) {}
        resolvedSourcePath = snapshotFile;
      } else {
        const err = new Error(
          "Production ContainerBot strictly requires 'artifactStore' and 'artifactDigest'. Workspace mutable source paths are prohibited."
        );
        err.kind = "infrastructure_error";
        err.code = "artifact_required";
        err.retryable = false;
        throw err;
      }

      // 3. Determine runtime command inside container
      const ext = path.extname(resolvedSourcePath);
      const containerMountPath = `/bot/bot${ext || (profileId === "python" ? ".py" : ".mjs")}`;
      let runtimeCommand;
      let runtimeArgs;

      if (profileId === "python") {
        runtimeCommand = "python3";
        runtimeArgs = ["-u", containerMountPath];
      } else {
        runtimeCommand = "node";
        runtimeArgs = [containerMountPath];
      }

      // Execute container strictly by immutable ID/digest to prevent tag drift
      const runImage = probe.imageId || image;

      const dockerArgs = buildDockerRunArgs({
        containerName,
        image: runImage,
        sourceHostPath: resolvedSourcePath,
        containerMountPath,
        runtimeCommand,
        runtimeArgs,
        limits
      });

      // 4. Spawn docker container process (strictly shell=false)
      await new Promise((resolve, reject) => {
        let settled = false;
        let startupTimer = null;

        function cleanupTimer() {
          if (startupTimer !== null) {
            clearTimeout(startupTimer);
            startupTimer = null;
          }
        }

        startupTimer = setTimeout(() => {
          if (!settled) {
            settled = true;
            try {
              // Kill container via docker kill
              spawnSync("docker", ["kill", containerName], { shell: false, windowsHide: true });
              if (child?.pid) killProcessTree(child.pid);
            } catch (_) {}

            if (stopped) {
              resolve();
              return;
            }
            const err = new Error(`ContainerBot '${botId}' startup timed out after ${limits.startupTimeoutMs || 5000}ms`);
            err.kind = "infrastructure_error";
            err.code = "startup_timeout";
            err.retryable = false;
            reject(err);
          }
        }, limits.startupTimeoutMs || 5000);

        try {
          const spawnFn = commandRunner?.spawn || spawn;
          child = spawnFn("docker", dockerArgs, {
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true
          });
        } catch (spawnErr) {
          settled = true;
          cleanupTimer();
          const err = new Error(`Failed to spawn container for bot '${botId}': ${spawnErr.message}`);
          err.kind = "infrastructure_error";
          err.code = "container_spawn_failed";
          err.retryable = false;
          reject(err);
          return;
        }

        exitPromise = new Promise((resExit) => {
          child.once("close", (code, sig) => {
            hasExited = true;
            exitCode = code;
            exitSignal = sig;
            resExit({ code, sig });
          });
        });

        child.on("error", (err) => {
          if (!settled) {
            settled = true;
            cleanupTimer();
            const infraErr = new Error(`Container process error: ${err.message}`);
            infraErr.kind = "infrastructure_error";
            infraErr.code = "container_error";
            infraErr.retryable = false;
            reject(infraErr);
          } else {
            if (channel && typeof channel.triggerFault === "function") {
              channel.triggerFault({
                code: "crash",
                message: `Container process error: ${err.message}`
              });
            }
          }
        });

        child.once("spawn", () => {
          cleanupTimer();
          if (!settled) {
            settled = true;
            if (stopped) {
              started = false;
              try {
                spawnSync("docker", ["kill", containerName], { shell: false, windowsHide: true });
                if (child.pid) killProcessTree(child.pid);
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
              maxStdoutLineBytes: limits.stdoutMaxLineBytes,
              maxStdoutTotalBytes: limits.stdoutMaxTotalBytes,
              maxStderrTotalBytes: limits.stderrMaxTotalBytes,
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
          throw new Error(`ContainerBot ${botId} called requestMove before start`);
        }
        const err = new Error(`ContainerBot ${botId} has already terminated (code ${exitCode}, signal ${exitSignal})`);
        err.code = "crash";
        throw err;
      }

      if (signal?.aborted) {
        const abortErr = new Error(`Request aborted for container bot ${botId}`);
        abortErr.name = "AbortError";
        throw abortErr;
      }

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

        if (!child) {
          if (channel) await channel.close();
          return;
        }

        // 1. Gracefully close stdin
        try {
          if (child.stdin && !child.stdin.destroyed) {
            child.stdin.end();
          }
        } catch (_) {}

        // 2. Allow short grace timer for container to shut down
        if (!hasExited && exitPromise) {
          let graceTimer = null;
          const timeoutP = new Promise((resolve) => {
            graceTimer = setTimeout(resolve, limits.graceStopMs || 250);
          });
          try {
            await Promise.race([exitPromise, timeoutP]);
          } finally {
            if (graceTimer !== null) clearTimeout(graceTimer);
          }
        }

        // 3. Force kill container by name (terminates container cgroup and all child processes)
        if (containerName) {
          try {
            spawnSync("docker", ["kill", containerName], {
              shell: false,
              windowsHide: true,
              timeout: 2000
            });
          } catch (_) {}
          try {
            spawnSync("docker", ["rm", "-f", containerName], {
              shell: false,
              windowsHide: true,
              timeout: 2000
            });
          } catch (_) {}
        }

        // 4. Force kill host docker process tree
        if (child.pid) {
          try {
            killProcessTree(child.pid);
          } catch (_) {}
        }

        // 5. Close ndjson streaming channel
        if (channel) {
          await channel.close();
        }

        // 6. Clean up private per-attempt snapshot directory
        if (attemptSnapshotDir) {
          try {
            fs.rmSync(attemptSnapshotDir, { recursive: true, force: true });
          } catch (_) {}
          attemptSnapshotDir = null;
        }
      })();

      return stopPromise;
    }
  };
}

/**
 * Creates a BuildService backed by isolated container validation.
 * Fails closed without host fallback on any runtime error.
 */
export function createContainerBuildService(options) {
  if (!options || !options.artifactStore) {
    throw new Error("createContainerBuildService requires an artifactStore");
  }

  const {
    artifactStore,
    image = PINNED_RUNNER_IMAGE,
    limits = DEFAULT_CONTAINER_BUILD_LIMITS,
    commandRunner = null
  } = options;

  const cacheIndex = new Map();

  return {
    get artifactStore() {
      return artifactStore;
    },

    async build(request) {
      if (!request || typeof request !== "object") {
        throw new Error("Build request must be an object");
      }

      const { sourceContent, sourcePath, profileId, compilerOptions = [], signal } = request;

      if (!profileId || typeof profileId !== "string") {
        throw new Error("Build request requires a profileId string");
      }

      const startMs = Date.now();

      // Check signal upfront
      if (signal?.aborted) {
        return {
          status: "FAILED",
          artifactDigest: null,
          manifest: null,
          logs: "Build aborted before starting.\n",
          error: "interrupted",
          durationMs: 0
        };
      }

      // 1. Resolve source buffer
      let contentBuffer;
      if (sourceContent !== undefined) {
        contentBuffer = Buffer.isBuffer(sourceContent)
          ? sourceContent
          : Buffer.from(String(sourceContent), "utf8");
      } else if (sourcePath && fs.existsSync(sourcePath)) {
        contentBuffer = fs.readFileSync(sourcePath);
      } else {
        return {
          status: "FAILED",
          artifactDigest: null,
          manifest: null,
          logs: `Missing source: file does not exist: ${sourcePath}\n`,
          error: "missing_source",
          durationMs: Date.now() - startMs
        };
      }

      const sourceDigest = computeSha256(contentBuffer);
      await artifactStore.storeArtifact("source", contentBuffer);

      // 2. Profile availability check in container sandbox
      if (profileId !== "python" && profileId !== "node") {
        return {
          status: "FAILED",
          artifactDigest: null,
          manifest: null,
          logs: `Untrusted compiler for profile '${profileId}' is unavailable in container isolation.\n` +
                `Supported isolated profiles: 'python', 'node'. C++ and Java untrusted compilers unprovisioned.\n`,
          error: "unsupported_isolated_profile",
          durationMs: Date.now() - startMs
        };
      }

      // 3. Cache lookup
      const cacheKey = computeSha256(
        JSON.stringify({
          sourceDigest,
          profileId,
          executor: CONTAINER_EXECUTOR_REVISION,
          image
        })
      );

      if (cacheIndex.has(cacheKey)) {
        const cachedManifest = cacheIndex.get(cacheKey);
        const existing = await artifactStore.resolveArtifact(cachedManifest.artifactDigest);
        if (existing) {
          return {
            status: "READY",
            artifactDigest: cachedManifest.artifactDigest,
            manifest: Object.freeze({ ...cachedManifest }),
            logs: "Build retrieved from content-addressed cache (cached).\n",
            durationMs: Date.now() - startMs
          };
        }
      }

      // 3b. Verify container runtime and resolve immutable image ID
      const probe = probeContainerRuntime({ image, commandRunner });
      if (!probe.available) {
        return {
          status: "FAILED",
          artifactDigest: null,
          manifest: null,
          logs: `Container runtime unavailable for build: ${probe.reason || "daemon or image missing"}\n`,
          error: "runtime_unavailable",
          durationMs: Date.now() - startMs
        };
      }

      // 4. Create ephemeral isolated directory on host for mounting
      const buildDir = path.join(
        os.tmpdir(),
        `arena-build-container-${profileId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      );
      fs.mkdirSync(buildDir, { recursive: true });

      const ext = profileId === "python" ? ".py" : ".mjs";
      const sourceFileName = `source${ext}`;
      const hostSourceFile = path.join(buildDir, sourceFileName);
      fs.writeFileSync(hostSourceFile, contentBuffer);

      const containerName = generateContainerName("build", profileId, 0);

      try {
        let compileCmd;
        let compileArgs;
        const containerMountPath = `/bot/${sourceFileName}`;

        if (profileId === "python") {
          compileCmd = "python3";
          compileArgs = [
            "-c",
            "import sys, py_compile; py_compile.compile(sys.argv[1], cfile='/tmp/scratch/source.pyc', doraise=True)",
            containerMountPath
          ];
        } else {
          compileCmd = "node";
          compileArgs = ["--check", containerMountPath];
        }

        // Execute build container strictly by immutable ID/digest to prevent tag drift
        const runImage = probe.imageId || image;

        const dockerArgs = buildDockerRunArgs({
          containerName,
          image: runImage,
          sourceHostPath: hostSourceFile,
          containerMountPath,
          runtimeCommand: compileCmd,
          runtimeArgs: compileArgs,
          limits: {
            ...limits,
            tmpfsScratch: limits.tmpfsScratch || "/tmp/scratch:rw,nosuid,uid=10001,gid=10001,size=128m",
            memoryFlag: limits.memoryFlag || "512m",
            memorySwapFlag: limits.memorySwapFlag || "512m",
            pidsLimit: limits.pidsLimit || 64,
            cpus: limits.cpus || "2.0"
          }
        });

        let compileRes;
        if (commandRunner?.spawnSync) {
          compileRes = commandRunner.spawnSync("docker", dockerArgs);
        } else {
          compileRes = spawnSync("docker", dockerArgs, {
            shell: false,
            windowsHide: true,
            timeout: limits.buildTimeoutMs || 30000,
            encoding: "utf8"
          });
        }

        const elapsedMs = Date.now() - startMs;
        let rawLogs = `${compileRes?.stdout || ""}\n${compileRes?.stderr || ""}`.trim();
        const MAX_LOGS = limits.maxLogBytes || 1048576;
        if (rawLogs.length > MAX_LOGS) {
          rawLogs = rawLogs.slice(0, MAX_LOGS - 32) + "\n...[LOG TRUNCATED AT 1 MiB CAP]";
        }

        if (compileRes?.error) {
          const isTimeout = compileRes.error.code === "ETIMEDOUT" || Boolean(compileRes.error.timedOut);
          return {
            status: "FAILED",
            artifactDigest: null,
            manifest: null,
            logs: rawLogs || compileRes.error.message,
            error: isTimeout ? "build_timeout" : "compile_failure",
            durationMs: elapsedMs
          };
        }

        if (compileRes?.status !== 0) {
          return {
            status: "FAILED",
            artifactDigest: null,
            manifest: null,
            logs: rawLogs,
            error: "compile_failure",
            durationMs: elapsedMs
          };
        }

        // 5. Verification succeeded: store artifact
        const artifactDigest = sourceDigest; // Validated source script is the executable artifact
        const manifest = {
          schemaVersion: 1,
          artifactDigest,
          sourceDigest,
          profileId,
          executor: CONTAINER_EXECUTOR_REVISION,
          image,
          builtAt: new Date().toISOString(),
          status: "READY",
          entrypoint: sourceFileName,
          bytes: contentBuffer.length
        };

        await artifactStore.storeArtifact("build", contentBuffer, { manifest });
        cacheIndex.set(cacheKey, manifest);

        return {
          status: "READY",
          artifactDigest,
          manifest: Object.freeze({ ...manifest }),
          logs: rawLogs || "Build and syntax verification succeeded in isolated container.\n",
          durationMs: elapsedMs
        };
      } finally {
        try {
          spawnSync("docker", ["rm", "-f", containerName], { shell: false, windowsHide: true });
        } catch (_) {}
        try {
          fs.rmSync(buildDir, { recursive: true, force: true });
        } catch (_) {}
      }
    },

    async getManifest(artifactDigest) {
      return artifactStore.getManifest(artifactDigest);
    }
  };
}
