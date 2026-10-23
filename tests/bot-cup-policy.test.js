"use strict";

/**
 * bot-cup-policy-v1 in the Arena match controller (plan §7.3, P4): the bank comes from the policy, each seat's first move
 * gets a 5 s grace that is not charged, later moves have 500 ms. Bots are in-process and "think" by advancing a fake clock,
 * so every timing is exact.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

let arena;
before(async () => {
  const [controller, functionBot, engine, identity, policy, ruleset, maps] = await Promise.all([
    import("../packages/arena/src/application/match-controller.mjs"),
    import("../packages/arena/src/adapters/function-bot.mjs"),
    import("../packages/arena-node/src/core/node-engine.mjs"),
    import("../packages/arena-node/src/core/ruleset-identity.mjs"),
    import("../packages/arena/src/domain/match-policy.mjs"),
    import("../packages/arena/src/domain/ruleset.mjs"),
    import("../packages/arena/src/domain/maps/index.mjs")
  ]);
  arena = { ...controller, ...functionBot, ...engine, ...identity, ...policy, ...ruleset, ...maps };
});

function fakeClock() {
  let now = 0;
  const timers = new Map();
  let next = 1;
  return {
    nowMs: () => now,
    advance(ms) {
      now += ms;
    },
    schedule(delay, callback) {
      const handle = next++;
      timers.set(handle, { at: now + delay, callback });
      return handle;
    },
    cancel(handle) {
      timers.delete(handle);
    }
  };
}

function journal() {
  return { init() {}, acceptedMove() {}, technicalEvent() {}, finish() {} };
}

/** Plays with bots whose think time per own move comes from `thinkA`/`thinkB` (arrays, last value repeats). */
async function play({ thinkA, thinkB, policy, maxTurns = Infinity, pick = (moves) => moves[0] }) {
  const clock = fakeClock();
  const turns = [];
  const bot = (id, think) => {
    let count = 0;
    return arena.createFunctionBot({
      botId: id,
      chooseFn(turn) {
        turns.push({ seat: turn.turn, ply: turn.ply, timeRemainingMs: turn.timeRemainingMs, turnTimeLimitMs: turn.turnTimeLimitMs });
        clock.advance(think[Math.min(count, think.length - 1)]);
        count += 1;
        if (turns.length > maxTurns) throw new Error("stop");
        return pick(turn.legalMoves);
      }
    });
  };
  const snapshot = arena.createCurrentRulesetSnapshot(arena.coreConfig);
  const controller = arena.createHeadlessMatchController({
    matchId: "policy-test",
    engine: arena.createNodeEngine(),
    botA: bot("a", thinkA),
    botB: bot("b", thinkB),
    clock,
    journal: journal(),
    policy,
    rulesetSnapshot: snapshot,
    rulesetHash: arena.computeRulesetHash(snapshot),
    engineRevision: "test",
    initialState: arena.createMapState("classic")
  });
  return { result: await controller.run(), turns };
}

describe("bot-cup-policy-v1", () => {
  it("pins its numbers and keeps arena-policy-v1 unchanged", () => {
    assert.deepEqual(arena.validateMatchPolicy(arena.BOT_CUP_MATCH_POLICY), { ok: true, errors: [] });
    assert.equal(arena.validateMatchPolicy({ ...arena.BOT_CUP_MATCH_POLICY, maxPlies: 400 }).ok, false);
    assert.equal(arena.validateMatchPolicy({ ...arena.BOT_CUP_MATCH_POLICY, firstMoveGraceMs: 60000 }).ok, false);
    assert.equal(arena.validateMatchPolicy({ ...arena.DEFAULT_MATCH_POLICY, firstMoveGraceMs: 5000 }).ok, false);
    assert.equal(arena.validateMatchPolicy(arena.DEFAULT_MATCH_POLICY).ok, true);
  });

  it("starts both banks at 30 s whatever the initial state's clock says, and announces the grace", async () => {
    // The fifth request throws inside the bot (a crash); the first four requests are what matters here.
    const { turns: seen } = await play({ thinkA: [10], thinkB: [10], policy: arena.BOT_CUP_MATCH_POLICY, maxTurns: 4 });
    assert.deepEqual(seen.slice(0, 4), [
      { seat: "A", ply: 1, timeRemainingMs: 30000, turnTimeLimitMs: 5000 },
      { seat: "B", ply: 2, timeRemainingMs: 30000, turnTimeLimitMs: 5000 },
      { seat: "A", ply: 3, timeRemainingMs: 30000, turnTimeLimitMs: 500 },
      { seat: "B", ply: 4, timeRemainingMs: 30000, turnTimeLimitMs: 500 }
    ]);
  });

  it("does not charge a slow first move to the bank, and charges later moves", async () => {
    const { turns } = await play({ thinkA: [4900, 300, 10], thinkB: [10], policy: arena.BOT_CUP_MATCH_POLICY, maxTurns: 6 });
    const a = turns.filter((turn) => turn.seat === "A");
    assert.deepEqual(a.slice(0, 3).map((turn) => turn.timeRemainingMs), [30000, 30000, 29700]);
  });

  it("forfeits a first move that reaches the 5 s grace, and a later move that reaches 500 ms", async () => {
    const slowStart = await play({ thinkA: [5000], thinkB: [10], policy: arena.BOT_CUP_MATCH_POLICY });
    assert.deepEqual(
      { outcome: slowStart.result.outcome, loser: slowStart.result.loser, reason: slowStart.result.reason, plies: slowStart.result.acceptedPlies },
      { outcome: "forfeit", loser: "A", reason: "turn_timeout", plies: 0 }
    );
    const slowLater = await play({ thinkA: [10], thinkB: [10, 500], policy: arena.BOT_CUP_MATCH_POLICY });
    assert.deepEqual(
      { loser: slowLater.result.loser, reason: slowLater.result.reason, plies: slowLater.result.acceptedPlies },
      { loser: "B", reason: "turn_timeout", plies: 3 }
    );
  });

  it("ends on the bank: 30 s spent in 450 ms moves is a total timeout", async () => {
    // Picking the last legal move keeps this game going long enough. A's grace move is free; 66 charged moves of 450 ms
    // leave 300 ms, less than one 500 ms move, so A loses on the bank on its 68th turn (after 134 plies).
    const { result } = await play({ thinkA: [450], thinkB: [1], policy: arena.BOT_CUP_MATCH_POLICY, pick: (moves) => moves.at(-1) });
    assert.deepEqual(result, { outcome: "forfeit", winner: "B", loser: "A", reason: "total_timeout", acceptedPlies: 134 });
  });

  it("keeps arena-policy-v1 timing: no grace, bank from the initial state", async () => {
    const { result, turns } = await play({ thinkA: [1000], thinkB: [10], policy: arena.DEFAULT_MATCH_POLICY });
    assert.equal(turns[0].turnTimeLimitMs, 1000);
    assert.equal(turns[0].timeRemainingMs, 600000);
    assert.equal(result.reason, "turn_timeout");
  });
});
