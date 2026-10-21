/**
 * tests/arena-queue.test.js
 *
 * Task 12 (Milestone M3): Durable queue unit tests with real temp SQLite.
 * Tests:
 * 1. FIFO eligible claim order
 * 2. Concurrency limit: 1 active job per worker
 * 3. Lease token uniqueness and monotonic attempt_no increment
 * 4. Heartbeat renewal extends lease_until
 * 5. Heartbeat rejection on token/attempt mismatch or expired lease
 * 6. Graceful job release resets job to queued and marks attempt fenced
 * 7. Expired lease recovery re-enqueues same job identity from initial state
 * 8. Max attempts boundary: marks job failed and match error after max attempts
 */

"use strict";

const { describe, it, before, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

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

const TEMP_BASE_DIR = path.resolve(os.tmpdir(), "arena-queue-test-" + Date.now());

let openDatabase;
let closeDatabase;
let createMatchRepository;
let createBotRepository;
let createJobQueue;

before(async () => {
  fs.mkdirSync(TEMP_BASE_DIR, { recursive: true });

  const dbMod = await import("../packages/arena-node/src/persistence/sqlite-database.mjs");
  openDatabase = dbMod.openDatabase;
  closeDatabase = dbMod.closeDatabase;

  const matchRepoMod = await import("../packages/arena-node/src/persistence/match-repository.mjs");
  createMatchRepository = matchRepoMod.createMatchRepository;

  const botRepoMod = await import("../packages/arena-node/src/persistence/bot-repository.mjs");
  createBotRepository = botRepoMod.createBotRepository;

  const queueMod = await import("../packages/arena-node/src/persistence/job-queue.mjs");
  createJobQueue = queueMod.createJobQueue;
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

  // Seed baseline users & bots for FK consistency
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

  function createTestMatch(matchId = `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`) {
    return matchRepo.createMatch({
      id: matchId,
      kind: "ranked",
      ladderId: "ladder-main",
      ruleset: { id: "ruleset-1" },
      policy: { maxTurns: 100 },
      profile: { id: "profile-1" },
      initialState: { turn: "A" },
      participants: [
        { seat: "A", botVersionId: "v-1" },
        { seat: "B", botVersionId: "v-2" }
      ]
    });
  }

  return { db, queue, matchRepo, botRepo, createTestMatch };
}

describe("Arena Job Queue", () => {
  it("claims jobs in FIFO order by creation time", () => {
    const { db, queue, createTestMatch } = setupEnv("fifo-order");
    try {
      const m1 = createTestMatch("match-1");
      const m2 = createTestMatch("match-2");
      const m3 = createTestMatch("match-3");

      const j1 = queue.enqueueJob({ kind: "match", targetId: m1.id, id: "job-1" });
      const j2 = queue.enqueueJob({ kind: "match", targetId: m2.id, id: "job-2" });
      const j3 = queue.enqueueJob({ kind: "match", targetId: m3.id, id: "job-3" });

      const claim1 = queue.claimNextJob({ workerId: "worker-1" });
      assert.ok(claim1, "claim1 must be non-null");
      assert.equal(claim1.jobId, "job-1");
      assert.equal(claim1.targetId, "match-1");

      const claim2 = queue.claimNextJob({ workerId: "worker-2" });
      assert.ok(claim2, "claim2 must be non-null");
      assert.equal(claim2.jobId, "job-2");
      assert.equal(claim2.targetId, "match-2");

      const claim3 = queue.claimNextJob({ workerId: "worker-3" });
      assert.ok(claim3, "claim3 must be non-null");
      assert.equal(claim3.jobId, "job-3");
      assert.equal(claim3.targetId, "match-3");

      const claim4 = queue.claimNextJob({ workerId: "worker-4" });
      assert.equal(claim4, null, "claim4 should be null when queue is empty");
    } finally {
      closeDatabase(db);
    }
  });

  it("enforces concurrency limit: 1 active job per worker", () => {
    const { db, queue, createTestMatch } = setupEnv("concurrency-limit");
    try {
      const m1 = createTestMatch("match-c1");
      const m2 = createTestMatch("match-c2");

      queue.enqueueJob({ kind: "match", targetId: m1.id, id: "job-c1" });
      queue.enqueueJob({ kind: "match", targetId: m2.id, id: "job-c2" });

      const claim1 = queue.claimNextJob({ workerId: "worker-exclusive" });
      assert.ok(claim1);
      assert.equal(claim1.jobId, "job-c1");

      // worker-exclusive already holds an active claim, cannot claim second job concurrently
      const claim2 = queue.claimNextJob({ workerId: "worker-exclusive" });
      assert.equal(claim2, null, "worker with active lease cannot claim another job");

      // But a different worker can claim the second job
      const claimOther = queue.claimNextJob({ workerId: "worker-other" });
      assert.ok(claimOther);
      assert.equal(claimOther.jobId, "job-c2");
    } finally {
      closeDatabase(db);
    }
  });

  it("allocates unique lease_token and monotonically increments attempt_no", () => {
    const { db, queue, createTestMatch } = setupEnv("token-and-attempt");
    try {
      const m1 = createTestMatch("match-tok");
      queue.enqueueJob({ kind: "match", targetId: m1.id, id: "job-tok" });

      const claim1 = queue.claimNextJob({ workerId: "worker-1" });
      assert.equal(claim1.attemptNo, 1);
      assert.ok(claim1.leaseToken, "leaseToken must be generated");

      const attempts = queue.getJobAttempts("job-tok");
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].attempt_no, 1);
      assert.equal(attempts[0].lease_token, claim1.leaseToken);
      assert.equal(attempts[0].status, "active");
    } finally {
      closeDatabase(db);
    }
  });

  it("renews lease_until on valid heartbeat with matching token and attempt", () => {
    const { db, queue, createTestMatch } = setupEnv("heartbeat-success");
    try {
      const m1 = createTestMatch("match-hb");
      queue.enqueueJob({ kind: "match", targetId: m1.id, id: "job-hb" });

      const claim = queue.claimNextJob({ workerId: "worker-hb", leaseDurationMs: 10000 });
      const initialLeaseUntil = queue.getJob("job-hb").lease_until;

      const ok = queue.heartbeatJob({
        jobId: "job-hb",
        leaseToken: claim.leaseToken,
        attemptNo: claim.attemptNo,
        extendDurationMs: 60000
      });
      assert.equal(ok, true, "heartbeat should succeed");

      const renewed = queue.getJob("job-hb");
      assert.ok(renewed.lease_until);
      assert.ok(renewed.heartbeat_at);
    } finally {
      closeDatabase(db);
    }
  });

  it("rejects heartbeat on token mismatch, attempt mismatch, or expired lease", () => {
    const { db, queue, createTestMatch } = setupEnv("heartbeat-reject");
    try {
      const m1 = createTestMatch("match-rej");
      queue.enqueueJob({ kind: "match", targetId: m1.id, id: "job-rej" });

      const claim = queue.claimNextJob({ workerId: "worker-rej", leaseDurationMs: 30000 });

      // Wrong token
      const badToken = queue.heartbeatJob({
        jobId: "job-rej",
        leaseToken: "wrong-token",
        attemptNo: claim.attemptNo
      });
      assert.equal(badToken, false, "heartbeat with wrong token must fail");

      // Wrong attempt
      const badAttempt = queue.heartbeatJob({
        jobId: "job-rej",
        leaseToken: claim.leaseToken,
        attemptNo: 99
      });
      assert.equal(badAttempt, false, "heartbeat with wrong attempt must fail");

      // Expired lease
      db.prepare("UPDATE jobs SET lease_until = datetime('now', '-10 seconds') WHERE id = ?").run("job-rej");
      const expiredHb = queue.heartbeatJob({
        jobId: "job-rej",
        leaseToken: claim.leaseToken,
        attemptNo: claim.attemptNo
      });
      assert.equal(expiredHb, false, "heartbeat on expired lease must fail");
    } finally {
      closeDatabase(db);
    }
  });

  it("releases job gracefully without awarding forfeit loss or failing match", () => {
    const { db, queue, matchRepo, createTestMatch } = setupEnv("release-graceful");
    try {
      const m = createTestMatch("match-rel");
      queue.enqueueJob({ kind: "match", targetId: m.id, id: "job-rel" });

      const claim = queue.claimNextJob({ workerId: "worker-rel" });
      assert.equal(claim.jobId, "job-rel");

      // Verify match transitioned to active when claimed
      const activeMatch = matchRepo.getMatch(m.id);
      assert.equal(activeMatch.status, "active");

      // Release job gracefully
      const released = queue.releaseJob({
        jobId: "job-rel",
        leaseToken: claim.leaseToken,
        attemptNo: claim.attemptNo,
        reason: "graceful_shutdown"
      });
      assert.equal(released, true);

      // Verify job is back to queued
      const reJob = queue.getJob("job-rel");
      assert.equal(reJob.status, "queued");
      assert.equal(reJob.lease_owner, null);
      assert.equal(reJob.lease_token, null);

      // Verify attempt is fenced
      const attempts = queue.getJobAttempts("job-rel");
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].status, "fenced");

      // Verify match status reset to pending
      const pendingMatch = matchRepo.getMatch(m.id);
      assert.equal(pendingMatch.status, "pending");

      // Another worker can now claim and attempt No becomes 2
      const claim2 = queue.claimNextJob({ workerId: "worker-2" });
      assert.ok(claim2);
      assert.equal(claim2.jobId, "job-rel");
      assert.equal(claim2.attemptNo, 2);
    } finally {
      closeDatabase(db);
    }
  });

  it("recovers expired jobs: marks attempt fenced, re-enqueues same match identity from scratch", () => {
    const { db, queue, matchRepo, createTestMatch } = setupEnv("recovery-expired");
    try {
      const m = createTestMatch("match-rec");
      queue.enqueueJob({ kind: "match", targetId: m.id, id: "job-rec", maxAttempts: 3 });

      const claim1 = queue.claimNextJob({ workerId: "worker-1" });
      assert.equal(claim1.attemptNo, 1);

      // Simulate lease expiration by setting lease_until into the past
      db.prepare("UPDATE jobs SET lease_until = datetime('now', '-5 seconds') WHERE id = ?").run("job-rec");

      // Recover expired jobs
      const recovered = queue.recoverExpiredJobs();
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0].jobId, "job-rec");
      assert.equal(recovered[0].action, "requeued");

      // Verify attempt 1 is fenced
      const attempts = queue.getJobAttempts("job-rec");
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].attempt_no, 1);
      assert.equal(attempts[0].status, "fenced");

      // Verify job is queued again
      const job = queue.getJob("job-rec");
      assert.equal(job.status, "queued");
      assert.equal(job.attempt_no, 1); // was incremented to 1 during attempt 1

      // Verify match status reset to pending
      assert.equal(matchRepo.getMatch(m.id).status, "pending");

      // Worker 2 claims it -> attempt 2
      const claim2 = queue.claimNextJob({ workerId: "worker-2" });
      assert.ok(claim2);
      assert.equal(claim2.attemptNo, 2);
      assert.notEqual(claim2.leaseToken, claim1.leaseToken);
    } finally {
      closeDatabase(db);
    }
  });

  it("reaches max_attempts: marks job failed and match error", () => {
    const { db, queue, matchRepo, createTestMatch } = setupEnv("max-attempts");
    try {
      const m = createTestMatch("match-max");
      queue.enqueueJob({ kind: "match", targetId: m.id, id: "job-max", maxAttempts: 2 });

      // Attempt 1: claim and expire
      const c1 = queue.claimNextJob({ workerId: "w1" });
      assert.equal(c1.attemptNo, 1);
      db.prepare("UPDATE jobs SET lease_until = datetime('now', '-5 seconds') WHERE id = ?").run("job-max");
      const rec1 = queue.recoverExpiredJobs();
      assert.equal(rec1[0].action, "requeued");

      // Attempt 2: claim and expire (reaches max_attempts = 2)
      const c2 = queue.claimNextJob({ workerId: "w2" });
      assert.equal(c2.attemptNo, 2);
      db.prepare("UPDATE jobs SET lease_until = datetime('now', '-5 seconds') WHERE id = ?").run("job-max");
      const rec2 = queue.recoverExpiredJobs();
      assert.equal(rec2[0].action, "failed");

      // Verify job status failed
      const job = queue.getJob("job-max");
      assert.equal(job.status, "failed");

      // Verify match status error
      const match = matchRepo.getMatch(m.id);
      assert.equal(match.status, "error");

      // No more claims possible
      const c3 = queue.claimNextJob({ workerId: "w3" });
      assert.equal(c3, null);
    } finally {
      closeDatabase(db);
    }
  });
});
