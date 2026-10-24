"use strict";

/**
 * Bot Cup admin API (apps/bot-cup-admin, P6) on SQLite with the real migrations: Cloudflare Access JWT (RS256, keys from an
 * injected certs endpoint) or password + TOTP, the admins table as a second layer, read-only viewers, one audit row per
 * write with a verifiable hash chain, and two different admins for disqualification and result changes.
 * Plan: docs/superpowers/plans/2026-10-23-uet-k71-bot-cup.md §4.2, §8.8, §11.4, §12 P6.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, START } = require("./bot-cup/harness");

const ADMIN_ORIGIN = "https://btc.test";
const TEAM_DOMAIN = "https://ottcup.cloudflareaccess.com";
const AUD = "aud-tag-123";

let adminMod;
let authMod;
let keys;
before(async () => {
  adminMod = await import("../apps/bot-cup-admin/src/app.mjs");
  authMod = await import("../apps/bot-cup-admin/src/auth.mjs");
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "key-1", alg: "RS256", use: "sig" };
  keys = { privateKey: pair.privateKey, jwk };
});

const b64 = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

async function accessJwt(email, { aud = AUD, iss = TEAM_DOMAIN, exp = START / 1000 + 3600, key = keys.privateKey } = {}) {
  const head = b64({ alg: "RS256", kid: "key-1", typ: "JWT" });
  const body = b64({ email, aud: [aud], iss, exp, iat: START / 1000 });
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(signature).toString("base64url")}`;
}

async function setup({ authMode = "access" } = {}) {
  const h = await createHarness();
  const certsCalls = [];
  const api = adminMod.createAdminApi({
    db: h.db,
    now: () => h.env.clock,
    config: { eventId: "ev", authMode, access: { teamDomain: TEAM_DOMAIN, aud: AUD }, allowedOrigins: [ADMIN_ORIGIN] },
    fetchImpl: async (url) => {
      certsCalls.push(url);
      return new Response(JSON.stringify({ keys: [keys.jwk] }), { headers: { "content-type": "application/json" } });
    }
  });
  const addAdmin = (email, role = "admin", extra = {}) => h.db.sqlite.prepare(
    "INSERT INTO admins (email, role, added_by, created_at, password_hash, totp_secret) VALUES (?, ?, 'test', 0, ?, ?)"
  ).run(email, role, extra.passwordHash ?? null, extra.totpSecret ?? null);

  async function admin(method, path, { as, json, cookie, origin = method === "GET" ? undefined : ADMIN_ORIGIN } = {}) {
    const headers = {};
    if (as) headers["cf-access-jwt-assertion"] = await accessJwt(as);
    if (cookie) headers.cookie = cookie;
    if (origin) headers.origin = origin;
    let body;
    if (json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(json);
    }
    const response = await api.fetch(new Request(`${ADMIN_ORIGIN}/admin-api${path}`, { method, headers, body }));
    const type = response.headers.get("content-type") || "";
    return { status: response.status, body: type.includes("json") ? await response.json() : await response.text(), headers: response.headers };
  }
  const auditRows = () => h.db.sqlite.prepare("SELECT * FROM audit_log ORDER BY seq").all();
  return { h, api, admin, addAdmin, auditRows, certsCalls };
}

describe("bot-cup admin: who gets in", () => {
  it("requires a valid Access JWT for an enabled admin", async () => {
    const t = await setup();
    t.addAdmin("boss@uet.test");
    assert.equal((await t.admin("GET", "/me")).status, 401);
    const me = await t.admin("GET", "/me", { as: "Boss@UET.test" });
    assert.deepEqual(me.body, { email: "boss@uet.test", role: "admin", authMode: "access", fourEyes: ["team.disqualify", "match.set_result"] });
    assert.deepEqual([(await t.admin("GET", "/me", { as: "student@vnu.edu.vn" })).status, (await t.admin("GET", "/me", { as: "student@vnu.edu.vn" })).body.error], [403, "not_an_admin"]);

    const call = async (token) => (await t.api.fetch(new Request(`${ADMIN_ORIGIN}/admin-api/me`, { headers: { "cf-access-jwt-assertion": token } }))).status;
    assert.equal(await call(await accessJwt("boss@uet.test", { aud: "other-app" })), 401);
    assert.equal(await call(await accessJwt("boss@uet.test", { iss: "https://evil.cloudflareaccess.com" })), 401);
    assert.equal(await call(await accessJwt("boss@uet.test", { exp: START / 1000 - 1 })), 401);
    const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"]);
    assert.equal(await call(await accessJwt("boss@uet.test", { key: other.privateKey })), 401, "a token signed by another key");
    const valid = await accessJwt("boss@uet.test");
    assert.equal(await call(`${valid.slice(0, -4)}AAAA`), 401, "a tampered signature");
    assert.equal(t.certsCalls.length, 1, "keys are cached");

    t.h.db.sqlite.prepare("UPDATE admins SET disabled_at = 1 WHERE email = 'boss@uet.test'").run();
    assert.equal((await t.admin("GET", "/me", { as: "boss@uet.test" })).status, 403);
  });

  it("signs in with password and TOTP in password mode, and locks after five failures", async () => {
    const t = await setup({ authMode: "password" });
    const { hashPassword } = await import("../apps/bot-cup-api/src/security.mjs");
    const secret = authMod.base32Encode(crypto.getRandomValues(new Uint8Array(20)));
    t.addAdmin("boss@uet.test", "admin", { passwordHash: await hashPassword("very-long-password"), totpSecret: secret });
    const code = await authMod.totpCode(secret, t.h.env.clock);
    assert.equal((await t.admin("POST", "/login", { json: { email: "boss@uet.test", password: "very-long-password", totp: "000000" } })).status, 401);
    const ok = await t.admin("POST", "/login", { json: { email: "boss@uet.test", password: "very-long-password", totp: code } });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get("set-cookie").split(";")[0];
    assert.match(ok.headers.get("set-cookie"), /^__Host-ottcup_admin=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Strict/);
    assert.equal((await t.admin("GET", "/overview", { cookie })).status, 200);
    assert.equal(t.auditRows().at(-1).action, "admin.login");

    for (let i = 0; i < 5; i++) await t.admin("POST", "/login", { json: { email: "boss@uet.test", password: "wrong", totp: code } });
    assert.equal((await t.admin("POST", "/login", { json: { email: "boss@uet.test", password: "very-long-password", totp: code } })).status, 423);
    assert.equal((await t.admin("POST", "/logout", { cookie })).status, 200);
    assert.equal((await t.admin("GET", "/overview", { cookie })).status, 401);
  });

  it("checks TOTP against the RFC 6238 test vector", async () => {
    // RFC 6238 appendix B, SHA-1 secret "12345678901234567890", T = 59 s -> 94287082 (last 6 digits 287082).
    const secret = authMod.base32Encode(new TextEncoder().encode("12345678901234567890"));
    assert.equal(await authMod.totpCode(secret, 59_000), "287082");
    assert.equal(await authMod.verifyTotp(secret, "287082", 59_000 + 30_000), true, "one step of drift is accepted");
    assert.equal(await authMod.verifyTotp(secret, "287082", 59_000 + 90_000), false);
  });

  it("lets viewers read but not write, and refuses writes from another origin", async () => {
    const t = await setup();
    t.addAdmin("viewer@uet.test", "viewer");
    t.addAdmin("boss@uet.test");
    assert.equal((await t.admin("GET", "/teams", { as: "viewer@uet.test" })).status, 200);
    const write = await t.admin("POST", "/announcements", { as: "viewer@uet.test", json: { title: "Hello", body: "World" } });
    assert.deepEqual([write.status, write.body.error], [403, "read_only"]);
    const cross = await t.admin("POST", "/announcements", { as: "boss@uet.test", json: { title: "Hello", body: "World" }, origin: "https://ottv2.vercel.app" });
    assert.deepEqual([cross.status, cross.body.error], [403, "forbidden_origin"]);
    assert.equal(t.auditRows().length, 0);
  });
});

describe("bot-cup admin: audit log", () => {
  it("adds exactly one audit row per write and keeps a verifiable chain", async () => {
    const t = await setup();
    t.addAdmin("boss@uet.test");
    const team = t.h.team({ name: "Đội Một" });
    const steps = [
      ["POST", `/teams/${team.id}/rename`, { displayName: "Đội Một Mới", reason: "tên cũ không phù hợp" }, "team.rename"],
      ["POST", "/announcements", { title: "Mở nộp bài", body: "Từ hôm nay.", publish: true }, "announcement.create"],
      ["GET", "/export/teams.csv", undefined, "export.teams"]
    ];
    for (const [method, path, json, action] of steps) {
      const before = t.auditRows().length;
      const result = await t.admin(method, path, { as: "boss@uet.test", json });
      assert.ok(result.status < 300, `${path}: ${result.status} ${JSON.stringify(result.body)}`);
      assert.equal(t.auditRows().length, before + 1, path);
      assert.equal(t.auditRows().at(-1).action, action);
    }
    assert.equal(t.auditRows()[0].reason, "tên cũ không phù hợp");
    assert.equal(t.auditRows()[0].actor_email, "boss@uet.test");
    const verified = await t.admin("GET", "/audit/verify", { as: "boss@uet.test" });
    assert.deepEqual({ ok: verified.body.ok, rows: verified.body.rows }, { ok: true, rows: 3 });

    assert.throws(() => t.h.db.sqlite.prepare("UPDATE audit_log SET reason = 'x'").run(), /append-only/);
    assert.throws(() => t.h.db.sqlite.prepare("DELETE FROM audit_log").run(), /append-only/);
    // Someone with raw database access drops the trigger and edits a row: the chain gives it away.
    t.h.db.sqlite.exec("DROP TRIGGER audit_log_no_update");
    t.h.db.sqlite.prepare("UPDATE audit_log SET reason = 'đổi lý do' WHERE seq = 1").run();
    assert.deepEqual((await t.admin("GET", "/audit/verify", { as: "boss@uet.test" })).body, { ok: false, seq: 1, error: "audit_hash_mismatch" });
  });

  it("needs a reason for every change", async () => {
    const t = await setup();
    t.addAdmin("boss@uet.test");
    const team = t.h.team();
    const result = await t.admin("POST", `/teams/${team.id}/rename`, { as: "boss@uet.test", json: { displayName: "Tên Mới" } });
    assert.deepEqual([result.status, result.body.error], [400, "reason_required"]);
  });
});

describe("bot-cup admin: two people for heavy decisions", () => {
  it("disqualifies a team only after a second admin approves, and the team can no longer play", async () => {
    const t = await setup();
    t.addAdmin("a@uet.test");
    t.addAdmin("b@uet.test");
    const token = t.h.runner();
    const team = t.h.team({ name: "Đội Chép" });
    await t.h.readySubmission(team, token);

    const asked = await t.admin("POST", `/teams/${team.id}/disqualify`, { as: "a@uet.test", json: { reason: "chép ai.js, đã xác minh" } });
    assert.equal(asked.status, 202);
    assert.equal(t.h.db.sqlite.prepare("SELECT disqualified_at FROM teams WHERE id = ?").get(team.id).disqualified_at, null, "nothing happens on one admin's word");
    const self = await t.admin("POST", `/pending/${asked.body.pendingId}/approve`, { as: "a@uet.test", json: {} });
    assert.deepEqual([self.status, self.body.error], [403, "same_admin"]);
    const approved = await t.admin("POST", `/pending/${asked.body.pendingId}/approve`, { as: "b@uet.test", json: { reason: "đồng ý" } });
    assert.equal(approved.status, 200);
    const row = t.h.db.sqlite.prepare("SELECT disqualified_at, dq_reason FROM teams WHERE id = ?").get(team.id);
    assert.equal(row.dq_reason, "chép ai.js, đã xác minh");
    assert.ok(row.disqualified_at);
    assert.equal((await t.admin("POST", `/pending/${asked.body.pendingId}/approve`, { as: "b@uet.test", json: {} })).body.error, "already_decided");

    const practice = await t.h.call("POST", "/api/t/practice", { cookie: team.cookie, json: { opponent: "easy" } });
    assert.deepEqual([practice.status, practice.body.error], [403, "team_disqualified"]);
    const me = await t.h.call("GET", "/api/t/me", { cookie: team.cookie });
    assert.deepEqual([me.body.disqualified, me.body.dqReason], [true, "chép ai.js, đã xác minh"]);
    assert.deepEqual(t.auditRows().map((r) => r.action).slice(-2), ["team.disqualify.request", "team.disqualify.approve"]);
  });

  it("changes a game result only with a second admin", async () => {
    const t = await setup();
    t.addAdmin("a@uet.test");
    t.addAdmin("b@uet.test");
    const token = t.h.runner();
    const team = t.h.team();
    await t.h.readySubmission(team, token);
    const [game] = (await t.admin("GET", "/matches?stage=smoke", { as: "a@uet.test" })).body.matches;
    const asked = await t.admin("POST", `/matches/${game.id}/result`, { as: "a@uet.test", json: { outcome: "win", winner: game.winner === "A" ? "B" : "A", reason: "khiếu nại được chấp nhận" } });
    assert.equal(asked.status, 202);
    const rejected = await t.admin("POST", `/pending/${asked.body.pendingId}/reject`, { as: "b@uet.test", json: { reason: "không đủ căn cứ" } });
    assert.equal(rejected.body.status, "rejected");
    assert.equal(t.h.db.sqlite.prepare("SELECT winner FROM matches WHERE id = ?").get(game.id).winner, game.winner);
  });
});

describe("bot-cup admin: day-to-day work", () => {
  it("confirms a member by hand, rechecks a submission, requeues a failed job, reruns a game, handles flags and runners", async () => {
    const t = await setup();
    t.addAdmin("boss@uet.test");
    const as = "boss@uet.test";
    const token = t.h.runner("main");

    // A pending group member whose school mail never arrived.
    const group = t.h.team({ status: "pending_members" });
    t.h.db.sqlite.prepare("UPDATE teams SET kind = 'group', verified_at = 1 WHERE id = ?").run(group.id);
    t.h.db.sqlite.prepare("INSERT INTO members (event_id, mssv, team_id, full_name, email, role, status, created_at) VALUES ('ev', ?, ?, 'Lead', 'lead@x.y', 'captain', 'confirmed', 0)").run("26020001", group.id);
    t.h.db.sqlite.prepare("INSERT INTO members (event_id, mssv, team_id, full_name, email, role, status, created_at) VALUES ('ev', ?, ?, 'Mate', 'mate@x.y', 'member', 'pending', 0)").run("26020002", group.id);
    const confirmed = await t.admin("POST", `/teams/${group.id}/members/26020002/confirm`, { as, json: { reason: "SV đến gặp BTC, đã đối chiếu thẻ" } });
    assert.deepEqual(confirmed.body, { ok: true, status: "active" });
    const detail = await t.admin("GET", `/teams/${group.id}`, { as });
    assert.equal(detail.body.members[1].email, "mate@x.y", "admins see full addresses");
    assert.equal("password_hash" in detail.body.team, false);

    const team = t.h.team();
    const submission = await t.h.readySubmission(team, token);
    await t.admin("POST", `/submissions/${submission.id}/recheck`, { as, json: { reason: "đổi image runner" } });
    assert.equal(t.h.db.sqlite.prepare("SELECT status FROM submissions WHERE id = ?").get(submission.id).status, "checking");
    await t.h.drain(token);
    assert.equal(t.h.db.sqlite.prepare("SELECT status FROM submissions WHERE id = ?").get(submission.id).status, "ready");
    const source = await t.admin("GET", `/submissions/${submission.id}/source`, { as });
    assert.match(source.body, /legalMoves/);
    assert.equal(t.auditRows().at(-1).action, "submission.view_source");

    // A failed job back in the queue.
    const failedJob = t.h.db.sqlite.prepare("SELECT id FROM jobs WHERE kind = 'match' LIMIT 1").get().id;
    t.h.db.sqlite.prepare("UPDATE jobs SET status = 'failed', attempts = 3, last_error = 'docker down' WHERE id = ?").run(failedJob);
    assert.equal((await t.admin("GET", "/jobs?status=failed", { as })).body.jobs.length, 1);
    await t.admin("POST", `/jobs/${failedJob}/requeue`, { as, json: { reason: "Docker đã chạy lại" } });
    assert.deepEqual(t.h.db.sqlite.prepare("SELECT status, attempts FROM jobs WHERE id = ?").get(failedJob), { status: "queued", attempts: 0 });

    const [game] = (await t.admin("GET", "/matches?stage=smoke&status=finished", { as })).body.matches;
    const rerun = await t.admin("POST", `/matches/${game.id}/rerun`, { as, json: { reason: "runner nghi vấn" } });
    assert.equal(t.h.db.sqlite.prepare("SELECT status FROM matches WHERE id = ?").get(game.id).status, "cancelled");
    assert.equal(t.h.db.sqlite.prepare("SELECT status FROM matches WHERE id = ?").get(rerun.body.newMatchId).status, "queued");

    const template = require("node:fs").readFileSync(require("node:path").join(__dirname, "../sdk/bot-cup/python/bot.py"), "utf8");
    await t.h.upload(t.h.team(), template);
    const [flag] = (await t.admin("GET", "/flags", { as })).body.flags;
    assert.equal(flag.reference, "sdk/bot-cup/python/bot.py");
    await t.admin("POST", `/flags/${flag.id}`, { as, json: { status: "cleared", reason: "template mẫu, đội mới nộp thử" } });
    assert.equal((await t.admin("GET", "/flags", { as })).body.flags.length, 0);

    t.h.db.sqlite.prepare("UPDATE runners SET suspect_at = 1, suspect_reason = 'replay_winner' WHERE name = 'main'").run();
    const runners = (await t.admin("GET", "/runners", { as })).body.runners;
    assert.equal(runners[0].suspect_reason, "replay_winner");
    await t.admin("POST", `/runners/${runners[0].id}/clear-suspect`, { as, json: { reason: "lỗi do bản runner cũ" } });
    await t.admin("POST", `/runners/${runners[0].id}/revoke`, { as, json: { reason: "máy cũ" } });
    assert.equal((await t.h.call("POST", "/runner/claim", { token, json: { slots: 1 } })).status, 401);

    const overview = await t.admin("GET", "/overview", { as });
    assert.equal(overview.status, 200);
    assert.equal(overview.body.alerts.suspectRunners, 0);
    assert.equal((await t.admin("GET", "/audit/verify", { as })).body.ok, true);
  });

  it("publishes announcements to the player site and exports CSV safe for spreadsheets", async () => {
    const t = await setup();
    t.addAdmin("boss@uet.test");
    const as = "boss@uet.test";
    await t.admin("POST", "/announcements", { as, json: { title: "Bản nháp", body: "chưa đăng" } });
    const created = await t.admin("POST", "/announcements", { as, json: { title: "Lịch vòng tròn", body: "Thứ Hai 7/12.", publish: true } });
    let shown = await t.h.call("GET", "/api/t/announcements");
    assert.deepEqual(shown.body.announcements.map((a) => a.title), ["Lịch vòng tròn"]);
    await t.admin("POST", `/announcements/${created.body.id}/withdraw`, { as, json: {} });
    shown = await t.h.call("GET", "/api/t/announcements");
    assert.deepEqual(shown.body.announcements, []);

    const team = t.h.team({ name: "=HYPERLINK(1)" });
    t.h.db.sqlite.prepare("INSERT INTO members (event_id, mssv, team_id, full_name, email, role, status, created_at) VALUES ('ev', '26029999', ?, '@cmd', 'a@b.c', 'captain', 'confirmed', 0)").run(team.id);
    const csv = await t.admin("GET", "/export/teams.csv", { as });
    assert.match(csv.headers.get("content-disposition"), /bot-cup-teams\.csv/);
    assert.match(csv.body, /'=HYPERLINK\(1\)/);
    assert.match(csv.body, /'@cmd/);
    assert.doesNotMatch(csv.body, /(^|,)=HYPERLINK/m);
  });
});
