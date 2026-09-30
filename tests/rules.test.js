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

  it("does not allow Player B a first move into its own goal", () => {
    const state = rules.createInitialState();
    state.turn = "B";
    for (const piece of state.pieces.filter((p) => p.player === "B")) {
      const ownGoal = config.GOAL.B;
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

  it("can execute moves in all 8 directions from the center", () => {
    const directions = [
      [-1, -1], [0, -1], [1, -1],
      [-1, 0],           [1, 0],
      [-1, 1],  [0, 1],  [1, 1]
    ];
    for (const [dx, dy] of directions) {
      const state = rules.createEmptyState();
      state.turn = "A";
      state.pieces = [{ id: "A-dam-0", player: "A", type: "dam", x: 4, y: 4 }];
      const result = rules.applyMove(state, "A", { x: 4, y: 4 }, { x: 4 + dx, y: 4 + dy });
      assert.equal(result.ok, true);
      assert.equal(result.state.pieces[0].x, 4 + dx);
      assert.equal(result.state.pieces[0].y, 4 + dy);
      assert.equal(result.events[0].type, "move");
    }
  });

  it("rejects off-board, fractional, out-of-turn, and friendly destinations", () => {
    const state = rules.createInitialState();
    assert.equal(rules.applyMove(state, "A", sq("e8"), { x: -1, y: 7 }).ok, false);
    assert.equal(rules.applyMove(state, "A", sq("e8"), { x: 4, y: 6.5 }).ok, false);
    assert.equal(move(state, "B", "e2", "e3").ok, false);
    assert.equal(move(state, "A", "e8", "f8").ok, false);
  });

  it("rejects zero-distance moves and off-board boundaries in all directions", () => {
    const state = rules.createInitialState();
    // Zero-distance move
    assert.equal(rules.applyMove(state, "A", sq("e8"), sq("e8")).ok, false);
    // Destination off-board boundaries: x < 0, y < 0, x >= 9, y >= 9
    assert.equal(rules.applyMove(state, "A", sq("e8"), { x: -1, y: 7 }).ok, false);
    assert.equal(rules.applyMove(state, "A", sq("e8"), { x: 4, y: -1 }).ok, false);
    assert.equal(rules.applyMove(state, "A", sq("e8"), { x: 9, y: 7 }).ok, false);
    assert.equal(rules.applyMove(state, "A", sq("e8"), { x: 4, y: 9 }).ok, false);
    // Origin off-board
    assert.equal(rules.applyMove(state, "A", { x: -1, y: 7 }, sq("e8")).ok, false);
    // Out-of-turn: Player A moving when turn is B
    const stateB = rules.cloneState(state);
    stateB.turn = "B";
    assert.equal(move(stateB, "A", "e8", "d7").ok, false);
    // Invalid player seat
    assert.equal(rules.applyMove(state, "C", sq("e8"), sq("d7")).ok, false);
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

  it("verifies the Rock-Paper-Scissors combat cycle: Dam beats Keo, Keo beats La, La beats Dam", () => {
    const matchups = [
      { mover: "dam", target: "keo" },
      { mover: "keo", target: "la" },
      { mover: "la", target: "dam" }
    ];
    for (const { mover, target } of matchups) {
      const state = rules.createEmptyState();
      state.turn = "A";
      state.pieces = [
        { id: `A-${mover}-0`, player: "A", type: mover, x: 4, y: 4 },
        { id: `B-${target}-0`, player: "B", type: target, x: 5, y: 4 },
        { id: "B-other-0", player: "B", type: mover, x: 8, y: 8 }
      ];
      assert.equal(
        rules.getLegalMoves(state, `A-${mover}-0`).some((m) => m.x === 5 && m.y === 4),
        true
      );
      const res = rules.applyMove(state, "A", { x: 4, y: 4 }, { x: 5, y: 4 });
      assert.equal(res.ok, true);
      assert.equal(res.events[0].type, "capture");
      assert.equal(res.events[0].capturedId, `B-${target}-0`);
      assert.equal(res.events[0].capturedType, target);
      assert.equal(res.state.pieces.some((p) => p.id === `B-${target}-0`), false);
      assert.equal(pieceAt(res.state, "f5", "A").type, mover);
      assertSingleOccupancy(res.state);
    }
  });

  it("rejects moving into friendly pieces of both same and different types", () => {
    const state = rules.createEmptyState();
    state.turn = "A";
    state.pieces = [
      { id: "A-dam-0", player: "A", type: "dam", x: 4, y: 4 },
      { id: "A-dam-1", player: "A", type: "dam", x: 5, y: 4 },
      { id: "A-la-0", player: "A", type: "la", x: 4, y: 5 }
    ];
    const legal = rules.getLegalMoves(state, "A-dam-0");
    assert.equal(legal.some((m) => m.x === 5 && m.y === 4), false);
    assert.equal(legal.some((m) => m.x === 4 && m.y === 5), false);
    assert.equal(rules.applyMove(state, "A", { x: 4, y: 4 }, { x: 5, y: 4 }).ok, false);
    assert.equal(rules.applyMove(state, "A", { x: 4, y: 4 }, { x: 4, y: 5 }).ok, false);
  });

  it("rejects draw moves into opposing piece of same type for all three types", () => {
    for (const type of ["dam", "la", "keo"]) {
      const state = rules.createEmptyState();
      state.turn = "A";
      state.pieces = [
        { id: `A-${type}-0`, player: "A", type, x: 4, y: 4 },
        { id: `B-${type}-0`, player: "B", type, x: 5, y: 4 }
      ];
      const before = JSON.stringify(state);
      assert.equal(
        rules.getLegalMoves(state, `A-${type}-0`).some((m) => m.x === 5 && m.y === 4),
        false
      );
      const res = rules.applyMove(state, "A", { x: 4, y: 4 }, { x: 5, y: 4 });
      assert.equal(res.ok, false);
      assert.equal(res.state, null);
      assert.deepEqual(res.events, []);
      assert.equal(JSON.stringify(state), before);
    }
  });

  it("rejects losing moves into opposing piece that beats mover for all three interactions", () => {
    const losingMatchups = [
      { mover: "dam", enemy: "la" },
      { mover: "keo", enemy: "dam" },
      { mover: "la", enemy: "keo" }
    ];
    for (const { mover, enemy } of losingMatchups) {
      const state = rules.createEmptyState();
      state.turn = "A";
      state.pieces = [
        { id: `A-${mover}-0`, player: "A", type: mover, x: 4, y: 4 },
        { id: `B-${enemy}-0`, player: "B", type: enemy, x: 5, y: 4 }
      ];
      const before = JSON.stringify(state);
      assert.equal(
        rules.getLegalMoves(state, `A-${mover}-0`).some((m) => m.x === 5 && m.y === 4),
        false
      );
      const res = rules.applyMove(state, "A", { x: 4, y: 4 }, { x: 5, y: 4 });
      assert.equal(res.ok, false);
      assert.equal(res.state, null);
      assert.deepEqual(res.events, []);
      assert.equal(JSON.stringify(state), before);
    }
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

  it("does not trigger victory when moving into or standing in the enemy goal", () => {
    // Player A moves to i9 (B's goal) - does NOT win
    const stateA = rules.createEmptyState();
    stateA.turn = "A";
    stateA.pieces = [
      { id: "A-dam-0", player: "A", type: "dam", x: 8, y: 7 },
      { id: "B-la-0", player: "B", type: "la", x: 4, y: 4 }
    ];
    const resA = rules.applyMove(stateA, "A", { x: 8, y: 7 }, { x: 8, y: 8 });
    assert.equal(resA.ok, true);
    assert.equal(resA.state.winner, null);
    assert.equal(resA.state.reason, null);
    assert.equal(resA.state.turn, "B");

    // Player B moves to a1 (A's goal) - does NOT win
    const stateB = rules.createEmptyState();
    stateB.turn = "B";
    stateB.pieces = [
      { id: "A-la-0", player: "A", type: "la", x: 4, y: 4 },
      { id: "B-dam-0", player: "B", type: "dam", x: 0, y: 1 }
    ];
    const resB = rules.applyMove(stateB, "B", { x: 0, y: 1 }, { x: 0, y: 0 });
    assert.equal(resB.ok, true);
    assert.equal(resB.state.winner, null);
    assert.equal(resB.state.reason, null);
    assert.equal(resB.state.turn, "A");
  });

  it("awards extinction victory when eliminating all ten opponent pieces", () => {
    // Player A captures the 10th (last) piece of Player B
    const state = rules.createInitialState();
    state.pieces = state.pieces.filter((p) => p.player === "A");
    state.pieces.push({ id: "B-keo-0", player: "B", type: "keo", x: 7, y: 6 });
    const aDam = state.pieces.find((p) => p.player === "A" && p.type === "dam" && p.x === 6 && p.y === 6);
    assert.ok(aDam);
    const result = rules.applyMove(state, "A", { x: 6, y: 6 }, { x: 7, y: 6 });
    assert.equal(result.ok, true);
    assert.equal(result.state.winner, "A");
    assert.equal(result.state.reason, "elimination");
    assert.equal(result.state.eliminatedPlayer, "B");
    assert.equal(result.state.pieces.filter((p) => p.player === "B").length, 0);
    assert.equal(result.state.clock.runningSeat, null);
    assert.equal(result.events.at(-1).type, "win");
    assert.equal(result.events.at(-1).reason, "elimination");
    assert.equal(result.events.at(-1).eliminatedPlayer, "B");

    // Player B captures A's sole remaining piece
    const stateForB = rules.createEmptyState();
    stateForB.turn = "B";
    stateForB.pieces = [
      { id: "A-la-0", player: "A", type: "la", x: 4, y: 4 },
      { id: "B-keo-0", player: "B", type: "keo", x: 5, y: 4 }
    ];
    const resultB = rules.applyMove(stateForB, "B", { x: 5, y: 4 }, { x: 4, y: 4 });
    assert.equal(resultB.ok, true);
    assert.equal(resultB.state.winner, "B");
    assert.equal(resultB.state.reason, "elimination");
    assert.equal(resultB.state.eliminatedPlayer, "A");
    assert.equal(resultB.state.pieces.filter((p) => p.player === "A").length, 0);
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

  it("rejects invalid elapsedMs values", () => {
    const state = rules.createInitialState();
    assert.equal(rules.elapseClock(state, -100).ok, false);
    assert.equal(rules.elapseClock(state, 1.5).ok, false);
    assert.equal(rules.elapseClock(null, 100).ok, false);
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
