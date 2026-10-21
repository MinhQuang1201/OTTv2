/**
 * apps/arena-api/src/routes/leaderboard.mjs
 *
 * Leaderboard & Elo rating retrieval (base /api/arena/v1/leaderboard).
 *
 * Requirements:
 * - Reads backend rating/stats; never recalculates on client.
 * - Ladder-scoped ratings ordered by rating DESC.
 * - Standard competition ranking for ties.
 */

import { authenticateOptional } from "../auth/authorization.mjs";
import { sendJson, sendError } from "../http-server.mjs";

export async function handleLeaderboardRoute(req, res, ctx) {
  const { db, parsedUrl } = ctx;
  const pathname = parsedUrl.pathname;

  // 1. Authenticate user
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendError(res, 405, "METHOD_NOT_ALLOWED", "Only GET is allowed", {}, req);
  }
  const auth = authenticateOptional(req, db);
  if (!auth.ok && !auth.anonymous) {
    return sendError(res, auth.statusCode, auth.error.code, auth.error.message, {}, req);
  }

  if (req.method === "GET" && pathname === "/api/arena/v1/leaderboard") {
    const ladderId = parsedUrl.searchParams.get("ladderId");
    if (!ladderId || ladderId.trim().length === 0) {
      return sendError(
        res,
        422,
        "VALIDATION_ERROR",
        "Query parameter 'ladderId' is required",
        {},
        req
      );
    }

    const rows = db
      .prepare(`
        SELECT
          br.bot_id,
          b.name AS bot_name,
          b.owner_id,
          br.rating,
          br.rated_games,
          br.wins,
          br.draws,
          br.losses,
          br.updated_at
        FROM bot_ratings br
        JOIN bots b ON br.bot_id = b.id
        WHERE br.ladder_id = ?
        ORDER BY br.rating DESC, br.bot_id ASC
      `)
      .all(ladderId.trim());

    // Compute standard competition rank (1, 2, 2, 4...)
    let currentRank = 1;
    let previousRating = null;
    const ratings = rows.map((row, idx) => {
      if (previousRating !== null && row.rating !== previousRating) {
        currentRank = idx + 1;
      }
      previousRating = row.rating;

      return {
        rank: currentRank,
        botId: row.bot_id,
        botName: row.bot_name,
        ownerId: row.owner_id,
        rating: row.rating,
        ratedGames: row.rated_games,
        wins: row.wins,
        draws: row.draws,
        losses: row.losses,
        updatedAt: row.updated_at
      };
    });

    return sendJson(res, 200, {
      ladderId: ladderId.trim(),
      total: ratings.length,
      ratings
    });
  }

  return sendError(res, 404, "NOT_FOUND", `Endpoint not found: ${pathname}`, {}, req);
}
