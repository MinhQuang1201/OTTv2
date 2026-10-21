/**
 * tests/arena-api-ready-versions.test.js
 *
 * Integration tests for additive authenticated GET /api/arena/v1/bots/:id/ready-versions.
 * Verifies:
 * - Opponent author can read public READY versions (returns 200).
 * - Full GET /bots/:id/versions remains HTTP 403 OWNERSHIP_DENIED for non-owners.
 * - Public metadata ONLY: id, botId, versionNo, profileId, buildStatus: 'ready', createdAt.
 *   No source, log, digest, or private metadata.
 * - Inactive or suspended bots return HTTP 404.
 * - Non-existent bots return HTTP 404.
 * - Non-GET methods return HTTP 405 with Allow: GET.
 * - Spectator role can also read public ready versions metadata.
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const { createHash } = require("node:crypto");

const TEMP_BASE_DIR = path.resolve(os.tmpdir(), "arena-ready-versions-test-" + Date.now());

let openDatabase;
let closeDatabase;
let createBotRepository;
let hashPassword;
let createSession;
let createArenaServer;

function sha256Digest(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
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

describe("GET /api/arena/v1/bots/:id/ready-versions", () => {
  let env;
  let server;
  let author1Token;
  let author2Token;
  let spectatorToken;

  before(async () => {
    fs.mkdirSync(TEMP_BASE_DIR, { recursive: true });

    const dbMod = await import("../packages/arena-node/src/persistence/sqlite-database.mjs");
    openDatabase = dbMod.openDatabase;
    closeDatabase = dbMod.closeDatabase;

    const botRepoMod = await import("../packages/arena-node/src/persistence/bot-repository.mjs");
    createBotRepository = botRepoMod.createBotRepository;

    const accountsMod = await import("../apps/arena-api/src/auth/accounts.mjs");
    hashPassword = accountsMod.hashPassword;
    createSession = accountsMod.createSession;

    const serverMod = await import("../apps/arena-api/src/http-server.mjs");
    createArenaServer = serverMod.createArenaServer;

    const dbPath = path.join(TEMP_BASE_DIR, "ready-versions.db");
    const { db } = openDatabase(dbPath);
    const botRepo = createBotRepository(db);

    // Seed users
    botRepo.createUser({
      id: "u-alice",
      normalizedUsername: "alice",
      passwordHash: hashPassword("alicepass123"),
      role: "author"
    });
    botRepo.createUser({
      id: "u-bob",
      normalizedUsername: "bob",
      passwordHash: hashPassword("bobpass123"),
      role: "author"
    });
    botRepo.createUser({
      id: "u-spectator",
      normalizedUsername: "spectator",
      passwordHash: hashPassword("specpass123"),
      role: "author"
    });

    author1Token = createSession(db, "u-alice").token;
    author2Token = createSession(db, "u-bob").token;
    spectatorToken = createSession(db, "u-spectator").token;

    // Seed Alice's bot (active) with multiple versions
    botRepo.createBot({ id: "bot-alice-main", ownerId: "u-alice", name: "AliceBot" }, { idempotencyKey: "k-b1", actorId: "u-alice" });
    
    // Version 1: ready
    botRepo.createVersion(
      { id: "ver-alice-v1", botId: "bot-alice-main", sourceDigest: sha256Digest("src1"), profileId: "controlled-node", profileRevision: "node-v1" },
      { idempotencyKey: "k-v1", actorId: "u-alice" }
    );
    botRepo.markVersionReady({ botVersionId: "ver-alice-v1", artifactDigest: sha256Digest("art1"), buildLog: "Build v1 OK" });

    // Version 2: building / pending
    botRepo.createVersion(
      { id: "ver-alice-v2", botId: "bot-alice-main", sourceDigest: sha256Digest("src2"), profileId: "controlled-node", profileRevision: "node-v1" },
      { idempotencyKey: "k-v2", actorId: "u-alice" }
    );

    // Version 3: failed
    botRepo.createVersion(
      { id: "ver-alice-v3", botId: "bot-alice-main", sourceDigest: sha256Digest("src3"), profileId: "controlled-node", profileRevision: "node-v1" },
      { idempotencyKey: "k-v3", actorId: "u-alice" }
    );
    botRepo.markVersionFailed({ botVersionId: "ver-alice-v3", buildLog: "SyntaxError: Unexpected token" });

    // Version 4: ready
    botRepo.createVersion(
      { id: "ver-alice-v4", botId: "bot-alice-main", sourceDigest: sha256Digest("src4"), profileId: "python-v1", profileRevision: "py-v1" },
      { idempotencyKey: "k-v4", actorId: "u-alice" }
    );
    botRepo.markVersionReady({ botVersionId: "ver-alice-v4", artifactDigest: sha256Digest("art4"), buildLog: "Build v4 OK" });

    // Seed Alice's suspended/inactive bot
    botRepo.createBot({ id: "bot-alice-suspended", ownerId: "u-alice", name: "OldSuspendedBot" }, { idempotencyKey: "k-b2", actorId: "u-alice" });
    db.prepare("UPDATE bots SET status = 'suspended' WHERE id = 'bot-alice-suspended'").run();
    botRepo.createVersion(
      { id: "ver-suspended-v1", botId: "bot-alice-suspended", sourceDigest: sha256Digest("src-s"), profileId: "controlled-node", profileRevision: "node-v1" },
      { idempotencyKey: "k-vs1", actorId: "u-alice" }
    );
    botRepo.markVersionReady({ botVersionId: "ver-suspended-v1", artifactDigest: sha256Digest("art-s"), buildLog: "OK" });

    server = createArenaServer({
      db,
      allowedOrigins: ["http://127.0.0.1:3000"],
      botRepo
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    env = { db };
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (env?.db) {
      closeDatabase(env.db);
    }
    try {
      fs.rmSync(TEMP_BASE_DIR, { recursive: true, force: true });
    } catch (_) {}
  });

  it("allows opponent author to read public READY versions (HTTP 200)", async () => {
    // Bob (u-bob) queries Alice's bot (bot-alice-main) ready-versions
    const res = await makeRequest(server, {
      path: "/api/arena/v1/bots/bot-alice-main/ready-versions",
      method: "GET",
      headers: { Authorization: `Bearer ${author2Token}` }
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.json);
    assert.ok(Array.isArray(res.json.versions));
    assert.equal(res.json.versions.length, 2);

    const v1 = res.json.versions.find((v) => v.id === "ver-alice-v1");
    assert.ok(v1);
    assert.equal(v1.botId, "bot-alice-main");
    assert.equal(v1.versionNo, 1);
    assert.equal(v1.profileId, "controlled-node");
    assert.equal(v1.buildStatus, "ready");
    assert.ok(v1.createdAt);

    // Strictly NO private fields/digests/logs
    assert.equal(v1.source, undefined);
    assert.equal(v1.sourceDigest, undefined);
    assert.equal(v1.artifactDigest, undefined);
    assert.equal(v1.buildLog, undefined);
    assert.equal(v1.profileRevision, undefined);

    const v4 = res.json.versions.find((v) => v.id === "ver-alice-v4");
    assert.ok(v4);
    assert.equal(v4.versionNo, 4);
    assert.equal(v4.profileId, "python-v1");
    assert.equal(v4.buildStatus, "ready");

    // Unready versions (ver-alice-v2 and ver-alice-v3) must NOT be included
    assert.equal(res.json.versions.some((v) => v.id === "ver-alice-v2"), false);
    assert.equal(res.json.versions.some((v) => v.id === "ver-alice-v3"), false);
  });

  it("keeps full GET /api/arena/v1/bots/:id/versions restricted to owner (HTTP 403 for opponent)", async () => {
    // Bob queries Alice's full versions endpoint -> 403 OWNERSHIP_DENIED
    const opponentRes = await makeRequest(server, {
      path: "/api/arena/v1/bots/bot-alice-main/versions",
      method: "GET",
      headers: { Authorization: `Bearer ${author2Token}` }
    });

    assert.equal(opponentRes.statusCode, 403);
    assert.equal(opponentRes.json.error.code, "OWNERSHIP_DENIED");

    // Alice queries her own full versions endpoint -> 200 with full data (including logs and digests)
    const ownerRes = await makeRequest(server, {
      path: "/api/arena/v1/bots/bot-alice-main/versions",
      method: "GET",
      headers: { Authorization: `Bearer ${author1Token}` }
    });

    assert.equal(ownerRes.statusCode, 200);
    assert.equal(ownerRes.json.versions.length, 4);
    assert.ok(ownerRes.json.versions[0].sourceDigest);
  });

  it("allows spectator role to read public ready versions", async () => {
    const res = await makeRequest(server, {
      path: "/api/arena/v1/bots/bot-alice-main/ready-versions",
      method: "GET",
      headers: { Authorization: `Bearer ${spectatorToken}` }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json.versions.length, 2);
  });

  it("returns HTTP 404 for suspended or inactive bots", async () => {
    const res = await makeRequest(server, {
      path: "/api/arena/v1/bots/bot-alice-suspended/ready-versions",
      method: "GET",
      headers: { Authorization: `Bearer ${author2Token}` }
    });

    assert.equal(res.statusCode, 404);
    assert.equal(res.json.error.code, "NOT_FOUND");
  });

  it("returns HTTP 404 for non-existent bots", async () => {
    const res = await makeRequest(server, {
      path: "/api/arena/v1/bots/bot-ghost-unknown/ready-versions",
      method: "GET",
      headers: { Authorization: `Bearer ${author1Token}` }
    });

    assert.equal(res.statusCode, 404);
    assert.equal(res.json.error.code, "NOT_FOUND");
  });

  it("rejects non-GET methods with HTTP 405 Method Not Allowed and Allow header", async () => {
    const res = await makeRequest(server, {
      path: "/api/arena/v1/bots/bot-alice-main/ready-versions",
      method: "POST",
      headers: { Authorization: `Bearer ${author1Token}` }
    });

    assert.equal(res.statusCode, 405);
    assert.equal(res.headers["allow"], "GET");
  });

  it("rejects unauthenticated requests with HTTP 401", async () => {
    const res = await makeRequest(server, {
      path: "/api/arena/v1/bots/bot-alice-main/ready-versions",
      method: "GET"
    });

    assert.equal(res.statusCode, 401);
  });
});
