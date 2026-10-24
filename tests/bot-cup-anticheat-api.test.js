"use strict";

/**
 * P8 on SQLite with the real migrations: behaviour-fingerprint jobs through the runner API and the flags they raise,
 * JPlag export/import on the admin site, two-person confirmation of a violation, the 48-hour notice, the anomaly report,
 * and the jobs table rebuild keeping existing rows.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createHarness, START } = require("./bot-cup/harness");

const ADMIN_ORIGIN = "https://btc.test";
const SET = "a".repeat(64);
const POSITIONS = 30;

let adminMod;
before(async () => {
  adminMod = await import("../apps/bot-cup-admin/src/app.mjs");
});

/** Distinct, valid move keys: one fingerprint per `seed`. */
function fingerprint(seed) {
  return Array.from({ length: POSITIONS }, (_, index) => {
    const x = (seed * 3 + index) % 8;
    const y = (seed * 5 + index * 7) % 8;
    return `${x},${y}-${x + 1},${y}`;
  });
}
const withChanges = (moves, count) => moves.map((move, index) => (index < count ? `8,8-7,${index % 8}` : move));

async function setup() {
  const h = await createHarness();
  const sqlite = h.db.sqlite;
  const admin = adminMod.createAdminApi({ db: h.db, now: () => h.env.clock, config: { eventId: "ev", authMode: "password", allowedOrigins: [ADMIN_ORIGIN] } });
  const cookies = {};
  for (const email of ["a@btc.test", "b@btc.test"]) {
    sqlite.prepare("INSERT INTO admins (email, role, added_by, created_at) VALUES (?, 'admin', 'test', 0)").run(email);
    const token = `session-${email}`;
    sqlite.prepare("INSERT INTO admin_sessions (id_hash, email, created_at, expires_at) VALUES (?, ?, 0, ?)").run(crypto.createHash("sha256").update(token).digest("hex"), email, START * 10);
    cookies[email] = `__Host-ottcup_admin=${token}`;
  }
  async function btc(method, url, json, who = "a@btc.test") {
    const init = { method, headers: { cookie: cookies[who] } };
    if (json !== undefined) {
      init.headers.origin = ADMIN_ORIGIN;
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(json);
    }
    const response = await admin.fetch(new Request(`${ADMIN_ORIGIN}/admin-api${url}`, init));
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text.startsWith("{") ? JSON.parse(text) : text };
  }
  const runner = h.runner();
  const teams = {};
  for (const name of ["copy", "twinA", "twinB", "own"]) {
    const team = h.team({ name: `Đội ${name}` });
    teams[name] = { ...team, submission: await h.readySubmission(team, runner) };
  }
  return { h, sqlite, btc, runner, teams };
}

describe("bot-cup anti-cheat API", () => {
  it("fingerprints every bot of a secret set and flags near-identical behaviour", async () => {
    const { h, sqlite, btc, runner, teams } = await setup();
    const hard = fingerprint(1);
    const answers = {
      "house:hard": hard, "house:medium": fingerprint(2), "house:easy": fingerprint(3),
      "house:template-python": fingerprint(6), "house:template-js": fingerprint(7),
      [teams.copy.submission.sha256]: withChanges(hard, 2), // 28/30 = 93% like ai.js hard
      [teams.twinA.submission.sha256]: fingerprint(4),
      [teams.twinB.submission.sha256]: withChanges(fingerprint(4), 1), // 29/30 like twinA
      [teams.own.submission.sha256]: fingerprint(6) // the Python template, unchanged
    };
    assert.equal((await btc("POST", "/anticheat/probes", { probeSet: "not-a-sha", scope: "final", reason: "vân tay" })).body.error, "invalid_request");
    const queued = await btc("POST", "/anticheat/probes", { probeSet: SET, scope: "final", reason: "vân tay sau khóa code" });
    assert.deepEqual([queued.status, queued.body.jobs], [200, 9], "5 reference bots (ai.js x3, templates x2) + 4 teams");

    const claimed = [];
    await h.drain(runner, {
      probe(job) {
        claimed.push(job);
        assert.equal(job.probe.set, SET);
        return answers[job.probe.house ? `house:${job.probe.house}` : job.probe.submission.sha256];
      }
    });
    assert.equal(claimed.length, 9);
    assert.doesNotMatch(JSON.stringify(claimed), /Đội|team-/, "a probe job names code and the set, never a team");

    // Flags come once the set is complete, whatever order the jobs finished in.
    const flags = sqlite.prepare("SELECT kind, submission_id, other_submission_id, reference, score, details FROM similarity_flags WHERE kind = 'behavior' ORDER BY score").all();
    assert.equal(flags.length, 3);
    assert.deepEqual([flags[0].submission_id, flags[0].reference, flags[0].score], [teams.copy.submission.id, "house:hard", 0.933]);
    assert.deepEqual([flags[1].score, [flags[1].submission_id, flags[1].other_submission_id].sort()], [0.967, [teams.twinA.submission.id, teams.twinB.submission.id].sort()]);
    assert.deepEqual(JSON.parse(flags[1].details), { probeSet: SET, compared: 30, same: 29, positions: 30 });
    assert.deepEqual([flags[2].submission_id, flags[2].reference, flags[2].score], [teams.own.submission.id, "house:template-python", 1]);

    // Asking again queues nothing: every target has a fingerprint for this set.
    assert.equal((await btc("POST", "/anticheat/probes", { probeSet: SET, scope: "final", reason: "lần hai" })).body.jobs, 0);
    const progress = (await btc("GET", "/anticheat/probes")).body.sets;
    assert.deepEqual([progress[0].probe_set, progress[0].done, progress[0].fingerprints], [SET, 9, 9]);

    // While it holds a probe lease, the runner may download that submission's code; it cannot send anything but move keys.
    await btc("POST", "/anticheat/probes", { probeSet: "b".repeat(64), scope: "final", reason: "bộ khác" });
    const leased = (await h.call("POST", "/runner/claim", { token: runner, json: { slots: 8 } })).body.jobs;
    const onSubmission = leased.find((item) => item.probe.submission);
    const code = await h.call("GET", `/runner/source/${onSubmission.probe.submission.sha256}`, { token: runner });
    assert.equal(code.status, 200);
    const bad = await h.call("POST", "/runner/complete", { token: runner, json: { jobId: onSubmission.jobId, attempt: onSubmission.attempt, moves: ["1,1-1,2", "x'); DROP TABLE jobs; --"] } });
    assert.deepEqual([bad.status, bad.body.error], [400, "invalid_request"]);

    // The anomaly report lists the twins and a thrown game.
    const insert = sqlite.prepare(
      `INSERT INTO matches (id, event_id, stage, round, game_index, map_id, policy_version, a_submission_id, b_submission_id, status, outcome, winner, loser, reason, plies, created_at)
       VALUES (?, 'ev', 'round_robin', 1, ?, 'classic', 'bot-cup-policy-v1', ?, ?, 'finished', 'win', ?, ?, ?, ?, 0)`
    );
    const sub = (name) => teams[name].submission.id;
    let n = 0;
    for (const [a, b, winner, reason, plies] of [
      ["own", "copy", "A", "goal", 70], ["copy", "own", "B", "goal", 66], ["own", "twinB", "A", "goal", 58], ["twinB", "own", "B", "goal", 61],
      // own wins its other games, then loses both games to twinA at once: an illegal move and a 9-ply loss.
      ["own", "twinA", "B", "illegal_move", 2], ["twinA", "own", "A", "elimination", 9]
    ]) {
      n += 1;
      insert.run(`m${n}`, n, sub(a), sub(b), winner, winner === "A" ? "B" : "A", reason, plies);
    }
    const report = await btc("GET", "/anticheat/anomalies");
    assert.equal(report.body.probeSet, SET, "the latest set with fingerprints");
    const rows = report.body.rows;
    assert.deepEqual(rows.map((row) => row.kind), ["behaviour_twin", "thrown_game", "thrown_game"]);
    assert.deepEqual([rows[0].teamName, rows[0].opponentName].sort(), ["Đội twinA", "Đội twinB"]);
    assert.deepEqual(rows.slice(1).map((row) => [row.matchId, row.teamName, row.opponentName, row.reason]).sort(), [
      ["m5", "Đội own", "Đội twinA", "illegal_move"], ["m6", "Đội own", "Đội twinA", "elimination"]
    ]);
    // An organiser turns the lead into a collusion flag on both teams' code; once is enough.
    const collusion = { teamId: rows[1].team, opponentId: rows[1].opponent, note: "thua 2 ván rất nhanh", reason: "xem replay m5, m6" };
    const flagged = await btc("POST", "/anticheat/collusion", collusion);
    assert.equal(flagged.status, 201);
    assert.deepEqual(sqlite.prepare("SELECT kind, submission_id, other_submission_id FROM similarity_flags WHERE id = ?").get(flagged.body.flagId),
      { kind: "collusion", submission_id: sub("own"), other_submission_id: sub("twinA") });
    assert.equal((await btc("POST", "/anticheat/collusion", collusion)).body.error, "already_flagged");
  });

  it("exports sources for JPlag (audited) and imports its report as flags", async () => {
    const { sqlite, btc, teams } = await setup();
    const exported = await btc("GET", "/anticheat/export?scope=final");
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-disposition"), /bot-cup-sources-final\.json/);
    assert.equal(exported.body.format, "ott-bot-cup-sources-1");
    assert.equal(exported.body.submissions.length, 4);
    assert.match(exported.body.submissions[0].source, /legalMoves/);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'anticheat.export_sources'").get().n, 1);

    const id = (name) => teams[name].submission.id;
    const report = {
      format: "ott-bot-cup-jplag-1", tool: "JPlag 6.2.0",
      pairs: [
        { a: id("twinA"), b: id("twinB"), reference: null, similarity: 0.91, max: 0.95, language: "python" },
        { a: id("copy"), b: null, reference: "packages/game-core/src/ai.js", similarity: 0.72, max: 0.8, language: "python" },
        { a: id("own"), b: id("copy"), reference: null, similarity: 0.5, max: 0.6, language: "python" }
      ]
    };
    const imported = await btc("POST", "/anticheat/jplag", { report, reason: "JPlag sau khóa code" });
    assert.deepEqual([imported.status, imported.body.flags, imported.body.skipped], [200, 2, 0]);
    const flags = sqlite.prepare("SELECT score, details, reference FROM similarity_flags WHERE kind = 'jplag' ORDER BY score DESC").all();
    assert.deepEqual(flags.map((flag) => [flag.score, JSON.parse(flag.details).priority, flag.reference]), [[0.91, true, null], [0.72, false, "packages/game-core/src/ai.js"]]);
    // The same report again adds nothing; pairs are matched in either order.
    const swapped = { ...report, pairs: [{ ...report.pairs[0], a: report.pairs[0].b, b: report.pairs[0].a }, report.pairs[1]] };
    assert.deepEqual((await btc("POST", "/anticheat/jplag", { report: swapped, reason: "nhập lại" })).body, { ok: true, pairs: 2, flags: 0, skipped: 2 });
    const foreign = { ...report, pairs: [{ a: "not-in-this-event", b: id("own"), similarity: 0.9 }] };
    assert.equal((await btc("POST", "/anticheat/jplag", { report: foreign, reason: "sai" })).body.error, "invalid_request");
    assert.equal((await btc("POST", "/anticheat/jplag", { report: { format: "x", pairs: [] }, reason: "sai" })).body.error, "invalid_request");
  });

  it("needs a second admin to confirm a violation, and records the 48-hour notice", async () => {
    const { h, sqlite, btc, teams } = await setup();
    sqlite.prepare("INSERT INTO similarity_flags (id, event_id, kind, submission_id, reference, score, created_at) VALUES ('f1', 'ev', 'jplag', ?, 'packages/game-core/src/ai.js', 0.9, 0)").run(teams.copy.submission.id);
    const flag = { id: "f1" };
    const asked = await btc("POST", `/flags/${flag.id}`, { status: "confirmed", reason: "chép ai.js" });
    assert.equal(asked.status, 202);
    assert.equal(sqlite.prepare("SELECT status FROM similarity_flags WHERE id = ?").get(flag.id).status, "open", "nothing changes before approval");
    assert.equal((await btc("POST", `/pending/${asked.body.pendingId}/approve`, {}, "a@btc.test")).body.error, "same_admin");
    assert.equal((await btc("POST", `/pending/${asked.body.pendingId}/approve`, {}, "b@btc.test")).status, 200);
    assert.deepEqual(sqlite.prepare("SELECT status, notes FROM similarity_flags WHERE id = ?").get(flag.id), { status: "confirmed", notes: "chép ai.js" });

    const notified = await btc("POST", `/flags/${flag.id}/notify`, { reason: "đã email đội" });
    assert.deepEqual([notified.status, notified.body.explainBy - notified.body.notifiedAt], [200, 48 * 60 * 60 * 1000]);
    assert.equal((await btc("POST", `/flags/${flag.id}/notify`, { reason: "lần hai" })).body.error, "already_notified");
    const listed = (await btc("GET", "/flags?status=confirmed")).body.flags[0];
    assert.equal(listed.notified_at, h.env.clock);
    assert.equal((await btc("GET", "/audit/verify")).body.ok, true);
  });
});

describe("bot-cup migration 0007", () => {
  it("rebuilds jobs with the probe kind and keeps every existing job", () => {
    const dir = path.join(__dirname, "../apps/bot-cup-api/migrations");
    const files = fs.readdirSync(dir).filter((file) => file.endsWith(".sql")).sort();
    const db = new DatabaseSync(":memory:");
    for (const file of files.filter((name) => name < "0007")) db.exec(fs.readFileSync(path.join(dir, file), "utf8"));
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("INSERT INTO jobs (id, event_id, kind, priority, submission_id, status, attempts, created_at, updated_at) VALUES ('j1', 'ev', 'check', 20, 's1', 'done', 1, 5, 6)").run();
    db.prepare("INSERT INTO jobs (id, event_id, kind, priority, match_id, status, attempts, created_at, updated_at, last_error) VALUES ('j2', 'ev', 'match', 30, 'm1', 'failed', 3, 7, 8, 'boom')").run();
    db.exec(fs.readFileSync(path.join(dir, files.find((name) => name.startsWith("0007"))), "utf8"));
    assert.deepEqual(db.prepare("SELECT id, kind, status, attempts, last_error FROM jobs ORDER BY id").all().map((row) => ({ ...row })), [
      { id: "j1", kind: "check", status: "done", attempts: 1, last_error: null },
      { id: "j2", kind: "match", status: "failed", attempts: 3, last_error: "boom" }
    ]);
    assert.throws(() => db.prepare("INSERT INTO jobs (id, event_id, kind, priority, submission_id, created_at, updated_at) VALUES ('j3', 'ev', 'probe', 15, 's1', 0, 0)").run(), /CHECK/);
    db.prepare("INSERT INTO jobs (id, event_id, kind, priority, probe_house, probe_set, created_at, updated_at) VALUES ('j4', 'ev', 'probe', 15, 'hard', ?, 0, 0)").run(SET);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'jobs_queue'").get(), "indexes are back");
  });
});
