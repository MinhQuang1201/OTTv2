/**
 * apps/arena-api/src/routes/bots.mjs
 *
 * Bot & Version management endpoints (base /api/arena/v1/bots).
 *
 * Routes:
 * - GET /api/arena/v1/bots: Paginated list of bots (author sees owned + public active; admin sees all).
 * - POST /api/arena/v1/bots: Creates a stable bot. Requires Idempotency-Key. Owner is req.user.id.
 * - GET /api/arena/v1/bots/:id/versions: Lists versions with bounded logs. Owner/admin only.
 * - GET /api/arena/v1/bots/:id/ready-versions: Lists active bot's ready versions (public metadata only). Any authenticated role.
 * - POST /api/arena/v1/bots/:id/versions: Uploads source inline UTF-8, enqueues build job.
 *     In trusted mode: restricted to admin (author cannot submit arbitrary source).
 *     Rejects shell/path parameters. Requires Idempotency-Key.
 */

import { createHash } from "node:crypto";
import { authenticate, checkOwnershipOrAdmin } from "../auth/authorization.mjs";
import { sendJson, sendError, parseJsonBody } from "../http-server.mjs";
import {
  IdempotencyConflictError,
  OwnershipError,
  NotFoundError
} from "../../../../packages/arena-node/src/persistence/bot-repository.mjs";
import {
  ProfileUnavailableError,
  PayloadTooLargeError
} from "../../../../packages/arena-node/src/persistence/bot-version-service.mjs";

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

export async function handleBotsRoute(req, res, ctx) {
  const { db, botRepo, botVersionService, parsedUrl, maxBodyBytes, trustedMode = true } = ctx;
  const pathname = parsedUrl.pathname;

  // 1. Authenticate user
  const auth = authenticate(req, db);
  if (!auth.ok) {
    return sendError(res, auth.statusCode, auth.error.code, auth.error.message, {}, req);
  }
  const user = req.user;

  // ── GET /api/arena/v1/bots ────────────────────────────────────────────────
  if (req.method === "GET" && pathname === "/api/arena/v1/bots") {
    const limitParam = parseInt(parsedUrl.searchParams.get("limit") || "20", 10);
    const limit = Math.max(1, Math.min(100, isNaN(limitParam) ? 20 : limitParam));
    const offsetParam = parseInt(parsedUrl.searchParams.get("offset") || "0", 10);
    const offset = Math.max(0, isNaN(offsetParam) ? 0 : offsetParam);

    let rows;
    let totalCount;

    if (user.role === "admin") {
      rows = db
        .prepare(
          "SELECT id, owner_id, name, status, created_at FROM bots ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?"
        )
        .all(limit, offset);
      totalCount = db.prepare("SELECT COUNT(*) AS total FROM bots").get().total;
    } else {
      rows = db
        .prepare(
          "SELECT id, owner_id, name, status, created_at FROM bots WHERE owner_id = ? OR status = 'active' ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?"
        )
        .all(user.id, limit, offset);
      totalCount = db
        .prepare("SELECT COUNT(*) AS total FROM bots WHERE owner_id = ? OR status = 'active'")
        .get(user.id).total;
    }

    return sendJson(res, 200, {
      bots: rows.map((r) => ({
        id: r.id,
        ownerId: r.owner_id,
        name: r.name,
        status: r.status,
        createdAt: r.created_at
      })),
      total: totalCount,
      limit,
      offset
    });
  }

  // ── POST /api/arena/v1/bots ───────────────────────────────────────────────
  if (req.method === "POST" && pathname === "/api/arena/v1/bots") {
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
    if (name.length === 0 || name.length > 255) {
      return sendError(res, 422, "VALIDATION_ERROR", "Bot name must be between 1 and 255 characters", {}, req);
    }

    if (body.id !== undefined) {
      if (typeof body.id !== "string") {
        return sendError(res, 400, "INVALID_PAYLOAD", "Bot id must be a string", {}, req);
      }
      const rawId = body.id.trim();
      if (rawId.length === 0) {
        return sendError(res, 422, "VALIDATION_ERROR", "Bot id cannot be empty", {}, req);
      }
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(rawId)) {
        return sendError(
          res,
          422,
          "VALIDATION_ERROR",
          "Bot id must be 1-64 alphanumeric characters, underscores, or hyphens and cannot contain slashes or whitespace",
          {},
          req
        );
      }
    }

    try {
      const botId =
        (typeof body.id === "string" && body.id.trim().length > 0 ? body.id.trim() : null) ||
        `bot-${createHash("sha256").update(`${user.id}:${idempotencyKey.trim()}`).digest("hex").slice(0, 16)}`;

      const bot = botRepo.createBot(
        { id: botId, ownerId: user.id, name },
        { idempotencyKey: idempotencyKey.trim(), actorId: user.id }
      );

      return sendJson(res, 201, {
        bot: {
          id: bot.id,
          ownerId: bot.owner_id,
          name: bot.name,
          status: bot.status,
          createdAt: bot.created_at
        }
      });
    } catch (err) {
      if (err instanceof IdempotencyConflictError || err.code === "IDEMPOTENCY_CONFLICT") {
        return sendError(res, 409, "IDEMPOTENCY_CONFLICT", err.message, {}, req);
      }
      if (err instanceof OwnershipError || err.code === "OWNERSHIP_DENIED") {
        return sendError(res, 403, "OWNERSHIP_DENIED", err.message, {}, req);
      }
      return sendError(res, 500, "INTERNAL_ERROR", err.message, {}, req);
    }
  }

  // ── Route matching: /api/arena/v1/bots/:id/versions ───────────────────────
  const versionsMatch = pathname.match(/^\/api\/arena\/v1\/bots\/([^/]+)\/versions\/?$/);
  if (versionsMatch) {
    const botId = versionsMatch[1];
    const bot = botRepo.getBot(botId);
    if (!bot) {
      return sendError(res, 404, "NOT_FOUND", `Bot not found: ${botId}`, {}, req);
    }

    // POST /bots/:id/versions
    if (req.method === "POST") {
      // Gate check in trusted mode
      if (trustedMode && user.role !== "admin") {
        return sendError(
          res,
          403,
          "SOURCE_SUBMISSION_DISABLED",
          "Source submission is disabled in trusted mode; admin-curated builds only until Task 19 isolation verification.",
          { canSubmitSource: false },
          req
        );
      }

      const ownershipCheck = checkOwnershipOrAdmin(user, bot.owner_id);
      if (!ownershipCheck.ok) {
        return sendError(res, ownershipCheck.statusCode, ownershipCheck.error.code, ownershipCheck.error.message, {}, req);
      }

      const idempotencyKey = req.headers["idempotency-key"] || req.headers["Idempotency-Key"];
      if (!idempotencyKey || typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
        return sendError(res, 400, "MISSING_IDEMPOTENCY_KEY", "Idempotency-Key header is required", {}, req);
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

      const source = typeof body.source === "string" ? body.source : null;
      if (!source || source.trim().length === 0) {
        return sendError(res, 422, "VALIDATION_ERROR", "Field 'source' must be a non-empty UTF-8 string", {}, req);
      }

      const profileId = typeof body.profileId === "string" ? body.profileId.trim() : "";
      if (!profileId) {
        return sendError(res, 422, "VALIDATION_ERROR", "Field 'profileId' is required", {}, req);
      }

      try {
        const uploadResult = await botVersionService.uploadBotVersion(
          {
            botId,
            sourceContent: source,
            profileId
          },
          {
            actorId: user.id,
            idempotencyKey: idempotencyKey.trim()
          }
        );

        const v = uploadResult.botVersion;
        return sendJson(res, 201, {
          version: {
            id: v.id,
            botId: v.bot_id,
            versionNo: v.version_no,
            sourceDigest: v.source_digest,
            profileId: v.profile_id,
            profileRevision: v.profile_revision,
            buildStatus: v.build_status,
            createdAt: v.created_at
          },
          job: uploadResult.job
            ? {
                id: uploadResult.job.id,
                kind: uploadResult.job.kind,
                status: uploadResult.job.status
              }
            : null
        });
      } catch (err) {
        if (err instanceof IdempotencyConflictError || err.code === "IDEMPOTENCY_CONFLICT") {
          return sendError(res, 409, "IDEMPOTENCY_CONFLICT", err.message, {}, req);
        }
        if (err instanceof OwnershipError || err.code === "OWNERSHIP_DENIED") {
          return sendError(res, 403, "OWNERSHIP_DENIED", err.message, {}, req);
        }
        if (err instanceof ProfileUnavailableError || err.code === "PROFILE_UNAVAILABLE") {
          return sendError(res, 422, "PROFILE_UNAVAILABLE", err.message, {}, req);
        }
        if (err instanceof PayloadTooLargeError || err.code === "PAYLOAD_TOO_LARGE") {
          return sendError(res, 413, "PAYLOAD_TOO_LARGE", err.message, {}, req);
        }
        return sendError(res, 500, "INTERNAL_ERROR", err.message, {}, req);
      }
    }

    // GET /bots/:id/versions
    if (req.method === "GET") {
      const ownershipCheck = checkOwnershipOrAdmin(user, bot.owner_id);
      if (!ownershipCheck.ok) {
        return sendError(res, ownershipCheck.statusCode, ownershipCheck.error.code, ownershipCheck.error.message, {}, req);
      }

      const versions = botRepo.listBotVersions(botId);
      return sendJson(res, 200, {
        versions: versions.map((v) => ({
          id: v.id,
          botId: v.bot_id,
          versionNo: v.version_no,
          sourceDigest: v.source_digest,
          profileId: v.profile_id,
          profileRevision: v.profile_revision,
          buildStatus: v.build_status,
          artifactDigest: v.artifact_digest || null,
          buildLog: v.build_log
            ? v.build_log.length > 65536
              ? v.build_log.slice(0, 65536) + " [truncated]"
              : v.build_log
            : null,
          createdAt: v.created_at
        }))
      });
    }
  }

  // ── Route matching: /api/arena/v1/bots/:id/ready-versions ─────────────────
  const readyVersionsMatch = pathname.match(/^\/api\/arena\/v1\/bots\/([^/]+)\/ready-versions\/?$/);
  if (readyVersionsMatch) {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return sendError(res, 405, "METHOD_NOT_ALLOWED", `Method ${req.method} not allowed. Expected GET`, {}, req);
    }

    const botId = readyVersionsMatch[1];
    const bot = botRepo.getBot(botId);
    if (!bot || bot.status !== "active") {
      return sendError(res, 404, "NOT_FOUND", `Bot not found or not active: ${botId}`, {}, req);
    }

    const versions = botRepo.listBotVersions(botId);
    const readyVersions = versions.filter((v) => v.build_status === "ready");

    return sendJson(res, 200, {
      versions: readyVersions.map((v) => ({
        id: v.id,
        botId: v.bot_id,
        versionNo: v.version_no,
        profileId: v.profile_id,
        buildStatus: "ready",
        createdAt: v.created_at
      }))
    });
  }

  return sendError(res, 404, "NOT_FOUND", `Endpoint not found: ${pathname}`, {}, req);
}

