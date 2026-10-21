/**
 * packages/arena-node/src/persistence/competition-standings-calculator.mjs
 *
 * Standings aggregation and history helper for Arena extended competitions.
 *
 * Requirements:
 * - Aggregates child tournament standings across all rounds of an extended competition.
 * - Adds persisted bye points (Swiss = 3 pts, Round-Robin rest = 0 pts).
 * - Exposes seatBalance (Seat A matches minus Seat B matches).
 * - Stable rank ordering: Points DESC, Wins DESC, botId ASC.
 * - Extracts match pairing history per round for Swiss and RR pairing algorithms.
 */

/**
 * Computes aggregated standings for an extended competition across all played rounds.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} competitionId
 * @param {Array<{ botId: string, botName?: string }>} [entries=[]]
 * @returns {Array<{ botId: string, botName: string, points: number, wins: number, draws: number, losses: number, played: number, byeCount: number, seatBalance: number }>}
 */
export function computeExtendedStandings(db, competitionId, entries = []) {
  if (!db) {
    throw new TypeError("computeExtendedStandings requires a database instance");
  }

  // 1. Query child tournament standings aggregation
  const childStandingsRows = db.prepare(`
    SELECT
      ts.bot_id,
      COALESCE(SUM(ts.played), 0) AS played,
      COALESCE(SUM(ts.wins), 0) AS wins,
      COALESCE(SUM(ts.draws), 0) AS draws,
      COALESCE(SUM(ts.losses), 0) AS losses,
      COALESCE(SUM(ts.points), 0) AS match_points
    FROM tournament_standings ts
    JOIN competition_rounds cr ON cr.tournament_id = ts.tournament_id
    WHERE cr.competition_id = ?
    GROUP BY ts.bot_id
  `).all(competitionId);

  const childStandingsMap = new Map();
  for (const row of childStandingsRows) {
    childStandingsMap.set(row.bot_id, row);
  }

  // 2. Query persisted byes aggregation
  const byeRows = db.prepare(`
    SELECT
      bot_id,
      COUNT(*) AS bye_count,
      COALESCE(SUM(points), 0) AS bye_points
    FROM competition_round_byes
    WHERE competition_id = ?
    GROUP BY bot_id
  `).all(competitionId);

  const byesMap = new Map();
  for (const row of byeRows) {
    byesMap.set(row.bot_id, row);
  }

  // 3. Query seat balances across all matches in this competition
  const seatRows = db.prepare(`
    SELECT
      mp.bot_id,
      COALESCE(SUM(CASE WHEN mp.seat = 'A' THEN 1 WHEN mp.seat = 'B' THEN -1 ELSE 0 END), 0) AS seat_balance
    FROM match_participants mp
    JOIN matches m ON m.id = mp.match_id
    JOIN competition_rounds cr ON cr.tournament_id = m.tournament_id
    WHERE cr.competition_id = ?
    GROUP BY mp.bot_id
  `).all(competitionId);

  const seatBalanceMap = new Map();
  for (const row of seatRows) {
    seatBalanceMap.set(row.bot_id, row.seat_balance);
  }

  // 4. Combine results for all admitted participants
  const botMap = new Map();
  for (const entry of entries) {
    if (entry.botId) {
      botMap.set(entry.botId, entry.botName || entry.botId);
    }
  }

  // Also include any bots present in child standings or byes not in entries list
  for (const botId of childStandingsMap.keys()) {
    if (!botMap.has(botId)) botMap.set(botId, botId);
  }
  for (const botId of byesMap.keys()) {
    if (!botMap.has(botId)) botMap.set(botId, botId);
  }

  const standings = [];
  for (const [botId, botName] of botMap.entries()) {
    const stats = childStandingsMap.get(botId) || {
      played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      match_points: 0
    };
    const byeInfo = byesMap.get(botId) || { bye_count: 0, bye_points: 0 };
    const seatBalance = seatBalanceMap.get(botId) || 0;

    const totalPoints = Number(stats.match_points) + Number(byeInfo.bye_points);

    standings.push({
      botId,
      botName,
      points: totalPoints,
      wins: Number(stats.wins),
      draws: Number(stats.draws),
      losses: Number(stats.losses),
      played: Number(stats.played),
      byeCount: Number(byeInfo.bye_count),
      seatBalance: Number(seatBalance)
    });
  }

  // 5. Deterministic tiebreak: points DESC, wins DESC, botId ASC
  standings.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.wins !== a.wins) return b.wins - a.wins;
    return a.botId.localeCompare(b.botId);
  });

  return standings;
}

/**
 * Retrieves match history across all rounds of an extended competition.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} competitionId
 * @returns {Array<{ roundNumber: number, botAId: string, botBId: string }>}
 */
export function getCompetitionRoundHistory(db, competitionId) {
  if (!db) {
    throw new TypeError("getCompetitionRoundHistory requires a database instance");
  }

  const rounds = db.prepare(`
    SELECT round_number, pairings_json
    FROM competition_rounds
    WHERE competition_id = ?
    ORDER BY round_number ASC
  `).all(competitionId);

  const history = [];
  for (const r of rounds) {
    let pairings = [];
    try {
      pairings = JSON.parse(r.pairings_json);
    } catch {
      pairings = [];
    }
    if (Array.isArray(pairings)) {
      for (const p of pairings) {
        if (p && p.botAId && p.botBId) {
          history.push({
            roundNumber: r.round_number,
            botAId: p.botAId,
            botBId: p.botBId
          });
        }
      }
    }
  }

  return history;
}
