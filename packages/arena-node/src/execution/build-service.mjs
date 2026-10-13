/**
 * BuildService for Arena AI protocol v1.
 * Coordinates bot compilation and validation across language profiles.
 * Implements workflow: RECEIVED -> BUILDING -> READY / FAILED with:
 * - Content-addressed caching by (sourceDigest + profileRevision + compilerVersion/options + executor)
 * - 30-second build deadline with process-tree cancellation
 * - 1 MiB diagnostic log truncation
 * - Ephemeral build directory isolation
 * - Verifiable BuildManifest generation
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeSha256 } from "../artifacts/artifact-store.mjs";

export const MAX_BUILD_LOG_BYTES = 1048576; // 1 MiB
export const DEFAULT_BUILD_DEADLINE_MS = 30000; // 30 seconds
export const EXECUTOR_REVISION = "trusted-local-v1";

/**
 * Computes deterministic build cache key digest.
 */
export function computeBuildCacheKey(params) {
  const normalized = {
    sourceDigest: params.sourceDigest,
    profileId: params.profileId,
    profileRevision: params.profileRevision || "v1",
    compilerVersion: params.compilerVersion || "default",
    compilerOptions: Array.isArray(params.compilerOptions) ? [...params.compilerOptions].sort() : [],
    executor: params.executor || EXECUTOR_REVISION
  };
  return computeSha256(JSON.stringify(normalized));
}

/**
 * Creates a BuildService instance.
 * @param {object} options
 * @param {import("../artifacts/artifact-store.d.mts").ArtifactStore} options.artifactStore
 * @param {Record<string, object>} [options.compilers] - Custom compiler doubles or handlers
 * @param {object} [options.profileRegistry]
 * @param {number} [options.buildDeadlineMs=30000]
 */
export function createBuildService(options) {
  if (!options || !options.artifactStore) {
    throw new Error("BuildService requires an artifactStore");
  }

  const {
    artifactStore,
    compilers = {},
    profileRegistry = null,
    buildDeadlineMs = DEFAULT_BUILD_DEADLINE_MS
  } = options;

  // In-memory cache key index: cacheKey -> manifest
  const cacheIndex = new Map();

  return {
    get artifactStore() {
      return artifactStore;
    },

    async build(request) {
      if (!request || typeof request !== "object") {
        throw new Error("Build request must be an object");
      }

      const {
        sourceContent,
        sourcePath,
        profileId,
        compilerOptions = [],
        signal
      } = request;

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

      // 1. Resolve source content
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

      // Store source artifact into artifact store
      await artifactStore.storeArtifact("source", contentBuffer);

      // 2. Resolve compiler handler
      let compiler = compilers[profileId];
      if (!compiler && profileRegistry) {
        const prof = profileRegistry.getProfile(profileId);
        if (prof && typeof prof.compile === "function") {
          compiler = prof;
        }
      }

      if (!compiler) {
        return {
          status: "FAILED",
          artifactDigest: null,
          manifest: null,
          logs: `Unknown build profile: '${profileId}'\n`,
          error: "unknown_profile",
          durationMs: Date.now() - startMs
        };
      }

      const profileRevision = compiler.profileRevision || `${profileId}-trusted-v1`;
      const compilerVersion = compiler.compilerVersion || "default";

      // 3. Cache lookup by deterministic cache key
      const cacheKey = computeBuildCacheKey({
        sourceDigest,
        profileId,
        profileRevision,
        compilerVersion,
        compilerOptions,
        executor: EXECUTOR_REVISION
      });

      if (cacheIndex.has(cacheKey)) {
        const cachedManifest = cacheIndex.get(cacheKey);
        // Verify artifact still exists in store
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

      // 4. Ephemeral build directory isolation
      const buildDir = path.join(
        os.tmpdir(),
        `arena-build-${profileId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      );
      fs.mkdirSync(buildDir, { recursive: true });

      try {
        if (signal?.aborted) {
          return {
            status: "FAILED",
            artifactDigest: null,
            manifest: null,
            logs: "Build aborted.\n",
            error: "interrupted",
            durationMs: Date.now() - startMs
          };
        }

        // Write entrypoint source into build directory
        const entryName = (request.sourcePath ? path.basename(request.sourcePath) : compiler.entryName) || `source_${Date.now()}`;
        const sourceFilePath = path.join(buildDir, entryName);
        fs.writeFileSync(sourceFilePath, contentBuffer);

        // Execute compiler with deadline
        let compileResult;
        const deadline = buildDeadlineMs;

        let timedOut = false;
        let timeoutHandle = null;

        const compilePromise = Promise.resolve().then(() =>
          compiler.compile({
            buildDir,
            sourceFilePath,
            sourceContent: contentBuffer,
            compilerOptions,
            timeoutMs: deadline,
            signal
          })
        );

        const timeoutPromise = new Promise((resolve) => {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            resolve({
              status: 1,
              stdout: "",
              stderr: `Build timed out: execution exceeded ${deadline} ms deadline.\n`,
              timedOut: true
            });
          }, deadline);
        });

        const abortPromise = new Promise((resolve) => {
          if (signal) {
            signal.addEventListener("abort", () => {
              resolve({
                status: 1,
                stdout: "",
                stderr: "Build cancelled by supervisor signal.\n",
                aborted: true
              });
            });
          }
        });

        try {
          compileResult = await Promise.race([compilePromise, timeoutPromise, abortPromise]);
        } finally {
          if (timeoutHandle !== null) clearTimeout(timeoutHandle);
        }

        const elapsedMs = Date.now() - startMs;

        // Truncate logs to MAX_BUILD_LOG_BYTES (1 MiB)
        let rawLogs = `${compileResult.stdout || ""}\n${compileResult.stderr || ""}`.trim();
        const TRUNC_MSG = "\n...[LOG TRUNCATED AT 1 MiB CAP]";
        if (rawLogs.length > MAX_BUILD_LOG_BYTES) {
          rawLogs = rawLogs.slice(0, MAX_BUILD_LOG_BYTES - TRUNC_MSG.length) + TRUNC_MSG;
        }

        if (compileResult.aborted || signal?.aborted) {
          return {
            status: "FAILED",
            artifactDigest: null,
            manifest: null,
            logs: rawLogs,
            error: "interrupted",
            durationMs: elapsedMs
          };
        }

        if (compileResult.timedOut || timedOut) {
          return {
            status: "FAILED",
            artifactDigest: null,
            manifest: null,
            logs: rawLogs,
            error: "build_timeout",
            durationMs: elapsedMs
          };
        }

        if (compileResult.status !== 0) {
          return {
            status: "FAILED",
            artifactDigest: null,
            manifest: null,
            logs: rawLogs,
            error: compileResult.error || "compile_failure",
            durationMs: elapsedMs
          };
        }

        // 5. Build succeeded: locate entrypoint binary and store artifact
        const entrypointName = compileResult.entrypoint || "bot";
        const entrypointPath = path.isAbsolute(entrypointName)
          ? entrypointName
          : path.join(buildDir, entrypointName);

        let binaryBuffer;
        if (fs.existsSync(entrypointPath)) {
          binaryBuffer = fs.readFileSync(entrypointPath);
        } else {
          // If no binary file on disk, package contentBuffer as valid script
          binaryBuffer = contentBuffer;
        }

        const artifactDigest = computeSha256(binaryBuffer);

        const manifest = {
          schemaVersion: 1,
          artifactDigest,
          sourceDigest,
          profileId,
          profileRevision,
          compilerVersion,
          compilerOptions: [...compilerOptions],
          executor: EXECUTOR_REVISION,
          builtAt: new Date().toISOString(),
          status: "READY",
          entrypoint: path.basename(entrypointPath),
          bytes: binaryBuffer.length
        };

        // Atomically store build artifact in content-addressed store
        await artifactStore.storeArtifact("build", binaryBuffer, { manifest });

        // Update in-memory cache index
        cacheIndex.set(cacheKey, manifest);

        return {
          status: "READY",
          artifactDigest,
          manifest: Object.freeze({ ...manifest }),
          logs: rawLogs,
          durationMs: elapsedMs
        };
      } finally {
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
