"use strict";

/**
 * Bot Cup API test harness: the Worker app on SQLite with the real migrations, a fake clock, teams with sessions,
 * runners with tokens, and a stand-in runner that settles jobs with real replays (tests/bot-cup/games.js).
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createD1 } = require("./d1-sqlite");
const { playCompactGame } = require("./games");

const WEB = "https://web.test";
const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 10, 30, 2, 0);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const PY_BOT = "import sys, json\nfor line in sys.stdin:\n    turn = json.loads(line)\n    print(json.dumps({'move': turn['legalMoves'][0]}))\n";

async function createHarness({ event = {}, config = {} } = {}) {
  const { createBotCupApi } = await import("../../apps/bot-cup-api/src/app.mjs");
  const db = createD1();
  const ev = {
    mode: "demo",
    registration_opens_at: START - DAY,
    registration_closes_at: START + 5 * DAY,
    practice_opens_at: START - DAY,
    code_freeze_at: START + 10 * DAY,
    ...event
  };
  db.sqlite.prepare(
    `INSERT INTO events (id, name, mode, registration_opens_at, registration_closes_at, practice_opens_at, code_freeze_at)
     VALUES ('ev', 'Test Cup', ?, ?, ?, ?, ?)`
  ).run(ev.mode, ev.registration_opens_at, ev.registration_closes_at, ev.practice_opens_at, ev.code_freeze_at);
  const env = { clock: START };
  const api = createBotCupApi({
    db,
    mailer: { async send() {} },
    turnstile: { async verify() { return true; } },
    now: () => env.clock,
    config: { eventId: "ev", otpPepper: "test-pepper-0123456789", webOrigin: WEB, allowedOrigins: [WEB], ...config }
  });

  async function call(method, path, { token, cookie, json, body, origin = method === "GET" ? undefined : WEB, headers = {} } = {}) {
    const all = { ...headers };
    if (token) all.authorization = `Bearer ${token}`;
    if (cookie) all.cookie = cookie;
    if (origin) all.origin = origin;
    let payload = body;
    if (json !== undefined) {
      all["content-type"] = "application/json";
      payload = JSON.stringify(json);
    }
    const response = await api.fetch(new Request(`https://api.test${path}`, { method, headers: all, body: payload }));
    const type = response.headers.get("content-type") || "";
    return { status: response.status, body: type.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer()), headers: response.headers };
  }

  let teams = 0;
  function team({ status = "active", name } = {}) {
    teams += 1;
    const id = `team-${teams}`;
    db.sqlite.prepare(
      `INSERT INTO teams (id, event_id, handle, display_name, display_key, kind, status, captain_mssv, password_hash, created_at)
       VALUES (?, 'ev', ?, ?, ?, 'solo', ?, ?, 'x', 0)`
    ).run(id, id, name ?? `Team ${teams}`, `team ${teams} ${name ?? ""}`, status, String(26020100 + teams));
    db.sqlite.prepare("INSERT INTO sessions (id_hash, team_id, created_at, expires_at) VALUES (?, ?, 0, ?)").run(sha256(`session-${id}`), id, START * 10);
    return { id, cookie: `__Host-ottcup_session=session-${id}` };
  }

  let runners = 0;
  function runner(name = `runner-${++runners}`) {
    const token = `${name}-token-${"x".repeat(40)}`;
    db.sqlite.prepare("INSERT INTO runners (id, name, token_hash, created_at) VALUES (?, ?, ?, 0)").run(`id-${name}`, name, sha256(token));
    return token;
  }

  async function upload(owner, content = PY_BOT, filename = "bot.py") {
    const form = new FormData();
    form.append("file", new Blob([content]), filename);
    const result = await call("POST", "/api/t/submissions", { cookie: owner.cookie, body: form });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.submission;
  }

  /**
   * Plays every queued job like a runner would: checks pass, games are real games where seat A plays first-legal and
   * seat B last-legal (or whatever `pick` returns for the job).
   */
  async function drain(token, { pick } = {}) {
    for (;;) {
      const jobs = (await call("POST", "/runner/claim", { token, json: { slots: 8 } })).body.jobs;
      if (!jobs.length) return;
      for (const job of jobs) {
        if (job.kind === "check") {
          await call("POST", "/runner/complete", { token, json: { jobId: job.jobId, attempt: job.attempt, ok: true, log: "ok" } });
        } else {
          const options = pick ? pick(job) : {};
          const replay = await playCompactGame({ mapId: job.match.mapId, ...options });
          const done = await call("POST", "/runner/complete", { token, json: { jobId: job.jobId, attempt: job.attempt, replay, stderr: { A: "log A\n", B: "log B\n" } } });
          assert.equal(done.status, 200, JSON.stringify(done.body));
        }
      }
    }
  }

  /** A submission that passed its check and smoke test. */
  async function readySubmission(owner, token, content) {
    const submission = await upload(owner, content ?? `${PY_BOT}# ${owner.id} ${Math.random()}\n`);
    await drain(token);
    const status = db.sqlite.prepare("SELECT status FROM submissions WHERE id = ?").get(submission.id).status;
    assert.equal(status, "ready");
    return submission;
  }

  return { db, env, api, call, team, runner, upload, drain, readySubmission };
}

module.exports = { createHarness, START, DAY, WEB, PY_BOT, sha256 };
