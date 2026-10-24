"use strict";

/** P8 pure anti-cheat logic: behaviour fingerprints (plan §8.5) and result anomalies (§8.7). */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const ai = require("../packages/game-core/src/ai.js");

let core;
before(async () => {
  core = await import("../packages/bot-cup-core/src/index.mjs");
});

const stateOf = (position) => ({ turn: position.turn, winner: null, pieces: position.pieces });

describe("bot-cup anti-cheat: behaviour fingerprints", () => {
  let positions;
  before(() => {
    positions = core.generateProbePositions({ count: 24, random: core.seededRandom(2026) });
  });

  it("generates distinct, non-trivial positions for both colours, the same for the same seed", () => {
    assert.equal(positions.length, 24);
    assert.ok(positions.every((position) => core.isNonTrivialPosition(position)));
    assert.ok(positions.every((position) => core.legalMovesOf(position).length >= core.FINGERPRINT_POLICY.minLegalMoves));
    const keys = positions.map((position) => JSON.stringify(position));
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(positions.some((position) => position.turn === "A") && positions.some((position) => position.turn === "B"));
    assert.deepEqual(core.generateProbePositions({ count: 24, random: core.seededRandom(2026) }), positions);
    assert.deepEqual(core.parseProbeSet(core.probeSetText(positions)), positions);
    assert.throws(() => core.parseProbeSet(JSON.stringify({ format: "x", positions })), /not a probe set/);
  });

  it("matches ai.js hard with itself (100%) and not with a random bot", () => {
    const hard = core.fingerprintWith(positions, (position) => ai.chooseMove(stateOf(position), position.turn, { level: "hard" }));
    const again = core.fingerprintWith(positions, (position) => ai.chooseMove(stateOf(position), position.turn, { level: "hard" }));
    const random = core.seededRandom(9);
    const noise = core.fingerprintWith(positions, (position) => {
      const moves = core.legalMovesOf(position);
      return moves[Math.floor(random() * moves.length)];
    });
    const self = core.compareFingerprints(hard, again);
    assert.deepEqual(self, { compared: 24, same: 24, ratio: 1 });
    assert.equal(core.fingerprintFlagged(self), true);
    const versusRandom = core.compareFingerprints(hard, noise);
    assert.ok(versusRandom.ratio < 0.3, `random bot ratio ${versusRandom.ratio}`);
    assert.equal(core.fingerprintFlagged(versusRandom), false);
  });

  it("only counts positions both bots answered, and needs enough of them", () => {
    assert.deepEqual(core.compareFingerprints(["1,1-1,2", null, "2,2-3,3"], ["1,1-1,2", "0,0-0,1", "2,2-3,2"]), { compared: 2, same: 1, ratio: 0.5 });
    const few = core.compareFingerprints(Array(10).fill("1,1-1,2"), Array(10).fill("1,1-1,2"));
    assert.equal(few.ratio, 1);
    assert.equal(core.fingerprintFlagged(few), false, "10 positions are not enough evidence");
    assert.equal(core.moveKey({ from: { x: 1, y: 2 }, to: { x: 2, y: 3 } }), "1,2-2,3");
    assert.equal(core.moveKey({ from: { x: 9, y: 2 }, to: { x: 2, y: 3 } }), null);
    assert.equal(core.isMoveKey("1,2-2,3"), true);
    assert.equal(core.isMoveKey("1,2-2,3; DROP"), false);
    // An illegal answer counts as no answer.
    assert.deepEqual(core.fingerprintWith(positions.slice(0, 1), () => ({ from: { x: 0, y: 0 }, to: { x: 8, y: 8 } })), [null]);
  });

  it("flags a whole set: reference look-alikes once each, pairs only when no shared reference explains them", () => {
    const keys = (seed) => Array.from({ length: 30 }, (_, index) => `${(seed + index) % 8},${(seed * 3 + index) % 8}-${((seed + index) % 8) + 1},${(seed * 3 + index) % 8}`);
    const template = keys(1);
    const prints = [
      { submissionId: null, house: "template-js", teamId: null, moves: template },
      // The two templates play alike: a team gets one flag, against the reference listed first among equals.
      { submissionId: null, house: "template-python", teamId: null, moves: template },
      { submissionId: null, house: "hard", teamId: null, moves: keys(2) },
      // Three teams that only submitted the template: one flag each, no pairs between them.
      { submissionId: "t1", house: null, teamId: "A", moves: template },
      { submissionId: "t2", house: null, teamId: "B", moves: template },
      { submissionId: "t3", house: null, teamId: "C", moves: template },
      // Two teams with the same bot of their own: a pair.
      { submissionId: "x1", house: null, teamId: "D", moves: keys(3) },
      { submissionId: "x2", house: null, teamId: "E", moves: keys(3) },
      // A second version of team D: never compared with D's other version.
      { submissionId: "x3", house: null, teamId: "D", moves: keys(3) }
    ];
    const flags = core.flagsForSet(prints).map((flag) => [flag.submissionId, flag.otherSubmissionId ?? flag.reference]);
    assert.deepEqual(flags.sort(), [
      ["t1", "house:template-js"], ["t2", "house:template-js"], ["t3", "house:template-js"], ["x1", "x2"], ["x2", "x3"]
    ].sort());
    assert.deepEqual(core.FINGERPRINT_POLICY.references, ["easy", "medium", "hard", "template-python", "template-js"]);
  });

  it("gives the same normalised hash to two files that only differ in names", () => {
    const a = "def best(moves):\n    score = 0\n    return moves[score]\n";
    const b = "def chon(nuoc_di):  # khác tên\n    diem = 0\n    return nuoc_di[diem]\n";
    assert.equal(core.normalizeSource(a, "python"), core.normalizeSource(b, "python"));
  });
});

describe("bot-cup anti-cheat: result anomalies", () => {
  const game = (id, a, b, winner, { reason = "goal", plies = 60, stage = "round_robin", outcome = "win" } = {}) => ({
    id, stage, a, b, status: "finished", outcome, winner: outcome === "draw" ? null : winner, loser: outcome === "draw" ? null : winner === "A" ? "B" : "A", reason, plies
  });

  it("reports a strong team's fault or very fast loss against one opponent, not a weak team's", () => {
    const games = [
      game("g1", "strong", "x", "A"), game("g2", "x", "strong", "B"), game("g3", "strong", "y", "A"), game("g4", "y", "strong", "B"),
      game("g5", "strong", "friend", "B", { reason: "illegal_move", plies: 3 }),
      game("g6", "strong", "friend", "B", { reason: "elimination", plies: 9 }),
      game("w1", "weak", "x", "B", { reason: "crash", plies: 2 }), game("w2", "weak", "y", "B", { reason: "crash", plies: 2 }),
      game("w3", "x", "weak", "A", { reason: "crash", plies: 1 }), game("w4", "y", "weak", "A", { reason: "crash", plies: 1 }),
      game("w5", "weak", "friend", "B", { reason: "crash", plies: 2 })
    ];
    const rows = core.findAnomalies({ games, names: new Map([["strong", "Đội Mạnh"]]) });
    const thrown = rows.filter((row) => row.kind === "thrown_game");
    assert.deepEqual(thrown.map((row) => row.matchId).sort(), ["g5", "g6"]);
    assert.equal(thrown[0].teamName, "Đội Mạnh");
    assert.equal(thrown[0].opponent, "friend");
    assert.ok(!thrown.some((row) => row.team === "weak"), "a bot that always crashes is broken, not colluding");
  });

  it("ignores games against house bots and unfinished games", () => {
    const games = [game("h", "strong", null, "B", { reason: "crash", plies: 1, stage: "gate" }), { ...game("q", "a", "b", "A"), status: "queued" }];
    assert.deepEqual(core.findAnomalies({ games }), []);
  });

  it("reports a pairing that goes far against practice form, and behaviour twins first", () => {
    const games = Array.from({ length: 6 }, (_, index) => game(`p${index}`, index % 2 ? "fav" : "dog", index % 2 ? "dog" : "fav", index % 2 ? "B" : "A"));
    const practice = new Map([["fav", { points: 18, played: 20 }], ["dog", { points: 4, played: 20 }]]);
    const twins = [{ team: "t1", other: "t2", ratio: 0.95, compared: 100 }, { team: "t3", other: "t4", ratio: 0.6, compared: 100 }];
    const rows = core.findAnomalies({ games, practice, twins });
    assert.deepEqual(rows.map((row) => row.kind), ["behaviour_twin", "practice_upset"]);
    assert.deepEqual([rows[1].team, rows[1].share, rows[1].practiceRate], ["fav", 0, 0.9]);
    // Too little practice: no claim.
    assert.equal(core.findAnomalies({ games, practice: new Map([["fav", { points: 3, played: 3 }], ["dog", { points: 0, played: 20 }]]) }).length, 0);
  });
});
