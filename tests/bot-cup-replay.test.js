"use strict";

/**
 * bot-cup-core.verifyReplay (plan §8.4, P4): real games from the Arena controller under bot-cup-policy-v1 verify, and
 * forged ones (illegal move, wrong winner, impossible clock, moves after the end, wrong map or policy) are refused.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

let core;
let arena;
before(async () => {
  core = await import("../packages/bot-cup-core/src/index.mjs");
  const [controller, functionBot, engine, identity, ruleset, maps] = await Promise.all([
    import("../packages/arena/src/application/match-controller.mjs"),
    import("../packages/arena/src/adapters/function-bot.mjs"),
    import("../packages/arena-node/src/core/node-engine.mjs"),
    import("../packages/arena-node/src/core/ruleset-identity.mjs"),
    import("../packages/arena/src/domain/ruleset.mjs"),
    import("../packages/arena/src/domain/maps/index.mjs")
  ]);
  arena = { ...controller, ...functionBot, ...engine, ...identity, ...ruleset, ...maps };
});

/** One game between in-process bots on a fake clock; returns the compact replay. */
async function game({ mapId = "classic", pickA, pickB, thinkA = 5, thinkB = 5, faultB = null }) {
  let now = 0;
  const clock = {
    nowMs: () => now,
    schedule: () => 0,
    cancel() {}
  };
  const moves = [];
  const bot = (id, pick, think, fault) => arena.createFunctionBot({
    botId: id,
    chooseFn(turn) {
      now += think;
      if (fault && fault(turn)) return { from: { x: 0, y: 0 }, to: { x: 4, y: 4 } };
      return pick(turn.legalMoves);
    }
  });
  const snapshot = arena.createCurrentRulesetSnapshot(arena.coreConfig);
  const result = await arena.createHeadlessMatchController({
    matchId: "replay-test",
    engine: arena.createNodeEngine(),
    botA: bot("a", pickA, thinkA),
    botB: bot("b", pickB, thinkB, faultB),
    clock,
    journal: { init() {}, acceptedMove() {}, technicalEvent() {}, finish() {} },
    policy: core.BOT_CUP_POLICY,
    rulesetSnapshot: snapshot,
    rulesetHash: arena.computeRulesetHash(snapshot),
    engineRevision: "test",
    initialState: arena.createMapState(mapId),
    onAcceptedMove: (event) => moves.push({ seat: event.seat, from: event.move.from, to: event.move.to, elapsedMs: event.frame.elapsedMs })
  }).run();
  return core.compactReplay({ mapId, moves, result });
}

const first = (moves) => moves[0];
const last = (moves) => moves.at(-1);
const clone = (value) => JSON.parse(JSON.stringify(value));

describe("bot-cup-core verifyReplay", () => {
  it("accepts real games: a goal, and a forfeit for an illegal move", async () => {
    const won = await game({ pickA: first, pickB: first });
    assert.equal(won.result.outcome, "win");
    const checked = core.verifyReplay(won, { mapId: "classic" });
    assert.equal(checked.ok, true, JSON.stringify(checked));
    assert.deepEqual(checked.result, won.result);

    const forfeit = await game({ mapId: "flanks", pickA: first, pickB: first, faultB: (turn) => turn.ply === 6 });
    assert.deepEqual([forfeit.result.outcome, forfeit.result.loser, forfeit.result.reason], ["forfeit", "B", "illegal_move"]);
    assert.equal(core.verifyReplay(forfeit, { mapId: "flanks" }).ok, true);
  });

  it("accepts a total timeout only when the bank really ran out", async () => {
    const replay = await game({ pickA: last, pickB: last, thinkA: 450, thinkB: 1 });
    assert.deepEqual([replay.result.reason, replay.result.loser, replay.result.acceptedPlies], ["total_timeout", "A", 134]);
    assert.equal(core.verifyReplay(replay, { mapId: "classic" }).ok, true);

    const early = clone(replay);
    early.moves = early.moves.slice(0, 40);
    early.result.acceptedPlies = 40;
    assert.equal(core.verifyReplay(early, { mapId: "classic" }).error, "replay_forfeit");
  });

  it("refuses an illegal move, a changed winner, moves after the end and an impossible clock", async () => {
    const replay = await game({ pickA: first, pickB: first });
    const expected = { mapId: "classic" };

    const illegal = clone(replay);
    illegal.moves[2].to = { x: illegal.moves[2].from.x + 2, y: illegal.moves[2].from.y };
    assert.deepEqual(core.verifyReplay(illegal, expected), { ok: false, error: "replay_illegal_move", ply: 3 });

    const otherWinner = clone(replay);
    otherWinner.result.winner = otherWinner.result.loser;
    otherWinner.result.loser = replay.result.winner;
    assert.equal(core.verifyReplay(otherWinner, expected).error, "replay_winner");

    const asDraw = clone(replay);
    asDraw.result = { outcome: "draw", winner: null, loser: null, reason: "max_plies", acceptedPlies: replay.moves.length };
    assert.equal(core.verifyReplay(asDraw, expected).error, "replay_winner");

    const extra = clone(replay);
    extra.moves.push(clone(extra.moves.at(-2)));
    extra.result.acceptedPlies += 1;
    assert.equal(core.verifyReplay(extra, expected).error, "replay_after_end");

    const slow = clone(replay);
    slow.moves[4].elapsedMs = 500;
    assert.deepEqual(core.verifyReplay(slow, expected), { ok: false, error: "replay_clock", ply: 5 });
    const graceOk = clone(replay);
    graceOk.moves[0].elapsedMs = 4999;
    assert.equal(core.verifyReplay(graceOk, expected).ok, true);

    const wrongSeat = clone(replay);
    wrongSeat.moves[1].seat = "A";
    assert.equal(core.verifyReplay(wrongSeat, expected).error, "replay_turn");
  });

  it("refuses a replay of another map, another policy or another format", async () => {
    const replay = await game({ pickA: first, pickB: first });
    assert.equal(core.verifyReplay(replay, { mapId: "center" }).error, "replay_map");
    assert.equal(core.verifyReplay({ ...replay, policy: { ...replay.policy, turnTimeLimitMs: 5000 } }, { mapId: "classic" }).error, "replay_policy");
    assert.equal(core.verifyReplay({ ...replay, format: "arena" }, { mapId: "classic" }).error, "replay_format");
    assert.equal(core.verifyReplay(null, { mapId: "classic" }).error, "replay_format");
  });

  it("expands a compact replay into an Arena replay document the web viewer accepts", async () => {
    const { validateReplayDocument } = await import("../packages/arena/src/contracts/index.mjs");
    const participants = { A: { botId: "sub-1", name: "Đội Một" }, B: { botId: "house-easy", name: "Dễ" } };
    for (const replay of [await game({ pickA: first, pickB: first }), await game({ mapId: "center", pickA: last, pickB: last, thinkA: 450, thinkB: 1 })]) {
      const document = await core.expandReplay(replay, { matchId: "m-1", participants });
      const validation = validateReplayDocument(document);
      assert.equal(validation.ok, true, JSON.stringify(validation.errors?.slice(0, 3)));
      assert.equal(document.frames.length, replay.moves.length + 1);
      assert.deepEqual(document.result, replay.result);
      assert.equal(document.matchPolicy.matchPolicyVersion, "bot-cup-policy-v1");
      assert.match(document.rulesetHash, /^sha256:[0-9a-f]{64}$/);
    }
  });

  it("scores games: win 1, draw 0.5, loss or fault 0", () => {
    assert.equal(core.gamePoints({ outcome: "win", winner: "A" }, "A"), 1);
    assert.equal(core.gamePoints({ outcome: "forfeit", winner: "B", loser: "A" }, "A"), 0);
    assert.equal(core.gamePoints({ outcome: "draw", winner: null }, "B"), 0.5);
  });
});
