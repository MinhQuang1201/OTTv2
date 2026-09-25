const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const rules = require("../rules");
const config = require("../config");

function sq(name) {
  return rules.parseSquare(name);
}

function pieceAt(state, name, player) {
  const { x, y } = sq(name);
  return state.pieces.find((p) => p.x === x && p.y === y && p.player === player);
}

function move(state, player, from, to) {
  return rules.applyMove(state, player, sq(from), sq(to));
}

describe("setup", () => {
  it("places 9 pieces per seat, 3 of each type, and leaves goals empty", () => {
    const s = rules.createInitialState();
    assert.equal(s.pieces.length, 18);
    assert.equal(s.turn, "A");
    assert.equal(s.winner, null);
    for (const seat of ["A", "B"]) {
      const c = rules.countByType(s, seat);
      assert.deepEqual(c, { dam: 3, la: 3, keo: 3 });
    }
    assert.equal(rules.piecesAt(s, ...Object.values(config.GOAL.A)).length, 0);
    assert.equal(rules.piecesAt(s, ...Object.values(config.GOAL.B)).length, 0);
  });

  it("reflects A onto B across the a1-i9 diagonal with the same types", () => {
    const s = rules.createInitialState();
    for (const p of s.pieces.filter((p) => p.player === "A")) {
      const q = s.pieces.find(
        (b) => b.player === "B" && b.x === p.y && b.y === p.x
      );
      assert.ok(q, `missing mirror of A ${p.type} at ${p.x},${p.y}`);
      assert.equal(q.type, p.type);
    }
  });

  it("uses three staggered RPS wings instead of a solid 3x3 block", () => {
    const s = rules.createInitialState();
    const actual = s.pieces
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

    assert.deepEqual(actual, expected);
  });

  it("keeps both armies off the diagonal with a three-layer neutral buffer", () => {
    const s = rules.createInitialState();
    assert.ok(
      s.pieces
        .filter((p) => p.player === "A")
        .every((p) => p.x > p.y && p.x - p.y >= 3)
    );
    assert.ok(
      s.pieces
        .filter((p) => p.player === "B")
        .every((p) => p.x < p.y && p.y - p.x >= 3)
    );
    assert.equal(s.pieces.some((p) => p.x === p.y), false);
    assert.deepEqual(config.GOAL.A, sq("a9"));
    assert.deepEqual(config.GOAL.B, sq("i1"));
  });

  it("does not let either side reach the diagonal on its opening move", () => {
    const s = rules.createInitialState();
    for (const p of s.pieces) {
      const legal = rules.getLegalMoves(s, p.id);
      assert.equal(
        legal.some((m) => m.x === m.y),
        false,
        `${p.id} can reach the divider immediately`
      );
    }
  });

  it("does not let either seat step into its own goal on move 1", () => {
    const s = rules.createInitialState();
    for (const p of s.pieces.filter((p) => p.player === "A")) {
      const legal = rules.getLegalMoves(s, p.id);
      assert.equal(
        legal.some((m) => m.x === config.GOAL.A.x && m.y === config.GOAL.A.y),
        false
      );
    }
    for (const p of s.pieces.filter((p) => p.player === "B")) {
      const legal = rules.getLegalMoves(s, p.id);
      assert.equal(
        legal.some((m) => m.x === config.GOAL.B.x && m.y === config.GOAL.B.y),
        false
      );
    }
  });
});

describe("movement", () => {
  it("allows all eight adjacent directions from the center", () => {
    const s = rules.createEmptyState();
    s.pieces = [
      { id: "A-dam-0", player: "A", type: "dam", x: 4, y: 4 }
    ];
    const legal = rules.getLegalMoves(s, "A-dam-0");
    assert.deepEqual(
      legal.sort((a, b) => a.y - b.y || a.x - b.x),
      [
        { x: 3, y: 3 },
        { x: 4, y: 3 },
        { x: 5, y: 3 },
        { x: 3, y: 4 },
        { x: 5, y: 4 },
        { x: 3, y: 5 },
        { x: 4, y: 5 },
        { x: 5, y: 5 }
      ]
    );
  });

  it("allows a king-step onto an empty square and rejects longer steps", () => {
    const s = rules.createInitialState();
    const ok = move(s, "A", "i4", "h3");
    assert.equal(ok.ok, true);
    assert.equal(pieceAt(ok.state, "h3", "A").type, "la");
    const far = move(s, "A", "i4", "g2");
    assert.equal(far.ok, false);
  });

  it("rejects moving onto a friendly piece", () => {
    const s = rules.createInitialState();
    const res = move(s, "A", "i4", "i5");
    assert.equal(res.ok, false);
  });

  it("rejects out-of-turn moves and does not mutate the input", () => {
    const s = rules.createInitialState();
    const copy = JSON.stringify(s);
    const res = move(s, "B", "a4", "a3");
    assert.equal(res.ok, false);
    assert.equal(JSON.stringify(s), copy);
  });

  it("rejects off-board destinations", () => {
    const s = rules.createInitialState();
    const res = rules.applyMove(s, "A", sq("d1"), { x: -1, y: 0 });
    assert.equal(res.ok, false);
  });

  it("rejects fractional coordinates that are not board squares", () => {
    const s = rules.createInitialState();
    const res = rules.applyMove(
      s,
      "A",
      { x: 8, y: 3 },
      { x: 8, y: 2.5 }
    );
    assert.equal(res.ok, false);
  });
});

describe("combat", () => {
  it("lets Đấm eat Kéo", () => {
    const s = rules.createEmptyState();
    s.turn = "A";
    s.pieces = [
      { id: "A-dam-0", player: "A", type: "dam", x: 4, y: 4 },
      { id: "B-keo-0", player: "B", type: "keo", x: 5, y: 4 }
    ];
    const res = rules.applyMove(s, "A", { x: 4, y: 4 }, { x: 5, y: 4 });
    assert.equal(res.ok, true);
    assert.equal(res.events.some((e) => e.type === "capture"), true);
    assert.equal(rules.piecesAt(res.state, 5, 4).length, 1);
    assert.equal(rules.piecesAt(res.state, 5, 4)[0].player, "A");
  });

  it("lets Kéo eat Lá and Lá eat Đấm", () => {
    const keo = rules.createEmptyState();
    keo.turn = "A";
    keo.pieces = [
      { id: "A-keo-0", player: "A", type: "keo", x: 3, y: 3 },
      { id: "B-la-0", player: "B", type: "la", x: 4, y: 3 }
    ];
    const r1 = rules.applyMove(keo, "A", { x: 3, y: 3 }, { x: 4, y: 3 });
    assert.equal(r1.events[0].type, "capture");

    const la = rules.createEmptyState();
    la.turn = "A";
    la.pieces = [
      { id: "A-la-0", player: "A", type: "la", x: 3, y: 3 },
      { id: "B-dam-0", player: "B", type: "dam", x: 4, y: 3 }
    ];
    const r2 = rules.applyMove(la, "A", { x: 3, y: 3 }, { x: 4, y: 3 });
    assert.equal(r2.events[0].type, "capture");
  });

  it("removes the attacker on a losing strike and leaves the defender", () => {
    const s = rules.createEmptyState();
    s.turn = "A";
    s.pieces = [
      { id: "A-dam-0", player: "A", type: "dam", x: 4, y: 4 },
      { id: "B-la-0", player: "B", type: "la", x: 5, y: 4 }
    ];
    const res = rules.applyMove(s, "A", { x: 4, y: 4 }, { x: 5, y: 4 });
    assert.equal(res.ok, true);
    assert.equal(res.events[0].type, "strike_loss");
    assert.equal(res.state.pieces.length, 1);
    assert.equal(res.state.pieces[0].id, "B-la-0");
  });

  it("stacks same types on one square and blocks a friendly from joining", () => {
    const s = rules.createEmptyState();
    s.turn = "A";
    s.pieces = [
      { id: "A-dam-0", player: "A", type: "dam", x: 4, y: 4 },
      { id: "B-dam-0", player: "B", type: "dam", x: 5, y: 4 },
      { id: "A-dam-1", player: "A", type: "dam", x: 4, y: 5 }
    ];
    const stacked = rules.applyMove(s, "A", { x: 4, y: 4 }, { x: 5, y: 4 });
    assert.equal(stacked.ok, true);
    assert.equal(stacked.events[0].type, "stack");
    assert.equal(rules.piecesAt(stacked.state, 5, 4).length, 2);

    stacked.state.turn = "A";
    const blocked = rules.applyMove(
      stacked.state,
      "A",
      { x: 4, y: 5 },
      { x: 5, y: 4 }
    );
    assert.equal(blocked.ok, false);
  });

  it("lets a stacked piece step off and leave the other behind", () => {
    const s = rules.createEmptyState();
    s.turn = "A";
    s.pieces = [
      { id: "A-la-0", player: "A", type: "la", x: 4, y: 4 },
      { id: "B-la-0", player: "B", type: "la", x: 4, y: 4 }
    ];
    const res = rules.applyMove(s, "A", { x: 4, y: 4 }, { x: 4, y: 5 });
    assert.equal(res.ok, true);
    assert.equal(rules.piecesAt(res.state, 4, 4).length, 1);
    assert.equal(rules.piecesAt(res.state, 4, 4)[0].player, "B");
    assert.equal(rules.piecesAt(res.state, 4, 5)[0].player, "A");
  });
});

describe("victory", () => {
  it("awards A when any A piece steps onto A9", () => {
    const s = rules.createEmptyState();
    s.turn = "A";
    s.pieces = [
      { id: "A-keo-0", player: "A", type: "keo", x: 0, y: 7 },
      { id: "B-keo-0", player: "B", type: "keo", x: 8, y: 1 },
      { id: "A-dam-0", player: "A", type: "dam", x: 3, y: 3 },
      { id: "A-la-0", player: "A", type: "la", x: 3, y: 4 },
      { id: "B-dam-0", player: "B", type: "dam", x: 6, y: 6 },
      { id: "B-la-0", player: "B", type: "la", x: 6, y: 5 }
    ];
    const res = rules.applyMove(s, "A", { x: 0, y: 7 }, { x: 0, y: 8 });
    assert.equal(res.ok, true);
    assert.equal(res.state.winner, "A");
    assert.equal(res.state.reason, "goal");
  });

  it("awards B when any B piece steps onto I1", () => {
    const s = rules.createEmptyState();
    s.turn = "B";
    s.pieces = [
      { id: "B-dam-0", player: "B", type: "dam", x: 8, y: 1 },
      { id: "A-dam-0", player: "A", type: "dam", x: 0, y: 7 },
      { id: "A-la-0", player: "A", type: "la", x: 1, y: 7 },
      { id: "A-keo-0", player: "A", type: "keo", x: 2, y: 7 },
      { id: "B-la-0", player: "B", type: "la", x: 7, y: 1 },
      { id: "B-keo-0", player: "B", type: "keo", x: 6, y: 1 }
    ];
    const res = rules.applyMove(s, "B", { x: 8, y: 1 }, { x: 8, y: 0 });
    assert.equal(res.state.winner, "B");
    assert.equal(res.state.reason, "goal");
  });

  it("does not award A for standing on B's I1 goal", () => {
    const s = rules.createEmptyState();
    s.turn = "A";
    s.pieces = [
      { id: "A-dam-0", player: "A", type: "dam", x: 7, y: 0 },
      { id: "A-la-0", player: "A", type: "la", x: 1, y: 2 },
      { id: "A-keo-0", player: "A", type: "keo", x: 2, y: 2 },
      { id: "B-dam-0", player: "B", type: "dam", x: 0, y: 7 },
      { id: "B-la-0", player: "B", type: "la", x: 1, y: 7 },
      { id: "B-keo-0", player: "B", type: "keo", x: 2, y: 7 }
    ];
    const res = rules.applyMove(s, "A", { x: 7, y: 0 }, { x: 8, y: 0 });
    assert.equal(res.state.winner, null);
  });

  it("does not award a win when one opponent type is gone but pieces remain", () => {
    const s = rules.createEmptyState();
    s.turn = "A";
    s.pieces = [
      { id: "A-dam-0", player: "A", type: "dam", x: 4, y: 4 },
      { id: "A-la-0", player: "A", type: "la", x: 0, y: 3 },
      { id: "A-keo-0", player: "A", type: "keo", x: 0, y: 4 },
      { id: "B-keo-0", player: "B", type: "keo", x: 5, y: 4 },
      { id: "B-la-0", player: "B", type: "la", x: 8, y: 6 },
      { id: "B-dam-0", player: "B", type: "dam", x: 8, y: 5 }
    ];
    const res = rules.applyMove(s, "A", { x: 4, y: 4 }, { x: 5, y: 4 });
    assert.equal(res.state.winner, null);
    assert.equal(res.state.reason, null);
    assert.equal(res.state.turn, "B");
  });

  it("awards the opponent when its final piece is captured", () => {
    const s = rules.createEmptyState();
    s.turn = "A";
    s.pieces = [
      { id: "A-dam-0", player: "A", type: "dam", x: 4, y: 4 },
      { id: "B-keo-0", player: "B", type: "keo", x: 5, y: 4 }
    ];
    const res = rules.applyMove(s, "A", { x: 4, y: 4 }, { x: 5, y: 4 });
    assert.equal(res.state.winner, "A");
    assert.equal(res.state.reason, "elimination");
    assert.equal(res.state.eliminatedPlayer, "B");
  });

  it("awards B when A loses its final attacking piece", () => {
    const s = rules.createEmptyState();
    s.turn = "A";
    s.pieces = [
      { id: "A-dam-0", player: "A", type: "dam", x: 4, y: 4 },
      { id: "B-la-0", player: "B", type: "la", x: 5, y: 4 }
    ];
    const res = rules.applyMove(s, "A", { x: 4, y: 4 }, { x: 5, y: 4 });
    assert.equal(res.state.winner, "B");
    assert.equal(res.state.reason, "elimination");
    assert.equal(res.state.eliminatedPlayer, "A");
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
