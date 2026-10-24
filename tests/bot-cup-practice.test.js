"use strict";

/**
 * Bot Cup practice, games, replays and the public leaderboard (apps/bot-cup-api, P5).
 * Plan: docs/superpowers/plans/2026-10-23-uet-k71-bot-cup.md §7.1, §8.8, §11.2, §12 P5.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, START, DAY } = require("./bot-cup/harness");

describe("bot-cup practice", () => {
  it("plays two games against the chosen house bot with the team's ready submission", async () => {
    const h = await createHarness();
    const token = h.runner();
    const team = h.team({ name: "Đội Alpha" });
    const submission = await h.readySubmission(team, token);

    const created = await h.call("POST", "/api/t/practice", { cookie: team.cookie, json: { opponent: "hard", mapId: "flanks" } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.body.matches.map((m) => [m.stage, m.mapId, m.mySeat, m.seats.A.name, m.seats.B.name, m.status]), [
      ["practice", "flanks", "A", "Đội Alpha", "AI Khó", "queued"],
      ["practice", "flanks", "B", "AI Khó", "Đội Alpha", "queued"]
    ]);
    const jobs = (await h.call("POST", "/runner/claim", { token: h.runner(), json: { slots: 4 } })).body.jobs;
    assert.deepEqual(jobs.map((job) => [job.match.seats.A, job.match.seats.B]).flat().filter((seat) => seat.house), [{ house: "hard" }, { house: "hard" }]);
    assert.ok(jobs.every((job) => JSON.stringify(job).includes(submission.sha256)));
  });

  it("allows 20 practice games a day, refuses unknown opponents and bots that are not ready", async () => {
    const h = await createHarness();
    const token = h.runner();
    const team = h.team();
    const notReady = await h.call("POST", "/api/t/practice", { cookie: team.cookie, json: { opponent: "easy" } });
    assert.deepEqual([notReady.status, notReady.body.error], [409, "practice_no_submission"]);
    await h.upload(team);
    assert.equal((await h.call("POST", "/api/t/practice", { cookie: team.cookie, json: { opponent: "easy" } })).body.error, "practice_not_ready");
    await h.drain(token);

    assert.deepEqual((await h.call("POST", "/api/t/practice", { cookie: team.cookie, json: { opponent: "god" } })).body, { error: "practice_opponent_invalid", field: "opponent" });
    assert.equal((await h.call("POST", "/api/t/practice", { cookie: team.cookie, json: { opponent: "easy", mapId: "moon" } })).body.error, "practice_map_invalid");
    for (let i = 0; i < 10; i++) assert.equal((await h.call("POST", "/api/t/practice", { cookie: team.cookie, json: { opponent: "easy" } })).status, 201);
    const over = await h.call("POST", "/api/t/practice", { cookie: team.cookie, json: { opponent: "easy" } });
    assert.deepEqual([over.status, over.body.error], [429, "practice_daily_limit"]);
    assert.equal(h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM matches WHERE stage = 'practice'").get().n, 20);
    const mine = await h.call("GET", "/api/t/matches", { cookie: team.cookie });
    assert.equal(mine.body.practice.usedToday, 20);
    h.env.clock = Date.UTC(2026, 10, 30, 17, 0);
    assert.equal((await h.call("POST", "/api/t/practice", { cookie: team.cookie, json: { opponent: "medium" } })).status, 201);
  });

  it("closes practice at code freeze", async () => {
    const h = await createHarness();
    const token = h.runner();
    const team = h.team();
    await h.readySubmission(team, token);
    h.env.clock = START + 10 * DAY;
    assert.equal((await h.call("POST", "/api/t/practice", { cookie: team.cookie, json: { opponent: "easy" } })).body.error, "code_frozen");
  });
});

describe("bot-cup games and replays", () => {
  it("shows a team its games, its own stderr, and a replay the web viewer accepts; others get 404", async () => {
    const h = await createHarness();
    const token = h.runner();
    const team = h.team({ name: "Đội Alpha" });
    const other = h.team({ name: "Đội Beta" });
    await h.readySubmission(team, token);
    h.env.clock += 60_000;
    await h.call("POST", "/api/t/practice", { cookie: team.cookie, json: { opponent: "medium", mapId: "center" } });
    await h.drain(token);

    const list = await h.call("GET", "/api/t/matches", { cookie: team.cookie });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.matches.map((m) => [m.stage, m.status]), [["practice", "finished"], ["practice", "finished"], ["smoke", "finished"], ["smoke", "finished"]]);
    assert.deepEqual(list.body.practice.opponents.map((o) => o.id), ["easy", "medium", "hard", "sentinel", "strategist"]);
    const practice = list.body.matches[1];

    const detail = await h.call("GET", `/api/t/matches/${practice.id}`, { cookie: team.cookie });
    assert.deepEqual(detail.body.match.stderr, { [practice.mySeat]: `log ${practice.mySeat}\n` }, "only the team's own bot's stderr");

    const replay = await h.call("GET", `/api/t/matches/${practice.id}/replay`, { cookie: team.cookie });
    assert.equal(replay.status, 200);
    const { validateReplayDocument } = await import("../packages/arena/src/contracts/index.mjs");
    assert.equal(validateReplayDocument(replay.body.replay).ok, true);
    assert.equal(replay.body.replay.participants[practice.mySeat].name, "Đội Alpha (v1)");
    assert.match(replay.body.sha256, /^[0-9a-f]{64}$/);

    for (const path of [`/api/t/matches/${practice.id}`, `/api/t/matches/${practice.id}/replay`]) {
      assert.equal((await h.call("GET", path, { cookie: other.cookie })).status, 404, `${path} for another team`);
      assert.equal((await h.call("GET", path)).status, 404, `${path} for a guest`);
    }
  });

  it("makes official stages public", async () => {
    const h = await createHarness();
    const token = h.runner();
    const team = h.team({ name: "Đội Alpha" });
    const submission = await h.readySubmission(team, token);
    const { enqueueMatch } = await import("../apps/bot-cup-api/src/queue.mjs");
    const { createStore } = await import("../apps/bot-cup-api/src/store.mjs");
    const game = enqueueMatch(createStore(h.db), { eventId: "ev", stage: "gate", mapId: "classic", a: { submissionId: submission.id }, b: { house: "easy" }, now: h.env.clock });
    await h.db.batch(game.statements);
    await h.drain(token);
    const publicView = await h.call("GET", `/api/t/matches/${game.matchId}`);
    assert.equal(publicView.status, 200);
    assert.deepEqual(publicView.body.match.stderr, {}, "a guest sees no stderr");
    assert.equal((await h.call("GET", `/api/t/matches/${game.matchId}/replay`)).status, 200);
  });
});

describe("bot-cup practice leaderboard", () => {
  it("ranks teams by their final submission's results against the strongest house bots", async () => {
    const h = await createHarness();
    const token = h.runner();
    const alpha = h.team({ name: "Đội Alpha" });
    const beta = h.team({ name: "Đội Beta" });
    const gamma = h.team({ name: "Đội Gamma" });
    for (const team of [alpha, beta, gamma]) await h.readySubmission(team, token);
    await h.call("POST", "/api/t/practice", { cookie: alpha.cookie, json: { opponent: "easy" } });
    await h.call("POST", "/api/t/practice", { cookie: beta.cookie, json: { opponent: "hard" } });
    // Seat A always plays the first legal move and B the last one; whoever wins, the scores below follow the games.
    await h.drain(token);

    const board = await h.call("GET", "/api/t/leaderboard");
    assert.equal(board.status, 200);
    assert.deepEqual(board.body.opponents.map((o) => o.name), ["AI Dễ", "AI Trung bình", "AI Khó", "Sentinel", "Strategist"]);
    assert.deepEqual(board.body.rows.map((row) => [row.rank, row.displayName, row.games]), [[1, "Đội Beta", 2], [2, "Đội Alpha", 2]]);
    assert.equal(board.body.rows[0].opponents.hard.played, 2);
    assert.doesNotMatch(JSON.stringify(board.body), /team-\d|2602|session/, "no ids, MSSV or secrets on the public board");

    // A new final submission starts a fresh line: old practice games no longer count for Beta.
    await h.readySubmission(beta, token);
    const after = await h.call("GET", "/api/t/leaderboard");
    assert.deepEqual(after.body.rows.map((row) => row.displayName), ["Đội Alpha"]);
  });
});
