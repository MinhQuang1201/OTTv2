/**
 * bot-repository.mjs
 *
 * Repository for user, bot, bot-version, and artifact persistence.
 *
 * Public API:
 *   createBotRepository(db)  → BotRepository
 *
 * BotRepository methods:
 *   createUser({ id, normalizedUsername, passwordHash, role })    → UserRecord
 *   createBot({ id, ownerId, name }, { idempotencyKey, actorId }) → BotRecord
 *   createVersion({ id, botId, sourceDigest, profileId, profileRevision }, { idempotencyKey, actorId }) → BotVersionRecord
 *   markVersionReady({ botVersionId, artifactDigest, buildLog })  → BotVersionRecord
 *   markVersionFailed({ botVersionId, buildLog })                 → BotVersionRecord
 *   registerArtifact({ digest, kind, relativePrivatePath, bytes }) → ArtifactRecord
 *   getUser(userId)           → UserRecord | undefined
 *   getBot(botId)             → BotRecord | undefined
 *   getBotVersion(versionId)  → BotVersionRecord | undefined
 *   getReadyVersion(botId, versionNo) → BotVersionRecord | undefined
 *   listBotVersions(botId)    → BotVersionRecord[]
 *   getArtifact(digest)       → ArtifactRecord | undefined
 *
 * Idempotency:
 *   createBot and createVersion accept { idempotencyKey, actorId }.
 *   Same key + same canonical payload digest → return existing target.
 *   Same key + different payload digest      → throw IdempotencyConflictError.
 *   Created in same transaction as api_requests row.
 *
 * Version allocation:
 *   version_no allocated via INSERT into UNIQUE(bot_id, version_no) inside a
 *   transaction — NOT via SELECT MAX(version_no)+1 outside a lock.
 */

import { createHash } from "node:crypto";

// ── Error types ───────────────────────────────────────────────────────────────

export class IdempotencyConflictError extends Error {
  constructor(key, operation) {
    super(
      `Idempotency conflict: key "${key}" already used for operation "${operation}" with a different payload`
    );
    this.name = "IdempotencyConflictError";
    this.code = "IDEMPOTENCY_CONFLICT";
    this.idempotencyKey = key;
    this.operation = operation;
  }
}

export class NotFoundError extends Error {
  constructor(resource, id) {
    super(`${resource} not found: ${id}`);
    this.name = "NotFoundError";
    this.code = "NOT_FOUND";
    this.resource = resource;
    this.resourceId = id;
  }
}

export class OwnershipError extends Error {
  constructor(resource, id, actorId) {
    super(`Actor "${actorId}" does not own ${resource} "${id}"`);
    this.name = "OwnershipError";
    this.code = "OWNERSHIP_DENIED";
    this.resource = resource;
    this.resourceId = id;
    this.actorId = actorId;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Computes SHA-256 hex digest of canonical JSON of the given value.
 * digest() is a pure helper injected so domain code doesn't import crypto.
 */
function canonicalDigest(value) {
  const json = JSON.stringify(sortKeys(value));
  return createHash("sha256").update(json, "utf8").digest("hex");
}

function sortKeys(val) {
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(sortKeys);
  const out = {};
  for (const k of Object.keys(val).sort()) out[k] = sortKeys(val[k]);
  return out;
}

// ── Repository factory ────────────────────────────────────────────────────────

/**
 * @param {import('better-sqlite3').Database} db
 */
export function createBotRepository(db) {

  // ── Prepared statements (created once per repository instance) ─────────────

  const stmts = {
    insertUser: db.prepare(`
      INSERT INTO users (id, normalized_username, password_hash, role)
      VALUES (?, ?, ?, ?)
    `),
    selectUser: db.prepare("SELECT * FROM users WHERE id = ?"),
    selectUserByUsername: db.prepare("SELECT * FROM users WHERE normalized_username = ?"),

    insertBot: db.prepare(`
      INSERT INTO bots (id, owner_id, name) VALUES (?, ?, ?)
    `),
    selectBot: db.prepare("SELECT * FROM bots WHERE id = ?"),

    insertBotVersion: db.prepare(`
      INSERT INTO bot_versions (id, bot_id, version_no, source_digest, profile_id, profile_revision)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    allocateVersionNo: db.prepare(`
      SELECT COALESCE(MAX(version_no), 0) + 1 AS next_no
      FROM bot_versions WHERE bot_id = ?
    `),
    selectBotVersion: db.prepare("SELECT * FROM bot_versions WHERE id = ?"),
    selectBotVersionByBotAndNo: db.prepare(
      "SELECT * FROM bot_versions WHERE bot_id = ? AND version_no = ? AND build_status = 'ready'"
    ),
    listBotVersions: db.prepare(
      "SELECT * FROM bot_versions WHERE bot_id = ? ORDER BY version_no ASC"
    ),
    updateBotVersionReady: db.prepare(`
      UPDATE bot_versions
      SET build_status = 'ready', artifact_digest = ?, build_log = ?
      WHERE id = ?
    `),
    updateBotVersionFailed: db.prepare(`
      UPDATE bot_versions
      SET build_status = 'failed', build_log = ?
      WHERE id = ?
    `),

    insertArtifact: db.prepare(`
      INSERT OR IGNORE INTO artifacts (digest, kind, relative_private_path, bytes)
      VALUES (?, ?, ?, ?)
    `),
    selectArtifact: db.prepare("SELECT * FROM artifacts WHERE digest = ?"),

    // Idempotency
    selectApiRequest: db.prepare(
      "SELECT * FROM api_requests WHERE actor_id = ? AND operation = ? AND idempotency_key = ?"
    ),
    insertApiRequest: db.prepare(`
      INSERT INTO api_requests (actor_id, operation, idempotency_key, payload_digest, target_id, response_status)
      VALUES (?, ?, ?, ?, ?, 200)
    `)
  };

  // ── Idempotency check ──────────────────────────────────────────────────────

  /**
   * Returns existing target_id if idempotent; throws ConflictError on payload
   * mismatch; returns null if key is new (caller should proceed to create).
   */
  function checkIdempotency(actorId, operation, idempotencyKey, payloadDigest) {
    const existing = stmts.selectApiRequest.get(actorId, operation, idempotencyKey);
    if (!existing) return null;
    if (existing.payload_digest !== payloadDigest) {
      throw new IdempotencyConflictError(idempotencyKey, operation);
    }
    return existing.target_id;
  }

  // ── createUser ─────────────────────────────────────────────────────────────

  /**
   * Creates a user. No idempotency key required (called by admin setup).
   * Throws on duplicate normalized_username (SQLite UNIQUE constraint).
   */
  function createUser({ id, normalizedUsername, passwordHash, role = "author" }) {
    stmts.insertUser.run(id, normalizedUsername, passwordHash, role);
    return stmts.selectUser.get(id);
  }

  // ── createBot ─────────────────────────────────────────────────────────────

  function createBot({ id, ownerId, name }, { idempotencyKey, actorId }) {
    if (typeof id !== "string") {
      throw new TypeError("Bot id must be a string");
    }
    const cleanId = id.trim();
    if (cleanId.length === 0 || !/^[a-zA-Z0-9_-]{1,64}$/.test(cleanId)) {
      throw new TypeError("Invalid bot id format: must be 1-64 alphanumeric characters, underscores, or hyphens");
    }
    const payloadDigest = canonicalDigest({ id: cleanId, ownerId, name, operation: "createBot" });

    return db.transaction(() => {
      const existingId = checkIdempotency(actorId, "createBot", idempotencyKey, payloadDigest);
      if (existingId !== null) {
        return stmts.selectBot.get(existingId);
      }

      // Ownership: only the actor themselves or admin can create a bot on their behalf
      const actor = stmts.selectUser.get(actorId);
      if (!actor) throw new NotFoundError("user", actorId);
      if (actor.id !== ownerId && actor.role !== "admin") {
        throw new OwnershipError("bot owner", ownerId, actorId);
      }

      stmts.insertBot.run(cleanId, ownerId, name);
      stmts.insertApiRequest.run(actorId, "createBot", idempotencyKey, payloadDigest, cleanId);
      return stmts.selectBot.get(cleanId);
    }).immediate();
  }

  // ── createVersion ─────────────────────────────────────────────────────────

  /**
   * Allocates a version_no inside the transaction using the UNIQUE(bot_id, version_no)
   * constraint for serialization — not via MAX+1 outside a lock.
   */
  function createVersion(
    { id, botId, sourceDigest, profileId, profileRevision },
    { idempotencyKey, actorId }
  ) {
    const payloadDigest = canonicalDigest({
      id, botId, sourceDigest, profileId, profileRevision, operation: "createVersion"
    });

    return db.transaction(() => {
      const existingId = checkIdempotency(actorId, "createVersion", idempotencyKey, payloadDigest);
      if (existingId !== null) {
        return stmts.selectBotVersion.get(existingId);
      }

      // Ownership check: actor must own the bot
      const bot = stmts.selectBot.get(botId);
      if (!bot) throw new NotFoundError("bot", botId);

      const actor = stmts.selectUser.get(actorId);
      if (!actor) throw new NotFoundError("user", actorId);
      if (bot.owner_id !== actorId && actor.role !== "admin") {
        throw new OwnershipError("bot", botId, actorId);
      }

      // Allocate version_no atomically within transaction
      const { next_no } = stmts.allocateVersionNo.get(botId);
      stmts.insertBotVersion.run(id, botId, next_no, sourceDigest, profileId, profileRevision);
      stmts.insertApiRequest.run(actorId, "createVersion", idempotencyKey, payloadDigest, id);
      return stmts.selectBotVersion.get(id);
    }).immediate();
  }

  // ── markVersionReady ───────────────────────────────────────────────────────

  function markVersionReady({ botVersionId, artifactDigest, buildLog = null }) {
    const row = stmts.selectBotVersion.get(botVersionId);
    if (!row) throw new NotFoundError("bot_version", botVersionId);
    stmts.updateBotVersionReady.run(artifactDigest ?? null, buildLog, botVersionId);
    return stmts.selectBotVersion.get(botVersionId);
  }

  // ── markVersionFailed ──────────────────────────────────────────────────────

  function markVersionFailed({ botVersionId, buildLog = null }) {
    const row = stmts.selectBotVersion.get(botVersionId);
    if (!row) throw new NotFoundError("bot_version", botVersionId);
    stmts.updateBotVersionFailed.run(buildLog, botVersionId);
    return stmts.selectBotVersion.get(botVersionId);
  }

  // ── registerArtifact ──────────────────────────────────────────────────────

  /**
   * Registers an artifact. INSERT OR IGNORE makes this idempotent for same digest.
   * relativePrivatePath must be server-generated (not from upload filename).
   */
  function registerArtifact({ digest, kind, relativePrivatePath, bytes }) {
    stmts.insertArtifact.run(digest, kind, relativePrivatePath, bytes);
    return stmts.selectArtifact.get(digest);
  }

  // ── Read methods ───────────────────────────────────────────────────────────

  function getUser(userId) {
    return stmts.selectUser.get(userId) ?? undefined;
  }

  function getBot(botId) {
    return stmts.selectBot.get(botId) ?? undefined;
  }

  function getBotVersion(versionId) {
    return stmts.selectBotVersion.get(versionId) ?? undefined;
  }

  function getReadyVersion(botId, versionNo) {
    return stmts.selectBotVersionByBotAndNo.get(botId, versionNo) ?? undefined;
  }

  function listBotVersions(botId) {
    return stmts.listBotVersions.all(botId);
  }

  function getArtifact(digest) {
    return stmts.selectArtifact.get(digest) ?? undefined;
  }

  return {
    createUser,
    createBot,
    createVersion,
    markVersionReady,
    markVersionFailed,
    registerArtifact,
    getUser,
    getBot,
    getBotVersion,
    getReadyVersion,
    listBotVersions,
    getArtifact
  };
}
