/**
 * sqlite-database.mjs
 *
 * Low-level SQLite database initialiser for the arena persistence layer.
 *
 * - Configures WAL journal mode, FK enforcement, and busy_timeout on every
 *   connection open.
 * - Checks schema_migrations BEFORE applying DDL. Fails closed on unknown/newer
 *   schema versions without altering existing data.
 * - Robust error handling: catches all startup/migration errors, rolls back any active
 *   transaction, and closes the database connection to avoid leaking locks.
 * - Runs the 001-arena migration exactly once transactionally.
 * - Exposes withTransaction using txn.immediate() (BEGIN IMMEDIATE) to serialize writes.
 * - Does NOT expose arbitrary SQL execution to the domain layer.
 *
 * Public API:
 *   openDatabase(dbPath, { sqlitePath?, migrationSql?, nativeBinding? }) → { db, version }
 *   withTransaction(db, fn)                                              → fn()
 *   closeDatabase(db)                                                    → void
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Default path to the 001-arena migration SQL file. */
const DEFAULT_MIGRATION_SQL_PATH = resolve(
  __dirname,
  "migrations/001-arena.sql"
);

/** List of migration definitions recognized by this codebase. */
export const MIGRATIONS = [
  { version: "001-arena", path: resolve(__dirname, "migrations/001-arena.sql") },
  { version: "002-competitions", path: resolve(__dirname, "migrations/002-competitions.sql") },
  { version: "003-competition-rounds", path: resolve(__dirname, "migrations/003-competition-rounds.sql") },
  { version: "004-arena-live-frames", path: resolve(__dirname, "migrations/004-arena-live-frames.sql") }
];

/** Set of schema migration versions recognized by this codebase. */
const KNOWN_VERSIONS = new Set(MIGRATIONS.map((m) => m.version));

/**
 * Applies a specific migration if not already present in schema_migrations.
 * Applies any prerequisite migrations in sequence if not yet applied.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} migrationVersion
 */
export function applyMigration(db, migrationVersion) {
  const targetIndex = MIGRATIONS.findIndex((x) => x.version === migrationVersion);
  if (targetIndex === -1) {
    throw new Error(`Unknown migration: '${migrationVersion}'`);
  }
  const hasMigrationsTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();

  for (let i = 0; i <= targetIndex; i++) {
    const m = MIGRATIONS[i];
    if (hasMigrationsTable) {
      const row = db
        .prepare("SELECT version FROM schema_migrations WHERE version = ?")
        .get(m.version);
      if (row) continue;
    }

    const sql = readFileSync(m.path, "utf8");
    db.exec(sql);
  }
}

/**
 * Loads better-sqlite3 from the given path or by default module resolution.
 * Throws immediately if the driver cannot be loaded — no silent RAM/JSON fallback.
 *
 * @param {string|null} sqlitePath - Absolute path to a better-sqlite3 module directory,
 *   or null to use the default require resolution from this file.
 * @returns {import('better-sqlite3').DatabaseConstructor}
 */
function loadDriver(sqlitePath) {
  const req = createRequire(import.meta.url);
  if (sqlitePath) {
    return req(sqlitePath);
  }
  return req("better-sqlite3");
}

/**
 * Opens (or creates) a SQLite database, applies WAL/FK/busy_timeout PRAGMAs,
 * checks schema_migrations BEFORE applying DDL, rejects unknown/newer versions
 * fail-closed, runs migration transactionally if not yet applied, and returns
 * the open db and verified version.
 *
 * On any startup failure (PRAGMA, file read, syntax, constraint, migration error),
 * rolls back any open transaction and closes the database handle before re-throwing.
 *
 * @param {string} dbPath - Filesystem path for the SQLite file, or ':memory:'.
 * @param {object} [options]
 * @param {string|null} [options.sqlitePath=null] - Override path to better-sqlite3 module.
 * @param {string|null} [options.migrationSql=null]  - SQL string to run instead of file.
 * @param {string|null} [options.nativeBinding=null] - Override path to native binding (.node).
 * @param {string|null} [options.targetVersion=null] - Migration target version (e.g. '002-competitions', 'latest').
 * @returns {{ db: import('better-sqlite3').Database, version: string }}
 */
export function openDatabase(dbPath, options = {}) {
  const {
    sqlitePath = null,
    migrationSql = null,
    nativeBinding = null,
    targetVersion = null,
    ...driverOptions
  } = options;

  // Resolve native binding from explicit option or environment configuration only.
  // No hardcoded developer paths in production modules.
  const resolvedNativeBinding = nativeBinding || process.env.ARENA_SQLITE_NATIVE_BINDING || undefined;

  const SqliteDatabase = loadDriver(sqlitePath);
  const dbOptions = resolvedNativeBinding
    ? { nativeBinding: resolvedNativeBinding, ...driverOptions }
    : driverOptions;
  const db = new SqliteDatabase(dbPath, dbOptions);

  try {
    // ── Connection-level PRAGMAs ───────────────────────────────────────────────
    // WAL mode: enables concurrent reads without blocking writers.
    db.pragma("journal_mode = WAL");
    // Enforce foreign key constraints for every statement on this connection.
    db.pragma("foreign_keys = ON");
    // Wait up to 5 s before returning SQLITE_BUSY instead of failing immediately.
    db.pragma("busy_timeout = 5000");

    // If explicit migrationSql override provided, run it directly (preserves test override semantics)
    if (migrationSql !== null) {
      db.exec(migrationSql);
      const row = db
        .prepare("SELECT version FROM schema_migrations WHERE version = ?")
        .get("001-arena");
      return { db, version: row ? row.version : "001-arena" };
    }

    // ── Check Schema Migrations Before Applying DDL ───────────────────────────
    const hasMigrationsTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get();

    let appliedVersions = [];
    if (hasMigrationsTable) {
      const appliedRows = db.prepare("SELECT version FROM schema_migrations").all();
      appliedVersions = appliedRows.map((r) => r.version);

      // Fail-closed check: reject if database contains unknown or newer migrations
      for (const ver of appliedVersions) {
        if (!KNOWN_VERSIONS.has(ver)) {
          throw new Error(
            `Unknown or unsupported schema version in database: '${ver}'. Refusing to apply DDL (fail-closed).`
          );
        }
      }

      // If specific targetVersion requested:
      if (targetVersion) {
        const target = targetVersion === "latest" ? MIGRATIONS[MIGRATIONS.length - 1].version : targetVersion;
        const targetIndex = MIGRATIONS.findIndex((m) => m.version === target);
        if (targetIndex === -1) {
          throw new Error(`Unknown target schema version: '${targetVersion}'`);
        }
        for (let i = 0; i <= targetIndex; i++) {
          const m = MIGRATIONS[i];
          if (!appliedVersions.includes(m.version)) {
            const sql = readFileSync(m.path, "utf8");
            db.exec(sql);
            appliedVersions.push(m.version);
          }
        }
        return { db, version: target };
      }

      // If no targetVersion specified and 001-arena is already applied, return current version
      if (appliedVersions.includes("001-arena")) {
        let currentVersion = "001-arena";
        for (let i = MIGRATIONS.length - 1; i >= 0; i--) {
          if (appliedVersions.includes(MIGRATIONS[i].version)) {
            currentVersion = MIGRATIONS[i].version;
            break;
          }
        }
        return { db, version: currentVersion };
      }
    }

    // Fresh database: apply migration up to targetVersion (default 001-arena for backwards compatibility)
    const target = targetVersion
      ? (targetVersion === "latest" ? MIGRATIONS[MIGRATIONS.length - 1].version : targetVersion)
      : "001-arena";
    const targetIndex = MIGRATIONS.findIndex((m) => m.version === target);
    if (targetIndex === -1) {
      throw new Error(`Unknown target schema version: '${target}'`);
    }

    for (let i = 0; i <= targetIndex; i++) {
      const m = MIGRATIONS[i];
      if (!appliedVersions.includes(m.version)) {
        const sql = readFileSync(m.path, "utf8");
        db.exec(sql);
        appliedVersions.push(m.version);
      }
    }

    // ── Verify Schema Version ─────────────────────────────────────────────────
    const row = db
      .prepare("SELECT version FROM schema_migrations WHERE version = ?")
      .get(target);

    if (!row) {
      throw new Error(
        `Arena schema migration failed: version ${target} not found in schema_migrations`
      );
    }

    return { db, version: row.version };
  } catch (err) {
    // Robust cleanup on ALL startup failures: rollback if in transaction and close
    try {
      if (db.inTransaction) {
        db.exec("ROLLBACK");
      }
    } catch {
      // ignore rollback failure on invalid connection
    }
    closeDatabase(db);
    throw err;
  }
}

/**
 * Wraps a synchronous function inside a BEGIN IMMEDIATE transaction.
 * Uses txn.immediate() to acquire the write lock immediately, serializing writes.
 * Rolls back automatically on any thrown exception and re-throws.
 *
 * @template T
 * @param {import('better-sqlite3').Database} db
 * @param {() => T} fn
 * @returns {T}
 */
export function withTransaction(db, fn) {
  const txn = db.transaction(fn);
  return txn.immediate();
}

/**
 * Closes the database connection. Idempotent — safe to call multiple times.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function closeDatabase(db) {
  if (db && db.open) {
    db.close();
  }
}
