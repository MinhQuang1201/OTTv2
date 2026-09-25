(function (global, factory) {
  const config =
    typeof module === "object" && module.exports
      ? require("./config")
      : global.OTT_CONFIG;
  const api = factory(config);
  if (typeof module === "object" && module.exports) module.exports = api;
  global.OTT_RULES = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (config) {
  const { SIZE, FILES, TYPES, BEATS, GOAL, A_SETUP, DELTAS } = config;

  function inside(x, y) {
    return x >= 0 && y >= 0 && x < SIZE && y < SIZE;
  }

  function parseSquare(name) {
    const file = FILES.indexOf(String(name).charAt(0).toLowerCase());
    const rank = Number(String(name).slice(1));
    if (file < 0 || !Number.isInteger(rank) || rank < 1 || rank > SIZE) {
      throw new Error("Ô không hợp lệ");
    }
    return { x: file, y: rank - 1 };
  }

  function formatSquare(pos) {
    return FILES[pos.x] + (pos.y + 1);
  }

  function compare(a, b) {
    if (a === b) return "tie";
    if (BEATS[a] === b) return "win";
    return "lose";
  }

  function cloneState(state) {
    return {
      turn: state.turn,
      winner: state.winner,
      reason: state.reason,
      wipeType: state.wipeType || null,
      wipeVictim: state.wipeVictim || null,
      pieces: state.pieces.map((p) => ({
        id: p.id,
        player: p.player,
        type: p.type,
        x: p.x,
        y: p.y
      }))
    };
  }

  function createEmptyState() {
    return {
      turn: "A",
      winner: null,
      reason: null,
      wipeType: null,
      wipeVictim: null,
      pieces: []
    };
  }

  function createInitialState() {
    const state = createEmptyState();
    A_SETUP.forEach((spot, i) => {
      state.pieces.push({
        id: "A-" + spot.type + "-" + i,
        player: "A",
        type: spot.type,
        x: spot.x,
        y: spot.y
      });
      state.pieces.push({
        id: "B-" + spot.type + "-" + i,
        player: "B",
        type: spot.type,
        x: SIZE - 1 - spot.x,
        y: SIZE - 1 - spot.y
      });
    });
    return state;
  }

  function piecesAt(state, x, y) {
    return state.pieces.filter((p) => p.x === x && p.y === y);
  }

  function countByType(state, player) {
    const counts = { dam: 0, la: 0, keo: 0 };
    for (const p of state.pieces) {
      if (p.player === player) counts[p.type] += 1;
    }
    return counts;
  }

  function getLegalMoves(state, pieceId) {
    const piece = state.pieces.find((p) => p.id === pieceId);
    if (!piece) return [];
    const moves = [];
    for (const [dx, dy] of DELTAS) {
      const x = piece.x + dx;
      const y = piece.y + dy;
      if (!inside(x, y)) continue;
      const occ = piecesAt(state, x, y);
      if (occ.some((p) => p.player === piece.player)) continue;
      moves.push({ x, y });
    }
    return moves;
  }

  function allMoves(state, player) {
    const out = [];
    for (const piece of state.pieces) {
      if (piece.player !== player) continue;
      for (const to of getLegalMoves(state, piece.id)) {
        out.push({
          pieceId: piece.id,
          from: { x: piece.x, y: piece.y },
          to
        });
      }
    }
    return out;
  }

  function detectWinner(state) {
    for (const seat of ["A", "B"]) {
      const goal = GOAL[seat];
      const onGoal = state.pieces.some(
        (p) => p.player === seat && p.x === goal.x && p.y === goal.y
      );
      if (onGoal) {
        return { winner: seat, reason: "goal", wipeType: null, wipeVictim: null };
      }
    }
    for (const seat of ["A", "B"]) {
      const counts = countByType(state, seat);
      for (const type of TYPES) {
        if (counts[type] === 0) {
          const other = seat === "A" ? "B" : "A";
          return {
            winner: other,
            reason: "wipe",
            wipeType: type,
            wipeVictim: seat
          };
        }
      }
    }
    return null;
  }

  function fail(message) {
    return { ok: false, error: message, state: null, events: [] };
  }

  function applyMove(state, player, from, to) {
    if (!state) return fail("Thiếu trạng thái");
    if (state.winner) return fail("Ván đã kết thúc");
    if (player !== "A" && player !== "B") return fail("Ghế không hợp lệ");
    if (state.turn !== player) return fail("Chưa tới lượt");
    if (!from || !to) return fail("Thiếu tọa độ");
    if (!inside(from.x, from.y) || !inside(to.x, to.y)) {
      return fail("Ngoài bàn cờ");
    }
    const dx = Math.abs(to.x - from.x);
    const dy = Math.abs(to.y - from.y);
    if (dx > 1 || dy > 1 || (dx === 0 && dy === 0)) {
      return fail("Chỉ được đi 1 ô theo 8 hướng");
    }

    const next = cloneState(state);
    const mover = next.pieces.find(
      (p) => p.player === player && p.x === from.x && p.y === from.y
    );
    if (!mover) return fail("Không có quân của bạn ở ô này");

    const occupants = piecesAt(next, to.x, to.y);
    if (occupants.some((p) => p.player === player)) {
      return fail("Không được đi vào ô có quân cùng phe");
    }

    const events = [];
    const enemies = occupants.filter((p) => p.player !== player);

    if (enemies.length === 0) {
      mover.x = to.x;
      mover.y = to.y;
      events.push({
        type: "move",
        pieceId: mover.id,
        from: { x: from.x, y: from.y },
        to: { x: to.x, y: to.y }
      });
    } else {
      const enemy = enemies[0];
      const result = compare(mover.type, enemy.type);
      if (result === "tie") {
        mover.x = to.x;
        mover.y = to.y;
        events.push({
          type: "stack",
          pieceId: mover.id,
          withId: enemy.id,
          from: { x: from.x, y: from.y },
          to: { x: to.x, y: to.y }
        });
      } else if (result === "win") {
        next.pieces = next.pieces.filter((p) => p.id !== enemy.id);
        mover.x = to.x;
        mover.y = to.y;
        events.push({
          type: "capture",
          pieceId: mover.id,
          capturedId: enemy.id,
          capturedType: enemy.type,
          from: { x: from.x, y: from.y },
          to: { x: to.x, y: to.y }
        });
      } else {
        next.pieces = next.pieces.filter((p) => p.id !== mover.id);
        events.push({
          type: "strike_loss",
          pieceId: mover.id,
          byId: enemy.id,
          from: { x: from.x, y: from.y },
          to: { x: to.x, y: to.y }
        });
      }
    }

    const win = detectWinner(next);
    if (win) {
      next.winner = win.winner;
      next.reason = win.reason;
      next.wipeType = win.wipeType;
      next.wipeVictim = win.wipeVictim;
      events.push({
        type: "win",
        winner: win.winner,
        reason: win.reason,
        wipeType: win.wipeType
      });
    } else {
      next.turn = player === "A" ? "B" : "A";
      if (allMoves(next, next.turn).length === 0) {
        const other = next.turn === "A" ? "B" : "A";
        if (allMoves(next, other).length === 0) {
          next.winner = null;
          next.reason = "draw";
        } else {
          next.turn = other;
        }
      }
    }

    return { ok: true, error: null, state: next, events };
  }

  function publicState(state) {
    return cloneState(state);
  }

  return {
    inside,
    parseSquare,
    formatSquare,
    compare,
    cloneState,
    createEmptyState,
    createInitialState,
    piecesAt,
    countByType,
    getLegalMoves,
    allMoves,
    detectWinner,
    applyMove,
    publicState
  };
});
