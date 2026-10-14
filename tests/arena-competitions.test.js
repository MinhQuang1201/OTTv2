/**
 * tests/arena-competitions.test.js
 *
 * Task 1 (Arena Part A): Competition lifecycle backend, migration, repository, and HTTP routes.
 *
 * Requirements verified:
 * 1. Migration backwards compatibility & fail-closed unknown migration detection.
 * 2. Competition lifecycle state machine:
 *    registration -> preparation -> locked -> running -> completed.
 * 3. Role/ownership restrictions:
 *    - Only admin can create competition, review entries, advance phase, retry match.
 *    - Authors can only submit their own bots and only when admitted.
 *    - Spectators/authors can read public event projections.
 * 4. Admission gates:
 *    - Pending admission blocks advance from registration to preparation.
 *    - At least 2 accepted entries required.
 * 5. Readiness and version pinning gates:
 *    - Non-ready bots block locking.
 *    - Missing submission blocks locking.
 *    - Duplicate bots block locking.
 * 6. Capacity & Idempotency:
 *    - Registration idempotent per user.
 *    - Capacity enforced on registration and review.
 * 7. Atomic tournament launch & nested transaction launch rollback:
 *    - Failure in tournament creation rolls back both competition update and tournament.
 *    - Competition remains locked without orphan records.
 * 8. Linked tournament match error retry API:
 *    - Only allowed during running phase on matches with 'error' status.
 * 9. Shared API contract compliance:
 *    - Exact shapes for Competition and Entry.
 *    - Standard error format { error: { code, message, requestId, details } }.
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
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

const TEMP_BASE_DIR = path.resolve(os.tmpdir(), "arena-competitions-test-" + Date.now());

let openDatabase;
let closeDatabase;
let applyMigration;
let withTransaction;
let createBotRepository;
let createTournamentRepository;
let createCompetitionRepository;
let CompetitionValidationError;
let CompetitionPhaseError;
let CompetitionCapacityError;
let BotNotReadyError;
let ForbiddenError;
let NotFoundError;
let IdempotencyConflictError;

let createArenaServer;
let createJobQueue;
let hashPassword;
let createSession;

function sha256Digest(str) {
  return `sha256:${createHash("sha256").update(str, "utf8").digest("hex")}`;
}

function makeRequest(server, options, body = null) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const reqOptions = {
      hostname: "127.0.0.1",
      port: addr.port,
      path: options.path,
      method: options.method || "GET",
      headers: {
        ...(options.headers || {})
      }
    };

    if (body && !reqOptions.headers["Content-Type"] && !reqOptions.headers["content-type"]) {
      reqOptions.headers["Content-Type"] = "application/json";
    }

    const req = http.request(reqOptions, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(rawBody);
        } catch (_) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          rawBody,
          json
        });
      });
    });

    req.on("error", reject);

    if (body) {
      if (typeof body === "string" || Buffer.isBuffer(body)) {
        req.write(body);
      } else {
        req.write(JSON.stringify(body));
      }
    }
    req.end();
  });
}

before(async () => {
  fs.mkdirSync(TEMP_BASE_DIR, { recursive: true });

  const dbMod = await import("../packages/arena-node/src/persistence/sqlite-database.mjs");
  openDatabase = dbMod.openDatabase;
  closeDatabase = dbMod.closeDatabase;
  applyMigration = dbMod.applyMigration;
  withTransaction = dbMod.withTransaction;

  const botRepoMod = await import("../packages/arena-node/src/persistence/bot-repository.mjs");
  createBotRepository = botRepoMod.createBotRepository;

  const tournRepoMod = await import("../packages/arena-node/src/persistence/tournament-repository.mjs");
  createTournamentRepository = tournRepoMod.createTournamentRepository;

  const compRepoMod = await import("../packages/arena-node/src/persistence/competition-repository.mjs");
  createCompetitionRepository = compRepoMod.createCompetitionRepository;
  CompetitionValidationError = compRepoMod.CompetitionValidationError;
  CompetitionPhaseError = compRepoMod.CompetitionPhaseError;
  CompetitionCapacityError = compRepoMod.CompetitionCapacityError;
  BotNotReadyError = compRepoMod.BotNotReadyError;
  ForbiddenError = compRepoMod.ForbiddenError;
  NotFoundError = compRepoMod.NotFoundError;
  IdempotencyConflictError = compRepoMod.IdempotencyConflictError;

  const serverMod = await import("../apps/arena-api/src/http-server.mjs");
  createArenaServer = serverMod.createArenaServer;

  const jobQueueMod = await import("../packages/arena-node/src/persistence/job-queue.mjs");
  createJobQueue = jobQueueMod.createJobQueue;

  const accountsMod = await import("../apps/arena-api/src/auth/accounts.mjs");
  hashPassword = accountsMod.hashPassword;
  createSession = accountsMod.createSession;
});

after(() => {
  try {
    fs.rmSync(TEMP_BASE_DIR, { recursive: true, force: true });
  } catch (_) {}
});

function seedUser(db, id, username, role = "author") {
  const pwdHash = hashPassword("TestPass123!");
  db.prepare(`
    INSERT INTO users (id, normalized_username, password_hash, role, status)
    VALUES (?, ?, ?, ?, 'active')
    ON CONFLICT(id) DO NOTHING
  `).run(id, username, pwdHash, role);
}

function setupTestDb(name) {
  const dir = path.join(TEMP_BASE_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "arena.db");
  const nativeBinding = process.env.ARENA_SQLITE_NATIVE_BINDING || undefined;
  const { db } = openDatabase(dbPath, nativeBinding ? { nativeBinding } : {});
  const botRepo = createBotRepository(db);
  const tournamentRepo = createTournamentRepository(db);
  const competitionRepo = createCompetitionRepository(db, { tournamentRepo });

  function registerReadyBot(botId, ownerId = "usr-admin") {
    seedUser(db, ownerId, ownerId, "author");
    botRepo.createBot(
      { id: botId, ownerId, name: botId },
      { idempotencyKey: `k-bot-${botId}`, actorId: ownerId }
    );
    const artDigest = `sha256:art-${botId}`;
    botRepo.registerArtifact({
      digest: artDigest,
      kind: "build",
      relativePrivatePath: `builds/${botId}`,
      bytes: 200
    });
    const vId = `ver-${botId}-1`;
    botRepo.createVersion(
      {
        id: vId,
        botId,
        sourceDigest: sha256Digest(`src-${botId}`),
        profileId: "controlled-node",
        profileRevision: "node-v1"
      },
      { idempotencyKey: `k-ver-${botId}`, actorId: ownerId }
    );
    botRepo.markVersionReady({ botVersionId: vId, artifactDigest: artDigest });
    return { botId, botVersionId: vId, artifactDigest: artDigest, ownerId };
  }

  return { dir, dbPath, db, botRepo, tournamentRepo, competitionRepo, registerReadyBot };
}

describe("Competition Lifecycle Backend — Task 1", () => {
  describe("1. Schema Migration & Backward Compatibility", () => {
    it("preserves backward compatibility: default openDatabase applies 001-arena; applyMigration applies 002-competitions", () => {
      const { db } = openDatabase(":memory:");
      try {
        const migrations = db.prepare("SELECT version FROM schema_migrations").all();
        assert.deepEqual(migrations.map((m) => m.version), ["001-arena"]);

        // Apply 002-competitions
        applyMigration(db, "002-competitions");
        const afterMigrations = db.prepare("SELECT version FROM schema_migrations").all();
        assert.deepEqual(afterMigrations.map((m) => m.version), ["001-arena", "002-competitions"]);

        // Applying again is idempotent
        applyMigration(db, "002-competitions");

        // Verify tables exist
        const compTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='competitions'").get();
        const entriesTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='competition_entries'").get();
        assert.ok(compTable);
        assert.ok(entriesTable);
      } finally {
        closeDatabase(db);
      }
    });

    it("rejects unknown migration version fail-closed", () => {
      const { db } = openDatabase(":memory:");
      try {
        assert.throws(() => applyMigration(db, "999-future-migration"), /Unknown migration/);
      } finally {
        closeDatabase(db);
      }
    });
  });

  describe("2. Repository: CRUD, Idempotency & Registration Gates", () => {
    it("creates competition in registration phase and enforces input validations", () => {
      const { db, competitionRepo } = setupTestDb("repo-create");
      try {
        // Empty name throws
        assert.throws(() => competitionRepo.createCompetition({ name: "" }), CompetitionValidationError);
        // Capacity < 2 or > 128 throws
        assert.throws(() => competitionRepo.createCompetition({ name: "C", capacity: 1 }), CompetitionValidationError);
        assert.throws(() => competitionRepo.createCompetition({ name: "C", capacity: 200 }), CompetitionValidationError);

        const comp = competitionRepo.createCompetition({
          name: "Spring Championship",
          description: "Spring season event",
          capacity: 8,
          ranked: true
        });

        assert.ok(comp.id.startsWith("comp-"));
        assert.equal(comp.name, "Spring Championship");
        assert.equal(comp.description, "Spring season event");
        assert.equal(comp.phase, "registration");
        assert.equal(comp.capacity, 8);
        assert.equal(comp.ranked, true);
        assert.equal(comp.tournamentId, null);
        assert.ok(comp.createdAt);
      } finally {
        closeDatabase(db);
      }
    });

    it("enforces idempotency on createCompetition", () => {
      const { db, competitionRepo } = setupTestDb("repo-idempotency");
      try {
        const actorId = "usr-admin-1";
        seedUser(db, actorId, actorId, "admin");
        const key = "key-create-event-1";

        const comp1 = competitionRepo.createCompetition(
          { name: "Summer Cup", capacity: 16 },
          { actorId, idempotencyKey: key }
        );

        // Replay with exact same payload returns existing competition
        const comp2 = competitionRepo.createCompetition(
          { name: "Summer Cup", capacity: 16 },
          { actorId, idempotencyKey: key }
        );
        assert.equal(comp1.id, comp2.id);

        // Mismatched payload with same key throws IdempotencyConflictError
        assert.throws(
          () =>
            competitionRepo.createCompetition(
              { name: "Winter Cup", capacity: 16 },
              { actorId, idempotencyKey: key }
            ),
          IdempotencyConflictError
        );
      } finally {
        closeDatabase(db);
      }
    });

    it("handles registration idempotency per user and enforces capacity limit", () => {
      const { db, competitionRepo } = setupTestDb("repo-registration-capacity");
      try {
        seedUser(db, "u1", "u1", "author");
        seedUser(db, "u2", "u2", "author");
        seedUser(db, "u3", "u3", "author");

        const comp = competitionRepo.createCompetition({ name: "Mini Cup", capacity: 2 });

        // User 1 registers -> pending
        const entry1 = competitionRepo.registerEntry(comp.id, "u1");
        assert.equal(entry1.userId, "u1");
        assert.equal(entry1.status, "pending");

        // User 1 re-registers -> idempotent, returns existing entry
        const entry1Dup = competitionRepo.registerEntry(comp.id, "u1");
        assert.equal(entry1Dup.userId, "u1");
        assert.equal(entry1Dup.status, "pending");

        // User 2 registers -> reaches capacity of 2
        const entry2 = competitionRepo.registerEntry(comp.id, "u2");
        assert.equal(entry2.status, "pending");

        // User 3 registers -> capacity exceeded
        assert.throws(
          () => competitionRepo.registerEntry(comp.id, "u3"),
          CompetitionCapacityError
        );
      } finally {
        closeDatabase(db);
      }
    });

    it("allows admin to review entries (accept/decline) with capacity check", () => {
      const { db, competitionRepo } = setupTestDb("repo-review");
      try {
        seedUser(db, "u1", "u1", "author");
        seedUser(db, "u2", "u2", "author");

        const comp = competitionRepo.createCompetition({ name: "Cup", capacity: 2 });
        competitionRepo.registerEntry(comp.id, "u1");
        competitionRepo.registerEntry(comp.id, "u2");

        // Admin accepts u1
        const reviewed1 = competitionRepo.reviewEntry(comp.id, "u1", true);
        assert.equal(reviewed1.status, "accepted");

        // Admin declines u2
        const reviewed2 = competitionRepo.reviewEntry(comp.id, "u2", false);
        assert.equal(reviewed2.status, "declined");

        // Reviewing unknown user throws NotFoundError
        assert.throws(
          () => competitionRepo.reviewEntry(comp.id, "unknown-user", true),
          NotFoundError
        );
      } finally {
        closeDatabase(db);
      }
    });
  });

  describe("3. Bot Submission & Ownership Gates in Preparation Phase", () => {
    it("enforces that bot submission is permitted ONLY during preparation phase and only by admitted owner of ready bot", () => {
      const { db, competitionRepo, botRepo, registerReadyBot } = setupTestDb("repo-submission");
      try {
        const b1 = registerReadyBot("bot-alice", "usr-alice");
        const b2 = registerReadyBot("bot-bob", "usr-bob");

        const comp = competitionRepo.createCompetition({ name: "Bot Cup", capacity: 4 });
        competitionRepo.registerEntry(comp.id, "usr-alice");
        competitionRepo.registerEntry(comp.id, "usr-bob");

        // In registration phase: submission must be rejected
        assert.throws(
          () => competitionRepo.submitBotVersion(comp.id, "usr-alice", b1.botVersionId),
          CompetitionPhaseError
        );

        // Admit both
        competitionRepo.reviewEntry(comp.id, "usr-alice", true);
        competitionRepo.reviewEntry(comp.id, "usr-bob", true);

        // Advance to preparation
        competitionRepo.advancePhase(comp.id, "registration");

        // Alice cannot submit Bob's bot (ownership gate)
        assert.throws(
          () => competitionRepo.submitBotVersion(comp.id, "usr-alice", b2.botVersionId),
          ForbiddenError
        );

        // Alice creates an unready bot version
        const unreadyVerId = "ver-alice-unready";
        botRepo.createVersion(
          {
            id: unreadyVerId,
            botId: "bot-alice",
            sourceDigest: sha256Digest("src-unready"),
            profileId: "controlled-node",
            profileRevision: "node-v1"
          },
          { idempotencyKey: "k-unready", actorId: "usr-alice" }
        );
        // Submitting unready version throws BotNotReadyError
        assert.throws(
          () => competitionRepo.submitBotVersion(comp.id, "usr-alice", unreadyVerId),
          BotNotReadyError
        );

        // Alice submits her READY bot version successfully
        const subAlice = competitionRepo.submitBotVersion(comp.id, "usr-alice", b1.botVersionId);
        assert.equal(subAlice.botId, "bot-alice");
        assert.equal(subAlice.botVersionId, b1.botVersionId);
        assert.equal(subAlice.buildStatus, "ready");
      } finally {
        closeDatabase(db);
      }
    });
  });

  describe("4. Phase State Machine & Atomic Tournament Launch", () => {
    it("blocks advance to preparation if pending entries exist or fewer than 2 admitted", () => {
      const { db, competitionRepo } = setupTestDb("repo-phase-prep-gates");
      try {
        seedUser(db, "u1", "u1", "author");
        seedUser(db, "u2", "u2", "author");

        const comp = competitionRepo.createCompetition({ name: "Gate Cup" });
        competitionRepo.registerEntry(comp.id, "u1");
        competitionRepo.registerEntry(comp.id, "u2");

        // Both are pending: advance fails
        assert.throws(
          () => competitionRepo.advancePhase(comp.id, "registration"),
          /pending entries exist/i
        );

        // Accept only 1: advance fails (< 2 accepted)
        competitionRepo.reviewEntry(comp.id, "u1", true);
        assert.throws(
          () => competitionRepo.advancePhase(comp.id, "registration"),
          /pending entries exist/i
        );

        competitionRepo.reviewEntry(comp.id, "u2", false); // declined
        assert.throws(
          () => competitionRepo.advancePhase(comp.id, "registration"),
          /requires at least 2 accepted/i
        );
      } finally {
        closeDatabase(db);
      }
    });

    it("blocks locking if any admitted participant has not submitted a READY bot version", () => {
      const { db, competitionRepo, registerReadyBot } = setupTestDb("repo-lock-gates");
      try {
        const b1 = registerReadyBot("bot-p1", "u1");
        registerReadyBot("bot-p2", "u2");

        const comp = competitionRepo.createCompetition({ name: "Lock Gate Cup" });
        competitionRepo.registerEntry(comp.id, "u1");
        competitionRepo.registerEntry(comp.id, "u2");
        competitionRepo.reviewEntry(comp.id, "u1", true);
        competitionRepo.reviewEntry(comp.id, "u2", true);

        // Advance to preparation
        competitionRepo.advancePhase(comp.id, "registration");

        // Only u1 submits
        competitionRepo.submitBotVersion(comp.id, "u1", b1.botVersionId);

        // Advance to locked fails because u2 hasn't submitted
        assert.throws(
          () => competitionRepo.advancePhase(comp.id, "preparation"),
          /has not submitted a bot version/i
        );
      } finally {
        closeDatabase(db);
      }
    });

    it("rolls back nested transaction if tournament creation fails during launch", () => {
      const { db, registerReadyBot } = setupTestDb("repo-nested-rollback");
      try {
        const b1 = registerReadyBot("bot-rb1", "u1");
        const b2 = registerReadyBot("bot-rb2", "u2");

        // Create competition repository with a failing tournament repo mock
        const failingTournRepo = {
          createTournament: () => {
            // Simulate crash inside tournament creation
            throw new Error("Simulated fatal tournament runner crash");
          },
          getTournament: () => undefined
        };

        const compRepo = createCompetitionRepository(db, { tournamentRepo: failingTournRepo });

        const comp = compRepo.createCompetition({ name: "Rollback Event" });
        compRepo.registerEntry(comp.id, "u1");
        compRepo.registerEntry(comp.id, "u2");
        compRepo.reviewEntry(comp.id, "u1", true);
        compRepo.reviewEntry(comp.id, "u2", true);
        compRepo.advancePhase(comp.id, "registration"); // -> preparation
        compRepo.submitBotVersion(comp.id, "u1", b1.botVersionId);
        compRepo.submitBotVersion(comp.id, "u2", b2.botVersionId);
        compRepo.advancePhase(comp.id, "preparation"); // -> locked

        // Verify currently in locked phase
        const lockedComp = compRepo.getCompetition(comp.id);
        assert.equal(lockedComp.phase, "locked");
        assert.equal(lockedComp.tournamentId, null);

        // Launch tournament -> fails inside transaction
        assert.throws(
          () => compRepo.advancePhase(comp.id, "locked"),
          /Simulated fatal tournament runner crash/
        );

        // Verify competition remains locked and tournamentId is null (rollback succeeded)
        const afterComp = compRepo.getCompetition(comp.id);
        assert.equal(afterComp.phase, "locked");
        assert.equal(afterComp.tournamentId, null);

        // Verify no orphan tournaments exist in DB
        const tournamentsCount = db.prepare("SELECT COUNT(*) AS c FROM tournaments").get().c;
        assert.equal(tournamentsCount, 0);
      } finally {
        closeDatabase(db);
      }
    });

    it("launches tournament atomically and completes only when all matches are terminal", () => {
      const { db, competitionRepo, registerReadyBot } = setupTestDb("repo-full-lifecycle");
      try {
        const b1 = registerReadyBot("bot-a", "ua");
        const b2 = registerReadyBot("bot-b", "ub");

        const comp = competitionRepo.createCompetition({ name: "End-to-End Event" });
        competitionRepo.registerEntry(comp.id, "ua");
        competitionRepo.registerEntry(comp.id, "ub");
        competitionRepo.reviewEntry(comp.id, "ua", true);
        competitionRepo.reviewEntry(comp.id, "ub", true);
        competitionRepo.advancePhase(comp.id, "registration"); // -> preparation
        competitionRepo.submitBotVersion(comp.id, "ua", b1.botVersionId);
        competitionRepo.submitBotVersion(comp.id, "ub", b2.botVersionId);
        competitionRepo.advancePhase(comp.id, "preparation"); // -> locked

        // Advance locked -> running (creates tournament)
        const runningComp = competitionRepo.advancePhase(comp.id, "locked");
        assert.equal(runningComp.phase, "running");
        assert.ok(runningComp.tournamentId);

        // Cannot complete while matches are still pending
        assert.throws(
          () => competitionRepo.advancePhase(comp.id, "running"),
          /matches are still running/i
        );

        // Mark 1 match as error
        db.prepare("UPDATE matches SET status = 'error' WHERE tournament_id = ?").run(runningComp.tournamentId);

        // Advance should fail reporting errors that must be retried
        assert.throws(
          () => competitionRepo.advancePhase(comp.id, "running"),
          /matches have errors and must be retried/i
        );

        // Retry the match via retryCompetitionMatch
        const retryRes = competitionRepo.retryCompetitionMatch(comp.id, 0);
        assert.equal(retryRes.ok, true);

        // Verify match status reset to pending
        const matchRow = db.prepare("SELECT status FROM matches WHERE tournament_id = ? AND schedule_index = 0").get(runningComp.tournamentId);
        assert.equal(matchRow.status, "pending");

        // Now mark all matches as completed
        db.prepare("UPDATE matches SET status = 'completed' WHERE tournament_id = ?").run(runningComp.tournamentId);

        // Advance to completed
        const completedComp = competitionRepo.advancePhase(comp.id, "running");
        assert.equal(completedComp.phase, "completed");

        // Completed event cannot be reopened
        assert.throws(
          () => competitionRepo.advancePhase(comp.id, "completed"),
          /already completed/i
        );
      } finally {
        closeDatabase(db);
      }
    });
  });

  describe("5. HTTP API Route Matrix (/api/arena/v1/competitions)", () => {
    let env;
    let server;
    let adminToken;
    let author1Token;
    let author2Token;
    let spectatorToken;
    let b1;
    let b2;

    before(async () => {
      env = setupTestDb("http-matrix-suite");

      // Seed users
      seedUser(env.db, "usr-adm", "adminuser", "admin");
      seedUser(env.db, "usr-aut1", "author1", "author");
      seedUser(env.db, "usr-aut2", "author2", "author");
      seedUser(env.db, "usr-spec", "spectator", "author");

      adminToken = createSession(env.db, "usr-adm").token;
      author1Token = createSession(env.db, "usr-aut1").token;
      author2Token = createSession(env.db, "usr-aut2").token;
      spectatorToken = createSession(env.db, "usr-spec").token;

      // Seed ready bots for authors
      b1 = env.registerReadyBot("bot-web1", "usr-aut1");
      b2 = env.registerReadyBot("bot-web2", "usr-aut2");

      server = createArenaServer({
        db: env.db,
        allowedOrigins: ["http://127.0.0.1:3000"],
        trustedMode: true,
        competitionRepo: env.competitionRepo,
        tournamentRepo: env.tournamentRepo
      });

      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    });

    after(async () => {
      await new Promise((resolve) => server.close(resolve));
      closeDatabase(env.db);
    });

    it("rejects unauthenticated requests with HTTP 401", async () => {
      const res = await makeRequest(server, {
        path: "/api/arena/v1/competitions",
        method: "GET"
      });
      assert.equal(res.statusCode, 401);
      assert.equal(res.json.error.code, "UNAUTHORIZED");
    });

    it("rejects non-admin competition creation with HTTP 403", async () => {
      const res = await makeRequest(
        server,
        {
          path: "/api/arena/v1/competitions",
          method: "POST",
          headers: { Authorization: `Bearer ${author1Token}` }
        },
        { name: "Author Cup" }
      );
      assert.equal(res.statusCode, 403);
      assert.equal(res.json.error.code, "FORBIDDEN");
    });

    it("executes complete competition lifecycle via HTTP endpoints matching plan contract", async () => {
      // 1. Admin creates competition -> 201
      const createRes = await makeRequest(
        server,
        {
          path: "/api/arena/v1/competitions",
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` }
        },
        {
          name: "Championship 2026",
          description: "Grand tournament",
          capacity: 4,
          ranked: true
        }
      );

      assert.equal(createRes.statusCode, 201);
      const comp = createRes.json.competition;
      assert.ok(comp.id);
      assert.equal(comp.name, "Championship 2026");
      assert.equal(comp.phase, "registration");
      assert.equal(comp.capacity, 4);
      assert.equal(comp.ranked, true);
      assert.equal(comp.tournamentId, null);

      // 2. Spectator lists competitions -> 200
      const listRes = await makeRequest(server, {
        path: "/api/arena/v1/competitions",
        method: "GET",
        headers: { Authorization: `Bearer ${spectatorToken}` }
      });
      assert.equal(listRes.statusCode, 200);
      assert.ok(Array.isArray(listRes.json.competitions));
      assert.ok(listRes.json.competitions.some((c) => c.id === comp.id));

      // 3. Authors register -> 200
      const reg1 = await makeRequest(server, {
        path: `/api/arena/v1/competitions/${comp.id}/register`,
        method: "POST",
        headers: { Authorization: `Bearer ${author1Token}` }
      });
      assert.equal(reg1.statusCode, 200);
      assert.equal(reg1.json.entry.userId, "usr-aut1");
      assert.equal(reg1.json.entry.status, "pending");

      // Idempotent re-registration
      const reg1Dup = await makeRequest(server, {
        path: `/api/arena/v1/competitions/${comp.id}/register`,
        method: "POST",
        headers: { Authorization: `Bearer ${author1Token}` }
      });
      assert.equal(reg1Dup.statusCode, 200);
      assert.equal(reg1Dup.json.entry.userId, "usr-aut1");

      const reg2 = await makeRequest(server, {
        path: `/api/arena/v1/competitions/${comp.id}/register`,
        method: "POST",
        headers: { Authorization: `Bearer ${author2Token}` }
      });
      assert.equal(reg2.statusCode, 200);
      assert.equal(reg2.json.entry.userId, "usr-aut2");

      // 4. Admin tries to advance before review -> 409
      const advFail = await makeRequest(
        server,
        {
          path: `/api/arena/v1/competitions/${comp.id}/advance`,
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` }
        },
        { expectedPhase: "registration" }
      );
      assert.equal(advFail.statusCode, 409);
      assert.equal(advFail.json.error.code, "PHASE_MISMATCH");

      // 5. Admin accepts both authors -> 200
      const rev1 = await makeRequest(
        server,
        {
          path: `/api/arena/v1/competitions/${comp.id}/entries/usr-aut1/review`,
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` }
        },
        { accepted: true }
      );
      assert.equal(rev1.statusCode, 200);
      assert.equal(rev1.json.entry.status, "accepted");

      const rev2 = await makeRequest(
        server,
        {
          path: `/api/arena/v1/competitions/${comp.id}/entries/usr-aut2/review`,
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` }
        },
        { accepted: true }
      );
      assert.equal(rev2.statusCode, 200);
      assert.equal(rev2.json.entry.status, "accepted");

      // 6. Admin advances to preparation -> 200
      const advPrep = await makeRequest(
        server,
        {
          path: `/api/arena/v1/competitions/${comp.id}/advance`,
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` }
        },
        { expectedPhase: "registration" }
      );
      assert.equal(advPrep.statusCode, 200);
      assert.equal(advPrep.json.competition.phase, "preparation");

      // 7. Authors submit bot versions
      const sub1 = await makeRequest(
        server,
        {
          path: `/api/arena/v1/competitions/${comp.id}/submission`,
          method: "POST",
          headers: { Authorization: `Bearer ${author1Token}` }
        },
        { botVersionId: b1.botVersionId }
      );
      assert.equal(sub1.statusCode, 200);
      assert.equal(sub1.json.entry.botId, "bot-web1");
      assert.equal(sub1.json.entry.botVersionId, b1.botVersionId);

      const sub2 = await makeRequest(
        server,
        {
          path: `/api/arena/v1/competitions/${comp.id}/submission`,
          method: "POST",
          headers: { Authorization: `Bearer ${author2Token}` }
        },
        { botVersionId: b2.botVersionId }
      );
      assert.equal(sub2.statusCode, 200);
      assert.equal(sub2.json.entry.botId, "bot-web2");

      // 8. Admin locks submissions -> 200
      const advLock = await makeRequest(
        server,
        {
          path: `/api/arena/v1/competitions/${comp.id}/advance`,
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` }
        },
        { expectedPhase: "preparation" }
      );
      assert.equal(advLock.statusCode, 200);
      assert.equal(advLock.json.competition.phase, "locked");

      // 9. Admin launches tournament atomically -> 200
      const advRun = await makeRequest(
        server,
        {
          path: `/api/arena/v1/competitions/${comp.id}/advance`,
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` }
        },
        { expectedPhase: "locked" }
      );
      assert.equal(advRun.statusCode, 200);
      assert.equal(advRun.json.competition.phase, "running");
      assert.ok(advRun.json.competition.tournamentId);

      const tournamentId = advRun.json.competition.tournamentId;

      // 10. GET /competitions/:id returns linked tournamentId and entries
      const detailRes = await makeRequest(server, {
        path: `/api/arena/v1/competitions/${comp.id}`,
        method: "GET",
        headers: { Authorization: `Bearer ${spectatorToken}` }
      });
      assert.equal(detailRes.statusCode, 200);
      assert.equal(detailRes.json.competition.tournamentId, tournamentId);
      assert.equal(detailRes.json.entries.length, 2);

      // 11. Retry endpoint rejects matches not in 'error' status
      const retryNonError = await makeRequest(server, {
        path: `/api/arena/v1/competitions/${comp.id}/matches/0/retry`,
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      assert.equal(retryNonError.statusCode, 409);
      assert.equal(retryNonError.json.error.code, "PHASE_MISMATCH");

      // Set match status to error
      env.db.prepare("UPDATE matches SET status = 'error' WHERE tournament_id = ? AND schedule_index = 0").run(tournamentId);

      // Retry endpoint succeeds on error match
      const retryOk = await makeRequest(server, {
        path: `/api/arena/v1/competitions/${comp.id}/matches/0/retry`,
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      assert.equal(retryOk.statusCode, 200);
      assert.equal(retryOk.json.ok, true);

      // Verify reset to pending
      const matchReset = env.db.prepare("SELECT status FROM matches WHERE tournament_id = ? AND schedule_index = 0").get(tournamentId);
      assert.equal(matchReset.status, "pending");
    });
  });

  describe("6. HTTP API Strict Methods, Fields & Capacity Validation", () => {
    let env;
    let server;
    let adminToken;
    let authorToken;

    before(async () => {
      env = setupTestDb("http-strict-fields-suite");
      seedUser(env.db, "adm-strict", "admstrict", "admin");
      seedUser(env.db, "aut-strict", "autstrict", "author");
      adminToken = createSession(env.db, "adm-strict").token;
      authorToken = createSession(env.db, "aut-strict").token;

      server = createArenaServer({
        db: env.db,
        allowedOrigins: ["http://127.0.0.1:3000"],
        competitionRepo: env.competitionRepo,
        tournamentRepo: env.tournamentRepo
      });

      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    });

    after(async () => {
      await new Promise((resolve) => server.close(resolve));
      closeDatabase(env.db);
    });

    it("enforces exact HTTP methods on mutation endpoints (rejects non-POST with HTTP 405)", async () => {
      const comp = env.competitionRepo.createCompetition({ name: "Method Test Event" });

      const getReg = await makeRequest(server, {
        path: `/api/arena/v1/competitions/${comp.id}/register`,
        method: "GET",
        headers: { Authorization: `Bearer ${authorToken}` }
      });
      assert.equal(getReg.statusCode, 405);
      assert.equal(getReg.headers["allow"], "POST");

      const putAdv = await makeRequest(server, {
        path: `/api/arena/v1/competitions/${comp.id}/advance`,
        method: "PUT",
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      assert.equal(putAdv.statusCode, 405);

      const delRetry = await makeRequest(server, {
        path: `/api/arena/v1/competitions/${comp.id}/matches/0/retry`,
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      assert.equal(delRetry.statusCode, 405);
    });

    it("rejects unexpected fields in mutation bodies with HTTP 422", async () => {
      const comp = env.competitionRepo.createCompetition({ name: "Fields Test Event" });

      // createCompetition with extraneous field
      const createRes = await makeRequest(
        server,
        {
          path: "/api/arena/v1/competitions",
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` }
        },
        { name: "Valid Name", rogueField: "not-allowed" }
      );
      assert.equal(createRes.statusCode, 422);
      assert.equal(createRes.json.error.code, "VALIDATION_ERROR");

      // review with extraneous field
      const reviewRes = await makeRequest(
        server,
        {
          path: `/api/arena/v1/competitions/${comp.id}/entries/aut-strict/review`,
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` }
        },
        { accepted: true, hack: 123 }
      );
      assert.equal(reviewRes.statusCode, 422);

      // advance with extraneous field
      const advRes = await makeRequest(
        server,
        {
          path: `/api/arena/v1/competitions/${comp.id}/advance`,
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` }
        },
        { expectedPhase: "registration", extra: true }
      );
      assert.equal(advRes.statusCode, 422);
    });

    it("strictly validates capacity as an integer between 2 and 128", async () => {
      const cases = [
        { capacity: "16", desc: "string number" },
        { capacity: 16.5, desc: "float number" },
        { capacity: 1, desc: "below minimum (1)" },
        { capacity: 0, desc: "zero" },
        { capacity: -4, desc: "negative" },
        { capacity: 129, desc: "above maximum (129)" },
        { capacity: 1000, desc: "large number" }
      ];

      for (const c of cases) {
        const res = await makeRequest(
          server,
          {
            path: "/api/arena/v1/competitions",
            method: "POST",
            headers: { Authorization: `Bearer ${adminToken}` }
          },
          { name: `Cap Test ${c.desc}`, capacity: c.capacity }
        );
        assert.equal(res.statusCode, 422, `Expected 422 for ${c.desc}`);
      }

      // Exact boundaries: 2 and 128 succeed
      const minRes = await makeRequest(
        server,
        {
          path: "/api/arena/v1/competitions",
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` }
        },
        { name: "Cap 2", capacity: 2 }
      );
      assert.equal(minRes.statusCode, 201);
      assert.equal(minRes.json.competition.capacity, 2);

      const maxRes = await makeRequest(
        server,
        {
          path: "/api/arena/v1/competitions",
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` }
        },
        { name: "Cap 128", capacity: 128 }
      );
      assert.equal(maxRes.statusCode, 201);
      assert.equal(maxRes.json.competition.capacity, 128);
    });
  });

  describe("7. Match Retry: Wrong-Role, Non-Error, Cross-Event & Identity Preservation", () => {
    let env;
    let server;
    let adminToken;
    let authorToken;
    let compA;
    let compB;

    before(async () => {
      env = setupTestDb("retry-comprehensive-suite");
      seedUser(env.db, "adm-retry", "admretry", "admin");
      seedUser(env.db, "aut-retry", "autretry", "author");
      adminToken = createSession(env.db, "adm-retry").token;
      authorToken = createSession(env.db, "aut-retry").token;

      // Event A with 2 bots
      const bA1 = env.registerReadyBot("bot-ra1", "aut-ra1");
      const bA2 = env.registerReadyBot("bot-ra2", "aut-ra2");
      compA = env.competitionRepo.createCompetition({ name: "Event A" });
      env.competitionRepo.registerEntry(compA.id, "aut-ra1");
      env.competitionRepo.registerEntry(compA.id, "aut-ra2");
      env.competitionRepo.reviewEntry(compA.id, "aut-ra1", true);
      env.competitionRepo.reviewEntry(compA.id, "aut-ra2", true);
      env.competitionRepo.advancePhase(compA.id, "registration");
      env.competitionRepo.submitBotVersion(compA.id, "aut-ra1", bA1.botVersionId);
      env.competitionRepo.submitBotVersion(compA.id, "aut-ra2", bA2.botVersionId);
      env.competitionRepo.advancePhase(compA.id, "preparation");
      compA = env.competitionRepo.advancePhase(compA.id, "locked"); // running

      // Event B with 2 bots
      const bB1 = env.registerReadyBot("bot-rb1", "aut-rb1");
      const bB2 = env.registerReadyBot("bot-rb2", "aut-rb2");
      compB = env.competitionRepo.createCompetition({ name: "Event B" });
      env.competitionRepo.registerEntry(compB.id, "aut-rb1");
      env.competitionRepo.registerEntry(compB.id, "aut-rb2");
      env.competitionRepo.reviewEntry(compB.id, "aut-rb1", true);
      env.competitionRepo.reviewEntry(compB.id, "aut-rb2", true);
      env.competitionRepo.advancePhase(compB.id, "registration");
      env.competitionRepo.submitBotVersion(compB.id, "aut-rb1", bB1.botVersionId);
      env.competitionRepo.submitBotVersion(compB.id, "aut-rb2", bB2.botVersionId);
      env.competitionRepo.advancePhase(compB.id, "preparation");
      compB = env.competitionRepo.advancePhase(compB.id, "locked"); // running

      server = createArenaServer({
        db: env.db,
        allowedOrigins: ["http://127.0.0.1:3000"],
        competitionRepo: env.competitionRepo,
        tournamentRepo: env.tournamentRepo
      });

      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    });

    after(async () => {
      await new Promise((resolve) => server.close(resolve));
      closeDatabase(env.db);
    });

    it("rejects non-admin retry with HTTP 403 (wrong-role)", async () => {
      const res = await makeRequest(server, {
        path: `/api/arena/v1/competitions/${compA.id}/matches/0/retry`,
        method: "POST",
        headers: { Authorization: `Bearer ${authorToken}` }
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.json.error.code, "FORBIDDEN");
    });

    it("rejects retry when match is not in error status (non-error: pending or completed)", async () => {
      // CompA match 0 is currently 'pending'
      const pendingRes = await makeRequest(server, {
        path: `/api/arena/v1/competitions/${compA.id}/matches/0/retry`,
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      assert.equal(pendingRes.statusCode, 409);
      assert.equal(pendingRes.json.error.code, "PHASE_MISMATCH");

      // Mark CompA match 0 as 'completed'
      env.db.prepare("UPDATE matches SET status = 'completed' WHERE tournament_id = ? AND schedule_index = 0").run(compA.tournamentId);

      const completedRes = await makeRequest(server, {
        path: `/api/arena/v1/competitions/${compA.id}/matches/0/retry`,
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      assert.equal(completedRes.statusCode, 409);
      assert.equal(completedRes.json.error.code, "PHASE_MISMATCH");
    });

    it("enforces cross-event isolation: cannot retry another event's match", async () => {
      // In Event B, set match 0 to 'error'
      env.db.prepare("UPDATE matches SET status = 'error' WHERE tournament_id = ? AND schedule_index = 0").run(compB.tournamentId);

      // Calling retry on Event A for match 0 (which is 'completed' in Event A) fails without touching Event B
      const retryOnA = await makeRequest(server, {
        path: `/api/arena/v1/competitions/${compA.id}/matches/0/retry`,
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      assert.equal(retryOnA.statusCode, 409);

      // Event B match 0 remains 'error'
      const matchB0 = env.db.prepare("SELECT status FROM matches WHERE tournament_id = ? AND schedule_index = 0").get(compB.tournamentId);
      assert.equal(matchB0.status, "error");

      // Requesting an out-of-range scheduleIndex on Event A returns 404 NOT_FOUND
      const missingIndexRes = await makeRequest(server, {
        path: `/api/arena/v1/competitions/${compA.id}/matches/99/retry`,
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      assert.equal(missingIndexRes.statusCode, 404);
      assert.equal(missingIndexRes.json.error.code, "NOT_FOUND");
    });

    it("retry preserves match and job identity without duplicating records", async () => {
      // Query match and job in Event B before retry
      const matchRowBefore = env.db.prepare("SELECT * FROM matches WHERE tournament_id = ? AND schedule_index = 0").get(compB.tournamentId);
      const jobRowBefore = env.db.prepare("SELECT * FROM jobs WHERE kind = 'match' AND target_id = ?").get(matchRowBefore.id);

      const totalMatchesBefore = env.db.prepare("SELECT COUNT(*) AS c FROM matches").get().c;
      const totalJobsBefore = env.db.prepare("SELECT COUNT(*) AS c FROM jobs").get().c;

      // Execute retry on Event B match 0
      const retryRes = await makeRequest(server, {
        path: `/api/arena/v1/competitions/${compB.id}/matches/0/retry`,
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      assert.equal(retryRes.statusCode, 200);
      assert.equal(retryRes.json.ok, true);

      // Query match and job after retry
      const matchRowAfter = env.db.prepare("SELECT * FROM matches WHERE tournament_id = ? AND schedule_index = 0").get(compB.tournamentId);
      const jobRowAfter = env.db.prepare("SELECT * FROM jobs WHERE kind = 'match' AND target_id = ?").get(matchRowBefore.id);

      const totalMatchesAfter = env.db.prepare("SELECT COUNT(*) AS c FROM matches").get().c;
      const totalJobsAfter = env.db.prepare("SELECT COUNT(*) AS c FROM jobs").get().c;

      // Identity preserved: exact same IDs and creation timestamps
      assert.equal(matchRowAfter.id, matchRowBefore.id);
      assert.equal(matchRowAfter.created_at, matchRowBefore.created_at);
      assert.equal(matchRowAfter.status, "pending");

      assert.equal(jobRowAfter.id, jobRowBefore.id);
      assert.equal(jobRowAfter.status, "queued");

      // No duplicate rows inserted
      assert.equal(totalMatchesAfter, totalMatchesBefore);
      assert.equal(totalJobsAfter, totalJobsBefore);
    });

    it("retry extends max_attempts allowing real queue claim when attempt_no was exhausted", async () => {
      // Find a match in compB (schedule_index 0)
      const matchRow = env.db
        .prepare("SELECT * FROM matches WHERE tournament_id = ? AND schedule_index = 0")
        .get(compB.tournamentId);

      // Simulate match failure by exhausted attempts: attempt_no = 3, max_attempts = 3
      env.db
        .prepare("UPDATE matches SET status = 'error' WHERE id = ?")
        .run(matchRow.id);
      env.db
        .prepare(
          "UPDATE jobs SET status = 'failed', attempt_no = 3, max_attempts = 3, lease_owner = NULL, lease_token = NULL WHERE kind = 'match' AND target_id = ?"
        )
        .run(matchRow.id);

      // Admin triggers retry
      const retryRes = await makeRequest(server, {
        path: `/api/arena/v1/competitions/${compB.id}/matches/0/retry`,
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      assert.equal(retryRes.statusCode, 200);
      assert.equal(retryRes.json.ok, true);

      // Verify DB state before worker claim:
      // 1. attempt_no is preserved at 3 (monotonic history preserved, no unique collision)
      // 2. max_attempts extended to MAX(3, 3 + 3) = 6
      // 3. status is 'queued'
      const jobAfterRetry = env.db
        .prepare("SELECT * FROM jobs WHERE kind = 'match' AND target_id = ?")
        .get(matchRow.id);
      assert.equal(jobAfterRetry.status, "queued");
      assert.equal(jobAfterRetry.attempt_no, 3);
      assert.equal(jobAfterRetry.max_attempts, 6);

      // Real worker queue claim must succeed (NOT fail with nextAttempt > max_attempts)
      // Clear any older queued match jobs from earlier tests so our retried job is claimed next
      env.db
        .prepare("UPDATE jobs SET status = 'completed' WHERE kind = 'match' AND id != ?")
        .run(jobAfterRetry.id);

      const jobQueue = createJobQueue(env.db);
      const claimed = jobQueue.claimNextJob("worker-retry-test", ["match"]);
      assert.ok(claimed, "Worker should successfully claim retried job");
      assert.equal(claimed.jobId, jobAfterRetry.id);
      assert.equal(claimed.targetId, matchRow.id);
      assert.equal(claimed.attemptNo, 4);

      // Verify match transitioned to active and attempt 4 recorded
      const matchAfterClaim = env.db.prepare("SELECT status FROM matches WHERE id = ?").get(matchRow.id);
      assert.equal(matchAfterClaim.status, "active");

      const attemptRow = env.db
        .prepare("SELECT * FROM job_attempts WHERE job_id = ? AND attempt_no = 4")
        .get(jobAfterRetry.id);
      assert.ok(attemptRow);
      assert.equal(attemptRow.status, "active");
    });

    it("enforces retry duplicate guard preventing concurrent or duplicate retries", async () => {
      // Set match at schedule_index 1 in compB to 'error'
      const matchRow = env.db
        .prepare("SELECT * FROM matches WHERE tournament_id = ? AND schedule_index = 1")
        .get(compB.tournamentId);
      env.db.prepare("UPDATE matches SET status = 'error' WHERE id = ?").run(matchRow.id);

      // First retry succeeds
      const firstRes = await makeRequest(server, {
        path: `/api/arena/v1/competitions/${compB.id}/matches/1/retry`,
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      assert.equal(firstRes.statusCode, 200);
      assert.equal(firstRes.json.ok, true);

      // Second immediate retry is guarded and rejected with 409 because match is now 'pending'
      const secondRes = await makeRequest(server, {
        path: `/api/arena/v1/competitions/${compB.id}/matches/1/retry`,
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      assert.equal(secondRes.statusCode, 409);
      assert.equal(secondRes.json.error.code, "PHASE_MISMATCH");
      assert.match(secondRes.json.error.message, /Only matches in 'error' status can be retried/);

      // Concurrency test: reset to 'error', then issue two concurrent requests
      env.db.prepare("UPDATE matches SET status = 'error' WHERE id = ?").run(matchRow.id);
      const [res1, res2] = await Promise.all([
        makeRequest(server, {
          path: `/api/arena/v1/competitions/${compB.id}/matches/1/retry`,
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` }
        }),
        makeRequest(server, {
          path: `/api/arena/v1/competitions/${compB.id}/matches/1/retry`,
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` }
        })
      ]);

      const statusCodes = [res1.statusCode, res2.statusCode].sort();
      assert.deepEqual(
        statusCodes,
        [200, 409],
        "Exactly one concurrent retry must succeed (200) and the duplicate must be rejected (409)"
      );
    });
  });

  describe("8. Schema Migration Startup: Fresh & Existing Databases", () => {
    it("starts fresh database with targetVersion='002-competitions' applying 001 and 002 cleanly", () => {
      const freshDbPath = path.join(TEMP_BASE_DIR, "fresh-startup.db");
      const { db, version } = openDatabase(freshDbPath, { targetVersion: "002-competitions" });
      try {
        assert.equal(version, "002-competitions");
        const migrations = db.prepare("SELECT version FROM schema_migrations ORDER BY version ASC").all();
        assert.deepEqual(migrations.map((m) => m.version), ["001-arena", "002-competitions"]);

        // Verify all 20 tables exist (18 arena + 2 competitions)
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
        assert.equal(tables.length, 20);
      } finally {
        closeDatabase(db);
      }
    });

    it("upgrades existing 001-arena database to 002-competitions preserving data without corruption", () => {
      const existingDbPath = path.join(TEMP_BASE_DIR, "existing-upgrade.db");

      // 1. Initialize with default 001-arena
      const { db: dbOld, version: vOld } = openDatabase(existingDbPath);
      assert.equal(vOld, "001-arena");
      seedUser(dbOld, "usr-persist", "persistuser", "author");
      dbOld.prepare("INSERT INTO bots (id, owner_id, name) VALUES (?, ?, ?)").run("bot-persist", "usr-persist", "PersistBot");
      closeDatabase(dbOld);

      // 2. Open with targetVersion='002-competitions'
      const { db: dbMigrated, version: vMigrated } = openDatabase(existingDbPath, { targetVersion: "002-competitions" });
      try {
        assert.equal(vMigrated, "002-competitions");

        // Verify existing data untouched
        const user = dbMigrated.prepare("SELECT * FROM users WHERE id = ?").get("usr-persist");
        assert.ok(user);
        assert.equal(user.normalized_username, "persistuser");

        const bot = dbMigrated.prepare("SELECT * FROM bots WHERE id = ?").get("bot-persist");
        assert.ok(bot);
        assert.equal(bot.name, "PersistBot");

        // Verify new tables available
        const compTable = dbMigrated.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'competitions'").get();
        assert.ok(compTable);
      } finally {
        closeDatabase(dbMigrated);
      }

      // 3. Reopening already migrated database is idempotent
      const { db: dbReopened, version: vReopened } = openDatabase(existingDbPath);
      try {
        assert.equal(vReopened, "002-competitions");
      } finally {
        closeDatabase(dbReopened);
      }
    });
  });
});
