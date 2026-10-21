/**
 * Arena test fixtures using REAL game-core engine.
 * All states are produced by running actual core functions.
 * No mocking of engine to verify win conditions.
 *
 * Ruleset: ottv2-g-default-v1
 * Board: 9x9, A goal at (0,0), B goal at (8,8)
 * Combat: dam beats keo, keo beats la, la beats dam
 */

"use strict";

const rules = require("../../../packages/game-core/src/rules.js");
const config = require("../../../packages/game-core/src/config.js");

/**
 * Creates a minimal CoreState with valid clock. Pieces are caller-supplied.
 */
function makeState({
  pieces,
  turn = "A",
  remainingA = 600000,
  remainingB = 600000,
  winner = null,
  reason = null,
  eliminatedPlayer = null
}) {
  return {
    turn: winner ? null : turn,
    winner: winner || null,
    reason: reason || null,
    eliminatedPlayer: eliminatedPlayer || null,
    clock: {
      remainingMs: { A: remainingA, B: remainingB },
      runningSeat: winner ? null : turn
    },
    pieces: pieces.map((p) => ({
      id: p.id,
      player: p.player,
      type: p.type,
      x: p.x,
      y: p.y
    }))
  };
}

/**
 * makeGoalReadyState — one move away from A winning by goal.
 * A has a single "dam" piece adjacent to A's goal at (0,0): piece at (1,0).
 * A plays dam at (1,0) -> (0,0) => A reaches goal => win: goal.
 */
function makeGoalReadyState() {
  const pieces = [
    { id: "A-dam-0", player: "A", type: "dam", x: 1, y: 0 },
    { id: "B-keo-0", player: "B", type: "keo", x: 8, y: 5 }
  ];
  const state = makeState({ pieces, turn: "A" });
  const w = rules.detectWinner(state);
  if (w) throw new Error("Goal-ready fixture: unexpected winner in initial state");
  return state;
}

/**
 * makeEliminationReadyState — one move away from A winning by elimination.
 * B has only one piece left. A has a "la" that beats B's "dam" adjacent.
 */
function makeEliminationReadyState() {
  const pieces = [
    { id: "A-la-0", player: "A", type: "la", x: 4, y: 4 },
    { id: "B-dam-0", player: "B", type: "dam", x: 5, y: 4 }
  ];
  const state = makeState({ pieces, turn: "A" });
  const w = rules.detectWinner(state);
  if (w) throw new Error("Elimination-ready fixture: unexpected winner in initial state");
  return state;
}

/**
 * makeNoMovesReadyState — A's move leaves B with no legal moves.
 * B is cornered at (5,8) with all adjacent cells blocked by same-type or superior pieces.
 * Any move by A leaves B with 0 legal moves => A wins by no_moves.
 */
function makeNoMovesReadyState() {
  const pieces = [
    { id: "B-dam-0", player: "B", type: "dam", x: 5, y: 8 },
    { id: "A-dam-0", player: "A", type: "dam", x: 4, y: 8 },
    { id: "A-la-0",  player: "A", type: "la",  x: 4, y: 7 },
    { id: "A-dam-1", player: "A", type: "dam", x: 5, y: 7 },
    { id: "A-dam-2", player: "A", type: "dam", x: 6, y: 7 },
    { id: "A-la-1",  player: "A", type: "la",  x: 6, y: 8 },
    { id: "A-keo-0", player: "A", type: "keo", x: 0, y: 5 }
  ];
  const state = makeState({ pieces, turn: "A" });
  const w = rules.detectWinner(state);
  if (w) throw new Error("NoMoves-ready fixture: unexpected winner in initial state");
  const bMoves = rules.allMoves(state, "B");
  if (bMoves.length > 0) throw new Error("NoMoves-ready: B still has moves");
  const aMoves = rules.allMoves(state, "A");
  if (aMoves.length === 0) throw new Error("NoMoves-ready: A has no moves");
  return state;
}

/**
 * makeIllegalMoveState — returns initial standard state, an illegal move, and a legal move.
 */
function makeIllegalMoveState() {
  const state = rules.createInitialState();
  return {
    state,
    illegalMove: { from: { x: 4, y: 7 }, to: { x: 4, y: 5 } },
    legalMove: { from: { x: 4, y: 7 }, to: { x: 3, y: 6 } }
  };
}

/**
 * Fixture 1: Ordinary Draw 400
 * Deterministic oscillation of 2 pieces for 400 plies without captures or goal reach.
 */
function makeDraw400Fixture() {
  const initialState = makeState({
    pieces: [
      { id: "A-keo-0", player: "A", type: "keo", x: 0, y: 3 },
      { id: "B-la-0",  player: "B", type: "la",  x: 0, y: 7 }
    ],
    turn: "A"
  });

  const getMoveA = (ply) =>
    Math.floor(ply / 2) % 2 === 0
      ? { from: { x: 0, y: 3 }, to: { x: 0, y: 4 } }
      : { from: { x: 0, y: 4 }, to: { x: 0, y: 3 } };

  const getMoveB = (ply) =>
    Math.floor(ply / 2) % 2 === 1
      ? { from: { x: 0, y: 7 }, to: { x: 0, y: 6 } }
      : { from: { x: 0, y: 6 }, to: { x: 0, y: 7 } };

  return { initialState, getMoveA, getMoveB };
}

/**
 * Fixture 2: Goal Priority at Ply 400
 * 399 oscillating plies, on ply 400 B moves B-dam-1 into B's goal (8,8).
 * Tests terminal precedence: goal wins over cap at move 400.
 */
function makeGoalPriority400Fixture() {
  const initialState = makeState({
    pieces: [
      { id: "A-keo-0", player: "A", type: "keo", x: 0, y: 3 },
      { id: "B-la-0",  player: "B", type: "la",  x: 0, y: 7 },
      { id: "B-dam-1", player: "B", type: "dam", x: 7, y: 8 }
    ],
    turn: "A"
  });

  const getMoveA = (ply) =>
    Math.floor(ply / 2) % 2 === 0
      ? { from: { x: 0, y: 3 }, to: { x: 0, y: 4 } }
      : { from: { x: 0, y: 4 }, to: { x: 0, y: 3 } };

  const getMoveB = (ply) =>
    ply === 400
      ? { from: { x: 7, y: 8 }, to: { x: 8, y: 8 } }
      : Math.floor(ply / 2) % 2 === 1
      ? { from: { x: 0, y: 7 }, to: { x: 0, y: 6 } }
      : { from: { x: 0, y: 6 }, to: { x: 0, y: 7 } };

  return { initialState, getMoveA, getMoveB };
}

/**
 * Fixture 3: Elimination Priority at Ply 400
 * A has only one piece A-keo-0. 399 oscillating plies.
 * On ply 400 B moves B-dam-1 from (1,4) into (0,3), capturing A's last piece.
 * Tests terminal precedence: elimination wins over cap at move 400.
 */
function makeEliminationPriority400Fixture() {
  const initialState = makeState({
    pieces: [
      { id: "A-keo-0", player: "A", type: "keo", x: 0, y: 3 },
      { id: "B-la-0",  player: "B", type: "la",  x: 0, y: 7 },
      { id: "B-dam-1", player: "B", type: "dam", x: 1, y: 4 }
    ],
    turn: "A"
  });

  const getMoveA = (ply) =>
    Math.floor(ply / 2) % 2 === 0
      ? { from: { x: 0, y: 3 }, to: { x: 0, y: 4 } }
      : { from: { x: 0, y: 4 }, to: { x: 0, y: 3 } };

  const getMoveB = (ply) =>
    ply === 400
      ? { from: { x: 1, y: 4 }, to: { x: 0, y: 3 } }
      : Math.floor(ply / 2) % 2 === 1
      ? { from: { x: 0, y: 7 }, to: { x: 0, y: 6 } }
      : { from: { x: 0, y: 6 }, to: { x: 0, y: 7 } };

  return { initialState, getMoveA, getMoveB };
}

/**
 * Fixture 4: No_moves Priority at Ply 400
 * A has only one piece A-dam-0 at (0,8).
 * For 399 plies A bounces between (0,8) and (1,7).
 * On ply 400 B moves B-dam-2 into (1,7), blocking A's only legal move.
 * Tests terminal precedence: no_moves wins over cap at move 400.
 */
function makeNoMovesPriority400Fixture() {
  const initialState = makeState({
    pieces: [
      { id: "A-dam-0", player: "A", type: "dam", x: 0, y: 8 },
      { id: "B-dam-1", player: "B", type: "dam", x: 0, y: 7 },
      { id: "B-la-1",  player: "B", type: "la",  x: 1, y: 8 },
      { id: "B-dam-2", player: "B", type: "dam", x: 1, y: 6 },
      { id: "B-dam-3", player: "B", type: "dam", x: 0, y: 6 },
      { id: "B-dam-4", player: "B", type: "dam", x: 2, y: 6 },
      { id: "B-dam-5", player: "B", type: "dam", x: 2, y: 7 },
      { id: "B-dam-6", player: "B", type: "dam", x: 2, y: 8 },
      { id: "B-la-0",  player: "B", type: "la",  x: 8, y: 0 }
    ],
    turn: "A"
  });

  const getMoveA = (ply) =>
    Math.floor(ply / 2) % 2 === 0
      ? { from: { x: 0, y: 8 }, to: { x: 1, y: 7 } }
      : { from: { x: 1, y: 7 }, to: { x: 0, y: 8 } };

  const getMoveB = (ply) =>
    ply === 400
      ? { from: { x: 1, y: 6 }, to: { x: 1, y: 7 } }
      : Math.floor(ply / 2) % 2 === 1
      ? { from: { x: 8, y: 0 }, to: { x: 8, y: 1 } }
      : { from: { x: 8, y: 1 }, to: { x: 8, y: 0 } };

  return { initialState, getMoveA, getMoveB };
}

/**
 * Fixture 5: Illegal Request at Ply 400 (Accepted 399)
 * 399 plies accepted normally. On request 400 (ply 400), B returns an illegal move.
 * Tests forfeit with acceptedPlies remaining 399.
 */
function makeIllegalRequest400Fixture() {
  const drawFixture = makeDraw400Fixture();

  const getMoveB = (ply) =>
    ply === 400
      ? { from: { x: 0, y: 7 }, to: { x: 0, y: 5 } } // illegal 2-square jump
      : drawFixture.getMoveB(ply);

  return {
    initialState: drawFixture.initialState,
    getMoveA: drawFixture.getMoveA,
    getMoveB
  };
}

module.exports = {
  makeState,
  makeGoalReadyState,
  makeEliminationReadyState,
  makeNoMovesReadyState,
  makeIllegalMoveState,
  makeDraw400Fixture,
  makeGoalPriority400Fixture,
  makeEliminationPriority400Fixture,
  makeNoMovesPriority400Fixture,
  makeIllegalRequest400Fixture
};
