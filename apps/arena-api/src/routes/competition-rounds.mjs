/**
 * apps/arena-api/src/routes/competition-rounds.mjs
 *
 * Route handlers for Arena rounds, maps, and modes extensions.
 *
 * Endpoints:
 * - GET  /api/arena/v1/competition-catalog: Descriptors for maps, formats, modes, and default config.
 * - POST /api/arena/v1/competitions/:id/next-round: Admin-only explicit progression to next round.
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

export function assertStrictFields(body, allowedFields, actionName) {
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

/**
 * Handles GET /api/arena/v1/competition-catalog
 */
export async function handleCompetitionCatalogRoute(req, res, ctx) {
  const { db, competitionRoundsRepo } = ctx;

  const auth = authenticate(req, db);
  if (!auth.ok) {
    return sendError(res, auth.statusCode, auth.error.code, auth.error.message, {}, req);
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendError(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed. Expected GET`, {}, req);
  }

  try {
    if (!competitionRoundsRepo) {
      return sendError(res, 500, "INTERNAL_ERROR", "Competition rounds repository not available", {}, req);
    }

    const catalog = competitionRoundsRepo.getCompetitionCatalog();
    return sendJson(res, 200, catalog);
  } catch (err) {
    return handleRouteError(err, req, res);
  }
}

/**
 * Handles POST /api/arena/v1/competitions/:id/next-round
 */
export async function handleNextRoundRoute(req, res, ctx, competitionId) {
  const { db, competitionRoundsRepo, maxBodyBytes } = ctx;

  const auth = authenticate(req, db);
  if (!auth.ok) {
    return sendError(res, auth.statusCode, auth.error.code, auth.error.message, {}, req);
  }
  const user = req.user;

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendError(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed. Expected POST`, {}, req);
  }

  const roleCheck = checkRole(user, ["admin"]);
  if (!roleCheck.ok) {
    return sendError(res, 403, "FORBIDDEN", "Only administrators can advance to the next round", {}, req);
  }

  let body;
  try {
    body = await parseJsonBody(req, maxBodyBytes);
  } catch (err) {
    return sendError(res, err.statusCode || 400, err.code || "BAD_REQUEST", err.message, {}, req);
  }

  try {
    assertStrictFields(body, new Set(["expectedRound"]), "next-round");

    if (body.expectedRound === undefined || body.expectedRound === null) {
      return sendError(res, 422, "VALIDATION_ERROR", "Field 'expectedRound' is required", {}, req);
    }

    if (
      typeof body.expectedRound !== "number" ||
      !Number.isInteger(body.expectedRound) ||
      body.expectedRound < 1 ||
      body.expectedRound > 254
    ) {
      return sendError(res, 422, "VALIDATION_ERROR", "Field 'expectedRound' must be an integer between 1 and 254", {}, req);
    }

    const expRound = body.expectedRound;

    if (!competitionRoundsRepo) {
      return sendError(res, 500, "INTERNAL_ERROR", "Competition rounds repository not available", {}, req);
    }

    const competition = competitionRoundsRepo.nextRound(competitionId, expRound);
    return sendJson(res, 200, { competition });
  } catch (err) {
    return handleRouteError(err, req, res);
  }
}

export function handleRouteError(err, req, res) {
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
  if (
    err instanceof CompetitionValidationError ||
    err.code === "VALIDATION_ERROR" ||
    err.code === "TOURNAMENT_VALIDATION_ERROR"
  ) {
    return sendError(res, 422, err.code || "VALIDATION_ERROR", err.message, {}, req);
  }
  return sendError(res, 500, "INTERNAL_ERROR", err.message, {}, req);
}
