/**
 * arena-elo.test.js
 * TDD tests for domain/elo.mjs — pure Elo math and tournament point mapping.
 * No DB, no process, no clock, no Node imports in the module under test.
 */

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

let computeEloResult;
let eloScore;
let tournamentPoints;
let expectedScore;
let kFactor;
let resultToEloScore;
let resultToTournamentPoints;
let INITIAL_RATING;
let K_PROVISIONAL;
let K_ESTABLISHED;
let K_THRESHOLD_GAMES;

before(async () => {
  const mod = await import("../packages/arena/src/domain/elo.mjs");
  computeEloResult = mod.computeEloResult;
  eloScore = mod.eloScore;
  tournamentPoints = mod.tournamentPoints;
  expectedScore = mod.expectedScore;
  kFactor = mod.kFactor;
  resultToEloScore = mod.resultToEloScore;
  resultToTournamentPoints = mod.resultToTournamentPoints;
  INITIAL_RATING = mod.INITIAL_RATING;
  K_PROVISIONAL = mod.K_PROVISIONAL;
  K_ESTABLISHED = mod.K_ESTABLISHED;
  K_THRESHOLD_GAMES = mod.K_THRESHOLD_GAMES;
});

// ---------------------------------------------------------------------------
// Constants & kFactor
// ---------------------------------------------------------------------------
describe("domain/elo constants and kFactor", () => {
  it("exports standard policy constants", () => {
    assert.equal(INITIAL_RATING, 1200);
    assert.equal(K_PROVISIONAL, 32);
    assert.equal(K_ESTABLISHED, 16);
    assert.equal(K_THRESHOLD_GAMES, 30);
  });

  it("kFactor returns 32 for games < 30 and 16 for games >= 30", () => {
    assert.equal(kFactor(0), 32);
    assert.equal(kFactor(1), 32);
    assert.equal(kFactor(29), 32);
    assert.equal(kFactor(30), 16);
    assert.equal(kFactor(31), 16);
    assert.equal(kFactor(100), 16);
  });

  it("kFactor throws on invalid game counts", () => {
    assert.throws(() => kFactor(-1), /non-negative/i);
    assert.throws(() => kFactor(29.5), /integer/i);
    assert.throws(() => kFactor("30"), /integer/i);
    assert.throws(() => kFactor(null), /integer/i);
    assert.throws(() => kFactor(NaN), /integer/i);
  });
});

// ---------------------------------------------------------------------------
// expectedScore helper
// ---------------------------------------------------------------------------
describe("expectedScore", () => {
  it("equal ratings → expected score 0.5 for both", () => {
    assert.equal(expectedScore(1200, 1200), 0.5);
    assert.equal(expectedScore(1500, 1500), 0.5);
  });

  it("higher rated has expected score > 0.5", () => {
    const e = expectedScore(1400, 1200);
    assert.ok(e > 0.5, `expected > 0.5, got ${e}`);
    assert.ok(e < 1, `expected < 1, got ${e}`);
  });

  it("lower rated has expected score < 0.5", () => {
    const e = expectedScore(1200, 1400);
    assert.ok(e < 0.5, `expected < 0.5, got ${e}`);
    assert.ok(e > 0, `expected > 0, got ${e}`);
  });

  it("symmetry: expectedScore(A,B) + expectedScore(B,A) === 1", () => {
    const pairs = [
      [1200, 1400],
      [1000, 2000],
      [1500, 1500],
      [800, 1200],
      [-100, 200],
      [2800.5, 2400.25]
    ];
    for (const [a, b] of pairs) {
      const sum = expectedScore(a, b) + expectedScore(b, a);
      assert.ok(
        Math.abs(sum - 1) < 1e-10,
        `symmetry failed for (${a},${b}): sum=${sum}`
      );
    }
  });

  it("finite ratings math proper with extreme or negative ratings", () => {
    const eHigh = expectedScore(3000, 1000);
    assert.ok(eHigh > 0.999 && eHigh < 1, `extreme high: got ${eHigh}`);
    const eLow = expectedScore(1000, 3000);
    assert.ok(eLow > 0 && eLow < 0.001, `extreme low: got ${eLow}`);

    // Negative ratings are handled mathematically without crash
    const eNeg = expectedScore(-200, 200);
    assert.ok(eNeg > 0 && eNeg < 0.5);
  });

  it("throws on non-finite ratingA", () => {
    assert.throws(() => expectedScore(Infinity, 1200), /finite/i);
    assert.throws(() => expectedScore(-Infinity, 1200), /finite/i);
    assert.throws(() => expectedScore(NaN, 1200), /finite/i);
  });

  it("throws on non-finite ratingB", () => {
    assert.throws(() => expectedScore(1200, Infinity), /finite/i);
    assert.throws(() => expectedScore(1200, -Infinity), /finite/i);
    assert.throws(() => expectedScore(1200, NaN), /finite/i);
  });

  it("throws on non-numeric ratingA", () => {
    assert.throws(() => expectedScore("1200", 1200), /numeric/i);
    assert.throws(() => expectedScore(null, 1200), /numeric/i);
  });

  it("throws on non-numeric ratingB", () => {
    assert.throws(() => expectedScore(1200, "1200"), /numeric/i);
    assert.throws(() => expectedScore(1200, undefined), /numeric/i);
  });
});

// ---------------------------------------------------------------------------
// eloScore — match outcome to Elo score (1/0.5/0, separate from tournament)
// ---------------------------------------------------------------------------
describe("eloScore", () => {
  it("win → 1", () => assert.equal(eloScore("win"), 1));
  it("draw → 0.5", () => assert.equal(eloScore("draw"), 0.5));
  it("loss → 0", () => assert.equal(eloScore("loss"), 0));

  it("rejects unknown outcome", () => {
    assert.throws(() => eloScore("forfeit"), /invalid.*score/i);
    assert.throws(() => eloScore(1), /invalid.*score/i);
    assert.throws(() => eloScore(null), /invalid.*score/i);
    assert.throws(() => eloScore(""), /invalid.*score/i);
    assert.throws(() => eloScore(undefined), /invalid.*score/i);
  });
});

// ---------------------------------------------------------------------------
// tournamentPoints — separate 3/1/0 mapper, must not reuse Elo score numbers
// ---------------------------------------------------------------------------
describe("tournamentPoints", () => {
  it("win → 3", () => assert.equal(tournamentPoints("win"), 3));
  it("draw → 1", () => assert.equal(tournamentPoints("draw"), 1));
  it("loss → 0", () => assert.equal(tournamentPoints("loss"), 0));

  it("rejects unknown outcome", () => {
    assert.throws(() => tournamentPoints("forfeit"), /invalid.*tournament/i);
    assert.throws(() => tournamentPoints(3), /invalid.*tournament/i);
    assert.throws(() => tournamentPoints(null), /invalid.*tournament/i);
    assert.throws(() => tournamentPoints(""), /invalid.*tournament/i);
    assert.throws(() => tournamentPoints(undefined), /invalid.*tournament/i);
  });

  it("tournament points 3 is distinct from Elo score of 1", () => {
    // win elo score = 1, win tournament points = 3 — different numeric values
    assert.notEqual(tournamentPoints("win"), eloScore("win"));
    assert.equal(eloScore("win"), 1);
    assert.equal(tournamentPoints("win"), 3);
  });
});

// ---------------------------------------------------------------------------
// resultToEloScore and resultToTournamentPoints with structured ArenaMatchResult
// ---------------------------------------------------------------------------
describe("resultToEloScore and resultToTournamentPoints", () => {
  const winResult = {
    outcome: "win",
    winner: "A",
    loser: "B",
    reason: "goal",
    acceptedPlies: 24
  };

  const drawResult = {
    outcome: "draw",
    winner: null,
    loser: null,
    reason: "max_plies",
    acceptedPlies: 400
  };

  const forfeitResult = {
    outcome: "forfeit",
    winner: "B",
    loser: "A",
    reason: "turn_timeout",
    acceptedPlies: 12
  };

  it("maps regular win result correctly to Elo scores (1 and 0)", () => {
    assert.equal(resultToEloScore(winResult, "A"), 1);
    assert.equal(resultToEloScore(winResult, "B"), 0);
  });

  it("maps regular win result correctly to tournament points (3 and 0)", () => {
    assert.equal(resultToTournamentPoints(winResult, "A"), 3);
    assert.equal(resultToTournamentPoints(winResult, "B"), 0);
  });

  it("maps draw result correctly to Elo scores (0.5 for both)", () => {
    assert.equal(resultToEloScore(drawResult, "A"), 0.5);
    assert.equal(resultToEloScore(drawResult, "B"), 0.5);
  });

  it("maps draw result correctly to tournament points (1 for both)", () => {
    assert.equal(resultToTournamentPoints(drawResult, "A"), 1);
    assert.equal(resultToTournamentPoints(drawResult, "B"), 1);
  });

  it("maps forfeit result like win/loss according to policy v1", () => {
    // Forfeit winner B gets win, loser A gets loss
    assert.equal(resultToEloScore(forfeitResult, "A"), 0);
    assert.equal(resultToEloScore(forfeitResult, "B"), 1);

    assert.equal(resultToTournamentPoints(forfeitResult, "A"), 0);
    assert.equal(resultToTournamentPoints(forfeitResult, "B"), 3);
  });

  it("supports all designated forfeit reasons (turn_timeout, crash, protocol_error, etc.)", () => {
    const forfeitReasons = [
      "turn_timeout",
      "total_timeout",
      "crash",
      "protocol_error",
      "illegal_move",
      "output_limit"
    ];
    for (const reason of forfeitReasons) {
      const res = { outcome: "forfeit", winner: "A", loser: "B", reason, acceptedPlies: 5 };
      assert.equal(resultToEloScore(res, "A"), 1);
      assert.equal(resultToEloScore(res, "B"), 0);
      assert.equal(resultToTournamentPoints(res, "A"), 3);
      assert.equal(resultToTournamentPoints(res, "B"), 0);
    }
  });

  it("rejects invalid structured results via existing validator", () => {
    const invalidResult = { outcome: "win", winner: "A", loser: "A", reason: "goal", acceptedPlies: 10 };
    assert.throws(() => resultToEloScore(invalidResult, "A"), /invalid.*ArenaMatchResult/i);
    assert.throws(() => resultToTournamentPoints(invalidResult, "A"), /invalid.*ArenaMatchResult/i);
  });

  it("rejects invalid seats", () => {
    assert.throws(() => resultToEloScore(winResult, "C"), /invalid seat/i);
    assert.throws(() => resultToTournamentPoints(winResult, null), /invalid seat/i);
  });
});

// ---------------------------------------------------------------------------
// computeEloResult — main Elo settlement function
// ---------------------------------------------------------------------------
describe("computeEloResult — equal ratings 1200 vs 1200, K32 (games=29)", () => {
  it("win: winner gets +16, loser gets -16; both K=32", () => {
    const res = computeEloResult({
      ratingA: 1200,
      ratingB: 1200,
      ratedGamesA: 29, // <30 → K=32
      ratedGamesB: 29, // <30 → K=32
      outcomeForA: "win"
    });

    // E_A = 0.5, S_A = 1 → delta_A = 32 * (1 - 0.5) = 16
    // E_B = 0.5, S_B = 0 → delta_B = 32 * (0 - 0.5) = -16
    assert.equal(res.A.before, 1200);
    assert.equal(res.B.before, 1200);
    assert.equal(res.A.K, 32);
    assert.equal(res.B.K, 32);
    assert.equal(res.A.score, 1);
    assert.equal(res.B.score, 0);
    assert.equal(res.A.delta, 16);
    assert.equal(res.B.delta, -16);
    assert.equal(res.A.after, 1216);
    assert.equal(res.B.after, 1184);
  });

  it("draw: both ratings unchanged at 1200", () => {
    const res = computeEloResult({
      ratingA: 1200,
      ratingB: 1200,
      ratedGamesA: 29,
      ratedGamesB: 29,
      outcomeForA: "draw"
    });
    assert.equal(res.A.delta, 0);
    assert.equal(res.B.delta, 0);
    assert.equal(res.A.after, 1200);
    assert.equal(res.B.after, 1200);
    assert.equal(res.A.score, 0.5);
    assert.equal(res.B.score, 0.5);
  });
});

describe("computeEloResult — K boundary: games29 uses K32, games30 uses K16", () => {
  it("games=29 → K=32 independently", () => {
    const res = computeEloResult({
      ratingA: 1200,
      ratingB: 1200,
      ratedGamesA: 29,
      ratedGamesB: 29,
      outcomeForA: "win"
    });
    assert.equal(res.A.K, 32);
    assert.equal(res.B.K, 32);
    assert.equal(res.A.after, 1216); // 1200 + 32*(1-0.5)
    assert.equal(res.B.after, 1184); // 1200 + 32*(0-0.5)
  });

  it("games=30 → K=16 independently", () => {
    const res = computeEloResult({
      ratingA: 1200,
      ratingB: 1200,
      ratedGamesA: 30,
      ratedGamesB: 30,
      outcomeForA: "win"
    });
    assert.equal(res.A.K, 16);
    assert.equal(res.B.K, 16);
    assert.equal(res.A.after, 1208); // 1200 + 16*(1-0.5)
    assert.equal(res.B.after, 1192); // 1200 + 16*(0-0.5)
  });

  it("games=0 → K=32 (provisional)", () => {
    const res = computeEloResult({
      ratingA: 1200,
      ratingB: 1200,
      ratedGamesA: 0,
      ratedGamesB: 0,
      outcomeForA: "draw"
    });
    assert.equal(res.A.K, 32);
    assert.equal(res.B.K, 32);
  });
});

describe("computeEloResult — asymmetric K and unequal ratings", () => {
  it("A (K32, games=0) beats B (K16, games=50): independent deltas, non-zero-sum allowed", () => {
    // ratings equal 1200 so E=0.5 for both, but K differs
    const res = computeEloResult({
      ratingA: 1200,
      ratingB: 1200,
      ratedGamesA: 0,   // K=32
      ratedGamesB: 50,  // K=16
      outcomeForA: "win"
    });
    assert.equal(res.A.K, 32);
    assert.equal(res.B.K, 16);
    // delta_A = 32 * (1 - 0.5) = 16, delta_B = 16 * (0 - 0.5) = -8
    assert.equal(res.A.delta, 16);
    assert.equal(res.B.delta, -8);
    assert.equal(res.A.after, 1216);
    assert.equal(res.B.after, 1192);
    // net sum = 16 + (-8) = 8, demonstrating non-zero-sum is allowed
    const netSum = res.A.delta + res.B.delta;
    assert.notEqual(netSum, 0, "non-zero-sum expected for asymmetric K");
  });

  it("unequal ratings: higher rated wins smaller Elo gain (floating tolerance check)", () => {
    // A at 1400, B at 1200; A wins
    const res = computeEloResult({
      ratingA: 1400,
      ratingB: 1200,
      ratedGamesA: 50, // K=16
      ratedGamesB: 50, // K=16
      outcomeForA: "win"
    });
    assert.equal(res.A.K, 16);
    assert.equal(res.B.K, 16);
    const eA = 1 / (1 + Math.pow(10, (1200 - 1400) / 400));
    const expectedDeltaA = 16 * (1 - eA);
    const expectedDeltaB = 16 * (0 - (1 - eA));

    assert.ok(
      Math.abs(res.A.delta - expectedDeltaA) < 1e-9,
      `delta_A mismatch: got ${res.A.delta}, expected ${expectedDeltaA}`
    );
    assert.ok(
      Math.abs(res.B.delta - expectedDeltaB) < 1e-9,
      `delta_B mismatch: got ${res.B.delta}, expected ${expectedDeltaB}`
    );
    // A rating higher → expected score > 0.5 → win gain < 0.5 * K
    assert.ok(res.A.delta < 16 * 0.5, "higher rated wins less than max Elo gain");
    assert.ok(res.B.delta > -16 * 0.5, "higher-rated loser loses less");
  });

  it("uses pre-settlement ratings for both expected scores (same snapshot)", () => {
    const ratingA = 1300;
    const ratingB = 1100;
    const eA_expected = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
    const eB_expected = 1 - eA_expected;

    const res = computeEloResult({
      ratingA,
      ratingB,
      ratedGamesA: 50,
      ratedGamesB: 50,
      outcomeForA: "win"
    });

    const backComputedEA = 1 - res.A.delta / res.A.K;
    assert.ok(
      Math.abs(backComputedEA - eA_expected) < 1e-9,
      `Expected score mismatch for A: got ${backComputedEA}, expected ${eA_expected}`
    );
    const backComputedEB = 0 - res.B.delta / res.B.K;
    assert.ok(
      Math.abs(backComputedEB - eB_expected) < 1e-9,
      `Expected score mismatch for B: got ${backComputedEB}, expected ${eB_expected}`
    );
  });
});

describe("computeEloResult — structured ArenaMatchResult input", () => {
  it("settles Elo correctly from structured ArenaMatchResult", () => {
    const winResult = {
      outcome: "win",
      winner: "A",
      loser: "B",
      reason: "elimination",
      acceptedPlies: 30
    };
    const res = computeEloResult({
      ratingA: 1200,
      ratingB: 1200,
      ratedGamesA: 10,
      ratedGamesB: 10,
      result: winResult
    });
    assert.equal(res.A.score, 1);
    assert.equal(res.B.score, 0);
    assert.equal(res.A.after, 1216);
    assert.equal(res.B.after, 1184);
  });

  it("validates consistency when both result and outcomeForA are provided", () => {
    const winResult = {
      outcome: "win",
      winner: "A",
      loser: "B",
      reason: "goal",
      acceptedPlies: 20
    };
    // Matching outcomeForA succeeds
    const res = computeEloResult({
      ratingA: 1200,
      ratingB: 1200,
      ratedGamesA: 10,
      ratedGamesB: 10,
      result: winResult,
      outcomeForA: "win"
    });
    assert.equal(res.A.score, 1);

    // Contradictory outcomeForA throws
    assert.throws(
      () =>
        computeEloResult({
          ratingA: 1200,
          ratingB: 1200,
          ratedGamesA: 10,
          ratedGamesB: 10,
          result: winResult,
          outcomeForA: "loss"
        }),
      /contradicts/i
    );
  });
});

describe("computeEloResult — no numeric rounding in stored values", () => {
  it("delta and after are stored as REAL (no integer rounding)", () => {
    const res = computeEloResult({
      ratingA: 1400,
      ratingB: 1200,
      ratedGamesA: 50,
      ratedGamesB: 50,
      outcomeForA: "win"
    });
    assert.ok(
      !Number.isInteger(res.A.delta),
      `A.delta should not be integer for unequal ratings: got ${res.A.delta}`
    );
    assert.ok(
      Number.isFinite(res.A.after),
      "after must be finite"
    );
  });

  it("after = before + delta exactly (float arithmetic)", () => {
    const res = computeEloResult({
      ratingA: 1400,
      ratingB: 1200,
      ratedGamesA: 50,
      ratedGamesB: 50,
      outcomeForA: "draw"
    });
    assert.equal(res.A.after, res.A.before + res.A.delta);
    assert.equal(res.B.after, res.B.before + res.B.delta);
  });
});

describe("computeEloResult — result shape", () => {
  it("returns A and B objects each with before/after/delta/K/score", () => {
    const res = computeEloResult({
      ratingA: 1200,
      ratingB: 1200,
      ratedGamesA: 10,
      ratedGamesB: 10,
      outcomeForA: "draw"
    });
    for (const side of ["A", "B"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(res, side), `missing ${side}`);
      for (const field of ["before", "after", "delta", "K", "score"]) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(res[side], field),
          `missing ${side}.${field}`
        );
        assert.ok(
          typeof res[side][field] === "number",
          `${side}.${field} must be a number, got ${typeof res[side][field]}`
        );
      }
    }
  });

  it("before values match the input ratings", () => {
    const res = computeEloResult({
      ratingA: 1350,
      ratingB: 1150,
      ratedGamesA: 10,
      ratedGamesB: 10,
      outcomeForA: "loss"
    });
    assert.equal(res.A.before, 1350);
    assert.equal(res.B.before, 1150);
  });
});

describe("computeEloResult — invalid input rejection", () => {
  const base = {
    ratingA: 1200,
    ratingB: 1200,
    ratedGamesA: 10,
    ratedGamesB: 10,
    outcomeForA: "win"
  };

  it("throws on non-finite ratingA", () => {
    assert.throws(() => computeEloResult({ ...base, ratingA: NaN }), /finite/i);
    assert.throws(() => computeEloResult({ ...base, ratingA: Infinity }), /finite/i);
  });

  it("throws on non-finite ratingB", () => {
    assert.throws(() => computeEloResult({ ...base, ratingB: NaN }), /finite/i);
    assert.throws(() => computeEloResult({ ...base, ratingB: -Infinity }), /finite/i);
  });

  it("throws on non-numeric ratingA", () => {
    assert.throws(() => computeEloResult({ ...base, ratingA: "1200" }), /numeric/i);
    assert.throws(() => computeEloResult({ ...base, ratingA: null }), /numeric/i);
  });

  it("throws on non-numeric ratingB", () => {
    assert.throws(() => computeEloResult({ ...base, ratingB: "1200" }), /numeric/i);
    assert.throws(() => computeEloResult({ ...base, ratingB: undefined }), /numeric/i);
  });

  it("throws on non-integer ratedGamesA", () => {
    assert.throws(() => computeEloResult({ ...base, ratedGamesA: 10.5 }), /integer/i);
    assert.throws(() => computeEloResult({ ...base, ratedGamesA: "10" }), /integer/i);
    assert.throws(() => computeEloResult({ ...base, ratedGamesA: NaN }), /integer/i);
  });

  it("throws on negative ratedGamesA", () => {
    assert.throws(() => computeEloResult({ ...base, ratedGamesA: -1 }), /negative|non-negative/i);
  });

  it("throws on non-integer ratedGamesB", () => {
    assert.throws(() => computeEloResult({ ...base, ratedGamesB: 5.5 }), /integer/i);
    assert.throws(() => computeEloResult({ ...base, ratedGamesB: null }), /integer/i);
  });

  it("throws on negative ratedGamesB", () => {
    assert.throws(() => computeEloResult({ ...base, ratedGamesB: -1 }), /negative|non-negative/i);
  });

  it("throws on invalid outcomeForA", () => {
    assert.throws(() => computeEloResult({ ...base, outcomeForA: "forfeit" }), /invalid.*score/i);
    assert.throws(() => computeEloResult({ ...base, outcomeForA: null }), /invalid.*score/i);
    assert.throws(() => computeEloResult({ ...base, outcomeForA: 1 }), /invalid.*score/i);
    assert.throws(() => computeEloResult({ ...base, outcomeForA: "" }), /invalid.*score/i);
  });

  it("throws when neither outcomeForA nor result is provided", () => {
    const { outcomeForA: _discard, ...noOutcome } = base;
    assert.throws(() => computeEloResult(noOutcome), /requires either 'outcomeForA' or 'result'/i);
  });

  it("throws on non-object params", () => {
    assert.throws(() => computeEloResult(null), /parameters object/i);
    assert.throws(() => computeEloResult("bad"), /parameters object/i);
  });
});

// ---------------------------------------------------------------------------
// Practice / Policy Isolation & Pure Module Invariance
// ---------------------------------------------------------------------------
describe("Pure module isolation", () => {

  it("pure numeric function does not access Date or clock or process environment", () => {
    // Calling computeEloResult is deterministic and pure
    const res1 = computeEloResult({
      ratingA: 1200,
      ratingB: 1200,
      ratedGamesA: 10,
      ratedGamesB: 10,
      outcomeForA: "win"
    });
    const res2 = computeEloResult({
      ratingA: 1200,
      ratingB: 1200,
      ratedGamesA: 10,
      ratedGamesB: 10,
      outcomeForA: "win"
    });
    assert.deepEqual(res1, res2);
  });
});
