"use strict";

/**
 * Bot Cup runner API (apps/bot-cup-api/src/runner, P4) on SQLite with the real migrations: a submission becomes a check
 * job, a passed check becomes two smoke games, verified replays settle the submission's status. Also leases, retries,
 * forged replays, idempotent completion, and that runners need a live token.
 * Plan: docs/superpowers/plans/2026-10-23-uet-k71-bot-cup.md §6.2, §8.4, §10.3, §12 P4.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createD1 } = require("./bot-cup/d1-sqlite");
const { playCompactGame } = require("./bot-cup/games");

const WEB = "https://web.test";
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const START = Date.UTC(2026, 10, 30, 2, 0);

let createBotCupApi;
before(async () => {
  ({ createBotCupApi } = await import("../apps/bot-cup-api/src/app.mjs"));
});

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const PY_BOT = "import sys, json\nfor line in sys.stdin:\n    turn = json.loads(line)\n    print(json.dumps({'move': turn['legalMoves'][0]}))\n";

function setup({ runnerImageId = null } = {}) {
  const db = createD1();
  db.sqlite.prepare(
    `INSERT INTO events (id, name, mode, registration_opens_at, registration_closes_at, practice_opens_at, code_freeze_at)
     VALUES ('ev', 'Test', 'demo', ?, ?, ?, ?)`
  ).run(START - DAY, START + 10 * DAY, START - DAY, START + 10 * DAY);
  const env = { clock: START };
  const api = createBotCupApi({
    db,
    mailer: { async send() {} },
    turnstile: { async verify() { return true; } },
    now: () => env.clock,
    config: { eventId: "ev", otpPepper: "test-pepper-0123456789", webOrigin: WEB, allowedOrigins: [WEB], runnerImageId }
  });

  db.sqlite.prepare(
    `INSERT INTO teams (id, event_id, handle, display_name, display_key, kind, status, captain_mssv, password_hash, created_at)
     VALUES ('team-1', 'ev', 'team-1', 'Team 1', 'team 1', 'solo', 'active', '26020101', 'x', 0)`
  ).run();
  db.sqlite.prepare("INSERT INTO sessions (id_hash, team_id, created_at, expires_at) VALUES (?, 'team-1', 0, ?)").run(sha256("session-1"), START * 2);
  const cookie = "__Host-ottcup_session=session-1";

  function runner(name) {
    const token = `${name}-token-${"x".repeat(40)}`;
    db.sqlite.prepare("INSERT INTO runners (id, name, token_hash, created_at) VALUES (?, ?, ?, 0)").run(`runner-${name}`, name, sha256(token));
    return token;
  }

  async function call(method, path, { token, cookie: sessionCookie, json, body, origin } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (sessionCookie) headers.cookie = sessionCookie;
    if (origin) headers.origin = origin;
    let payload = body;
    if (json !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(json);
    }
    const response = await api.fetch(new Request(`https://api.test${path}`, { method, headers, body: payload }));
    const type = response.headers.get("content-type") || "";
    return { status: response.status, body: type.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer()), headers: response.headers };
  }

  async function upload(content = PY_BOT) {
    const form = new FormData();
    form.append("file", new Blob([content]), "bot.py");
    const result = await call("POST", "/api/t/submissions", { cookie, body: form, origin: WEB });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.submission;
  }

  const claim = (token, slots = 4) => call("POST", "/runner/claim", { token, json: { slots } });
  const complete = (token, json) => call("POST", "/runner/complete", { token, json });
  const submission = (id) => db.sqlite.prepare("SELECT status, check_log FROM submissions WHERE id = ?").get(id);
  const job = (id) => db.sqlite.prepare("SELECT * FROM jobs WHERE id = ?").get(id);

  return { db, env, call, cookie, runner, upload, claim, complete, submission, job };
}

/** The two smoke games ordered as [team plays Red (A), team plays Blue (B)]. */
const bySeat = (jobs) => [jobs.find((j) => j.match.seats.A.submission), jobs.find((j) => j.match.seats.B.submission)];

/** A real game where the team's bot sits at `seat`; `fault` makes that seat play an illegal move on its third turn. */
function smokeReplay(seat, { fault = false } = {}) {
  const illegal = fault ? (turn) => turn.ply > 4 : null;
  return playCompactGame(seat === "A" ? { faultA: illegal } : { faultB: illegal });
}

describe("bot-cup runner API: check and smoke test", () => {
  it("checks a new submission, plays two smoke games and marks it ready", async () => {
    const t = setup();
    const token = t.runner("main");
    const other = t.runner("spare");
    const submission = await t.upload();

    const first = await t.claim(token);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.jobs.length, 1);
    const check = first.body.jobs[0];
    assert.deepEqual({ kind: check.kind, attempt: check.attempt, submission: check.submission }, { kind: "check", attempt: 1, submission: { sha256: submission.sha256, language: "python" } });
    assert.deepEqual((await t.claim(other)).body.jobs, [], "a leased job is not handed out twice");

    const source = await t.call("GET", `/runner/source/${submission.sha256}`, { token });
    assert.equal(source.status, 200);
    assert.equal(source.body.toString("utf8"), PY_BOT);
    assert.equal((await t.call("GET", `/runner/source/${submission.sha256}`, { token: other })).status, 404, "only the lease holder reads the source");

    const checked = await t.complete(token, { jobId: check.jobId, attempt: 1, ok: true, log: "Build and syntax verification succeeded" });
    assert.deepEqual(checked.body, { ok: true, status: "checking", smokeGames: 2 });

    const games = bySeat((await t.claim(token)).body.jobs);
    assert.equal(games.length, 2);
    assert.deepEqual(games.map((g) => [g.kind, g.match.mapId, g.match.policy.matchPolicyVersion]), [["match", "classic", "bot-cup-policy-v1"], ["match", "classic", "bot-cup-policy-v1"]]);
    assert.deepEqual(games[0].match.seats, { A: { submission: { sha256: submission.sha256, language: "python" } }, B: { house: "easy" } });
    assert.deepEqual(games[1].match.seats, { A: { house: "easy" }, B: { submission: { sha256: submission.sha256, language: "python" } } });
    assert.doesNotMatch(JSON.stringify(games), /team|Team/, "the runner learns no team identity");

    const replayA = await smokeReplay("A");
    const done = await t.complete(token, { jobId: games[0].jobId, attempt: 1, replay: replayA, stderr: { A: "thinking…\n", B: "" } });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(t.submission(submission.id).status, "checking", "still waiting for the second game");
    await t.complete(token, { jobId: games[1].jobId, attempt: 1, replay: await smokeReplay("B"), stderr: {} });
    assert.equal(t.submission(submission.id).status, "ready");

    const detail = await t.call("GET", `/api/t/submissions/${submission.id}`, { cookie: t.cookie });
    assert.equal(detail.body.submission.status, "ready");
    assert.match(detail.body.submission.checkLog, /Qua chạy thử/);
    assert.deepEqual(detail.body.submission.smoke.map((g) => [g.seat, g.opponent, g.status, g.stderr]), [["A", "easy", "finished", "thinking…\n"], ["B", "easy", "finished", null]]);
    const stored = t.db.sqlite.prepare("SELECT replay_gz, replay_sha256, plies FROM matches WHERE id = ?").get(games[0].match.id);
    assert.equal(stored.plies, replayA.moves.length);
    assert.equal(stored.replay_sha256, sha256(JSON.stringify(replayA)));
    assert.deepEqual(JSON.parse(require("node:zlib").gunzipSync(stored.replay_gz).toString("utf8")), replayA);
  });

  it("marks a submission build_failed with the compiler log, and smoke_failed when its bot faults", async () => {
    const t = setup();
    const token = t.runner("main");
    const broken = await t.upload("def f(:\n");
    const [check] = (await t.claim(token)).body.jobs;
    await t.complete(token, { jobId: check.jobId, attempt: 1, ok: false, log: "SyntaxError: invalid syntax" });
    assert.deepEqual(t.submission(broken.id), { status: "build_failed", check_log: "SyntaxError: invalid syntax" });
    assert.deepEqual((await t.claim(token)).body.jobs, [], "no smoke games for a build failure");

    const faulty = await t.upload(`${PY_BOT}# v2\n`);
    const [check2] = (await t.claim(token)).body.jobs;
    await t.complete(token, { jobId: check2.jobId, attempt: 1, ok: true, log: "ok" });
    const games = bySeat((await t.claim(token)).body.jobs);
    await t.complete(token, { jobId: games[0].jobId, attempt: 1, replay: await smokeReplay("A", { fault: true }), stderr: {} });
    await t.complete(token, { jobId: games[1].jobId, attempt: 1, replay: await smokeReplay("B"), stderr: {} });
    const status = t.submission(faulty.id);
    assert.equal(status.status, "smoke_failed");
    assert.match(status.check_log, /Ván cầm Đỏ \(classic\): đi nước không hợp lệ/);
  });
});

describe("bot-cup runner API: trust and failure handling", () => {
  async function leasedGame(t, token) {
    await t.upload();
    const [check] = (await t.claim(token)).body.jobs;
    await t.complete(token, { jobId: check.jobId, attempt: 1, ok: true, log: "ok" });
    // Both smoke games are leased; the second is settled so only the first is left in play.
    const [game, other] = bySeat((await t.claim(token)).body.jobs);
    await t.complete(token, { jobId: other.jobId, attempt: 1, replay: await smokeReplay("B"), stderr: {} });
    return game;
  }

  it("refuses a forged replay and marks the runner as suspect", async () => {
    const t = setup();
    const token = t.runner("main");
    const game = await leasedGame(t, token);
    const replay = await smokeReplay("A");
    const forged = JSON.parse(JSON.stringify(replay));
    forged.result.winner = replay.result.loser;
    forged.result.loser = replay.result.winner;
    const result = await t.complete(token, { jobId: game.jobId, attempt: 1, replay: forged, stderr: {} });
    assert.equal(result.status, 422);
    assert.equal(result.body.error, "replay_rejected");
    assert.equal(t.job(game.jobId).status, "failed");
    const runner = t.db.sqlite.prepare("SELECT suspect_at, suspect_reason FROM runners WHERE name = 'main'").get();
    assert.ok(runner.suspect_at);
    assert.match(runner.suspect_reason, /replay_winner/);
    assert.equal(t.db.sqlite.prepare("SELECT status FROM matches WHERE id = ?").get(game.match.id).status, "failed");
  });

  it("returns a job whose lease ran out to the queue, and the old lease can no longer report", async () => {
    const t = setup();
    const slow = t.runner("slow");
    const fresh = t.runner("fresh");
    const game = await leasedGame(t, slow);
    assert.deepEqual((await t.claim(fresh)).body.jobs, [], "the leased game is not handed out again");
    t.env.clock += 5 * MINUTE;
    const reclaimed = (await t.claim(fresh)).body.jobs;
    assert.deepEqual(reclaimed.map((j) => [j.jobId, j.attempt]), [[game.jobId, 2]]);
    const late = await t.complete(slow, { jobId: game.jobId, attempt: 1, replay: await smokeReplay("A"), stderr: {} });
    assert.deepEqual([late.status, late.body.error], [409, "lease_lost"]);
    const ok = await t.complete(fresh, { jobId: game.jobId, attempt: 2, replay: await smokeReplay("A"), stderr: {} });
    assert.equal(ok.status, 200);
    const again = await t.complete(fresh, { jobId: game.jobId, attempt: 2, replay: await smokeReplay("A"), stderr: {} });
    assert.deepEqual(again.body, { ok: true, duplicate: true }, "a retried report is accepted once");
  });

  it("retries an infrastructure failure up to three leases, then fails the job", async () => {
    const t = setup();
    const token = t.runner("main");
    const game = await leasedGame(t, token);
    for (const attempt of [1, 2]) {
      const failed = await t.call("POST", "/runner/fail", { token, json: { jobId: game.jobId, attempt, detail: "docker: daemon not running" } });
      assert.deepEqual(failed.body, { ok: true, status: "queued" });
      const [again] = (await t.claim(token, 1)).body.jobs;
      assert.equal(again.attempt, attempt + 1);
    }
    const last = await t.call("POST", "/runner/fail", { token, json: { jobId: game.jobId, attempt: 3, detail: "docker: daemon not running" } });
    assert.deepEqual(last.body, { ok: true, status: "failed" });
    assert.equal(t.job(game.jobId).last_error, "docker: daemon not running");
    assert.equal(t.db.sqlite.prepare("SELECT status FROM matches WHERE id = ?").get(game.match.id).status, "failed");
    assert.deepEqual((await t.claim(token)).body.jobs, []);
  });

  it("serves higher-priority work first", async () => {
    const t = setup();
    const token = t.runner("main");
    await t.upload();
    const { enqueueMatch } = await import("../apps/bot-cup-api/src/queue.mjs");
    const { createStore } = await import("../apps/bot-cup-api/src/store.mjs");
    const store = createStore(t.db);
    const ko = enqueueMatch(store, { eventId: "ev", stage: "knockout", mapId: "center", a: { house: "hard" }, b: { house: "easy" }, now: t.env.clock + 1 });
    const practice = enqueueMatch(store, { eventId: "ev", stage: "practice", mapId: "flanks", a: { house: "hard" }, b: { house: "easy" }, now: t.env.clock - 1 });
    await t.db.batch([...practice.statements, ...ko.statements]);
    const order = (await t.claim(token, 3)).body.jobs.map((j) => j.kind === "check" ? "check" : j.match.mapId);
    assert.deepEqual(order, ["center", "check", "flanks"]);
  });

  it("needs a live runner token, and the configured image when one is set", async () => {
    const t = setup({ runnerImageId: "sha256:expected" });
    const token = t.runner("main");
    assert.equal((await t.claim(null)).status, 401);
    assert.equal((await t.claim("not-a-real-token-but-long-enough-xxxxxxxxxxxx")).status, 401);
    const wrong = await t.claim(token);
    assert.deepEqual([wrong.status, wrong.body.error], [409, "runner_image_mismatch"]);
    await t.call("POST", "/runner/heartbeat", { token, json: { version: "test", imageId: "sha256:expected", slots: 4, active: 0 } });
    assert.equal((await t.claim(token)).status, 200);
    const seen = t.db.sqlite.prepare("SELECT last_seen_at, version, slots FROM runners WHERE name = 'main'").get();
    assert.deepEqual(seen, { last_seen_at: START, version: "test", slots: 4 });
    t.db.sqlite.prepare("UPDATE runners SET revoked_at = 1 WHERE name = 'main'").run();
    assert.equal((await t.claim(token)).status, 401);
  });
});
