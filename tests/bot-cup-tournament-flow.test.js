"use strict";

/**
 * A whole Demo tournament through the admin steps and the runner API, on SQLite with the real migrations (P7):
 * code freeze -> gate -> round robin -> Top 4 interviews (one fails, the 5th steps in) -> knockout with a tie-break ->
 * final and third place -> published documents with SHA-256 -> appeals. Who wins each game is set by making the losing
 * seat play an illegal move on its first turn, so every result is a real, verified replay.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createHarness, START, DAY } = require("./bot-cup/harness");
const { playCompactGame } = require("./bot-cup/games");

const ADMIN_ORIGIN = "https://btc.test";
const FREEZE = START + 3 * DAY;

let adminMod;
before(async () => {
  adminMod = await import("../apps/bot-cup-admin/src/app.mjs");
});

describe("bot-cup tournament flow (Demo)", () => {
  it("runs freeze, gate, round robin, interviews, knockout with a tie-break, and publishes verifiable results", async () => {
    const h = await createHarness({ event: { code_freeze_at: FREEZE } });
    const sqlite = h.db.sqlite;
    const runner = h.runner();
    const randoms = [0.5, 0.1];
    const admin = adminMod.createAdminApi({
      db: h.db,
      now: () => h.env.clock,
      config: { eventId: "ev", authMode: "password", allowedOrigins: [ADMIN_ORIGIN], random: () => randoms.shift() ?? 0 }
    });
    for (const email of ["a@btc.test", "b@btc.test"]) sqlite.prepare("INSERT INTO admins (email, role, added_by, created_at) VALUES (?, 'admin', 'test', 0)").run(email);
    const session = (email) => {
      const token = `admin-session-${email}`;
      sqlite.prepare("INSERT INTO admin_sessions (id_hash, email, created_at, expires_at) VALUES (?, ?, 0, ?)").run(crypto.createHash("sha256").update(token).digest("hex"), email, START * 10);
      return `__Host-ottcup_admin=${token}`;
    };
    const cookieA = session("a@btc.test");
    async function btc(method, path, json) {
      const init = { method, headers: { cookie: cookieA } };
      if (json !== undefined) {
        init.headers.origin = ADMIN_ORIGIN;
        init.headers["content-type"] = "application/json";
        init.body = JSON.stringify(json);
      }
      const response = await admin.fetch(new Request(`${ADMIN_ORIGIN}/admin-api${path}`, init));
      return { status: response.status, headers: response.headers, body: await response.json() };
    }
    const stepOk = async (name, extra = {}) => {
      const result = await btc("POST", `/tournament/${name}`, { reason: `bước ${name}`, ...extra });
      assert.equal(result.status, 200, `${name}: ${JSON.stringify(result.body)}`);
      return result.body;
    };

    // Seven teams with a fixed strength; "weak-1" and "weak-2" lose every game, so they fail the gate.
    const names = ["s1", "s2", "s3", "s4", "s5", "weak-1", "weak-2"];
    const strength = new Map(names.map((name, index) => [name, names.length - index]));
    const teams = {};
    const teamBySha = new Map();
    for (const name of names) {
      const team = h.team({ name: `Đội ${name}` });
      const submission = await h.readySubmission(team, runner, `print("${name}")  # ${Math.random()}\n`);
      teams[name] = { ...team, submission };
      teamBySha.set(submission.sha256, name);
    }
    // The sealed version is the chosen one, not a newer ready one uploaded later.
    h.env.clock += 1000;
    const newer = await h.upload(teams.s1, `print("s1 new")  # ${Math.random()}\n`);
    teamBySha.set(newer.sha256, "s1");
    const chosen = await h.call("PUT", "/api/t/team/final-submission", { cookie: teams.s1.cookie, json: { submissionId: teams.s1.submission.id } });
    assert.equal(chosen.status, 200, JSON.stringify(chosen.body));

    /** Losing seat for a game: weak teams lose everything, house bots lose to real teams, else by strength or schedule. */
    function loserOf(job) {
      const row = sqlite.prepare("SELECT stage, game_index, pairing_id FROM matches WHERE id = ?").get(job.match.id);
      const who = (seat) => (job.match.seats[seat].house ? "house" : teamBySha.get(job.match.seats[seat].submission.sha256));
      const [a, b] = [who("A"), who("B")];
      if (a === "house") return b.startsWith("weak") ? "B" : "A";
      if (b === "house") return a.startsWith("weak") ? "A" : "B";
      if (row.stage === "knockout") {
        const pairing = sqlite.prepare("SELECT slot, team_a FROM pairings WHERE id = ?").get(row.pairing_id);
        if (pairing.slot === "SF1" && row.game_index < 6) {
          // Level 3-3 after six games: the higher seed wins the even games, the lower seed the odd ones.
          const highWins = row.game_index % 2 === 0;
          return (teams[a].id === pairing.team_a) === highWins ? "B" : "A";
        }
      }
      return strength.get(a) > strength.get(b) ? "B" : "A";
    }
    async function drain() {
      for (;;) {
        const jobs = (await h.call("POST", "/runner/claim", { token: runner, json: { slots: 8 } })).body.jobs;
        if (!jobs.length) return;
        for (const job of jobs) {
          if (job.kind === "check") {
            await h.call("POST", "/runner/complete", { token: runner, json: { jobId: job.jobId, attempt: job.attempt, ok: true, log: "ok" } });
            continue;
          }
          const loser = loserOf(job);
          const replay = await playCompactGame({ mapId: job.match.mapId, faultA: loser === "A" ? () => true : null, faultB: loser === "B" ? () => true : null });
          const done = await h.call("POST", "/runner/complete", { token: runner, json: { jobId: job.jobId, attempt: job.attempt, replay, stderr: {} } });
          assert.equal(done.status, 200, JSON.stringify(done.body));
        }
      }
    }
    await drain();

    // ---- code freeze ----
    const early = await btc("POST", "/tournament/freeze", { reason: "thử sớm" });
    assert.deepEqual([early.status, early.body.error], [409, "freeze_too_early"]);
    h.env.clock = FREEZE;
    const frozen = await stepOk("freeze");
    assert.equal(frozen.sealed, 7);
    const sealedDoc = await h.call("GET", "/api/t/results/sealed");
    const sealedText = JSON.stringify(sealedDoc.body, null, 2);
    assert.equal(sealedDoc.headers.get("x-sha256"), crypto.createHash("sha256").update(sealedText).digest("hex"), "the published SHA-256 matches the document");
    assert.equal(sealedDoc.body.entries.find((entry) => entry.team === "Đội s1").sha256, teams.s1.submission.sha256);
    const change = await h.call("PUT", "/api/t/team/final-submission", { cookie: teams.s2.cookie, json: { submissionId: teams.s2.submission.id } });
    assert.deepEqual([change.status, change.body.error], [409, "code_frozen"]);
    assert.throws(() => sqlite.prepare("UPDATE entrants SET sha256 = 'x'").run(), /sealed submissions cannot change/);
    assert.deepEqual((await btc("POST", "/tournament/qualifying-start", { reason: "nhảy cóc" })).body.error, "phase_mismatch");

    // ---- gate ----
    assert.equal((await stepOk("gate-start")).games, 42);
    assert.equal((await btc("POST", "/tournament/gate-close", { reason: "chưa xong" })).body.error, "games_pending");
    await drain();
    const gate = await stepOk("gate-close");
    assert.deepEqual([gate.qualified, gate.format], [5, "round_robin"]);
    const view = (await btc("GET", "/tournament")).body;
    assert.deepEqual(view.entrants.filter((e) => e.gateStatus === "not_qualified").map((e) => e.team).sort(), ["Đội weak-1", "Đội weak-2"]);

    // ---- round robin ----
    const rr = await stepOk("qualifying-start");
    assert.deepEqual([rr.format, rr.teams], ["round_robin", 5]);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM pairings WHERE stage = 'round_robin'").get().n, 10);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM matches WHERE stage = 'round_robin'").get().n, 60);
    await drain();
    const live = (await h.call("GET", "/api/t/tournament")).body;
    assert.deepEqual(live.standings.rows.map((row) => [row.rank, row.displayName, row.points]), [
      [1, "Đội s1", 24], [2, "Đội s2", 18], [3, "Đội s3", 12], [4, "Đội s4", 6], [5, "Đội s5", 0]
    ]);
    assert.doesNotMatch(JSON.stringify(live), /team-\d|2602/, "no ids or MSSV in the public view");
    await stepOk("qualifying-close");

    // ---- appeals ----
    const appeal = (team, body) => h.call("POST", "/api/t/appeals", { cookie: team.cookie, json: { stage: "qualifying", body } });
    for (let i = 0; i < 3; i++) assert.equal((await appeal(teams.s5, `Ván thứ ${i} có vấn đề máy chấm.`)).status, 201);
    assert.equal((await appeal(teams.s5, "Khiếu nại thứ tư cho giai đoạn.")).body.error, "appeal_limit");
    assert.equal((await appeal(teams["weak-1"], "Đội không vào vòng loại.")).status, 201, "a team that failed the gate is still an entrant");
    const outsider = h.team();
    assert.equal((await h.call("POST", "/api/t/appeals", { cookie: outsider.cookie, json: { stage: "qualifying", body: "Không có bài niêm phong." } })).body.error, "appeal_not_entrant");
    const open = (await btc("GET", "/tournament")).body.appeals.find((item) => item.status === "open");
    assert.equal((await btc("POST", `/tournament/appeals/${open.id}/answer`, { response: "Đã xem replay, kết quả giữ nguyên." })).status, 200);
    assert.equal((await h.call("GET", "/api/t/appeals", { cookie: teams.s5.cookie })).body.appeals.filter((item) => item.status === "answered").length, 1);

    // ---- interviews: s2 fails, s5 takes the fourth place ----
    assert.deepEqual((await btc("POST", "/tournament/knockout-start", { reason: "chưa phỏng vấn" })).body.error, "interviews_pending");
    for (const [name, result] of [["s1", "pass"], ["s2", "fail"], ["s3", "pass"], ["s4", "pass"], ["s5", "pass"]]) {
      assert.equal((await btc("POST", "/tournament/interview", { teamId: teams[name].id, result, reason: "phỏng vấn code" })).status, 200);
    }
    const ko = await stepOk("knockout-start");
    assert.deepEqual(ko.pairings, ["SF1", "SF2"]);
    const seeds = sqlite.prepare("SELECT t.display_name, e.seed FROM entrants e JOIN teams t ON t.id = e.team_id WHERE e.seed IS NOT NULL ORDER BY e.seed").all();
    assert.deepEqual(seeds.map((row) => row.display_name), ["Đội s1", "Đội s3", "Đội s4", "Đội s5"]);

    // ---- semi-finals: SF1 (s1 v s5) is level 3-3 and goes to two tie-break games, which s1 wins ----
    await drain();
    const advance1 = await stepOk("knockout-advance");
    assert.deepEqual(advance1.tiebreaks, [{ slot: "SF1", mapId: "flanks" }]);
    await drain();
    const advance2 = await stepOk("knockout-advance");
    assert.deepEqual(advance2.pairings, ["F", "3RD"]);
    await drain();
    const finished = await stepOk("knockout-advance");
    assert.equal(finished.finished, true);

    const final = await h.call("GET", "/api/t/results/final");
    assert.equal(final.headers.get("x-sha256"), crypto.createHash("sha256").update(JSON.stringify(final.body, null, 2)).digest("hex"));
    assert.deepEqual(final.body.ranking.slice(0, 4).map((row) => row.team), ["Đội s1", "Đội s3", "Đội s4", "Đội s5"]);
    assert.equal(final.body.ranking.find((row) => row.team === "Đội s2").place, 5);
    const sf1 = final.body.knockout.find((pairing) => pairing.slot === "SF1");
    assert.deepEqual([sf1.points, sf1.tiebreaks], [[5, 3], 1]);
    assert.equal((await h.call("GET", "/api/t/tournament")).body.phase, "finished");

    // Every step is on the audit chain.
    const actions = sqlite.prepare("SELECT action FROM audit_log ORDER BY seq").all().map((row) => row.action);
    for (const step of ["freeze", "gate-start", "gate-close", "qualifying-start", "qualifying-close", "knockout-start", "knockout-advance"]) assert.ok(actions.includes(`tournament.${step}`), step);
    assert.equal((await btc("GET", "/audit/verify")).body.ok, true);
    const adminDoc = await btc("GET", "/tournament/results/final");
    assert.equal(adminDoc.headers.get("x-sha256"), final.headers.get("x-sha256"), "organisers download the same document");
    // Knockout games are public, with replays.
    const koGame = sqlite.prepare("SELECT id FROM matches WHERE stage = 'knockout' AND status = 'finished' LIMIT 1").get();
    assert.equal((await h.call("GET", `/api/t/matches/${koGame.id}/replay`)).status, 200);
  });

  it("finishes without a knockout when fewer than 4 teams qualify", async () => {
    const h = await createHarness({ event: { code_freeze_at: FREEZE } });
    const runner = h.runner();
    for (const name of ["x", "y", "z"]) await h.readySubmission(h.team({ name: `Đội ${name}` }), runner);
    const admin = adminMod.createAdminApi({ db: h.db, now: () => h.env.clock, config: { eventId: "ev", authMode: "password", allowedOrigins: [ADMIN_ORIGIN] } });
    h.db.sqlite.prepare("INSERT INTO admins (email, role, added_by, created_at) VALUES ('a@btc.test', 'admin', 'test', 0)").run();
    h.db.sqlite.prepare("INSERT INTO admin_sessions (id_hash, email, created_at, expires_at) VALUES (?, 'a@btc.test', 0, ?)").run(crypto.createHash("sha256").update("s").digest("hex"), START * 10);
    const step = async (name) => {
      const response = await admin.fetch(new Request(`${ADMIN_ORIGIN}/admin-api/tournament/${name}`, { method: "POST", headers: { cookie: "__Host-ottcup_admin=s", origin: ADMIN_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ reason: "demo nhỏ" }) }));
      return { status: response.status, headers: response.headers, body: await response.json() };
    };
    const drainAll = async () => {
      for (;;) {
        const jobs = (await h.call("POST", "/runner/claim", { token: runner, json: { slots: 8 } })).body.jobs;
        if (!jobs.length) return;
        for (const job of jobs) {
          // House bots lose every gate game; teams play out their games.
          const houseSeat = job.match.seats.A.house ? "A" : job.match.seats.B.house ? "B" : null;
          const replay = await playCompactGame({ mapId: job.match.mapId, faultA: houseSeat === "A" ? () => true : null, faultB: houseSeat === "B" ? () => true : null });
          await h.call("POST", "/runner/complete", { token: runner, json: { jobId: job.jobId, attempt: job.attempt, replay, stderr: {} } });
        }
      }
    };
    h.env.clock = FREEZE;
    for (const name of ["freeze", "gate-start"]) assert.equal((await step(name)).status, 200, name);
    await drainAll();
    assert.equal((await step("gate-close")).body.qualified, 3);
    assert.equal((await step("qualifying-start")).status, 200);
    await drainAll();
    assert.equal((await step("qualifying-close")).status, 200);
    assert.equal((await step("knockout-start")).body.error, "knockout_not_possible");
    const done = await step("finish");
    assert.equal(done.body.finished, true);
    const final = await h.call("GET", "/api/t/results/final");
    assert.equal(final.body.ranking.length, 3);
  });

  it("runs a Swiss qualifying for 11 teams: one bye a round, no rematches, a disqualified team leaves later rounds", async () => {
    const h = await createHarness({ event: { code_freeze_at: FREEZE } });
    const sqlite = h.db.sqlite;
    const runner = h.runner();
    const strength = new Map();
    const teams = [];
    for (let i = 0; i < 11; i++) {
      const team = h.team({ name: `Đội swiss ${String.fromCharCode(97 + i)}` });
      const submission = await h.readySubmission(team, runner);
      strength.set(submission.sha256, 11 - i);
      teams.push(team);
    }
    const admin = adminMod.createAdminApi({ db: h.db, now: () => h.env.clock, config: { eventId: "ev", authMode: "password", allowedOrigins: [ADMIN_ORIGIN] } });
    sqlite.prepare("INSERT INTO admins (email, role, added_by, created_at) VALUES ('a@btc.test', 'admin', 'test', 0)").run();
    sqlite.prepare("INSERT INTO admin_sessions (id_hash, email, created_at, expires_at) VALUES (?, 'a@btc.test', 0, ?)").run(crypto.createHash("sha256").update("s").digest("hex"), START * 10);
    const step = async (name) => {
      const response = await admin.fetch(new Request(`${ADMIN_ORIGIN}/admin-api/tournament/${name}`, { method: "POST", headers: { cookie: "__Host-ottcup_admin=s", origin: ADMIN_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ reason: "Swiss" }) }));
      return { status: response.status, body: await response.json() };
    };
    const drainAll = async () => {
      for (;;) {
        const jobs = (await h.call("POST", "/runner/claim", { token: runner, json: { slots: 8 } })).body.jobs;
        if (!jobs.length) return;
        for (const job of jobs) {
          // House bots lose every gate game; between teams the stronger one wins.
          const power = (seat) => (job.match.seats[seat].house ? 0 : strength.get(job.match.seats[seat].submission.sha256));
          const loser = power("A") > power("B") ? "B" : "A";
          const replay = await playCompactGame({ mapId: job.match.mapId, faultA: loser === "A" ? () => true : null, faultB: loser === "B" ? () => true : null });
          const done = await h.call("POST", "/runner/complete", { token: runner, json: { jobId: job.jobId, attempt: job.attempt, replay, stderr: {} } });
          assert.equal(done.status, 200, JSON.stringify(done.body));
        }
      }
    };
    h.env.clock = FREEZE;
    for (const name of ["freeze", "gate-start"]) assert.equal((await step(name)).status, 200, name);
    await drainAll();
    assert.equal((await step("gate-close")).body.format, "swiss");
    const started = await step("qualifying-start");
    assert.deepEqual([started.body.format, started.body.round, started.body.rounds], ["swiss", 1, 7]);
    assert.equal((await step("swiss-next")).body.error, "games_pending");

    for (let round = 1; round <= 7; round++) {
      await drainAll();
      if (round === 3) {
        // An approved disqualification between rounds: the team plays no later round, its past games still count.
        sqlite.prepare("UPDATE teams SET disqualified_at = ?, dq_reason = 'test' WHERE id = ?").run(h.env.clock, teams[10].id);
      }
      if (round < 7) assert.equal((await step("swiss-next")).body.round, round + 1);
    }
    assert.equal((await step("swiss-next")).body.error, "swiss_complete");

    const pairings = sqlite.prepare("SELECT round, team_a, team_b, bye_team FROM pairings WHERE stage = 'swiss' ORDER BY round").all();
    const seen = new Set();
    const byes = [];
    for (let round = 1; round <= 7; round++) {
      const rows = pairings.filter((row) => row.round === round);
      const teamsInRound = rows.flatMap((row) => (row.bye_team ? [row.bye_team] : [row.team_a, row.team_b]));
      const expected = round <= 3 ? 11 : 10;
      assert.equal(new Set(teamsInRound).size, expected, `round ${round}: every active team exactly once`);
      assert.equal(teamsInRound.length, expected);
      if (round > 3) assert.ok(!teamsInRound.includes(teams[10].id), "the disqualified team is not paired");
      byes.push(...rows.filter((row) => row.bye_team).map((row) => row.bye_team));
      for (const row of rows.filter((item) => !item.bye_team)) {
        const key = [row.team_a, row.team_b].sort().join("|");
        assert.ok(!seen.has(key), `round ${round}: no rematch`);
        seen.add(key);
      }
    }
    assert.equal(byes.length, 3, "a bye in each of the three 11-team rounds");
    assert.equal(new Set(byes).size, byes.length, "no team gets two byes");
    const maps = sqlite.prepare("SELECT round, GROUP_CONCAT(DISTINCT map_id) AS maps FROM matches WHERE stage = 'swiss' GROUP BY round ORDER BY round").all();
    assert.ok(maps.every((row) => !row.maps.includes(",")), "one map per Swiss round");

    const closed = await step("qualifying-close");
    assert.deepEqual([closed.status, closed.body.format, closed.body.teams], [200, "swiss", 10]);
    const qualifying = await h.call("GET", "/api/t/results/qualifying");
    assert.equal(qualifying.body.standings[0].team, "Đội swiss a", "the strongest team tops the table");
    assert.ok(!qualifying.body.standings.some((row) => row.team === "Đội swiss k"), "the disqualified team is not ranked");
    assert.equal(qualifying.body.pairings.filter((pairing) => pairing.bye).length, 3);
  });
});
