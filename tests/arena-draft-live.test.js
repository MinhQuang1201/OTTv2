/**
 * tests/arena-draft-live.test.js
 *
 * Backend integration test suite for Arena Part B:
 * - Ephemeral Draft Execution (isolated compile/run, zero Elo, zero DB pollution, temp cleanup)
 * - Incremental Live Arena Frames (fenced cursor, attempt reset, pre-finalization polling, finalization cleanup)
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const { createHash } = require("node:crypto");

const TEMP_BASE_DIR = path.resolve(os.tmpdir(), "arena-draft-live-test-" + Date.now());

let openDatabase;
let closeDatabase;
let applyMigration;
let withTransaction;
let createBotRepository;
let createTournamentRepository;
let createMatchRepository;
let createJobQueue;
let createMatchFinalizer;
let createProfileRegistry;
let createArtifactStore;
let createLiveFrameStore;
let createDraftService;
let createArenaServer;
let hashPassword;
let createSession;
let FencedLiveFrameError;
let createJobWorker;
let createNodeEngine;
let coreConfig;
let createCurrentRulesetSnapshot;
let createMapState;
let startArenaService;

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
        let parsed = null;
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          parsed = rawBody;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: parsed
        });
      });
    });

    req.on("error", reject);

    if (body) {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      req.write(payload);
    }
    req.end();
  });
}

describe("Arena Part B — Draft Execution & Live Frames", () => {
  let testDbCounter = 0;

  function createTestDb(targetVersion = "004-arena-live-frames") {
    testDbCounter++;
    const dbPath = path.resolve(TEMP_BASE_DIR, `test-${testDbCounter}.sqlite`);
    const { db, version } = openDatabase(dbPath, { targetVersion });
    return { db, dbPath, version };
  }

  function seedUser(db, { id, username, role = "author" }) {
    const passwordHash = hashPassword("password123");
    db.prepare(`
      INSERT INTO users (id, normalized_username, password_hash, role, status)
      VALUES (?, ?, ?, ?, 'active')
    `).run(id, username.toLowerCase(), passwordHash, role);
    return { id, username, role };
  }

  function seedBot(db, { id, ownerId, name = "Test Bot" }) {
    db.prepare(`
      INSERT INTO bots (id, owner_id, name, status)
      VALUES (?, ?, ?, 'active')
    `).run(id, ownerId, name);
    return { id, ownerId, name };
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

    const matchRepoMod = await import("../packages/arena-node/src/persistence/match-repository.mjs");
    createMatchRepository = matchRepoMod.createMatchRepository;

    const queueMod = await import("../packages/arena-node/src/persistence/job-queue.mjs");
    createJobQueue = queueMod.createJobQueue;

    const finalizerMod = await import("../packages/arena-node/src/persistence/finalizer.mjs");
    createMatchFinalizer = finalizerMod.createMatchFinalizer;

    const profileMod = await import("../packages/arena-node/src/execution/profile-registry.mjs");
    createProfileRegistry = profileMod.createProfileRegistry;

    const artMod = await import("../packages/arena-node/src/artifacts/artifact-store.mjs");
    createArtifactStore = artMod.createArtifactStore;

    const liveMod = await import("../packages/arena-node/src/persistence/live-frame-store.mjs");
    createLiveFrameStore = liveMod.createLiveFrameStore;
    FencedLiveFrameError = liveMod.FencedLiveFrameError;

    const draftMod = await import("../packages/arena-node/src/execution/draft-service.mjs");
    createDraftService = draftMod.createDraftService;

    const serverMod = await import("../apps/arena-api/src/http-server.mjs");
    createArenaServer = serverMod.createArenaServer;

    const authMod = await import("../apps/arena-api/src/auth/accounts.mjs");
    hashPassword = authMod.hashPassword;
    createSession = authMod.createSession;

    const workerMod = await import("../packages/arena-node/src/worker/job-worker.mjs");
    createJobWorker = workerMod.createJobWorker;

    const engineMod = await import("../packages/arena-node/src/core/node-engine.mjs");
    createNodeEngine = engineMod.createNodeEngine;
    coreConfig = engineMod.coreConfig;

    const contractsMod = await import("../packages/arena/src/contracts/index.mjs");
    createCurrentRulesetSnapshot = contractsMod.createCurrentRulesetSnapshot;

    const mapsMod = await import("../packages/arena/src/domain/maps/index.mjs");
    createMapState = mapsMod.createMapState;

    const mainMod = await import("../apps/arena-api/src/main.mjs");
    startArenaService = mainMod.startArenaService;
  });

  after(() => {
    try {
      fs.rmSync(TEMP_BASE_DIR, { recursive: true, force: true });
    } catch {}
  });

  // ── 1. Migration 004 ───────────────────────────────────────────────────────
  describe("1. Schema Migration 004: Live Frames", () => {
    it("applies 004-arena-live-frames creating match_live_frames cleanly", () => {
      const { db, version } = createTestDb("004-arena-live-frames");
      try {
        assert.equal(version, "004-arena-live-frames");
        const applied = db.prepare("SELECT version FROM schema_migrations ORDER BY applied_at ASC").all();
        assert.ok(applied.some((r) => r.version === "004-arena-live-frames"));

        const tableInfo = db.prepare("PRAGMA table_info(match_live_frames)").all();
        const colNames = tableInfo.map((c) => c.name);
        assert.ok(colNames.includes("match_id"));
        assert.ok(colNames.includes("attempt_no"));
        assert.ok(colNames.includes("ply"));
        assert.ok(colNames.includes("frame_json"));
      } finally {
        closeDatabase(db);
      }
    });

    it("upgrades existing 003 database to 004 preserving data", () => {
      const { db } = createTestDb("003-competition-rounds");
      try {
        applyMigration(db, "004-arena-live-frames");
        const applied = db.prepare("SELECT version FROM schema_migrations WHERE version = '004-arena-live-frames'").get();
        assert.ok(applied);
      } finally {
        closeDatabase(db);
      }
    });

    it("createLiveFrameStore fails closed with MIGRATION_REQUIRED on unmigrated database without altering schema", () => {
      const { db } = createTestDb("003-competition-rounds");
      try {
        assert.throws(
          () => createLiveFrameStore(db),
          (err) => err.code === "MIGRATION_REQUIRED"
        );
        const applied = db.prepare("SELECT version FROM schema_migrations WHERE version = '004-arena-live-frames'").get();
        assert.equal(applied, undefined, "Schema must NOT be silently migrated inside store constructor");
      } finally {
        closeDatabase(db);
      }
    });
  });

  // ── 2. Draft Execution Service ─────────────────────────────────────────────
  describe("2. Ephemeral Draft Execution Service", () => {
    const LEGAL_NODE_BOT = `
      process.stdin.setEncoding('utf8');
      let buffer = '';
      process.stdin.on('data', chunk => {
        buffer += chunk;
        const lines = buffer.split('\\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.type === 'start') {
            process.stdout.write(JSON.stringify({ type: 'ready' }) + '\\n');
          } else if (msg.type === 'turn') {
            // Find first legal move or advance opening piece
            const pieces = msg.state?.pieces || [];
            const myPiece = pieces.find(p => p.player === 'A' || p.owner === 'A');
            const from = myPiece ? { x: myPiece.x, y: myPiece.y } : { x: 4, y: 7 };
            // For standard classic opening: piece at (4,7) can step to (4,8)
            const move = { from, to: { x: from.x, y: from.y + 1 } };
            process.stdout.write(JSON.stringify({
              protocolVersion: 1,
              type: 'action',
              requestId: msg.requestId,
              move,
              comment: 'draft opening step'
            }) + '\\n');
          }
        }
      });
    `;

    const SYNTAX_ERROR_NODE_BOT = `
      this is not valid javascript syntax ((((
    `;

    const TIMEOUT_NODE_BOT = `
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', () => {
        // Infinite loop blocking event loop
        while(true) {}
      });
    `;

    it("fails closed when container isolation runtime is unavailable by default (trustedLocalMode: false)", async () => {
      const { db } = createTestDb();
      try {
        const profileRegistry = createProfileRegistry();
        const draftService = createDraftService({
          profileRegistry,
          trustedLocalMode: false,
          containerExecutor: { probe: () => ({ available: false, reason: "test_runtime_unavailable" }) },
          tempBaseDir: TEMP_BASE_DIR
        });

        seedUser(db, { id: "u-author-safe", username: "authorsafe" });
        seedBot(db, { id: "bot-draft-safe", ownerId: "u-author-safe" });

        const result = await draftService.runDraft({
          db,
          authorId: "u-author-safe",
          botId: "bot-draft-safe",
          source: LEGAL_NODE_BOT,
          profileId: "node"
        });

        assert.equal(result.status, "unavailable");
        assert.equal(result.isolation, "container");
        assert.ok(result.error.includes("Container isolation runtime is unavailable"));
      } finally {
        closeDatabase(db);
      }
    });

    it("compiles and runs a legal candidate draft move returning move diagnostics", async () => {
      const { db } = createTestDb();
      try {
        const profileRegistry = createProfileRegistry();
        const draftService = createDraftService({
          profileRegistry,
          trustedLocalMode: true,
          tempBaseDir: TEMP_BASE_DIR
        });

        seedUser(db, { id: "u-author", username: "author" });
        seedBot(db, { id: "bot-draft-1", ownerId: "u-author", name: "Draft Candidate" });

        const beforeVersions = db.prepare("SELECT COUNT(*) AS count FROM bot_versions").get().count;
        const beforeMatches = db.prepare("SELECT COUNT(*) AS count FROM matches").get().count;
        const beforeRatings = db.prepare("SELECT COUNT(*) AS count FROM bot_ratings").get().count;

        const result = await draftService.runDraft({
          db,
          authorId: "u-author",
          botId: "bot-draft-1",
          source: LEGAL_NODE_BOT,
          profileId: "node",
          mapId: "classic"
        });

        assert.equal(result.status, "success");
        assert.equal(result.isolation, "trusted-process");
        assert.equal(result.compile.status, "ok");
        assert.equal(result.execution.legal, true);
        assert.ok(result.execution.move);
        assert.equal(result.execution.move.from.x, 4);
        assert.equal(result.execution.move.to.x, 4);
        assert.equal(result.execution.comment, "draft opening step");
        assert.ok(result.execution.elapsedMs >= 0);
        assert.ok(result.nextState);

        // ZERO official DB pollution verification
        const afterVersions = db.prepare("SELECT COUNT(*) AS count FROM bot_versions").get().count;
        const afterMatches = db.prepare("SELECT COUNT(*) AS count FROM matches").get().count;
        const afterRatings = db.prepare("SELECT COUNT(*) AS count FROM bot_ratings").get().count;

        assert.equal(afterVersions, beforeVersions, "bot_versions must NOT increase");
        assert.equal(afterMatches, beforeMatches, "matches must NOT increase");
        assert.equal(afterRatings, beforeRatings, "bot_ratings must NOT increase");

        // Temporary artifact cleanup verification
        const tempFolders = fs.readdirSync(TEMP_BASE_DIR).filter((f) => f.startsWith("arena-draft-"));
        assert.equal(tempFolders.length, 0, "all temporary draft working directories must be cleaned up");
      } finally {
        closeDatabase(db);
      }
    });

    it("captures compilation/syntax error cleanly without throwing unhandled error", async () => {
      const { db } = createTestDb();
      try {
        const profileRegistry = createProfileRegistry();
        const draftService = createDraftService({
          profileRegistry,
          trustedLocalMode: true,
          tempBaseDir: TEMP_BASE_DIR
        });

        seedUser(db, { id: "u-author", username: "author" });
        seedBot(db, { id: "bot-draft-2", ownerId: "u-author" });

        const result = await draftService.runDraft({
          db,
          authorId: "u-author",
          botId: "bot-draft-2",
          source: SYNTAX_ERROR_NODE_BOT,
          profileId: "node"
        });

        assert.equal(result.status, "compile_error");
        assert.equal(result.isolation, "trusted-process");
        assert.equal(result.compile.status, "failed");
        assert.ok(result.compile.logs.length > 0);
      } finally {
        closeDatabase(db);
      }
    });

    it("enforces execution deadline when bot enters infinite loop", async () => {
      const { db } = createTestDb();
      try {
        const profileRegistry = createProfileRegistry();
        const draftService = createDraftService({
          profileRegistry,
          trustedLocalMode: true,
          turnTimeoutMs: 500,
          tempBaseDir: TEMP_BASE_DIR
        });

        seedUser(db, { id: "u-author", username: "author" });
        seedBot(db, { id: "bot-draft-3", ownerId: "u-author" });

        const result = await draftService.runDraft({
          db,
          authorId: "u-author",
          botId: "bot-draft-3",
          source: TIMEOUT_NODE_BOT,
          profileId: "node"
        });

        assert.equal(result.status, "execution_error");
        assert.equal(result.isolation, "trusted-process");
        assert.ok(result.execution.error.includes("timeout") || result.execution.error.includes("crash"));
      } finally {
        closeDatabase(db);
      }
    });

    it("rejects non-owner author trying to run draft on another user's bot", async () => {
      const { db } = createTestDb();
      try {
        const profileRegistry = createProfileRegistry();
        const draftService = createDraftService({ profileRegistry, trustedLocalMode: true });

        seedUser(db, { id: "u-alice", username: "alice" });
        seedUser(db, { id: "u-bob", username: "bob" });
        seedBot(db, { id: "bot-alice", ownerId: "u-alice" });

        await assert.rejects(
          async () => {
            await draftService.runDraft({
              db,
              authorId: "u-bob",
              botId: "bot-alice",
              source: LEGAL_NODE_BOT,
              profileId: "node"
            });
          },
          (err) => err.code === "OWNERSHIP_MISMATCH" || err.message.includes("owner")
        );
      } finally {
        closeDatabase(db);
      }
    });

    it("enforces start timeout and forcefully terminates bot on hanging startup", async () => {
      const { db } = createTestDb();
      try {
        const profileRegistry = createProfileRegistry();
        let stopCalled = false;

        profileRegistry.registerProfile({
          id: "mock-hang",
          language: "mock",
          probe: () => ({ available: true }),
          compile: () => ({ status: 0, stdout: "", stderr: "" }),
          createBot: () => ({
            botId: "mock-hang-bot",
            start: () => new Promise(() => {
              // Hanging start promise that never resolves
            }),
            stop: async () => {
              stopCalled = true;
            },
            turn: async () => {}
          })
        });

        const draftService = createDraftService({
          profileRegistry,
          trustedLocalMode: true,
          startTimeoutMs: 100, // short timeout for test
          tempBaseDir: TEMP_BASE_DIR
        });

        seedUser(db, { id: "u-author-hang", username: "authorhang" });
        seedBot(db, { id: "bot-draft-hang", ownerId: "u-author-hang" });

        const result = await draftService.runDraft({
          db,
          authorId: "u-author-hang",
          botId: "bot-draft-hang",
          source: "mock hanging bot source",
          profileId: "mock-hang"
        });

        assert.equal(result.status, "execution_error");
        assert.equal(result.isolation, "trusted-process");
        assert.equal(result.execution.error, "start_timeout");
        assert.equal(stopCalled, true, "botInstance.stop() must be invoked forcefully even if start promise hangs");
      } finally {
        closeDatabase(db);
      }
    });

    it("enforces concurrency limit when concurrent requests exceed cap", async () => {
      const { db } = createTestDb();
      try {
        const profileRegistry = createProfileRegistry();
        let resolveTurn;
        const turnPromise = new Promise((resolve) => {
          resolveTurn = resolve;
        });

        profileRegistry.registerProfile({
          id: "mock-slow",
          language: "mock",
          probe: () => ({ available: true }),
          compile: () => ({ status: 0, stdout: "", stderr: "" }),
          createBot: () => ({
            botId: "mock-slow-bot",
            start: async () => {},
            stop: async () => {},
            requestMove: async () => {
              await turnPromise;
              return { move: { from: { x: 4, y: 7 }, to: { x: 4, y: 8 } } };
            }
          })
        });

        const draftService = createDraftService({
          profileRegistry,
          trustedLocalMode: true,
          maxConcurrentDrafts: 1, // Only 1 active draft permitted
          tempBaseDir: TEMP_BASE_DIR
        });

        seedUser(db, { id: "u-author-conc", username: "authorconc" });
        seedBot(db, { id: "bot-draft-conc", ownerId: "u-author-conc" });

        // Launch first draft which occupies the concurrency slot
        const run1Promise = draftService.runDraft({
          db,
          authorId: "u-author-conc",
          botId: "bot-draft-conc",
          source: "mock slow bot source",
          profileId: "mock-slow"
        });

        // Launch second concurrent draft: should reject immediately with ConcurrencyLimitError
        await assert.rejects(
          async () => {
            await draftService.runDraft({
              db,
              authorId: "u-author-conc",
              botId: "bot-draft-conc",
              source: "mock slow bot source",
              profileId: "mock-slow"
            });
          },
          (err) => err.code === "CONCURRENCY_LIMIT_EXCEEDED"
        );

        // Unblock first draft and verify it finishes normally
        resolveTurn();
        const res1 = await run1Promise;
        assert.equal(res1.status, "success");
      } finally {
        closeDatabase(db);
      }
    });

    it("accepts canonical profile IDs (node, python) and rejects unsolicited aliases like node-process-v1", async () => {
      const { db } = createTestDb();
      try {
        const profileRegistry = createProfileRegistry();
        const draftService = createDraftService({
          profileRegistry,
          trustedLocalMode: true,
          tempBaseDir: TEMP_BASE_DIR
        });

        seedUser(db, { id: "u-author-v1", username: "authorv1" });
        seedBot(db, { id: "bot-draft-v1", ownerId: "u-author-v1" });

        // Canonical ID 'node' succeeds
        const canonicalResult = await draftService.runDraft({
          db,
          authorId: "u-author-v1",
          botId: "bot-draft-v1",
          source: LEGAL_NODE_BOT,
          profileId: "node",
          mapId: "classic"
        });

        assert.equal(canonicalResult.status, "success");
        assert.equal(canonicalResult.isolation, "trusted-process");
        assert.equal(canonicalResult.execution.legal, true);

        // Unsolicited alias 'node-process-v1' is rejected as unsupported profile without widening registry
        const aliasResult = await draftService.runDraft({
          db,
          authorId: "u-author-v1",
          botId: "bot-draft-v1",
          source: LEGAL_NODE_BOT,
          profileId: "node-process-v1",
          mapId: "classic"
        });

        assert.equal(aliasResult.status, "compile_error");
        assert.ok(aliasResult.compile.logs.includes("Unsupported execution profile: 'node-process-v1'"));
      } finally {
        closeDatabase(db);
      }
    });

    it("allows admin to execute draft on another author's bot while non-admin author is rejected", async () => {
      const { db } = createTestDb();
      try {
        const profileRegistry = createProfileRegistry();
        const draftService = createDraftService({
          profileRegistry,
          trustedLocalMode: true,
          tempBaseDir: TEMP_BASE_DIR
        });

        seedUser(db, { id: "u-author-alice", username: "alice", role: "author" });
        seedUser(db, { id: "u-admin", username: "admin", role: "admin" });
        seedBot(db, { id: "bot-alice-owned", ownerId: "u-author-alice" });

        // Admin execution on Alice's bot succeeds
        const adminResult = await draftService.runDraft({
          db,
          authorId: "u-admin",
          authorRole: "admin",
          isAdmin: true,
          botId: "bot-alice-owned",
          source: LEGAL_NODE_BOT,
          profileId: "node"
        });

        assert.equal(adminResult.status, "success");
        assert.equal(adminResult.execution.legal, true);
      } finally {
        closeDatabase(db);
      }
    });

    it("executes draft through container isolation path using temporary artifact store when container runtime is available", async () => {
      const { db } = createTestDb();
      try {
        const profileRegistry = createProfileRegistry();
        let dockerRunInvoked = false;
        let dockerCompileInvoked = false;
        let spawnedContainerName = null;

        const { EventEmitter } = require("node:events");
        const { PassThrough } = require("node:stream");

        // Custom command runner simulating verified Linux Docker daemon and docker run
        const mockRunner = {
          spawnSync: (cmd, args) => {
            if (cmd === "docker" && args[0] === "version") {
              return {
                status: 0,
                stdout: JSON.stringify({
                  Server: { Os: "linux", Version: "28.0.1", Arch: "x86_64" }
                }),
                stderr: ""
              };
            }
            if (cmd === "docker" && args[0] === "inspect") {
              return {
                status: 0,
                stdout: "sha256:mockimageid123\n",
                stderr: ""
              };
            }
            if (cmd === "docker" && args[0] === "run") {
              dockerCompileInvoked = true;
              return { status: 0, stdout: "", stderr: "" };
            }
            return { status: 0, stdout: "", stderr: "" };
          },
          spawn: (cmd, args) => {
            if (cmd === "docker" && args[0] === "run") {
              dockerRunInvoked = true;
              const nameIdx = args.indexOf("--name");
              if (nameIdx !== -1) spawnedContainerName = args[nameIdx + 1];

              const child = new EventEmitter();
              child.pid = 99999;
              child.stdin = new PassThrough();
              child.stdout = new PassThrough();
              child.stderr = new PassThrough();
              child.kill = () => {};

              // Emit ready on start, and action on turn
              child.stdin.on("data", (chunk) => {
                const str = chunk.toString("utf8");
                for (const line of str.split("\n")) {
                  if (!line.trim()) continue;
                  try {
                    const msg = JSON.parse(line);
                    if (msg.type === "start") {
                      child.stdout.write(JSON.stringify({ type: "ready" }) + "\n");
                    } else if (msg.type === "turn") {
                      child.stdout.write(
                        JSON.stringify({
                          protocolVersion: 1,
                          type: "action",
                          requestId: msg.requestId,
                          move: { from: { x: 4, y: 7 }, to: { x: 4, y: 8 } },
                          comment: "container draft move"
                        }) + "\n"
                      );
                    }
                  } catch (_) {}
                }
              });

              process.nextTick(() => child.emit("spawn"));
              return child;
            }
            throw new Error(`Unexpected command: ${cmd} ${args.join(" ")}`);
          }
        };

        const draftService = createDraftService({
          profileRegistry,
          trustedLocalMode: false, // Strict container isolation required!
          containerExecutor: {
            image: "sha256:mockimageid123",
            commandRunner: mockRunner
          },
          tempBaseDir: TEMP_BASE_DIR
        });

        seedUser(db, { id: "u-author-cnt", username: "authorcnt" });
        seedBot(db, { id: "bot-draft-cnt", ownerId: "u-author-cnt" });

        const result = await draftService.runDraft({
          db,
          authorId: "u-author-cnt",
          botId: "bot-draft-cnt",
          source: LEGAL_NODE_BOT,
          profileId: "node"
        });

        assert.equal(result.status, "success");
        assert.equal(result.isolation, "container");
        assert.equal(result.execution.legal, true);
        assert.equal(result.execution.comment, "container draft move");
        assert.equal(dockerCompileInvoked, true, "docker container build must be executed inside container via spawnSync");
        assert.equal(dockerRunInvoked, true, "docker run must be executed via container executor");
        assert.ok(spawnedContainerName?.startsWith("arena-bot-"), "must generate isolated container name");
      } finally {
        closeDatabase(db);
      }
    });
  });

  // ── 3. Live Frame Store & Projection ───────────────────────────────────────
  describe("3. Incremental Live Arena Frame Store", () => {
    it("buffers sequential plies and supports incremental cursor polling", () => {
      const { db } = createTestDb();
      try {
        const liveStore = createLiveFrameStore(db);

        seedUser(db, { id: "u-1", username: "u1" });
        seedUser(db, { id: "u-2", username: "u2" });
        seedBot(db, { id: "bot-1", ownerId: "u-1" });
        seedBot(db, { id: "bot-2", ownerId: "u-2" });

        // Insert dummy match
        db.prepare(`
          INSERT INTO matches (id, ladder_id, status, kind, ruleset_json, policy_json, profile_json, initial_state_json)
          VALUES ('m-live-1', 'ladder-main', 'active', 'practice', '{}', '{}', '{}', '{}')
        `).run();

        // Record plies 0, 1, 2, 3
        liveStore.recordFrame({
          matchId: "m-live-1",
          attemptNo: 1,
          ply: 0,
          seat: null,
          move: null,
          frame: { ply: 0, clock: { remainingMs: { A: 600000, B: 600000 } } }
        });

        liveStore.recordFrame({
          matchId: "m-live-1",
          attemptNo: 1,
          ply: 1,
          seat: "A",
          move: { from: { x: 4, y: 1 }, to: { x: 4, y: 2 } },
          frame: { ply: 1, seat: "A", move: { from: { x: 4, y: 1 }, to: { x: 4, y: 2 } } }
        });

        liveStore.recordFrame({
          matchId: "m-live-1",
          attemptNo: 1,
          ply: 2,
          seat: "B",
          move: { from: { x: 4, y: 7 }, to: { x: 4, y: 6 } },
          frame: { ply: 2, seat: "B", move: { from: { x: 4, y: 7 }, to: { x: 4, y: 6 } } }
        });

        // 1. Initial query: fetch all from start
        const allRes = liveStore.getLiveFrames({ matchId: "m-live-1", afterPly: -1 });
        assert.equal(allRes.status, "running");
        assert.equal(allRes.attemptNo, 1);
        assert.equal(allRes.currentPly, 2);
        assert.equal(allRes.frames.length, 3);
        assert.equal(allRes.frames[0].ply, 0);
        assert.equal(allRes.frames[1].ply, 1);
        assert.equal(allRes.frames[2].ply, 2);

        // 2. Incremental cursor query: fetch only plies > 1
        const incRes = liveStore.getLiveFrames({ matchId: "m-live-1", afterPly: 1, attemptNo: 1 });
        assert.equal(incRes.frames.length, 1);
        assert.equal(incRes.frames[0].ply, 2);
        assert.equal(incRes.reset, false);
      } finally {
        closeDatabase(db);
      }
    });

    it("handles attempt reset fencing when worker retries with attempt 2", () => {
      const { db } = createTestDb();
      try {
        const liveStore = createLiveFrameStore(db);

        db.prepare(`
          INSERT INTO matches (id, ladder_id, status, kind, ruleset_json, policy_json, profile_json, initial_state_json)
          VALUES ('m-live-reset', 'ladder-main', 'active', 'practice', '{}', '{}', '{}', '{}')
        `).run();

        // Attempt 1 had ply 0 and ply 1
        liveStore.recordFrame({
          matchId: "m-live-reset",
          attemptNo: 1,
          ply: 0,
          seat: null,
          frame: { ply: 0 }
        });
        liveStore.recordFrame({
          matchId: "m-live-reset",
          attemptNo: 1,
          ply: 1,
          seat: "A",
          frame: { ply: 1 }
        });

        // Attempt 2 starts (e.g. attempt 1 timed out or restarted)
        liveStore.recordFrame({
          matchId: "m-live-reset",
          attemptNo: 2,
          ply: 0,
          seat: null,
          frame: { ply: 0, resetAttempt: 2 }
        });

        // Client polling with attemptNo=1 must detect reset and receive attempt 2 frames
        const resetRes = liveStore.getLiveFrames({
          matchId: "m-live-reset",
          afterPly: 1,
          attemptNo: 1
        });

        assert.equal(resetRes.reset, true);
        assert.equal(resetRes.attemptNo, 2);
        assert.equal(resetRes.frames.length, 1);
        assert.equal(resetRes.frames[0].ply, 0);
      } finally {
        closeDatabase(db);
      }
    });

    it("prunes live frames upon match finalization and returns terminal replay redirect", () => {
      const { db } = createTestDb();
      try {
        const liveStore = createLiveFrameStore(db);

        db.prepare(`
          INSERT INTO matches (id, ladder_id, status, kind, ruleset_json, policy_json, profile_json, initial_state_json)
          VALUES ('m-live-done', 'ladder-main', 'active', 'practice', '{}', '{}', '{}', '{}')
        `).run();

        liveStore.recordFrame({
          matchId: "m-live-done",
          attemptNo: 1,
          ply: 0,
          frame: { ply: 0 }
        });
        liveStore.recordFrame({
          matchId: "m-live-done",
          attemptNo: 1,
          ply: 1,
          frame: { ply: 1 }
        });

        // Verify rows exist before pruning
        const beforeCount = db.prepare("SELECT COUNT(*) AS count FROM match_live_frames WHERE match_id = 'm-live-done'").get().count;
        assert.equal(beforeCount, 2);

        // Finalize match: status becomes completed and prune live frames
        db.prepare("UPDATE matches SET status = 'completed' WHERE id = 'm-live-done'").run();
        liveStore.pruneLiveFrames("m-live-done");

        // Verify rows deleted from match_live_frames
        const afterCount = db.prepare("SELECT COUNT(*) AS count FROM match_live_frames WHERE match_id = 'm-live-done'").get().count;
        assert.equal(afterCount, 0);

        // Subsequent live query returns terminal status and replayUrl
        const termRes = liveStore.getLiveFrames({ matchId: "m-live-done", afterPly: 0 });
        assert.equal(termRes.status, "completed");
        assert.equal(termRes.terminal, true);
        assert.equal(termRes.replayUrl, "/api/arena/v1/matches/m-live-done/replay");
      } finally {
        closeDatabase(db);
      }
    });

    it("rejects stale writes to terminal matches post-finalization (no resurrection after prune)", () => {
      const { db } = createTestDb();
      try {
        const liveStore = createLiveFrameStore(db);

        db.prepare(`
          INSERT INTO matches (id, ladder_id, status, kind, ruleset_json, policy_json, profile_json, initial_state_json)
          VALUES ('m-live-term', 'ladder-main', 'completed', 'practice', '{}', '{}', '{}', '{}')
        `).run();

        // Stale worker tries to write to completed match: must throw FencedLiveFrameError MATCH_TERMINAL
        assert.throws(
          () => {
            liveStore.recordFrame({
              matchId: "m-live-term",
              attemptNo: 1,
              ply: 1,
              frame: { ply: 1, resurrected: true }
            });
          },
          (err) => err instanceof FencedLiveFrameError && err.code === "MATCH_TERMINAL"
        );

        // Verify zero rows were resurrected in match_live_frames
        const count = db.prepare("SELECT COUNT(*) AS count FROM match_live_frames WHERE match_id = 'm-live-term'").get().count;
        assert.equal(count, 0, "must NOT resurrect frames in match_live_frames for terminal match");
      } finally {
        closeDatabase(db);
      }
    });

    it("rejects writes when job lease has expired or attempt/leaseToken mismatches", () => {
      const { db } = createTestDb();
      try {
        const liveStore = createLiveFrameStore(db);

        db.prepare(`
          INSERT INTO matches (id, ladder_id, status, kind, ruleset_json, policy_json, profile_json, initial_state_json)
          VALUES ('m-live-fence', 'ladder-main', 'active', 'practice', '{}', '{}', '{}', '{}')
        `).run();

        // Active job claimed at attempt 2 with lease_token 'token-valid'
        db.prepare(`
          INSERT INTO jobs (id, kind, target_id, status, attempt_no, lease_owner, lease_token, lease_until)
          VALUES ('job-m-fence', 'match', 'm-live-fence', 'claimed', 2, 'worker-1', 'token-valid', datetime('now', '+60 seconds'))
        `).run();

        // 1. Attempt mismatch: worker with stale attempt 1 tries to write
        assert.throws(
          () => {
            liveStore.recordFrame({
              matchId: "m-live-fence",
              attemptNo: 1,
              leaseToken: "token-valid",
              ply: 1,
              frame: { ply: 1 }
            });
          },
          (err) => err instanceof FencedLiveFrameError && err.code === "ATTEMPT_MISMATCH"
        );

        // 2. Lease token mismatch: worker with old lease token tries to write
        assert.throws(
          () => {
            liveStore.recordFrame({
              matchId: "m-live-fence",
              attemptNo: 2,
              leaseToken: "token-stale-old",
              ply: 1,
              frame: { ply: 1 }
            });
          },
          (err) => err instanceof FencedLiveFrameError && err.code === "LEASE_TOKEN_MISMATCH"
        );

        // 3. Omitted lease token must also be fenced for a claimed job
        assert.throws(
          () => {
            liveStore.recordFrame({
              matchId: "m-live-fence",
              attemptNo: 2,
              ply: 1,
              frame: { ply: 1 }
            });
          },
          (err) => err instanceof FencedLiveFrameError && err.code === "LEASE_TOKEN_MISMATCH"
        );

        // 4. Explicit null lease token must also be fenced
        assert.throws(
          () => {
            liveStore.recordFrame({
              matchId: "m-live-fence",
              attemptNo: 2,
              leaseToken: null,
              ply: 1,
              frame: { ply: 1 }
            });
          },
          (err) => err instanceof FencedLiveFrameError && err.code === "LEASE_TOKEN_MISMATCH"
        );

        // 5. Expired lease: expire the lease
        db.prepare(`
          UPDATE jobs SET lease_until = datetime('now', '-10 seconds') WHERE id = 'job-m-fence'
        `).run();

        assert.throws(
          () => {
            liveStore.recordFrame({
              matchId: "m-live-fence",
              attemptNo: 2,
              leaseToken: "token-valid",
              ply: 1,
              frame: { ply: 1 }
            });
          },
          (err) => err instanceof FencedLiveFrameError && err.code === "LEASE_EXPIRED"
        );
      } finally {
        closeDatabase(db);
      }
    });

    it("deletes frames from past attempts when a newer valid attempt writes", () => {
      const { db } = createTestDb();
      try {
        const liveStore = createLiveFrameStore(db);

        db.prepare(`
          INSERT INTO matches (id, ladder_id, status, kind, ruleset_json, policy_json, profile_json, initial_state_json)
          VALUES ('m-live-clean', 'ladder-main', 'active', 'practice', '{}', '{}', '{}', '{}')
        `).run();

        db.prepare(`
          INSERT INTO jobs (id, kind, target_id, status, attempt_no, lease_owner, lease_token, lease_until)
          VALUES ('job-clean', 'match', 'm-live-clean', 'claimed', 1, 'worker-1', 'tok-1', datetime('now', '+60 seconds'))
        `).run();

        // Attempt 1 writes plies 0 and 1
        liveStore.recordFrame({ matchId: "m-live-clean", attemptNo: 1, leaseToken: "tok-1", ply: 0, frame: { ply: 0 } });
        liveStore.recordFrame({ matchId: "m-live-clean", attemptNo: 1, leaseToken: "tok-1", ply: 1, frame: { ply: 1 } });

        const countAtt1 = db.prepare("SELECT COUNT(*) AS count FROM match_live_frames WHERE match_id = 'm-live-clean' AND attempt_no = 1").get().count;
        assert.equal(countAtt1, 2);

        // Worker recovers/retries: job promoted to attempt 2
        db.prepare(`
          UPDATE jobs SET attempt_no = 2, lease_token = 'tok-2', lease_until = datetime('now', '+60 seconds')
          WHERE id = 'job-clean'
        `).run();

        // Attempt 2 writes ply 0
        liveStore.recordFrame({ matchId: "m-live-clean", attemptNo: 2, leaseToken: "tok-2", ply: 0, frame: { ply: 0, attempt: 2 } });

        // Verify attempt 1 frames were purged!
        const remainingAtt1 = db.prepare("SELECT COUNT(*) AS count FROM match_live_frames WHERE match_id = 'm-live-clean' AND attempt_no = 1").get().count;
        assert.equal(remainingAtt1, 0, "frames from previous attempts must be pruned when a newer valid attempt writes");

        const currentAtt2 = db.prepare("SELECT COUNT(*) AS count FROM match_live_frames WHERE match_id = 'm-live-clean' AND attempt_no = 2").get().count;
        assert.equal(currentAtt2, 1);
      } finally {
        closeDatabase(db);
      }
    });

    it("enforces physical storage retention bound per match preserving ply 0", () => {
      const { db } = createTestDb();
      try {
        // Live store with small bound: 4 frames max
        const liveStore = createLiveFrameStore(db, { maxRetainedFramesPerMatch: 4 });

        db.prepare(`
          INSERT INTO matches (id, ladder_id, status, kind, ruleset_json, policy_json, profile_json, initial_state_json)
          VALUES ('m-live-bound', 'ladder-main', 'active', 'practice', '{}', '{}', '{}', '{}')
        `).run();

        // Write plies 0 through 6 (total 7 frames)
        for (let p = 0; p <= 6; p++) {
          liveStore.recordFrame({
            matchId: "m-live-bound",
            attemptNo: 1,
            ply: p,
            frame: { ply: p }
          });
        }

        // Verify physical storage is bounded to exactly 4 rows
        const rows = db.prepare("SELECT ply FROM match_live_frames WHERE match_id = 'm-live-bound' ORDER BY ply ASC").all();
        assert.equal(rows.length, 4, "physical rows in match_live_frames must NOT exceed maxRetainedFramesPerMatch");

        const plies = rows.map((r) => r.ply);
        // Ply 0 (initial state) MUST be preserved, plus the latest 3 plies (4, 5, 6)
        assert.deepEqual(plies, [0, 4, 5, 6]);
      } finally {
        closeDatabase(db);
      }
    });

    it("paginated cursor returns lastReturnedPly preventing client from skipping gaps", () => {
      const { db } = createTestDb();
      try {
        const liveStore = createLiveFrameStore(db);

        db.prepare(`
          INSERT INTO matches (id, ladder_id, status, kind, ruleset_json, policy_json, profile_json, initial_state_json)
          VALUES ('m-live-gaps', 'ladder-main', 'active', 'practice', '{}', '{}', '{}', '{}')
        `).run();

        // Record plies 0..4
        for (let p = 0; p <= 4; p++) {
          liveStore.recordFrame({
            matchId: "m-live-gaps",
            attemptNo: 1,
            ply: p,
            frame: { ply: p }
          });
        }

        // Batch 1: fetch with limit 2 starting from afterPly -1
        const b1 = liveStore.getLiveFrames({ matchId: "m-live-gaps", afterPly: -1, limit: 2 });
        assert.equal(b1.frames.length, 2);
        assert.equal(b1.frames[0].ply, 0);
        assert.equal(b1.frames[1].ply, 1);
        assert.equal(b1.lastReturnedPly, 1);
        assert.equal(b1.currentPly, 4);

        // Batch 2: advance cursor to lastReturnedPly (1), fetch with limit 2
        const b2 = liveStore.getLiveFrames({ matchId: "m-live-gaps", afterPly: b1.lastReturnedPly, limit: 2 });
        assert.equal(b2.frames.length, 2);
        assert.equal(b2.frames[0].ply, 2);
        assert.equal(b2.frames[1].ply, 3);
        assert.equal(b2.lastReturnedPly, 3);
        assert.equal(b2.currentPly, 4);

        // Batch 3: advance cursor to lastReturnedPly (3), fetch with limit 2
        const b3 = liveStore.getLiveFrames({ matchId: "m-live-gaps", afterPly: b2.lastReturnedPly, limit: 2 });
        assert.equal(b3.frames.length, 1);
        assert.equal(b3.frames[0].ply, 4);
        assert.equal(b3.lastReturnedPly, 4);
        assert.equal(b3.currentPly, 4);
      } finally {
        closeDatabase(db);
      }
    });

    it("worker execution actively records incremental live frames with top-level clock before finalization and prunes upon completion", async () => {
      const { db } = createTestDb();
      try {
        const liveStore = createLiveFrameStore(db);
        const jobQueue = createJobQueue(db);
        const matchRepo = createMatchRepository(db);
        const finalizer = createMatchFinalizer(db);
        const botRepo = createBotRepository(db);

        seedUser(db, { id: "u-w1", username: "workeruser1" });
        seedUser(db, { id: "u-w2", username: "workeruser2" });
        seedBot(db, { id: "bot-w1", ownerId: "u-w1", name: "Worker Bot 1" });
        seedBot(db, { id: "bot-w2", ownerId: "u-w2", name: "Worker Bot 2" });

        botRepo.registerArtifact({ digest: "sha256:artw1", kind: "build", relativePrivatePath: "builds/w1", bytes: 100 });
        botRepo.registerArtifact({ digest: "sha256:artw2", kind: "build", relativePrivatePath: "builds/w2", bytes: 100 });
        botRepo.createVersion(
          { id: "v-w1", botId: "bot-w1", sourceDigest: "sha256:srcw1", profileId: "node", profileRevision: "v1" },
          { idempotencyKey: "k-vw1", actorId: "u-w1" }
        );
        botRepo.markVersionReady({ botVersionId: "v-w1", artifactDigest: "sha256:artw1" });
        botRepo.createVersion(
          { id: "v-w2", botId: "bot-w2", sourceDigest: "sha256:srcw2", profileId: "node", profileRevision: "v1" },
          { idempotencyKey: "k-vw2", actorId: "u-w2" }
        );
        botRepo.markVersionReady({ botVersionId: "v-w2", artifactDigest: "sha256:artw2" });

        const rulesetSnapshot = createCurrentRulesetSnapshot(coreConfig);
        const initialState = createMapState("classic");

        const match = matchRepo.createMatch({
          id: "m-worker-live-test",
          kind: "practice",
          ladderId: "ladder-main",
          ruleset: rulesetSnapshot,
          policy: {
            matchPolicyVersion: "arena-policy-v1",
            maxPlies: 400,
            initialTimeMs: 600000,
            turnTimeLimitMs: 1000,
            clockBoundary: "strict_less_than_budget",
            clockSource: "referee_monotonic"
          },
          profile: { id: "node" },
          initialState,
          participants: [
            { seat: "A", botVersionId: "v-w1" },
            { seat: "B", botVersionId: "v-w2" }
          ]
        });

        jobQueue.enqueueJob({
          id: "job-worker-live-test",
          kind: "match",
          targetId: match.id
        });

        let observedLiveDuringExecution = null;

        const makeBot = (botSeat) => ({
          async start() {},
          async requestMove(turn) {
            if (botSeat === "B") {
              // Observe live frames buffered so far (plies 0 and 1) before match finalization
              observedLiveDuringExecution = liveStore.getLiveFrames({ matchId: match.id, afterPly: -1 });
              // Return illegal move on seat B to conclude match normally with forfeit
              return {
                protocolVersion: 1,
                type: "action",
                requestId: turn.requestId,
                move: { from: { x: 0, y: 0 }, to: { x: 8, y: 8 } },
                comment: "forfeit on seat B"
              };
            }
            const move = turn.legalMoves[0];
            return {
              protocolVersion: 1,
              type: "action",
              requestId: turn.requestId,
              move: { from: { x: move.from.x, y: move.from.y }, to: { x: move.to.x, y: move.to.y } },
              comment: "opening move by seat A"
            };
          },
          async stop() {}
        });

        const worker = createJobWorker({
          workerId: "test-live-worker",
          db,
          jobQueue,
          matchRepo,
          finalizer,
          liveFrameStore: liveStore,
          botFactory: (seat) => makeBot(seat),
          allowedKinds: ["match"]
        });

        const runOutcome = await worker.runOnce();
        assert.equal(runOutcome.executed, true, "Worker should execute the match job");

        // 1. Verify incremental live frames WERE captured during match execution before finalization
        assert.ok(observedLiveDuringExecution, "Live frames must be observable mid-match before finalization");
        assert.equal(observedLiveDuringExecution.status, "running");
        assert.equal(observedLiveDuringExecution.terminal, false);
        assert.ok(observedLiveDuringExecution.frames.length >= 2, "Must contain ply 0 and ply 1");

        // Verify initial frame 0
        const frame0 = observedLiveDuringExecution.frames[0];
        assert.equal(frame0.ply, 0);
        assert.ok(frame0.clock, "Frame 0 must have top-level clock");
        assert.equal(frame0.clock.remainingMs.A, 600000);
        assert.equal(frame0.clock.remainingMs.B, 600000);

        // Verify ply 1 frame recorded by onAcceptedMove
        const frame1 = observedLiveDuringExecution.frames[1];
        assert.equal(frame1.ply, 1);
        assert.equal(frame1.seat, "A");
        assert.ok(frame1.move, "Frame 1 must contain accepted move");
        assert.ok(frame1.clock, "Frame 1 must contain top-level clock");
        assert.ok(typeof frame1.clock.remainingMs.A === "number");
        assert.ok(typeof frame1.clock.remainingMs.B === "number");
        assert.deepEqual(frame1.clock, frame1.state.clock, "Top-level clock must match state.clock");

        // 2. Verify that upon match finalization, live frames are pruned and replay redirect is returned
        const postFinalization = liveStore.getLiveFrames({ matchId: match.id, afterPly: -1 });
        assert.equal(postFinalization.status, "completed");
        assert.equal(postFinalization.terminal, true);
        assert.equal(postFinalization.replayUrl, `/api/arena/v1/matches/${match.id}/replay`);
        assert.equal(postFinalization.frames.length, 0, "Live frames must be pruned upon finalization");

        const remainingRows = db.prepare("SELECT COUNT(*) AS count FROM match_live_frames WHERE match_id = ?").get(match.id).count;
        assert.equal(remainingRows, 0, "Physical rows in match_live_frames must be 0 post-finalization");
      } finally {
        closeDatabase(db);
      }
    });
  });

  // ── 4. HTTP API Matrix ─────────────────────────────────────────────────────
  describe("4. HTTP API Endpoints (/draft/run & /matches/:id/live)", () => {
    let server;
    let db;
    let authorToken;
    let author2Token;
    let adminToken;

    before(async () => {
      const setup = createTestDb();
      db = setup.db;

      seedUser(db, { id: "u-api-author", username: "author", role: "author" });
      seedUser(db, { id: "u-api-author-2", username: "author2", role: "author" });
      seedUser(db, { id: "u-api-admin", username: "admin", role: "admin" });
      seedBot(db, { id: "bot-api-1", ownerId: "u-api-author", name: "Api Bot" });

      const session = createSession(db, "u-api-author");
      authorToken = session.token;
      const session2 = createSession(db, "u-api-author-2");
      author2Token = session2.token;
      adminToken = createSession(db, "u-api-admin").token;

      const profileRegistry = createProfileRegistry();
      const draftService = createDraftService({
        profileRegistry,
        trustedLocalMode: true,
        tempBaseDir: TEMP_BASE_DIR
      });
      const liveFrameStore = createLiveFrameStore(db);

      server = createArenaServer({
        db,
        profileRegistry,
        draftService,
        liveFrameStore,
        trustedMode: true
      });

      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    });

    after(async () => {
      await new Promise((resolve) => server.close(resolve));
      closeDatabase(db);
    });

    it("POST /api/arena/v1/bots/:id/draft/run rejects unauthenticated with HTTP 401", async () => {
      const res = await makeRequest(server, {
        method: "POST",
        path: "/api/arena/v1/bots/bot-api-1/draft/run"
      }, { source: "code", profileId: "node" });

      assert.equal(res.statusCode, 401);
    });

    it("POST /api/arena/v1/bots/:id/draft/run rejects a non-admin owner with HTTP 403 when drafts run on the host", async () => {
      const res = await makeRequest(server, {
        method: "POST",
        path: "/api/arena/v1/bots/bot-api-1/draft/run",
        headers: { Authorization: `Bearer ${authorToken}` }
      }, {
        source: "console.log('host');",
        profileId: "node"
      });

      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error.code, "SOURCE_SUBMISSION_DISABLED");
    });

    it("POST /api/arena/v1/bots/:id/draft/run lets an admin execute a trusted draft and returns 200 with diagnostics", async () => {
      const nodeCode = `
        process.stdin.setEncoding('utf8');
        let buf = '';
        process.stdin.on('data', d => {
          buf += d;
          const lines = buf.split('\\n');
          buf = lines.pop();
          for (const l of lines) {
            if (!l.trim()) continue;
            const msg = JSON.parse(l);
            if (msg.type === 'start') process.stdout.write(JSON.stringify({ type: 'ready' }) + '\\n');
            if (msg.type === 'turn') {
              process.stdout.write(JSON.stringify({
                protocolVersion: 1,
                type: 'action',
                requestId: msg.requestId,
                move: { from: { x: 4, y: 7 }, to: { x: 4, y: 8 } },
                comment: 'http draft move'
              }) + '\\n');
            }
          }
        });
      `;

      const res = await makeRequest(server, {
        method: "POST",
        path: "/api/arena/v1/bots/bot-api-1/draft/run",
        headers: { Authorization: `Bearer ${adminToken}` }
      }, {
        source: nodeCode,
        profileId: "node",
        mapId: "classic"
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.status, "success");
      assert.equal(res.body.isolation, "trusted-process");
      assert.equal(res.body.execution.legal, true);
      assert.equal(res.body.execution.comment, "http draft move");
    });

    it("POST /api/arena/v1/bots/:id/draft/run returns HTTP 503 ISOLATION_UNAVAILABLE when container isolation is required but unavailable", async () => {
      const profileRegistry = createProfileRegistry();
      const unavailDraftService = createDraftService({
        profileRegistry,
        trustedLocalMode: false,
        containerExecutor: { probe: () => ({ available: false, reason: "test_runtime_unavailable" }) },
        tempBaseDir: TEMP_BASE_DIR
      });
      const unavailServer = createArenaServer({
        db,
        profileRegistry,
        draftService: unavailDraftService,
        liveFrameStore: createLiveFrameStore(db),
        trustedMode: true
      });
      await new Promise((resolve) => unavailServer.listen(0, "127.0.0.1", resolve));
      try {
        const res = await makeRequest(unavailServer, {
          method: "POST",
          path: "/api/arena/v1/bots/bot-api-1/draft/run",
          headers: { Authorization: `Bearer ${authorToken}` }
        }, {
          source: "console.log('untrusted');",
          profileId: "node"
        });
        assert.equal(res.statusCode, 503);
        assert.equal(res.body.error.code, "ISOLATION_UNAVAILABLE");
      } finally {
        await new Promise((resolve) => unavailServer.close(resolve));
      }
    });

    it("POST /api/arena/v1/bots/:id/draft/run returns HTTP 429 CONCURRENCY_LIMIT_EXCEEDED when max concurrency exceeded", async () => {
      const profileRegistry = createProfileRegistry();
      const busyDraftService = createDraftService({
        profileRegistry,
        trustedLocalMode: true,
        maxConcurrentDrafts: 0,
        tempBaseDir: TEMP_BASE_DIR
      });
      const busyServer = createArenaServer({
        db,
        profileRegistry,
        draftService: busyDraftService,
        liveFrameStore: createLiveFrameStore(db),
        trustedMode: true
      });
      await new Promise((resolve) => busyServer.listen(0, "127.0.0.1", resolve));
      try {
        const res = await makeRequest(busyServer, {
          method: "POST",
          path: "/api/arena/v1/bots/bot-api-1/draft/run",
          headers: { Authorization: `Bearer ${adminToken}` }
        }, {
          source: "console.log('hi');",
          profileId: "node"
        });
        assert.equal(res.statusCode, 429);
        assert.equal(res.body.error.code, "CONCURRENCY_LIMIT_EXCEEDED");
      } finally {
        await new Promise((resolve) => busyServer.close(resolve));
      }
    });

    it("GET /api/arena/v1/matches/:id/live returns 200 with frames and cursor", async () => {
      // Seed running match with frame
      db.prepare(`
        INSERT INTO matches (id, ladder_id, status, kind, ruleset_json, policy_json, profile_json, initial_state_json)
        VALUES ('m-http-live', 'ladder-main', 'active', 'practice', '{}', '{}', '{}', '{}')
      `).run();

      const liveStore = createLiveFrameStore(db);
      liveStore.recordFrame({
        matchId: "m-http-live",
        attemptNo: 1,
        ply: 0,
        frame: { ply: 0, test: "opening" }
      });

      const res = await makeRequest(server, {
        method: "GET",
        path: "/api/arena/v1/matches/m-http-live/live?afterPly=-1",
        headers: { Authorization: `Bearer ${authorToken}` }
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.matchId, "m-http-live");
      assert.equal(res.body.status, "running");
      assert.equal(res.body.frames.length, 1);
      assert.equal(res.body.frames[0].ply, 0);
    });

    it("POST /api/arena/v1/bots/:id/draft/run returns HTTP 403 OWNERSHIP_MISMATCH when non-owner author runs draft", async () => {
      const res = await makeRequest(server, {
        method: "POST",
        path: "/api/arena/v1/bots/bot-api-1/draft/run",
        headers: { Authorization: `Bearer ${author2Token}` }
      }, {
        source: "process.stdout.write('{}');",
        profileId: "node"
      });

      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error.code, "OWNERSHIP_MISMATCH");
      assert.match(res.body.error.message, /belongs to/);
    });

    it("GET /api/arena/v1/matches/:id/live parses and respects limit query param with meaningful invalid bounds", async () => {
      // Seed a running match with 5 sequential frames (ply 0 to 4)
      db.prepare(`
        INSERT INTO matches (id, ladder_id, status, kind, ruleset_json, policy_json, profile_json, initial_state_json)
        VALUES ('m-http-limit-test', 'ladder-main', 'active', 'practice', '{}', '{}', '{}', '{}')
      `).run();

      const liveStore = createLiveFrameStore(db);
      for (let p = 0; p < 5; p++) {
        liveStore.recordFrame({
          matchId: "m-http-limit-test",
          attemptNo: 1,
          ply: p,
          frame: { ply: p, data: `frame-${p}` }
        });
      }

      // 1. Valid limit within range (limit=2) -> exactly 2 frames
      const resValid = await makeRequest(server, {
        method: "GET",
        path: "/api/arena/v1/matches/m-http-limit-test/live?afterPly=-1&limit=2",
        headers: { Authorization: `Bearer ${authorToken}` }
      });
      assert.equal(resValid.statusCode, 200);
      assert.equal(resValid.body.frames.length, 2, "Expected limit=2 to return 2 frames");
      assert.equal(resValid.body.lastReturnedPly, 1);

      // 2. Invalid low bound (limit=0) -> clamped to minimum (1 frame)
      const resZero = await makeRequest(server, {
        method: "GET",
        path: "/api/arena/v1/matches/m-http-limit-test/live?afterPly=-1&limit=0",
        headers: { Authorization: `Bearer ${authorToken}` }
      });
      assert.equal(resZero.statusCode, 200);
      assert.equal(resZero.body.frames.length, 1, "Expected limit=0 to be clamped to 1 frame");
      assert.equal(resZero.body.lastReturnedPly, 0);

      // 3. Invalid negative bound (limit=-10) -> clamped to minimum (1 frame)
      const resNeg = await makeRequest(server, {
        method: "GET",
        path: "/api/arena/v1/matches/m-http-limit-test/live?afterPly=-1&limit=-10",
        headers: { Authorization: `Bearer ${authorToken}` }
      });
      assert.equal(resNeg.statusCode, 200);
      assert.equal(resNeg.body.frames.length, 1, "Expected limit=-10 to be clamped to 1 frame");

      // 4. Invalid high bound (limit=999) -> clamped to 250 (returns all 5 available frames)
      const resHigh = await makeRequest(server, {
        method: "GET",
        path: "/api/arena/v1/matches/m-http-limit-test/live?afterPly=-1&limit=999",
        headers: { Authorization: `Bearer ${authorToken}` }
      });
      assert.equal(resHigh.statusCode, 200);
      assert.equal(resHigh.body.frames.length, 5, "Expected limit=999 to return all 5 available frames");
      assert.equal(resHigh.body.lastReturnedPly, 4);

      // 5. Invalid non-numeric NaN (limit=invalid) -> safe fallback to default limit (returns 5 frames)
      const resNaN = await makeRequest(server, {
        method: "GET",
        path: "/api/arena/v1/matches/m-http-limit-test/live?afterPly=-1&limit=invalid",
        headers: { Authorization: `Bearer ${authorToken}` }
      });
      assert.equal(resNaN.statusCode, 200);
      assert.equal(resNaN.body.frames.length, 5, "Expected limit=invalid to fall back to default limit");

      // 6. Fractional string (limit=1.5) -> parseInt truncates to 1
      const resFrac = await makeRequest(server, {
        method: "GET",
        path: "/api/arena/v1/matches/m-http-limit-test/live?afterPly=-1&limit=1.5",
        headers: { Authorization: `Bearer ${authorToken}` }
      });
      assert.equal(resFrac.statusCode, 200);
      assert.equal(resFrac.body.frames.length, 1, "Expected limit=1.5 to truncate to 1 frame via parseInt");
      assert.equal(resFrac.body.lastReturnedPly, 0);

      // 7. Suffixed string (limit=2junk) -> parseInt truncates to 2
      const resSuffix = await makeRequest(server, {
        method: "GET",
        path: "/api/arena/v1/matches/m-http-limit-test/live?afterPly=-1&limit=2junk",
        headers: { Authorization: `Bearer ${authorToken}` }
      });
      assert.equal(resSuffix.statusCode, 200);
      assert.equal(resSuffix.body.frames.length, 2, "Expected limit=2junk to parse prefix integer 2");
      assert.equal(resSuffix.body.lastReturnedPly, 1);
    });

    it("startArenaService on fresh database applies migration 004 and initializes live frame store", async () => {
      const freshDbPath = path.resolve(TEMP_BASE_DIR, `fresh-srv-${Date.now()}.sqlite`);
      const freshSrv = await startArenaService({
        dbPath: freshDbPath,
        port: 0,
        bind: "127.0.0.1",
        externalWorker: true
      });

      try {
        // Verify migration 004 applied
        const mig = freshSrv.db.prepare("SELECT version FROM schema_migrations WHERE version = '004-arena-live-frames'").get();
        assert.ok(mig, "Migration 004-arena-live-frames must be recorded in schema_migrations on fresh start");

        // Verify live frame table exists
        const table = freshSrv.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'match_live_frames'").get();
        assert.ok(table, "Table match_live_frames must exist on fresh start");

        // Querying live frames returns 404 (NOT_FOUND) instead of 503 (SERVICE_UNAVAILABLE)
        seedUser(freshSrv.db, { id: "usr-fresh-admin", username: "freshadmin", role: "admin" });
        const token = createSession(freshSrv.db, "usr-fresh-admin").token;
        const res = await makeRequest(freshSrv.server, {
          method: "GET",
          path: "/api/arena/v1/matches/non-existent-match/live",
          headers: { Authorization: `Bearer ${token}` }
        });
        assert.notEqual(res.statusCode, 503, "Live endpoint must not return 503 SERVICE_UNAVAILABLE on fresh service start");
        assert.equal(res.statusCode, 404);
      } finally {
        await freshSrv.stop();
      }
    });

    it("startArenaService closes database connection when server startup throws (exception safety)", async () => {
      const crashDbPath = path.resolve(TEMP_BASE_DIR, `crash-db-${Date.now()}.sqlite`);

      await assert.rejects(
        startArenaService({
          dbPath: crashDbPath,
          port: -1, // Invalid port causes server.listen to throw/reject
          bind: "127.0.0.1",
          externalWorker: true
        }),
        /port should be >= 0/
      );

      // Verify DB was properly closed: we should be able to open and unlink it without lock issues
      const { db: reopenDb } = openDatabase(crashDbPath);
      closeDatabase(reopenDb);
      assert.doesNotThrow(() => {
        fs.unlinkSync(crashDbPath);
      }, "Database file must not be locked by a leaked handle after startup rejection");
    });

    it("GET /api/arena/v1/capabilities reflects server trustedMode while preserving failclosed untrusted and author submission gates", async () => {
      // 1. In trusted mode (default test server)
      const resTrusted = await makeRequest(server, {
        method: "GET",
        path: "/api/arena/v1/capabilities"
      });
      assert.equal(resTrusted.statusCode, 200);
      assert.equal(resTrusted.body.trusted, true);
      assert.equal(resTrusted.body.untrusted, false);
      assert.equal(resTrusted.body.canSubmitSource, false);
      assert.ok(resTrusted.body.profiles.includes("node"));

      // 2. In untrusted mode: trusted becomes false, but untrusted and canSubmitSource remain strictly failclosed (false)
      const untrustedServer = createArenaServer({
        db,
        trustedMode: false,
        profileRegistry: createProfileRegistry()
      });
      await new Promise((resolve) => untrustedServer.listen(0, "127.0.0.1", resolve));
      try {
        const resUntrusted = await makeRequest(untrustedServer, {
          method: "GET",
          path: "/api/arena/v1/capabilities"
        });
        assert.equal(resUntrusted.statusCode, 200);
        assert.equal(resUntrusted.body.trusted, false);
        assert.equal(resUntrusted.body.untrusted, false, "Must not grant untrusted capability without container verification");
        assert.equal(resUntrusted.body.canSubmitSource, false, "Author submission must remain failclosed");
      } finally {
        await new Promise((resolve) => untrustedServer.close(resolve));
      }
    });
  });
});
