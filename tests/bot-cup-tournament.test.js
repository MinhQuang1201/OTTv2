"use strict";

/**
 * Pure tournament rules (packages/bot-cup-core/src/tournament.mjs), the P7 test list of
 * docs/superpowers/plans/2026-10-23-uet-k71-bot-cup.md §12: format by N, round robin, tie-breaks, knockout brackets
 * (Top 4 and Top 16), interview replacement, Swiss rounds, maps, byes, eliminated teams, determinism.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

let t;
before(async () => {
  t = await import("../packages/bot-cup-core/src/index.mjs");
});

const teams = (ids) => ids.map((teamId, index) => ({ teamId, sealedAt: 1000 + index }));


describe("bot-cup tournament: sealing and gate", () => {
  it("seals the chosen version if it is ready, else the newest ready one; nothing still being checked", () => {
    const list = [{ id: "v1", seq: 1, status: "ready" }, { id: "v2", seq: 2, status: "ready" }, { id: "v3", seq: 3, status: "checking" }];
    assert.equal(t.sealedSubmission(list, null).id, "v2");
    assert.equal(t.sealedSubmission(list, "v1").id, "v1");
    assert.equal(t.sealedSubmission(list, "v3").id, "v2");
    assert.equal(t.sealedSubmission([{ id: "v1", seq: 1, status: "smoke_failed" }], null), null);
  });

  it("plays 6 gate games (3 maps x 2 colours) against easy and needs 4 points", () => {
    const games = t.gateGames("s1");
    assert.equal(games.length, 6);
    assert.deepEqual(games.map((g) => [g.mapId, g.a.submissionId ? "team" : g.a.house]), [
      ["classic", "team"], ["classic", "easy"], ["flanks", "team"], ["flanks", "easy"], ["center", "team"], ["center", "easy"]
    ]);
    const finished = (points) => points.map((p) => ({ status: "finished", points: p }));
    assert.deepEqual(t.gateVerdict(finished([1, 1, 1, 1, 0, 0])), { status: "qualified", points: 4 });
    assert.deepEqual(t.gateVerdict(finished([1, 1, 1, 0.5, 0, 0])), { status: "not_qualified", points: 3.5 });
    assert.equal(t.gateVerdict([...finished([1, 1, 1, 1, 1]), { status: "running", points: 0 }]), null);
  });
});

describe("bot-cup tournament: qualifying format and round robin", () => {
  it("chooses round robin up to 10 teams and Swiss above", () => {
    assert.equal(t.chooseFormat(1), "none");
    assert.equal(t.chooseFormat(2), "round_robin");
    assert.equal(t.chooseFormat(10), "round_robin");
    assert.equal(t.chooseFormat(11), "swiss");
  });

  it("pairs 8 teams in 28 pairings over 7 rounds, each pair once, each team once per round", () => {
    const ids = ["h", "g", "f", "e", "d", "c", "b", "a"];
    const pairings = t.roundRobinPairings(ids);
    assert.equal(pairings.length, 28);
    assert.equal(new Set(pairings.map((p) => [p.a, p.b].sort().join("-"))).size, 28);
    for (let round = 1; round <= 7; round++) {
      const playing = pairings.filter((p) => p.round === round).flatMap((p) => [p.a, p.b]);
      assert.equal(new Set(playing).size, 8, `round ${round}`);
    }
    assert.deepEqual(t.roundRobinPairings(ids), pairings, "deterministic");
    const odd = t.roundRobinPairings(["a", "b", "c", "d", "e"]);
    assert.equal(odd.length, 10);
    assert.ok(odd.every((p) => p.a && p.b), "the resting team simply has no pairing");
  });

  it("gives each pairing 6 games, every map in both colours", () => {
    assert.deepEqual(t.pairingGames("round_robin").map((g) => `${g.mapId}:${g.red}`), ["classic:a", "classic:b", "flanks:a", "flanks:b", "center:a", "center:b"]);
    assert.deepEqual(t.pairingGames("swiss", 5).map((g) => `${g.mapId}:${g.red}`), ["flanks:a", "flanks:b"]);
  });

  it("scores a pairing from the games' colours", () => {
    const games = [
      { status: "finished", outcome: "win", winner: "A", red: "a" },
      { status: "finished", outcome: "win", winner: "A", red: "b" },
      { status: "finished", outcome: "draw", winner: null, red: "a" },
      { status: "finished", outcome: "forfeit", winner: "B", red: "b" }
    ];
    assert.deepEqual(t.pairingScore(games), { a: 2.5, b: 1.5, winsA: 2, winsB: 1, played: 4, complete: true });
    assert.equal(t.pairingScore([...games, { status: "queued" }]).complete, false);
  });

  it("breaks round robin ties by head-to-head, then Sonneborn-Berger, wins and the earlier submission", () => {
    // a and b both have 5 points; a beat b 4-2, so a is ahead although b sealed earlier. c leads on 8.
    const pairings = [
      { a: "a", b: "b", pointsA: 4, pointsB: 2, winsA: 4, winsB: 2, games: 6 },
      { a: "a", b: "c", pointsA: 1, pointsB: 5, winsA: 1, winsB: 5, games: 6 },
      { a: "b", b: "c", pointsA: 3, pointsB: 3, winsA: 3, winsB: 3, games: 6 }
    ];
    const table = t.roundRobinStandings([{ teamId: "b", sealedAt: 1 }, { teamId: "a", sealedAt: 2 }, { teamId: "c", sealedAt: 3 }], pairings);
    assert.deepEqual(table.map((row) => [row.rank, row.teamId, row.points, row.h2h]), [[1, "c", 8, 0], [2, "a", 5, 4], [3, "b", 5, 2]]);
    assert.deepEqual(t.roundRobinStandings(teams(["a", "b", "c"]), pairings), t.roundRobinStandings(teams(["a", "b", "c"]), pairings), "deterministic");

    // Fully level teams fall back to the earlier sealed submission.
    const level = t.roundRobinStandings([{ teamId: "x", sealedAt: 50 }, { teamId: "y", sealedAt: 10 }], [{ a: "x", b: "y", pointsA: 3, pointsB: 3, winsA: 3, winsB: 3, games: 6 }]);
    assert.deepEqual(level.map((row) => row.teamId), ["y", "x"]);
  });
});

describe("bot-cup tournament: knockout", () => {
  it("has no knockout under 4 teams, and builds the Top 4 and Top 16 brackets by seed", () => {
    assert.deepEqual(t.knockoutFirstRound(["a", "b", "c"], 4), []);
    const four = t.knockoutFirstRound(["s1", "s2", "s3", "s4", "s5"], 4);
    assert.deepEqual(four.map((p) => [p.slot, p.high, p.low]), [["SF1", "s1", "s4"], ["SF2", "s2", "s3"]]);
    const seeds = Array.from({ length: 20 }, (_, index) => `s${index + 1}`);
    const sixteen = t.knockoutFirstRound(seeds, 16);
    assert.deepEqual(sixteen.map((p) => `${p.highSeed}-${p.lowSeed}`), ["1-16", "8-9", "5-12", "4-13", "3-14", "6-11", "7-10", "2-15"]);
  });

  it("goes to tie-break games when level, at most twice, then the higher seed", () => {
    assert.deepEqual(t.knockoutDecision({ highPoints: 2.5, lowPoints: 3.5, tiebreaksPlayed: 0 }), { decided: true, winner: "low", bySeed: false });
    assert.deepEqual(t.knockoutDecision({ highPoints: 3, lowPoints: 3, tiebreaksPlayed: 0 }), { decided: false });
    assert.deepEqual(t.knockoutDecision({ highPoints: 4, lowPoints: 4, tiebreaksPlayed: 1 }), { decided: false });
    assert.deepEqual(t.knockoutDecision({ highPoints: 5, lowPoints: 5, tiebreaksPlayed: 2 }), { decided: true, winner: "high", bySeed: true });
    assert.equal(t.drawTiebreakMap(() => 0), "classic");
    assert.equal(t.drawTiebreakMap(() => 0.99), "center");
  });

  it("feeds semi-finals into a final and a third-place match, and quarter-finals into semi-finals", () => {
    const entry = (team, seed) => ({ team, seed });
    const semis = [
      { slot: "SF1", winnerEntry: entry("s4", 4), loserEntry: entry("s1", 1) },
      { slot: "SF2", winnerEntry: entry("s2", 2), loserEntry: entry("s3", 3) }
    ];
    assert.deepEqual(t.nextKnockoutPairings(semis).map((p) => [p.slot, p.high, p.low]), [["F", "s2", "s4"], ["3RD", "s1", "s3"]]);
    const quarters = [1, 2, 3, 4].map((n) => ({ slot: `QF${n}`, winnerEntry: entry(`w${n}`, n) }));
    assert.deepEqual(t.nextKnockoutPairings(quarters).map((p) => [p.slot, p.high, p.low]), [["SF1", "w1", "w2"], ["SF2", "w3", "w4"]]);
    assert.deepEqual(t.nextKnockoutPairings([{ slot: "F" }, { slot: "3RD" }]), []);
  });

  it("replaces a Top 4 team that fails its interview with the next team in the ranking", () => {
    const ranking = ["t1", "t2", "t3", "t4", "t5", "t6"];
    assert.deepEqual(t.topFourAfterInterviews(ranking, {}), { ready: false, seeded: [], waitingFor: ["t1", "t2", "t3", "t4"] });
    const failed = t.topFourAfterInterviews(ranking, { t1: "pass", t2: "fail", t3: "pass", t4: "pass" });
    assert.deepEqual(failed, { ready: false, seeded: ["t1", "t3", "t4"], waitingFor: ["t5"] });
    assert.deepEqual(t.topFourAfterInterviews(ranking, { t1: "pass", t2: "fail", t3: "pass", t4: "pass", t5: "pass" }), { ready: true, seeded: ["t1", "t3", "t4", "t5"], waitingFor: [] });
  });
});

describe("bot-cup tournament: Swiss (pure, Thực tế)", () => {
  it("plays clamp(ceil(log2 N), 7, 10) rounds with the map rotating by round", () => {
    assert.equal(t.swissRoundCount(11), 7);
    assert.equal(t.swissRoundCount(300), 9);
    assert.equal(t.swissRoundCount(700), 10);
    assert.equal(t.swissRoundCount(5000), 10);
    assert.deepEqual([1, 2, 3, 4].map(t.swissMap), ["classic", "flanks", "center", "classic"]);
  });

  /** Plays a whole Swiss with a fixed strength order: the stronger team takes 1.5 of 2. */
  function runSwiss(ids, { eliminateAfter = {} } = {}) {
    const roundCount = t.swissRoundCount(ids.length);
    const strength = new Map(ids.map((id, index) => [id, ids.length - index]));
    const history = [];
    const played = [];
    let active = [...ids];
    const byes = [];
    for (let round = 1; round <= roundCount; round++) {
      active = active.filter((id) => !(eliminateAfter[id] && round > eliminateAfter[id]));
      const standings = t.swissStandings(teams(ids), played);
      const { pairings, bye } = t.pairSwiss({ active, round, roundCount, standings, history });
      if (bye) {
        byes.push(bye);
        played.push({ bye, round });
      }
      for (const pairing of pairings) {
        const aStronger = strength.get(pairing.a) > strength.get(pairing.b);
        history.push({ round, a: pairing.a, b: pairing.b });
        played.push({ round, a: pairing.a, b: pairing.b, pointsA: aStronger ? 1.5 : 0.5, pointsB: aStronger ? 0.5 : 1.5, winsA: aStronger ? 1 : 0, winsB: aStronger ? 0 : 1, games: 2 });
      }
    }
    return { history, played, byes, roundCount, standings: t.swissStandings(teams(ids), played) };
  }

  it("pairs 33 teams over 7 rounds without rematches, a bye worth 2 points at most once per team", () => {
    const ids = Array.from({ length: 33 }, (_, index) => `team-${String(index + 1).padStart(2, "0")}`);
    const swiss = runSwiss(ids);
    assert.equal(swiss.roundCount, 7);
    const keys = swiss.history.map((pairing) => [pairing.a, pairing.b].sort().join("|"));
    assert.equal(new Set(keys).size, keys.length, "no rematches");
    assert.equal(swiss.byes.length, 7);
    assert.equal(new Set(swiss.byes).size, 7, "nobody gets two byes");
    const withBye = swiss.standings.find((row) => row.teamId === swiss.byes[0]);
    assert.equal(withBye.byes, 1);
    assert.equal(swiss.standings[0].teamId, "team-01", "the strongest team wins");
    assert.deepEqual(runSwiss(ids).standings.map((row) => row.teamId), swiss.standings.map((row) => row.teamId), "deterministic");
  });

  it("drops an eliminated team from later rounds and keeps its past games for its opponents", () => {
    const ids = Array.from({ length: 12 }, (_, index) => `t${String(index + 1).padStart(2, "0")}`);
    const swiss = runSwiss(ids, { eliminateAfter: { t05: 2 } });
    assert.ok(swiss.history.filter((pairing) => pairing.round > 2).every((pairing) => pairing.a !== "t05" && pairing.b !== "t05"));
    assert.equal(swiss.history.filter((pairing) => pairing.round <= 2 && (pairing.a === "t05" || pairing.b === "t05")).length, 2);
    const opponent = swiss.history.find((pairing) => pairing.round === 1 && (pairing.a === "t05" || pairing.b === "t05"));
    const opponentId = opponent.a === "t05" ? opponent.b : opponent.a;
    assert.ok(swiss.standings.find((row) => row.teamId === opponentId).games >= 2);
  });

  it("orders a Swiss table by points, then Buchholz cut 1", () => {
    const table = t.swissStandings(teams(["a", "b", "c", "d"]), [
      { a: "a", b: "b", pointsA: 2, pointsB: 0, winsA: 2, winsB: 0, games: 2 },
      { a: "c", b: "d", pointsA: 2, pointsB: 0, winsA: 2, winsB: 0, games: 2 },
      { a: "a", b: "c", pointsA: 1, pointsB: 1, winsA: 1, winsB: 1, games: 2 },
      { a: "b", b: "d", pointsA: 2, pointsB: 0, winsA: 2, winsB: 0, games: 2 }
    ]);
    assert.deepEqual(table.map((row) => [row.teamId, row.points]), [["a", 3], ["c", 3], ["b", 2], ["d", 0]]);
  });
});

describe("bot-cup tournament: appeals", () => {
  it("accepts appeals within 12 h (Demo) or 24 h (Thực tế) of publication, at most 3 per stage", () => {
    const hour = 3600 * 1000;
    assert.equal(t.appealAllowed({ mode: "demo", resultsPublishedAt: 0, now: 11 * hour, appealsInStage: 0 }), null);
    assert.equal(t.appealAllowed({ mode: "demo", resultsPublishedAt: 0, now: 12 * hour, appealsInStage: 0 }), "appeal_window_closed");
    assert.equal(t.appealAllowed({ mode: "production", resultsPublishedAt: 0, now: 23 * hour, appealsInStage: 2 }), null);
    assert.equal(t.appealAllowed({ mode: "production", resultsPublishedAt: 0, now: hour, appealsInStage: 3 }), "appeal_limit");
    assert.equal(t.appealAllowed({ mode: "demo", resultsPublishedAt: null, now: hour, appealsInStage: 0 }), "appeal_window_closed");
  });
});
