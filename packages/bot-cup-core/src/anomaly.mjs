/**
 * Result anomalies that may point to collusion (plan §8.7). Nothing here is a verdict: each row is a lead for the
 * organisers, who watch the replays and decide (plan §8.8). Pure.
 */

export const ANOMALY_POLICY = Object.freeze({
  /** Losses that look thrown: a fault, or a game over within this many plies (a goal needs more). */
  faultReasons: Object.freeze(["illegal_move", "crash", "protocol_error", "turn_timeout", "total_timeout", "output_limit"]),
  fastLossPlies: 12,
  /** The loser normally plays well: at least this share of points in its other team games... */
  strongElsewhere: 0.5,
  /** ...over at least this many games, with faults in at most this share of them. */
  minOtherGames: 4,
  maxFaultRateElsewhere: 0.1,
  /** Practice upset: the practice rates differ by this much, yet the favourite took at most this share of the pairing. */
  practiceGap: 0.4,
  upsetShare: 0.25,
  minPracticeGames: 4,
  /** Behaviour fingerprints this close between two teams (plan §8.7: usually the same author). */
  twinRatio: 0.9
});

const TEAM_STAGES = new Set(["round_robin", "swiss", "knockout"]);

function pointsFor(game, side) {
  if (game.outcome === "draw") return 0.5;
  return game.winner === side ? 1 : 0;
}

/**
 * @param {{
 *   games: Array<{ id: string, stage: string, a: string|null, b: string|null, status: string, outcome: string|null,
 *                  winner: "A"|"B"|null, loser: "A"|"B"|null, reason: string|null, plies: number|null }>,
 *   practice?: Map<string, { points: number, played: number }>,
 *   twins?: Array<{ team: string, other: string, ratio: number, compared: number }>,
 *   names?: Map<string, string>
 * }} input  team ids in a/b (null for a house bot); practice = each team's results against non-easy house bots
 * @returns {Array<object>} rows, most suspicious kinds first
 */
export function findAnomalies({ games, practice = new Map(), twins = [], names = new Map() }) {
  const name = (teamId) => names.get(teamId) ?? teamId;
  const played = games.filter((game) => TEAM_STAGES.has(game.stage) && game.status === "finished" && game.a && game.b);
  const rows = [];

  // 1. Thrown games: a fault or a very fast loss by a team that otherwise plays well and rarely faults.
  for (const game of played) {
    if (!game.loser) continue;
    const loser = game.loser === "A" ? game.a : game.b;
    const winner = game.loser === "A" ? game.b : game.a;
    const fault = ANOMALY_POLICY.faultReasons.includes(game.reason);
    const fast = game.plies !== null && game.plies <= ANOMALY_POLICY.fastLossPlies;
    if (!fault && !fast) continue;
    // "Elsewhere" = against other opponents, so several thrown games to the same team do not hide each other.
    const others = played.filter((other) => (other.a === loser || other.b === loser) && other.a !== winner && other.b !== winner);
    if (others.length < ANOMALY_POLICY.minOtherGames) continue;
    const share = others.reduce((sum, other) => sum + pointsFor(other, other.a === loser ? "A" : "B"), 0) / others.length;
    const faults = others.filter((other) => other.loser && (other.loser === "A" ? other.a : other.b) === loser && ANOMALY_POLICY.faultReasons.includes(other.reason)).length;
    if (share < ANOMALY_POLICY.strongElsewhere || faults / others.length > ANOMALY_POLICY.maxFaultRateElsewhere) continue;
    rows.push({
      kind: "thrown_game", matchId: game.id, stage: game.stage, team: loser, teamName: name(loser), opponent: winner, opponentName: name(winner),
      reason: game.reason, plies: game.plies, shareElsewhere: Math.round(share * 1000) / 1000, gamesElsewhere: others.length
    });
  }

  // 2. Pairings that go against practice form by a wide margin.
  const pairs = new Map();
  for (const game of played) {
    const key = [game.a, game.b].sort().join("|");
    const entry = pairs.get(key) ?? { teams: [game.a, game.b].sort(), points: new Map(), games: 0 };
    entry.games += 1;
    entry.points.set(game.a, (entry.points.get(game.a) ?? 0) + pointsFor(game, "A"));
    entry.points.set(game.b, (entry.points.get(game.b) ?? 0) + pointsFor(game, "B"));
    pairs.set(key, entry);
  }
  const rate = (teamId) => {
    const record = practice.get(teamId);
    return record && record.played >= ANOMALY_POLICY.minPracticeGames ? record.points / record.played : null;
  };
  for (const entry of pairs.values()) {
    const [x, y] = entry.teams;
    const [rx, ry] = [rate(x), rate(y)];
    if (rx === null || ry === null || Math.abs(rx - ry) < ANOMALY_POLICY.practiceGap) continue;
    const [favourite, underdog] = rx > ry ? [x, y] : [y, x];
    const share = (entry.points.get(favourite) ?? 0) / entry.games;
    if (share > ANOMALY_POLICY.upsetShare) continue;
    rows.push({
      kind: "practice_upset", team: favourite, teamName: name(favourite), opponent: underdog, opponentName: name(underdog),
      share: Math.round(share * 1000) / 1000, games: entry.games,
      practiceRate: Math.round(Math.max(rx, ry) * 1000) / 1000, opponentPracticeRate: Math.round(Math.min(rx, ry) * 1000) / 1000
    });
  }

  // 3. Two teams whose bots answer the secret positions almost identically.
  for (const twin of twins) {
    if (twin.ratio < ANOMALY_POLICY.twinRatio || twin.team === twin.other) continue;
    rows.push({ kind: "behaviour_twin", team: twin.team, teamName: name(twin.team), opponent: twin.other, opponentName: name(twin.other), ratio: twin.ratio, compared: twin.compared });
  }

  const order = { behaviour_twin: 0, thrown_game: 1, practice_upset: 2 };
  return rows.sort((p, q) => order[p.kind] - order[q.kind]);
}
