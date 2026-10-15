/**
 * apps/arena-api/src/main.mjs
 *
 * Task 14 (Milestone M4): Arena HTTP API Entry Point.
 *
 * Bootstraps the independent Arena HTTP API service:
 * - Loads validated configuration (default 127.0.0.1:3001, CORS allowlist, storage, limits).
 * - Opens SQLite database.
 * - Initializes repositories, artifact storage, execution registry, build service, and finalizer.
 * - Instantiates Arena HTTP API server.
 * - Worker Ownership:
 *   - If externalWorker is false: runs embedded JobWorker in this process.
 *   - If externalWorker is true: skips embedded worker (external worker process owns job queue).
 * - Graceful shutdown on SIGINT/SIGTERM.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.mjs";
import { createArenaServer } from "./http-server.mjs";
import { openDatabase, closeDatabase } from "../../../packages/arena-node/src/persistence/sqlite-database.mjs";
import { createArtifactStore } from "../../../packages/arena-node/src/artifacts/artifact-store.mjs";
import { createProfileRegistry } from "../../../packages/arena-node/src/execution/profile-registry.mjs";
import { createBuildService } from "../../../packages/arena-node/src/execution/build-service.mjs";
import { createBotVersionService } from "../../../packages/arena-node/src/persistence/bot-version-service.mjs";
import { createBotRepository } from "../../../packages/arena-node/src/persistence/bot-repository.mjs";
import { createMatchRepository } from "../../../packages/arena-node/src/persistence/match-repository.mjs";
import { createTournamentRepository } from "../../../packages/arena-node/src/persistence/tournament-repository.mjs";
import { createJobQueue } from "../../../packages/arena-node/src/persistence/job-queue.mjs";
import { createMatchFinalizer } from "../../../packages/arena-node/src/persistence/finalizer.mjs";
import { createJobWorker, createProfileBotFactory } from "../../../packages/arena-node/src/worker/job-worker.mjs";
import { createLiveFrameStore } from "../../../packages/arena-node/src/persistence/live-frame-store.mjs";
import { createDraftService } from "../../../packages/arena-node/src/execution/draft-service.mjs";
import { probeContainerRuntime, createContainerBuildService } from "../../../packages/arena-node/src/execution/container-executor.mjs";

/**
 * Starts the Arena API service and optional embedded worker.
 *
 * @param {object} [overrides={}]
 * @returns {Promise<{ config: object, server: import("node:http").Server, db: import("better-sqlite3").Database, worker: object|null, stop: () => Promise<void> }>}
 */
export async function startArenaService(overrides = {}) {
  let db = null;
  let server = null;
  let worker = null;

  try {
    const config = loadConfig(overrides);

    const opened = openDatabase(config.dbPath, { targetVersion: "latest" });
    db = opened.db || opened;
    const artifactStore = createArtifactStore({ storageDir: config.storageDir });
    const profileRegistry = createProfileRegistry();
    const executionCapabilities = config.localDemoContainers
      ? probeContainerRuntime()
      : null;
    const getExecutionCapabilities = config.localDemoContainers
      ? () => probeContainerRuntime()
      : null;
    const containerExecutor = config.localDemoContainers
      ? { image: executionCapabilities?.image, probe: getExecutionCapabilities }
      : null;
    const buildService = config.localDemoContainers
      ? createContainerBuildService({ artifactStore, image: executionCapabilities?.image, probe: getExecutionCapabilities })
      : createBuildService({ artifactStore, profileRegistry });
    const botVersionService = createBotVersionService({
      db,
      artifactStore,
      buildService,
      profileRegistry
    });

    const botRepo = createBotRepository(db);
    const matchRepo = createMatchRepository(db);
    const tournamentRepo = createTournamentRepository(db);
    const jobQueue = createJobQueue(db);
    const finalizer = createMatchFinalizer(db);

    const hasLiveFramesTable = Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'match_live_frames'").get()
    );
    const liveFrameStore = hasLiveFramesTable ? createLiveFrameStore(db) : null;
    const draftService = createDraftService({
      profileRegistry,
      trustedLocalMode: config.trustedMode,
      containerExecutor: overrides.containerExecutor || containerExecutor
    });

    server = createArenaServer({
      db,
      allowedOrigins: config.allowedOrigins,
      trustedMode: config.trustedMode,
      maxBodyBytes: config.maxBodyBytes,
      botRepo,
      matchRepo,
      tournamentRepo,
      jobQueue,
      botVersionService,
      profileRegistry,
      draftService,
      liveFrameStore,
      finalizer,
      localDemoContainers: config.localDemoContainers,
      executionCapabilities,
      getExecutionCapabilities
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.bind, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : config.port;
    console.log(`[arena:api] HTTP server listening on http://${config.bind}:${port} (trustedMode=${config.trustedMode})`);

    if (config.externalWorker) {
      console.log(`[arena:api] External worker enabled (config.externalWorker=true) — skipping embedded worker`);
    } else {
      console.log(`[arena:api] Starting embedded JobWorker...`);
      const botFactory = createProfileBotFactory({ artifactStore, profileRegistry, containerExecutor });
      worker = createJobWorker({
        workerId: `embedded-worker-${process.pid}`,
        db,
        jobQueue,
        matchRepo,
        finalizer,
        botVersionService,
        botFactory,
        liveFrameStore,
        allowedKinds: ["build", "match"]
      });
      worker.start();
      console.log(`[arena:api] Embedded JobWorker running`);
    }

    let stopped = false;
    async function stop() {
      if (stopped) return;
      stopped = true;

      if (worker) {
        try {
          await worker.stop();
        } catch (_) {}
      }

      if (server) {
        if (typeof server.closeIdleConnections === "function") {
          try {
            server.closeIdleConnections();
          } catch (_) {}
        }
        if (typeof server.closeAllConnections === "function") {
          try {
            server.closeAllConnections();
          } catch (_) {}
        }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 3000);
          server.close(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }

      if (db) {
        try {
          closeDatabase(db);
        } catch (_) {}
      }
    }

    return {
      config,
      server,
      db,
      worker,
      stop
    };
  } catch (err) {
    if (worker) {
      try {
        await worker.stop();
      } catch (_) {}
    }
    if (server) {
      try {
        await new Promise((resolve) => server.close(resolve));
      } catch (_) {}
    }
    if (db) {
      try {
        closeDatabase(db);
      } catch (_) {}
    }
    throw err;
  }
}

// Direct CLI invocation
const isMain =
  process.argv[1] &&
  (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
    process.argv[1].endsWith("apps/arena-api/src/main.mjs") ||
    process.argv[1].endsWith("apps\\arena-api\\src\\main.mjs"));

if (isMain) {
  startArenaService()
    .then(({ stop }) => {
      const onShutdown = async () => {
        console.log("\n[arena:api] Shutting down gracefully...");
        await stop();
        process.exit(0);
      };
      process.on("SIGINT", onShutdown);
      process.on("SIGTERM", onShutdown);
    })
    .catch((err) => {
      console.error("[arena:api] Fatal startup error:", err);
      process.exit(1);
    });
}
