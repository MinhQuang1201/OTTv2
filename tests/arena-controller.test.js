/**
 * Arena Controller Test — Task 2
 * Tests HeadlessMatchController + FunctionBot.
 * Uses dynamic import for ESM modules from CJS test context.
 * Uses REAL game-core engine (no mocks) for rules and win validation.
 */

"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const coreFixtures = require("./fixtures/arena/core-states.js");
const rules = require("../packages/game-core/src/rules.js");
const config = require("../packages/game-core/src/config.js");

let createHeadlessMatchController;
let createFunctionBot;
let createNodeEngine;
let computeCurrentEngineFingerprint;
let computeRulesetHash;
let DEFAULT_MATCH_POLICY;
let createCurrentRulesetSnapshot;

before(async () => {
  const controllerMod = await import("../packages/arena/src/application/match-controller.mjs");
  const functionBotMod = await import("../packages/arena/src/adapters/function-bot.mjs");
  const engineMod = await import("../packages/arena-node/src/core/node-engine.mjs");
  const identityMod = await import("../packages/arena-node/src/core/ruleset-identity.mjs");
  const policyMod = await import("../packages/arena/src/domain/match-policy.mjs");
  const rulesetMod = await import("../packages/arena/src/domain/ruleset.mjs");

  createHeadlessMatchController = controllerMod.createHeadlessMatchController;
  createFunctionBot = functionBotMod.createFunctionBot;
  createNodeEngine = engineMod.createNodeEngine;
  computeCurrentEngineFingerprint = identityMod.computeCurrentEngineFingerprint;
  computeRulesetHash = identityMod.computeRulesetHash;
  DEFAULT_MATCH_POLICY = policyMod.DEFAULT_MATCH_POLICY;
  createCurrentRulesetSnapshot = rulesetMod.createCurrentRulesetSnapshot;
});

// ---------------------------------------------------------------------------
// Fakes for Ports
// ---------------------------------------------------------------------------

function makeFakeClock(startMs = 0) {
  let now = startMs;
  const timers = new Map();
  let nextHandle = 1;

  return {
    nowMs() {
      return now;
    },
    advance(ms) {
      now += ms;
    },
    setNow(ms) {
      now = ms;
    },
    schedule(delayMs, callback) {
      const handle = nextHandle++;
      const fireAt = now + delayMs;
      timers.set(handle, { fireAt, callback });
      return handle;
    },
    cancel(handle) {
      timers.delete(handle);
    },
    tick() {
      for (const [handle, { fireAt, callback }] of [...timers.entries()]) {
        if (fireAt <= now) {
          timers.delete(handle);
          callback();
        }
      }
    },
    get pendingCount() {
      return timers.size;
    }
  };
}

function makeFakeJournal() {
  const initCalls = [];
  const acceptedMoveCalls = [];
  const technicalEventCalls = [];
  let finishResult = null;

  return {
    init(input) {
      initCalls.push(input);
    },
    acceptedMove(input) {
      acceptedMoveCalls.push(input);
    },
    technicalEvent(input) {
      technicalEventCalls.push(input);
    },
    finish(result, terminalState) {
      finishResult = { result, terminalState };
      return {
        schemaVersion: 1,
        matchId: "test-match",
        engineRevision: "sha256:test",
        engineGitRevision: null,
        rulesetId: "ottv2-g-default-v1",
        rulesetHash: "sha256:test",
        rulesetSnapshot: {},
        matchPolicy: DEFAULT_MATCH_POLICY,
        participants: {
          A: { botId: "bot-a" },
          B: { botId: "bot-b" }
        },
        initialCoreState: terminalState,
        frames: [{ ply: 0, coreState: terminalState, lastMove: null }],
        events: [],
        result,
        terminalCoreState: terminalState
      };
    },
    get initCalls() {
      return initCalls;
    },
    get acceptedMoveCalls() {
      return acceptedMoveCalls;
    },
    get technicalEventCalls() {
      return technicalEventCalls;
    },
    get finishResult() {
      return finishResult;
    }
  };
}

function makeControllerConfig(initialState, overrides = {}) {
  const engine = createNodeEngine();
  const snapshot = createCurrentRulesetSnapshot(config);
  const rulesetHash = computeRulesetHash(snapshot);
  const engineRevision = computeCurrentEngineFingerprint();

  return {
    matchId: overrides.matchId || "match-test-001",
    engine,
    botA: overrides.botA || null,
    botB: overrides.botB || null,
    clock: overrides.clock || makeFakeClock(),
    journal: overrides.journal || makeFakeJournal(),
    policy: overrides.policy || { ...DEFAULT_MATCH_POLICY },
    rulesetSnapshot: snapshot,
    rulesetHash,
    engineRevision,
    engineGitRevision: null,
    participants: overrides.participants || {
      A: { botId: "bot-a", isFunctionBot: true },
      B: { botId: "bot-b", isFunctionBot: true }
    },
    initialState: initialState || engine.createInitialState(),
    ...overrides
  };
}

function makeFirstMoveBot(botId = "first-bot") {
  return createFunctionBot({
    botId,
    chooseFn(turn) {
      if (!turn.legalMoves || turn.legalMoves.length === 0) {
        throw new Error("No legal moves");
      }
      return turn.legalMoves[0];
    }
  });
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe("FunctionBot adapter", () => {
  it("implements BotPort start, requestMove, stop with idempotency", async () => {
    let stoppedCount = 0;
    const bot = createFunctionBot({
      botId: "fn-bot",
      chooseFn(turn) {
        return turn.legalMoves[0];
      },
      onStop() {
        stoppedCount++;
      }
    });

    const ctx = {
      matchId: "m1",
      seat: "A",
      rulesetId: "ottv2-g-default-v1",
      rulesetHash: "sha256:x",
      initialTimeMs: 600000,
      turnTimeLimitMs: 1000
    };

    await bot.start(ctx);
    await bot.start(ctx); // idempotent

    const turn = {
      protocolVersion: 1,
      type: "turn",
      requestId: "m1:A:1",
      matchId: "m1",
      rulesetId: "ottv2-g-default-v1",
      rulesetHash: "sha256:x",
      boardWidth: 9,
      boardHeight: 9,
      ply: 1,
      turn: "A",
      timeRemainingMs: 600000,
      turnTimeLimitMs: 1000,
      board: [{ id: "A-la-0", owner: "A", type: "la", x: 4, y: 7 }],
      legalMoves: [{ from: { x: 4, y: 7 }, to: { x: 3, y: 6 } }]
    };

    const action = await bot.requestMove(turn, new AbortController().signal);
    assert.equal(action.protocolVersion, 1);
    assert.equal(action.requestId, "m1:A:1");
    assert.deepEqual(action.move, { from: { x: 4, y: 7 }, to: { x: 3, y: 6 } });

    await bot.stop();
    await bot.stop(); // idempotent
    assert.equal(stoppedCount, 1);
  });

  it("isolates inputs: bot policy mutating turn cannot affect caller", async () => {
    const bot = createFunctionBot({
      botId: "mutating-policy",
      chooseFn(turn) {
        turn.board.push({ id: "HACK", owner: "A", type: "dam", x: 0, y: 0 });
        turn.legalMoves.length = 0;
        return { from: { x: 4, y: 7 }, to: { x: 3, y: 6 } };
      }
    });

    await bot.start({
      matchId: "m1",
      seat: "A",
      rulesetId: "ottv2-g-default-v1",
      rulesetHash: "sha256:x",
      initialTimeMs: 600000,
      turnTimeLimitMs: 1000
    });

    const board = [{ id: "A-la-0", owner: "A", type: "la", x: 4, y: 7 }];
    const legalMoves = [{ from: { x: 4, y: 7 }, to: { x: 3, y: 6 } }];
    const turn = {
      protocolVersion: 1,
      type: "turn",
      requestId: "m1:A:1",
      matchId: "m1",
      rulesetId: "ottv2-g-default-v1",
      rulesetHash: "sha256:x",
      boardWidth: 9,
      boardHeight: 9,
      ply: 1,
      turn: "A",
      timeRemainingMs: 600000,
      turnTimeLimitMs: 1000,
      board,
      legalMoves
    };

    await bot.requestMove(turn, new AbortController().signal);
    assert.equal(board.length, 1);
    assert.equal(legalMoves.length, 1);
    await bot.stop();
  });

  it("propagates thrown errors to requestMove caller", async () => {
    const bot = createFunctionBot({
      botId: "crasher",
      chooseFn() {
        throw new Error("bot exploded");
      }
    });

    await bot.start({
      matchId: "m1",
      seat: "A",
      rulesetId: "ottv2-g-default-v1",
      rulesetHash: "sha256:x",
      initialTimeMs: 600000,
      turnTimeLimitMs: 1000
    });

    const turn = {
      protocolVersion: 1,
      type: "turn",
      requestId: "m1:A:1",
      matchId: "m1",
      rulesetId: "ottv2-g-default-v1",
      rulesetHash: "sha256:x",
      boardWidth: 9,
      boardHeight: 9,
      ply: 1,
      turn: "A",
      timeRemainingMs: 600000,
      turnTimeLimitMs: 1000,
      board: [],
      legalMoves: []
    };

    await assert.rejects(
      () => bot.requestMove(turn, new AbortController().signal),
      /bot exploded/
    );
    await bot.stop();
  });
});

describe("HeadlessMatchController: host input and lifecycle guards", () => {
  it("returns infrastructure_error when initialState is null or invalid", async () => {
    const cfg = makeControllerConfig(null);
    cfg.initialState = null;
    cfg.botA = makeFirstMoveBot("a");
    cfg.botB = makeFirstMoveBot("b");

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();
    assert.equal(result.kind, "infrastructure_error");
    assert.equal(result.code, "missing_initial_state");
  });

  it("returns infrastructure_error when initialState is already terminal", async () => {
    const state = rules.createInitialState();
    const terminalState = rules.cloneState(state);
    terminalState.winner = "A";
    terminalState.reason = "goal";

    const cfg = makeControllerConfig(terminalState);
    cfg.botA = makeFirstMoveBot("a");
    cfg.botB = makeFirstMoveBot("b");

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();
    assert.equal(result.kind, "infrastructure_error");
    assert.equal(result.code, "initial_state_already_terminal");
  });

  it("returns infrastructure_error when opening seat has no legal moves", async () => {
    const brokenState = {
      turn: "A",
      winner: null,
      reason: null,
      eliminatedPlayer: null,
      clock: { remainingMs: { A: 600000, B: 600000 }, runningSeat: "A" },
      pieces: [
        { id: "A-dam-0", player: "A", type: "dam", x: 0, y: 8 },
        { id: "B-dam-1", player: "B", type: "dam", x: 0, y: 7 },
        { id: "B-la-1",  player: "B", type: "la",  x: 1, y: 8 },
        { id: "B-dam-2", player: "B", type: "dam", x: 1, y: 7 }
      ]
    };

    const cfg = makeControllerConfig(brokenState);
    cfg.botA = makeFirstMoveBot("a");
    cfg.botB = makeFirstMoveBot("b");

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();
    assert.equal(result.kind, "infrastructure_error");
    assert.equal(result.code, "initial_state_no_legal_moves");
  });

  it("returns infrastructure_error on supervisor AbortSignal", async () => {
    const supervisor = new AbortController();
    const clock = makeFakeClock(0);

    const hungBot = createFunctionBot({
      botId: "hung",
      chooseFn() {
        return new Promise(() => {}); // never resolves
      }
    });

    const cfg = makeControllerConfig(null, {
      clock,
      botA: hungBot,
      botB: makeFirstMoveBot("b"),
      supervisorSignal: supervisor.signal
    });

    const controller = createHeadlessMatchController(cfg);
    const runPromise = controller.run();

    await Promise.resolve();
    supervisor.abort();

    const result = await runPromise;
    assert.equal(result.kind, "infrastructure_error");
    assert.equal(result.code, "interrupted");
  });

  it("ensures run() cannot be invoked more than once", async () => {
    const cfg = makeControllerConfig(null, {
      botA: makeFirstMoveBot("a"),
      botB: makeFirstMoveBot("b")
    });
    cfg.initialState = null;

    const controller = createHeadlessMatchController(cfg);
    await controller.run();
    await assert.rejects(() => controller.run(), /run\(\) can only be called once/);
  });
});

describe("HeadlessMatchController: clock boundaries and timeouts", () => {
  it("forfeits turn_timeout when bot never resolves (fake monotonic clock race)", async () => {
    const clock = makeFakeClock(0);
    const hungBot = createFunctionBot({
      botId: "hung-a",
      chooseFn() {
        return new Promise(() => {});
      }
    });

    const cfg = makeControllerConfig(null, {
      clock,
      botA: hungBot,
      botB: makeFirstMoveBot("b")
    });

    const controller = createHeadlessMatchController(cfg);
    const runPromise = controller.run();

    // Advance fake clock past turnTimeLimitMs (1000)
    for (let i = 0; i < 5; i++) await Promise.resolve();
    clock.advance(1001);
    clock.tick();

    const result = await runPromise;
    assert.equal(result.outcome, "forfeit");
    assert.equal(result.reason, "turn_timeout");
    assert.equal(result.loser, "A");
    assert.equal(result.winner, "B");
    assert.equal(result.acceptedPlies, 0);
  });

  it("prioritizes total_timeout when remainingMs <= turnTimeLimitMs", async () => {
    const clock = makeFakeClock(0);
    const engine = createNodeEngine();
    const state = engine.createInitialState();
    state.clock.remainingMs.A = 800; // <= 1000ms

    const hungBot = createFunctionBot({
      botId: "hung-a",
      chooseFn() {
        return new Promise(() => {});
      }
    });

    const cfg = makeControllerConfig(state, {
      clock,
      botA: hungBot,
      botB: makeFirstMoveBot("b")
    });

    const controller = createHeadlessMatchController(cfg);
    const runPromise = controller.run();

    for (let i = 0; i < 5; i++) await Promise.resolve();
    clock.advance(801);
    clock.tick();

    const result = await runPromise;
    assert.equal(result.outcome, "forfeit");
    assert.equal(result.reason, "total_timeout");
    assert.equal(result.loser, "A");
    assert.equal(result.winner, "B");
  });

  it("enforces inclusive clock boundary: response at exact deadline is NOT committed", async () => {
    const clock = makeFakeClock(0);
    const engine = createNodeEngine();

    const borderlineBot = createFunctionBot({
      botId: "borderline",
      chooseFn(turn) {
        // Advances clock to exact deadline budget (1000ms) before responding
        clock.advance(1000);
        return turn.legalMoves[0];
      }
    });

    const cfg = makeControllerConfig(null, {
      clock,
      engine,
      botA: borderlineBot,
      botB: makeFirstMoveBot("b")
    });

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();

    // elapsed (1000) >= deadlineBudget (1000) => timeout!
    assert.equal(result.outcome, "forfeit");
    assert.equal(result.reason, "turn_timeout");
    assert.equal(result.loser, "A");
    assert.equal(result.acceptedPlies, 0);
  });

  it("deducts elapsed time only from acting seat", async () => {
    const clock = makeFakeClock(0);
    const journal = makeFakeJournal();
    const engine = createNodeEngine();

    const timedBotA = createFunctionBot({
      botId: "timed-a",
      chooseFn() {
        clock.advance(150); // 150ms elapsed
        return { from: { x: 4, y: 4 }, to: { x: 5, y: 4 } };
      }
    });

    const timedBotB = createFunctionBot({
      botId: "timed-b",
      chooseFn(turn) {
        clock.advance(250); // 250ms elapsed
        return turn.legalMoves[0];
      }
    });

    // Use elimination ready state so game finishes in 1 move
    const elimState = coreFixtures.makeEliminationReadyState();
    const cfg = makeControllerConfig(elimState, {
      clock,
      journal,
      engine,
      botA: timedBotA,
      botB: timedBotB
    });

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();

    assert.equal(result.outcome, "win");
    assert.equal(journal.acceptedMoveCalls.length, 1);
    const moveA = journal.acceptedMoveCalls[0];
    assert.equal(moveA.seat, "A");
    assert.equal(moveA.elapsedMs, 150);
    assert.equal(moveA.remainingMs, 600000 - 150);
    // B was not acting, so B remainingMs is untouched
    assert.equal(moveA.coreState.clock.remainingMs.B, 600000);
  });
});

describe("HeadlessMatchController: fault classification and lifecycle cleanup", () => {
  it("forfeits crash when bot throws an exception", async () => {
    const crasher = createFunctionBot({
      botId: "crasher",
      chooseFn() {
        throw new Error("bot crashed");
      }
    });

    const cfg = makeControllerConfig(null, {
      botA: crasher,
      botB: makeFirstMoveBot("b")
    });

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();
    assert.equal(result.outcome, "forfeit");
    assert.equal(result.reason, "crash");
    assert.equal(result.loser, "A");
    assert.equal(result.winner, "B");
    assert.equal(result.acceptedPlies, 0);
  });

  it("forfeits protocol_error when bot returns invalid action schema", async () => {
    const malformedBot = createFunctionBot({
      botId: "bad-schema",
      chooseFn() {
        return { move: { from: { x: 0, y: 0.5 }, to: { x: 1, y: 1 } } }; // fractional coord
      }
    });

    const cfg = makeControllerConfig(null, {
      botA: malformedBot,
      botB: makeFirstMoveBot("b")
    });

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();
    assert.equal(result.outcome, "forfeit");
    assert.equal(result.reason, "protocol_error");
    assert.equal(result.loser, "A");
    assert.equal(result.winner, "B");
  });

  it("forfeits illegal_move when bot returns an illegal core move", async () => {
    const illegalBot = createFunctionBot({
      botId: "illegal-mover",
      chooseFn() {
        // Move 2 squares is illegal
        return { from: { x: 4, y: 7 }, to: { x: 4, y: 5 } };
      }
    });

    const cfg = makeControllerConfig(null, {
      botA: illegalBot,
      botB: makeFirstMoveBot("b")
    });

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();
    assert.equal(result.outcome, "forfeit");
    assert.equal(result.reason, "illegal_move");
    assert.equal(result.loser, "A");
    assert.equal(result.winner, "B");
  });

  it("stops both bots in finally on all branches and produces terminal once", async () => {
    let stopACalled = false;
    let stopBCalled = false;

    const botA = createFunctionBot({
      botId: "bot-a",
      chooseFn() {
        throw new Error("fault");
      },
      onStop() {
        stopACalled = true;
      }
    });

    const botB = createFunctionBot({
      botId: "bot-b",
      chooseFn(turn) {
        return turn.legalMoves[0];
      },
      onStop() {
        stopBCalled = true;
      }
    });

    const cfg = makeControllerConfig(null, {
      botA,
      botB
    });

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();

    assert.equal(result.outcome, "forfeit");
    assert.equal(stopACalled, true);
    assert.equal(stopBCalled, true);
  });

  it("journal technicalEvent excludes seq and ply fields (assigned by journal)", async () => {
    const journal = makeFakeJournal();
    const crasher = createFunctionBot({
      botId: "crasher",
      chooseFn() {
        throw new Error("fault");
      }
    });

    const cfg = makeControllerConfig(null, {
      journal,
      botA: crasher,
      botB: makeFirstMoveBot("b")
    });

    const controller = createHeadlessMatchController(cfg);
    await controller.run();

    assert.ok(journal.technicalEventCalls.length > 0);
    for (const call of journal.technicalEventCalls) {
      assert.equal(call.seq, undefined);
      assert.equal(call.ply, undefined);
      assert.ok(typeof call.type === "string");
      assert.ok(typeof call.message === "string");
    }
  });
});

describe("HeadlessMatchController: deterministic 400-move sequences on real core", () => {
  it("Scenario 1: ordinary draw at ply 400 (acceptedPlies === 400, reason === max_plies)", async () => {
    const fixture = coreFixtures.makeDraw400Fixture();
    const journal = makeFakeJournal();

    let plyCountA = 0;
    let plyCountB = 0;

    const botA = createFunctionBot({
      botId: "osc-a",
      chooseFn(turn) {
        plyCountA++;
        return fixture.getMoveA(turn.ply);
      }
    });

    const botB = createFunctionBot({
      botId: "osc-b",
      chooseFn(turn) {
        plyCountB++;
        return fixture.getMoveB(turn.ply);
      }
    });

    const cfg = makeControllerConfig(fixture.initialState, {
      journal,
      botA,
      botB
    });

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();

    assert.equal(result.outcome, "draw");
    assert.equal(result.reason, "max_plies");
    assert.equal(result.acceptedPlies, 400);
    assert.equal(plyCountA, 200);
    assert.equal(plyCountB, 200);
    assert.equal(journal.acceptedMoveCalls.length, 400);
    assert.ok(journal.finishResult);
    assert.equal(journal.finishResult.result.outcome, "draw");
  });

  it("Scenario 2: goal priority at ply 400 (goal wins before cap)", async () => {
    const fixture = coreFixtures.makeGoalPriority400Fixture();
    const journal = makeFakeJournal();

    const botA = createFunctionBot({
      botId: "goal-test-a",
      chooseFn(turn) {
        return fixture.getMoveA(turn.ply);
      }
    });

    const botB = createFunctionBot({
      botId: "goal-test-b",
      chooseFn(turn) {
        return fixture.getMoveB(turn.ply);
      }
    });

    const cfg = makeControllerConfig(fixture.initialState, {
      journal,
      botA,
      botB
    });

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();

    // Goal at move 400 has priority over draw cap!
    assert.equal(result.outcome, "win");
    assert.equal(result.reason, "goal");
    assert.equal(result.winner, "B");
    assert.equal(result.loser, "A");
    assert.equal(result.acceptedPlies, 400);
  });

  it("Scenario 3: elimination priority at ply 400 (elimination wins before cap)", async () => {
    const fixture = coreFixtures.makeEliminationPriority400Fixture();
    const journal = makeFakeJournal();

    const botA = createFunctionBot({
      botId: "elim-test-a",
      chooseFn(turn) {
        return fixture.getMoveA(turn.ply);
      }
    });

    const botB = createFunctionBot({
      botId: "elim-test-b",
      chooseFn(turn) {
        return fixture.getMoveB(turn.ply);
      }
    });

    const cfg = makeControllerConfig(fixture.initialState, {
      journal,
      botA,
      botB
    });

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();

    // Elimination at move 400 has priority over draw cap!
    assert.equal(result.outcome, "win");
    assert.equal(result.reason, "elimination");
    assert.equal(result.winner, "B");
    assert.equal(result.loser, "A");
    assert.equal(result.acceptedPlies, 400);
  });

  it("Scenario 4: no_moves priority at ply 400 (no_moves wins before cap)", async () => {
    const fixture = coreFixtures.makeNoMovesPriority400Fixture();
    const journal = makeFakeJournal();

    const botA = createFunctionBot({
      botId: "no-moves-test-a",
      chooseFn(turn) {
        return fixture.getMoveA(turn.ply);
      }
    });

    const botB = createFunctionBot({
      botId: "no-moves-test-b",
      chooseFn(turn) {
        return fixture.getMoveB(turn.ply);
      }
    });

    const cfg = makeControllerConfig(fixture.initialState, {
      journal,
      botA,
      botB
    });

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();

    // No_moves at move 400 has priority over draw cap!
    assert.equal(result.outcome, "win");
    assert.equal(result.reason, "no_moves");
    assert.equal(result.winner, "B");
    assert.equal(result.loser, "A");
    assert.equal(result.acceptedPlies, 400);
  });

  it("Scenario 5: illegal request at ply 400 retains acceptedPlies === 399 and forfeits", async () => {
    const fixture = coreFixtures.makeIllegalRequest400Fixture();
    const journal = makeFakeJournal();

    const botA = createFunctionBot({
      botId: "ill-test-a",
      chooseFn(turn) {
        return fixture.getMoveA(turn.ply);
      }
    });

    const botB = createFunctionBot({
      botId: "ill-test-b",
      chooseFn(turn) {
        return fixture.getMoveB(turn.ply);
      }
    });

    const cfg = makeControllerConfig(fixture.initialState, {
      journal,
      botA,
      botB
    });

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();

    // 399 moves accepted, 400th rejected as illegal => forfeit with acceptedPlies 399
    assert.equal(result.outcome, "forfeit");
    assert.equal(result.reason, "illegal_move");
    assert.equal(result.winner, "A");
    assert.equal(result.loser, "B");
    assert.equal(result.acceptedPlies, 399);
    assert.equal(journal.acceptedMoveCalls.length, 399);
  });
});

function createInstrumentedAbortController() {
  const controller = new AbortController();
  const signal = controller.signal;
  const activeListeners = new Set();
  let maxConcurrent = 0;

  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);

  signal.addEventListener = function (type, listener, options) {
    if (type === "abort") {
      activeListeners.add(listener);
      if (activeListeners.size > maxConcurrent) {
        maxConcurrent = activeListeners.size;
      }
    }
    return originalAdd(type, listener, options);
  };

  signal.removeEventListener = function (type, listener, options) {
    if (type === "abort") {
      activeListeners.delete(listener);
    }
    return originalRemove(type, listener, options);
  };

  return {
    controller,
    signal,
    get activeCount() {
      return activeListeners.size;
    },
    get maxConcurrent() {
      return maxConcurrent;
    }
  };
}

describe("HeadlessMatchController: abort listener lifecycle regression", () => {
  it("real 400-plies run has bounded live listener count (<= 1) and exactly zero after completion", async () => {
    const fixture = coreFixtures.makeDraw400Fixture();
    const instrumented = createInstrumentedAbortController();

    const botA = createFunctionBot({
      botId: "a",
      chooseFn(turn) {
        return fixture.getMoveA(turn.ply);
      }
    });

    const botB = createFunctionBot({
      botId: "b",
      chooseFn(turn) {
        return fixture.getMoveB(turn.ply);
      }
    });

    const cfg = makeControllerConfig(fixture.initialState, {
      botA,
      botB,
      supervisorSignal: instrumented.signal
    });

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();

    assert.equal(result.outcome, "draw");
    assert.equal(result.acceptedPlies, 400);
    assert.ok(
      instrumented.maxConcurrent <= 1,
      `Max concurrent listeners should be <= 1, got ${instrumented.maxConcurrent}`
    );
    assert.equal(
      instrumented.activeCount,
      0,
      `Active listeners after completion must be 0, got ${instrumented.activeCount}`
    );
  });

  it("aborted path leaves exactly zero listeners after completion", async () => {
    const instrumented = createInstrumentedAbortController();
    const clock = makeFakeClock(0);

    const hungBot = createFunctionBot({
      botId: "hung",
      chooseFn() {
        return new Promise(() => {});
      }
    });

    const cfg = makeControllerConfig(null, {
      clock,
      botA: hungBot,
      botB: makeFirstMoveBot("b"),
      supervisorSignal: instrumented.signal
    });

    const controller = createHeadlessMatchController(cfg);
    const runPromise = controller.run();

    await Promise.resolve();
    instrumented.controller.abort();

    const result = await runPromise;
    assert.equal(result.kind, "infrastructure_error");
    assert.equal(result.code, "interrupted");
    assert.equal(
      instrumented.activeCount,
      0,
      `Active listeners after abort must be 0, got ${instrumented.activeCount}`
    );
  });

  it("never-responding timeout path leaves exactly zero listeners after completion", async () => {
    const instrumented = createInstrumentedAbortController();
    const clock = makeFakeClock(0);

    const hungBot = createFunctionBot({
      botId: "hung-a",
      chooseFn() {
        return new Promise(() => {});
      }
    });

    const cfg = makeControllerConfig(null, {
      clock,
      botA: hungBot,
      botB: makeFirstMoveBot("b"),
      supervisorSignal: instrumented.signal
    });

    const controller = createHeadlessMatchController(cfg);
    const runPromise = controller.run();

    for (let i = 0; i < 5; i++) await Promise.resolve();
    clock.advance(1001);
    clock.tick();

    const result = await runPromise;
    assert.equal(result.outcome, "forfeit");
    assert.equal(result.reason, "turn_timeout");
    assert.equal(
      instrumented.activeCount,
      0,
      `Active listeners after timeout must be 0, got ${instrumented.activeCount}`
    );
  });
});

describe("HeadlessMatchController: supervisor review blockers regressions", () => {
  // Blocker 1: initialState optional in .d.mts, defaults to engine.createInitialState()
  it("Blocker 1: defaults to engine.createInitialState() when initialState is undefined (omitted)", async () => {
    const cfg = makeControllerConfig();
    delete cfg.initialState; // explicitly omitted
    cfg.botA = makeFirstMoveBot("a");
    cfg.botB = makeFirstMoveBot("b");

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();
    assert.notEqual(
      result.kind,
      "infrastructure_error",
      `Omitted initialState should run normally, got infrastructure error: ${result.code}`
    );
    assert.ok(result.outcome);
  });

  // Blocker 2: Corrupt host state validation
  it("Blocker 2a: rejects corrupt host state with duplicate piece IDs", async () => {
    const state = rules.createInitialState();
    state.pieces[1].id = state.pieces[0].id; // duplicate ID
    const cfg = makeControllerConfig(state, {
      botA: makeFirstMoveBot("a"),
      botB: makeFirstMoveBot("b")
    });

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();
    assert.equal(result.kind, "infrastructure_error");
    assert.equal(result.code, "duplicate_piece_id");
  });

  it("Blocker 2b: rejects corrupt host state with duplicate cell occupancy", async () => {
    const state = rules.createInitialState();
    state.pieces[1].x = state.pieces[0].x;
    state.pieces[1].y = state.pieces[0].y; // two pieces on same cell
    const cfg = makeControllerConfig(state, {
      botA: makeFirstMoveBot("a"),
      botB: makeFirstMoveBot("b")
    });

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();
    assert.equal(result.kind, "infrastructure_error");
    assert.equal(result.code, "duplicate_cell_occupancy");
  });

  it("Blocker 2c: rejects corrupt host state with negative or non-finite clock banks without fresh fallback", async () => {
    const state = rules.createInitialState();
    state.clock.remainingMs.A = -500; // negative
    const cfg = makeControllerConfig(state, {
      botA: makeFirstMoveBot("a"),
      botB: makeFirstMoveBot("b")
    });

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();
    assert.equal(result.kind, "infrastructure_error");
    assert.equal(result.code, "invalid_initial_clock");

    const state2 = rules.createInitialState();
    state2.clock.remainingMs.B = NaN; // non-finite
    const cfg2 = makeControllerConfig(state2, {
      botA: makeFirstMoveBot("a"),
      botB: makeFirstMoveBot("b")
    });
    const controller2 = createHeadlessMatchController(cfg2);
    const result2 = await controller2.run();
    assert.equal(result2.kind, "infrastructure_error");
    assert.equal(result2.code, "invalid_initial_clock");
  });

  it("Blocker 2d: rejects corrupt host state with invalid piece type or seat or coordinates", async () => {
    const state = rules.createInitialState();
    state.pieces[0].type = "dragon"; // invalid piece type
    const cfg = makeControllerConfig(state, {
      botA: makeFirstMoveBot("a"),
      botB: makeFirstMoveBot("b")
    });

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();
    assert.equal(result.kind, "infrastructure_error");
    assert.equal(result.code, "invalid_piece_type");

    const state2 = rules.createInitialState();
    state2.pieces[0].x = 9; // out of bounds
    const cfg2 = makeControllerConfig(state2, {
      botA: makeFirstMoveBot("a"),
      botB: makeFirstMoveBot("b")
    });
    const controller2 = createHeadlessMatchController(cfg2);
    const result2 = await controller2.run();
    assert.equal(result2.kind, "infrastructure_error");
    assert.equal(result2.code, "invalid_piece_coordinates");
  });

  it("Blocker 2e: rejects corrupt host state when already won under engine.detectWinner", async () => {
    const state = rules.createInitialState();
    // Place A piece directly on A's goal (0,0), but keep state.winner = null
    state.pieces[0].x = 0;
    state.pieces[0].y = 0;
    state.winner = null;
    state.reason = null;

    const cfg = makeControllerConfig(state, {
      botA: makeFirstMoveBot("a"),
      botB: makeFirstMoveBot("b")
    });

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();
    assert.equal(result.kind, "infrastructure_error");
    assert.equal(result.code, "initial_state_already_terminal");
  });

  // Blocker 3: Host exceptions in startup/journal/engine caught as RunFailure and both bots cleaned up
  it("Blocker 3a: catches bot.start failure, cleans up both bots, preserves error code and does not finish replay", async () => {
    let botAStopped = false;
    let botBStopped = false;
    const journal = makeFakeJournal();

    const botA = createFunctionBot({
      botId: "a",
      chooseFn: () => ({ from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }),
      onStop: () => { botAStopped = true; }
    });

    const botB = {
      botId: "b",
      async start() {
        const err = new Error("Bot spawn failed");
        err.kind = "infrastructure_error";
        err.code = "bot_spawn_failed";
        err.retryable = true;
        throw err;
      },
      async requestMove() { throw new Error("not called"); },
      async stop() { botBStopped = true; }
    };

    const cfg = makeControllerConfig(null, {
      journal,
      botA,
      botB
    });

    const controller = createHeadlessMatchController(cfg);
    // run() must NOT reject with unhandled exception!
    const result = await controller.run();
    assert.equal(result.kind, "infrastructure_error");
    assert.equal(result.code, "bot_spawn_failed");
    assert.equal(result.retryable, true);
    assert.equal(botAStopped, true, "botA must be stopped even after botB.start fails");
    assert.equal(botBStopped, true, "botB must be stopped");
    assert.equal(journal.finishResult, null, "journal.finish must not be called on infrastructure error");
  });

  it("Blocker 3b: catches journal.init failure, cleans up both bots, and does not finish replay", async () => {
    let botAStopped = false;
    let botBStopped = false;
    const journal = {
      init() { throw new Error("Journal storage failure"); },
      acceptedMove() {},
      technicalEvent() {},
      finish() {}
    };

    const botA = createFunctionBot({
      botId: "a",
      chooseFn: () => ({ from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }),
      onStop: () => { botAStopped = true; }
    });
    const botB = createFunctionBot({
      botId: "b",
      chooseFn: () => ({ from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }),
      onStop: () => { botBStopped = true; }
    });

    const cfg = makeControllerConfig(null, {
      journal,
      botA,
      botB
    });

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();
    assert.equal(result.kind, "infrastructure_error");
    assert.equal(botAStopped, true);
    assert.equal(botBStopped, true);
  });

  // Blocker 4: requestMove rejection with kind: infrastructure_error returns RunFailure, not crash forfeit
  it("Blocker 4a: requestMove rejected with kind: infrastructure_error preserves RunFailure without bot loss", async () => {
    const journal = makeFakeJournal();
    const infraBot = createFunctionBot({
      botId: "infra-bot",
      chooseFn: () => {
        const err = new Error("Sandbox communication failure");
        err.kind = "infrastructure_error";
        err.code = "sandbox_failure";
        err.retryable = true;
        throw err;
      }
    });

    const cfg = makeControllerConfig(null, {
      journal,
      botA: infraBot,
      botB: makeFirstMoveBot("b")
    });

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();

    assert.equal(result.kind, "infrastructure_error");
    assert.equal(result.code, "sandbox_failure");
    assert.equal(result.retryable, true);
    assert.equal(journal.finishResult, null, "Replay must not finish with forfeit on infrastructure error");
  });

  it("Blocker 4b: genuine plain bot policy throw remains crash forfeit", async () => {
    const crasherBot = createFunctionBot({
      botId: "plain-crasher",
      chooseFn: () => {
        throw new Error("Normal bug in bot algorithm");
      }
    });

    const cfg = makeControllerConfig(null, {
      botA: crasherBot,
      botB: makeFirstMoveBot("b")
    });

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();

    assert.equal(result.outcome, "forfeit");
    assert.equal(result.reason, "crash");
    assert.equal(result.loser, "A");
    assert.equal(result.winner, "B");
  });

  // Boundary 1: Inconsistent mid-run zero legal moves
  it("Boundary: inconsistent mid-run zero legal moves returns infrastructure error, not fabricated win", async () => {
    let callCount = 0;
    const baseEngine = createNodeEngine();
    const spyEngine = {
      ...baseEngine,
      allMoves(state, seat) {
        callCount++;
        // On the second allMoves call (seat B's turn after ply 1), return empty array
        // while state.winner is null (inconsistent non-terminal state)
        if (callCount > 1) {
          return [];
        }
        return baseEngine.allMoves(state, seat);
      }
    };

    const cfg = makeControllerConfig(null, {
      engine: spyEngine,
      botA: makeFirstMoveBot("a"),
      botB: makeFirstMoveBot("b")
    });

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();

    assert.equal(result.kind, "infrastructure_error");
    assert.equal(result.code, "inconsistent_engine_state_no_legal_moves");
  });

  // Boundary 2: Malformed rulesetSnapshot validation
  it("Boundary: malformed rulesetSnapshot returns infrastructure error before starting bots", async () => {
    let botAStarted = false;
    let botBStarted = false;

    const botA = createFunctionBot({
      botId: "bot-a",
      chooseFn: () => ({ from: { x: 0, y: 0 }, to: { x: 1, y: 1 } })
    });
    const originalStartA = botA.start.bind(botA);
    botA.start = async (ctx) => {
      botAStarted = true;
      return originalStartA(ctx);
    };

    const botB = createFunctionBot({
      botId: "bot-b",
      chooseFn: () => ({ from: { x: 0, y: 0 }, to: { x: 1, y: 1 } })
    });
    const originalStartB = botB.start.bind(botB);
    botB.start = async (ctx) => {
      botBStarted = true;
      return originalStartB(ctx);
    };

    const cfg = makeControllerConfig(null, {
      rulesetSnapshot: {
        rulesetId: "unsupported-custom-ruleset",
        boardWidth: 9
      },
      botA,
      botB
    });

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();

    assert.equal(result.kind, "infrastructure_error");
    assert.equal(result.code, "invalid_ruleset_snapshot");
    assert.equal(botAStarted, false, "botA must not be started on malformed ruleset");
    assert.equal(botBStarted, false, "botB must not be started on malformed ruleset");
  });

  // Final Check 1: journal.finish throw
  it("Final Check: journal.finish throw returns structured RunFailure and stops both bots", async () => {
    let botAStopped = false;
    let botBStopped = false;
    const journal = makeFakeJournal();
    journal.finish = () => {
      const err = new Error("Journal disk write error");
      err.kind = "infrastructure_error";
      err.code = "journal_finish_failed";
      throw err;
    };

    const botA = createFunctionBot({
      botId: "a",
      chooseFn: () => ({ from: { x: 4, y: 7 }, to: { x: 3, y: 6 } }),
      onStop: () => { botAStopped = true; }
    });
    const botB = createFunctionBot({
      botId: "b",
      chooseFn: () => ({ from: { x: 4, y: 1 }, to: { x: 5, y: 2 } }),
      onStop: () => { botBStopped = true; }
    });

    const cfg = makeControllerConfig(null, {
      journal,
      botA,
      botB
    });

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();

    assert.equal(result.kind, "infrastructure_error");
    assert.equal(result.code, "journal_finish_failed");
    assert.equal(botAStopped, true, "botA must be stopped");
    assert.equal(botBStopped, true, "botB must be stopped");
  });

  // Final Check 2: terminal engine.cloneState throw
  it("Final Check: terminal engine.cloneState throw returns structured RunFailure and stops both bots", async () => {
    let botAStopped = false;
    let botBStopped = false;
    const baseEngine = createNodeEngine();
    let throwOnClone = false;
    const spyEngine = {
      ...baseEngine,
      cloneState(state) {
        if (throwOnClone) {
          const err = new Error("Engine clone failure at terminal");
          err.kind = "infrastructure_error";
          err.code = "terminal_clone_failed";
          throw err;
        }
        return baseEngine.cloneState(state);
      }
    };

    const botA = createFunctionBot({
      botId: "a",
      chooseFn: () => {
        throwOnClone = true;
        throw new Error("forfeit crash");
      },
      onStop: () => { botAStopped = true; }
    });
    const botB = createFunctionBot({
      botId: "b",
      chooseFn: () => ({ from: { x: 4, y: 1 }, to: { x: 5, y: 2 } }),
      onStop: () => { botBStopped = true; }
    });

    const cfg = makeControllerConfig(null, {
      engine: spyEngine,
      botA,
      botB
    });

    const controller = createHeadlessMatchController(cfg);
    const result = await controller.run();

    assert.equal(result.kind, "infrastructure_error");
    assert.equal(result.code, "terminal_clone_failed");
    assert.equal(botAStopped, true);
    assert.equal(botBStopped, true);
  });

  // Final Check 3: synchronous botA.stop throw still allows botB.stop to be called
  it("Final Check: synchronous throw in botA.stop still allows botB.stop to be called", async () => {
    let botBStopped = false;
    const botA = {
      botId: "sync-thrower",
      async start() {},
      async requestMove() {
        return {
          protocolVersion: 1,
          requestId: "req",
          move: { from: { x: 4, y: 7 }, to: { x: 3, y: 6 } }
        };
      },
      stop() {
        throw new Error("Synchronous stop throw in botA");
      }
    };
    const botB = {
      botId: "bot-b",
      async start() {},
      async requestMove() {
        return {
          protocolVersion: 1,
          requestId: "req",
          move: { from: { x: 4, y: 1 }, to: { x: 5, y: 2 } }
        };
      },
      async stop() {
        botBStopped = true;
      }
    };

    const cfg = makeControllerConfig(null, {
      botA,
      botB
    });

    const controller = createHeadlessMatchController(cfg);
    await controller.run();

    assert.equal(botBStopped, true, "botB.stop must still be called even if botA.stop throws synchronously");
  });
});


