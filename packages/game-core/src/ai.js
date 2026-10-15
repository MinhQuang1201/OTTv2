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
  const GOAL = config.GOAL;

  function chebyshev(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  }

  function scoreMove(state, player, move) {
    const trial = rules.applyMove(state, player, move.from, move.to);
    if (!trial.ok) return -1000;
    let score = 0;
    if (trial.state.winner === player) return 1000000;
    if (trial.state.winner) return -1000000;
    for (const ev of trial.events) {
      if (ev.type === "capture") score += 40;
    }
    const goal = GOAL[player];
    score += (8 - chebyshev(move.to, goal)) * 2;
    const piece = state.pieces.find((p) => p.id === move.pieceId);
    if (piece) score += (8 - chebyshev(move.to, goal)) - (8 - chebyshev(piece, goal));
    // Evaluate legal replies through the same authority as real moves. Winning
    // threats dominate material and progress; the worst capture is one reply,
    // not the sum of mutually exclusive hypothetical captures.
    const opponent = player === "A" ? "B" : "A";
    let captureRisk = 0;
    for (const reply of rules.allMoves(trial.state, opponent)) {
      const response = rules.applyMove(trial.state, opponent, reply.from, reply.to);
      if (!response.ok) continue;
      if (response.state.winner === opponent) return -100000 + score;
      for (const event of response.events) {
        if (event.type === "capture") {
          captureRisk = Math.max(captureRisk, event.capturedId === move.pieceId ? 65 : 45);
        }
      }
    }
    score -= captureRisk;
    return score;
  }

  function chooseMove(state, player) {
    if (!state || state.winner || state.turn !== player) return null;
    const moves = rules.allMoves(state, player);
    if (!moves.length) {
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
