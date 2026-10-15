/**
 * apps/arena-api/src/config.mjs
 *
 * Configuration loader for OTTv2 Arena HTTP API service.
 * Defaults:
 * - bind: 127.0.0.1
 * - port: 3001
 * - allowedOrigins: ["http://127.0.0.1:3000", "http://localhost:3000"]
 * - storageDir: var/arena/artifacts
 * - dbPath: var/arena/arena.db
 * - maxBodyBytes: 1048576 (1 MiB)
 * - maxSourceBytes: 1048576 (1 MiB)
 * - trustedMode: true (admin curated only, untrusted is disabled fail-closed)
 * - externalWorker: false (API runs embedded worker unless externalWorker is set)
 * - localDemoContainers: false (explicit local Docker acceptance mode)
 */

import path from "node:path";

export const DEFAULT_CONFIG = Object.freeze({
  bind: "127.0.0.1",
  port: 3001,
  allowedOrigins: Object.freeze(["http://127.0.0.1:3000", "http://localhost:3000"]),
  storageDir: "var/arena/artifacts",
  dbPath: "var/arena/arena.db",
  maxBodyBytes: 1048576, // 1 MiB
  maxSourceBytes: 1048576, // 1 MiB
  trustedMode: true,
  externalWorker: false,
  localDemoContainers: false
});

/**
 * Loads and merges configuration from environment variables and explicit options.
 *
 * @param {object} [overrides={}]
 * @returns {object}
 */
export function loadConfig(overrides = {}) {
  let origins = DEFAULT_CONFIG.allowedOrigins;
  if (process.env.ARENA_ALLOWED_ORIGINS) {
    origins = process.env.ARENA_ALLOWED_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (overrides.allowedOrigins) {
    origins = Array.isArray(overrides.allowedOrigins)
      ? overrides.allowedOrigins
      : [overrides.allowedOrigins];
  }

  const port = Number(
    overrides.port ??
      process.env.ARENA_API_PORT ??
      process.env.PORT ??
      DEFAULT_CONFIG.port
  );

  const bind =
    overrides.bind ??
    process.env.ARENA_API_HOST ??
    DEFAULT_CONFIG.bind;

  const dbPath =
    overrides.dbPath ??
    process.env.ARENA_DB_PATH ??
    DEFAULT_CONFIG.dbPath;

  const storageDir =
    overrides.storageDir ??
    process.env.ARENA_STORAGE_DIR ??
    DEFAULT_CONFIG.storageDir;

  const maxBodyBytes = Number(
    overrides.maxBodyBytes ??
      process.env.ARENA_MAX_BODY_BYTES ??
      DEFAULT_CONFIG.maxBodyBytes
  );

  const maxSourceBytes = Number(
    overrides.maxSourceBytes ??
      process.env.ARENA_MAX_SOURCE_BYTES ??
      DEFAULT_CONFIG.maxSourceBytes
  );

  const externalWorker =
    overrides.externalWorker !== undefined
      ? Boolean(overrides.externalWorker)
      : process.env.ARENA_EXTERNAL_WORKER === "true" || process.env.ARENA_EXTERNAL_WORKER === "1";

  const localDemoContainers =
    overrides.localDemoContainers !== undefined
      ? Boolean(overrides.localDemoContainers)
      : process.env.ARENA_LOCAL_DEMO_CONTAINERS === "true" || process.env.ARENA_LOCAL_DEMO_CONTAINERS === "1";

  const trustedMode =
    overrides.trustedMode !== undefined
      ? Boolean(overrides.trustedMode)
      : process.env.ARENA_TRUSTED_MODE !== undefined
      ? process.env.ARENA_TRUSTED_MODE === "true" || process.env.ARENA_TRUSTED_MODE === "1"
      : localDemoContainers
      ? false
      : DEFAULT_CONFIG.trustedMode;

  if (localDemoContainers && trustedMode) {
    throw new Error("localDemoContainers cannot be combined with trustedMode");
  }

  if (localDemoContainers && bind !== "127.0.0.1" && bind !== "localhost" && bind !== "::1") {
    throw new Error("ARENA_LOCAL_DEMO_CONTAINERS requires a loopback API bind address");
  }

  return {
    bind,
    port,
    allowedOrigins: origins,
    dbPath: path.resolve(dbPath),
    storageDir: path.resolve(storageDir),
    maxBodyBytes,
    maxSourceBytes,
    trustedMode,
    externalWorker,
    localDemoContainers
  };
}
