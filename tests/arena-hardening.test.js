/**
 * tests/arena-hardening.test.js
 *
 * Targeted regression tests for backend audit hardening fixes:
 * 1. Strict full SHA256 digest validation in ArtifactStore (no filesystem access on malformed digest).
 * 2. Bot ID format validation (reject empty, non-string, slashes, whitespace; preserve generated IDs).
 * 3. Match schedule upfront validation of policy and initial core state (no match or job rows inserted on invalid input).
 * 4. Bounded login rate limiting (hard Map cap under burst, cross-username same-peer throttle, independent peers, expiry).
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Artifact store
import { createArtifactStore } from "../packages/arena-node/src/artifacts/artifact-store.mjs";

// Database & Repositories
import { openDatabase, closeDatabase } from "../packages/arena-node/src/persistence/sqlite-database.mjs";
import { createBotRepository } from "../packages/arena-node/src/persistence/bot-repository.mjs";
import { createMatchRepository } from "../packages/arena-node/src/persistence/match-repository.mjs";
import { createNodeEngine, coreConfig } from "../packages/arena-node/src/core/node-engine.mjs";
import {
  DEFAULT_MATCH_POLICY,
  createCurrentRulesetSnapshot,
  validateMatchPolicy,
  checkInitialState
} from "../packages/arena/src/contracts/index.mjs";

// Rate limiting and accounts
import {
  checkLoginRateLimit,
  recordLoginFailure,
  resetLoginFailure,
  _getRateLimitMapSize,
  _clearRateLimitsForTesting,
  MAX_TRACKED_ENTRIES,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_USER_MAX_FAILURES,
  RATE_LIMIT_PEER_MAX_FAILURES,
  hashPassword
} from "../apps/arena-api/src/auth/accounts.mjs";

// HTTP Server
import { createArenaServer } from "../apps/arena-api/src/http-server.mjs";

// Helper for HTTP requests
function makeRequest(server, options, payload = null) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const reqOptions = {
      hostname: "127.0.0.1",
      port: addr.port,
      path: options.path,
      method: options.method || "GET",
      headers: { ...(options.headers || {}) }
    };

    let bodyStr = null;
    if (payload !== null) {
      bodyStr = typeof payload === "string" ? payload : JSON.stringify(payload);
      reqOptions.headers["Content-Type"] = "application/json";
      reqOptions.headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }

    const req = http.request(reqOptions, (res) => {
      let rawData = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        rawData += chunk;
      });
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(rawData);
        } catch (_) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: rawData,
          json
        });
      });
    });

    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

describe("Backend Audit Hardening Regression Suite", () => {
  // ── 1. ArtifactStore Strict Digest Hardening ──────────────────────────────
  describe("ArtifactStore Digest Hardening", () => {
    let tmpDir;
    let store;

    before(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "artifact-hardening-test-"));
      store = createArtifactStore({ storageRoot: tmpDir });
    });

    after(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    const malformedDigests = [
      "sha256:../../../../package.json",
      "sha256:..\\..\\..\\..\\package.json",
      "sha256:abc",
      "sha256:" + "0".repeat(63), // 63 chars (too short)
      "sha256:" + "0".repeat(65), // 65 chars (too long)
      "sha256:" + "G".repeat(64), // uppercase / non-hex
      "md5:d41d8cd98f00b204e9800998ecf8427e",
      "",
      null,
      undefined,
      12345
    ];

    for (const badDigest of malformedDigests) {
      it(`resolveArtifact returns null without FS probe for malformed digest: ${JSON.stringify(badDigest)}`, async () => {
        const result = await store.resolveArtifact(badDigest);
        assert.equal(result, null);
      });

      it(`verifyDigest returns false without FS probe for malformed digest: ${JSON.stringify(badDigest)}`, async () => {
        const result = await store.verifyDigest(badDigest);
        assert.equal(result, false);
      });

      it(`getManifest returns null without FS probe for malformed digest: ${JSON.stringify(badDigest)}`, async () => {
        const result = await store.getManifest(badDigest);
        assert.equal(result, null);
      });

      it(`getArtifactPath throws TypeError without FS probe for malformed digest: ${JSON.stringify(badDigest)}`, () => {
        assert.throws(
          () => store.getArtifactPath(badDigest),
          (err) => err instanceof TypeError && err.message.includes("Invalid SHA-256 digest format")
        );
      });
    }

    it("accepts valid full lowercase 64-char sha256 digest", () => {
      const validDigest = "sha256:" + "a".repeat(64);
      const artifactPath = store.getArtifactPath(validDigest);
      assert.ok(artifactPath.includes("a".repeat(62)));
    });
  });

  // ── 2. Bot ID Format Hardening ───────────────────────────────────────────
  describe("Bot ID Validation Hardening", () => {
    let tmpDir;
    let db;
    let botRepo;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "bot-hardening-"));
      const dbPath = join(tmpDir, "arena.db");
      const res = openDatabase(dbPath);
      db = res.db;
      botRepo = createBotRepository(db);
      // Seed a user
      db.prepare("INSERT INTO users (id, normalized_username, role, password_hash) VALUES (?, ?, ?, ?)").run(
        "usr-1",
        "alice",
        "author",
        "hash"
      );
    });

    afterEach(() => {
      closeDatabase(db);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    const invalidBotIds = [
      "",
      "   ",
      "bot/with/slashes",
      "bot\\with\\backslashes",
      "bot with spaces",
      "bot@name!",
      "a".repeat(65) // exceeds 64 chars
    ];

    for (const badId of invalidBotIds) {
      it(`botRepo.createBot rejects invalid ID format: ${JSON.stringify(badId)}`, () => {
        assert.throws(
          () =>
            botRepo.createBot(
              {
                id: badId,
                ownerId: "usr-1",
                name: "Test Bot"
              },
              { idempotencyKey: `bad-id-${Math.random()}`, actorId: "usr-1" }
            ),
          (err) => err instanceof TypeError && err.message.includes("Invalid bot id format")
        );
      });
    }

    it("botRepo.createBot rejects non-string ID", () => {
      assert.throws(
        () =>
          botRepo.createBot(
            {
              id: 12345,
              ownerId: "usr-1",
              name: "Test Bot"
            },
            { idempotencyKey: "non-string-id", actorId: "usr-1" }
          ),
        (err) => err instanceof TypeError
      );
    });

    it("botRepo.createBot rejects missing ID (id is required by contract)", () => {
      assert.throws(
        () =>
          botRepo.createBot(
            {
              ownerId: "usr-1",
              name: "Missing ID Bot"
            },
            { idempotencyKey: "missing-id-key", actorId: "usr-1" }
          ),
        (err) => err instanceof TypeError && err.message.includes("Bot id must be a string")
      );
    });

    it("botRepo.createBot accepts valid alphanumeric, hyphen, and underscore IDs", () => {
      const bot = botRepo.createBot(
        {
          id: "valid_bot-123",
          ownerId: "usr-1",
          name: "Valid Bot"
        },
        { idempotencyKey: "valid-id-key", actorId: "usr-1" }
      );
      assert.equal(bot.id, "valid_bot-123");
    });
  });

  // ── 3. Match Scheduling Upfront Validation ────────────────────────────────
  describe("Match Scheduling Upfront Validation Hardening", () => {
    let tmpDir;
    let db;
    let server;
    let authorToken;
    let adminToken;
    let botVersionIdA;
    let botVersionIdB;

    before(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), "match-hardening-"));
      const dbPath = join(tmpDir, "arena.db");
      const res = openDatabase(dbPath);
      db = res.db;

      // Seed users
      const authorHash = hashPassword("AuthorSecret123!");
      db.prepare("INSERT INTO users (id, normalized_username, role, password_hash) VALUES (?, ?, ?, ?)").run(
        "usr-author",
        "match-author",
        "author",
        authorHash
      );
      const adminHash = hashPassword("AdminSecret123!");
      db.prepare("INSERT INTO users (id, normalized_username, role, password_hash) VALUES (?, ?, ?, ?)").run(
        "usr-admin",
        "match-admin",
        "admin",
        adminHash
      );

      // Seed bots & ready bot versions
      const botRepo = createBotRepository(db);
      const userAuthor = db.prepare("SELECT id FROM users WHERE normalized_username = 'match-author'").get();
      const botA = botRepo.createBot(
        { id: "bot-sched-a", ownerId: userAuthor.id, name: "Bot A" },
        { idempotencyKey: "bot-a-key", actorId: userAuthor.id }
      );
      const botB = botRepo.createBot(
        { id: "bot-sched-b", ownerId: userAuthor.id, name: "Bot B" },
        { idempotencyKey: "bot-b-key", actorId: userAuthor.id }
      );

      const digestA = "sha256:" + "a".repeat(64);
      const digestB = "sha256:" + "b".repeat(64);
      const srcDigestA = "sha256:" + "1".repeat(64);
      const srcDigestB = "sha256:" + "2".repeat(64);

      botRepo.registerArtifact({
        digest: digestA,
        kind: "build",
        relativePrivatePath: "builds/aa/sample",
        bytes: 128
      });
      botRepo.registerArtifact({
        digest: digestB,
        kind: "build",
        relativePrivatePath: "builds/bb/sample",
        bytes: 128
      });

      const verA = botRepo.createVersion(
        {
          id: "ver-sched-a",
          botId: botA.id,
          sourceDigest: srcDigestA,
          profileId: "controlled-node",
          profileRevision: "node-v1"
        },
        { idempotencyKey: "ver-a-key", actorId: userAuthor.id }
      );
      botRepo.markVersionReady({ botVersionId: verA.id, artifactDigest: digestA });
      botVersionIdA = verA.id;

      const verB = botRepo.createVersion(
        {
          id: "ver-sched-b",
          botId: botB.id,
          sourceDigest: srcDigestB,
          profileId: "controlled-node",
          profileRevision: "node-v1"
        },
        { idempotencyKey: "ver-b-key", actorId: userAuthor.id }
      );
      botRepo.markVersionReady({ botVersionId: verB.id, artifactDigest: digestB });
      botVersionIdB = verB.id;

      server = createArenaServer({
        db,
        allowedOrigins: ["http://localhost:5173"]
      });
      await new Promise((resolve) => server.listen(0, resolve));

      // Login to obtain author and admin tokens
      const authorLogin = await makeRequest(
        server,
        { path: "/api/arena/v1/auth/login", method: "POST" },
        { username: "match-author", password: "AuthorSecret123!" }
      );
      authorToken = authorLogin.json.token;

      const adminLogin = await makeRequest(
        server,
        { path: "/api/arena/v1/auth/login", method: "POST" },
        { username: "match-admin", password: "AdminSecret123!" }
      );
      adminToken = adminLogin.json.token;
    });

    after(async () => {
      await new Promise((resolve) => server.close(resolve));
      closeDatabase(db);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("rejects invalid match policy upfront with HTTP 422 and inserts ZERO match or job rows", async () => {
      const initialMatches = db.prepare("SELECT COUNT(*) AS count FROM matches").get().count;
      const initialJobs = db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count;

      const badPolicyPayload = {
        kind: "practice",
        idempotencyKey: "bad-policy-test-1",
        participants: {
          A: { botVersionId: botVersionIdA },
          B: { botVersionId: botVersionIdB }
        },
        policy: {
          matchPolicyVersion: "arena-policy-v1",
          maxPlies: 400,
          initialTimeMs: 600000,
          turnTimeLimitMs: -50, // NEGATIVE turn limit!
          clockBoundary: "strict_less_than_budget",
          clockSource: "referee_monotonic"
        }
      };

      const res = await makeRequest(
        server,
        {
          path: "/api/arena/v1/matches",
          method: "POST",
          headers: {
            Authorization: `Bearer ${authorToken}`,
            "Idempotency-Key": "bad-policy-test-1"
          }
        },
        badPolicyPayload
      );

      assert.equal(res.statusCode, 422);
      assert.equal(res.json?.error?.code, "VALIDATION_ERROR");
      assert.ok(res.json?.error?.message.includes("turnTimeLimitMs must be a positive integer"));

      // Verify ZERO rows inserted into matches or jobs
      const finalMatches = db.prepare("SELECT COUNT(*) AS count FROM matches").get().count;
      const finalJobs = db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count;
      assert.equal(finalMatches, initialMatches, "No match row must be inserted on policy error");
      assert.equal(finalJobs, initialJobs, "No job row must be inserted on policy error");
    });

    it("rejects invalid initial game state upfront with HTTP 422 and inserts ZERO match or job rows", async () => {
      const initialMatches = db.prepare("SELECT COUNT(*) AS count FROM matches").get().count;
      const initialJobs = db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count;

      const corruptStatePayload = {
        kind: "practice",
        idempotencyKey: "corrupt-state-test-1",
        participants: {
          A: { botVersionId: botVersionIdA },
          B: { botVersionId: botVersionIdB }
        },
        initialState: {
          turn: "A",
          winner: null,
          reason: null,
          eliminatedPlayer: null,
          clock: {
            remainingMs: { A: 600000, B: 600000 },
            runningSeat: null
          },
          pieces: [
            // Overlapping pieces on (0, 0)
            { id: "p1", player: "A", type: "dam", x: 0, y: 0 },
            { id: "p2", player: "B", type: "la", x: 0, y: 0 }
          ]
        }
      };

      const res = await makeRequest(
        server,
        {
          path: "/api/arena/v1/matches",
          method: "POST",
          headers: {
            Authorization: `Bearer ${authorToken}`,
            "Idempotency-Key": "corrupt-state-test-1"
          }
        },
        corruptStatePayload
      );

      assert.equal(res.statusCode, 422);
      assert.equal(res.json?.error?.code, "VALIDATION_ERROR");
      assert.ok(res.json?.error?.message.includes("duplicate_cell_occupancy"));

      // Verify ZERO rows inserted into matches or jobs
      const finalMatches = db.prepare("SELECT COUNT(*) AS count FROM matches").get().count;
      const finalJobs = db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count;
      assert.equal(finalMatches, initialMatches, "No match row must be inserted on corrupt state");
      assert.equal(finalJobs, initialJobs, "No job row must be inserted on corrupt state");
    });
  });

  // ── 4. Bounded Login Rate Limiting Hardening ──────────────────────────────
  describe("Bounded Login Rate Limiting Hardening", () => {
    beforeEach(() => {
      _clearRateLimitsForTesting();
    });

    it("enforces strict hard map cap: 1,500 burst failed logins never exceed MAX_TRACKED_ENTRIES", () => {
      for (let i = 0; i < 1500; i++) {
        recordLoginFailure({ username: `burst_user_${i}`, peerIp: `10.0.${Math.floor(i / 250)}.${i % 250}` });
      }

      const mapSize = _getRateLimitMapSize();
      assert.ok(
        mapSize <= MAX_TRACKED_ENTRIES,
        `Rate limit map size ${mapSize} must not exceed hard cap of ${MAX_TRACKED_ENTRIES}`
      );
    });

    it("cross-username same-peer throttle: 20 failed attempts from same peer blocks subsequent attempts (HTTP 429)", () => {
      const peer = "192.168.1.50";

      // 20 failed logins with 20 different usernames from same peer
      for (let i = 0; i < RATE_LIMIT_PEER_MAX_FAILURES; i++) {
        const check = checkLoginRateLimit({ username: `victim_${i}`, peerIp: peer });
        assert.equal(check.allowed, true, `Attempt ${i + 1} should be allowed before reaching limit`);
        recordLoginFailure({ username: `victim_${i}`, peerIp: peer });
      }

      // 21st attempt from same peer with yet another username must be BLOCKED
      const sprayCheck = checkLoginRateLimit({ username: "victim_21", peerIp: peer });
      assert.equal(sprayCheck.allowed, false, "Same peer spraying multiple usernames must be blocked");
      assert.ok(sprayCheck.retryAfterSeconds > 0);
    });

    it("independent peers are not affected by another peer's throttle", () => {
      const badPeer = "10.10.10.1";
      const goodPeer = "10.10.10.2";

      // Throttle badPeer
      for (let i = 0; i < RATE_LIMIT_PEER_MAX_FAILURES; i++) {
        recordLoginFailure({ username: `spray_${i}`, peerIp: badPeer });
      }

      // badPeer is blocked
      assert.equal(checkLoginRateLimit({ username: "target", peerIp: badPeer }).allowed, false);

      // goodPeer is NOT blocked
      assert.equal(checkLoginRateLimit({ username: "target", peerIp: goodPeer }).allowed, true);
    });

    it("login success resets user failure count but does not clear peer throttling", () => {
      const peer = "172.16.0.5";
      const user = "alice";

      // 4 failed attempts for alice
      for (let i = 0; i < 4; i++) {
        recordLoginFailure({ username: user, peerIp: peer });
      }

      // Before success: alice has 1 remaining attempt
      const checkBefore = checkLoginRateLimit({ username: user, peerIp: peer });
      assert.equal(checkBefore.allowed, true);
      assert.equal(checkBefore.remainingAttempts, 1);

      // Successful login resets user failures
      resetLoginFailure({ username: user, peerIp: peer });

      // After success: alice has full attempts restored
      const checkAfter = checkLoginRateLimit({ username: user, peerIp: peer });
      assert.equal(checkAfter.allowed, true);
      assert.equal(checkAfter.remainingAttempts, RATE_LIMIT_USER_MAX_FAILURES);
    });
  });
});
