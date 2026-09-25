const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const rules = require("../rules");
const config = require("../config");

function sq(name) {
  return rules.parseSquare(name);
}

function move(state, player, from, to) {
  return rules.applyMove(state, player, sq(from), sq(to));
}

function pieceAt(state, name, player) {
  const { x, y } = sq(name);
  return state.pieces.find((p) => p.x === x && p.y === y && (!player || p.player === player));
}

function assertSingleOccupancy(state) {
  const occupied = new Set();
  for (const piece of state.pieces) {
    const key = piece.x + "," + piece.y;
    assert.equal(occupied.has(key), false, "duplicate occupancy at " + key);
    occupied.add(key);
  }
}

describe("setup", () => {
  it("uses the canonical Rule.md A3:C5 setup and mirrored B setup", () => {
    const state = rules.createInitialState();
    const a = state.pieces.filter((p) => p.player === "A");
    assert.deepEqual(
      a.map((p) => [p.type, rules.formatSquare(p)]),
      [
        ["la", "a3"], ["dam", "b3"], ["keo", "c3"],
        ["dam", "a4"], ["keo", "b4"], ["la", "c4"],
        ["keo", "a5"], ["la", "b5"], ["dam", "c5"]
      ]
    );
    for (const p of a) {
      const mirror = state.pieces.find(
        (q) => q.player === "B" && q.x === config.SIZE - 1 - p.x && q.y === config.SIZE - 1 - p.y
      );
      assert.ok(mirror);
      assert.equal(mirror.type, p.type);
    }
    assert.equal(rules.piecesAt(state, ...Object.values(config.GOAL.A)).length, 0);
    assert.equal(rules.piecesAt(state, ...Object.values(config.GOAL.B)).length, 0);
    assertSingleOccupancy(state);
  });

  it("starts A first and does not allow a first move into its own goal", () => {
    const state = rules.createInitialState();
    assert.equal(state.turn, "A");
    for (const piece of state.pieces) {
      const ownGoal = config.GOAL[piece.player];
      assert.equal(
        rules.getLegalMoves(state, piece.id).some((m) => m.x === ownGoal.x && m.y === ownGoal.y),
        false
      );
    }
  });
});

describe("movement", () => {
  it("uses C3 to D2 as the canonical opening and rejects C3 to C1", () => {
    const state = rules.createInitialState();
    const opening = move(state, "A", "c3", "d2");
    assert.equal(opening.ok, true);
    assert.equal(pieceAt(opening.state, "d2", "A").type, "keo");
    const tooFar = move(state, "A", "c3", "c1");
    assert.equal(tooFar.ok, false);
  });

  it("allows all eight adjacent directions from the center", () => {
    const state = rules.createEmptyState();
    state.pieces = [{ id: "A-dam-0", player: "A", type: "dam", x: 4, y: 4 }];
    assert.equal(rules.getLegalMoves(state, "A-dam-0").length, 8);
  });

  it("rejects off-board, fractional, out-of-turn, and friendly destinations", () => {
    const state = rules.createInitialState();
    assert.equal(rules.applyMove(state, "A", sq("a3"), { x: -1, y: 2 }).ok, false);
    assert.equal(rules.applyMove(state, "A", sq("a3"), { x: 0, y: 1.5 }).ok, false);
    assert.equal(move(state, "B", "g7", "g6").ok, false);
    assert.equal(move(state, "A", "a3", "b3").ok, false);
  });
});

describe("combat and occupancy", () => {
  it("rejects an opposing same-type destination without mutation or stack event", () => {
    const state = rules.createEmptyState();
    state.turn = "A";
    state.pieces = [
      { id: "A-dam-0", player: "A", type: "dam", x: 4, y: 4 },
      { id: "B-dam-0", player: "B", type: "dam", x: 5, y: 4 }
    ];
    const before = JSON.stringify(state);
    assert.equal(rules.getLegalMoves(state, "A-dam-0").some((m) => m.x === 5 && m.y === 4), false);
    const result = rules.applyMove(state, "A", { x: 4, y: 4 }, { x: 5, y: 4 });
    assert.equal(result.ok, false);
    assert.equal(result.state, null);
    assert.deepEqual(result.events, []);
    assert.equal(JSON.stringify(state), before);
  });

  it("captures, loses a strike, and preserves single occupancy", () => {
    const captureState = rules.createEmptyState();
    captureState.turn = "A";
    captureState.pieces = [
      { id: "A-dam-0", player: "A", type: "dam", x: 4, y: 4 },
      { id: "B-keo-0", player: "B", type: "keo", x: 5, y: 4 }
    ];
    const capture = rules.applyMove(captureState, "A", { x: 4, y: 4 }, { x: 5, y: 4 });
    assert.equal(capture.ok, true);
    assert.equal(capture.events[0].type, "capture");
    assertSingleOccupancy(capture.state);

    const lossState = rules.createEmptyState();
    lossState.turn = "A";
    lossState.pieces = [
      { id: "A-dam-0", player: "A", type: "dam", x: 4, y: 4 },
      { id: "B-la-0", player: "B", type: "la", x: 5, y: 4 },
      { id: "A-keo-0", player: "A", type: "keo", x: 0, y: 0 }
    ];
    const loss = rules.applyMove(lossState, "A", { x: 4, y: 4 }, { x: 5, y: 4 });
    assert.equal(loss.ok, true);
    assert.equal(loss.events[0].type, "strike_loss");
    assertSingleOccupancy(loss.state);
  });
});

describe("victory ordering and no moves", () => {
  it("checks goal before elimination when one move satisfies both", () => {
    const state = rules.createEmptyState();
    state.turn = "A";
    state.pieces = [
      { id: "A-dam-0", player: "A", type: "dam", x: 0, y: 7 },
      { id: "B-keo-0", player: "B", type: "keo", x: 0, y: 8 }
    ];
    const result = rules.applyMove(state, "A", { x: 0, y: 7 }, { x: 0, y: 8 });
    assert.equal(result.state.winner, "A");
    assert.equal(result.state.reason, "goal");
  });

  it("awards the opponent elimination immediately when the last attacker loses", () => {
    const state = rules.createEmptyState();
    state.turn = "A";
    state.pieces = [
      { id: "A-dam-0", player: "A", type: "dam", x: 4, y: 4 },
      { id: "B-la-0", player: "B", type: "la", x: 5, y: 4 }
    ];
    const result = rules.applyMove(state, "A", { x: 4, y: 4 }, { x: 5, y: 4 });
    assert.equal(result.state.winner, "B");
    assert.equal(result.state.reason, "elimination");
    assert.equal(result.state.eliminatedPlayer, "A");
  });

  it("awards the player who just moved when the next player has no legal move", () => {
    const state = rules.createEmptyState();
    state.turn = "A";
    state.pieces = [
      { id: "A-dam-0", player: "A", type: "dam", x: 4, y: 4 },
      { id: "B-dam-0", player: "B", type: "dam", x: 0, y: 0 },
      { id: "A-dam-1", player: "A", type: "dam", x: 1, y: 0 },
      { id: "A-dam-2", player: "A", type: "dam", x: 0, y: 1 },
      { id: "A-dam-3", player: "A", type: "dam", x: 1, y: 1 }
    ];
    const result = rules.applyMove(state, "A", { x: 4, y: 4 }, { x: 4, y: 3 });
    assert.equal(result.ok, true);
    assert.equal(result.state.winner, "A");
    assert.equal(result.state.reason, "no_moves");
    assert.equal(result.state.turn, "A");
    assert.equal(result.events.at(-1).type, "win");
  });

  it("does not accept moves after goal, elimination, or no-moves terminal state", () => {
    for (const state of [
      Object.assign(rules.createEmptyState(), { winner: "A", reason: "goal" }),
      Object.assign(rules.createEmptyState(), { winner: "B", reason: "elimination" }),
      Object.assign(rules.createEmptyState(), { winner: "A", reason: "no_moves" })
    ]) {
      assert.equal(rules.applyMove(state, "A", { x: 0, y: 0 }, { x: 0, y: 1 }).ok, false);
    }
  });
});

describe("clock", () => {
  it("exposes a deep-copied ten-minute clock and elapses only the running seat", () => {
    const state = rules.createInitialState();
    const copy = rules.publicState(state);
    copy.clock.remainingMs.A = 1;
    assert.equal(state.clock.remainingMs.A, config.TIME_CONTROL.initialMs);
    const result = rules.elapseClock(state, config.TIME_CONTROL.initialMs - 1);
    assert.equal(result.state.clock.remainingMs.A, 1);
    assert.equal(result.state.clock.remainingMs.B, config.TIME_CONTROL.initialMs);
    assert.equal(result.state.winner, null);
    assert.equal(state.clock.remainingMs.A, config.TIME_CONTROL.initialMs);
  });

  it("times out at zero and pauses terminal/no-moves clocks", () => {
    const state = rules.createInitialState();
    const timeout = rules.elapseClock(state, config.TIME_CONTROL.initialMs);
    assert.equal(timeout.state.clock.remainingMs.A, 0);
    assert.equal(timeout.state.winner, "B");
    assert.equal(timeout.state.reason, "timeout");
    assert.equal(timeout.events.at(-1).type, "win");

    const terminal = rules.elapseClock(timeout.state, 1000);
    assert.deepEqual(terminal.state.clock, timeout.state.clock);

    const noMoves = rules.createEmptyState();
    noMoves.winner = "A";
    noMoves.reason = "no_moves";
    noMoves.clock.runningSeat = null;
    assert.deepEqual(rules.elapseClock(noMoves, 1000).state.clock, noMoves.clock);
  });
});

describe("algebraic", () => {
  it("round-trips squares on a 9x9 board", () => {
    assert.deepEqual(rules.parseSquare("a1"), { x: 0, y: 0 });
    assert.deepEqual(rules.parseSquare("i9"), { x: 8, y: 8 });
    assert.equal(rules.formatSquare({ x: 4, y: 4 }), "e5");
    assert.equal(config.SIZE, 9);
  });
});
