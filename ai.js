(function (global, factory) {
  const rules =
    typeof module === "object" && module.exports
      ? require("./rules")
      : global.OTT_RULES;
  const config =
    typeof module === "object" && module.exports
      ? require("./config")
      : global.OTT_CONFIG;
  const api = factory(rules, config);
  if (typeof module === "object" && module.exports) module.exports = api;
  global.OTT_AI = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (rules, config) {
  const GOAL = config.GOAL;

  function chebyshev(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  }

  function scoreMove(state, player, move) {
    const trial = rules.applyMove(state, player, move.from, move.to);
    if (!trial.ok) return -1000;
    let score = 0;
    if (trial.state.winner === player) score += 10000;
    if (trial.state.winner && trial.state.winner !== player) score -= 8000;
    for (const ev of trial.events) {
      if (ev.type === "capture") score += 40;
      if (ev.type === "strike_loss") score -= 35;
    }
    const goal = GOAL[player];
    score += (8 - chebyshev(move.to, goal)) * 2;
    const piece = state.pieces.find((p) => p.id === move.pieceId);
    if (piece) score += (8 - chebyshev(move.to, goal)) - (8 - chebyshev(piece, goal));
    score += Math.random() * 0.4;
    return score;
  }

  function chooseMove(state, player) {
    const moves = rules.allMoves(state, player);
    if (!moves.length) {
      if (!state.winner && typeof console !== "undefined" && console.error) {
        console.error("AI không có nước đi trong thế chưa kết thúc");
      }
      return null;
    }
    let best = moves[0];
    let bestScore = -Infinity;
    for (const move of moves) {
      const s = scoreMove(state, player, move);
      if (s > bestScore) {
        bestScore = s;
        best = move;
      }
    }
    return best;
  }

  return { chooseMove };
});
