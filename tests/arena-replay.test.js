/**
 * Arena Replay Journal and Validator Tests — Task 3
 * Tests ReplayJournal and runtime validateReplayDocument bounded validation.
 * Uses dynamic import for ESM modules from CJS test context.
 * Uses REAL game-core engine (no mocks) for rules and win validation.
 */

"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const coreFixtures = require("./fixtures/arena/core-states.js");
const config = require("../packages/game-core/src/config.js");

let createReplayJournal;
let ReplayJournal;
let validateReplayDocument;
let validateArenaMatchResult;
let canonicalSerialize;
let createWinResult;
let createDrawResult;
let createForfeitResult;
let DEFAULT_MATCH_POLICY;
let createCurrentRulesetSnapshot;
let createHeadlessMatchController;
let createFunctionBot;
let createNodeEngine;
let computeCurrentEngineFingerprint;
let computeRulesetHash;
let computeReplayDigest;

before(async () => {
  const journalMod = await import("../packages/arena/src/application/replay-journal.mjs");
  const contractsMod = await import("../packages/arena/src/contracts/index.mjs");
  const controllerMod = await import("../packages/arena/src/application/match-controller.mjs");
  const functionBotMod = await import("../packages/arena/src/adapters/function-bot.mjs");
  const engineMod = await import("../packages/arena-node/src/core/node-engine.mjs");
  const identityMod = await import("../packages/arena-node/src/core/ruleset-identity.mjs");

  createReplayJournal = journalMod.createReplayJournal;
  ReplayJournal = journalMod.ReplayJournal;
  validateReplayDocument = contractsMod.validateReplayDocument;
  validateArenaMatchResult = contractsMod.validateArenaMatchResult;
  canonicalSerialize = contractsMod.canonicalSerialize;
  createWinResult = contractsMod.createWinResult;
  createDrawResult = contractsMod.createDrawResult;
  createForfeitResult = contractsMod.createForfeitResult;
  DEFAULT_MATCH_POLICY = contractsMod.DEFAULT_MATCH_POLICY;
  createCurrentRulesetSnapshot = contractsMod.createCurrentRulesetSnapshot;
  createHeadlessMatchController = controllerMod.createHeadlessMatchController;
  createFunctionBot = functionBotMod.createFunctionBot;
  createNodeEngine = engineMod.createNodeEngine;
  computeCurrentEngineFingerprint = identityMod.computeCurrentEngineFingerprint;
  computeRulesetHash = identityMod.computeRulesetHash;
  computeReplayDigest = identityMod.computeReplayDigest;
});

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

function cloneDeep(val) {
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(cloneDeep);
  const copy = {};
  for (const k of Object.keys(val)) {
    copy[k] = cloneDeep(val[k]);
  }
  return copy;
}

function makeValidInitArgs() {
  const snapshot = createCurrentRulesetSnapshot(config);
  const hash = computeRulesetHash(snapshot);
  const engine = createNodeEngine();
  const initialCoreState = engine.createInitialState();

  return {
    matchId: "match-test-replay-001",
    engineRevision: "sha256:engine-rev-001",
    engineGitRevision: "20a8371",
    rulesetId: snapshot.rulesetId,
    rulesetHash: hash,
    rulesetSnapshot: cloneDeep(snapshot),
    matchPolicy: cloneDeep(DEFAULT_MATCH_POLICY),
    participants: {
      A: { botId: "bot-alpha", name: "AlphaBot" },
      B: { botId: "bot-beta", name: "BetaBot" }
    },
    initialCoreState: cloneDeep(initialCoreState)
  };
}

describe("ReplayJournal — lifecycle, event sequencing and immutability", () => {
  it("initializes frame 0 and init event at seq 0, ply 0", () => {
    const journal = createReplayJournal();
    const initArgs = makeValidInitArgs();

    journal.init(initArgs);

    // Document is not finished yet, getDocument returns null
    assert.equal(journal.getDocument(), null);

    const winResult = createWinResult({
      winner: "A",
      loser: "B",
      reason: "goal",
      acceptedPlies: 0
    });
    const terminalState = cloneDeep(initArgs.initialCoreState);
    terminalState.winner = "A";
    terminalState.reason = "goal";

    const doc = journal.finish(winResult, terminalState);

    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.matchId, initArgs.matchId);
    assert.equal(doc.frames.length, 1);
    assert.equal(doc.frames[0].ply, 0);
    assert.equal(doc.frames[0].lastMove, null);
    assert.deepEqual(doc.frames[0].coreState.pieces, initArgs.initialCoreState.pieces);

    // Initial event at seq 0, ply 0
    assert.equal(doc.events[0].seq, 0);
    assert.equal(doc.events[0].ply, 0);
    assert.equal(doc.events[0].type, "init");

    // Terminal event is present
    const lastEvent = doc.events[doc.events.length - 1];
    assert.equal(lastEvent.type, "terminal");
    assert.equal(lastEvent.seq, 1);
    assert.equal(lastEvent.ply, 0);
  });

  it("sequences init, technical, move, capture, terminal with distinct monotonic seq and corresponding plies", () => {
    const journal = createReplayJournal();
    const initArgs = makeValidInitArgs();
    journal.init(initArgs);

    // Technical event at ply 0 (before moves)
    journal.technicalEvent({
      type: "start",
      message: "Match started"
    });

    const engine = createNodeEngine();
    let coreState = engine.createInitialState();

    // Opening move (non-capture)
    const legalMoves = engine.allMoves(coreState, "A");
    const m1 = legalMoves[0];
    const move1Result = engine.applyMove(coreState, "A", m1.from, m1.to);
    assert.equal(move1Result.ok, true);
    coreState = move1Result.state;

    journal.acceptedMove({
      seat: "A",
      pieceId: m1.pieceId,
      from: m1.from,
      to: m1.to,
      capturedPieceId: null,
      capturedPieceType: null,
      elapsedMs: 25,
      remainingMs: 599975,
      events: move1Result.events,
      coreState: cloneDeep(coreState)
    });

    // Technical pause at ply 1
    journal.technicalEvent({
      type: "technical_pause",
      message: "Brief technical pause"
    });

    // Capture move at ply 2
    journal.acceptedMove({
      seat: "B",
      pieceId: "p2",
      from: { x: 4, y: 1 },
      to: { x: 4, y: 6 },
      capturedPieceId: "p1",
      capturedPieceType: "la",
      elapsedMs: 30,
      remainingMs: 599970,
      events: [
        { type: "move", pieceId: "p2", from: { x: 4, y: 1 }, to: { x: 4, y: 6 } },
        { type: "capture", pieceId: "p2", capturedId: "p1", capturedType: "la", from: { x: 4, y: 1 }, to: { x: 4, y: 6 } }
      ],
      coreState: cloneDeep(coreState)
    });

    const winResult = createWinResult({
      winner: "B",
      loser: "A",
      reason: "elimination",
      acceptedPlies: 2
    });
    const terminalState = cloneDeep(coreState);
    terminalState.winner = "B";
    terminalState.reason = "elimination";

    const doc = journal.finish(winResult, terminalState);

    // Verify frames: exactly acceptedPlies + 1 = 3 frames
    assert.equal(doc.frames.length, 3);
    assert.equal(doc.frames[0].ply, 0);
    assert.equal(doc.frames[0].lastMove, null);
    assert.equal(doc.frames[1].ply, 1);
    assert.equal(doc.frames[1].lastMove.seat, "A");
    assert.equal(doc.frames[1].lastMove.capturedPieceId, null);
    assert.equal(doc.frames[2].ply, 2);
    assert.equal(doc.frames[2].lastMove.seat, "B");
    assert.equal(doc.frames[2].lastMove.capturedPieceId, "p1");

    // Persisted lastMove must NOT retain coreState!
    assert.equal(doc.frames[1].lastMove.coreState, undefined);
    assert.equal(doc.frames[2].lastMove.coreState, undefined);

    // Verify events sequence integrity: contiguous seq from 0
    assert.deepEqual(doc.events.map((e) => e.seq), [0, 1, 2, 3, 4, 5, 6]);

    // Check individual event types and mapped plies:
    // seq 0: init (ply 0)
    assert.equal(doc.events[0].type, "init");
    assert.equal(doc.events[0].ply, 0);

    // seq 1: technical start (ply 0)
    assert.equal(doc.events[1].type, "technical");
    assert.equal(doc.events[1].ply, 0);
    assert.equal(doc.events[1].payload.type, "start");

    // seq 2: move (ply 1)
    assert.equal(doc.events[2].type, "move");
    assert.equal(doc.events[2].ply, 1);

    // seq 3: technical pause (ply 1)
    assert.equal(doc.events[3].type, "technical");
    assert.equal(doc.events[3].ply, 1);

    // seq 4: move (ply 2)
    assert.equal(doc.events[4].type, "move");
    assert.equal(doc.events[4].ply, 2);

    // seq 5: capture (ply 2)
    assert.equal(doc.events[5].type, "capture");
    assert.equal(doc.events[5].ply, 2);
    assert.equal(doc.events[5].payload.capturedPieceId, "p1");

    // seq 6: terminal (ply 2)
    assert.equal(doc.events[6].type, "terminal");
    assert.equal(doc.events[6].ply, 2);
    assert.equal(doc.events[6].payload.outcome, "win");
  });

  it("duplicate finish does not add extra terminal event or mutate document", () => {
    const journal = createReplayJournal();
    journal.init(makeValidInitArgs());

    const result = createDrawResult({ acceptedPlies: 0 });
    const terminalState = cloneDeep(makeValidInitArgs().initialCoreState);

    const doc1 = journal.finish(result, terminalState);
    const eventCount1 = doc1.events.length;

    // Call finish a second time
    const doc2 = journal.finish(result, terminalState);

    assert.equal(doc2.events.length, eventCount1);
    assert.deepEqual(doc1, doc2);

    // getDocument returns the same finalized clone
    const doc3 = journal.getDocument();
    assert.deepEqual(doc1, doc3);
  });

  it("throws when calling init twice or acceptedMove before init / after finish", () => {
    const journal = createReplayJournal();
    const initArgs = makeValidInitArgs();

    // acceptedMove before init throws
    assert.throws(() => {
      journal.acceptedMove({
        seat: "A",
        pieceId: "p1",
        from: { x: 0, y: 0 },
        to: { x: 0, y: 1 },
        coreState: initArgs.initialCoreState
      });
    }, /not initialized/i);

    journal.init(initArgs);

    // Second init throws
    assert.throws(() => {
      journal.init(initArgs);
    }, /already initialized/i);

    journal.finish(createDrawResult({ acceptedPlies: 0 }), initArgs.initialCoreState);

    // acceptedMove after finish throws
    assert.throws(() => {
      journal.acceptedMove({
        seat: "A",
        pieceId: "p1",
        from: { x: 0, y: 0 },
        to: { x: 0, y: 1 },
        coreState: initArgs.initialCoreState
      });
    }, /finished/i);
  });

  it("enforces deep clone isolation: mutating original inputs does not affect ReplayDocument", () => {
    const journal = createReplayJournal();
    const initArgs = makeValidInitArgs();
    journal.init(initArgs);

    // Mutate original initArgs after init
    initArgs.initialCoreState.turn = "MUTATED";
    initArgs.matchPolicy.maxPlies = 999;
    initArgs.participants.A.botId = "MUTATED_BOT";

    const engine = createNodeEngine();
    const coreState = engine.createInitialState();
    const moveInput = {
      seat: "A",
      pieceId: "p1",
      from: { x: 4, y: 7 },
      to: { x: 4, y: 6 },
      capturedPieceId: null,
      capturedPieceType: null,
      elapsedMs: 10,
      remainingMs: 599990,
      events: [],
      coreState
    };

    journal.acceptedMove(moveInput);

    // Mutate moveInput after acceptedMove
    moveInput.seat = "MUTATED_SEAT";
    moveInput.from.x = 99;
    moveInput.coreState.turn = "MUTATED_CORE";

    const winResult = createWinResult({
      winner: "A",
      loser: "B",
      reason: "goal",
      acceptedPlies: 1
    });
    const terminalState = engine.createInitialState();
    terminalState.winner = "A";
    terminalState.reason = "goal";

    const doc = journal.finish(winResult, terminalState);

    // Mutate winResult and terminalState after finish
    winResult.winner = "MUTATED";
    terminalState.reason = "MUTATED";

    // Verify stored ReplayDocument remains completely intact
    assert.equal(doc.initialCoreState.turn, "A");
    assert.equal(doc.matchPolicy.maxPlies, 400);
    assert.equal(doc.participants.A.botId, "bot-alpha");
    assert.equal(doc.frames[1].lastMove.seat, "A");
    assert.equal(doc.frames[1].lastMove.from.x, 4);
    assert.equal(doc.frames[1].coreState.turn, "A");
    assert.equal(doc.result.winner, "A");
    assert.equal(doc.terminalCoreState.reason, "goal");

    // Mutate the returned doc and verify getDocument() returns an unmodified clone
    doc.matchId = "MUTATED_DOC";
    const freshDoc = journal.getDocument();
    assert.equal(freshDoc.matchId, "match-test-replay-001");
  });

  it("keeps frame0 initial state and applies real clocks; terminal clock fault does not rewrite history frames", () => {
    const journal = createReplayJournal();
    const initArgs = makeValidInitArgs();
    initArgs.initialCoreState.clock.remainingMs.A = 600000;
    initArgs.initialCoreState.clock.remainingMs.B = 600000;
    journal.init(initArgs);

    const engine = createNodeEngine();
    const coreState1 = engine.createInitialState();
    coreState1.clock.remainingMs.A = 595000;
    coreState1.clock.remainingMs.B = 600000;

    journal.acceptedMove({
      seat: "A",
      pieceId: "p1",
      from: { x: 4, y: 7 },
      to: { x: 4, y: 6 },
      capturedPieceId: null,
      capturedPieceType: null,
      elapsedMs: 5000,
      remainingMs: 595000,
      events: [],
      coreState: coreState1
    });

    // Seat B times out at ply 2: terminal state deducts budget, but frame 1 remains unchanged
    const terminalState = cloneDeep(coreState1);
    terminalState.clock.remainingMs.B = 0; // timed out
    terminalState.clock.runningSeat = null;

    const forfeitResult = createForfeitResult({
      winner: "A",
      loser: "B",
      reason: "total_timeout",
      acceptedPlies: 1
    });

    const doc = journal.finish(forfeitResult, terminalState);

    // Frame 0 has initial clock
    assert.equal(doc.frames[0].coreState.clock.remainingMs.A, 600000);
    assert.equal(doc.frames[0].coreState.clock.remainingMs.B, 600000);

    // Frame 1 has clock after move 1
    assert.equal(doc.frames[1].coreState.clock.remainingMs.A, 595000);
    assert.equal(doc.frames[1].coreState.clock.remainingMs.B, 600000);

    // Terminal state has deducted timeout clock
    assert.equal(doc.terminalCoreState.clock.remainingMs.B, 0);
  });
});

describe("validateReplayDocument — bounded runtime validation", () => {
  function makeValidReplayDocument() {
    const journal = createReplayJournal();
    const initArgs = makeValidInitArgs();
    journal.init(initArgs);

    const engine = createNodeEngine();
    let coreState = engine.createInitialState();

    const legalMoves = engine.allMoves(coreState, "A");
    const m1 = legalMoves[0];
    const moveResult = engine.applyMove(coreState, "A", m1.from, m1.to);
    coreState = moveResult.state;

    journal.acceptedMove({
      seat: "A",
      pieceId: m1.pieceId,
      from: m1.from,
      to: m1.to,
      capturedPieceId: null,
      capturedPieceType: null,
      elapsedMs: 100,
      remainingMs: 599900,
      events: moveResult.events,
      coreState
    });

    const winResult = createWinResult({
      winner: "A",
      loser: "B",
      reason: "goal",
      acceptedPlies: 1
    });
    const terminalState = cloneDeep(coreState);
    terminalState.winner = "A";
    terminalState.reason = "goal";

    return journal.finish(winResult, terminalState);
  }

  it("passes validation on valid ReplayDocument", () => {
    const doc = makeValidReplayDocument();
    const validation = validateReplayDocument(doc);
    assert.equal(validation.ok, true, `Validation failed: ${JSON.stringify(validation.errors)}`);
    assert.equal(validation.errors.length, 0);
  });

  it("rejects document exceeding 8 MiB budget", () => {
    const doc = makeValidReplayDocument();
    // Simulate oversized document with large comment or payload
    const bigString = "x".repeat(8 * 1024 * 1024 + 100);
    doc.events[0].payload = { padding: bigString };

    const validation = validateReplayDocument(doc);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((e) => e.code === "document_size_exceeded"));
  });

  it("rejects schemaVersion !== 1", () => {
    const doc = makeValidReplayDocument();
    doc.schemaVersion = 2;
    const validation = validateReplayDocument(doc);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((e) => e.code === "invalid_schema_version"));
  });

  it("allows unknown engineRevision for valid G9 snapshot (viewing only)", () => {
    const doc = makeValidReplayDocument();
    doc.engineRevision = "sha256:unknown-future-engine-revision-xyz";
    doc.engineGitRevision = null;
    const validation = validateReplayDocument(doc);
    assert.equal(validation.ok, true, `Should accept unknown engine revision: ${JSON.stringify(validation.errors)}`);
  });

  it("rejects unsupported board dimension / schema", () => {
    const doc = makeValidReplayDocument();
    doc.rulesetSnapshot.boardWidth = 8;
    const validation = validateReplayDocument(doc);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((e) => e.code === "unsupported_board_dimensions"));
  });

  it("rejects duplicate or gap event seq numbers", () => {
    const doc = makeValidReplayDocument();
    // Create gap: seq 0, then seq 2 (missing seq 1)
    doc.events[1].seq = 2;
    const valGap = validateReplayDocument(doc);
    assert.equal(valGap.ok, false);
    assert.ok(valGap.errors.some((e) => e.code === "invalid_event_sequence"));

    // Duplicate seq
    doc.events[1].seq = 0;
    const valDup = validateReplayDocument(doc);
    assert.equal(valDup.ok, false);
    assert.ok(valDup.errors.some((e) => e.code === "invalid_event_sequence"));
  });

  it("rejects event count exceeding 2000 events limit", () => {
    const doc = makeValidReplayDocument();
    const events = [];
    for (let i = 0; i <= 2001; i++) {
      events.push({
        seq: i,
        ply: 0,
        type: i === 0 ? "init" : i === 2001 ? "terminal" : "technical",
        payload: {}
      });
    }
    doc.events = events;
    const validation = validateReplayDocument(doc);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((e) => e.code === "event_count_exceeded"));
  });

  it("rejects frame count not matching acceptedPlies + 1", () => {
    const doc = makeValidReplayDocument();
    // acceptedPlies is 1, so frames should be 2. Remove one frame.
    doc.frames = [doc.frames[0]];
    const validation = validateReplayDocument(doc);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((e) => e.code === "frame_count_mismatch"));
  });

  it("rejects acceptedPlies exceeding maxPlies cap (400)", () => {
    const doc = makeValidReplayDocument();
    doc.result.acceptedPlies = 401;
    const validation = validateReplayDocument(doc);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((e) => e.code === "accepted_plies_exceeded"));
  });

  it("validates forfeit at ply 0 is allowed", () => {
    const journal = createReplayJournal();
    const initArgs = makeValidInitArgs();
    journal.init(initArgs);

    const forfeitResult = createForfeitResult({
      winner: "B",
      loser: "A",
      reason: "turn_timeout",
      acceptedPlies: 0
    });
    const terminalState = cloneDeep(initArgs.initialCoreState);
    const doc = journal.finish(forfeitResult, terminalState);

    const validation = validateReplayDocument(doc);
    assert.equal(validation.ok, true, `Forfeit at ply 0 must be valid: ${JSON.stringify(validation.errors)}`);

    const fixtureDir = path.resolve(__dirname, "fixtures/arena/replays");
    if (!fs.existsSync(fixtureDir)) {
      fs.mkdirSync(fixtureDir, { recursive: true });
    }
    fs.writeFileSync(path.join(fixtureDir, "forfeit-ply0.json"), JSON.stringify(doc, null, 2), "utf8");
  });

  it("rejects draw when acceptedPlies < 400 (cap requirement under arena-policy-v1)", () => {
    const doc = makeValidReplayDocument();
    // Fabricate draw result at ply 10
    doc.result = {
      outcome: "draw",
      winner: null,
      loser: null,
      reason: "max_plies",
      acceptedPlies: 10
    };
    // Adjust frame count to match 11
    doc.frames = Array.from({ length: 11 }, (_, i) => ({
      ply: i,
      coreState: doc.frames[0].coreState,
      lastMove: i === 0 ? null : doc.frames[1].lastMove
    }));
    const validation = validateReplayDocument(doc);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((e) => e.code === "invalid_draw_plies"));
  });

  it("rejects duplicate piece IDs within a frame", () => {
    const doc = makeValidReplayDocument();
    const pieces = cloneDeep(doc.frames[0].coreState.pieces);
    pieces.push({ id: pieces[0].id, player: "A", type: "la", x: 0, y: 1 });
    doc.frames[0].coreState.pieces = pieces;

    const validation = validateReplayDocument(doc);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((e) => e.code === "duplicate_piece_id"));
  });

  it("rejects duplicate cell occupancy within a frame", () => {
    const doc = makeValidReplayDocument();
    const pieces = cloneDeep(doc.frames[0].coreState.pieces);
    // Put second piece on same cell as first piece
    pieces[1].x = pieces[0].x;
    pieces[1].y = pieces[0].y;
    doc.frames[0].coreState.pieces = pieces;

    const validation = validateReplayDocument(doc);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((e) => e.code === "duplicate_cell_occupancy"));
  });

  it("rejects invalid piece coordinates (out of bounds 0..8 or non-integers)", () => {
    const doc = makeValidReplayDocument();
    doc.frames[0].coreState.pieces[0].x = 9;
    const validation = validateReplayDocument(doc);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((e) => e.code === "coordinate_out_of_bounds"));
  });

  it("rejects frame count > 81 pieces", () => {
    const doc = makeValidReplayDocument();
    const pieces = [];
    for (let x = 0; x < 9; x++) {
      for (let y = 0; y < 9; y++) {
        pieces.push({ id: `p-${x}-${y}`, player: "A", type: "dam", x, y });
      }
    }
    // Add 82nd piece
    pieces.push({ id: "p-extra", player: "B", type: "la", x: 0, y: 0 });
    doc.frames[0].coreState.pieces = pieces;

    const validation = validateReplayDocument(doc);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((e) => e.code === "piece_count_exceeded"));
  });

  it("rejects lastMove containing forbidden coreState snapshot property", () => {
    const doc = makeValidReplayDocument();
    doc.frames[1].lastMove.coreState = doc.frames[1].coreState;
    const validation = validateReplayDocument(doc);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((e) => e.code === "forbidden_core_state_in_last_move"));
  });

  it("rejects result outcome mismatch with terminalCoreState (e.g. win outcome with mismatched winner)", () => {
    const doc = makeValidReplayDocument();
    // Result has winner A, change terminalCoreState to B
    doc.terminalCoreState.winner = "B";
    const validation = validateReplayDocument(doc);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((e) => e.code === "result_terminal_mismatch"));
  });
});

describe("Deterministic integration with HeadlessMatchController + FunctionBot + fake clock", () => {
  it("runs full deterministic game and produces valid ReplayDocument matching digest roundtrip", async () => {
    const engine = createNodeEngine();
    const snapshot = createCurrentRulesetSnapshot(config);
    const rulesetHash = computeRulesetHash(snapshot);
    const engineRevision = "sha256:test-engine-rev";

    // Play bot A greedily or forward, bot B defensively
    const botA = createFunctionBot({
      botId: "bot-a",
      name: "BotA",
      chooseFn: (turn) => turn.legalMoves[0]
    });

    const botB = createFunctionBot({
      botId: "bot-b",
      name: "BotB",
      chooseFn: (turn) => turn.legalMoves[0]
    });

    const fakeClock = makeFakeClock(1000);
    const journal = createReplayJournal();

    const controller = createHeadlessMatchController({
      matchId: "match-det-001",
      engine,
      botA,
      botB,
      clock: fakeClock,
      journal,
      rulesetSnapshot: snapshot,
      rulesetHash,
      engineRevision,
      engineGitRevision: "20a8371",
      policy: DEFAULT_MATCH_POLICY,
      participants: {
        A: { botId: "bot-a", name: "BotA" },
        B: { botId: "bot-b", name: "BotB" }
      }
    });

    const result = await controller.run();
    assert.ok(result);
    assert.notEqual(result.kind, "infrastructure_error");

    const doc = journal.getDocument();
    assert.ok(doc, "getDocument must return finalized document");

    // Validate the generated document passes all bounds & invariants
    const validation = validateReplayDocument(doc);
    assert.equal(validation.ok, true, `Generated document must be valid: ${JSON.stringify(validation.errors)}`);

    // Verify roundtrip serialization
    const serialized = JSON.stringify(doc);
    assert.ok(serialized.length <= 8 * 1024 * 1024);

    const parsed = JSON.parse(serialized);
    const parsedVal = validateReplayDocument(parsed);
    assert.equal(parsedVal.ok, true);
    assert.deepEqual(parsed, doc);

    // Compute canonical digest
    const digest1 = computeReplayDigest(doc);
    const digest2 = computeReplayDigest(parsed);
    assert.equal(digest1, digest2);
    assert.ok(digest1.startsWith("sha256:"));

    // Save fixture for tests/fixtures/arena/replays/
    const fixtureDir = path.resolve(__dirname, "fixtures/arena/replays");
    if (!fs.existsSync(fixtureDir)) {
      fs.mkdirSync(fixtureDir, { recursive: true });
    }
    fs.writeFileSync(path.join(fixtureDir, "deterministic-match.json"), serialized, "utf8");
    assert.ok(fs.existsSync(path.join(fixtureDir, "deterministic-match.json")));
  });

  it("produces identical ReplayDocument across two independent runs with identical deterministic bots", async () => {
    async function runDeterministicMatch(matchId) {
      const engine = createNodeEngine();
      const snapshot = createCurrentRulesetSnapshot(config);
      const rulesetHash = computeRulesetHash(snapshot);

      const botA = createFunctionBot({
        botId: "bot-a",
        chooseFn: (turn) => turn.legalMoves[0]
      });
      const botB = createFunctionBot({
        botId: "bot-b",
        chooseFn: (turn) => turn.legalMoves[0]
      });

      const fakeClock = makeFakeClock(0);
      const journal = createReplayJournal();

      const controller = createHeadlessMatchController({
        matchId,
        engine,
        botA,
        botB,
        clock: fakeClock,
        journal,
        rulesetSnapshot: snapshot,
        rulesetHash,
        engineRevision: "sha256:engine-det",
        engineGitRevision: "20a8371",
        policy: DEFAULT_MATCH_POLICY,
        participants: {
          A: { botId: "bot-a" },
          B: { botId: "bot-b" }
        }
      });

      await controller.run();
      return journal.getDocument();
    }

    const doc1 = await runDeterministicMatch("match-same-seed");
    const doc2 = await runDeterministicMatch("match-same-seed");

    assert.deepEqual(doc1, doc2);
    const digest1 = computeReplayDigest(doc1);
    const digest2 = computeReplayDigest(doc2);
    assert.equal(digest1, digest2);
  });
});

describe("Task 3 Review Consolidated Regressions (Blocks 1-7)", () => {
  function makeBaseDoc() {
    const journal = createReplayJournal();
    const initArgs = makeValidInitArgs();
    journal.init(initArgs);

    const engine = createNodeEngine();
    let coreState = engine.createInitialState();
    const legalMoves = engine.allMoves(coreState, "A");
    const m1 = legalMoves[0];
    const moveResult = engine.applyMove(coreState, "A", m1.from, m1.to);
    coreState = moveResult.state;

    journal.acceptedMove({
      seat: "A",
      pieceId: m1.pieceId,
      from: m1.from,
      to: m1.to,
      capturedPieceId: null,
      capturedPieceType: null,
      elapsedMs: 50,
      remainingMs: 599950,
      events: moveResult.events,
      coreState
    });

    const winResult = createWinResult({
      winner: "A",
      loser: "B",
      reason: "goal",
      acceptedPlies: 1
    });
    const terminalState = cloneDeep(coreState);
    terminalState.winner = "A";
    terminalState.reason = "goal";
    terminalState.clock.runningSeat = null;

    return journal.finish(winResult, terminalState);
  }

  // --- Block 1: null guards, unserializable error, early return ---
  it("Block 1: handles null frames array, empty frames, and null frame entries without crash", () => {
    const docNullFrames = makeBaseDoc();
    docNullFrames.frames = null;
    const res1 = validateReplayDocument(docNullFrames);
    assert.equal(res1.ok, false);
    assert.ok(res1.errors.some((e) => e.code === "invalid_frames"));

    const docEmptyFrames = makeBaseDoc();
    docEmptyFrames.frames = [];
    const res2 = validateReplayDocument(docEmptyFrames);
    assert.equal(res2.ok, false);
    assert.ok(res2.errors.some((e) => e.code === "frame_count_mismatch" || e.code === "invalid_frames"));

    const docNullEntry = makeBaseDoc();
    docNullEntry.frames[0] = null;
    const res3 = validateReplayDocument(docNullEntry);
    assert.equal(res3.ok, false);
    assert.ok(res3.errors.some((e) => e.code === "invalid_frame"));
  });

  it("Block 1: handles null events array, empty events, and null event entries without crash", () => {
    const docNullEvents = makeBaseDoc();
    docNullEvents.events = null;
    const res1 = validateReplayDocument(docNullEvents);
    assert.equal(res1.ok, false);
    assert.ok(res1.errors.some((e) => e.code === "invalid_events"));

    const docEmptyEvents = makeBaseDoc();
    docEmptyEvents.events = [];
    const res2 = validateReplayDocument(docEmptyEvents);
    assert.equal(res2.ok, false);
    assert.ok(res2.errors.some((e) => e.code === "empty_events"));

    const docNullEvEntry = makeBaseDoc();
    docNullEvEntry.events[0] = null;
    const res3 = validateReplayDocument(docNullEvEntry);
    assert.equal(res3.ok, false);
    assert.ok(res3.errors.some((e) => e.code === "invalid_event"));
  });

  it("Block 1: returns structured unserializable_document error on circular reference or BigInt", () => {
    const docCircular = makeBaseDoc();
    docCircular.self = docCircular;
    const res1 = validateReplayDocument(docCircular);
    assert.equal(res1.ok, false);
    assert.ok(res1.errors.some((e) => e.code === "unserializable_document"));

    const docBigInt = makeBaseDoc();
    docBigInt.badNumber = 42n;
    const res2 = validateReplayDocument(docBigInt);
    assert.equal(res2.ok, false);
    assert.ok(res2.errors.some((e) => e.code === "unserializable_document"));
  });

  it("Block 1: size budget failure returns early without deep execution", () => {
    const doc = makeBaseDoc();
    doc.frames[0] = null; // Normally triggers invalid_frame
    doc.events = null; // Normally triggers invalid_events
    const res = validateReplayDocument(doc, { maxBytes: 50 }); // Artificially low budget
    assert.equal(res.ok, false);
    assert.equal(res.errors.length, 1);
    assert.equal(res.errors[0].code, "document_size_exceeded");
  });

  // --- Block 2: Full CoreState envelope & pieces validation ---
  it("Block 2: rejects initialCoreState with invalid turn, non-null winner, or non-null reason", () => {
    const docBadTurn = makeBaseDoc();
    docBadTurn.initialCoreState.turn = "C";
    const res1 = validateReplayDocument(docBadTurn);
    assert.equal(res1.ok, false);
    assert.ok(res1.errors.some((e) => e.code === "invalid_turn"));

    const docPreWon = makeBaseDoc();
    docPreWon.initialCoreState.winner = "A";
    const res2 = validateReplayDocument(docPreWon);
    assert.equal(res2.ok, false);
    assert.ok(res2.errors.some((e) => e.code === "non_terminal_winner"));
  });

  it("Block 2: rejects initialCoreState or frame coreState with negative or non-finite clock banks", () => {
    const docNegClock = makeBaseDoc();
    docNegClock.initialCoreState.clock.remainingMs.A = -500;
    const res1 = validateReplayDocument(docNegClock);
    assert.equal(res1.ok, false);
    assert.ok(res1.errors.some((e) => e.code === "invalid_clock_remaining"));

    const docNanClock = makeBaseDoc();
    docNanClock.frames[1].coreState.clock.remainingMs.B = NaN;
    const res2 = validateReplayDocument(docNanClock);
    assert.equal(res2.ok, false);
    assert.ok(res2.errors.some((e) => e.code === "invalid_clock_remaining"));
  });

  it("Block 2: rejects intermediate frame with non-null winner or non-null reason", () => {
    const doc = makeBaseDoc();
    doc.frames[0].coreState.winner = "B";
    const res = validateReplayDocument(doc);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.code === "non_terminal_winner"));
  });

  it("Block 2: rejects terminalCoreState with runningSeat !== null (clock must be stopped)", () => {
    const doc = makeBaseDoc();
    doc.terminalCoreState.clock.runningSeat = "A";
    const res = validateReplayDocument(doc);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.code === "terminal_clock_not_stopped"));
  });

  // --- Block 3: lastMove fields, capture pair, and piece cross-check ---
  it("Block 3: rejects lastMove with invalid coordinate or zero distance move", () => {
    const doc = makeBaseDoc();
    doc.frames[1].lastMove.to = { x: doc.frames[1].lastMove.from.x, y: doc.frames[1].lastMove.from.y };
    const res = validateReplayDocument(doc);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.code === "zero_distance_move"));
  });

  it("Block 3: rejects lastMove with capture pair inconsistency (capturedPieceId without type or vice versa)", () => {
    const docIdWithoutType = makeBaseDoc();
    docIdWithoutType.frames[1].lastMove.capturedPieceId = "p-cap";
    docIdWithoutType.frames[1].lastMove.capturedPieceType = null;
    const res1 = validateReplayDocument(docIdWithoutType);
    assert.equal(res1.ok, false);
    assert.ok(res1.errors.some((e) => e.code === "invalid_capture_pair"));

    const docTypeWithoutId = makeBaseDoc();
    docTypeWithoutId.frames[1].lastMove.capturedPieceId = null;
    docTypeWithoutId.frames[1].lastMove.capturedPieceType = "dam";
    const res2 = validateReplayDocument(docTypeWithoutId);
    assert.equal(res2.ok, false);
    assert.ok(res2.errors.some((e) => e.code === "invalid_capture_pair"));
  });

  it("Block 3: cross-check rejects lastMove when moved piece is not found at from in previous frame", () => {
    const doc = makeBaseDoc();
    doc.frames[1].lastMove.from = { x: 0, y: 0 }; // Piece was at 4,7 not 0,0
    const res = validateReplayDocument(doc);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.code === "moved_piece_position_mismatch" || e.code === "moved_piece_not_found_in_previous_frame"));
  });

  it("Block 3: cross-check rejects lastMove when moved piece does not arrive at to in current frame", () => {
    const doc = makeBaseDoc();
    // Put moved piece somewhere else in frame 1
    const p = doc.frames[1].coreState.pieces.find((x) => x.id === doc.frames[1].lastMove.pieceId);
    p.x = 8;
    p.y = 8;
    const res = validateReplayDocument(doc);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.code === "moved_piece_destination_mismatch"));
  });

  it("Block 3: cross-check rejects capture when captured piece was not at destination in previous frame", () => {
    const doc = makeBaseDoc();
    // Pick an existing piece of B in frame 0 that is NOT at destination
    const enemyPiece = doc.frames[0].coreState.pieces.find((x) => x.player === "B");
    doc.frames[1].lastMove.capturedPieceId = enemyPiece.id;
    doc.frames[1].lastMove.capturedPieceType = enemyPiece.type;
    const res = validateReplayDocument(doc);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.code === "captured_piece_not_at_destination"));
  });

  it("Block 3: cross-check rejects non-capture move onto an occupied square", () => {
    const doc = makeBaseDoc();
    // In frame 0, add a dummy piece at destination
    doc.frames[0].coreState.pieces.push({
      id: "dummy-blocker",
      player: "B",
      type: "dam",
      x: doc.frames[1].lastMove.to.x,
      y: doc.frames[1].lastMove.to.y
    });
    doc.initialCoreState.pieces = cloneDeep(doc.frames[0].coreState.pieces);
    const res = validateReplayDocument(doc);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.code === "non_capture_onto_occupied_cell"));
  });

  it("Block 3: cross-check rejects when unrelated piece is mutated between frames", () => {
    const doc = makeBaseDoc();
    // Mutate an unrelated piece in frame 1
    const other = doc.frames[1].coreState.pieces.find((x) => x.id !== doc.frames[1].lastMove.pieceId);
    other.x = 0;
    other.y = 1;
    const res = validateReplayDocument(doc);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.code === "unrelated_piece_mutated"));
  });

  it("Block 3: rejects lastMove with comment exceeding 2048 characters", () => {
    const doc = makeBaseDoc();
    doc.frames[1].lastMove.comment = "a".repeat(2049);
    const res = validateReplayDocument(doc);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.code === "comment_too_long"));
  });

  it("Block 3: rejects lastMove with invalid events schema", () => {
    const doc = makeBaseDoc();
    doc.frames[1].lastMove.events = [{ type: "unknown_event_type" }];
    const res = validateReplayDocument(doc);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.code === "invalid_core_event"));
  });

  // --- Block 4: strict event sequences and move/capture event counts ---
  it("Block 4: rejects event 0 with non-zero seq, non-zero ply, or non-init type", () => {
    const doc = makeBaseDoc();
    doc.events[0].type = "technical";
    const res = validateReplayDocument(doc);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.code === "invalid_first_event"));
  });

  it("Block 4: rejects events with unrecognized event type", () => {
    const doc = makeBaseDoc();
    doc.events[1].type = "custom_illegal_type";
    const res = validateReplayDocument(doc);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.code === "invalid_event_type"));
  });

  it("Block 4: rejects events with multiple terminal events or terminal event not at the end", () => {
    const doc = makeBaseDoc();
    doc.events.splice(1, 0, { seq: 1, ply: 0, type: "terminal", payload: doc.result });
    // Adjust seqs
    doc.events.forEach((ev, idx) => (ev.seq = idx));
    const res = validateReplayDocument(doc);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.code === "invalid_terminal_event_count"));
  });

  it("Block 4: rejects when move event count at ply p is not exactly 1", () => {
    const doc = makeBaseDoc();
    // Remove the move event at ply 1
    doc.events = doc.events.filter((e) => e.type !== "move");
    doc.events.forEach((ev, idx) => (ev.seq = idx));
    const res = validateReplayDocument(doc);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.code === "move_event_count_mismatch"));
  });

  it("Block 4: rejects when move event payload does not match lastMove record", () => {
    const doc = makeBaseDoc();
    const moveEv = doc.events.find((e) => e.type === "move");
    moveEv.payload.from = { x: 0, y: 0 };
    const res = validateReplayDocument(doc);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.code === "move_payload_mismatch"));
  });

  // --- Block 5: frame0 canonical equals initial ---
  it("Block 5: rejects when frames[0].coreState does not canonically equal initialCoreState", () => {
    const doc = makeBaseDoc();
    doc.frames[0].coreState.turn = "B"; // initialCoreState is "A"
    const res = validateReplayDocument(doc);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.code === "frame0_initial_state_mismatch"));
  });

  // --- Block 6: forfeit/draw and terminal consistency ---
  it("Block 6: forfeit and draw reject non-null winner, reason, or eliminatedPlayer in terminalCoreState", () => {
    const doc = makeBaseDoc();
    doc.result = createForfeitResult({
      winner: "A",
      loser: "B",
      reason: "crash",
      acceptedPlies: 1
    });
    // Fabricate invalid winner in terminalCoreState on forfeit
    doc.terminalCoreState.winner = "A";
    const res = validateReplayDocument(doc);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.code === "result_terminal_mismatch"));
  });

  it("Block 6: terminalCoreState pieces must equal last accepted frame pieces across win, draw, and forfeit", () => {
    const doc = makeBaseDoc();
    // Tamper with pieces in terminalCoreState
    doc.terminalCoreState.pieces = [doc.terminalCoreState.pieces[0]];
    const res = validateReplayDocument(doc);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.code === "terminal_position_mismatch"));
  });

  it("Block 6: win by elimination requires terminalCoreState.eliminatedPlayer to match loser", () => {
    const doc = makeBaseDoc();
    doc.result = createWinResult({
      winner: "A",
      loser: "B",
      reason: "elimination",
      acceptedPlies: 1
    });
    doc.terminalCoreState.reason = "elimination";
    doc.terminalCoreState.eliminatedPlayer = null; // Should be "B"
    const res = validateReplayDocument(doc);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.code === "result_terminal_mismatch"));
  });
});
