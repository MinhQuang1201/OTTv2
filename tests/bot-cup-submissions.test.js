"use strict";

/**
 * Bot Cup submissions (apps/bot-cup-api, P3) against the real migrations on SQLite: upload checks, SHA-256 receipt,
 * daily limit, versions, final submission, code freeze, copy flags, and that one team cannot read another's code.
 * Plan: docs/superpowers/plans/2026-10-23-uet-k71-bot-cup.md §6, §8.2, §8.5, §12 P3.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createD1 } = require("./bot-cup/d1-sqlite");

const WEB = "https://web.test";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PRACTICE = Date.UTC(2026, 10, 30, 1, 0); // 08:00 in Vietnam
const FREEZE = PRACTICE + 7 * DAY;
const ROOT = path.resolve(__dirname, "..");

let createBotCupApi;
before(async () => {
  ({ createBotCupApi } = await import("../apps/bot-cup-api/src/app.mjs"));
});

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function setup({ practiceOpensAt = PRACTICE, codeFreezeAt = FREEZE } = {}) {
  const db = createD1();
  db.sqlite.prepare(
    `INSERT INTO events (id, name, mode, registration_opens_at, registration_closes_at, practice_opens_at, code_freeze_at)
     VALUES ('ev', 'Test', 'demo', ?, ?, ?, ?)`
  ).run(PRACTICE - 10 * DAY, FREEZE, practiceOpensAt, codeFreezeAt);
  const env = { clock: PRACTICE + HOUR };
  const api = createBotCupApi({
    db,
    mailer: { async send() {} },
    turnstile: { async verify() { return true; } },
    now: () => env.clock,
    config: { eventId: "ev", otpPepper: "test-pepper-0123456789", webOrigin: WEB, allowedOrigins: [WEB] }
  });

  let counter = 0;
  /** An active solo team with a session, written straight to the tables. */
  function team({ status = "active" } = {}) {
    counter += 1;
    const id = `team-${counter}`;
    const mssv = String(26020100 + counter);
    db.sqlite.prepare(
      `INSERT INTO teams (id, event_id, handle, display_name, display_key, kind, status, captain_mssv, password_hash, created_at)
       VALUES (?, 'ev', ?, ?, ?, 'solo', ?, ?, 'x', 0)`
    ).run(id, `team-${counter}`, `Team ${counter}`, `team ${counter}`, status, mssv);
    const token = `session-token-${counter}`;
    db.sqlite.prepare("INSERT INTO sessions (id_hash, team_id, created_at, expires_at) VALUES (?, ?, 0, ?)").run(sha256(token), id, FREEZE * 2);
    return { id, cookie: `__Host-ottcup_session=${token}` };
  }

  async function send(method, url, { cookie, body, headers = {}, origin = WEB } = {}) {
    const init = { method, headers: { ...headers } };
    if (origin) init.headers.origin = origin;
    if (cookie) init.headers.cookie = cookie;
    if (body !== undefined) init.body = body;
    if (body instanceof FormData) init.duplex = "half";
    return api.fetch(new Request(`https://api.test/api/t${url}`, init));
  }

  async function call(method, url, options = {}) {
    const options2 = { ...options };
    if (options.json !== undefined) {
      options2.body = JSON.stringify(options.json);
      options2.headers = { "content-type": "application/json" };
    }
    const response = await send(method, url, options2);
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, body, headers: response.headers };
  }

  function upload(cookie, content, filename = "bot.py") {
    const form = new FormData();
    form.append("file", new Blob([content]), filename);
    return call("POST", "/submissions", { cookie, body: form });
  }

  return { db, env, team, call, upload };
}

const PY_BOT = "import sys, json\nfor line in sys.stdin:\n    turn = json.loads(line)\n    print(json.dumps({'move': turn['legalMoves'][0]}))\n";

describe("bot-cup submissions: upload checks", () => {
  it("stores an upload with its SHA-256 and version number, and lists it", async () => {
    const { team, upload, call, db } = setup();
    const { cookie } = team();
    const created = await upload(cookie, PY_BOT, "my_bot.py");
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(
      { ...created.body.submission, id: "<id>" },
      { id: "<id>", version: 1, language: "python", filename: "my_bot.py", size: Buffer.byteLength(PY_BOT), sha256: sha256(PY_BOT), origin: "upload", status: "checking", createdAt: PRACTICE + HOUR }
    );
    const stored = db.sqlite.prepare("SELECT content FROM submission_sources WHERE sha256 = ?").get(sha256(PY_BOT));
    assert.equal(stored.content.toString("utf8"), PY_BOT);

    const js = await upload(cookie, "console.error('hi');\n", "bot.mjs");
    assert.equal(js.body.submission.version, 2);
    assert.equal(js.body.submission.language, "node");

    const list = await call("GET", "/submissions", { cookie });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.submissions.map((s) => s.version), [2, 1]);
    assert.equal(list.body.finalSubmissionId, js.body.submission.id);
    assert.equal(list.body.finalChosen, false);
    assert.deepEqual(list.body.quota, { perDay: 10, usedToday: 2, resetsAt: Date.UTC(2026, 10, 30, 17, 0), maxVersions: 200, total: 2 });
    assert.equal(list.body.window.open, true);
  });

  it("rejects files over 200 KB, binary files, bad encodings, wrong extensions and empty files", async () => {
    const { team, upload, db } = setup();
    const { cookie } = team();
    const cases = [
      ["x".repeat(200 * 1024 + 1), "bot.py", 413, "submission_too_large"],
      ["# padding\n".repeat(30 * 1024), "bot.py", 413, "submission_too_large"],
      [Buffer.from([0x70, 0x72, 0x00, 0x01, 0x0a]), "bot.py", 400, "submission_binary"],
      [Buffer.from([0x23, 0x20, 0xc3, 0x28, 0x0a]), "bot.py", 400, "submission_encoding"],
      ["print(1)\n", "bot.txt", 400, "submission_extension"],
      ["print(1)\n", "bot.cpp", 400, "submission_extension"],
      ["print(1)\n", ".py", 400, "submission_extension"],
      ["  \n\n", "bot.py", 400, "submission_empty"]
    ];
    for (const [content, filename, status, error] of cases) {
      const result = await upload(cookie, content, filename);
      assert.equal(result.status, status, `${filename} ${error}: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.error, error);
    }
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM submissions").get().n, 0);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM submission_sources").get().n, 0);
  });

  it("accepts exactly 200 KB and Vietnamese text in UTF-8", async () => {
    const { team, upload } = setup();
    const { cookie } = team();
    const head = "# Bot của đội Một\n";
    const content = head + "#".repeat(200 * 1024 - Buffer.byteLength(head));
    const result = await upload(cookie, content, "bot.py");
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.submission.size, 200 * 1024);
  });

  it("refuses the same file twice for one team, with the version it already has", async () => {
    const { team, upload } = setup();
    const { cookie } = team();
    await upload(cookie, PY_BOT);
    const again = await upload(cookie, PY_BOT, "renamed.py");
    assert.equal(again.status, 409);
    assert.deepEqual(again.body, { error: "submission_duplicate", version: 1 });
  });

  it("needs a session, an active team, a same-site Origin and multipart", async () => {
    const { team, upload, call } = setup();
    assert.equal((await upload(null, PY_BOT)).status, 401);
    const pending = team({ status: "pending_members" });
    const blocked = await upload(pending.cookie, PY_BOT);
    assert.deepEqual([blocked.status, blocked.body.error], [403, "team_not_active"]);
    const { cookie } = team();
    const form = new FormData();
    form.append("file", new Blob([PY_BOT]), "bot.py");
    assert.equal((await call("POST", "/submissions", { cookie, body: form, origin: "https://evil.test" })).body.error, "forbidden_origin");
    assert.equal((await call("POST", "/submissions", { cookie, json: { file: PY_BOT } })).status, 415);
  });
});

describe("bot-cup submissions: window and limits", () => {
  it("opens with practice and closes at code freeze", async () => {
    const early = setup({ practiceOpensAt: PRACTICE + DAY });
    const t1 = early.team();
    const notOpen = await early.upload(t1.cookie, PY_BOT);
    assert.deepEqual([notOpen.status, notOpen.body.error], [409, "submissions_not_open"]);

    const unscheduled = setup({ practiceOpensAt: null });
    assert.equal((await unscheduled.upload(unscheduled.team().cookie, PY_BOT)).body.error, "submissions_not_open");

    const late = setup();
    const t2 = late.team();
    late.env.clock = FREEZE;
    const frozen = await late.upload(t2.cookie, PY_BOT);
    assert.deepEqual([frozen.status, frozen.body.error], [409, "code_frozen"]);
  });

  it("allows 10 uploads per Vietnamese day and resets at midnight UTC+7", async () => {
    const { team, upload, env, call } = setup();
    const { cookie } = team();
    for (let i = 0; i < 10; i++) assert.equal((await upload(cookie, `${PY_BOT}# v${i}\n`)).status, 201);
    const eleventh = await upload(cookie, `${PY_BOT}# v10\n`);
    assert.equal(eleventh.status, 429);
    assert.equal(eleventh.body.error, "submission_daily_limit");
    const midnight = Date.UTC(2026, 10, 30, 17, 0);
    assert.equal(eleventh.body.retryAfterMs, midnight - env.clock);

    env.clock = midnight - 1;
    assert.equal((await upload(cookie, `${PY_BOT}# v11\n`)).status, 429);
    env.clock = midnight;
    assert.equal((await upload(cookie, `${PY_BOT}# v12\n`)).status, 201);
    assert.equal((await call("GET", "/submissions", { cookie })).body.quota.usedToday, 1);
  });

  it("stops at 200 versions per team", async () => {
    const { team, upload, db, env } = setup();
    const t = team();
    const insert = db.sqlite.prepare(
      `INSERT INTO submissions (id, event_id, team_id, seq, language, filename, size, sha256, normalized_hash, created_at)
       VALUES (?, 'ev', ?, ?, 'python', 'bot.py', 1, ?, 'n', 0)`
    );
    for (let seq = 1; seq <= 200; seq++) insert.run(`old-${seq}`, t.id, seq, `sha-${seq}`);
    env.clock += DAY;
    const result = await upload(t.cookie, PY_BOT);
    assert.deepEqual([result.status, result.body.error], [409, "submission_version_limit"]);
  });
});

describe("bot-cup submissions: final submission", () => {
  it("defaults to the newest eligible version, can be chosen, and is locked at code freeze", async () => {
    const { team, upload, call, env, db } = setup();
    const { cookie, id: teamId } = team();
    const v1 = (await upload(cookie, `${PY_BOT}# 1\n`)).body.submission;
    const v2 = (await upload(cookie, `${PY_BOT}# 2\n`)).body.submission;

    const chosen = await call("PUT", "/team/final-submission", { cookie, json: { submissionId: v1.id } });
    assert.equal(chosen.status, 200);
    assert.equal(chosen.body.finalSubmissionId, v1.id);
    assert.equal(chosen.body.finalChosen, true);

    // A version that failed its checks stops being the final one; the newest eligible one takes over.
    db.sqlite.prepare("UPDATE submissions SET status = 'build_failed' WHERE id = ?").run(v1.id);
    const fallback = await call("GET", "/submissions", { cookie });
    assert.equal(fallback.body.finalSubmissionId, v2.id);
    assert.equal(fallback.body.finalChosen, false);
    const refused = await call("PUT", "/team/final-submission", { cookie, json: { submissionId: v1.id } });
    assert.deepEqual([refused.status, refused.body.error], [409, "submission_not_eligible"]);

    assert.equal((await call("PUT", "/team/final-submission", { cookie, json: { submissionId: null } })).body.finalChosen, false);

    env.clock = FREEZE;
    const frozen = await call("PUT", "/team/final-submission", { cookie, json: { submissionId: v2.id } });
    assert.deepEqual([frozen.status, frozen.body.error], [409, "code_frozen"]);
    assert.equal(db.sqlite.prepare("SELECT final_submission_id AS id FROM teams WHERE id = ?").get(teamId).id, null);
  });

  it("does not let a team pick, read or download another team's submission", async () => {
    const { team, upload, call } = setup();
    const owner = team();
    const other = team();
    const theirs = (await upload(owner.cookie, PY_BOT)).body.submission;
    assert.equal((await call("GET", `/submissions/${theirs.id}`, { cookie: other.cookie })).status, 404);
    assert.equal((await call("GET", `/submissions/${theirs.id}/source`, { cookie: other.cookie })).status, 404);
    assert.equal((await call("PUT", "/team/final-submission", { cookie: other.cookie, json: { submissionId: theirs.id } })).status, 404);

    const mine = await call("GET", `/submissions/${theirs.id}`, { cookie: owner.cookie });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.submission.checkLog, null);
    const source = await call("GET", `/submissions/${theirs.id}/source`, { cookie: owner.cookie });
    assert.equal(source.status, 200);
    assert.equal(source.body, PY_BOT);
    assert.match(source.headers.get("content-disposition"), /attachment; filename="team-1-v1\.py"/);
    assert.equal(source.headers.get("x-content-type-options"), "nosniff");
  });
});

describe("bot-cup submissions: immutability and copy flags", () => {
  it("keeps submissions append-only in the database", async () => {
    const { team, upload, db } = setup();
    const { cookie } = team();
    const { id } = (await upload(cookie, PY_BOT)).body.submission;
    assert.throws(() => db.sqlite.prepare("UPDATE submissions SET sha256 = 'x' WHERE id = ?").run(id), /append-only/);
    assert.throws(() => db.sqlite.prepare("DELETE FROM submissions WHERE id = ?").run(id), /append-only/);
    assert.throws(() => db.sqlite.prepare("UPDATE submission_sources SET content = x'00'").run(), /immutable/);
    db.sqlite.prepare("UPDATE submissions SET status = 'ready', check_log = 'ok' WHERE id = ?").run(id);
  });

  it("flags a copy of another team's bot that only renames, reformats and recomments it", async () => {
    const { team, upload, db } = setup();
    const a = team();
    const b = team();
    const c = team();
    const original = "def best(moves):\n    # pick the first\n    return moves[0]\n\nimport sys\nfor line in sys.stdin:\n    print(best(line))\n";
    const disguised = "def chon(ds):\n    '''Chọn nước đầu.'''\n    return ds[ 0 ]\nimport sys\nfor dong in sys.stdin:  # vòng lặp\n    print(chon(dong))\n";
    const different = "import sys\nfor line in sys.stdin:\n    if line:\n        print(line[::-1])\n";
    const first = (await upload(a.cookie, original)).body.submission;
    const copy = (await upload(b.cookie, disguised)).body.submission;
    await upload(c.cookie, different);
    const flags = db.sqlite.prepare("SELECT kind, submission_id, other_submission_id, reference, status FROM similarity_flags").all();
    assert.deepEqual(flags, [{ kind: "hash", submission_id: copy.id, other_submission_id: first.id, reference: null, status: "open" }]);
  });

  it("flags an unchanged reference bot and the starter template", async () => {
    const { team, upload, db } = setup();
    const { cookie } = team();
    const sentinel = fs.readFileSync(path.join(ROOT, "bots/sentinel.mjs"), "utf8").replace(/Sentinel/g, "Guardian");
    const template = fs.readFileSync(path.join(ROOT, "sdk/bot-cup/python/bot.py"), "utf8");
    await upload(cookie, sentinel, "guardian.mjs");
    await upload(cookie, template, "bot.py");
    const references = db.sqlite.prepare("SELECT reference FROM similarity_flags ORDER BY created_at, rowid").all().map((row) => row.reference);
    assert.deepEqual(references, ["bots/sentinel.mjs", "sdk/bot-cup/python/bot.py"]);
  });

  it("does not show flags to the team", async () => {
    const { team, upload, call } = setup();
    const { cookie } = team();
    const template = fs.readFileSync(path.join(ROOT, "sdk/bot-cup/js/bot.mjs"), "utf8");
    const created = await upload(cookie, template, "bot.mjs");
    assert.doesNotMatch(JSON.stringify(created.body), /flag|similar|reference/i);
    assert.doesNotMatch(JSON.stringify((await call("GET", "/submissions", { cookie })).body), /flag|similar|reference/i);
  });
});
