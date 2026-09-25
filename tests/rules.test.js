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
  it("uses three RPS wings reflected across the a1-i9 diagonal", () => {
    const state = rules.createInitialState();
    const a = state.pieces
      .filter((p) => p.player === "A")
      .map((p) => `${rules.formatSquare(p)}:${p.type}`)
      .sort();
    const expected = [
      "d1:dam",
      "e1:keo",
      "e2:la",
      "f2:la",
      "g2:dam",
      "g3:keo",
      "h4:keo",
      "i4:la",
      "i5:dam"
    ].sort();
    assert.deepEqual(a, expected);
    assert.equal(state.pieces.length, 18);
    assert.equal(state.turn, "A");
    assert.equal(state.winner, null);
    for (const seat of ["A", "B"]) {
      assert.deepEqual(rules.countByType(state, seat), { dam: 3, la: 3, keo: 3 });
    }
    for (const p of state.pieces.filter((p) => p.player === "A")) {
      const mirror = state.pieces.find(
        (q) => q.player === "B" && q.x === p.y && q.y === p.x
      );
      assert.ok(mirror);
      assert.equal(mirror.type, p.type);
    }
    assert.equal(rules.piecesAt(state, ...Object.values(config.GOAL.A)).length, 0);
    assert.equal(rules.piecesAt(state, ...Object.values(config.GOAL.B)).length, 0);
    assertSingleOccupancy(state);
  });

  it("keeps both armies off the diagonal with a three-layer neutral buffer", () => {
    const state = rules.createInitialState();
    assert.ok(
      state.pieces
        .filter((p) => p.player === "A")
        .every((p) => p.x > p.y && p.x - p.y >= 3)
    );
    assert.ok(
      state.pieces
        .filter((p) => p.player === "B")
        .every((p) => p.x < p.y && p.y - p.x >= 3)
    );
    assert.equal(state.pieces.some((p) => p.x === p.y), false);
    assert.deepEqual(config.GOAL.A, sq("a9"));
    assert.deepEqual(config.GOAL.B, sq("i1"));
  });

  it("starts A first without letting either side reach the divider or its goal immediately", () => {
    const state = rules.createInitialState();
    assert.equal(state.turn, "A");
    for (const piece of state.pieces) {
      const legal = rules.getLegalMoves(state, piece.id);
      const ownGoal = config.GOAL[piece.player];
      assert.equal(
        legal.some((m) => m.x === m.y),
        false,
        `${piece.id} can reach the divider immediately`
      );
      assert.equal(
        legal.some((m) => m.x === ownGoal.x && m.y === ownGoal.y),
        false
      );
    }
  });
});

describe("movement", () => {
  it("uses I4 to H3 as the strategic opening and rejects I4 to G2", () => {
    const state = rules.createInitialState();
    const opening = move(state, "A", "i4", "h3");
    assert.equal(opening.ok, true);
    assert.equal(pieceAt(opening.state, "h3", "A").type, "la");
    const tooFar = move(state, "A", "i4", "g2");
    assert.equal(tooFar.ok, false);
  });

  it("allows all eight adjacent directions from the center", () => {
    const state = rules.createEmptyState();
    state.pieces = [{ id: "A-dam-0", player: "A", type: "dam", x: 4, y: 4 }];
    assert.equal(rules.getLegalMoves(state, "A-dam-0").length, 8);
  });

  it("rejects off-board, fractional, out-of-turn, and friendly destinations", () => {
    const state = rules.createInitialState();
    assert.equal(rules.applyMove(state, "A", sq("d1"), { x: -1, y: 0 }).ok, false);
    assert.equal(rules.applyMove(state, "A", sq("d1"), { x: 3, y: 0.5 }).ok, false);
    assert.equal(move(state, "B", "a4", "a3").ok, false);
    assert.equal(move(state, "A", "i4", "i5").ok, false);
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

describe("arena setup", () => {
  it("places 6 pieces per seat, 2 of each type, and leaves the four goals empty", () => {
    const s = rules.createInitialState("arena");
    assert.equal(s.mode, "arena");
    assert.deepEqual(s.seats, ["A", "B", "C", "D"]);
    assert.equal(s.pieces.length, 24);
    for (const seat of s.seats) {
      assert.deepEqual(rules.countByType(s, seat), { dam: 2, la: 2, keo: 2 });
    }
    for (const goal of Object.values(config.ARENA_GOAL)) {
      assert.equal(rules.piecesAt(s, goal.x, goal.y).length, 0);
    }
  });

  it("copies A onto B/C/D by 90-degree rotation with the same types", () => {
    const s = rules.createInitialState("arena");
    const aPieces = s.pieces.filter((p) => p.player === "A");
    for (const p of aPieces) {
      const b = rules.rotate90(p.x, p.y);
      const q = s.pieces.find(
        (x) => x.player === "B" && x.x === b.x && x.y === b.y
      );
      assert.ok(q, `missing B mirror of A ${p.type} at ${p.x},${p.y}`);
      assert.equal(q.type, p.type);
    }
  });

  it("does not let a seat step into its own goal on move 1", () => {
    const s = rules.createInitialState("arena");
    for (const seat of s.seats) {
      const goal = config.ARENA_GOAL[seat];
      for (const p of s.pieces.filter((x) => x.player === seat)) {
        const legal = rules.getLegalMoves(s, p.id);
        assert.equal(
          legal.some((m) => m.x === goal.x && m.y === goal.y),
          false
        );
      }
    }
  });
});

describe("arena victory", () => {
  it("awards B on a1 and does not end when only one of four seats is wiped", () => {
    const s = rules.createEmptyState("arena");
    s.turn = "B";
    s.pieces = [
      { id: "B-dam-0", player: "B", type: "dam", x: 0, y: 1 },
      { id: "A-dam-0", player: "A", type: "dam", x: 4, y: 4 },
      { id: "C-la-0", player: "C", type: "la", x: 5, y: 5 },
      { id: "D-keo-0", player: "D", type: "keo", x: 3, y: 3 }
    ];
    const res = rules.applyMove(s, "B", { x: 0, y: 1 }, { x: 0, y: 0 });
    assert.equal(res.state.winner, "B");
    assert.equal(res.state.reason, "goal");
  });

  it("skips a wiped seat and continues the turn cycle", () => {
    const s = rules.createEmptyState("arena");
    s.turn = "A";
    s.pieces = [
      { id: "A-dam-0", player: "A", type: "dam", x: 4, y: 4 },
      { id: "B-keo-0", player: "B", type: "keo", x: 5, y: 4 },
      { id: "C-la-0", player: "C", type: "la", x: 1, y: 1 },
      { id: "D-dam-0", player: "D", type: "dam", x: 2, y: 2 }
    ];
    const res = rules.applyMove(s, "A", { x: 4, y: 4 }, { x: 5, y: 4 });
    assert.equal(res.state.winner, null);
    assert.equal(res.state.turn, "C");
    assert.equal(res.state.pieces.some((p) => p.player === "B"), false);
  });

  it("awards the last living seat after the third opponent is eliminated", () => {
    const s = rules.createEmptyState("arena");
    s.turn = "A";
    s.pieces = [
      { id: "A-dam-0", player: "A", type: "dam", x: 4, y: 4 },
      { id: "C-keo-0", player: "C", type: "keo", x: 5, y: 4 }
    ];
    const res = rules.applyMove(s, "A", { x: 4, y: 4 }, { x: 5, y: 4 });
    assert.equal(res.state.winner, "A");
    assert.equal(res.state.reason, "elimination");
  });
});
