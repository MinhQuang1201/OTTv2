/**
 * tests/arena-worker.test.js
 *
 * Task 12 (Milestone M3): Dispatcher, worker lifecycle, and restart recovery.
 *
 * Tests:
 * 1. Worker executes queued match to completion and settles results atomically.
 * 2. Heartbeat timer extends lease independently while match is executing.
 * 3. Graceful stop mid-match aborts bots and releases lease without rating mutation or forfeit loss.
 * 4. Integration test: child process worker kill mid-match, reopen & claim by new worker,
 *    old worker rejected with StaleLeaseError, exactly once Elo commit.
 */

"use strict";

const { describe, it, before, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");

// Per-test override for portable Node 18 test run (NOT in production code)
const PORTABLE_NODE18_BINDING =
  "C:/Users/ADMIN/AppData/Local/Temp/opencode/arena-sqlite-smoke-node18/node_modules/better-sqlite3/build/Release/better_sqlite3.node";

if (
  process.versions.node.startsWith("18.") &&
  !process.env.ARENA_SQLITE_NATIVE_BINDING &&
  fs.existsSync(PORTABLE_NODE18_BINDING)
) {
  process.env.ARENA_SQLITE_NATIVE_BINDING = PORTABLE_NODE18_BINDING;
}

const TEMP_BASE_DIR = path.resolve(os.tmpdir(), "arena-worker-test-" + Date.now());

let openDatabase;
let closeDatabase;
let createMatchRepository;
let createBotRepository;
let createMatchFinalizer;
let createJobQueue;
let createJobWorker;
let createProcessBot;
let StaleLeaseError;
let computeCompletionDigest;
let canonicalSerialize;

function sha256Digest(data) {
  const str = typeof data === "string" ? data : canonicalSerialize(data);
  return `sha256:${createHash("sha256").update(str, "utf8").digest("hex")}`;
}

before(async () => {
  fs.mkdirSync(TEMP_BASE_DIR, { recursive: true });

  const dbMod = await import("../packages/arena-node/src/persistence/sqlite-database.mjs");
  openDatabase = dbMod.openDatabase;
  closeDatabase = dbMod.closeDatabase;

  const matchRepoMod = await import("../packages/arena-node/src/persistence/match-repository.mjs");
  createMatchRepository = matchRepoMod.createMatchRepository;

  const botRepoMod = await import("../packages/arena-node/src/persistence/bot-repository.mjs");
  createBotRepository = botRepoMod.createBotRepository;

  const finalizerMod = await import("../packages/arena-node/src/persistence/finalizer.mjs");
  createMatchFinalizer = finalizerMod.createMatchFinalizer;
  StaleLeaseError = finalizerMod.StaleLeaseError;

  const queueMod = await import("../packages/arena-node/src/persistence/job-queue.mjs");
  createJobQueue = queueMod.createJobQueue;

  const workerMod = await import("../packages/arena-node/src/worker/job-worker.mjs");
  createJobWorker = workerMod.createJobWorker;

  const processBotMod = await import("../packages/arena-node/src/execution/process-bot.mjs");
  createProcessBot = processBotMod.createProcessBot;

  const usecaseMod = await import("../packages/arena/src/application/finalize-match.mjs");
  computeCompletionDigest = usecaseMod.computeCompletionDigest;

  const rulesetMod = await import("../packages/arena/src/domain/ruleset.mjs");
  canonicalSerialize = rulesetMod.canonicalSerialize;
});

after(() => {
  try {
    fs.rmSync(TEMP_BASE_DIR, { recursive: true, force: true });
  } catch (_) {}
});

function setupEnv(testName) {
  const dir = path.join(TEMP_BASE_DIR, testName);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "arena.db");

  const nativeBinding = process.env.ARENA_SQLITE_NATIVE_BINDING || undefined;
  const { db } = openDatabase(dbPath, nativeBinding ? { nativeBinding } : {});

  const queue = createJobQueue(db);
  const matchRepo = createMatchRepository(db);
  const botRepo = createBotRepository(db);
  const finalizer = createMatchFinalizer(db, { computeDigest: sha256Digest });

  // Seed baseline users & bots
  botRepo.createUser({ id: "user-1", normalizedUsername: "u1", passwordHash: "h1" });
  botRepo.createUser({ id: "user-2", normalizedUsername: "u2", passwordHash: "h2" });
  botRepo.createBot({ id: "bot-1", ownerId: "user-1", name: "Bot1" }, { idempotencyKey: "k-b1", actorId: "user-1" });
  botRepo.createBot({ id: "bot-2", ownerId: "user-2", name: "Bot2" }, { idempotencyKey: "k-b2", actorId: "user-2" });
  botRepo.registerArtifact({ digest: "sha256:a1", kind: "build", relativePrivatePath: "builds/a1", bytes: 100 });
  botRepo.registerArtifact({ digest: "sha256:a2", kind: "build", relativePrivatePath: "builds/a2", bytes: 100 });
  botRepo.createVersion({ id: "v-1", botId: "bot-1", sourceDigest: "sha256:s1", profileId: "python", profileRevision: "v1" }, { idempotencyKey: "k-v1", actorId: "user-1" });
  botRepo.markVersionReady({ botVersionId: "v-1", artifactDigest: "sha256:a1" });
  botRepo.createVersion({ id: "v-2", botId: "bot-2", sourceDigest: "sha256:s2", profileId: "python", profileRevision: "v1" }, { idempotencyKey: "k-v2", actorId: "user-2" });
  botRepo.markVersionReady({ botVersionId: "v-2", artifactDigest: "sha256:a2" });

  const FIXTURES_DIR = path.resolve(__dirname, "fixtures/arena/replays");
  const WIN_FIXTURE = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "deterministic-match.json"), "utf8"));

  function createTestMatch(matchId = `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`) {
    return matchRepo.createMatch({
      id: matchId,
      kind: "ranked",
      ladderId: "ladder-main",
      ruleset: WIN_FIXTURE.rulesetSnapshot,
      policy: WIN_FIXTURE.matchPolicy,
      profile: { id: "profile-1" },
      initialState: WIN_FIXTURE.initialCoreState,
      participants: [
        { seat: "A", botVersionId: "v-1" },
        { seat: "B", botVersionId: "v-2" }
      ]
    });
  }

  return { dir, dbPath, db, queue, matchRepo, botRepo, finalizer, WIN_FIXTURE, createTestMatch };
}

describe("Arena Job Worker", () => {
  it("executes queued match to completion and settles results atomically", async () => {
    const env = setupEnv("worker-exec-match");
    try {
      const match = env.createTestMatch("match-exec-1");
      env.queue.enqueueJob({ kind: "match", targetId: match.id, id: "job-exec-1" });

      const legalBotScript = path.resolve(__dirname, "fixtures/arena/bots/legal.mjs");

      const worker = createJobWorker({
        workerId: "worker-exec-1",
        db: env.db,
        jobQueue: env.queue,
        matchRepo: env.matchRepo,
        finalizer: env.finalizer,
        computeDigest: sha256Digest,
        botFactory: (seat, participant) => {
          return createProcessBot({
            botId: participant.bot_id,
            executable: process.execPath,
            args: [legalBotScript]
          });
        }
      });

      const outcome = await worker.runOnce();
      assert.ok(outcome.executed, "Worker should have executed a job");
      assert.equal(outcome.claim.jobId, "job-exec-1");
      assert.ok(outcome.result, "Match should have produced a result");

      // Verify match in DB is completed and settled
      const completedMatch = env.matchRepo.getMatch(match.id);
      assert.equal(completedMatch.status, "completed");
      assert.equal(completedMatch.settlement_seq, 1);
      assert.ok(completedMatch.settled_at);

      // Verify match result persisted
      const resultRecord = env.matchRepo.getMatchResult(match.id);
      assert.ok(resultRecord);

      // Verify bot ratings updated
      const rA = env.matchRepo.getBotRating("ladder-main", "bot-1");
      const rB = env.matchRepo.getBotRating("ladder-main", "bot-2");
      assert.equal(rA.rated_games, 1);
      assert.equal(rB.rated_games, 1);
      assert.notEqual(rA.rating, 1200.0);
      assert.notEqual(rB.rating, 1200.0);

      // Verify job status completed
      const job = env.queue.getJob("job-exec-1");
      assert.equal(job.status, "completed");
    } finally {
      closeDatabase(env.db);
    }
  });

  it("heartbeat timer extends lease independently while match is executing", async () => {
    const env = setupEnv("worker-heartbeat");
    try {
      const match = env.createTestMatch("match-hb-test");
      env.queue.enqueueJob({ kind: "match", targetId: match.id, id: "job-hb-test" });

      const legalBotScript = path.resolve(__dirname, "fixtures/arena/bots/legal.mjs");

      let heartbeatCount = 0;
      const originalHeartbeat = env.queue.heartbeatJob.bind(env.queue);
      env.queue.heartbeatJob = (params) => {
        heartbeatCount++;
        return originalHeartbeat(params);
      };

      const worker = createJobWorker({
        workerId: "worker-hb",
        db: env.db,
        jobQueue: env.queue,
        matchRepo: env.matchRepo,
        finalizer: env.finalizer,
        computeDigest: sha256Digest,
        heartbeatIntervalMs: 50, // fast heartbeat for test
        leaseDurationMs: 5000,
        botFactory: (seat, participant) => {
          return createProcessBot({
            botId: participant.bot_id,
            executable: process.execPath,
            args: [legalBotScript]
          });
        }
      });

      const outcome = await worker.runOnce();
      assert.ok(outcome.executed);
      assert.ok(heartbeatCount >= 1, `Heartbeat should have ticked at least once, got: ${heartbeatCount}`);
    } finally {
      closeDatabase(env.db);
    }
  });

  it("graceful stop mid-match aborts bots and releases lease without rating mutation", async () => {
    const env = setupEnv("worker-graceful-stop");
    try {
      const match = env.createTestMatch("match-stop-test");
      env.queue.enqueueJob({ kind: "match", targetId: match.id, id: "job-stop-test" });

      const sleepBotScript = path.resolve(__dirname, "fixtures/arena/bots/sleep.mjs");

      const worker = createJobWorker({
        workerId: "worker-stop",
        db: env.db,
        jobQueue: env.queue,
        matchRepo: env.matchRepo,
        finalizer: env.finalizer,
        computeDigest: sha256Digest,
        botFactory: (seat, participant) => {
          return createProcessBot({
            botId: participant.bot_id,
            executable: process.execPath,
            args: [sleepBotScript]
          });
        }
      });

      // Start runOnce in background
      const runPromise = worker.runOnce();

      // Give worker a moment to claim and start bots
      await new Promise((r) => setTimeout(r, 100));

      // Worker stops gracefully
      await worker.stop();
      await runPromise;

      // Verify job is back to queued
      const job = env.queue.getJob("job-stop-test");
      assert.equal(job.status, "queued");
      assert.equal(job.lease_owner, null);

      // Verify match is pending
      const m = env.matchRepo.getMatch(match.id);
      assert.equal(m.status, "pending");

      // Verify ratings NOT changed
      const rA = env.matchRepo.getBotRating("ladder-main", "bot-1");
      const rB = env.matchRepo.getBotRating("ladder-main", "bot-2");
      assert.equal(rA.rated_games, 0);
      assert.equal(rB.rated_games, 0);
      assert.equal(rA.rating, 1200.0);
      assert.equal(rB.rating, 1200.0);
    } finally {
      closeDatabase(env.db);
    }
  });

  it("child process worker kill mid-match, reopen & claim by new worker, old worker rejected, exactly once Elo commit", async () => {
    const env = setupEnv("worker-kill-recovery");
    try {
      const match = env.createTestMatch("match-crash-test");
      env.queue.enqueueJob({ kind: "match", targetId: match.id, id: "job-crash-test" });

      const sleepBotScript = path.resolve(__dirname, "fixtures/arena/bots/sleep.mjs");
      const legalBotScript = path.resolve(__dirname, "fixtures/arena/bots/legal.mjs");

      const { pathToFileURL } = require("node:url");

      // Worker runner helper script
      const runnerScript = path.join(env.dir, "worker-runner.mjs");
      const dbModUrl = pathToFileURL(path.resolve(__dirname, "../packages/arena-node/src/persistence/sqlite-database.mjs")).href;
      const matchRepoModUrl = pathToFileURL(path.resolve(__dirname, "../packages/arena-node/src/persistence/match-repository.mjs")).href;
      const finalizerModUrl = pathToFileURL(path.resolve(__dirname, "../packages/arena-node/src/persistence/finalizer.mjs")).href;
      const queueModUrl = pathToFileURL(path.resolve(__dirname, "../packages/arena-node/src/persistence/job-queue.mjs")).href;
      const workerModUrl = pathToFileURL(path.resolve(__dirname, "../packages/arena-node/src/worker/job-worker.mjs")).href;
      const processBotModUrl = pathToFileURL(path.resolve(__dirname, "../packages/arena-node/src/execution/process-bot.mjs")).href;

      fs.writeFileSync(
        runnerScript,
        `
import { openDatabase, closeDatabase } from ${JSON.stringify(dbModUrl)};
import { createMatchRepository } from ${JSON.stringify(matchRepoModUrl)};
import { createMatchFinalizer } from ${JSON.stringify(finalizerModUrl)};
import { createJobQueue } from ${JSON.stringify(queueModUrl)};
import { createJobWorker } from ${JSON.stringify(workerModUrl)};
import { createProcessBot } from ${JSON.stringify(processBotModUrl)};
import { createHash } from "node:crypto";

const nativeBinding = process.env.ARENA_SQLITE_NATIVE_BINDING || undefined;
const { db } = openDatabase(${JSON.stringify(env.dbPath)}, nativeBinding ? { nativeBinding } : {});
const queue = createJobQueue(db);
const matchRepo = createMatchRepository(db);
const finalizer = createMatchFinalizer(db, {
  computeDigest: (str) => "sha256:" + createHash("sha256").update(str).digest("hex")
});

const worker = createJobWorker({
  workerId: "child-worker-1",
  db,
  jobQueue: queue,
  matchRepo,
  finalizer,
  computeDigest: (str) => "sha256:" + createHash("sha256").update(str).digest("hex"),
  botFactory: (seat, participant) => {
    return createProcessBot({
      botId: participant.bot_id,
      executable: process.execPath,
      args: [${JSON.stringify(sleepBotScript)}]
    });
  }
});

process.on("message", async (msg) => {
  if (msg === "start") {
    process.send("started");
    await worker.runOnce();
  }
});
`,
        "utf8"
      );

      // Spawn child process Worker 1
      const child = spawn(process.execPath, [runnerScript], {
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        env: { ...process.env }
      });
      child.stderr.on("data", (d) => process.stderr.write(`[child stderr] ${d}`));

      await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (code, signal) => {
          if (code !== null && code !== 0) {
            reject(new Error(`Child exited early with code ${code}`));
          }
        });
        child.on("message", (msg) => {
          if (msg === "started") resolve();
        });
        child.send("start");
      });

      // Wait until child has claimed the job
      let claimed = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 100));
        claimed = env.queue.getJob("job-crash-test");
        if (claimed && claimed.status === "claimed") break;
      }

      assert.equal(claimed.status, "claimed");
      assert.equal(claimed.lease_owner, "child-worker-1");
      const oldLeaseToken = claimed.lease_token;
      const oldAttemptNo = claimed.attempt_no;

      // KILL Worker 1 with SIGKILL mid-match!
      child.kill("SIGKILL");
      await new Promise((resolve) => child.on("exit", resolve));

      // Expire the lease in database to simulate timeout
      env.db.prepare("UPDATE jobs SET lease_until = datetime('now', '-5 seconds') WHERE id = ?").run("job-crash-test");

      // Recovery runs
      const recovered = env.queue.recoverExpiredJobs();
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0].action, "requeued");

      // Verify attempt 1 is fenced
      const attempts = env.queue.getJobAttempts("job-crash-test");
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].status, "fenced");

      // Verify old worker cannot finalize if it attempts to with old credentials (StaleLeaseError)
      assert.throws(
        () => {
          env.finalizer.finalizeMatch({
            matchId: match.id,
            attemptNo: oldAttemptNo,
            leaseToken: oldLeaseToken,
            result: { outcome: "win", winner: "A", reason: "checkmate" },
            replay: env.WIN_FIXTURE,
            replayDigest: "sha256:fake",
            completionDigest: "sha256:fake"
          });
        },
        (err) => {
          return err instanceof StaleLeaseError || err.name === "StaleLeaseError";
        }
      );

      // Worker 2 (new worker) claims and runs the match to completion
      const worker2 = createJobWorker({
        workerId: "worker-recovery-2",
        db: env.db,
        jobQueue: env.queue,
        matchRepo: env.matchRepo,
        finalizer: env.finalizer,
        computeDigest: sha256Digest,
        botFactory: (seat, participant) => {
          return createProcessBot({
            botId: participant.bot_id,
            executable: process.execPath,
            args: [legalBotScript]
          });
        }
      });

      const outcome2 = await worker2.runOnce();
      assert.ok(outcome2.executed);
      assert.equal(outcome2.claim.attemptNo, 2);

      // Verify EXACTLY ONCE Elo commit
      const completedMatch = env.matchRepo.getMatch(match.id);
      assert.equal(completedMatch.status, "completed");
      assert.equal(completedMatch.settlement_seq, 1);

      const rA = env.matchRepo.getBotRating("ladder-main", "bot-1");
      const rB = env.matchRepo.getBotRating("ladder-main", "bot-2");
      assert.equal(rA.rated_games, 1);
      assert.equal(rB.rated_games, 1);
    } finally {
      closeDatabase(env.db);
    }
  });
});
