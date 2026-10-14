/**
 * apps/arena-api/src/routes/competitions.mjs
 *
 * Competition lifecycle and event orchestration routes (base /api/arena/v1/competitions).
 *
 * Routes:
 * - GET    /api/arena/v1/competitions: List competitions
 * - POST   /api/arena/v1/competitions: Create competition (admin only)
 * - GET    /api/arena/v1/competitions/:id: Detail with entries and linked tournamentId
 * - POST   /api/arena/v1/competitions/:id/register: Author registers for competition (idempotent per user)
 * - POST   /api/arena/v1/competitions/:id/entries/:userId/review: Admin accepts/declines participant entry
 * - POST   /api/arena/v1/competitions/:id/submission: Author selects owned READY bot version
 * - POST   /api/arena/v1/competitions/:id/advance: Admin advances lifecycle phase
 * - POST   /api/arena/v1/competitions/:id/matches/:scheduleIndex/retry: Admin retries failed match
 */

import { authenticate, checkRole } from "../auth/authorization.mjs";
import { sendJson, sendError, parseJsonBody } from "../http-server.mjs";
import {
  CompetitionValidationError,
  CompetitionPhaseError,
  CompetitionCapacityError,
  BotNotReadyError,
  ForbiddenError,
  NotFoundError,
  IdempotencyConflictError
} from "../../../../packages/arena-node/src/persistence/competition-repository.mjs";

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

function assertStrictFields(body, allowedFields, actionName) {
  if (hasForbiddenShellPathFields(body)) {
    throw new CompetitionValidationError("Shell and filesystem path fields are forbidden", "INVALID_PAYLOAD");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CompetitionValidationError(`Invalid body for ${actionName}: expected JSON object`);
  }
  for (const k of Object.keys(body)) {
    if (!allowedFields.has(k)) {
      throw new CompetitionValidationError(`Unexpected field '${k}' in ${actionName} payload`);
    }
  }
}

export async function handleCompetitionsRoute(req, res, ctx) {
  const { db, competitionRepo, parsedUrl, maxBodyBytes } = ctx;
  const pathname = parsedUrl.pathname;

  // 1. Authenticate user for all competition routes
  const auth = authenticate(req, db);
  if (!auth.ok) {
    return sendError(res, auth.statusCode, auth.error.code, auth.error.message, {}, req);
  }
  const user = req.user;

  try {
    // ── /api/arena/v1/competitions ────────────────────────────────────────────
    if (pathname === "/api/arena/v1/competitions" || pathname === "/api/arena/v1/competitions/") {
      if (req.method === "GET") {
        const limit = parsedUrl.searchParams.get("limit") || 50;
        const offset = parsedUrl.searchParams.get("offset") || 0;
        const competitions = competitionRepo.listCompetitions({ limit, offset });
        return sendJson(res, 200, { competitions });
      }

      if (req.method === "POST") {
        const roleCheck = checkRole(user, ["admin"]);
        if (!roleCheck.ok) {
          return sendError(res, 403, "FORBIDDEN", "Only administrators can create competitions", {}, req);
        }

        let body;
        try {
          body = await parseJsonBody(req, maxBodyBytes);
        } catch (err) {
          return sendError(res, err.statusCode || 400, err.code || "BAD_REQUEST", err.message, {}, req);
        }

        assertStrictFields(body, new Set(["name", "description", "capacity", "ranked"]), "create competition");

        const name = body.name ? String(body.name).trim() : "";
        if (name.length === 0) {
          return sendError(res, 422, "VALIDATION_ERROR", "Field 'name' is required and cannot be empty", {}, req);
        }
        if (name.length > 255) {
          return sendError(res, 422, "VALIDATION_ERROR", "Field 'name' cannot exceed 255 characters", {}, req);
        }

        let capacity = 16;
        if (body.capacity !== undefined && body.capacity !== null) {
          if (typeof body.capacity !== "number" || !Number.isInteger(body.capacity) || body.capacity < 2 || body.capacity > 128) {
            return sendError(res, 422, "VALIDATION_ERROR", "Field 'capacity' must be an integer between 2 and 128", {}, req);
          }
          capacity = body.capacity;
        }

        if (body.ranked !== undefined && typeof body.ranked !== "boolean") {
          return sendError(res, 422, "VALIDATION_ERROR", "Field 'ranked' must be a boolean", {}, req);
        }

        const idempotencyKey = req.headers["idempotency-key"] || req.headers["Idempotency-Key"];

        const competition = competitionRepo.createCompetition(
          {
            name,
            description: body.description,
            capacity,
            ranked: body.ranked !== undefined ? Boolean(body.ranked) : true
          },
          {
            actorId: user.id,
            idempotencyKey: idempotencyKey ? String(idempotencyKey).trim() : undefined
          }
        );

        return sendJson(res, 201, { competition });
      }

      res.setHeader("Allow", "GET, POST");
      return sendError(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed on /competitions`, {}, req);
    }

    // ── /api/arena/v1/competitions/:id/register ─────────────────────────────
    const registerMatch = pathname.match(/^\/api\/arena\/v1\/competitions\/([^/]+)\/register\/?$/);
    if (registerMatch) {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return sendError(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed. Expected POST`, {}, req);
      }

      const competitionId = registerMatch[1];
      const roleCheck = checkRole(user, ["author", "admin"]);
      if (!roleCheck.ok) {
        return sendError(res, 403, "FORBIDDEN", "Only authors and admins can register for competitions", {}, req);
      }

      let body;
      try {
        body = await parseJsonBody(req, maxBodyBytes);
      } catch (err) {
        return sendError(res, err.statusCode || 400, err.code || "BAD_REQUEST", err.message, {}, req);
      }
      assertStrictFields(body, new Set([]), "register");

      const entry = competitionRepo.registerEntry(competitionId, user.id);
      return sendJson(res, 200, { entry });
    }

    // ── /api/arena/v1/competitions/:id/entries/:userId/review ───────────────
    const reviewMatch = pathname.match(/^\/api\/arena\/v1\/competitions\/([^/]+)\/entries\/([^/]+)\/review\/?$/);
    if (reviewMatch) {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return sendError(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed. Expected POST`, {}, req);
      }

      const competitionId = reviewMatch[1];
      const targetUserId = reviewMatch[2];

      const roleCheck = checkRole(user, ["admin"]);
      if (!roleCheck.ok) {
        return sendError(res, 403, "FORBIDDEN", "Only administrators can review competition entries", {}, req);
      }

      let body;
      try {
        body = await parseJsonBody(req, maxBodyBytes);
      } catch (err) {
        return sendError(res, err.statusCode || 400, err.code || "BAD_REQUEST", err.message, {}, req);
      }

      assertStrictFields(body, new Set(["accepted"]), "review");

      if (body.accepted === undefined || typeof body.accepted !== "boolean") {
        return sendError(res, 422, "VALIDATION_ERROR", "Field 'accepted' must be a boolean", {}, req);
      }

      const entry = competitionRepo.reviewEntry(competitionId, targetUserId, body.accepted);
      return sendJson(res, 200, { entry });
    }

    // ── /api/arena/v1/competitions/:id/submission ───────────────────────────
    const submissionMatch = pathname.match(/^\/api\/arena\/v1\/competitions\/([^/]+)\/submission\/?$/);
    if (submissionMatch) {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return sendError(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed. Expected POST`, {}, req);
      }

      const competitionId = submissionMatch[1];

      const roleCheck = checkRole(user, ["author", "admin"]);
      if (!roleCheck.ok) {
        return sendError(res, 403, "FORBIDDEN", "Only authors and admins can submit bot versions", {}, req);
      }

      let body;
      try {
        body = await parseJsonBody(req, maxBodyBytes);
      } catch (err) {
        return sendError(res, err.statusCode || 400, err.code || "BAD_REQUEST", err.message, {}, req);
      }

      assertStrictFields(body, new Set(["botVersionId"]), "submission");

      const botVersionId = body.botVersionId ? String(body.botVersionId).trim() : "";
      if (!botVersionId) {
        return sendError(res, 422, "VALIDATION_ERROR", "Field 'botVersionId' is required", {}, req);
      }

      const entry = competitionRepo.submitBotVersion(competitionId, user.id, botVersionId);
      return sendJson(res, 200, { entry });
    }

    // ── /api/arena/v1/competitions/:id/advance ──────────────────────────────
    const advanceMatch = pathname.match(/^\/api\/arena\/v1\/competitions\/([^/]+)\/advance\/?$/);
    if (advanceMatch) {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return sendError(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed. Expected POST`, {}, req);
      }

      const competitionId = advanceMatch[1];

      const roleCheck = checkRole(user, ["admin"]);
      if (!roleCheck.ok) {
        return sendError(res, 403, "FORBIDDEN", "Only administrators can advance competition phases", {}, req);
      }

      let body;
      try {
        body = await parseJsonBody(req, maxBodyBytes);
      } catch (err) {
        return sendError(res, err.statusCode || 400, err.code || "BAD_REQUEST", err.message, {}, req);
      }

      assertStrictFields(body, new Set(["expectedPhase"]), "advance");

      const expectedPhase = body.expectedPhase ? String(body.expectedPhase).trim() : "";
      if (!expectedPhase) {
        return sendError(res, 422, "VALIDATION_ERROR", "Field 'expectedPhase' is required", {}, req);
      }

      const competition = competitionRepo.advancePhase(competitionId, expectedPhase);
      return sendJson(res, 200, { competition });
    }

    // ── /api/arena/v1/competitions/:id/matches/:scheduleIndex/retry ──────────
    const retryMatch = pathname.match(/^\/api\/arena\/v1\/competitions\/([^/]+)\/matches\/([^/]+)\/retry\/?$/);
    if (retryMatch) {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return sendError(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed. Expected POST`, {}, req);
      }

      const competitionId = retryMatch[1];
      const scheduleIndexRaw = retryMatch[2];

      const roleCheck = checkRole(user, ["admin"]);
      if (!roleCheck.ok) {
        return sendError(res, 403, "FORBIDDEN", "Only administrators can retry matches", {}, req);
      }

      let body;
      try {
        body = await parseJsonBody(req, maxBodyBytes);
      } catch (err) {
        return sendError(res, err.statusCode || 400, err.code || "BAD_REQUEST", err.message, {}, req);
      }
      assertStrictFields(body, new Set([]), "retry");

      if (!/^\d+$/.test(scheduleIndexRaw)) {
        return sendError(res, 422, "VALIDATION_ERROR", "scheduleIndex must be a non-negative integer", {}, req);
      }

      const scheduleIndex = Number(scheduleIndexRaw);
      if (!Number.isSafeInteger(scheduleIndex) || scheduleIndex < 0 || scheduleIndex > 65535) {
        return sendError(res, 422, "VALIDATION_ERROR", "scheduleIndex out of bounds (0..65535)", {}, req);
      }

      const result = competitionRepo.retryCompetitionMatch(competitionId, scheduleIndex);
      return sendJson(res, 200, result);
    }

    // ── /api/arena/v1/competitions/:id ────────────────────────────────────────
    const detailMatch = pathname.match(/^\/api\/arena\/v1\/competitions\/([^/]+)\/?$/);
    if (detailMatch) {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return sendError(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed. Expected GET`, {}, req);
      }

      const competitionId = detailMatch[1];
      const detail = competitionRepo.getCompetitionWithEntries(competitionId);
      if (!detail) {
        return sendError(res, 404, "NOT_FOUND", `Competition not found: ${competitionId}`, {}, req);
      }

      return sendJson(res, 200, detail);
    }

    return sendError(res, 404, "NOT_FOUND", `Endpoint not found: ${pathname}`, {}, req);
  } catch (err) {
    if (err.code === "INVALID_PAYLOAD") {
      return sendError(res, 400, "INVALID_PAYLOAD", err.message, {}, req);
    }
    if (err instanceof NotFoundError || err.code === "NOT_FOUND") {
      return sendError(res, 404, "NOT_FOUND", err.message, {}, req);
    }
    if (err instanceof ForbiddenError || err.code === "FORBIDDEN") {
      return sendError(res, 403, "FORBIDDEN", err.message, {}, req);
    }
    if (err instanceof CompetitionPhaseError || err.code === "PHASE_MISMATCH") {
      return sendError(res, 409, "PHASE_MISMATCH", err.message, {}, req);
    }
    if (err instanceof CompetitionCapacityError || err.code === "CAPACITY_EXCEEDED") {
      return sendError(res, 409, "CAPACITY_EXCEEDED", err.message, {}, req);
    }
    if (err instanceof IdempotencyConflictError || err.code === "IDEMPOTENCY_CONFLICT") {
      return sendError(res, 409, "IDEMPOTENCY_CONFLICT", err.message, {}, req);
    }
    if (err instanceof BotNotReadyError || err.code === "BOT_VERSION_NOT_READY") {
      return sendError(res, 422, "BOT_VERSION_NOT_READY", err.message, {}, req);
    }
    if (err instanceof CompetitionValidationError || err.code === "VALIDATION_ERROR" || err.code === "TOURNAMENT_VALIDATION_ERROR") {
      return sendError(res, 422, err.code || "VALIDATION_ERROR", err.message, {}, req);
    }
    return sendError(res, 500, "INTERNAL_ERROR", err.message, {}, req);
  }
}
