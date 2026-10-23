/**
 * apps/arena-api/src/http-server.mjs
 *
 * HTTP server and route dispatcher for OTTv2 Arena API (base /api/arena/v1).
 *
 * Key guarantees:
 * - Independent Node http.Server (never mounts on server.js or Worker).
 * - Exact CORS allowlist enforcement.
 * - Trace request ID (X-Request-Id) generation and reflection.
 * - Bounded streaming JSON body parser (1 MiB default limit, HTTP 413).
 * - Structured JSON errors distinguishing 400, 401, 403, 404, 409, 413, 422, 429, 503.
 * - Token privacy (tokens in URLs forbidden, no tokens or private paths in error logs).
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";

import {
  verifyPassword,
  createSession,
  revokeSession,
  checkLoginRateLimit,
  recordLoginFailure,
  resetLoginFailure
} from "./auth/accounts.mjs";
import { authenticate, checkRole } from "./auth/authorization.mjs";
import { handleRegistration } from "./routes/auth.mjs";

import { handleBotsRoute } from "./routes/bots.mjs";
import { handleMatchesRoute } from "./routes/matches.mjs";
import { handleTournamentsRoute } from "./routes/tournaments.mjs";
import { handleCompetitionsRoute } from "./routes/competitions.mjs";
import { handleCompetitionCatalogRoute } from "./routes/competition-rounds.mjs";
import { handleLeaderboardRoute } from "./routes/leaderboard.mjs";
import { createCompetitionRepository } from "../../../packages/arena-node/src/persistence/competition-repository.mjs";
import { createCompetitionRoundsRepository } from "../../../packages/arena-node/src/persistence/competition-rounds-repository.mjs";
import { createBotRepository } from "../../../packages/arena-node/src/persistence/bot-repository.mjs";
import { createMatchRepository } from "../../../packages/arena-node/src/persistence/match-repository.mjs";
import { createLiveFrameStore } from "../../../packages/arena-node/src/persistence/live-frame-store.mjs";
import { createDraftService } from "../../../packages/arena-node/src/execution/draft-service.mjs";

const PROFILE_PROBE_CACHE_MS = 5 * 60 * 1000;

/**
 * Sends a structured JSON success response.
 *
 * @param {http.ServerResponse} res
 * @param {number} statusCode
 * @param {object} data
 * @param {object} [extraHeaders={}]
 */
export function sendJson(res, statusCode, data, extraHeaders = {}) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [k, v] of Object.entries(extraHeaders)) {
    res.setHeader(k, v);
  }
  res.end(JSON.stringify(data));
}

/**
 * Sends a structured JSON error response.
 *
 * @param {http.ServerResponse} res
 * @param {number} statusCode
 * @param {string} code
 * @param {string} message
 * @param {object} [details={}]
 * @param {http.IncomingMessage} [req=null]
 */
export function sendError(res, statusCode, code, message, details = {}, req = null) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const requestId = req?.id || randomUUID();
  res.setHeader("X-Request-Id", requestId);

  // Guarantee no internal server private paths leak to client
  const safeMessage = typeof message === "string" ? message.replace(/([A-Z]:\\[^\s]+|\/[^\s]+)/gi, "[redacted-path]") : message;

  res.end(
    JSON.stringify({
      error: {
        code,
        message: safeMessage,
        requestId,
        details: details || {}
      }
    })
  );
}

/**
 * Bounded JSON body parser. Throws 413 if payload exceeds maxBytes.
 *
 * @param {http.IncomingMessage} req
 * @param {number} [maxBytes=1048576]
 * @returns {Promise<any>}
 */
export function parseJsonBody(req, maxBytes = 1048576) {
  return new Promise((resolve, reject) => {
    let bytesReceived = 0;
    const chunks = [];

    const onData = (chunk) => {
      bytesReceived += chunk.length;
      if (bytesReceived > maxBytes) {
        req.pause();
        req.removeListener("data", onData);
        req.removeListener("end", onEnd);
        reject({
          statusCode: 413,
          code: "PAYLOAD_TOO_LARGE",
          message: `Request payload exceeds limit of ${maxBytes} bytes`
        });
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed);
      } catch (err) {
        reject({
          statusCode: 400,
          code: "INVALID_JSON",
          message: "Malformed JSON payload in request body"
        });
      }
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", (err) => {
      reject({
        statusCode: 400,
        code: "BAD_REQUEST",
        message: err.message
      });
    });
  });
}

/**
 * Creates the Arena HTTP Server instance.
 *
 * @param {object} options
 * @param {import('better-sqlite3').Database} options.db
 * @param {string[]} [options.allowedOrigins]
 * @param {boolean} [options.trustedMode=true]
 * @param {number} [options.maxBodyBytes=1048576]
 * @param {object} [options.botRepo]
 * @param {object} [options.matchRepo]
 * @param {object} [options.tournamentRepo]
 * @param {object} [options.jobQueue]
 * @param {object} [options.botVersionService]
 * @param {object} [options.profileRegistry]
 * @param {object} [options.finalizer]
 * @returns {http.Server}
 */
export function createArenaServer(options) {
  const {
    db,
    allowedOrigins = ["http://127.0.0.1:3000", "http://localhost:3000"],
    trustedMode = true,
    maxBodyBytes = 1048576,
    botRepo = null,
    matchRepo = null,
    tournamentRepo = null,
    jobQueue = null,
    botVersionService = null,
    profileRegistry = null,
    draftService = null,
    liveFrameStore = null,
    finalizer = null,
    competitionRepo = null,
    competitionRoundsRepo = null,
    localDemoContainers = false,
    publicRegistration = false,
    executionCapabilities = null,
    getExecutionCapabilities = null
  } = options;

  if (!db) {
    throw new TypeError("createArenaServer requires options.db");
  }
  if (localDemoContainers && trustedMode) {
    throw new Error("localDemoContainers cannot be combined with trustedMode");
  }

  const resolvedBotRepo = botRepo || createBotRepository(db);
  const resolvedMatchRepo = matchRepo || createMatchRepository(db);
  const hasLiveFramesTable = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'match_live_frames'").get()
  );
  const resolvedLiveFrameStore =
    liveFrameStore || (hasLiveFramesTable ? createLiveFrameStore(db) : null);
  const resolvedDraftService =
    draftService ||
    (profileRegistry
      ? createDraftService({
          profileRegistry,
          containerExecutor: options.containerExecutor || null,
          trustedLocalMode: Boolean(options.trustedLocalMode ?? trustedMode)
        })
      : null);

  const resolvedCompetitionRepo =
    competitionRepo || createCompetitionRepository(db, { tournamentRepo });
  const resolvedCompetitionRoundsRepo =
    competitionRoundsRepo || createCompetitionRoundsRepository(db, { tournamentRepo });

  // Probes spawn the toolchains synchronously, so /capabilities reuses one result for a while.
  let availableProfilesCache = null;
  function availableProfileIds() {
    if (!profileRegistry) return ["node", "python", "cpp", "java"];
    const now = Date.now();
    if (!availableProfilesCache || now - availableProfilesCache.at > PROFILE_PROBE_CACHE_MS) {
      const canProbe = typeof profileRegistry.probeProfile === "function";
      const ids = profileRegistry
        .listProfiles()
        .map((p) => p.id)
        .filter((id) => !canProbe || profileRegistry.probeProfile(id)?.available !== false);
      availableProfilesCache = { at: now, ids };
    }
    return availableProfilesCache.ids;
  }

  const server = http.createServer(async (req, res) => {
    // 1. Assign trace request ID
    req.id = req.headers["x-request-id"] || req.headers["X-Request-Id"] || randomUUID();
    res.setHeader("X-Request-Id", req.id);

    // 2. Exact CORS allowlist enforcement
    const origin = req.headers["origin"] || req.headers["Origin"];
    const isOriginAllowed = origin && allowedOrigins.includes(origin);

    if (isOriginAllowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, Idempotency-Key, X-Request-Id"
      );
      res.setHeader("Access-Control-Max-Age", "86400");
    }

    if (req.method === "OPTIONS") {
      if (origin && !isOriginAllowed) {
        return sendError(res, 403, "CORS_FORBIDDEN", "Origin not permitted by CORS policy", {}, req);
      }
      res.statusCode = 204;
      res.end();
      return;
    }

    // 3. Routing
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      const pathname = parsedUrl.pathname;

      if (!pathname.startsWith("/api/arena/v1")) {
        return sendError(res, 404, "NOT_FOUND", `Route not found: ${pathname}`, {}, req);
      }

      // ── GET /capabilities ──────────────────────────────────────────────────
      if (req.method === "GET" && pathname === "/api/arena/v1/capabilities") {
        const currentExecutionCapabilities = getExecutionCapabilities
          ? getExecutionCapabilities()
          : executionCapabilities;
        const containerReady = Boolean(localDemoContainers && currentExecutionCapabilities?.available);
        return sendJson(res, 200, {
          publicRegistration: Boolean(publicRegistration),
          executor: localDemoContainers ? "oci-container-local-demo-v1" : "trusted-local-v1",
          trusted: Boolean(trustedMode),
          untrusted: Boolean(localDemoContainers && currentExecutionCapabilities?.available),
          canSubmitSource: Boolean(localDemoContainers && currentExecutionCapabilities?.available),
          profiles: containerReady ? ["python", "node"] : availableProfileIds(),
          localDemoContainers: Boolean(localDemoContainers),
          localDocker: localDemoContainers ? (currentExecutionCapabilities || { available: false, reason: "not_configured" }) : null
        });
      }

      if (pathname === "/api/arena/v1/auth/register") {
        return await handleRegistration(req, res, {
          db, publicRegistration, maxBodyBytes, parseJsonBody, sendError, sendJson
        });
      }

      // ── POST /auth/login ────────────────────────────────────────────────────
      if (req.method === "POST" && pathname === "/api/arena/v1/auth/login") {
        let body;
        try {
          body = await parseJsonBody(req, maxBodyBytes);
        } catch (err) {
          return sendError(res, err.statusCode || 400, err.code || "BAD_REQUEST", err.message, {}, req);
        }

        const username = body.username ? String(body.username).trim().toLowerCase() : "";
        const password = body.password ? String(body.password) : "";

        // Derive peer IP strictly from socket remoteAddress; never trust forwarded headers
        const rawRemoteAddress = req.socket?.remoteAddress || "127.0.0.1";
        const peerIp = String(rawRemoteAddress).replace(/^::ffff:/, "");

        const rateTarget = {
          username: username || null,
          peerIp
        };

        const rateCheck = checkLoginRateLimit(rateTarget);
        if (!rateCheck.allowed) {
          return sendError(
            res,
            429,
            "TOO_MANY_REQUESTS",
            `Too many failed login attempts. Please try again in ${rateCheck.retryAfterSeconds} seconds.`,
            { retryAfterSeconds: rateCheck.retryAfterSeconds },
            req
          );
        }

        if (!username || !password) {
          recordLoginFailure(rateTarget);
          return sendError(res, 401, "INVALID_CREDENTIALS", "Invalid username or password", {}, req);
        }

        const user = db.prepare("SELECT * FROM users WHERE normalized_username = ?").get(username);
        if (!user || !verifyPassword(password, user.password_hash)) {
          recordLoginFailure(rateTarget);
          return sendError(res, 401, "INVALID_CREDENTIALS", "Invalid username or password", {}, req);
        }

        if (user.status !== "active") {
          recordLoginFailure(rateTarget);
          return sendError(res, 401, "ACCOUNT_DISABLED", "User account is suspended or disabled", {}, req);
        }

        resetLoginFailure(rateTarget);
        const session = createSession(db, user.id);

        return sendJson(res, 200, {
          token: session.token,
          user: {
            id: user.id,
            username: user.normalized_username,
            role: user.role
          },
          expiresAt: session.expiresAt
        });
      }

      // ── POST /auth/logout ───────────────────────────────────────────────────
      if (req.method === "POST" && pathname === "/api/arena/v1/auth/logout") {
        const auth = authenticate(req, db);
        if (!auth.ok) {
          return sendError(res, auth.statusCode, auth.error.code, auth.error.message, {}, req);
        }

        revokeSession(db, auth.token);
        return sendJson(res, 200, { ok: true });
      }

      // ── GET /me ─────────────────────────────────────────────────────────────
      if (req.method === "GET" && pathname === "/api/arena/v1/me") {
        const auth = authenticate(req, db);
        if (!auth.ok) {
          return sendError(res, auth.statusCode, auth.error.code, auth.error.message, {}, req);
        }

        const canSubmitSource =
          req.user.role === "admin" || (localDemoContainers && Boolean(
            (getExecutionCapabilities ? getExecutionCapabilities() : executionCapabilities)?.available
          ));
        return sendJson(res, 200, {
          user: {
            id: req.user.id,
            username: req.user.username,
            role: req.user.role
          },
          canSubmitSource
        });
      }

      // ── Routes: /bots ──────────────────────────────────────────────────────
      if (pathname.startsWith("/api/arena/v1/bots")) {
        return await handleBotsRoute(req, res, {
          db,
          botRepo: resolvedBotRepo,
          botVersionService,
          profileRegistry,
          draftService: resolvedDraftService,
          parsedUrl,
          maxBodyBytes,
          trustedMode,
          localDemoContainers,
          executionCapabilities: req.method === "POST" && /^\/api\/arena\/v1\/bots\/[^/]+\/versions\/?$/.test(pathname) && getExecutionCapabilities
            ? getExecutionCapabilities()
            : executionCapabilities
        });
      }

      // ── Routes: /matches ───────────────────────────────────────────────────
      if (pathname.startsWith("/api/arena/v1/matches")) {
        return await handleMatchesRoute(req, res, {
          db,
          matchRepo: resolvedMatchRepo,
          jobQueue,
          liveFrameStore: resolvedLiveFrameStore,
          parsedUrl,
          maxBodyBytes
        });
      }

      // ── Routes: /tournaments ───────────────────────────────────────────────
      if (pathname.startsWith("/api/arena/v1/tournaments")) {
        return await handleTournamentsRoute(req, res, {
          db,
          tournamentRepo,
          parsedUrl,
          maxBodyBytes
        });
      }

      // ── Routes: /competition-catalog ───────────────────────────────────────
      if (pathname === "/api/arena/v1/competition-catalog" || pathname === "/api/arena/v1/competition-catalog/") {
        return await handleCompetitionCatalogRoute(req, res, {
          db,
          competitionRoundsRepo: resolvedCompetitionRoundsRepo,
          parsedUrl,
          maxBodyBytes
        });
      }

      // ── Routes: /competitions ───────────────────────────────────────────────
      if (pathname.startsWith("/api/arena/v1/competitions")) {
        return await handleCompetitionsRoute(req, res, {
          db,
          competitionRepo: resolvedCompetitionRepo,
          competitionRoundsRepo: resolvedCompetitionRoundsRepo,
          tournamentRepo,
          parsedUrl,
          maxBodyBytes
        });
      }

      // ── Routes: /leaderboard ───────────────────────────────────────────────
      if (pathname.startsWith("/api/arena/v1/leaderboard")) {
        return await handleLeaderboardRoute(req, res, {
          db,
          parsedUrl
        });
      }

      return sendError(res, 404, "NOT_FOUND", `Endpoint not found: ${pathname}`, {}, req);
    } catch (err) {
      return sendError(res, 500, "INTERNAL_ERROR", "An unexpected server error occurred", {}, req);
    }
  });

  return server;
}
