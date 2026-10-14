/**
 * apps/arena-api/src/routes/matches.mjs
 *
 * Match scheduling, status tracking, and replay retrieval (base /api/arena/v1/matches).
 *
 * Routes:
 * - POST /api/arena/v1/matches: Schedule match (admin for ranked; user for practice with ready pins).
 * - GET /api/arena/v1/matches: Paginated match list.
 * - GET /api/arena/v1/matches/:id: Match status, pinned participant metadata, and result.
 * - GET /api/arena/v1/matches/:id/replay: Finalized replay document and digests; HTTP 409 if pending.
 */

import { createHash } from "node:crypto";
import { authenticate } from "../auth/authorization.mjs";
import { sendJson, sendError, parseJsonBody } from "../http-server.mjs";
import {
  IdempotencyConflictError,
  MatchValidationError,
  OwnershipError,
  NotFoundError
} from "../../../../packages/arena-node/src/persistence/match-repository.mjs";
import {
  DEFAULT_MATCH_POLICY,
  validateMatchPolicy,
  isSupportedEngineRuleset,
  checkInitialState,
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

export async function handleMatchesRoute(req, res, ctx) {
  const { db, matchRepo, jobQueue, parsedUrl, maxBodyBytes } = ctx;
  const pathname = parsedUrl.pathname;

  // 1. Authenticate user
  const auth = authenticate(req, db);
  if (!auth.ok) {
    return sendError(res, auth.statusCode, auth.error.code, auth.error.message, {}, req);
  }
  const user = req.user;

  // ── GET /api/arena/v1/matches ─────────────────────────────────────────────
  if (req.method === "GET" && pathname === "/api/arena/v1/matches") {
    const limitParam = parseInt(parsedUrl.searchParams.get("limit") || "20", 10);
    const limit = Math.max(1, Math.min(100, isNaN(limitParam) ? 20 : limitParam));
    const offsetParam = parseInt(parsedUrl.searchParams.get("offset") || "0", 10);
    const offset = Math.max(0, isNaN(offsetParam) ? 0 : offsetParam);

    const ladderId = parsedUrl.searchParams.get("ladderId") || undefined;
    const status = parsedUrl.searchParams.get("status") || undefined;
    const kind = parsedUrl.searchParams.get("kind") || undefined;
    const tournamentId = parsedUrl.searchParams.get("tournamentId") || undefined;

    const matches = matchRepo.listMatches({
      ladderId,
      status,
      kind,
      tournamentId,
      limit,
      offset
    });

    const totalCount = db
      .prepare(
        "SELECT COUNT(*) AS total FROM matches WHERE (? IS NULL OR ladder_id = ?) AND (? IS NULL OR status = ?) AND (? IS NULL OR kind = ?) AND (? IS NULL OR tournament_id = ?)"
      )
      .get(
        ladderId || null,
        ladderId || null,
        status || null,
        status || null,
        kind || null,
        kind || null,
        tournamentId || null,
        tournamentId || null
      ).total;

    return sendJson(res, 200, {
      matches: matches.map((m) => ({
        id: m.id,
        kind: m.kind,
        ladderId: m.ladder_id,
        status: m.status,
        tournamentId: m.tournament_id,
        scheduleIndex: m.schedule_index,
        settledAt: m.settled_at,
        settlementSeq: m.settlement_seq,
        createdAt: m.created_at
      })),
      total: totalCount,
      limit,
      offset
    });
  }

  // ── POST /api/arena/v1/matches ────────────────────────────────────────────
  if (req.method === "POST" && pathname === "/api/arena/v1/matches") {
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

    const kind = body.kind;
    if (kind !== "ranked" && kind !== "practice") {
      return sendError(res, 422, "INVALID_MATCH_KIND", "Match kind must be 'ranked' or 'practice'", {}, req);
    }

    // Role check: ranked matches are admin-only
    if (kind === "ranked" && user.role !== "admin") {
      return sendError(
        res,
        403,
        "FORBIDDEN",
        "Only administrators can schedule ranked matches; authors may schedule practice matches.",
        {},
        req
      );
    }

    // Normalize participants
    let pA = body.participants?.A || (body.botA ? { botVersionId: body.botA.botVersionId || body.botA.versionId } : null);
    let pB = body.participants?.B || (body.botB ? { botVersionId: body.botB.botVersionId || body.botB.versionId } : null);

    if (Array.isArray(body.participants)) {
      for (const p of body.participants) {
        if (p.seat === "A") pA = p;
        if (p.seat === "B") pB = p;
      }
    }

    if (!pA?.botVersionId || !pB?.botVersionId) {
      return sendError(
        res,
        422,
        "VALIDATION_ERROR",
        "Both participants (seat A and seat B) must specify a botVersionId",
        {},
        req
      );
    }

    // Check version readiness before scheduling
    const verA = db.prepare("SELECT * FROM bot_versions WHERE id = ?").get(pA.botVersionId);
    if (!verA) {
      return sendError(res, 404, "NOT_FOUND", `Bot version not found: ${pA.botVersionId}`, {}, req);
    }
    const verB = db.prepare("SELECT * FROM bot_versions WHERE id = ?").get(pB.botVersionId);
    if (!verB) {
      return sendError(res, 404, "NOT_FOUND", `Bot version not found: ${pB.botVersionId}`, {}, req);
    }

    if (verA.build_status !== "ready" || verB.build_status !== "ready") {
      return sendError(
        res,
        422,
        "BOT_VERSION_NOT_READY",
        "Both bot versions must be READY to schedule a match",
        {
          botAStatus: verA.build_status,
          botBStatus: verB.build_status
        },
        req
      );
    }

    if (kind === "ranked" && verA.bot_id === verB.bot_id) {
      return sendError(
        res,
        422,
        "RANKED_DISTINCT_BOTS_REQUIRED",
        "Ranked match requires distinct bots for seats A and B",
        {},
        req
      );
    }

    const engine = createNodeEngine();
    const defaultRuleset = createCurrentRulesetSnapshot(coreConfig);
    const defaultInitialState = engine.createInitialState();

    // 1. Policy validation upfront before any match/job DB writes
    let candidatePolicy = body.policyJson ?? body.policy ?? DEFAULT_MATCH_POLICY;
    if (typeof candidatePolicy === "string") {
      try {
        candidatePolicy = JSON.parse(candidatePolicy);
      } catch (_) {
        return sendError(res, 400, "INVALID_PAYLOAD", "policyJson must be valid JSON", {}, req);
      }
    }
    const policyVal = validateMatchPolicy(candidatePolicy);
    if (!policyVal.ok) {
      return sendError(
        res,
        422,
        "VALIDATION_ERROR",
        `Invalid match policy: ${policyVal.errors.map((e) => e.message).join("; ")}`,
        { errors: policyVal.errors },
        req
      );
    }

    // 2. Ruleset validation upfront
    let candidateRuleset = body.rulesetJson ?? body.ruleset ?? defaultRuleset;
    if (typeof candidateRuleset === "string") {
      try {
        candidateRuleset = JSON.parse(candidateRuleset);
      } catch (_) {
        return sendError(res, 400, "INVALID_PAYLOAD", "rulesetJson must be valid JSON", {}, req);
      }
    }
    if (!isSupportedEngineRuleset(candidateRuleset)) {
      return sendError(
        res,
        422,
        "VALIDATION_ERROR",
        "Invalid or unsupported ruleset snapshot",
        {},
        req
      );
    }

    // 3. Initial core state validation upfront
    let candidateState = body.initialStateJson ?? body.initialState ?? defaultInitialState;
    if (typeof candidateState === "string") {
      try {
        candidateState = JSON.parse(candidateState);
      } catch (_) {
        return sendError(res, 400, "INVALID_PAYLOAD", "initialStateJson must be valid JSON", {}, req);
      }
    }
    const stateError = checkInitialState(candidateState, engine);
    if (stateError) {
      return sendError(
        res,
        422,
        "VALIDATION_ERROR",
        `Invalid initial game state: ${stateError}`,
        { code: stateError },
        req
      );
    }

    try {
      const matchId =
        body.id ||
        `match-${createHash("sha256").update(`${user.id}:${idempotencyKey.trim()}`).digest("hex").slice(0, 16)}`;

      const match = matchRepo.createMatch(
        {
          id: matchId,
          kind,
          ladderId: body.ladderId || "ladder-main",
          rulesetJson: candidateRuleset,
          policyJson: candidatePolicy,
          profileJson: body.profileJson || body.profile || {},
          initialStateJson: candidateState,
          participants: { A: pA, B: pB }
        },
        {
          actorId: user.id,
          idempotencyKey: idempotencyKey.trim()
        }
      );

      // Enqueue job for worker execution
      if (jobQueue) {
        jobQueue.enqueueJob({
          kind: "match",
          targetId: match.id
        });
      }

      const participants = matchRepo.getMatchParticipants(match.id);

      return sendJson(res, 201, {
        match: {
          id: match.id,
          kind: match.kind,
          ladderId: match.ladder_id,
          status: match.status,
          participants
        }
      });
    } catch (err) {
      if (err instanceof IdempotencyConflictError || err.code === "IDEMPOTENCY_CONFLICT") {
        return sendError(res, 409, "IDEMPOTENCY_CONFLICT", err.message, {}, req);
      }
      if (err instanceof OwnershipError || err.code === "OWNERSHIP_DENIED") {
        return sendError(res, 403, "OWNERSHIP_DENIED", err.message, {}, req);
      }
      if (err instanceof MatchValidationError || err.code === "MATCH_VALIDATION_ERROR") {
        return sendError(res, 422, err.code, err.message, {}, req);
      }
      if (err instanceof NotFoundError || err.code === "NOT_FOUND") {
        return sendError(res, 404, "NOT_FOUND", err.message, {}, req);
      }
      return sendError(res, 500, "INTERNAL_ERROR", err.message, {}, req);
    }
  }

  // ── GET /api/arena/v1/matches/:id/replay ──────────────────────────────────
  const replayMatch = pathname.match(/^\/api\/arena\/v1\/matches\/([^/]+)\/replay\/?$/);
  if (replayMatch) {
    const matchId = replayMatch[1];
    const match = matchRepo.getMatch(matchId);
    if (!match) {
      return sendError(res, 404, "NOT_FOUND", `Match not found: ${matchId}`, {}, req);
    }

    const matchResult = matchRepo.getMatchResult(matchId);
    if (!matchResult) {
      return sendError(
        res,
        409,
        "MATCH_NOT_FINALIZED",
        `Match ${matchId} has not finalized yet (status: ${match.status})`,
        { status: match.status },
        req
      );
    }

    let replayDoc;
    try {
      replayDoc = JSON.parse(matchResult.replay_json);
    } catch (err) {
      return sendError(res, 500, "CORRUPT_REPLAY", "Failed to deserialize stored replay document", {}, req);
    }

    return sendJson(
      res,
      200,
      {
        matchId: matchResult.match_id,
        replayDigest: matchResult.replay_digest,
        completionDigest: matchResult.completion_digest,
        replay: replayDoc
      },
      {
        ETag: `"${matchResult.replay_digest}"`
      }
    );
  }

  // ── GET /api/arena/v1/matches/:id ─────────────────────────────────────────
  const matchDetails = pathname.match(/^\/api\/arena\/v1\/matches\/([^/]+)\/?$/);
  if (matchDetails) {
    const matchId = matchDetails[1];
    const match = matchRepo.getMatch(matchId);
    if (!match) {
      return sendError(res, 404, "NOT_FOUND", `Match not found: ${matchId}`, {}, req);
    }

    const participants = matchRepo.getMatchParticipants(matchId);
    const resultRow = matchRepo.getMatchResult(matchId);
    let result = null;
    if (resultRow) {
      try {
        result = JSON.parse(resultRow.result_json);
      } catch (_) {}
    }

    return sendJson(res, 200, {
      match: {
        id: match.id,
        kind: match.kind,
        ladderId: match.ladder_id,
        status: match.status,
        tournamentId: match.tournament_id,
        scheduleIndex: match.schedule_index,
        settledAt: match.settled_at,
        settlementSeq: match.settlement_seq,
        createdAt: match.created_at,
        participants,
        result
      }
    });
  }

  return sendError(res, 404, "NOT_FOUND", `Endpoint not found: ${pathname}`, {}, req);
}
