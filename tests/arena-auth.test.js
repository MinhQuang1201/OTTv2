/**
 * tests/arena-auth.test.js
 *
 * Task 14 (Milestone M4): Arena HTTP API Authentication, Accounts, and Authorization.
 *
 * Tests:
 * 1. Password hashing (scrypt + salt) and secure verification.
 * 2. User management CLI (manage-user.mjs) bootstrap for admin and author accounts.
 * 3. Opaque session tokens (SHA-256 storage, 24h TTL, revocation on logout).
 * 4. Login rate-limiting on repeated failures (HTTP 429).
 * 5. Token privacy (tokens forbidden in URL/query, no tokens in logs/errors).
 * 6. DB-authoritative roles and ownership (no request userId/role spoofing).
 * 7. CORS exact allowlist enforcement.
 * 8. Strict isolation: no Worker auth/factory calls, no server.js changes, arena account cannot create OTT rooms.
 */

"use strict";

const { describe, it, before, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const { createHash } = require("node:crypto");

// Per-test override for portable Node 18 test run (NOT in production code)
const PORTABLE_NODE18_BINDING =
  "C:/Users/ADMIN/AppData/Local/Temp/opencode/arena-sqlite-smoke-node18/node_modules/better-sqlite3/build/Release/better_sqlite3.node";

if (
  process.versions.node.startsWith("18.") &&
  !process.env.ARENA_SQLITE_NATIVE_BINDING &&
  fs.existsSync(PORTABLE_NODE18_BINDING)
) {
  process.env.ARENA_SQLITE_NATIVE_BINDING = PORTABLE_NODE18_BINDING;
}

const TEMP_BASE_DIR = path.resolve(os.tmpdir(), "arena-auth-test-" + Date.now());

let openDatabase;
let closeDatabase;
let createArtifactStore;
let createProfileRegistry;
let createBuildService;
let createBotVersionService;
let createBotRepository;
let createMatchRepository;
let createTournamentRepository;
let createJobQueue;
let createMatchFinalizer;

let hashPassword;
let verifyPassword;
let createSession;
let verifySession;
let revokeSession;
let createArenaServer;
let manageUserCli;

before(async () => {
  fs.mkdirSync(TEMP_BASE_DIR, { recursive: true });

  const dbMod = await import("../packages/arena-node/src/persistence/sqlite-database.mjs");
  openDatabase = dbMod.openDatabase;
  closeDatabase = dbMod.closeDatabase;

  const accountsMod = await import("../apps/arena-api/src/auth/accounts.mjs");
  hashPassword = accountsMod.hashPassword;
  verifyPassword = accountsMod.verifyPassword;
  createSession = accountsMod.createSession;
  verifySession = accountsMod.verifySession;
  revokeSession = accountsMod.revokeSession;

  const serverMod = await import("../apps/arena-api/src/http-server.mjs");
  createArenaServer = serverMod.createArenaServer;

  const cliMod = await import("../apps/arena-api/scripts/manage-user.mjs");
  manageUserCli = cliMod.manageUserCli;
});

after(() => {
  try {
    fs.rmSync(TEMP_BASE_DIR, { recursive: true, force: true });
  } catch (_) {}
});

function setupTestEnv(testName) {
  const dir = path.join(TEMP_BASE_DIR, testName);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "arena.db");
  const storageDir = path.join(dir, "artifacts");
  fs.mkdirSync(storageDir, { recursive: true });

  const nativeBinding = process.env.ARENA_SQLITE_NATIVE_BINDING || undefined;
  const { db } = openDatabase(dbPath, nativeBinding ? { nativeBinding } : {});

  return { dir, dbPath, storageDir, db };
}

/** Helper to make HTTP request to test server */
function makeRequest(server, options, body = null) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const reqOptions = {
      hostname: "127.0.0.1",
      port: addr.port,
      path: options.path,
      method: options.method || "GET",
      headers: {
        ...(options.headers || {})
      }
    };

    if (body && !reqOptions.headers["Content-Type"] && !reqOptions.headers["content-type"]) {
      reqOptions.headers["Content-Type"] = "application/json";
    }

    const req = http.request(reqOptions, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(rawBody);
        } catch (_) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          rawBody,
          json
        });
      });
    });

    req.on("error", reject);

    if (body) {
      if (typeof body === "string" || Buffer.isBuffer(body)) {
        req.write(body);
      } else {
        req.write(JSON.stringify(body));
      }
    }
    req.end();
  });
}

describe("Arena Auth & Accounts — Task 14", () => {
  it("hashes password with Node scrypt+salt and verifies timing-safe", () => {
    const password = "SuperSecretPassword123!";
    const hash = hashPassword(password);

    assert.ok(hash.startsWith("scrypt$"), "Hash format must start with scrypt$");
    const parts = hash.split("$");
    assert.equal(parts.length, 3, "Hash format must have 3 segments");

    // Correct password verifies true
    assert.equal(verifyPassword(password, hash), true);

    // Incorrect password verifies false
    assert.equal(verifyPassword("WrongPassword", hash), false);

    // Distinct salts produce distinct hashes for identical passwords
    const hash2 = hashPassword(password);
    assert.notEqual(hash, hash2, "Distinct salts must produce distinct hashes");
    assert.equal(verifyPassword(password, hash2), true);
  });

  it("manage-user CLI bootstraps admin and author accounts into DB", async () => {
    const env = setupTestEnv("cli-bootstrap");

    // 1. Create admin user
    const adminCode = await manageUserCli([
      "create",
      "--username",
      "alice-admin",
      "--role",
      "admin",
      "--password",
      "AdminPass123!",
      "--db",
      env.dbPath
    ]);
    assert.equal(adminCode, 0, "admin creation CLI should exit 0");

    // 2. Create author user
    const authorCode = await manageUserCli([
      "create",
      "--username",
      "bob-author",
      "--role",
      "author",
      "--password",
      "AuthorPass123!",
      "--db",
      env.dbPath
    ]);
    assert.equal(authorCode, 0, "author creation CLI should exit 0");

    // Verify DB entries
    const adminUser = env.db.prepare("SELECT * FROM users WHERE normalized_username = ?").get("alice-admin");
    assert.ok(adminUser);
    assert.equal(adminUser.role, "admin");
    assert.equal(adminUser.status, "active");
    assert.equal(verifyPassword("AdminPass123!", adminUser.password_hash), true);

    const authorUser = env.db.prepare("SELECT * FROM users WHERE normalized_username = ?").get("bob-author");
    assert.ok(authorUser);
    assert.equal(authorUser.role, "author");
    assert.equal(authorUser.status, "active");
    assert.equal(verifyPassword("AuthorPass123!", authorUser.password_hash), true);

    // Reject duplicate username
    const dupCode = await manageUserCli([
      "create",
      "--username",
      "alice-admin",
      "--role",
      "author",
      "--password",
      "AnotherPass",
      "--db",
      env.dbPath
    ]);
    assert.equal(dupCode, 1, "Duplicate username CLI must fail with code 1");

    closeDatabase(env.db);
  });

  it("creates opaque session token, stores SHA256 in DB with 24h TTL, and revokes on logout", async () => {
    const env = setupTestEnv("session-tokens");
    const password = "ValidPassword123!";
    const hash = hashPassword(password);

    env.db
      .prepare(
        "INSERT INTO users (id, normalized_username, password_hash, role, status) VALUES (?, ?, ?, ?, ?)"
      )
      .run("usr-1", "testuser", hash, "author", "active");

    // 1. Create session
    const session = createSession(env.db, "usr-1");
    assert.ok(session.token, "Opaque token must be returned");
    assert.equal(typeof session.token, "string");
    assert.ok(session.token.length >= 32, "Token should be cryptographically strong");

    const expectedHash = createHash("sha256").update(session.token).digest("hex");

    // Verify DB stores only SHA-256 hash, NOT the raw token
    const dbSession = env.db.prepare("SELECT * FROM auth_sessions WHERE token_hash = ?").get(expectedHash);
    assert.ok(dbSession, "Session must exist in DB by token_hash");
    assert.equal(dbSession.user_id, "usr-1");
    assert.equal(dbSession.revoked_at, null);

    const expiresAt = new Date(dbSession.expires_at).getTime();
    const now = Date.now();
    const diffHours = (expiresAt - now) / (1000 * 60 * 60);
    assert.ok(diffHours >= 23.9 && diffHours <= 24.1, `TTL must be ~24 hours, got ${diffHours}h`);

    // 2. Verify active session
    const verifyRes = verifySession(env.db, session.token);
    assert.equal(verifyRes.ok, true);
    assert.equal(verifyRes.user.id, "usr-1");
    assert.equal(verifyRes.user.role, "author");

    // 3. Revoke session
    revokeSession(env.db, session.token);
    const revokedRes = verifySession(env.db, session.token);
    assert.equal(revokedRes.ok, false);
    assert.equal(revokedRes.error, "SESSION_REVOKED");

    closeDatabase(env.db);
  });

  it("rejects expired session and disabled account", async () => {
    const env = setupTestEnv("session-expiry-disabled");
    const hash = hashPassword("Pass123!");

    env.db
      .prepare(
        "INSERT INTO users (id, normalized_username, password_hash, role, status) VALUES (?, ?, ?, ?, ?)"
      )
      .run("usr-expired", "expireduser", hash, "author", "active");

    // Session expired 1 hour ago
    const expiredToken = "expired-token-12345678901234567890";
    const expiredHash = createHash("sha256").update(expiredToken).digest("hex");
    const pastDate = new Date(Date.now() - 3600000).toISOString();

    env.db
      .prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(expiredHash, "usr-expired", pastDate);

    const expiredRes = verifySession(env.db, expiredToken);
    assert.equal(expiredRes.ok, false);
    assert.equal(expiredRes.error, "SESSION_EXPIRED");

    // User suspended
    env.db
      .prepare(
        "INSERT INTO users (id, normalized_username, password_hash, role, status) VALUES (?, ?, ?, ?, ?)"
      )
      .run("usr-suspended", "suspendeduser", hash, "author", "suspended");

    const sessionSuspended = createSession(env.db, "usr-suspended");
    const suspendedRes = verifySession(env.db, sessionSuspended.token);
    assert.equal(suspendedRes.ok, false);
    assert.equal(suspendedRes.error, "ACCOUNT_DISABLED");

    closeDatabase(env.db);
  });

  describe("HTTP Auth Endpoints & Security Checks", () => {
    let env;
    let server;
    let allowedOrigin = "http://127.0.0.1:3000";

    before(async () => {
      env = setupTestEnv("http-auth-suite");

      // Seed admin and author
      const adminHash = hashPassword("AdminSecret123!");
      env.db
        .prepare(
          "INSERT INTO users (id, normalized_username, password_hash, role, status) VALUES (?, ?, ?, ?, ?)"
        )
        .run("u-admin", "admin", adminHash, "admin", "active");

      const authorHash = hashPassword("AuthorSecret123!");
      env.db
        .prepare(
          "INSERT INTO users (id, normalized_username, password_hash, role, status) VALUES (?, ?, ?, ?, ?)"
        )
        .run("u-author", "author", authorHash, "author", "active");

      const suspendedHash = hashPassword("SuspendedSecret123!");
      env.db
        .prepare(
          "INSERT INTO users (id, normalized_username, password_hash, role, status) VALUES (?, ?, ?, ?, ?)"
        )
        .run("u-suspended", "suspended", suspendedHash, "author", "suspended");

      server = createArenaServer({
        db: env.db,
        allowedOrigins: [allowedOrigin],
        trustedMode: true
      });

      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    });

    after(async () => {
      await new Promise((resolve) => server.close(resolve));
      closeDatabase(env.db);
    });

    it("POST /api/arena/v1/auth/login authenticates valid credentials and returns opaque token", async () => {
      const res = await makeRequest(
        server,
        {
          path: "/api/arena/v1/auth/login",
          method: "POST"
        },
        { username: "author", password: "AuthorSecret123!" }
      );

      assert.equal(res.statusCode, 200);
      assert.ok(res.json?.token, "Must return token");
      assert.equal(res.json?.user?.username, "author");
      assert.equal(res.json?.user?.role, "author");
      assert.ok(res.json?.expiresAt);

      // Verify trace request ID header is returned
      assert.ok(res.headers["x-request-id"], "Response must include X-Request-Id");
    });

    it("POST /api/arena/v1/auth/login rejects invalid credentials and suspended accounts with 401", async () => {
      // Wrong password
      const wrongPassRes = await makeRequest(
        server,
        {
          path: "/api/arena/v1/auth/login",
          method: "POST"
        },
        { username: "author", password: "WrongPassword" }
      );
      assert.equal(wrongPassRes.statusCode, 401);
      assert.equal(wrongPassRes.json?.error?.code, "INVALID_CREDENTIALS");

      // Non-existent user
      const unknownRes = await makeRequest(
        server,
        {
          path: "/api/arena/v1/auth/login",
          method: "POST"
        },
        { username: "nonexistent", password: "SomePassword" }
      );
      assert.equal(unknownRes.statusCode, 401);
      assert.equal(unknownRes.json?.error?.code, "INVALID_CREDENTIALS");

      // Suspended account
      const suspendedRes = await makeRequest(
        server,
        {
          path: "/api/arena/v1/auth/login",
          method: "POST"
        },
        { username: "suspended", password: "SuspendedSecret123!" }
      );
      assert.equal(suspendedRes.statusCode, 401);
      assert.equal(suspendedRes.json?.error?.code, "ACCOUNT_DISABLED");
    });

    it("bounds and rate-limits repeated failed login attempts (HTTP 429)", async () => {
      // Send 5 failed login attempts for a single target username
      const targetUser = "rate-limit-test-user";
      for (let i = 0; i < 5; i++) {
        const res = await makeRequest(
          server,
          {
            path: "/api/arena/v1/auth/login",
            method: "POST"
          },
          { username: targetUser, password: "BadPassword" }
        );
        assert.equal(res.statusCode, 401);
      }

      // 6th attempt should be rate limited with 429
      const rateLimitedRes = await makeRequest(
        server,
        {
          path: "/api/arena/v1/auth/login",
          method: "POST"
        },
        { username: targetUser, password: "BadPassword" }
      );
      assert.equal(rateLimitedRes.statusCode, 429);
      assert.equal(rateLimitedRes.json?.error?.code, "TOO_MANY_REQUESTS");
    });

    it("POST /api/arena/v1/auth/logout revokes session", async () => {
      // Login first
      const loginRes = await makeRequest(
        server,
        {
          path: "/api/arena/v1/auth/login",
          method: "POST"
        },
        { username: "admin", password: "AdminSecret123!" }
      );
      const token = loginRes.json.token;

      // Verify /me works
      const meRes = await makeRequest(server, {
        path: "/api/arena/v1/me",
        method: "GET",
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.equal(meRes.statusCode, 200);
      assert.equal(meRes.json?.user?.username, "admin");

      // Logout
      const logoutRes = await makeRequest(server, {
        path: "/api/arena/v1/auth/logout",
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.equal(logoutRes.statusCode, 200);

      // Subsequent /me request fails with 401
      const meAfterLogout = await makeRequest(server, {
        path: "/api/arena/v1/me",
        method: "GET",
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.equal(meAfterLogout.statusCode, 401);
      assert.equal(meAfterLogout.json?.error?.code, "SESSION_REVOKED");
    });

    it("forbids tokens in URL query parameter (tokens must be in Authorization header only)", async () => {
      const loginRes = await makeRequest(
        server,
        {
          path: "/api/arena/v1/auth/login",
          method: "POST"
        },
        { username: "author", password: "AuthorSecret123!" }
      );
      const token = loginRes.json.token;

      // Attempting to pass token via URL query string
      const queryRes = await makeRequest(server, {
        path: `/api/arena/v1/me?token=${token}`,
        method: "GET"
      });
      assert.equal(queryRes.statusCode, 401, "Token in query parameter must be rejected");
      assert.equal(queryRes.json?.error?.code, "UNAUTHORIZED");
    });

    it("GET /me reports DB-authoritative role and source submission capability", async () => {
      // Author login
      const authorLogin = await makeRequest(
        server,
        {
          path: "/api/arena/v1/auth/login",
          method: "POST"
        },
        { username: "author", password: "AuthorSecret123!" }
      );
      const authorToken = authorLogin.json.token;

      const authorMe = await makeRequest(server, {
        path: "/api/arena/v1/me",
        method: "GET",
        headers: { Authorization: `Bearer ${authorToken}` }
      });
      assert.equal(authorMe.statusCode, 200);
      assert.equal(authorMe.json.user.role, "author");
      assert.equal(authorMe.json.canSubmitSource, false, "In trusted mode, author cannot submit source");

      // Admin login
      const adminLogin = await makeRequest(
        server,
        {
          path: "/api/arena/v1/auth/login",
          method: "POST"
        },
        { username: "admin", password: "AdminSecret123!" }
      );
      const adminToken = adminLogin.json.token;

      const adminMe = await makeRequest(server, {
        path: "/api/arena/v1/me",
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      assert.equal(adminMe.statusCode, 200);
      assert.equal(adminMe.json.user.role, "admin");
      assert.equal(adminMe.json.canSubmitSource, true, "Admin curated source submission is enabled");
    });

    it("ignores or rejects spoofed userId or role in request body/headers", async () => {
      const authorLogin = await makeRequest(
        server,
        {
          path: "/api/arena/v1/auth/login",
          method: "POST"
        },
        { username: "author", password: "AuthorSecret123!" }
      );
      const authorToken = authorLogin.json.token;

      // Send request attempting to spoof admin role in header or body
      const spoofRes = await makeRequest(server, {
        path: "/api/arena/v1/me",
        method: "GET",
        headers: {
          Authorization: `Bearer ${authorToken}`,
          "X-User-Id": "u-admin",
          "X-Role": "admin"
        }
      });
      assert.equal(spoofRes.statusCode, 200);
      assert.equal(spoofRes.json.user.role, "author", "Role must be author authoritative from DB, never headers");
      assert.equal(spoofRes.json.user.id, "u-author", "User ID must be u-author from DB");
    });

    it("enforces CORS exact allowlist on preflight and regular requests", async () => {
      // 1. Allowed origin preflight
      const allowedOptRes = await makeRequest(server, {
        path: "/api/arena/v1/capabilities",
        method: "OPTIONS",
        headers: {
          Origin: allowedOrigin,
          "Access-Control-Request-Method": "GET"
        }
      });
      assert.equal(allowedOptRes.statusCode, 204);
      assert.equal(allowedOptRes.headers["access-control-allow-origin"], allowedOrigin);
      assert.ok(allowedOptRes.headers["access-control-allow-methods"]);

      // 2. Disallowed origin preflight
      const disallowedOptRes = await makeRequest(server, {
        path: "/api/arena/v1/capabilities",
        method: "OPTIONS",
        headers: {
          Origin: "http://malicious-site.example.com",
          "Access-Control-Request-Method": "GET"
        }
      });
      assert.equal(disallowedOptRes.statusCode, 403);
      assert.equal(disallowedOptRes.headers["access-control-allow-origin"], undefined);

      // 3. Regular request with allowed origin
      const allowedGetRes = await makeRequest(server, {
        path: "/api/arena/v1/capabilities",
        method: "GET",
        headers: {
          Origin: allowedOrigin
        }
      });
      assert.equal(allowedGetRes.statusCode, 200);
      assert.equal(allowedGetRes.headers["access-control-allow-origin"], allowedOrigin);

      // 4. Regular request with disallowed origin
      const disallowedGetRes = await makeRequest(server, {
        path: "/api/arena/v1/capabilities",
        method: "GET",
        headers: {
          Origin: "http://malicious-site.example.com"
        }
      });
      assert.equal(disallowedGetRes.headers["access-control-allow-origin"], undefined);
    });

    it("maintains strict isolation from Worker auth/factory and server.js", async () => {
      // Test setting arena endpoint does not touch Worker globals or server.js
      assert.equal(typeof global.OTT_PLAYHTML_CONNECTION_FACTORY, "undefined");
      assert.equal(typeof global.OTT_INTERNAL_SECRET, "undefined");

      // Verify arena account cannot create OTT rooms (no /ott or room routes exist in arena server)
      const roomRes = await makeRequest(server, {
        path: "/ott/create",
        method: "POST"
      });
      assert.equal(roomRes.statusCode, 404, "Arena server must not handle OTT room creation");
    });
  });
});
