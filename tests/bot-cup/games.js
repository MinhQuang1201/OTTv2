"use strict";

/**
 * Real Bot Cup games for tests: the Arena controller under bot-cup-policy-v1 with in-process bots on a fake clock, turned
 * into the compact replay a runner sends. `pickA`/`pickB` choose from the legal moves; `faultA`/`faultB` return true on the
 * turns where that seat should play an illegal move instead.
 */
async function playCompactGame({ mapId = "classic", pickA = (m) => m[0], pickB = (m) => m[0], thinkA = 5, thinkB = 5, faultA = null, faultB = null } = {}) {
  const [core, controllerMod, functionBot, engine, identity, ruleset, maps] = await Promise.all([
    import("../../packages/bot-cup-core/src/index.mjs"),
    import("../../packages/arena/src/application/match-controller.mjs"),
    import("../../packages/arena/src/adapters/function-bot.mjs"),
    import("../../packages/arena-node/src/core/node-engine.mjs"),
    import("../../packages/arena-node/src/core/ruleset-identity.mjs"),
    import("../../packages/arena/src/domain/ruleset.mjs"),
    import("../../packages/arena/src/domain/maps/index.mjs")
  ]);
  let now = 0;
  const clock = { nowMs: () => now, schedule: () => 0, cancel() {} };
  const moves = [];
  const bot = (id, pick, think, fault) => functionBot.createFunctionBot({
    botId: id,
    chooseFn(turn) {
      now += think;
      if (fault && fault(turn)) return { from: { x: 0, y: 0 }, to: { x: 4, y: 4 } };
      return pick(turn.legalMoves);
    }
  });
  const snapshot = ruleset.createCurrentRulesetSnapshot(engine.coreConfig);
  const result = await controllerMod.createHeadlessMatchController({
    matchId: "test-game",
    engine: engine.createNodeEngine(),
    botA: bot("a", pickA, thinkA, faultA),
    botB: bot("b", pickB, thinkB, faultB),
    clock,
    journal: { init() {}, acceptedMove() {}, technicalEvent() {}, finish() {} },
    policy: core.BOT_CUP_POLICY,
    rulesetSnapshot: snapshot,
    rulesetHash: identity.computeRulesetHash(snapshot),
    engineRevision: "test",
    initialState: maps.createMapState(mapId),
    onAcceptedMove: (event) => moves.push({ seat: event.seat, from: event.move.from, to: event.move.to, elapsedMs: event.frame.elapsedMs })
  }).run();
  return core.compactReplay({ mapId, moves, result });
}

module.exports = { playCompactGame };
