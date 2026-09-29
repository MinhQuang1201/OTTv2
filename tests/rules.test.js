const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const rules = require("../packages/game-core/src/rules");
const config = require("../packages/game-core/src/config");

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
  it("uses the canonical ten-piece setup and mirrored B setup", () => {
    const state = rules.createInitialState();
    assert.deepEqual(config.GOAL, { A: { x: 0, y: 0 }, B: { x: 8, y: 8 } });
    const a = state.pieces.filter((p) => p.player === "A");
    assert.equal(a.length, 10);
    assert.deepEqual(rules.countByType(state, "A"), { dam: 3, la: 4, keo: 3 });
    assert.deepEqual(rules.countByType(state, "B"), { dam: 3, la: 4, keo: 3 });
    assert.deepEqual(
      a.map((p) => [p.type, rules.formatSquare(p)]),
      [
        ["la", "e8"], ["dam", "f8"], ["keo", "e7"],
        ["la", "f7"], ["dam", "g7"], ["keo", "f6"],
        ["la", "g6"], ["dam", "h6"], ["keo", "g5"], ["la", "h5"]
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
  it("uses E8 to D7 as the canonical opening and rejects E8 to E6", () => {
    const state = rules.createInitialState();
    const opening = move(state, "A", "e8", "d7");
    assert.equal(opening.ok, true);
    assert.equal(pieceAt(opening.state, "d7", "A").type, "la");
    const tooFar = move(state, "A", "e8", "e6");
    assert.equal(tooFar.ok, false);
  });

  it("allows all eight adjacent directions from the center", () => {
    const state = rules.createEmptyState();
    state.pieces = [{ id: "A-dam-0", player: "A", type: "dam", x: 4, y: 4 }];
    assert.equal(rules.getLegalMoves(state, "A-dam-0").length, 8);
  });

  it("rejects off-board, fractional, out-of-turn, and friendly destinations", () => {
    const state = rules.createInitialState();
    assert.equal(rules.applyMove(state, "A", sq("e8"), { x: -1, y: 7 }).ok, false);
    assert.equal(rules.applyMove(state, "A", sq("e8"), { x: 4, y: 6.5 }).ok, false);
    assert.equal(move(state, "B", "e2", "e3").ok, false);
    assert.equal(move(state, "A", "e8", "f8").ok, false);
  });

  it("rejects a move into an opposing piece that beats the mover", () => {
    const state = rules.createEmptyState();
    state.turn = "A";
    state.pieces = [
      { id: "A-la-0", player: "A", type: "la", x: 4, y: 4 },
      { id: "B-keo-0", player: "B", type: "keo", x: 5, y: 4 }
    ];
    const before = JSON.stringify(state);

    assert.equal(rules.getLegalMoves(state, "A-la-0").some((move) => move.x === 5 && move.y === 4), false);
    const result = rules.applyMove(state, "A", { x: 4, y: 4 }, { x: 5, y: 4 });
    assert.equal(result.ok, false);
    assert.equal(result.state, null);
    assert.deepEqual(result.events, []);
    assert.equal(JSON.stringify(state), before);
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

  it("captures with a winning attack and rejects a losing attack", () => {
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

    const losingState = rules.createEmptyState();
    losingState.turn = "A";
    losingState.pieces = [
      { id: "A-dam-0", player: "A", type: "dam", x: 4, y: 4 },
      { id: "B-la-0", player: "B", type: "la", x: 5, y: 4 }
    ];
    const before = JSON.stringify(losingState);
    const losing = rules.applyMove(losingState, "A", { x: 4, y: 4 }, { x: 5, y: 4 });
    assert.equal(losing.ok, false);
    assert.equal(losing.state, null);
    assert.deepEqual(losing.events, []);
    assert.equal(JSON.stringify(losingState), before);
  });
});

describe("victory ordering and no moves", () => {
  it("checks goal before elimination when one move satisfies both", () => {
    const state = rules.createEmptyState();
    state.turn = "A";
    state.pieces = [
      { id: "A-dam-0", player: "A", type: "dam", x: 0, y: 1 },
      { id: "B-keo-0", player: "B", type: "keo", x: 0, y: 0 }
    ];
    const result = rules.applyMove(state, "A", { x: 0, y: 1 }, { x: 0, y: 0 });
    assert.equal(result.state.winner, "A");
    assert.equal(result.state.reason, "goal");
  });

  it("awards the blue player when a piece reaches I9", () => {
    const state = rules.createEmptyState();
    state.turn = "B";
    state.pieces = [
      { id: "B-dam-0", player: "B", type: "dam", x: 8, y: 7 },
      { id: "A-keo-0", player: "A", type: "keo", x: 4, y: 4 }
    ];
    const result = rules.applyMove(state, "B", { x: 8, y: 7 }, { x: 8, y: 8 });
    assert.equal(result.state.winner, "B");
    assert.equal(result.state.reason, "goal");
  });

  it("does not eliminate the last attacker through a losing attack", () => {
    const state = rules.createEmptyState();
    state.turn = "A";
    state.pieces = [
      { id: "A-dam-0", player: "A", type: "dam", x: 4, y: 4 },
      { id: "B-la-0", player: "B", type: "la", x: 5, y: 4 }
    ];
    const before = JSON.stringify(state);
    const result = rules.applyMove(state, "A", { x: 4, y: 4 }, { x: 5, y: 4 });
    assert.equal(result.ok, false);
    assert.equal(result.state, null);
    assert.deepEqual(result.events, []);
    assert.equal(JSON.stringify(state), before);
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
