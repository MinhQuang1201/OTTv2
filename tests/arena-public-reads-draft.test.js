"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "arena-public-reads-"));
let db;
let openDatabase;
let server;
let closeDatabase;

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, ...options }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    req.on("error", reject);
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
  });
}

test.before(async () => {
  ({ openDatabase, closeDatabase } = await import("../packages/arena-node/src/persistence/sqlite-database.mjs"));
  const opened = openDatabase(path.join(temp, "arena.db"));
  db = opened.db;
  const { createArenaServer } = await import("../apps/arena-api/src/http-server.mjs");
  server = createArenaServer({ db, trustedMode: false, localDemoContainers: true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (db) closeDatabase(db);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("public read routes are anonymous while private bot versions and writes remain protected", async () => {
  for (const pathname of [
    "/api/arena/v1/leaderboard?ladderId=ladder-main",
    "/api/arena/v1/matches",
    "/api/arena/v1/tournaments",
    "/api/arena/v1/matches/missing/replay",
    "/api/arena/v1/matches/missing/live",
    "/api/arena/v1/tournaments/missing"
  ]) {
    const response = await request({ path: pathname, method: "GET" });
    assert.notEqual(response.status, 401, pathname);
  }
  assert.equal((await request({ path: "/api/arena/v1/bots/missing/versions", method: "GET" })).status, 401);
  assert.equal((await request({ path: "/api/arena/v1/matches", method: "POST", headers: { "content-type": "application/json", "idempotency-key": "x" } }, {})).status, 401);
});

test("public reads still reject bearer tokens in URL query strings", async () => {
  const tokenQuery = await request({ path: "/api/arena/v1/leaderboard?ladderId=ladder-main&token=leaked", method: "GET" });
  assert.equal(tokenQuery.status, 401);
  assert.equal(tokenQuery.body.error.code, "UNAUTHORIZED");
  const bearerQuery = await request({ path: "/api/arena/v1/tournaments?bearer=leaked", method: "GET" });
  assert.equal(bearerQuery.status, 401);
  assert.equal(bearerQuery.body.error.code, "UNAUTHORIZED");
});

test("draft tournament has no matches/jobs until one admin start", async () => {
  const { createTournamentRepository } = await import("../packages/arena-node/src/persistence/tournament-repository.mjs");
  db.prepare("INSERT INTO users (id, normalized_username, password_hash, role) VALUES ('draft-admin', 'draft-admin', 'x', 'admin')").run();
  for (const [botId, versionId] of [["draft-a", "draft-va"], ["draft-b", "draft-vb"]]) {
    db.prepare("INSERT INTO bots (id, owner_id, name) VALUES (?, 'draft-admin', ?)").run(botId, botId);
    db.prepare("INSERT OR IGNORE INTO artifacts (digest, kind, relative_private_path, bytes) VALUES ('sha256:artifact', 'build', 'builds/test/artifact', 1)").run();
    db.prepare("INSERT INTO bot_versions (id, bot_id, version_no, source_digest, profile_id, profile_revision, build_status, artifact_digest) VALUES (?, ?, 1, 'sha256:source', 'node', 'node-v1', 'ready', 'sha256:artifact')").run(versionId, botId);
  }
  const repo = createTournamentRepository(db);
  const base = {
    id: "draft-tournament",
    name: "Draft Tournament",
    ranked: true,
    ruleset: JSON.stringify({ schemaVersion: 1 }),
    policy: JSON.stringify({ schemaVersion: 1 }),
    initialState: JSON.stringify({ schemaVersion: 1 }),
    entries: [{ botId: "draft-a", botVersionId: "draft-va" }, { botId: "draft-b", botVersionId: "draft-vb" }],
    startImmediately: false
  };
  const draft = repo.createTournament(base, { actorId: "draft-admin", idempotencyKey: "draft-create" });
  assert.equal(draft.status, "pending");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM matches WHERE tournament_id = 'draft-tournament'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE target_id LIKE 'draft-tournament-%'").get().n, 0);
  const started = repo.startTournament("draft-tournament");
  assert.equal(started.status, "active");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM matches WHERE tournament_id = 'draft-tournament'").get().n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE target_id LIKE 'draft-tournament-%'").get().n, 2);
  repo.startTournament("draft-tournament");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE target_id LIKE 'draft-tournament-%'").get().n, 2);
});
