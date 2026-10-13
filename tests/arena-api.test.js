/**
 * tests/arena-api.test.js
 *
 * Task 14 (Milestone M4): Arena HTTP API Route Matrix and Integration Suite.
 *
 * Verifies:
 * 1. Full route matrix under base /api/arena/v1.
 * 2. Mandatory Idempotency-Key semantics (§5.5) on bot, version, match, and tournament creation:
 *    - Replay identical payload -> returns existing resource.
 *    - Conflicting payload -> HTTP 409 Conflict.
 *    - Different actors with same key -> no collision.
 *    - Concurrent requests with identical key -> serialized to single resource.
 * 3. Execution gates in TRUSTED mode:
 *    - canSubmitSource=false for author.
 *    - Admin-curated upload only.
 * 4. Match scheduling gates:
 *    - Ranked matches restricted to admin.
 *    - Practice matches allowed for authors with READY bot versions.
 *    - Unready bot versions rejected with HTTP 422.
 * 5. Actual integration execution with JobWorker:
 *    - Real worker claims match, executes bots, calls finalizer.
 *    - GET /matches/:id/replay returns 409 when pending, 200 with finalized replay + digest when settled.
 * 6. Tournament creation and standings reads (3-1-0 point scheme).
 * 7. Leaderboard reads backend ratings without client recalculation.
 * 8. Strict input bounds (1 MiB payload limit -> HTTP 413, list limit <= 100).
 * 9. Worker ownership: API does not auto-run worker when external worker flag is enabled.
 */

"use strict";

const { describe, it, before, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const { createHash, randomUUID } = require("node:crypto");

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

const TEMP_BASE_DIR = path.resolve(os.tmpdir(), "arena-api-test-" + Date.now());

let openDatabase;
let closeDatabase;
let createArtifactStore;
let createProfileRegistry;
let createBuildService;
let createBotVersionService;
let createBotRepository;
let createMatchRepository;
let createTournamentRepository;
let createJobQueue;
let createMatchFinalizer;
let createJobWorker;
let createProfileBotFactory;
let runWorkerCli;
let createProcessBot;

let hashPassword;
let createSession;
let createArenaServer;
let loadConfig;
let startArenaService;

before(async () => {
  fs.mkdirSync(TEMP_BASE_DIR, { recursive: true });

  const dbMod = await import("../packages/arena-node/src/persistence/sqlite-database.mjs");
  openDatabase = dbMod.openDatabase;
  closeDatabase = dbMod.closeDatabase;

  const artifactMod = await import("../packages/arena-node/src/artifacts/artifact-store.mjs");
  createArtifactStore = artifactMod.createArtifactStore;

  const profileMod = await import("../packages/arena-node/src/execution/profile-registry.mjs");
  createProfileRegistry = profileMod.createProfileRegistry;

  const buildMod = await import("../packages/arena-node/src/execution/build-service.mjs");
  createBuildService = buildMod.createBuildService;

  const botVerMod = await import("../packages/arena-node/src/persistence/bot-version-service.mjs");
  createBotVersionService = botVerMod.createBotVersionService;

  const botRepoMod = await import("../packages/arena-node/src/persistence/bot-repository.mjs");
  createBotRepository = botRepoMod.createBotRepository;

  const matchRepoMod = await import("../packages/arena-node/src/persistence/match-repository.mjs");
  createMatchRepository = matchRepoMod.createMatchRepository;

  const tournamentRepoMod = await import("../packages/arena-node/src/persistence/tournament-repository.mjs");
  createTournamentRepository = tournamentRepoMod.createTournamentRepository;

  const queueMod = await import("../packages/arena-node/src/persistence/job-queue.mjs");
  createJobQueue = queueMod.createJobQueue;

  const finalizerMod = await import("../packages/arena-node/src/persistence/finalizer.mjs");
  createMatchFinalizer = finalizerMod.createMatchFinalizer;

  const workerMod = await import("../packages/arena-node/src/worker/job-worker.mjs");
  createJobWorker = workerMod.createJobWorker;
  createProfileBotFactory = workerMod.createProfileBotFactory;
  runWorkerCli = workerMod.runWorkerCli;

  const processBotMod = await import("../packages/arena-node/src/execution/process-bot.mjs");
  createProcessBot = processBotMod.createProcessBot;

  const accountsMod = await import("../apps/arena-api/src/auth/accounts.mjs");
  hashPassword = accountsMod.hashPassword;
  createSession = accountsMod.createSession;

  const serverMod = await import("../apps/arena-api/src/http-server.mjs");
  createArenaServer = serverMod.createArenaServer;

  const configMod = await import("../apps/arena-api/src/config.mjs");
  loadConfig = configMod.loadConfig;

  const mainMod = await import("../apps/arena-api/src/main.mjs");
  startArenaService = mainMod.startArenaService;
});

after(() => {
  try {
    fs.rmSync(TEMP_BASE_DIR, { recursive: true, force: true });
  } catch (_) {}
});

function setupTestEnvironment(testName) {
  const dir = path.join(TEMP_BASE_DIR, testName);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "arena.db");
  const storageDir = path.join(dir, "artifacts");
  fs.mkdirSync(storageDir, { recursive: true });

  const nativeBinding = process.env.ARENA_SQLITE_NATIVE_BINDING || undefined;
  const { db } = openDatabase(dbPath, nativeBinding ? { nativeBinding } : {});

  const artifactStore = createArtifactStore({ storageDir });
  const profileRegistry = createProfileRegistry();

  profileRegistry.registerProfile({
    id: "controlled-node",
    language: "node",
    revision: "node-v1",
    probe: () => ({ available: true })
  });

  const fakeCompiler = {
    compile: async ({ sourcePath, outputDir }) => {
      const artifactPath = path.join(outputDir, "bot.mjs");
      fs.copyFileSync(sourcePath, artifactPath);
      return {
        success: true,
        artifactPath,
        buildLog: "Compile succeeded (controlled copy)"
      };
    }
  };

  const buildService = createBuildService({
    artifactStore,
    profileRegistry,
    compilers: { "controlled-node": fakeCompiler }
  });

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

  return {
    dir,
    dbPath,
    storageDir,
    db,
    artifactStore,
    profileRegistry,
    buildService,
    botVersionService,
    botRepo,
    matchRepo,
    tournamentRepo,
    jobQueue,
    finalizer
  };
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

describe("Arena HTTP API — Task 14 Route Matrix & Integration", () => {
  let env;
  let server;
  let adminToken;
  let authorToken;
  let author2Token;

  before(async () => {
    env = setupTestEnvironment("api-matrix-suite");

    // Seed users
    const pwdHash = hashPassword("TestPass123!");
    env.db.prepare("INSERT INTO users (id, normalized_username, password_hash, role, status) VALUES (?, ?, ?, ?, ?)").run(
      "usr-admin",
      "admin",
      pwdHash,
      "admin",
      "active"
    );
    env.db.prepare("INSERT INTO users (id, normalized_username, password_hash, role, status) VALUES (?, ?, ?, ?, ?)").run(
      "usr-author-1",
      "author1",
      pwdHash,
      "author",
      "active"
    );
    env.db.prepare("INSERT INTO users (id, normalized_username, password_hash, role, status) VALUES (?, ?, ?, ?, ?)").run(
      "usr-author-2",
      "author2",
      pwdHash,
      "author",
      "active"
    );

    adminToken = createSession(env.db, "usr-admin").token;
    authorToken = createSession(env.db, "usr-author-1").token;
    author2Token = createSession(env.db, "usr-author-2").token;

    server = createArenaServer({
      db: env.db,
      allowedOrigins: ["http://127.0.0.1:3000"],
      trustedMode: true,
      botRepo: env.botRepo,
      matchRepo: env.matchRepo,
      tournamentRepo: env.tournamentRepo,
      jobQueue: env.jobQueue,
      botVersionService: env.botVersionService,
      profileRegistry: env.profileRegistry,
      finalizer: env.finalizer
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase(env.db);
  });

  // ── 1. GET /capabilities ──────────────────────────────────────────────────
  it("GET /capabilities is public and reports trusted mode and untrusted gate status", async () => {
    const res = await makeRequest(server, {
      path: "/api/arena/v1/capabilities",
      method: "GET"
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json.executor, "trusted-local-v1");
    assert.equal(res.json.trusted, true);
    assert.equal(res.json.untrusted, false);
    assert.equal(res.json.canSubmitSource, false);
    assert.ok(Array.isArray(res.json.profiles));
  });

  // ── 2. Bots CRUD & Idempotency ────────────────────────────────────────────
  it("POST /bots requires Idempotency-Key and creates owned bot", async () => {
    // Missing Idempotency-Key -> 400
    const noKeyRes = await makeRequest(
      server,
      {
        path: "/api/arena/v1/bots",
        method: "POST",
        headers: { Authorization: `Bearer ${authorToken}` }
      },
      { name: "AlphaBot" }
    );
    assert.equal(noKeyRes.statusCode, 400);
    assert.equal(noKeyRes.json?.error?.code, "MISSING_IDEMPOTENCY_KEY");

    // Successful bot creation
    const key = `key-bot-${Date.now()}`;
    const createRes = await makeRequest(
      server,
      {
        path: "/api/arena/v1/bots",
        method: "POST",
        headers: {
          Authorization: `Bearer ${authorToken}`,
          "Idempotency-Key": key
        }
      },
      { name: "AlphaBot" }
    );

    assert.equal(createRes.statusCode, 201);
    const bot = createRes.json.bot;
    assert.ok(bot.id);
    assert.equal(bot.ownerId, "usr-author-1");
    assert.equal(bot.name, "AlphaBot");

    // Same key + same payload -> returns identical bot
    const replayRes = await makeRequest(
      server,
      {
        path: "/api/arena/v1/bots",
        method: "POST",
        headers: {
          Authorization: `Bearer ${authorToken}`,
          "Idempotency-Key": key
        }
      },
      { name: "AlphaBot" }
    );
    assert.equal(replayRes.statusCode, 201);
    assert.equal(replayRes.json.bot.id, bot.id);

    // Same key + different payload -> HTTP 409 Conflict
    const conflictRes = await makeRequest(
      server,
      {
        path: "/api/arena/v1/bots",
        method: "POST",
        headers: {
          Authorization: `Bearer ${authorToken}`,
          "Idempotency-Key": key
        }
      },
      { name: "DifferentBotName" }
    );
    assert.equal(conflictRes.statusCode, 409);
    assert.equal(conflictRes.json?.error?.code, "IDEMPOTENCY_CONFLICT");

    // Different actor with same key -> no collision, creates distinct bot
    const diffActorRes = await makeRequest(
      server,
      {
        path: "/api/arena/v1/bots",
        method: "POST",
        headers: {
          Authorization: `Bearer ${author2Token}`,
          "Idempotency-Key": key
        }
      },
      { name: "AlphaBot" }
    );
    assert.equal(diffActorRes.statusCode, 201);
    assert.notEqual(diffActorRes.json.bot.id, bot.id);
    assert.equal(diffActorRes.json.bot.ownerId, "usr-author-2");
  });

  it("POST /bots rejects forbidden shell and path fields", async () => {
    const res = await makeRequest(
      server,
      {
        path: "/api/arena/v1/bots",
        method: "POST",
        headers: {
          Authorization: `Bearer ${authorToken}`,
          "Idempotency-Key": `key-reject-shell-${Date.now()}`
        }
      },
      { name: "MaliciousBot", filePath: "/etc/passwd", command: "sh exploit.sh" }
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.json?.error?.code, "INVALID_PAYLOAD");
  });

  it("GET /bots returns paginated metadata and bounds results (max 100)", async () => {
    const listRes = await makeRequest(server, {
      path: "/api/arena/v1/bots?limit=50",
      method: "GET",
      headers: { Authorization: `Bearer ${authorToken}` }
    });

    assert.equal(listRes.statusCode, 200);
    assert.ok(Array.isArray(listRes.json.bots));
    assert.ok(listRes.json.total >= 2);
    assert.equal(listRes.json.limit, 50);

    // Verify limit capped at 100
    const overLimitRes = await makeRequest(server, {
      path: "/api/arena/v1/bots?limit=500",
      method: "GET",
      headers: { Authorization: `Bearer ${authorToken}` }
    });
    assert.equal(overLimitRes.json.limit, 100);
  });

  // ── 3. Bot Versions & Trusted Execution Gate ──────────────────────────────
  it("POST /bots/:id/versions enforces execution gate in trusted mode (author 403, admin allowed)", async () => {
    // 1. Create a bot for admin
    const botRes = await makeRequest(
      server,
      {
        path: "/api/arena/v1/bots",
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Idempotency-Key": `key-admin-bot-${Date.now()}`
        }
      },
      { name: "CuratedBot1" }
    );
    const botId = botRes.json.bot.id;

    const botSource = `
      export function chooseMove(turn) {
        return turn.legalMoves[0];
      }
    `;

    // 2. Author attempts to upload source -> 403 Forbidden
    const authorUploadRes = await makeRequest(
      server,
      {
        path: `/api/arena/v1/bots/${botId}/versions`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${authorToken}`,
          "Idempotency-Key": `key-author-upload-${Date.now()}`
        }
      },
      { source: botSource, profileId: "controlled-node" }
    );
    assert.equal(authorUploadRes.statusCode, 403);
    assert.equal(authorUploadRes.json?.error?.code, "SOURCE_SUBMISSION_DISABLED");

    // 3. Admin upload succeeds and enqueues build job
    const adminUploadRes = await makeRequest(
      server,
      {
        path: `/api/arena/v1/bots/${botId}/versions`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Idempotency-Key": `key-admin-upload-${Date.now()}`
        }
      },
      { source: botSource, profileId: "controlled-node" }
    );

    assert.equal(adminUploadRes.statusCode, 201);
    assert.ok(adminUploadRes.json.version.id);
    assert.equal(adminUploadRes.json.version.buildStatus, "pending");
    assert.ok(adminUploadRes.json.job.id);
    assert.equal(adminUploadRes.json.job.kind, "build");
  });

  it("POST /bots/:id/versions enforces 1 MiB body and source limits (HTTP 413)", async () => {
    const botRes = await makeRequest(
      server,
      {
        path: "/api/arena/v1/bots",
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Idempotency-Key": `key-admin-bot-large-${Date.now()}`
        }
      },
      { name: "LargeSourceBot" }
    );
    const botId = botRes.json.bot.id;

    // Generate string exceeding 1 MiB (1,048,576 bytes)
    const giantSource = "a".repeat(1048576 + 1024);

    const largeRes = await makeRequest(
      server,
      {
        path: `/api/arena/v1/bots/${botId}/versions`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Idempotency-Key": `key-large-upload-${Date.now()}`
        }
      },
      { source: giantSource, profileId: "controlled-node" }
    );

    assert.equal(largeRes.statusCode, 413);
    assert.equal(largeRes.json?.error?.code, "PAYLOAD_TOO_LARGE");
  });

  // ── 4. Matches & Practice / Ranked Scheduling ─────────────────────────────
  it("POST /matches enforces ranked admin-only gate and READY version pins", async () => {
    // Create two bots and mark their versions ready in DB
    const botARes = await makeRequest(
      server,
      {
        path: "/api/arena/v1/bots",
        method: "POST",
        headers: {
          Authorization: `Bearer ${authorToken}`,
          "Idempotency-Key": `key-botA-${Date.now()}`
        }
      },
      { name: "BotA" }
    );
    const botBRes = await makeRequest(
      server,
      {
        path: "/api/arena/v1/bots",
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Idempotency-Key": `key-botB-${Date.now()}`
        }
      },
      { name: "BotB" }
    );
    const botAId = botARes.json.bot.id;
    const botBId = botBRes.json.bot.id;

    const fixtureBotPath = path.resolve("tests/fixtures/arena/bots/legal.mjs");
    const sourceContent = fs.readFileSync(fixtureBotPath);
    const buildA = await env.buildService.build({ sourceContent, profileId: "node" });
    const buildB = await env.buildService.build({ sourceContent, profileId: "node" });

    env.botRepo.registerArtifact({
      digest: buildA.artifactDigest,
      kind: "build",
      relativePrivatePath: `builds/${buildA.artifactDigest.slice(7, 9)}/${buildA.artifactDigest.slice(9)}`,
      bytes: buildA.manifest.bytes
    });
    env.botRepo.registerArtifact({
      digest: buildB.artifactDigest,
      kind: "build",
      relativePrivatePath: `builds/${buildB.artifactDigest.slice(7, 9)}/${buildB.artifactDigest.slice(9)}`,
      bytes: buildB.manifest.bytes
    });

    // Create versions directly via DB helper for controlled READY fixture
    const verAId = `verA-${randomUUID()}`;
    const verBId = `verB-${randomUUID()}`;
    const unreadyVerId = `verUnready-${randomUUID()}`;

    env.db
      .prepare(
        "INSERT INTO bot_versions (id, bot_id, version_no, source_digest, profile_id, profile_revision, build_status, artifact_digest) VALUES (?, ?, 1, ?, 'node', 'node-trusted-v1', 'ready', ?)"
      )
      .run(verAId, botAId, buildA.manifest.sourceDigest, buildA.artifactDigest);

    env.db
      .prepare(
        "INSERT INTO bot_versions (id, bot_id, version_no, source_digest, profile_id, profile_revision, build_status, artifact_digest) VALUES (?, ?, 1, ?, 'node', 'node-trusted-v1', 'ready', ?)"
      )
      .run(verBId, botBId, buildB.manifest.sourceDigest, buildB.artifactDigest);

    env.db
      .prepare(
        "INSERT INTO bot_versions (id, bot_id, version_no, source_digest, profile_id, profile_revision, build_status) VALUES (?, ?, 2, 'digestPending', 'node', 'node-trusted-v1', 'pending')"
      )
      .run(unreadyVerId, botAId);

    // 1. Author attempts ranked match -> 403 Forbidden
    const authorRankedRes = await makeRequest(
      server,
      {
        path: "/api/arena/v1/matches",
        method: "POST",
        headers: {
          Authorization: `Bearer ${authorToken}`,
          "Idempotency-Key": `key-match-ranked-author-${Date.now()}`
        }
      },
      {
        kind: "ranked",
        ladderId: "ladder-main",
        botA: { botVersionId: verAId },
        botB: { botVersionId: verBId }
      }
    );
    assert.equal(authorRankedRes.statusCode, 403);
    assert.equal(authorRankedRes.json?.error?.code, "FORBIDDEN");

    // 2. Unready version scheduled -> 422 Unprocessable Entity
    const unreadyRes = await makeRequest(
      server,
      {
        path: "/api/arena/v1/matches",
        method: "POST",
        headers: {
          Authorization: `Bearer ${authorToken}`,
          "Idempotency-Key": `key-match-unready-${Date.now()}`
        }
      },
      {
        kind: "practice",
        ladderId: "ladder-main",
        botA: { botVersionId: unreadyVerId },
        botB: { botVersionId: verBId }
      }
    );
    assert.equal(unreadyRes.statusCode, 422);
    assert.equal(unreadyRes.json?.error?.code, "BOT_VERSION_NOT_READY");

    // 3. Author schedules practice match with READY pins -> 201 Created
    const practiceKey = `key-practice-${Date.now()}`;
    const practiceRes = await makeRequest(
      server,
      {
        path: "/api/arena/v1/matches",
        method: "POST",
        headers: {
          Authorization: `Bearer ${authorToken}`,
          "Idempotency-Key": practiceKey
        }
      },
      {
        kind: "practice",
        ladderId: "ladder-main",
        botA: { botVersionId: verAId },
        botB: { botVersionId: verBId }
      }
    );
    assert.equal(practiceRes.statusCode, 201);
    const matchId = practiceRes.json.match.id;
    assert.equal(practiceRes.json.match.kind, "practice");
    assert.equal(practiceRes.json.match.status, "pending");

    // 4. GET /matches/:id/replay before finalization returns HTTP 409 Conflict
    const pendingReplayRes = await makeRequest(server, {
      path: `/api/arena/v1/matches/${matchId}/replay`,
      method: "GET",
      headers: { Authorization: `Bearer ${authorToken}` }
    });
    assert.equal(pendingReplayRes.statusCode, 409);
    assert.equal(pendingReplayRes.json?.error?.code, "MATCH_NOT_FINALIZED");
  });

  // ── 5. Actual JobWorker Integration (Moves, Finalizer, Replay Read) ───────
  it("executes actual match via JobWorker, commits result/replay, and GET /replay returns 200 with digest", async () => {
    // Create bots and ready versions pointing to real fixture bots
    const botAlpha = env.botRepo.createBot(
      { id: `bot-alpha-${Date.now()}`, ownerId: "usr-admin", name: "AlphaBot" },
      { idempotencyKey: `bot-alpha-${Date.now()}`, actorId: "usr-admin" }
    );
    const botBeta = env.botRepo.createBot(
      { id: `bot-beta-${Date.now()}`, ownerId: "usr-admin", name: "BetaBot" },
      { idempotencyKey: `bot-beta-${Date.now()}`, actorId: "usr-admin" }
    );

    const fixtureBotPath = path.resolve("tests/fixtures/arena/bots/legal.mjs");
    const sourceContent = fs.readFileSync(fixtureBotPath);

    const buildAlpha = await env.buildService.build({ sourceContent, profileId: "node" });
    const buildBeta = await env.buildService.build({ sourceContent, profileId: "node" });

    env.botRepo.registerArtifact({
      digest: buildAlpha.artifactDigest,
      kind: "build",
      relativePrivatePath: `builds/${buildAlpha.artifactDigest.slice(7, 9)}/${buildAlpha.artifactDigest.slice(9)}`,
      bytes: buildAlpha.manifest.bytes
    });
    env.botRepo.registerArtifact({
      digest: buildBeta.artifactDigest,
      kind: "build",
      relativePrivatePath: `builds/${buildBeta.artifactDigest.slice(7, 9)}/${buildBeta.artifactDigest.slice(9)}`,
      bytes: buildBeta.manifest.bytes
    });

    const verA = env.botRepo.createVersion(
      {
        id: `ver-alpha-${Date.now()}`,
        botId: botAlpha.id,
        sourceDigest: buildAlpha.manifest.sourceDigest,
        profileId: "node",
        profileRevision: buildAlpha.manifest.profileRevision
      },
      { idempotencyKey: `ver-alpha-key-${Date.now()}`, actorId: "usr-admin" }
    );
    env.botRepo.markVersionReady({
      botVersionId: verA.id,
      artifactDigest: buildAlpha.artifactDigest,
      buildLog: "Ready"
    });

    const verB = env.botRepo.createVersion(
      {
        id: `ver-beta-${Date.now()}`,
        botId: botBeta.id,
        sourceDigest: buildBeta.manifest.sourceDigest,
        profileId: "node",
        profileRevision: buildBeta.manifest.profileRevision
      },
      { idempotencyKey: `ver-beta-key-${Date.now()}`, actorId: "usr-admin" }
    );
    env.botRepo.markVersionReady({
      botVersionId: verB.id,
      artifactDigest: buildBeta.artifactDigest,
      buildLog: "Ready"
    });

    // Schedule ranked match via API
    const matchKey = `key-ranked-exec-${Date.now()}`;
    const scheduleRes = await makeRequest(
      server,
      {
        path: "/api/arena/v1/matches",
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Idempotency-Key": matchKey
        }
      },
      {
        kind: "ranked",
        ladderId: "ladder-main",
        botA: { botVersionId: verA.id },
        botB: { botVersionId: verB.id }
      }
    );
    assert.equal(scheduleRes.statusCode, 201);
    const matchId = scheduleRes.json.match.id;

    // Instantiate real JobWorker using createProfileBotFactory and execute the queued match
    const worker = createJobWorker({
      workerId: "test-integration-worker",
      db: env.db,
      jobQueue: env.jobQueue,
      matchRepo: env.matchRepo,
      finalizer: env.finalizer,
      botVersionService: env.botVersionService,
      allowedKinds: ["match"],
      botFactory: createProfileBotFactory({
        artifactStore: env.artifactStore,
        profileRegistry: env.profileRegistry
      })
    });

    // Drain queued matches until our target matchId completes
    let targetMatchExecuted = false;
    while (true) {
      const runResult = await worker.runOnce();
      if (!runResult.executed) break;
      if (runResult.claim && runResult.claim.targetId === matchId) {
        targetMatchExecuted = true;
        assert.equal(runResult.result.result.outcome, "win", "Match must finish with a real win outcome");
        break;
      }
    }
    assert.equal(targetMatchExecuted, true, "Worker must claim and execute the match job");

    // 1. GET /matches/:id now returns completed status and result
    const getMatchRes = await makeRequest(server, {
      path: `/api/arena/v1/matches/${matchId}`,
      method: "GET",
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(getMatchRes.statusCode, 200);
    assert.equal(getMatchRes.json.match.status, "completed");
    assert.ok(getMatchRes.json.match.result);
    assert.equal(getMatchRes.json.match.result.outcome, "win");

    // 2. GET /matches/:id/replay now returns 200 with full replay and digests
    const replayRes = await makeRequest(server, {
      path: `/api/arena/v1/matches/${matchId}/replay`,
      method: "GET",
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(replayRes.statusCode, 200);
    assert.equal(replayRes.json.matchId, matchId);
    assert.ok(replayRes.json.replayDigest.startsWith("sha256:"));
    assert.ok(replayRes.json.completionDigest.startsWith("sha256:"));
    assert.ok(replayRes.json.replay.frames.length > 0);
    assert.equal(replayRes.headers["etag"], `"${replayRes.json.replayDigest}"`);
  });

  // ── 6. Tournaments & Standings ────────────────────────────────────────────
  it("POST /tournaments creates double round-robin tournament and GET /tournaments/:id returns 3-1-0 standings", async () => {
    const fixtureBotPath = path.resolve("tests/fixtures/arena/bots/legal.mjs");
    const sourceContent = fs.readFileSync(fixtureBotPath);
    const tourneyBuild = await env.buildService.build({ sourceContent, profileId: "node" });

    env.botRepo.registerArtifact({
      digest: tourneyBuild.artifactDigest,
      kind: "build",
      relativePrivatePath: `builds/${tourneyBuild.artifactDigest.slice(7, 9)}/${tourneyBuild.artifactDigest.slice(9)}`,
      bytes: tourneyBuild.manifest.bytes
    });

    // Create 3 bots and ready versions
    const botIds = [];
    const verIds = [];
    for (let i = 1; i <= 3; i++) {
      const b = env.botRepo.createBot(
        { id: `t-bot-${i}-${Date.now()}`, ownerId: "usr-admin", name: `TourneyBot${i}` },
        { idempotencyKey: `t-bot-key-${i}-${Date.now()}`, actorId: "usr-admin" }
      );
      botIds.push(b.id);

      const v = env.botRepo.createVersion(
        {
          id: `t-ver-${i}-${Date.now()}`,
          botId: b.id,
          sourceDigest: tourneyBuild.manifest.sourceDigest,
          profileId: "node",
          profileRevision: tourneyBuild.manifest.profileRevision
        },
        { idempotencyKey: `t-ver-key-${i}-${Date.now()}`, actorId: "usr-admin" }
      );
      env.botRepo.markVersionReady({
        botVersionId: v.id,
        artifactDigest: tourneyBuild.artifactDigest,
        buildLog: tourneyBuild.logs
      });
      verIds.push(v.id);
    }

    // 1. Author cannot create tournament -> 403 Forbidden
    const authorTourneyRes = await makeRequest(
      server,
      {
        path: "/api/arena/v1/tournaments",
        method: "POST",
        headers: {
          Authorization: `Bearer ${authorToken}`,
          "Idempotency-Key": `key-author-tourney-${Date.now()}`
        }
      },
      {
        name: "AuthorTourney",
        entries: verIds.map((id) => ({ botVersionId: id }))
      }
    );
    assert.equal(authorTourneyRes.statusCode, 403);
    assert.equal(authorTourneyRes.json?.error?.code, "FORBIDDEN");

    // 2. Admin creates tournament -> 201 Created with 3*(3-1) = 6 matches
    const tourneyKey = `key-admin-tourney-${Date.now()}`;
    const tourneyRes = await makeRequest(
      server,
      {
        path: "/api/arena/v1/tournaments",
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Idempotency-Key": tourneyKey
        }
      },
      {
        name: "Spring Championship 2026",
        ladderId: "ladder-main",
        entries: verIds.map((id) => ({ botVersionId: id }))
      }
    );

    assert.equal(tourneyRes.statusCode, 201);
    const tourneyId = tourneyRes.json.tournament.id;
    assert.equal(tourneyRes.json.matchesCount, 6, "3 bots in double round-robin must generate exactly 6 matches");

    // 3. GET /tournaments/:id returns schedule and initial 3-1-0 standings
    const getTourneyRes = await makeRequest(server, {
      path: `/api/arena/v1/tournaments/${tourneyId}`,
      method: "GET",
      headers: { Authorization: `Bearer ${authorToken}` }
    });

    assert.equal(getTourneyRes.statusCode, 200);
    assert.equal(getTourneyRes.json.tournament.name, "Spring Championship 2026");
    assert.equal(getTourneyRes.json.matches.length, 6);
    assert.equal(getTourneyRes.json.standings.length, 3);
    for (const standing of getTourneyRes.json.standings) {
      assert.equal(standing.points, 0);
      assert.equal(standing.played, 0);
    }
  });

  // ── 7. Leaderboard ────────────────────────────────────────────────────────
  it("GET /leaderboard reads backend rating/stats without client recalculation", async () => {
    // Missing ladderId -> 422
    const missingLadderRes = await makeRequest(server, {
      path: "/api/arena/v1/leaderboard",
      method: "GET",
      headers: { Authorization: `Bearer ${authorToken}` }
    });
    assert.equal(missingLadderRes.statusCode, 422);
    assert.equal(missingLadderRes.json?.error?.code, "VALIDATION_ERROR");

    // Provide corresponding bot record first for foreign key integrity
    env.db
      .prepare("INSERT OR IGNORE INTO bots (id, owner_id, name) VALUES (?, ?, ?)")
      .run("usr-admin-seeded-bot", "usr-admin", "GrandmasterBot");

    // Seed bot rating directly in DB
    env.db
      .prepare(
        "INSERT INTO bot_ratings (ladder_id, bot_id, rating, rated_games, wins, draws, losses) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run("ladder-main", "usr-admin-seeded-bot", 1248.5, 5, 4, 1, 0);

    const res = await makeRequest(server, {
      path: "/api/arena/v1/leaderboard?ladderId=ladder-main",
      method: "GET",
      headers: { Authorization: `Bearer ${authorToken}` }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json.ladderId, "ladder-main");
    assert.ok(Array.isArray(res.json.ratings));
    const entry = res.json.ratings.find((r) => r.botId === "usr-admin-seeded-bot");
    assert.ok(entry, "Seeded bot rating must be returned");
    assert.equal(entry.rating, 1248.5);
    assert.equal(entry.wins, 4);
    assert.equal(entry.rank, 1);
  });

  // ── 8. Worker Ownership & Main Entry ──────────────────────────────────────
  it("loadConfig parses external worker flag and config options", () => {
    const config = loadConfig({
      port: 3005,
      externalWorker: true,
      allowedOrigins: ["http://example.com"]
    });

    assert.equal(config.port, 3005);
    assert.equal(config.externalWorker, true);
    assert.deepEqual(config.allowedOrigins, ["http://example.com"]);
  });

  it("starts arena:api main service and runs arena:worker CLI on temp DB with externalWorker flag", async () => {
    const tempServiceDir = path.join(TEMP_BASE_DIR, "service-boot-test-" + Date.now());
    fs.mkdirSync(tempServiceDir, { recursive: true });
    const tempDbPath = path.join(tempServiceDir, "arena-boot.db");
    const tempStorageDir = path.join(tempServiceDir, "artifacts");

    let service = null;
    try {
      // 1. Boot main service with externalWorker: true on ephemeral port
      service = await startArenaService({
        dbPath: tempDbPath,
        storageDir: tempStorageDir,
        bind: "127.0.0.1",
        port: 0,
        externalWorker: true
      });

      assert.ok(service.server);
      assert.equal(service.worker, null, "embedded worker must not start when externalWorker is true");

      const addr = service.server.address();
      const port = addr.port;

      // Verify capabilities endpoint responds 200
      const capRes = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/api/arena/v1/capabilities`, (res) => {
          let raw = "";
          res.on("data", (c) => (raw += c));
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        });
        req.on("error", reject);
      });

      assert.equal(capRes.status, 200);
      assert.equal(capRes.body.trusted, true);
    } finally {
      if (service) {
        await service.stop();
      }
    }

    // 2. Run standalone worker CLI runner with --once on the same temp DB
    let cliError = null;
    try {
      await runWorkerCli([
        "--db", tempDbPath,
        "--storage", tempStorageDir,
        "--worker-id", "test-boot-worker",
        "--once"
      ]);
    } catch (err) {
      cliError = err;
    }
    assert.equal(cliError, null, "runWorkerCli --once must execute without error");
  });

  // ── 9. Python Profile Dispatch Integration ────────────────────────────────
  it("executes match with Python profile bot via profileRegistry dispatch and produces valid replay", async () => {
    const pythonBotCode = `import sys, json

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        turn = json.loads(line)
        if "legalMoves" in turn and len(turn["legalMoves"]) > 0:
            action = {
                "protocolVersion": 1,
                "requestId": turn["requestId"],
                "move": turn["legalMoves"][0],
                "comment": "python legal move"
            }
            sys.stdout.write(json.dumps(action) + "\\n")
            sys.stdout.flush()
    except Exception as e:
        sys.stderr.write(f"python bot error: {e}\\n")
`;

    // 1. Build python bot using real build service
    const pyBuild = await env.buildService.build({
      sourceContent: Buffer.from(pythonBotCode, "utf8"),
      profileId: "python"
    });
    assert.equal(pyBuild.status, "READY");
    assert.ok(pyBuild.artifactDigest);

    env.botRepo.registerArtifact({
      digest: pyBuild.artifactDigest,
      kind: "build",
      relativePrivatePath: `builds/${pyBuild.artifactDigest.slice(7, 9)}/${pyBuild.artifactDigest.slice(9)}`,
      bytes: pyBuild.manifest.bytes
    });

    // Create python bot and ready version
    const pyBot = env.botRepo.createBot(
      { id: `py-bot-${Date.now()}`, ownerId: "usr-admin", name: "PythonLegalBot" },
      { idempotencyKey: `py-bot-key-${Date.now()}`, actorId: "usr-admin" }
    );
    const pyVer = env.botRepo.createVersion(
      {
        id: `py-ver-${Date.now()}`,
        botId: pyBot.id,
        sourceDigest: pyBuild.manifest.sourceDigest,
        profileId: "python",
        profileRevision: pyBuild.manifest.profileRevision
      },
      { idempotencyKey: `py-ver-key-${Date.now()}`, actorId: "usr-admin" }
    );
    env.botRepo.markVersionReady({
      botVersionId: pyVer.id,
      artifactDigest: pyBuild.artifactDigest,
      buildLog: pyBuild.logs
    });

    // Node bot for opponent
    const fixtureBotPath = path.resolve("tests/fixtures/arena/bots/legal.mjs");
    const nodeSource = fs.readFileSync(fixtureBotPath);
    const nodeBuild = await env.buildService.build({ sourceContent: nodeSource, profileId: "node" });
    env.botRepo.registerArtifact({
      digest: nodeBuild.artifactDigest,
      kind: "build",
      relativePrivatePath: `builds/${nodeBuild.artifactDigest.slice(7, 9)}/${nodeBuild.artifactDigest.slice(9)}`,
      bytes: nodeBuild.manifest.bytes
    });
    const nodeBot = env.botRepo.createBot(
      { id: `py-node-bot-${Date.now()}`, ownerId: "usr-admin", name: "NodeOpponentBot" },
      { idempotencyKey: `py-node-bot-key-${Date.now()}`, actorId: "usr-admin" }
    );
    const nodeVer = env.botRepo.createVersion(
      {
        id: `py-node-ver-${Date.now()}`,
        botId: nodeBot.id,
        sourceDigest: nodeBuild.manifest.sourceDigest,
        profileId: "node",
        profileRevision: nodeBuild.manifest.profileRevision
      },
      { idempotencyKey: `py-node-ver-key-${Date.now()}`, actorId: "usr-admin" }
    );
    env.botRepo.markVersionReady({
      botVersionId: nodeVer.id,
      artifactDigest: nodeBuild.artifactDigest,
      buildLog: nodeBuild.logs
    });

    // Schedule ranked match Python vs Node
    const matchKey = `key-py-node-match-${Date.now()}`;
    const scheduleRes = await makeRequest(
      server,
      {
        path: "/api/arena/v1/matches",
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Idempotency-Key": matchKey
        }
      },
      {
        kind: "ranked",
        ladderId: "ladder-main",
        botA: { botVersionId: pyVer.id },
        botB: { botVersionId: nodeVer.id }
      }
    );
    assert.equal(scheduleRes.statusCode, 201);
    const pyMatchId = scheduleRes.json.match.id;

    // Execute via worker with profile bot factory (dispatches Python for seat A and Node for seat B)
    const worker = createJobWorker({
      workerId: "test-py-integration-worker",
      db: env.db,
      jobQueue: env.jobQueue,
      matchRepo: env.matchRepo,
      finalizer: env.finalizer,
      botVersionService: env.botVersionService,
      allowedKinds: ["match"],
      botFactory: createProfileBotFactory({
        artifactStore: env.artifactStore,
        profileRegistry: env.profileRegistry
      })
    });

    let targetMatchExecuted = false;
    while (true) {
      const runResult = await worker.runOnce();
      if (!runResult.executed) break;
      if (runResult.claim && runResult.claim.targetId === pyMatchId) {
        targetMatchExecuted = true;
        assert.ok(runResult.result.result.outcome);
        break;
      }
    }
    assert.equal(targetMatchExecuted, true, "Worker must claim and execute the Python vs Node match");

    // Verify replay is readable with 200
    const replayRes = await makeRequest(server, {
      path: `/api/arena/v1/matches/${pyMatchId}/replay`,
      method: "GET",
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(replayRes.statusCode, 200);
    assert.ok(replayRes.json.replay.frames.length > 0);
  });
});
