(function (global, factory) {
  const config =
    typeof module === "object" && module.exports
      ? require("./config")
      : global.OTT_CONFIG;
  const api = factory(config);
  if (typeof module === "object" && module.exports) module.exports = api;
  global.OTT_RULES = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (config) {
  const { SIZE, FILES, BEATS, GOAL, A_SETUP, DELTAS, TIME_CONTROL } = config;

  function inside(x, y) {
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < SIZE && y < SIZE;
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

  function freshClock() {
    return {
      remainingMs: { A: TIME_CONTROL.initialMs, B: TIME_CONTROL.initialMs },
      runningSeat: "A"
    };
  }

  function cloneClock(clock) {
    const source = clock || freshClock();
    return {
      remainingMs: {
        A: Number.isFinite(source.remainingMs && source.remainingMs.A)
          ? source.remainingMs.A
          : TIME_CONTROL.initialMs,
        B: Number.isFinite(source.remainingMs && source.remainingMs.B)
          ? source.remainingMs.B
          : TIME_CONTROL.initialMs
      },
      runningSeat: source.runningSeat === "A" || source.runningSeat === "B" ? source.runningSeat : null
    };
  }

  function cloneState(state) {
    return {
      turn: state.turn,
      winner: state.winner || null,
      reason: state.reason || null,
      eliminatedPlayer: state.eliminatedPlayer || null,
      clock: cloneClock(state.clock),
      pieces: (state.pieces || []).map((p) => ({
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
      eliminatedPlayer: null,
      clock: freshClock(),
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
        x: spot.y,
        y: spot.x
      });
    });
    return state;
  }

  function piecesAt(state, x, y) {
    return (state.pieces || []).filter((p) => p.x === x && p.y === y);
  }

  function hasSingleOccupancy(state) {
    const occupied = new Set();
    for (const piece of state.pieces || []) {
      const key = piece.x + "," + piece.y;
      if (occupied.has(key)) return false;
      occupied.add(key);
    }
    return true;
  }

  function countByType(state, player) {
    const counts = { dam: 0, la: 0, keo: 0 };
    for (const p of state.pieces || []) {
      if (p.player === player && counts[p.type] !== undefined) counts[p.type] += 1;
    }
    return counts;
  }

  function getLegalMoves(state, pieceId) {
    if (!state || !hasSingleOccupancy(state) || state.winner) return [];
    const piece = state.pieces.find((p) => p.id === pieceId);
    if (!piece) return [];
    const moves = [];
    for (const [dx, dy] of DELTAS) {
      const x = piece.x + dx;
      const y = piece.y + dy;
      if (!inside(x, y)) continue;
      const occ = piecesAt(state, x, y);
      if (occ.length > 0 && (occ[0].player === piece.player || occ[0].type === piece.type)) continue;
      moves.push({ x, y });
    }
    return moves;
  }

  function allMoves(state, player) {
    if (!state || state.winner) return [];
    const out = [];
    for (const piece of state.pieces || []) {
      if (piece.player !== player) continue;
      for (const to of getLegalMoves(state, piece.id)) {
        out.push({ pieceId: piece.id, from: { x: piece.x, y: piece.y }, to });
      }
    }
    return out;
  }

  function detectWinner(state) {
    for (const seat of ["A", "B"]) {
      const goal = GOAL[seat];
      if (state.pieces.some((p) => p.player === seat && p.x === goal.x && p.y === goal.y)) {
        return { winner: seat, reason: "goal", eliminatedPlayer: null };
      }
    }
    for (const seat of ["A", "B"]) {
      if (!state.pieces.some((p) => p.player === seat)) {
        return {
          winner: seat === "A" ? "B" : "A",
          reason: "elimination",
          eliminatedPlayer: seat
        };
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
    if (!hasSingleOccupancy(state)) return fail("Trạng thái bàn cờ không hợp lệ");
    if (player !== "A" && player !== "B") return fail("Ghế không hợp lệ");
    if (state.turn !== player) return fail("Chưa tới lượt");
    if (!from || !to) return fail("Thiếu tọa độ");
    if (!inside(from.x, from.y) || !inside(to.x, to.y)) return fail("Ngoài bàn cờ");
    const dx = Math.abs(to.x - from.x);
    const dy = Math.abs(to.y - from.y);
    if (dx > 1 || dy > 1 || (dx === 0 && dy === 0)) return fail("Chỉ được đi 1 ô theo 8 hướng");

    const mover = state.pieces.find((p) => p.player === player && p.x === from.x && p.y === from.y);
    if (!mover) return fail("Không có quân của bạn ở ô này");
    const occupants = piecesAt(state, to.x, to.y);
    if (occupants.length > 1) return fail("Trạng thái bàn cờ không hợp lệ");
    if (occupants.some((p) => p.player === player)) return fail("Không được đi vào ô có quân cùng phe");
    if (occupants.some((p) => p.type === mover.type)) return fail("Không được đi vào ô có quân cùng loại");

    const next = cloneState(state);
    const nextMover = next.pieces.find((p) => p.id === mover.id);
    const events = [];
    const enemy = occupants[0];
    if (!enemy) {
      nextMover.x = to.x;
      nextMover.y = to.y;
      events.push({ type: "move", pieceId: nextMover.id, from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } });
    } else {
      const result = compare(nextMover.type, enemy.type);
      if (result === "win") {
        next.pieces = next.pieces.filter((p) => p.id !== enemy.id);
        nextMover.x = to.x;
        nextMover.y = to.y;
        events.push({
          type: "capture",
          pieceId: nextMover.id,
          capturedId: enemy.id,
          capturedType: enemy.type,
          from: { x: from.x, y: from.y },
          to: { x: to.x, y: to.y }
        });
      } else {
        next.pieces = next.pieces.filter((p) => p.id !== nextMover.id);
        events.push({
          type: "strike_loss",
          pieceId: nextMover.id,
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
      next.eliminatedPlayer = win.eliminatedPlayer;
      next.clock.runningSeat = null;
      events.push({ type: "win", winner: win.winner, reason: win.reason, eliminatedPlayer: win.eliminatedPlayer });
    } else {
      const nextTurn = player === "A" ? "B" : "A";
      if (allMoves(next, nextTurn).length === 0) {
        next.winner = player;
        next.reason = "no_moves";
        next.eliminatedPlayer = null;
        next.clock.runningSeat = null;
        events.push({ type: "win", winner: player, reason: "no_moves", eliminatedPlayer: null });
      } else {
        next.turn = nextTurn;
        next.clock.runningSeat = nextTurn;
      }
    }
    if (!hasSingleOccupancy(next)) return fail("Trạng thái bàn cờ không hợp lệ");
    return { ok: true, error: null, state: next, events };
  }

  function elapseClock(state, elapsedMs) {
    if (!state) return fail("Thiếu trạng thái");
    if (!Number.isInteger(elapsedMs) || elapsedMs < 0) return fail("Thời gian không hợp lệ");
    const next = cloneState(state);
    const seat = next.clock.runningSeat;
    if (next.winner || !seat || elapsedMs === 0) {
      return { ok: true, error: null, state: next, events: [] };
    }
    const before = next.clock.remainingMs[seat];
    next.clock.remainingMs[seat] = Math.max(0, before - elapsedMs);
    const events = [];
    if (next.clock.remainingMs[seat] === 0) {
      const winner = seat === "A" ? "B" : "A";
      next.winner = winner;
      next.reason = "timeout";
      next.eliminatedPlayer = null;
      next.clock.runningSeat = null;
      events.push({ type: "win", winner, reason: "timeout", eliminatedPlayer: null });
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
    elapseClock,
    publicState
  };
});
