/**
 * apps/arena-api/src/routes/tournaments.mjs
 *
 * Tournament creation, status tracking, and aggregate standings (base /api/arena/v1/tournaments).
 *
 * Routes:
 * - POST /api/arena/v1/tournaments: Double round-robin tournament scheduler (admin only, idempotency mandatory).
 * - GET /api/arena/v1/tournaments/:id: Schedule, matches status, and 3-1-0 points standings.
 */

import { createHash } from "node:crypto";
import { authenticate, checkRole } from "../auth/authorization.mjs";
import { sendJson, sendError, parseJsonBody } from "../http-server.mjs";
import {
  IdempotencyConflictError,
  TournamentValidationError
} from "../../../../packages/arena-node/src/persistence/tournament-repository.mjs";
import {
  DEFAULT_MATCH_POLICY,
  createCurrentRulesetSnapshot
} from "../../../../packages/arena/src/contracts/index.mjs";
import { createNodeEngine, coreConfig } from "../../../../packages/arena-node/src/core/node-engine.mjs";

const FORBIDDEN_SHELL_PATH_KEYS = new Set([
  "filepath",
  "file_path",
  "path",
  "command",
  "cmd",
  "shell",
  "executable",
  "binary",
  "scriptpath",
  "script_path"
]);

function hasForbiddenShellPathFields(obj) {
  if (!obj || typeof obj !== "object") return false;
  for (const k of Object.keys(obj)) {
    if (FORBIDDEN_SHELL_PATH_KEYS.has(k.toLowerCase())) {
      return true;
    }
  }
  return false;
}

export async function handleTournamentsRoute(req, res, ctx) {
  const { db, tournamentRepo, parsedUrl, maxBodyBytes } = ctx;
  const pathname = parsedUrl.pathname;

  // 1. Authenticate user
  const auth = authenticate(req, db);
  if (!auth.ok) {
    return sendError(res, auth.statusCode, auth.error.code, auth.error.message, {}, req);
  }
  const user = req.user;

  // ── POST /api/arena/v1/tournaments ────────────────────────────────────────
  if (req.method === "POST" && pathname === "/api/arena/v1/tournaments") {
    // Admin only
    const roleCheck = checkRole(user, ["admin"]);
    if (!roleCheck.ok) {
      return sendError(
        res,
        403,
        "FORBIDDEN",
        "Only administrators can create tournaments",
        {},
        req
      );
    }

    const idempotencyKey = req.headers["idempotency-key"] || req.headers["Idempotency-Key"];
    if (!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
      return sendError(res, 400, "MISSING_IDEMPOTENCY_KEY", "Idempotency-Key header is required", {}, req);
    }
    if (idempotencyKey.length > 256) {
      return sendError(res, 400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key exceeds 256 characters", {}, req);
    }

    let body;
    try {
      body = await parseJsonBody(req, maxBodyBytes);
    } catch (err) {
      return sendError(res, err.statusCode || 400, err.code || "BAD_REQUEST", err.message, {}, req);
    }

    if (hasForbiddenShellPathFields(body)) {
      return sendError(res, 400, "INVALID_PAYLOAD", "Shell and filesystem path fields are forbidden", {}, req);
    }

    const name = body.name ? String(body.name).trim() : "";
    if (name.length === 0) {
      return sendError(res, 422, "VALIDATION_ERROR", "Field 'name' is required and cannot be empty", {}, req);
    }

    if (!Array.isArray(body.entries) || body.entries.length < 2) {
      return sendError(
        res,
        422,
        "VALIDATION_ERROR",
        `Tournament requires at least 2 entries, got ${body.entries ? body.entries.length : 0}`,
        {},
        req
      );
    }

    // Verify all bot versions are READY and resolve botId
    const resolvedEntries = [];
    for (const entry of body.entries) {
      const verId = entry.botVersionId || entry.versionId;
      if (!verId) {
        return sendError(res, 422, "VALIDATION_ERROR", "Each entry must specify a botVersionId", {}, req);
      }
      const ver = db.prepare("SELECT * FROM bot_versions WHERE id = ?").get(verId);
      if (!ver) {
        return sendError(res, 404, "NOT_FOUND", `Bot version not found: ${verId}`, {}, req);
      }
      if (ver.build_status !== "ready") {
        return sendError(
          res,
          422,
          "BOT_VERSION_NOT_READY",
          `Bot version ${verId} is not ready (status: ${ver.build_status})`,
          {},
          req
        );
      }
      resolvedEntries.push({
        botId: entry.botId || ver.bot_id,
        botVersionId: verId
      });
    }

    const engine = createNodeEngine();
    const defaultRuleset = createCurrentRulesetSnapshot(coreConfig);
    const defaultInitialState = engine.createInitialState();

    try {
      const tournamentId =
        body.id ||
        `tourn-${createHash("sha256").update(`${user.id}:${idempotencyKey.trim()}`).digest("hex").slice(0, 16)}`;

      const tournament = tournamentRepo.createTournament(
        {
          id: tournamentId,
          name,
          ladderId: body.ladderId || "ladder-main",
          ranked: body.ranked !== undefined ? Boolean(body.ranked) : true,
          rulesetJson: body.rulesetJson || body.ruleset || defaultRuleset,
          policyJson: body.policyJson || body.policy || DEFAULT_MATCH_POLICY,
          initialStateJson: body.initialStateJson || body.initialState || defaultInitialState,
          entries: resolvedEntries
        },
        {
          actorId: user.id,
          idempotencyKey: idempotencyKey.trim()
        }
      );

      const matches = tournamentRepo.getTournamentMatches(tournament.id);

      return sendJson(res, 201, {
        tournament: {
          id: tournament.id,
          name: tournament.name,
          status: tournament.status,
          pointScheme: tournament.point_scheme,
          ranked: Boolean(tournament.ranked),
          createdAt: tournament.created_at
        },
        matchesCount: matches.length
      });
    } catch (err) {
      if (err instanceof IdempotencyConflictError || err.code === "IDEMPOTENCY_CONFLICT") {
        return sendError(res, 409, "IDEMPOTENCY_CONFLICT", err.message, {}, req);
      }
      if (err instanceof TournamentValidationError || err.code === "TOURNAMENT_VALIDATION_ERROR") {
        return sendError(res, 422, err.code, err.message, {}, req);
      }
      return sendError(res, 500, "INTERNAL_ERROR", err.message, {}, req);
    }
  }

  // ── GET /api/arena/v1/tournaments/:id ─────────────────────────────────────
  const tournamentMatch = pathname.match(/^\/api\/arena\/v1\/tournaments\/([^/]+)\/?$/);
  if (tournamentMatch) {
    const tournamentId = tournamentMatch[1];
    const tournament = tournamentRepo.getTournament(tournamentId);
    if (!tournament) {
      return sendError(res, 404, "NOT_FOUND", `Tournament not found: ${tournamentId}`, {}, req);
    }

    const standings = tournamentRepo.getTournamentStandings(tournamentId);
    const matches = tournamentRepo.getTournamentMatches(tournamentId);

    return sendJson(res, 200, {
      tournament: {
        id: tournament.id,
        name: tournament.name,
        status: tournament.status,
        pointScheme: tournament.point_scheme,
        ranked: Boolean(tournament.ranked),
        createdAt: tournament.created_at
      },
      standings,
      matches: matches.map((m) => ({
        id: m.id,
        scheduleIndex: m.schedule_index,
        kind: m.kind,
        status: m.status,
        settledAt: m.settled_at
      }))
    });
  }

  return sendError(res, 404, "NOT_FOUND", `Endpoint not found: ${pathname}`, {}, req);
}
