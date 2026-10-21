(function (global, factory) {
  const rules =
    typeof require === "function"
      ? require("./rules")
      : global.OTT_RULES;
  const config =
    typeof require === "function"
      ? require("./config")
      : global.OTT_CONFIG;
  const api = factory(rules, config);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  global.OTT_AI = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (rules, config) {
  const { SIZE, GOAL, DELTAS } = config;
  const CELLS = SIZE * SIZE;
  const WIN = 1000000;

  // Piece types are indexed so BEATS[type] is the index of the type it captures.
  const TYPE_INDEX = { dam: 0, la: 1, keo: 2 };
  const CAPTURES = [TYPE_INDEX[config.BEATS.dam], TYPE_INDEX[config.BEATS.la], TYPE_INDEX[config.BEATS.keo]];

  // level -> search depth, node budget and how much noise the choice gets.
  const LEVELS = {
    easy: { depth: 1, maxNodes: 2000, randomMoveChance: 0.2, pickAmongTop: 3 },
    medium: { depth: 2, maxNodes: 20000, randomMoveChance: 0, pickAmongTop: 1 },
    hard: { depth: 4, maxNodes: 100000, randomMoveChance: 0, pickAmongTop: 1 }
  };
  const DEFAULT_LEVEL = "hard";

  const seatIndex = (seat) => (seat === "A" ? 0 : 1);
  const GOAL_CELL = [GOAL.A.y * SIZE + GOAL.A.x, GOAL.B.y * SIZE + GOAL.B.x];

  function distanceToGoal(side, x, y) {
    const goal = GOAL[side === 0 ? "A" : "B"];
    return Math.max(Math.abs(x - goal.x), Math.abs(y - goal.y));
  }

  /** Mutable search position. It mirrors rules.applyMove; tests cross-check the two. */
  function buildPosition(state) {
    const pieces = state.pieces.map((p) => ({
      id: p.id,
      side: seatIndex(p.player),
      type: TYPE_INDEX[p.type],
      x: p.x,
      y: p.y,
      alive: true
    }));
    const board = new Int16Array(CELLS);
    pieces.forEach((piece, index) => { board[piece.y * SIZE + piece.x] = index + 1; });
    const count = [0, 0];
    for (const piece of pieces) count[piece.side] += 1;
    return { pieces, board, count };
  }

  function generateMoves(position, side) {
    const { pieces, board } = position;
    const moves = [];
    for (let index = 0; index < pieces.length; index++) {
      const piece = pieces[index];
      if (!piece.alive || piece.side !== side) continue;
      for (const [dx, dy] of DELTAS) {
        const x = piece.x + dx;
        const y = piece.y + dy;
        if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
        const occupant = board[y * SIZE + x];
        let capture = 0;
        if (occupant) {
          const target = pieces[occupant - 1];
          if (target.side === side || CAPTURES[piece.type] !== target.type) continue;
          capture = 1;
        }
        moves.push({ index, x, y, capture, order: capture * 100 + orderingBonus(side, piece, x, y) });
      }
    }
    moves.sort((a, b) => b.order - a.order || a.index - b.index);
    return moves;
  }

  function orderingBonus(side, piece, x, y) {
    return distanceToGoal(side, piece.x, piece.y) - distanceToGoal(side, x, y) + 1;
  }

  function makeMove(position, side, move) {
    const { pieces, board } = position;
    const piece = pieces[move.index];
    const fromCell = piece.y * SIZE + piece.x;
    const toCell = move.y * SIZE + move.x;
    const victimSlot = board[toCell];
    board[fromCell] = 0;
    board[toCell] = move.index + 1;
    const undo = { index: move.index, fromX: piece.x, fromY: piece.y, victimSlot };
    piece.x = move.x;
    piece.y = move.y;
    if (victimSlot) {
      pieces[victimSlot - 1].alive = false;
      position.count[1 - side] -= 1;
    }
    return undo;
  }

  function unmakeMove(position, side, undo) {
    const { pieces, board } = position;
    const piece = pieces[undo.index];
    const toCell = piece.y * SIZE + piece.x;
    piece.x = undo.fromX;
    piece.y = undo.fromY;
    board[piece.y * SIZE + piece.x] = undo.index + 1;
    board[toCell] = undo.victimSlot;
    if (undo.victimSlot) {
      pieces[undo.victimSlot - 1].alive = true;
      position.count[1 - side] += 1;
    }
  }

  function closeness(distance) {
    const near = SIZE - 1 - distance;
    return near * near;
  }

  /** Score from `side`'s point of view. */
  function evaluate(position, side) {
    const { pieces } = position;
    const best = [SIZE, SIZE];
    const progress = [0, 0];
    const byType = [[0, 0, 0], [0, 0, 0]];
    for (const piece of pieces) {
      if (!piece.alive) continue;
      const distance = distanceToGoal(piece.side, piece.x, piece.y);
      if (distance < best[piece.side]) best[piece.side] = distance;
      progress[piece.side] += SIZE - 1 - distance;
      byType[piece.side][piece.type] += 1;
    }
    const other = 1 - side;
    let score = 100 * (position.count[side] - position.count[other]);
    score += 3 * (closeness(best[side]) - closeness(best[other]));
    score += 2 * (progress[side] - progress[other]);
    // A type nobody can capture is safe from capture for good.
    for (let type = 0; type < 3; type++) {
      const hunter = CAPTURES.indexOf(type);
      if (byType[other][hunter] === 0) score += 4 * byType[side][type];
      if (byType[side][hunter] === 0) score -= 4 * byType[other][type];
    }
    score += generateMoves(position, side).length - generateMoves(position, other).length;
    return score;
  }

  function createSearch(position, budget) {
    let nodes = 0;
    let aborted = false;

    function visit(side, depth, alpha, beta, ply) {
      nodes += 1;
      if (nodes > budget) { aborted = true; return 0; }
      const moves = generateMoves(position, side);
      // The side to move has no legal move: the previous mover wins (no_moves).
      if (!moves.length) return -(WIN - ply);
      if (depth === 0) return evaluate(position, side);
      let best = -Infinity;
      for (const move of moves) {
        const undo = makeMove(position, side, move);
        let value;
        if (move.y * SIZE + move.x === GOAL_CELL[side] || position.count[1 - side] === 0) value = WIN - ply;
        else value = -visit(1 - side, depth - 1, -beta, -alpha, ply + 1);
        unmakeMove(position, side, undo);
        if (aborted) return 0;
        if (value > best) best = value;
        if (best > alpha) alpha = best;
        if (alpha >= beta) break;
      }
      return best;
    }

    function rootScores(side, depth) {
      const moves = generateMoves(position, side);
      const scored = [];
      for (const move of moves) {
        const undo = makeMove(position, side, move);
        let value;
        if (move.y * SIZE + move.x === GOAL_CELL[side] || position.count[1 - side] === 0) value = WIN;
        else value = -visit(1 - side, depth - 1, -Infinity, Infinity, 1);
        unmakeMove(position, side, undo);
        if (aborted) return null;
        scored.push({ move, value });
      }
      return scored;
    }

    return { rootScores, get nodes() { return nodes; } };
  }

  function normalizeOptions(options) {
    const level = options && LEVELS[options.level] ? options.level : DEFAULT_LEVEL;
    const base = LEVELS[level];
    return {
      level,
      depth: options && Number.isInteger(options.depth) && options.depth > 0 ? options.depth : base.depth,
      maxNodes: options && Number.isFinite(options.maxNodes) && options.maxNodes > 0 ? options.maxNodes : base.maxNodes,
      randomMoveChance: base.randomMoveChance,
      pickAmongTop: base.pickAmongTop,
      rng: options && typeof options.rng === "function" ? options.rng : Math.random
    };
  }

  function toResult(piece, move) {
    return { pieceId: piece.id, from: { x: piece.x, y: piece.y }, to: { x: move.x, y: move.y } };
  }

  /**
   * Picks a move for `player`. `options.level` is "easy" | "medium" | "hard" (default "hard").
   * Without randomness (medium/hard) the result only depends on the position.
   */
  function chooseMove(state, player, options) {
    if (!state || state.winner || state.turn !== player) return null;
    if (!rules.allMoves(state, player).length) return null;
    const settings = normalizeOptions(options);
    const side = seatIndex(player);
    const position = buildPosition(state);

    // Deepen one ply at a time and keep the last fully searched result, so the
    // node budget bounds the work without making the answer depend on timing.
    let scored = null;
    for (let depth = 1; depth <= settings.depth; depth++) {
      const search = createSearch(position, settings.maxNodes);
      const result = search.rootScores(side, depth);
      if (!result) break;
      scored = result;
      if (result.some((entry) => entry.value >= WIN - 1)) break;
    }
    if (!scored) scored = createSearch(position, Infinity).rootScores(side, 1);

    const piecesOf = position.pieces;
    if (settings.randomMoveChance > 0 && settings.rng() < settings.randomMoveChance) {
      const pick = scored[Math.floor(settings.rng() * scored.length) % scored.length];
      return toResult(piecesOf[pick.move.index], pick.move);
    }
    scored.sort((a, b) => b.value - a.value || a.move.index - b.move.index);
    const pool = scored.slice(0, Math.max(1, settings.pickAmongTop));
    // Only choose among near-equal moves, never trade a win/loss for variety.
    const bestValue = pool[0].value;
    const candidates = pool.filter((entry) => bestValue - entry.value <= 30 && Math.abs(entry.value) < WIN / 2);
    const chosen = candidates.length > 1
      ? candidates[Math.floor(settings.rng() * candidates.length) % candidates.length]
      : pool[0];
    return toResult(piecesOf[chosen.move.index], chosen.move);
  }

  return { chooseMove, LEVELS, DEFAULT_LEVEL };
});
