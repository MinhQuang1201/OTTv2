/**
 * apps/arena-api/src/auth/authorization.mjs
 *
 * Authorization and access control guards:
 * - Bearer token validation (rejects tokens in query params or URLs).
 * - DB-authoritative user and role binding (ignores client spoof attempts).
 * - Role checks ('admin', 'author').
 * - Resource ownership verification.
 */

import { verifySession } from "./accounts.mjs";

/**
 * Authenticates an incoming HTTP request using the Bearer token in the Authorization header.
 * Strictly rejects tokens in URL query strings.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('better-sqlite3').Database} db
 * @returns {{ ok: boolean, statusCode?: number, error?: object, user?: object, token?: string }}
 */
export function authenticate(req, db) {
  // 1. Forbid tokens passed in URL query strings to avoid leaking to access logs or browser history
  if (req.url && (req.url.includes("token=") || req.url.includes("bearer="))) {
    return {
      ok: false,
      statusCode: 401,
      error: {
        code: "UNAUTHORIZED",
        message: "Bearer tokens in URL query parameters are strictly forbidden"
      }
    };
  }

  const authHeader = req.headers["authorization"] || req.headers["Authorization"];
  if (!authHeader || typeof authHeader !== "string") {
    return {
      ok: false,
      statusCode: 401,
      error: {
        code: "UNAUTHORIZED",
        message: "Missing Authorization header"
      }
    };
  }

  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    return {
      ok: false,
      statusCode: 401,
      error: {
        code: "UNAUTHORIZED",
        message: "Invalid Authorization header format; must be Bearer <token>"
      }
    };
  }

  const token = parts[1];
  const res = verifySession(db, token);

  if (!res.ok) {
    if (res.error === "SESSION_REVOKED") {
      return {
        ok: false,
        statusCode: 401,
        error: {
          code: "SESSION_REVOKED",
          message: "Session token has been revoked"
        }
      };
    }
    if (res.error === "SESSION_EXPIRED") {
      return {
        ok: false,
        statusCode: 401,
        error: {
          code: "SESSION_EXPIRED",
          message: "Session token has expired"
        }
      };
    }
    if (res.error === "ACCOUNT_DISABLED") {
      return {
        ok: false,
        statusCode: 401,
        error: {
          code: "ACCOUNT_DISABLED",
          message: "Account is disabled or suspended"
        }
      };
    }

    return {
      ok: false,
      statusCode: 401,
      error: {
        code: "UNAUTHORIZED",
        message: "Invalid session token"
      }
    };
  }

  // Bind DB-authoritative user to request context (client-supplied roles/IDs ignored)
  req.user = res.user;
  req.token = token;
  req.session = res.session;

  return { ok: true, user: res.user, token };
}

/**
 * Checks if the authenticated user has one of the allowed roles.
 *
 * @param {object} user
 * @param {string[]} allowedRoles
 * @returns {{ ok: boolean, statusCode?: number, error?: object }}
 */
export function checkRole(user, allowedRoles) {
  if (!user || !user.role || !allowedRoles.includes(user.role)) {
    return {
      ok: false,
      statusCode: 403,
      error: {
        code: "FORBIDDEN",
        message: `Forbidden: role '${user ? user.role : "unauthenticated"}' does not have required permissions`
      }
    };
  }
  return { ok: true };
}

/**
 * Checks if the authenticated user is the owner of the resource or has the 'admin' role.
 *
 * @param {object} user
 * @param {string} ownerId
 * @returns {{ ok: boolean, statusCode?: number, error?: object }}
 */
export function checkOwnershipOrAdmin(user, ownerId) {
  if (!user) {
    return {
      ok: false,
      statusCode: 401,
      error: { code: "UNAUTHORIZED", message: "Authentication required" }
    };
  }

  if (user.role === "admin" || user.id === ownerId) {
    return { ok: true };
  }

  return {
    ok: false,
    statusCode: 403,
    error: {
      code: "OWNERSHIP_DENIED",
      message: "Forbidden: user does not own this resource"
    }
  };
}
