/**
 * tests/fixtures/arena/concurrency-worker.mjs
 *
 * Helper worker for multi-process/thread concurrency testing on SQLite.
 * Can be invoked via child_process or worker_threads.
 */

import { parentPort, workerData } from "node:worker_threads";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");

async function runWorker(config) {
  const { action, dbPath, options = {}, params = {} } = config;

  // Import the sqlite-database and repository modules from packages/arena-node
  const dbModule = await import("../../../packages/arena-node/src/persistence/sqlite-database.mjs");
  const botRepoModule = await import("../../../packages/arena-node/src/persistence/bot-repository.mjs");

  const { openDatabase, withTransaction, closeDatabase } = dbModule;
  const { createBotRepository } = botRepoModule;

  const { db } = openDatabase(dbPath, options);
  const repo = createBotRepository(db);

  try {
    if (action === "allocate-versions") {
      const { botId, userId, workerId, count } = params;
      const allocated = [];
      for (let i = 1; i <= count; i++) {
        const versionId = `ver-${workerId}-${i}-${Date.now()}`;
        const idempotencyKey = `idem-${workerId}-${i}-${Date.now()}`;
        const ver = repo.createVersion(
          {
            id: versionId,
            botId,
            sourceDigest: `sha256:${workerId}-${i}`,
            profileId: "trusted-local-v1",
            profileRevision: "rev-1"
          },
          { idempotencyKey, actorId: userId }
        );
        allocated.push(ver.version_no);
      }
      return { success: true, allocated };
    }

    if (action === "hold-write-lock") {
      const { holdMs = 200 } = params;
      withTransaction(db, () => {
        // Hold lock by performing an update or dummy table write
        db.prepare("CREATE TABLE IF NOT EXISTS lock_probe (id INTEGER PRIMARY KEY, ts TEXT)").run();
        db.prepare("INSERT INTO lock_probe (ts) VALUES (datetime('now'))").run();

        // Synchronous sleep while inside the transaction
        const start = Date.now();
        while (Date.now() - start < holdMs) {
          // busy-wait to hold SQLite exclusive lock
        }
      });
      return { success: true, heldMs: holdMs };
    }

    if (action === "write-under-lock") {
      const { botId, userId, workerId } = params;
      // This will wait up to busy_timeout (5000ms) for the held lock to be released
      const ver = repo.createVersion(
        {
          id: `contended-ver-${workerId}-${Date.now()}`,
          botId,
          sourceDigest: `sha256:contended-${workerId}`,
          profileId: "trusted-local-v1",
          profileRevision: "rev-1"
        },
        { idempotencyKey: `contended-key-${workerId}-${Date.now()}`, actorId: userId }
      );
      return { success: true, versionNo: ver.version_no };
    }

    if (action === "upload-service-versions") {
      const { botId, userId, workerId, count, storageDir } = params;
      const serviceModule = await import("../../../packages/arena-node/src/persistence/bot-version-service.mjs");
      const artifactModule = await import("../../../packages/arena-node/src/artifacts/artifact-store.mjs");
      const { createBotVersionService } = serviceModule;
      const { createArtifactStore } = artifactModule;
      const artifactStore = createArtifactStore({ storageDir });
      const service = createBotVersionService({ db, artifactStore });
      const allocated = [];
      for (let i = 1; i <= count; i++) {
        const res = await service.uploadBotVersion(
          {
            botId,
            sourceContent: `// worker ${workerId} code ${i}`,
            profileId: "python"
          },
          {
            actorId: userId,
            idempotencyKey: `idem-service-${workerId}-${i}-${Date.now()}`
          }
        );
        allocated.push(res.botVersion.version_no);
      }
      return { success: true, allocated };
    }

    throw new Error(`Unknown worker action: ${action}`);
  } finally {
    closeDatabase(db);
  }
}

// ── Entrypoint ─────────────────────────────────────────────────────────────

if (parentPort && workerData) {
  // Invoked as Worker Thread
  runWorker(workerData)
    .then((result) => parentPort.postMessage(result))
    .catch((err) => parentPort.postMessage({ success: false, error: err.message, stack: err.stack }));
} else if (process.argv[2]) {
  // Invoked as child process via CLI argument JSON
  try {
    const config = JSON.parse(process.argv[2]);
    runWorker(config)
      .then((result) => {
        process.stdout.write(JSON.stringify(result));
        process.exit(0);
      })
      .catch((err) => {
        process.stderr.write(JSON.stringify({ success: false, error: err.message }));
        process.exit(1);
      });
  } catch (err) {
    process.stderr.write(JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
  }
}
