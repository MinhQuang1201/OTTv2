/**
 * Arena Versioned Map Registry Tests.
 * Tests listMaps, getMap, createMapState, validateMapState, validateMapSetup,
 * 180° rotational symmetry, type inventory, own-goal exclusion, one-step goal safety,
 * and integration with real game-core rules and replay journal.
 */

"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const rules = require("../packages/game-core/src/rules.js");
const config = require("../packages/game-core/src/config.js");

let listMaps;
let getMap;
let createMapState;
let validateMapState;
let validateMapSetup;
let MAP_DEFINITIONS;
let CLASSIC_SETUP_A;
let FLANKS_SETUP_A;
let CENTER_SETUP_A;

let createReplayJournal;
let validateReplayDocument;
let createWinResult;
let createCurrentRulesetSnapshot;
let computeRulesetHash;
let DEFAULT_MATCH_POLICY;

before(async () => {
  const mapsMod = await import("../packages/arena/src/domain/maps/index.mjs");
  listMaps = mapsMod.listMaps;
  getMap = mapsMod.getMap;
  createMapState = mapsMod.createMapState;
  validateMapState = mapsMod.validateMapState;
  validateMapSetup = mapsMod.validateMapSetup;
  MAP_DEFINITIONS = mapsMod.MAP_DEFINITIONS;
  CLASSIC_SETUP_A = mapsMod.CLASSIC_SETUP_A;
  FLANKS_SETUP_A = mapsMod.FLANKS_SETUP_A;
  CENTER_SETUP_A = mapsMod.CENTER_SETUP_A;

  const journalMod = await import("../packages/arena/src/application/replay-journal.mjs");
  const contractsMod = await import("../packages/arena/src/contracts/index.mjs");
  const identityMod = await import("../packages/arena-node/src/core/ruleset-identity.mjs");

  createReplayJournal = journalMod.createReplayJournal;
  validateReplayDocument = contractsMod.validateReplayDocument;
  createWinResult = contractsMod.createWinResult;
  createCurrentRulesetSnapshot = contractsMod.createCurrentRulesetSnapshot;
  computeRulesetHash = identityMod.computeRulesetHash;
  DEFAULT_MATCH_POLICY = contractsMod.DEFAULT_MATCH_POLICY;
});

describe("Map Registry Descriptors & Discovery", () => {
  it("listMaps returns descriptors for exactly 3 versioned maps: classic, flanks, center", () => {
    const maps = listMaps();
    assert.equal(maps.length, 3);

    const ids = maps.map((m) => m.id);
    assert.deepEqual(ids, ["classic", "flanks", "center"]);

    for (const m of maps) {
      assert.equal(typeof m.id, "string");
      assert.equal(m.revision, 1);
      assert.equal(typeof m.name, "string");
      assert.ok(m.name.length > 0);
      assert.equal(typeof m.description, "string");
      assert.ok(m.description.length > 0);
      // By default, initialState is not included
      assert.equal(m.initialState, undefined);
    }
  });

  it("listMaps with includeState embeds a fresh cloned initialState", () => {
    const maps = listMaps({ includeState: true });
    assert.equal(maps.length, 3);
    for (const m of maps) {
      assert.ok(m.initialState);
      assert.equal(m.initialState.turn, "A");
      assert.equal(m.initialState.pieces.length, 20);
    }
  });

  it("getMap retrieves specific map by id and returns null for unknown map", () => {
    const classic = getMap("classic");
    assert.ok(classic);
    assert.equal(classic.id, "classic");
    assert.equal(classic.revision, 1);
    assert.equal(classic.name, "Classic");

    const flanks = getMap("flanks");
    assert.ok(flanks);
    assert.equal(flanks.id, "flanks");
    assert.equal(flanks.revision, 1);

    const center = getMap("center");
    assert.ok(center);
    assert.equal(center.id, "center");
    assert.equal(center.revision, 1);

    assert.equal(getMap("unknown-map"), null);
    assert.equal(getMap(null), null);
    assert.equal(getMap(123), null);
  });

  it("getMap with includeState returns descriptor with cloned initialState", () => {
    const desc = getMap("flanks", { includeState: true });
    assert.ok(desc.initialState);
    assert.equal(desc.initialState.turn, "A");
    assert.equal(desc.initialState.pieces.length, 20);
  });
});

describe("State Factory & Immutability", () => {
  it("createMapState defaults to classic revision 1", () => {
    const state = createMapState();
    assert.equal(state.turn, "A");
    assert.equal(state.winner, null);
    assert.equal(state.reason, null);
    assert.equal(state.eliminatedPlayer, null);
    assert.equal(state.clock.runningSeat, "A");
    assert.equal(state.clock.remainingMs.A, 600000);
    assert.equal(state.clock.remainingMs.B, 600000);
    assert.equal(state.pieces.length, 20);
  });

  it("createMapState produces deep clone: mutations do not leak", () => {
    const state1 = createMapState("center");
    state1.turn = "MUTATED";
    state1.clock.remainingMs.A = 999;
    state1.pieces[0].x = 99;

    const state2 = createMapState("center");
    assert.equal(state2.turn, "A");
    assert.equal(state2.clock.remainingMs.A, 600000);
    assert.notEqual(state2.pieces[0].x, 99);
  });

  it("throws on unknown map id or unsupported revision", () => {
    assert.throws(() => createMapState("unknown-id"), /Unknown map id/);
    assert.throws(() => createMapState("classic", 2), /Unsupported revision 2/);
  });
});

describe("Invariants & Validation across All 3 Maps", () => {
  const mapIds = ["classic", "flanks", "center"];

  for (const mapId of mapIds) {
    describe(`Map variant: '${mapId}'`, () => {
      it("passes validateMapState and validateMapSetup", () => {
        const def = MAP_DEFINITIONS[mapId];
        assert.ok(def);

        const setupVal = validateMapSetup(def.setupA);
        assert.equal(setupVal.ok, true, `setupA validation failed: ${setupVal.errors.join(", ")}`);

        const state = createMapState(mapId);
        const stateVal = validateMapState(state);
        assert.equal(stateVal.ok, true, `state validation failed: ${stateVal.errors.join(", ")}`);
      });

      it("preserves exact 10 pieces per seat with 3-4-3 type inventory", () => {
        const state = createMapState(mapId);
        const piecesA = state.pieces.filter((p) => p.player === "A");
        const piecesB = state.pieces.filter((p) => p.player === "B");

        assert.equal(piecesA.length, 10);
        assert.equal(piecesB.length, 10);

        const countsA = rules.countByType(state, "A");
        const countsB = rules.countByType(state, "B");

        assert.deepEqual(countsA, { dam: 3, la: 4, keo: 3 });
        assert.deepEqual(countsB, { dam: 3, la: 4, keo: 3 });
      });

      it("enforces 180° point-reflection symmetry around center e5 (4, 4)", () => {
        const state = createMapState(mapId);
        const piecesA = state.pieces.filter((p) => p.player === "A");

        for (const pa of piecesA) {
          const expectedBx = 8 - pa.x;
          const expectedBy = 8 - pa.y;
          const mirrorB = state.pieces.find((pb) => pb.player === "B" && pb.x === expectedBx && pb.y === expectedBy);

          assert.ok(mirrorB, `Missing mirror piece B for A at (${pa.x}, ${pa.y}) on map ${mapId}`);
          assert.equal(mirrorB.type, pa.type, `Type mismatch on mirror piece at (${expectedBx}, ${expectedBy})`);
        }
      });

      it("enforces single occupancy (zero duplicate coordinates across all 20 pieces)", () => {
        const state = createMapState(mapId);
        const occupied = new Set();
        for (const p of state.pieces) {
          const key = `${p.x},${p.y}`;
          assert.equal(occupied.has(key), false, `Collision found at ${key} on map ${mapId}`);
          occupied.add(key);
        }
        assert.equal(occupied.size, 20);
      });

      it("enforces goal exclusion and one-step goal safety: no piece starts on or 1 step from own goal", () => {
        const state = createMapState(mapId);

        // Goal A is (0, 0); Goal B is (8, 8)
        assert.equal(rules.piecesAt(state, config.GOAL.A.x, config.GOAL.A.y).length, 0);
        assert.equal(rules.piecesAt(state, config.GOAL.B.x, config.GOAL.B.y).length, 0);

        // No Seat A piece within Chebyshev distance 1 from (0, 0)
        for (const pa of state.pieces.filter((p) => p.player === "A")) {
          const distA = Math.max(Math.abs(pa.x - config.GOAL.A.x), Math.abs(pa.y - config.GOAL.A.y));
          assert.ok(distA > 1, `Seat A piece at (${pa.x}, ${pa.y}) is too close to own goal (0, 0)`);
        }

        // No Seat B piece within Chebyshev distance 1 from (8, 8)
        for (const pb of state.pieces.filter((p) => p.player === "B")) {
          const distB = Math.max(Math.abs(pb.x - config.GOAL.B.x), Math.abs(pb.y - config.GOAL.B.y));
          assert.ok(distB > 1, `Seat B piece at (${pb.x}, ${pb.y}) is too close to own goal (8, 8)`);
        }

        // Real rules verification: neither player can move into own goal on turn 1
        for (const p of state.pieces) {
          const ownGoal = config.GOAL[p.player];
          const legal = rules.getLegalMoves(state, p.id);
          const entersOwnGoal = legal.some((m) => m.x === ownGoal.x && m.y === ownGoal.y);
          assert.equal(entersOwnGoal, false, `Piece ${p.id} can immediately enter own goal on map ${mapId}`);
        }
      });

      it("guarantees both Seat A and Seat B have legal opening moves", () => {
        const state = createMapState(mapId);

        const movesA = rules.allMoves(state, "A");
        assert.ok(movesA.length > 0, `Seat A must have legal moves on map ${mapId}`);

        // Temporarily check Seat B's legal moves
        const stateForB = rules.cloneState(state);
        stateForB.turn = "B";
        const movesB = rules.allMoves(stateForB, "B");
        assert.ok(movesB.length > 0, `Seat B must have legal moves on map ${mapId}`);
      });
    });
  }
});

describe("Classic Parity with core rules.createInitialState", () => {
  it("createMapState('classic') matches rules.createInitialState byte-for-byte", () => {
    const fromMap = createMapState("classic");
    const fromCore = rules.createInitialState();

    assert.equal(fromMap.turn, fromCore.turn);
    assert.equal(fromMap.winner, fromCore.winner);
    assert.equal(fromMap.reason, fromCore.reason);
    assert.equal(fromMap.eliminatedPlayer, fromCore.eliminatedPlayer);
    assert.deepEqual(fromMap.clock, fromCore.clock);
    assert.deepEqual(fromMap.pieces, fromCore.pieces);
  });
});

describe("Negative Setup & State Validator Tests", () => {
  it("rejects setupA with wrong length", () => {
    const invalid = CLASSIC_SETUP_A.slice(0, 9);
    const res = validateMapSetup(invalid);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes("exactly 10 pieces")));
  });

  it("rejects setupA with wrong type counts", () => {
    const invalid = CLASSIC_SETUP_A.map((p, i) => (i === 0 ? { ...p, type: "dam" } : p));
    const res = validateMapSetup(invalid);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes("Type count mismatch")));
  });

  it("rejects setupA with duplicate coordinates", () => {
    const invalid = CLASSIC_SETUP_A.map((p, i) => (i === 1 ? { ...p, x: p.x, y: 7 } : p));
    invalid[1] = { ...invalid[0] };
    const res = validateMapSetup(invalid);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes("duplicate")));
  });

  it("rejects setupA where a piece is within 1 step of own goal (0, 0)", () => {
    const invalid = CLASSIC_SETUP_A.map((p, i) => (i === 0 ? { ...p, x: 1, y: 1 } : p));
    const res = validateMapSetup(invalid);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes("within 1 step of own goal")));
  });

  it("rejects setupA where a piece is directly on own goal (0, 0)", () => {
    const invalid = CLASSIC_SETUP_A.map((p, i) => (i === 0 ? { ...p, x: 0, y: 0 } : p));
    const res = validateMapSetup(invalid);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes("cannot start on own goal")));
  });

  it("rejects state with non-null terminal winner", () => {
    const state = createMapState("flanks");
    state.winner = "A";
    const res = validateMapState(state);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes("terminal")));
  });

  it("rejects state where rotational symmetry is broken", () => {
    const state = createMapState("center");
    // Tamper with one piece of B
    state.pieces.find((p) => p.id === "B-la-0").type = "dam";
    const res = validateMapState(state);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes("Missing 180° rotational symmetric")));
  });
});

describe("Actual Game-Core Execution on Non-Classic Maps", () => {
  it("executes legal moves on 'flanks' map and transitions turn via rules.applyMove", () => {
    const state = createMapState("flanks");
    const legalMoves = rules.allMoves(state, "A");
    assert.ok(legalMoves.length > 0);

    const firstMove = legalMoves[0];
    const result = rules.applyMove(state, "A", firstMove.from, firstMove.to);
    assert.equal(result.ok, true, `applyMove failed: ${result.error}`);
    assert.ok(result.state);
    assert.equal(result.state.turn, "B");
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].type, "move");
    assert.deepEqual(result.events[0].from, firstMove.from);
    assert.deepEqual(result.events[0].to, firstMove.to);
  });

  it("executes legal moves on 'center' map and transitions turn via rules.applyMove", () => {
    const state = createMapState("center");
    const legalMoves = rules.allMoves(state, "A");
    assert.ok(legalMoves.length > 0);

    const firstMove = legalMoves[0];
    const result = rules.applyMove(state, "A", firstMove.from, firstMove.to);
    assert.equal(result.ok, true, `applyMove failed: ${result.error}`);
    assert.equal(result.state.turn, "B");
  });

  it("rejects illegal move on custom map without mutating original state", () => {
    const state = createMapState("flanks");
    const piece = state.pieces.find((p) => p.player === "A");

    // Illegal jump of 2 squares
    const illegalTo = { x: piece.x, y: piece.y - 2 };
    const result = rules.applyMove(state, "A", { x: piece.x, y: piece.y }, illegalTo);
    assert.equal(result.ok, false);
    assert.ok(result.error);
    // Original state unchanged
    assert.equal(state.turn, "A");
  });
});

describe("Replay Hydration & Journal Integration with Custom Maps", () => {
  it("initializes and finalizes a ReplayJournal with 'flanks' map producing valid ReplayDocument", () => {
    const initialState = createMapState("flanks");
    const snapshot = createCurrentRulesetSnapshot(config);
    const rulesetHash = computeRulesetHash(snapshot);

    const journal = createReplayJournal();
    journal.init({
      matchId: "match-flanks-001",
      engineRevision: "sha256:test-engine",
      engineGitRevision: null,
      rulesetId: snapshot.rulesetId,
      rulesetHash,
      rulesetSnapshot: snapshot,
      matchPolicy: DEFAULT_MATCH_POLICY,
      participants: {
        A: { botId: "bot-alpha" },
        B: { botId: "bot-beta" }
      },
      initialCoreState: initialState
    });

    // Apply 1 move
    const legalMoves = rules.allMoves(initialState, "A");
    const m = legalMoves[0];
    const moveRes = rules.applyMove(initialState, "A", m.from, m.to);
    assert.equal(moveRes.ok, true);

    journal.acceptedMove({
      seat: "A",
      pieceId: m.pieceId,
      from: m.from,
      to: m.to,
      capturedPieceId: null,
      capturedPieceType: null,
      elapsedMs: 50,
      remainingMs: 599950,
      events: moveRes.events,
      coreState: moveRes.state
    });

    const winResult = createWinResult({
      winner: "A",
      loser: "B",
      reason: "goal",
      acceptedPlies: 1
    });

    const terminalState = rules.cloneState(moveRes.state);
    terminalState.winner = "A";
    terminalState.reason = "goal";

    const doc = journal.finish(winResult, terminalState);
    assert.ok(doc);
    assert.equal(doc.frames.length, 2);
    assert.equal(doc.frames[0].ply, 0);
    assert.deepEqual(doc.frames[0].coreState.pieces, initialState.pieces);

    // Validate ReplayDocument bounded schema
    const validation = validateReplayDocument(doc);
    assert.equal(validation.ok, true, `validateReplayDocument failed: ${JSON.stringify(validation.errors)}`);
  });

  it("initializes and finalizes a ReplayJournal with 'center' map producing valid ReplayDocument", () => {
    const initialState = createMapState("center");
    const snapshot = createCurrentRulesetSnapshot(config);
    const rulesetHash = computeRulesetHash(snapshot);

    const journal = createReplayJournal();
    journal.init({
      matchId: "match-center-001",
      engineRevision: "sha256:test-engine",
      engineGitRevision: null,
      rulesetId: snapshot.rulesetId,
      rulesetHash,
      rulesetSnapshot: snapshot,
      matchPolicy: DEFAULT_MATCH_POLICY,
      participants: {
        A: { botId: "bot-gamma" },
        B: { botId: "bot-delta" }
      },
      initialCoreState: initialState
    });

    const winResult = createWinResult({
      winner: "A",
      loser: "B",
      reason: "goal",
      acceptedPlies: 0
    });
    const terminalState = rules.cloneState(initialState);
    terminalState.winner = "A";
    terminalState.reason = "goal";

    const doc = journal.finish(winResult, terminalState);
    const validation = validateReplayDocument(doc);
    assert.equal(validation.ok, true, `validateReplayDocument failed: ${JSON.stringify(validation.errors)}`);
  });
});
