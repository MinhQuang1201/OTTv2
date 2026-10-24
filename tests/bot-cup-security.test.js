"use strict";

/**
 * P9 security review of the Bot Cup API and admin site (plan §12 P9: IDOR, CSRF, rate limits, body sizes), on SQLite with
 * the real migrations. Each test pins one finding or one rule the review checked; see docs/evidence/…-bot-cup-p9.md.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createHarness, START, WEB } = require("./bot-cup/harness");

const ADMIN_ORIGIN = "https://btc.test";

let adminMod;
before(async () => {
  adminMod = await import("../apps/bot-cup-admin/src/app.mjs");
});

/** Every write route of the player API with a body it would accept apart from the Origin. */
const WRITES = [
  ["POST", "/api/t/register"], ["POST", "/api/t/register/verify"], ["POST", "/api/t/register/resend"], ["POST", "/api/t/login"],
  ["POST", "/api/t/logout"], ["POST", "/api/t/team/members"], ["DELETE", "/api/t/team/members/26020101"],
  ["POST", "/api/t/team/members/26020101/resend"], ["POST", "/api/t/invites/accept"], ["POST", "/api/t/password/reset/request"],
  ["POST", "/api/t/password/reset/confirm"], ["POST", "/api/t/password/change"], ["POST", "/api/t/sessions/revoke-all"],
  ["POST", "/api/t/submissions"], ["PUT", "/api/t/team/final-submission"], ["POST", "/api/t/practice"], ["POST", "/api/t/appeals"]
];

describe("bot-cup security review (P9)", () => {
  it("refuses every write from another origin or with no origin (CSRF), before doing anything", async () => {
    const h = await createHarness();
    const team = h.team();
    for (const [method, path] of WRITES) {
      for (const origin of ["https://evil.test", null]) {
        const result = await h.call(method, path, { cookie: team.cookie, json: {}, origin });
        assert.deepEqual([result.status, result.body.error], [403, "forbidden_origin"], `${method} ${path} from ${origin}`);
      }
    }
  });

  it("never buffers an oversized body: a large Content-Length is refused unread, a long stream is cut off", async () => {
    const h = await createHarness();
    const team = h.team();
    const declared = await h.call("POST", "/api/t/practice", { cookie: team.cookie, body: "{}", headers: { "content-type": "application/json", "content-length": String(50 * 1024 * 1024) } });
    assert.deepEqual([declared.status, declared.body.error], [413, "invalid_request"]);
    // No Content-Length: a stream that keeps going is stopped just past the limit, not read to the end.
    let pulled = 0;
    const endless = new ReadableStream({
      pull(controller) {
        pulled += 1;
        if (pulled > 10_000) return controller.close();
        controller.enqueue(new TextEncoder().encode(`{"x":"${"a".repeat(1000)}`));
      }
    });
    const response = await h.api.fetch(new Request("https://api.test/api/t/practice", {
      method: "POST", headers: { cookie: team.cookie, origin: WEB, "content-type": "application/json" }, body: endless, duplex: "half"
    }));
    assert.equal(response.status, 413);
    assert.ok(pulled < 100, `read ${pulled} chunks of an endless body`);
    const badUtf8 = await h.call("POST", "/api/t/practice", { cookie: team.cookie, body: Buffer.from([0x7b, 0xff, 0x7d]), headers: { "content-type": "application/json" } });
    assert.deepEqual([badUtf8.status, badUtf8.body.error], [400, "invalid_request"]);
  });

  it("shows a team only its own appeals, and a public game without either side's stderr", async () => {
    const h = await createHarness({ event: { code_freeze_at: START + 1000 } });
    const runner = h.runner();
    const [a, b] = [h.team({ name: "Đội An" }), h.team({ name: "Đội Bình" })];
    const sa = await h.readySubmission(a, runner);
    const sb = await h.readySubmission(b, runner);
    // An official game between them, finished with stderr on both sides.
    h.db.sqlite.prepare(
      `INSERT INTO matches (id, event_id, stage, round, game_index, map_id, policy_version, a_submission_id, b_submission_id, status, outcome, winner, loser, reason, plies, stderr_a, stderr_b, created_at)
       VALUES ('rr-1', 'ev', 'round_robin', 1, 0, 'classic', 'bot-cup-policy-v1', ?, ?, 'finished', 'win', 'A', 'B', 'goal', 40, 'secret A', 'secret B', 0)`
    ).run(sa.id, sb.id);
    const asB = await h.call("GET", "/api/t/matches/rr-1", { cookie: b.cookie });
    assert.deepEqual(asB.body.match.stderr, { B: "secret B" }, "a team reads only its own bot's stderr");
    const guest = await h.call("GET", "/api/t/matches/rr-1");
    assert.deepEqual(guest.body.match.stderr, {});
    assert.doesNotMatch(JSON.stringify(guest.body), /secret|2602|@/, "no stderr, MSSV or email for guests");

    h.db.sqlite.prepare("INSERT INTO appeals (id, event_id, team_id, stage, body, created_at) VALUES ('ap-a', 'ev', ?, 'gate', 'Khiếu nại của đội An.', 0)").run(a.id);
    const appealsOfB = await h.call("GET", "/api/t/appeals", { cookie: b.cookie });
    assert.deepEqual(appealsOfB.body.appeals, []);
    assert.equal((await h.call("GET", "/api/t/appeals")).status, 401);
  });

  it("keeps organiser tools behind the admin session and the writer role", async () => {
    const h = await createHarness();
    const admin = adminMod.createAdminApi({ db: h.db, now: () => h.env.clock, config: { eventId: "ev", authMode: "password", allowedOrigins: [ADMIN_ORIGIN] } });
    h.db.sqlite.prepare("INSERT INTO admins (email, role, added_by, created_at) VALUES ('viewer@btc.test', 'viewer', 'test', 0)").run();
    h.db.sqlite.prepare("INSERT INTO admin_sessions (id_hash, email, created_at, expires_at) VALUES (?, 'viewer@btc.test', 0, ?)").run(crypto.createHash("sha256").update("v").digest("hex"), START * 10);
    const call = (method, path, cookie, body) => admin.fetch(new Request(`${ADMIN_ORIGIN}/admin-api${path}`, {
      method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { origin: ADMIN_ORIGIN, "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined
    }));
    for (const path of ["/anticheat/export?scope=final", "/anticheat/anomalies", "/flags", "/tournament", "/audit"]) {
      assert.equal((await call("GET", path)).status, 401, `${path} without a session`);
    }
    const viewer = "__Host-ottcup_admin=v";
    for (const [path, body] of [["/anticheat/probes", { probeSet: "a".repeat(64), scope: "final", reason: "thử" }], ["/anticheat/jplag", { report: { format: "ott-bot-cup-jplag-1", pairs: [] }, reason: "thử" }], ["/tournament/freeze", { reason: "thử" }]]) {
      const response = await call("POST", path, viewer, body);
      assert.equal(response.status, 403, `${path} as a viewer`);
    }
  });
});
