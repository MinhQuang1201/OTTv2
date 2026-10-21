/**
 * apps/arena-api/src/auth/accounts.mjs
 *
 * Password hashing, token management, session verification, and login rate limiting.
 *
 * Policies:
 * - Scrypt + 16-byte random salt for password storage.
 * - Cryptographically random opaque 32-byte hex session tokens.
 * - Only SHA-256 token hashes stored in auth_sessions table.
 * - TTL: 24 hours.
 * - Explicit revocation on logout.
 * - User status check (active required).
 * - Bounded login failure rate limiter (5 failed attempts per 15 min window).
 */

import {
  scryptSync,
  randomBytes,
  timingSafeEqual,
  createHash
} from "node:crypto";

/**
 * Hashes a plaintext password using Node.js scrypt with a random 16-byte salt.
 *
 * @param {string} password
 * @returns {string} Formatted string: `scrypt$<saltHex>$<derivedKeyHex>`
 */
export function hashPassword(password) {
  if (typeof password !== "string" || password.length === 0) {
    throw new TypeError("Password must be a non-empty string");
  }
  const salt = randomBytes(16).toString("hex");
  const derivedKey = scryptSync(password, salt, 64);
  return `scrypt$${salt}$${derivedKey.toString("hex")}`;
}

/**
 * Verifies a plaintext password against a stored scrypt hash using timing-safe comparison.
 *
 * @param {string} password
 * @param {string} storedHash
 * @returns {boolean}
 */
export function verifyPassword(password, storedHash) {
  if (
    typeof password !== "string" ||
    typeof storedHash !== "string" ||
    !storedHash.startsWith("scrypt$")
  ) {
    return false;
  }

  const parts = storedHash.split("$");
  if (parts.length !== 3) return false;

  const salt = parts[1];
  const expectedHash = Buffer.from(parts[2], "hex");
  const derivedKey = scryptSync(password, salt, expectedHash.length);

  if (derivedKey.length !== expectedHash.length) {
    return false;
  }

  return timingSafeEqual(derivedKey, expectedHash);
}

/**
 * Computes the SHA-256 hex digest of an opaque bearer token.
 *
 * @param {string} token
 * @returns {string}
 */
export function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Creates an opaque session token, saves its SHA-256 hash to the database with a 24-hour TTL,
 * and returns the bearer token to deliver in-memory to the client.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {number} [ttlMs=86400000] - Default 24 hours
 * @returns {{ token: string, tokenHash: string, expiresAt: string }}
 */
export function createSession(db, userId, ttlMs = 24 * 60 * 60 * 1000) {
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  const stmt = db.prepare(`
    INSERT INTO auth_sessions (token_hash, user_id, expires_at)
    VALUES (?, ?, ?)
  `);
  stmt.run(tokenHash, userId, expiresAt);

  return { token, tokenHash, expiresAt };
}

/**
 * Verifies an opaque token against the database:
 * checks revocation, expiration, and user account active status.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} token
 * @returns {{ ok: boolean, error?: string, session?: object, user?: object }}
 */
export function verifySession(db, token) {
  if (typeof token !== "string" || token.trim().length === 0) {
    return { ok: false, error: "UNAUTHORIZED" };
  }

  const tokenHash = hashToken(token.trim());

  const row = db
    .prepare(`
      SELECT
        s.token_hash,
        s.user_id,
        s.expires_at,
        s.revoked_at,
        s.created_at AS session_created_at,
        u.id,
        u.normalized_username,
        u.role,
        u.status AS user_status
      FROM auth_sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token_hash = ?
    `)
    .get(tokenHash);

  if (!row) {
    return { ok: false, error: "UNAUTHORIZED" };
  }

  if (row.revoked_at !== null) {
    return { ok: false, error: "SESSION_REVOKED" };
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return { ok: false, error: "SESSION_EXPIRED" };
  }

  if (row.user_status !== "active") {
    return { ok: false, error: "ACCOUNT_DISABLED" };
  }

  return {
    ok: true,
    session: {
      tokenHash: row.token_hash,
      userId: row.user_id,
      expiresAt: row.expires_at,
      createdAt: row.session_created_at
    },
    user: {
      id: row.id,
      username: row.normalized_username,
      role: row.role,
      status: row.user_status
    }
  };
}

/**
 * Revokes a session token by writing `revoked_at = datetime('now')` for its hash.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} token
 * @returns {boolean} True if a session row was updated
 */
export function revokeSession(db, token) {
  if (typeof token !== "string" || token.trim().length === 0) {
    return false;
  }
  const tokenHash = hashToken(token.trim());
  const res = db
    .prepare(`
      UPDATE auth_sessions
      SET revoked_at = datetime('now')
      WHERE token_hash = ? AND revoked_at IS NULL
    `)
    .run(tokenHash);

  return res.changes > 0;
}

// ── Bounded Login Rate Limiter ────────────────────────────────────────────────

const loginAttempts = new Map();
export const RATE_LIMIT_MAX_FAILURES = 5;
export const RATE_LIMIT_USER_MAX_FAILURES = 5;
export const RATE_LIMIT_PEER_MAX_FAILURES = 20;
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const MAX_TRACKED_ENTRIES = 1000;

function cleanupRateLimiter() {
  const now = Date.now();
  // 1. Purge expired entries
  for (const [key, record] of loginAttempts.entries()) {
    if (now - record.firstAttemptAt > RATE_LIMIT_WINDOW_MS) {
      loginAttempts.delete(key);
    }
  }
  // 2. Strict hard cap: evict oldest entries if capacity reached
  while (loginAttempts.size >= MAX_TRACKED_ENTRIES) {
    const oldestKey = loginAttempts.keys().next().value;
    if (oldestKey === undefined) break;
    loginAttempts.delete(oldestKey);
  }
}

function normalizeKeys(target) {
  if (typeof target === "string") {
    const trimmed = target.trim();
    if (!trimmed) return [];
    return [{ key: trimmed, maxFailures: RATE_LIMIT_MAX_FAILURES }];
  }
  if (!target || typeof target !== "object") {
    return [];
  }
  const keys = [];
  if (target.username && typeof target.username === "string") {
    const u = target.username.toLowerCase().trim();
    if (u) {
      keys.push({ key: `u:${u}`, maxFailures: RATE_LIMIT_USER_MAX_FAILURES });
    }
  }
  if (target.peerIp && typeof target.peerIp === "string") {
    const p = target.peerIp.trim();
    if (p) {
      keys.push({ key: `p:${p}`, maxFailures: RATE_LIMIT_PEER_MAX_FAILURES });
    }
  }
  return keys;
}

/**
 * Checks if a login target (key string or { username, peerIp }) is currently rate-limited.
 *
 * @param {string|{ username?: string|null, peerIp?: string|null }} target
 * @returns {{ allowed: boolean, remainingAttempts: number, retryAfterSeconds: number }}
 */
export function checkLoginRateLimit(target) {
  cleanupRateLimiter();
  const keys = normalizeKeys(target);
  if (keys.length === 0) {
    return { allowed: true, remainingAttempts: RATE_LIMIT_MAX_FAILURES, retryAfterSeconds: 0 };
  }

  const now = Date.now();
  let minRemaining = RATE_LIMIT_MAX_FAILURES;
  let maxRetryAfter = 0;
  let blocked = false;

  for (const { key, maxFailures } of keys) {
    const record = loginAttempts.get(key);
    if (!record) {
      minRemaining = Math.min(minRemaining, maxFailures);
      continue;
    }

    const elapsed = now - record.firstAttemptAt;
    if (elapsed > RATE_LIMIT_WINDOW_MS) {
      loginAttempts.delete(key);
      minRemaining = Math.min(minRemaining, maxFailures);
      continue;
    }

    if (record.failures >= maxFailures) {
      blocked = true;
      const retryAfter = Math.ceil((RATE_LIMIT_WINDOW_MS - elapsed) / 1000);
      maxRetryAfter = Math.max(maxRetryAfter, retryAfter);
      minRemaining = 0;
    } else {
      minRemaining = Math.min(minRemaining, maxFailures - record.failures);
    }
  }

  if (blocked) {
    return {
      allowed: false,
      remainingAttempts: 0,
      retryAfterSeconds: Math.max(1, maxRetryAfter)
    };
  }

  return {
    allowed: true,
    remainingAttempts: minRemaining,
    retryAfterSeconds: 0
  };
}

/**
 * Records a failed login attempt for the target.
 *
 * @param {string|{ username?: string|null, peerIp?: string|null }} target
 * @returns {{ allowed: boolean, remainingAttempts: number, retryAfterSeconds: number }}
 */
export function recordLoginFailure(target) {
  cleanupRateLimiter();
  const keys = normalizeKeys(target);
  const now = Date.now();

  for (const { key } of keys) {
    if (!loginAttempts.has(key) && loginAttempts.size >= MAX_TRACKED_ENTRIES) {
      cleanupRateLimiter();
      while (loginAttempts.size >= MAX_TRACKED_ENTRIES) {
        const oldestKey = loginAttempts.keys().next().value;
        if (oldestKey === undefined) break;
        loginAttempts.delete(oldestKey);
      }
    }

    let record = loginAttempts.get(key);
    if (!record || now - record.firstAttemptAt > RATE_LIMIT_WINDOW_MS) {
      record = { failures: 1, firstAttemptAt: now };
    } else {
      record.failures += 1;
    }
    loginAttempts.delete(key);
    loginAttempts.set(key, record);
  }

  return checkLoginRateLimit(target);
}

/**
 * Clears failed login attempts for a target upon successful authentication.
 *
 * @param {string|{ username?: string|null, peerIp?: string|null }} target
 */
export function resetLoginFailure(target) {
  const keys = normalizeKeys(target);
  for (const { key } of keys) {
    // Only reset user or generic key; keep peer throttling intact to prevent spray reset
    if (!key.startsWith("p:")) {
      loginAttempts.delete(key);
    }
  }
}

export function _getRateLimitMapSize() {
  return loginAttempts.size;
}

export function _clearRateLimitsForTesting() {
  loginAttempts.clear();
}
