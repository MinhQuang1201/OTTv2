(function (global, factory) {
  const config =
    typeof module === "object" && module.exports
      ? require("./config")
      : global.OTT_CONFIG;
  const api = factory(config);
  if (typeof module === "object" && module.exports) module.exports = api;
  global.OTT_RULES = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (config) {
  const {
    SIZE,
    FILES,
    BEATS,
    GOAL,
    ARENA_GOAL,
    A_SETUP,
    A_ARENA_SETUP,
    DELTAS,
    MODES,
    TIME_CONTROL
  } = config;

  function normalizeMode(mode) {
    return mode === "arena" ? "arena" : "duel";
  }

  function seatsOfMode(mode) {
    return MODES[normalizeMode(mode)].seats.slice();
  }

  function seatsOf(state) {
    if (state && Array.isArray(state.seats) && state.seats.length) {
      return state.seats.slice();
    }
    return seatsOfMode(state && state.mode);
  }

  function goalsOf(state) {
    return state && state.mode === "arena" ? ARENA_GOAL : GOAL;
  }

  function rotate90(x, y) {
    return { x: SIZE - 1 - y, y: x };
  }

  function inside(x, y) {
    return (
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      x >= 0 &&
      y >= 0 &&
      x < SIZE &&
      y < SIZE
    );
  }

  function parseSquare(name) {
    const text = String(name || "");
    const file = FILES.indexOf(text.charAt(0).toLowerCase());
    const rank = Number(text.slice(1));
    if (file < 0 || !Number.isInteger(rank) || rank < 1 || rank > SIZE) {
      throw new Error("Invalid square");
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

  function freshClock(mode) {
    const remainingMs = {};
    for (const seat of seatsOfMode(mode)) {
      remainingMs[seat] = TIME_CONTROL.initialMs;
    }
    return {
      remainingMs,
      runningSeat: "A"
    };
  }

  function cloneClock(clock, seats) {
    const source = clock || freshClock(seats.length === 4 ? "arena" : "duel");
    const remainingMs = {};
    for (const seat of seats) {
      const value = source.remainingMs && source.remainingMs[seat];
      remainingMs[seat] = Number.isFinite(value) ? value : TIME_CONTROL.initialMs;
    }
    return {
      remainingMs,
      runningSeat: seats.includes(source.runningSeat) ? source.runningSeat : null
    };
  }

  function cloneState(state) {
    const seats = seatsOf(state);
    return {
      mode: normalizeMode(state && state.mode),
      seats,
      turn: state.turn,
      winner: state.winner || null,
      reason: state.reason || null,
      eliminatedPlayer: state.eliminatedPlayer || null,
      clock: cloneClock(state.clock, seats),
      pieces: (state.pieces || []).map((piece) => ({
        id: piece.id,
        player: piece.player,
        type: piece.type,
        x: piece.x,
        y: piece.y
      }))
    };
  }

  function createEmptyState(mode) {
    const normalized = normalizeMode(mode);
    return {
      mode: normalized,
      seats: seatsOfMode(normalized),
      turn: "A",
      winner: null,
      reason: null,
      eliminatedPlayer: null,
      clock: freshClock(normalized),
      pieces: []
    };
  }

  function placeRotated(state, setup, seats) {
    setup.forEach((spot, index) => {
      seats.forEach((seat, rotation) => {
        let x = spot.x;
        let y = spot.y;
        for (let step = 0; step < rotation; step += 1) {
          const rotated = rotate90(x, y);
          x = rotated.x;
          y = rotated.y;
        }
        state.pieces.push({
          id: seat + "-" + spot.type + "-" + index,
          player: seat,
          type: spot.type,
          x,
          y
        });
      });
    });
  }

  function createInitialState(mode) {
    const normalized = normalizeMode(mode);
    const state = createEmptyState(normalized);
    if (normalized === "arena") {
      placeRotated(state, A_ARENA_SETUP, state.seats);
      return state;
    }

    A_SETUP.forEach((spot, index) => {
      state.pieces.push({
        id: "A-" + spot.type + "-" + index,
        player: "A",
        type: spot.type,
        x: spot.x,
        y: spot.y
      });
      state.pieces.push({
        id: "B-" + spot.type + "-" + index,
        player: "B",
        type: spot.type,
        x: spot.y,
        y: spot.x
      });
    });
    return state;
  }

  function piecesAt(state, x, y) {
    return (state.pieces || []).filter((piece) => piece.x === x && piece.y === y);
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
    for (const piece of state.pieces || []) {
      if (piece.player === player && counts[piece.type] !== undefined) {
        counts[piece.type] += 1;
      }
    }
    return counts;
  }

  function livingSeats(state) {
    const pieces = state.pieces || [];
    return seatsOf(state).filter((seat) =>
      pieces.some((piece) => piece.player === seat)
    );
  }

  function nextTurn(state, current) {
    const seats = seatsOf(state);
    const living = livingSeats(state);
    if (living.length <= 1) return current;
    let index = seats.indexOf(current);
    if (index < 0) index = 0;
    for (let step = 0; step < seats.length; step += 1) {
      index = (index + 1) % seats.length;
      if (living.includes(seats[index])) return seats[index];
    }
    return current;
  }

  function getLegalMoves(state, pieceId) {
    if (!state || state.winner || !hasSingleOccupancy(state)) return [];
    const piece = state.pieces.find((candidate) => candidate.id === pieceId);
    if (!piece) return [];

    const moves = [];
    for (const [dx, dy] of DELTAS) {
      const x = piece.x + dx;
      const y = piece.y + dy;
      if (!inside(x, y)) continue;
      const occupants = piecesAt(state, x, y);
      if (
        occupants.some(
          (occupant) =>
            occupant.player === piece.player || occupant.type === piece.type
        )
      ) {
        continue;
      }
      moves.push({ x, y });
    }
    return moves;
  }

  function allMoves(state, player) {
    if (!state || state.winner) return [];
    const moves = [];
    for (const piece of state.pieces || []) {
      if (piece.player !== player) continue;
      for (const to of getLegalMoves(state, piece.id)) {
        moves.push({
          pieceId: piece.id,
          from: { x: piece.x, y: piece.y },
          to
        });
      }
    }
    return moves;
  }

  function detectWinner(state) {
    const seats = seatsOf(state);
    const goals = goalsOf(state);
    for (const seat of seats) {
      const goal = goals[seat];
      if (!goal) continue;
      if (
        state.pieces.some(
          (piece) =>
            piece.player === seat && piece.x === goal.x && piece.y === goal.y
        )
      ) {
        return { winner: seat, reason: "goal", eliminatedPlayer: null };
      }
    }

    const living = livingSeats(state);
    if (living.length === 1) {
      const eliminated = seats.filter((seat) => seat !== living[0]);
      return {
        winner: living[0],
        reason: "elimination",
        eliminatedPlayer: eliminated.length === 1 ? eliminated[0] : null
      };
    }
    return null;
  }

  function eliminatePlayer(state, seat) {
    const next = cloneState(state);
    next.pieces = next.pieces.filter((piece) => piece.player !== seat);
    const winner = detectWinner(next);
    if (winner) {
      next.winner = winner.winner;
      next.reason = winner.reason;
      next.eliminatedPlayer = seat;
      next.clock.runningSeat = null;
    } else if (next.turn === seat) {
      next.turn = nextTurn(next, seat);
      next.clock.runningSeat = next.turn;
    }
    return next;
  }

  function fail(error) {
    return { ok: false, error, state: null, events: [] };
  }

  function applyMove(state, player, from, to) {
    if (!state) return fail("Missing state");
    if (state.winner) return fail("Game already ended");
    if (!hasSingleOccupancy(state)) return fail("Invalid board occupancy");
    if (!seatsOf(state).includes(player)) return fail("Invalid seat");
    if (state.turn !== player) return fail("Not your turn");
    if (!from || !to) return fail("Missing coordinates");
    if (
      !inside(from.x, from.y) ||
      !inside(to.x, to.y)
    ) {
      return fail("Outside board");
    }

    const dx = Math.abs(to.x - from.x);
    const dy = Math.abs(to.y - from.y);
    if (dx > 1 || dy > 1 || (dx === 0 && dy === 0)) {
      return fail("A move must go one square in any direction");
    }

    const mover = state.pieces.find(
      (piece) =>
        piece.player === player &&
        piece.x === from.x &&
        piece.y === from.y
    );
    if (!mover) return fail("Your piece is not on that square");

    const occupants = piecesAt(state, to.x, to.y);
    if (occupants.length > 1) return fail("Invalid board occupancy");
    if (occupants.some((piece) => piece.player === player)) {
      return fail("Cannot move onto a friendly piece");
    }
    if (occupants.some((piece) => piece.type === mover.type)) {
      return fail("Cannot move onto the same piece type");
    }

    const next = cloneState(state);
    const nextMover = next.pieces.find((piece) => piece.id === mover.id);
    const enemy = occupants[0];
    const events = [];

    if (!enemy) {
      nextMover.x = to.x;
      nextMover.y = to.y;
      events.push({
        type: "move",
        pieceId: nextMover.id,
        moverType: nextMover.type,
        from: { x: from.x, y: from.y },
        to: { x: to.x, y: to.y }
      });
    } else {
      const result = compare(nextMover.type, enemy.type);
      if (result === "win") {
        next.pieces = next.pieces.filter((piece) => piece.id !== enemy.id);
        nextMover.x = to.x;
        nextMover.y = to.y;
        events.push({
          type: "capture",
          pieceId: nextMover.id,
          moverType: nextMover.type,
          capturedId: enemy.id,
          capturedType: enemy.type,
          capturedPlayer: enemy.player,
          from: { x: from.x, y: from.y },
          to: { x: to.x, y: to.y }
        });
      } else {
        next.pieces = next.pieces.filter((piece) => piece.id !== nextMover.id);
        events.push({
          type: "strike_loss",
          pieceId: nextMover.id,
          moverType: nextMover.type,
          byId: enemy.id,
          byType: enemy.type,
          from: { x: from.x, y: from.y },
          to: { x: to.x, y: to.y }
        });
      }
    }

    const winner = detectWinner(next);
    if (winner) {
      next.winner = winner.winner;
      next.reason = winner.reason;
      next.eliminatedPlayer = winner.eliminatedPlayer;
      next.clock.runningSeat = null;
      events.push({
        type: "win",
        winner: winner.winner,
        reason: winner.reason,
        eliminatedPlayer: winner.eliminatedPlayer
      });
    } else {
      const following = nextTurn(next, player);
      if (allMoves(next, following).length === 0) {
        next.winner = player;
        next.reason = "no_moves";
        next.eliminatedPlayer = null;
        next.clock.runningSeat = null;
        events.push({
          type: "win",
          winner: player,
          reason: "no_moves",
          eliminatedPlayer: null
        });
      } else {
        next.turn = following;
        next.clock.runningSeat = following;
      }
    }

    if (!hasSingleOccupancy(next)) return fail("Invalid board occupancy");
    return { ok: true, error: null, state: next, events };
  }

  function elapseClock(state, elapsedMs) {
    if (!state) return fail("Missing state");
    if (!Number.isInteger(elapsedMs) || elapsedMs < 0) {
      return fail("Invalid elapsed time");
    }

    const next = cloneState(state);
    const seat = next.clock.runningSeat;
    if (next.winner || !seat || elapsedMs === 0) {
      return { ok: true, error: null, state: next, events: [] };
    }

    next.clock.remainingMs[seat] = Math.max(
      0,
      next.clock.remainingMs[seat] - elapsedMs
    );
    if (next.clock.remainingMs[seat] > 0) {
      return { ok: true, error: null, state: next, events: [] };
    }

    const events = [];
    if (next.mode === "duel") {
      const winner = seat === "A" ? "B" : "A";
      next.winner = winner;
      next.reason = "timeout";
      next.eliminatedPlayer = null;
      next.clock.runningSeat = null;
      events.push({
        type: "win",
        winner,
        reason: "timeout",
        eliminatedPlayer: null
      });
      return { ok: true, error: null, state: next, events };
    }

    next.pieces = next.pieces.filter((piece) => piece.player !== seat);
    const winner = detectWinner(next);
    if (winner) {
      next.winner = winner.winner;
      next.reason = winner.reason;
      next.eliminatedPlayer = seat;
      next.clock.runningSeat = null;
      events.push({
        type: "win",
        winner: winner.winner,
        reason: winner.reason,
        eliminatedPlayer: seat
      });
      return { ok: true, error: null, state: next, events };
    }

    const following = nextTurn(next, seat);
    next.turn = following;
    next.clock.runningSeat = following;
    events.push({ type: "timeout", seat });
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
    livingSeats,
    nextTurn,
    getLegalMoves,
    allMoves,
    detectWinner,
    eliminatePlayer,
    applyMove,
    elapseClock,
    publicState,
    goalsOf,
    seatsOf,
    rotate90,
    normalizeMode
  };
});
