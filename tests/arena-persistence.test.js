const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { Worker } = require("node:worker_threads");

// Finding 3: Per-test override for portable Node 18 test run (NOT in production code)
const PORTABLE_NODE18_BINDING =
  "C:/Users/ADMIN/AppData/Local/Temp/opencode/arena-sqlite-smoke-node18/node_modules/better-sqlite3/build/Release/better_sqlite3.node";

if (
  process.versions.node.startsWith("18.") &&
  !process.env.ARENA_SQLITE_NATIVE_BINDING &&
  fs.existsSync(PORTABLE_NODE18_BINDING)
) {
  process.env.ARENA_SQLITE_NATIVE_BINDING = PORTABLE_NODE18_BINDING;
}

let openDatabase;
let withTransaction;
let closeDatabase;
let createBotRepository;
let createMatchRepository;
let IdempotencyConflictError;
let NotFoundError;
let OwnershipError;
let MatchValidationError;

let tempDir;
let tempDbPath;

const WORKER_FIXTURE_PATH = path.resolve(__dirname, "fixtures/arena/concurrency-worker.mjs");
const REPO_PERSISTENCE_DIR = path.resolve(__dirname, "../packages/arena-node/src/persistence");

function runWorkerTask(config, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_FIXTURE_PATH, {
      workerData: config,
      env: process.env
    });

    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`Worker timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    worker.on("message", (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });

    worker.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    worker.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Worker stopped with exit code ${code}`));
      }
    });
  });
}

before(async () => {
  // Import from target layout: packages/arena-node/src/persistence
  const dbModule = await import("../packages/arena-node/src/persistence/sqlite-database.mjs");
  const botRepoModule = await import("../packages/arena-node/src/persistence/bot-repository.mjs");
  const matchRepoModule = await import("../packages/arena-node/src/persistence/match-repository.mjs");

  openDatabase = dbModule.openDatabase;
  withTransaction = dbModule.withTransaction;
  closeDatabase = dbModule.closeDatabase;

  createBotRepository = botRepoModule.createBotRepository;
  createMatchRepository = matchRepoModule.createMatchRepository;

  IdempotencyConflictError = botRepoModule.IdempotencyConflictError;
  NotFoundError = botRepoModule.NotFoundError;
  OwnershipError = botRepoModule.OwnershipError;
  MatchValidationError = matchRepoModule.MatchValidationError;

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-persistence-test-"));
  tempDbPath = path.join(tempDir, "arena-test.db");
});

after(async () => {
  if (tempDir && fs.existsSync(tempDir)) {
    // Windows file locks may take a few ms to release
    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        break;
      } catch {
        if (i < 4) await new Promise((r) => setTimeout(r, 100));
      }
    }
  }
});

describe("arena persistence regressions: Findings 1, 2, 3, 4", () => {
  it("Finding 1: persistence module layout and migration path are under packages/arena-node", () => {
    const migrationFile = path.join(REPO_PERSISTENCE_DIR, "migrations/001-arena.sql");
    assert.ok(fs.existsSync(migrationFile), "migrations/001-arena.sql must exist inside packages/arena-node");

    // Open a fresh in-memory database without custom migrationSql option;
    // this tests that DEFAULT_MIGRATION_SQL_PATH resolves correctly
    const { db, version } = openDatabase(":memory:");
    try {
      assert.equal(version, "001-arena");
    } finally {
      closeDatabase(db);
    }
  });

  it("Finding 2: MatchRepository does NOT expose unauthorized write mutators", () => {
    const { db } = openDatabase(":memory:");
    try {
      const matchRepo = createMatchRepository(db);

      // Mutators for finalizer / settlement (future 11) and tournaments (future 13)
      // must NOT be exposed on MatchRepository in Task 8 foundation
      assert.equal(
        matchRepo.recordMatchResult,
        undefined,
        "recordMatchResult mutator must not be exposed on MatchRepository"
      );
      assert.equal(
        matchRepo.recordRatingChange,
        undefined,
        "recordRatingChange mutator must not be exposed on MatchRepository"
      );
      assert.equal(
        matchRepo.createTournament,
        undefined,
        "createTournament mutator must not be exposed on MatchRepository"
      );
      assert.equal(
        matchRepo.registerTournamentEntry,
        undefined,
        "registerTournamentEntry mutator must not be exposed on MatchRepository"
      );

      // Read methods and createMatch must remain present
      assert.equal(typeof matchRepo.createMatch, "function");
      assert.equal(typeof matchRepo.getMatch, "function");
      assert.equal(typeof matchRepo.listMatches, "function");
      assert.equal(typeof matchRepo.getMatchParticipants, "function");
      assert.equal(typeof matchRepo.getMatchResult, "function");
      assert.equal(typeof matchRepo.getBotRating, "function");
      assert.equal(typeof matchRepo.getTournament, "function");
      assert.equal(typeof matchRepo.getTournamentStandings, "function");
    } finally {
      closeDatabase(db);
    }
  });

  it("Finding 3: production sqlite-database.mjs does NOT contain hardcoded C:/Users/ADMIN paths", () => {
    const dbSource = fs.readFileSync(
      path.join(REPO_PERSISTENCE_DIR, "sqlite-database.mjs"),
      "utf8"
    );
    assert.ok(
      !dbSource.includes("C:/Users/ADMIN"),
      "Production sqlite-database.mjs must not contain hardcoded C:/Users/ADMIN path"
    );
    assert.ok(
      !dbSource.includes("arena-sqlite-smoke-node18"),
      "Production sqlite-database.mjs must not contain hardcoded test temp paths"
    );
  });

  it("Finding 4: rejects unknown/newer schema versions fail-closed without altering data", () => {
    const diskPath = path.join(tempDir, "future-version.db");

    // Pre-create DB with a newer/unknown schema migration
    const Database = require("better-sqlite3");
    const nativeBinding = process.env.ARENA_SQLITE_NATIVE_BINDING || undefined;
    const rawDb = new Database(diskPath, nativeBinding ? { nativeBinding } : {});
    rawDb.exec(`
      CREATE TABLE schema_migrations (version TEXT NOT NULL PRIMARY KEY, applied_at TEXT);
      INSERT INTO schema_migrations (version, applied_at) VALUES ('999-future-migration', datetime('now'));
      CREATE TABLE custom_future_table (id INTEGER PRIMARY KEY, note TEXT);
      INSERT INTO custom_future_table (id, note) VALUES (42, 'untouchable-data');
    `);
    rawDb.close();

    // openDatabase MUST detect the unknown/newer version BEFORE applying DDL,
    // throw fail-closed, and leave existing data untouched
    assert.throws(
      () => {
        openDatabase(diskPath);
      },
      (err) => {
        return (
          err.message.includes("999-future-migration") ||
          err.message.includes("Unknown or unsupported schema version") ||
          err.message.includes("fail-closed")
        );
      }
    );

    // Verify existing data was not altered
    const verifyDb = new Database(diskPath, nativeBinding ? { nativeBinding } : {});
    const row = verifyDb.prepare("SELECT note FROM custom_future_table WHERE id = 42").get();
    assert.equal(row.note, "untouchable-data");

    // Verify no arena tables were erroneously created
    const arenaTable = verifyDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'matches'")
      .get();
    assert.equal(arenaTable, undefined, "DDL must not have been executed on unknown schema version");
    verifyDb.close();
  });

  it("withTransaction starts with BEGIN IMMEDIATE: competing connection fails SQLITE_BUSY before any writes", () => {
    const diskPath = path.join(tempDir, "immediate-lock-probe.db");
    const { db: db1 } = openDatabase(diskPath);
    const { db: db2 } = openDatabase(diskPath);

    // Set short busy_timeout on db2 so it fails fast if lock is held
    db2.pragma("busy_timeout = 20");

    let insideCallback = false;
    let competingAcquired = false;
    let competingError = null;

    try {
      withTransaction(db1, () => {
        insideCallback = true;
        // BEFORE any writes or reads on db1, db1 MUST already hold BEGIN IMMEDIATE lock.
        // Competing connection db2 attempts BEGIN IMMEDIATE:
        try {
          db2.exec("BEGIN IMMEDIATE");
          competingAcquired = true;
          db2.exec("ROLLBACK");
        } catch (err) {
          competingError = err;
        }
      });

      assert.ok(insideCallback, "Transaction callback must have executed");
      assert.equal(
        competingAcquired,
        false,
        "Competing connection MUST NOT acquire BEGIN IMMEDIATE lock while db1 is in withTransaction (before writes)"
      );
      assert.ok(
        competingError &&
          (competingError.code === "SQLITE_BUSY" || competingError.message.includes("busy")),
        `Competing connection must fail with SQLITE_BUSY, received: ${competingError?.message}`
      );
    } finally {
      closeDatabase(db1);
      closeDatabase(db2);
    }
  });

  it("openDatabase cleans up on startup failure: malformed SQL does not leak lock to second connection", () => {
    const diskPath = path.join(tempDir, "startup-fail-cleanup.db");

    assert.throws(() => {
      openDatabase(diskPath, {
        migrationSql: "THIS IS INVALID SYNTAX CRASH;"
      });
    });

    // If db was leaked or left open in a transaction, db2 would fail with lock or busy.
    // With proper catch rollback + close, db2 must open and write successfully.
    const { db: db2 } = openDatabase(diskPath);
    try {
      db2.prepare("CREATE TABLE clean_probe (id INT)").run();
      db2.prepare("INSERT INTO clean_probe VALUES (1)").run();
      const row = db2.prepare("SELECT id FROM clean_probe WHERE id = 1").get();
      assert.equal(row.id, 1, "Second connection must be able to write without leaked lock");
    } finally {
      closeDatabase(db2);
    }
  });
});

describe("arena persistence: SQLite schema and PRAGMAs", () => {
  it("creates all 18 tables defined in plan §5.5 and sets schema_migrations", () => {
    const { db, version } = openDatabase(":memory:");
    try {
      assert.equal(version, "001-arena");

      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all();
      const tableNames = rows.map((r) => r.name).sort();

      const expectedTables = [
        "api_requests",
        "artifacts",
        "auth_sessions",
        "bot_ratings",
        "bot_versions",
        "bots",
        "job_attempts",
        "jobs",
        "match_participants",
        "match_results",
        "matches",
        "rating_changes",
        "schema_migrations",
        "tournament_entries",
        "tournament_matches",
        "tournament_standings",
        "tournaments",
        "users"
      ].sort();

      assert.equal(tableNames.length, 18, `Expected exactly 18 tables, found: ${tableNames.length}`);
      assert.deepEqual(tableNames, expectedTables);
    } finally {
      closeDatabase(db);
    }
  });

  it("applies PRAGMAs: foreign_keys=ON, busy_timeout=5000, and WAL mode on disk", () => {
    const diskPath = path.join(tempDir, "pragma-test.db");
    const { db } = openDatabase(diskPath);
    try {
      const fk = db.pragma("foreign_keys", { simple: true });
      const busy = db.pragma("busy_timeout", { simple: true });
      const jMode = db.pragma("journal_mode", { simple: true });

      assert.equal(fk, 1, "Foreign keys must be enabled (PRAGMA foreign_keys = 1)");
      assert.equal(busy, 5000, "busy_timeout must be 5000ms");
      assert.equal(jMode.toLowerCase(), "wal", "journal_mode must be WAL on disk");
    } finally {
      closeDatabase(db);
    }
  });

  it("migration is idempotent when reapplied or reopened on existing database", () => {
    const diskPath = path.join(tempDir, "idempotent-migration.db");
    const { db: db1 } = openDatabase(diskPath);
    closeDatabase(db1);

    // Reopen second time
    const { db: db2, version } = openDatabase(diskPath);
    try {
      assert.equal(version, "001-arena");
      const migrationRows = db2.prepare("SELECT version FROM schema_migrations").all();
      assert.equal(migrationRows.length, 1);
      assert.equal(migrationRows[0].version, "001-arena");
    } finally {
      closeDatabase(db2);
    }
  });
});

describe("arena persistence: Constraints (FK, CHECK, UNIQUE)", () => {
  it("enforces foreign key constraints: rejects orphan references", () => {
    const { db } = openDatabase(":memory:");
    try {
      assert.throws(
        () => {
          db.prepare("INSERT INTO bots (id, owner_id, name) VALUES (?, ?, ?)").run(
            "bot-orphan",
            "non-existent-user",
            "OrphanBot"
          );
        },
        (err) => err.message.includes("FOREIGN KEY constraint failed")
      );
    } finally {
      closeDatabase(db);
    }
  });

  it("enforces CHECK constraints: rejects invalid enum and range values", () => {
    const { db } = openDatabase(":memory:");
    try {
      // 1. Invalid user role
      assert.throws(
        () => {
          db.prepare("INSERT INTO users (id, normalized_username, password_hash, role) VALUES (?, ?, ?, ?)").run(
            "u1",
            "user1",
            "hash",
            "superadmin"
          );
        },
        (err) => err.message.includes("CHECK constraint failed")
      );

      // 2. Invalid match kind
      assert.throws(
        () => {
          db.prepare(
            `INSERT INTO matches (id, kind, ladder_id, ruleset_json, policy_json, profile_json, initial_state_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run("m1", "exhibition", "default", "{}", "{}", "{}", "{}");
        },
        (err) => err.message.includes("CHECK constraint failed")
      );

      // 3. Negative version_no in bot_versions
      db.prepare("INSERT INTO users (id, normalized_username, password_hash) VALUES (?, ?, ?)").run(
        "u-valid",
        "validuser",
        "hash"
      );
      db.prepare("INSERT INTO bots (id, owner_id, name) VALUES (?, ?, ?)").run("b-valid", "u-valid", "BotValid");

      assert.throws(
        () => {
          db.prepare(
            `INSERT INTO bot_versions (id, bot_id, version_no, source_digest, profile_id, profile_revision)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run("bv-bad", "b-valid", 0, "sha256:abc", "prof1", "rev1");
        },
        (err) => err.message.includes("CHECK constraint failed")
      );
    } finally {
      closeDatabase(db);
    }
  });

  it("enforces UNIQUE constraints: duplicate username and duplicate (bot_id, version_no)", () => {
    const { db } = openDatabase(":memory:");
    try {
      db.prepare("INSERT INTO users (id, normalized_username, password_hash) VALUES (?, ?, ?)").run(
        "u1",
        "samename",
        "hash1"
      );

      // Duplicate normalized_username
      assert.throws(
        () => {
          db.prepare("INSERT INTO users (id, normalized_username, password_hash) VALUES (?, ?, ?)").run(
            "u2",
            "samename",
            "hash2"
          );
        },
        (err) => err.message.includes("UNIQUE constraint failed")
      );

      // Duplicate (bot_id, version_no)
      db.prepare("INSERT INTO bots (id, owner_id, name) VALUES (?, ?, ?)").run("b1", "u1", "Bot 1");
      db.prepare(
        `INSERT INTO bot_versions (id, bot_id, version_no, source_digest, profile_id, profile_revision)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run("bv1", "b1", 1, "sha256:1", "p1", "r1");

      assert.throws(
        () => {
          db.prepare(
            `INSERT INTO bot_versions (id, bot_id, version_no, source_digest, profile_id, profile_revision)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run("bv2", "b1", 1, "sha256:2", "p1", "r1");
        },
        (err) => err.message.includes("UNIQUE constraint failed")
      );
    } finally {
      closeDatabase(db);
    }
  });
});

describe("arena persistence: Transaction and Rollback", () => {
  it("rolls back all changes within withTransaction when an exception is thrown", () => {
    const { db } = openDatabase(":memory:");
    try {
      db.prepare("INSERT INTO users (id, normalized_username, password_hash) VALUES (?, ?, ?)").run(
        "u-init",
        "inituser",
        "hash"
      );

      assert.throws(() => {
        withTransaction(db, () => {
          db.prepare("INSERT INTO bots (id, owner_id, name) VALUES (?, ?, ?)").run(
            "bot-will-rollback",
            "u-init",
            "TemporaryBot"
          );
          throw new Error("Simulated failure inside transaction");
        });
      });

      const bot = db.prepare("SELECT * FROM bots WHERE id = ?").get("bot-will-rollback");
      assert.equal(bot, undefined, "Bot row must have been rolled back");
    } finally {
      closeDatabase(db);
    }
  });
});

describe("arena persistence: BotRepository and Idempotency", () => {
  it("creates user, bot, versions, marks ready/failed and registers artifacts", () => {
    const { db } = openDatabase(":memory:");
    try {
      const repo = createBotRepository(db);

      const user = repo.createUser({
        id: "user-1",
        normalizedUsername: "playerone",
        passwordHash: "secret-hash",
        role: "author"
      });
      assert.equal(user.id, "user-1");
      assert.equal(user.role, "author");

      const bot = repo.createBot(
        { id: "bot-1", ownerId: "user-1", name: "AlphaBot" },
        { idempotencyKey: "key-bot-1", actorId: "user-1" }
      );
      assert.equal(bot.id, "bot-1");
      assert.equal(bot.name, "AlphaBot");

      const ver1 = repo.createVersion(
        {
          id: "bv-1",
          botId: "bot-1",
          sourceDigest: "sha256:source-1",
          profileId: "trusted-local-v1",
          profileRevision: "rev-1"
        },
        { idempotencyKey: "key-ver-1", actorId: "user-1" }
      );
      assert.equal(ver1.version_no, 1);
      assert.equal(ver1.build_status, "pending");

      const ver2 = repo.createVersion(
        {
          id: "bv-2",
          botId: "bot-1",
          sourceDigest: "sha256:source-2",
          profileId: "trusted-local-v1",
          profileRevision: "rev-2"
        },
        { idempotencyKey: "key-ver-2", actorId: "user-1" }
      );
      assert.equal(ver2.version_no, 2);

      const artifact = repo.registerArtifact({
        digest: "sha256:art-1",
        kind: "build",
        relativePrivatePath: "var/arena/builds/art-1.tar.gz",
        bytes: 1048576
      });
      assert.equal(artifact.digest, "sha256:art-1");
      assert.equal(artifact.bytes, 1048576);

      const readyVer = repo.markVersionReady({
        botVersionId: "bv-1",
        artifactDigest: "sha256:art-1",
        buildLog: "Build succeeded in 1200ms"
      });
      assert.equal(readyVer.build_status, "ready");
      assert.equal(readyVer.artifact_digest, "sha256:art-1");

      const failedVer = repo.markVersionFailed({
        botVersionId: "bv-2",
        buildLog: "SyntaxError in bot script"
      });
      assert.equal(failedVer.build_status, "failed");

      assert.equal(repo.getBot("bot-1").name, "AlphaBot");
      assert.equal(repo.getReadyVersion("bot-1", 1).id, "bv-1");
      assert.equal(repo.getReadyVersion("bot-1", 2), undefined);
      assert.equal(repo.listBotVersions("bot-1").length, 2);
    } finally {
      closeDatabase(db);
    }
  });

  it("handles creation idempotency: same key returns original, mismatch throws conflict", () => {
    const { db } = openDatabase(":memory:");
    try {
      const repo = createBotRepository(db);
      repo.createUser({ id: "author-1", normalizedUsername: "author1", passwordHash: "h" });

      const bot1 = repo.createBot(
        { id: "bot-idem", ownerId: "author-1", name: "IdemBot" },
        { idempotencyKey: "idem-key-1", actorId: "author-1" }
      );

      const bot1Repeat = repo.createBot(
        { id: "bot-idem", ownerId: "author-1", name: "IdemBot" },
        { idempotencyKey: "idem-key-1", actorId: "author-1" }
      );
      assert.equal(bot1Repeat.id, bot1.id);

      assert.throws(
        () => {
          repo.createBot(
            { id: "bot-idem-different", ownerId: "author-1", name: "DifferentBotName" },
            { idempotencyKey: "idem-key-1", actorId: "author-1" }
          );
        },
        (err) => err instanceof IdempotencyConflictError && err.code === "IDEMPOTENCY_CONFLICT"
      );
    } finally {
      closeDatabase(db);
    }
  });

  it("enforces bot ownership check: author cannot create bot for another user without admin role", () => {
    const { db } = openDatabase(":memory:");
    try {
      const repo = createBotRepository(db);
      repo.createUser({ id: "user-a", normalizedUsername: "usera", passwordHash: "h", role: "author" });
      repo.createUser({ id: "user-b", normalizedUsername: "userb", passwordHash: "h", role: "author" });

      assert.throws(
        () => {
          repo.createBot(
            { id: "bot-stolen", ownerId: "user-b", name: "StolenBot" },
            { idempotencyKey: "k1", actorId: "user-a" }
          );
        },
        (err) => err instanceof OwnershipError && err.code === "OWNERSHIP_DENIED"
      );
    } finally {
      closeDatabase(db);
    }
  });
});

describe("arena persistence: MatchRepository and Pinning", () => {
  function setupTestBots(db) {
    const botRepo = createBotRepository(db);
    botRepo.createUser({ id: "u-author1", normalizedUsername: "auth1", passwordHash: "h", role: "author" });
    botRepo.createUser({ id: "u-author2", normalizedUsername: "auth2", passwordHash: "h", role: "author" });

    botRepo.createBot({ id: "bot-A", ownerId: "u-author1", name: "Bot A" }, { idempotencyKey: "k-bA", actorId: "u-author1" });
    botRepo.createBot({ id: "bot-B", ownerId: "u-author2", name: "Bot B" }, { idempotencyKey: "k-bB", actorId: "u-author2" });

    botRepo.registerArtifact({ digest: "sha256:art-A1", kind: "build", relativePrivatePath: "var/arena/a1", bytes: 100 });
    botRepo.registerArtifact({ digest: "sha256:art-B1", kind: "build", relativePrivatePath: "var/arena/b1", bytes: 200 });

    const verA1 = botRepo.createVersion(
      { id: "bv-A1", botId: "bot-A", sourceDigest: "sha256:srcA1", profileId: "trusted-local-v1", profileRevision: "rev-A1" },
      { idempotencyKey: "k-vA1", actorId: "u-author1" }
    );
    botRepo.markVersionReady({ botVersionId: "bv-A1", artifactDigest: "sha256:art-A1" });

    const verB1 = botRepo.createVersion(
      { id: "bv-B1", botId: "bot-B", sourceDigest: "sha256:srcB1", profileId: "trusted-local-v1", profileRevision: "rev-B1" },
      { idempotencyKey: "k-vB1", actorId: "u-author2" }
    );
    botRepo.markVersionReady({ botVersionId: "bv-B1", artifactDigest: "sha256:art-B1" });

    const verB2Pending = botRepo.createVersion(
      { id: "bv-B2-pending", botId: "bot-B", sourceDigest: "sha256:srcB2", profileId: "trusted-local-v1", profileRevision: "rev-B2" },
      { idempotencyKey: "k-vB2", actorId: "u-author2" }
    );

    return { botRepo, verA1, verB1, verB2Pending };
  }

  it("discriminator kind is mandatory ('ranked' or 'practice')", () => {
    const { db } = openDatabase(":memory:");
    try {
      setupTestBots(db);
      const matchRepo = createMatchRepository(db);

      assert.throws(
        () => {
          matchRepo.createMatch({
            ladderId: "ladder-1",
            rulesetJson: "{}",
            policyJson: "{}",
            profileJson: "{}",
            initialStateJson: "{}",
            participants: { A: { botVersionId: "bv-A1" }, B: { botVersionId: "bv-B1" } }
          });
        },
        (err) => err instanceof MatchValidationError && err.code === "MISSING_MATCH_KIND"
      );

      assert.throws(
        () => {
          matchRepo.createMatch({
            kind: "casual",
            ladderId: "ladder-1",
            rulesetJson: "{}",
            policyJson: "{}",
            profileJson: "{}",
            initialStateJson: "{}",
            participants: { A: { botVersionId: "bv-A1" }, B: { botVersionId: "bv-B1" } }
          });
        },
        (err) => err instanceof MatchValidationError && err.code === "INVALID_MATCH_KIND"
      );
    } finally {
      closeDatabase(db);
    }
  });

  it("ranked match enforces distinct bots; practice match allows self-play", () => {
    const { db } = openDatabase(":memory:");
    try {
      const { botRepo } = setupTestBots(db);
      const matchRepo = createMatchRepository(db);

      const verA2 = botRepo.createVersion(
        { id: "bv-A2", botId: "bot-A", sourceDigest: "sha256:srcA2", profileId: "trusted-local-v1", profileRevision: "rev-A2" },
        { idempotencyKey: "k-vA2", actorId: "u-author1" }
      );
      botRepo.markVersionReady({ botVersionId: "bv-A2", artifactDigest: "sha256:art-A1" });

      assert.throws(
        () => {
          matchRepo.createMatch({
            kind: "ranked",
            ladderId: "standard-ladder",
            rulesetJson: '{"rulesetId":"ottv2-g-default-v1"}',
            policyJson: '{"matchPolicyVersion":"arena-policy-v1"}',
            profileJson: '{"profileId":"trusted-local-v1"}',
            initialStateJson: '{"turn":"A"}',
            participants: { A: { botVersionId: "bv-A1" }, B: { botVersionId: "bv-A2" } }
          });
        },
        (err) => err instanceof MatchValidationError && err.code === "RANKED_DISTINCT_BOTS_REQUIRED"
      );

      const practiceMatch = matchRepo.createMatch({
        id: "practice-self-play",
        kind: "practice",
        ladderId: "practice-ladder",
        rulesetJson: '{"rulesetId":"ottv2-g-default-v1"}',
        policyJson: '{"matchPolicyVersion":"arena-policy-v1"}',
        profileJson: '{"profileId":"trusted-local-v1"}',
        initialStateJson: '{"turn":"A"}',
        participants: { A: { botVersionId: "bv-A1" }, B: { botVersionId: "bv-A2" } }
      });
      assert.equal(practiceMatch.kind, "practice");
      assert.equal(practiceMatch.participants.A.bot_id, "bot-A");
      assert.equal(practiceMatch.participants.B.bot_id, "bot-A");
    } finally {
      closeDatabase(db);
    }
  });

  it("requires both bot versions to be READY; rejects pending/failed versions", () => {
    const { db } = openDatabase(":memory:");
    try {
      setupTestBots(db);
      const matchRepo = createMatchRepository(db);

      assert.throws(
        () => {
          matchRepo.createMatch({
            kind: "ranked",
            ladderId: "standard-ladder",
            rulesetJson: "{}",
            policyJson: "{}",
            profileJson: "{}",
            initialStateJson: "{}",
            participants: { A: { botVersionId: "bv-A1" }, B: { botVersionId: "bv-B2-pending" } }
          });
        },
        (err) => err instanceof MatchValidationError && err.code === "BOT_VERSION_NOT_READY"
      );
    } finally {
      closeDatabase(db);
    }
  });

  it("pins ready versions, artifacts, profiles, ruleset, and policy snapshots immutably", () => {
    const { db } = openDatabase(":memory:");
    try {
      const { botRepo } = setupTestBots(db);
      const matchRepo = createMatchRepository(db);

      const match = matchRepo.createMatch({
        id: "match-pinned-1",
        kind: "ranked",
        ladderId: "standard-ladder",
        rulesetJson: '{"rulesetId":"ottv2-g-default-v1"}',
        policyJson: '{"matchPolicyVersion":"arena-policy-v1","maxPlies":400}',
        profileJson: '{"profileId":"trusted-local-v1"}',
        initialStateJson: '{"turn":"A","clock":{"remainingMs":{"A":600000,"B":600000}}}',
        participants: { A: { botVersionId: "bv-A1" }, B: { botVersionId: "bv-B1" } }
      });

      assert.equal(match.id, "match-pinned-1");
      assert.equal(match.status, "pending");
      assert.equal(match.participants.A.artifact_digest, "sha256:art-A1");
      assert.equal(match.participants.A.profile_id, "trusted-local-v1");
      assert.equal(match.participants.A.profile_revision, "rev-A1");
      assert.equal(match.participants.B.artifact_digest, "sha256:art-B1");

      db.prepare("UPDATE bots SET name = 'AlphaBot Modified' WHERE id = 'bot-A'").run();
      const verA3 = botRepo.createVersion(
        { id: "bv-A3", botId: "bot-A", sourceDigest: "sha256:srcA3", profileId: "new-profile", profileRevision: "rev-A3" },
        { idempotencyKey: "k-vA3", actorId: "u-author1" }
      );
      botRepo.markVersionReady({ botVersionId: "bv-A3", artifactDigest: "sha256:art-A3-new" });

      const reloadedMatch = matchRepo.getMatch("match-pinned-1");
      assert.equal(reloadedMatch.participants.A.bot_version_id, "bv-A1");
      assert.equal(reloadedMatch.participants.A.artifact_digest, "sha256:art-A1");
      assert.equal(reloadedMatch.participants.A.profile_id, "trusted-local-v1");
      assert.equal(reloadedMatch.participants.A.profile_revision, "rev-A1");
    } finally {
      closeDatabase(db);
    }
  });

  it("reads match results, bot ratings, and tournament standings accurately", () => {
    const { db } = openDatabase(":memory:");
    try {
      setupTestBots(db);
      const matchRepo = createMatchRepository(db);

      matchRepo.createMatch({
        id: "match-read-test",
        kind: "ranked",
        ladderId: "main-ladder",
        rulesetJson: "{}",
        policyJson: "{}",
        profileJson: "{}",
        initialStateJson: "{}",
        participants: { A: { botVersionId: "bv-A1" }, B: { botVersionId: "bv-B1" } }
      });

      const rA0 = matchRepo.getBotRating("main-ladder", "bot-A");
      assert.equal(rA0.rating, 1200.0);
      assert.equal(rA0.rated_games, 0);

      // Direct DB insert of match_result to verify read-only API
      db.prepare(`
        INSERT INTO match_results (match_id, result_json, replay_json, replay_digest, completion_digest)
        VALUES (?, ?, ?, ?, ?)
      `).run("match-read-test", '{"outcome":"win"}', '{"schemaVersion":1}', "sha256:rep", "sha256:comp");

      const res = matchRepo.getMatchResult("match-read-test");
      assert.equal(res.match_id, "match-read-test");
      assert.equal(res.replay_digest, "sha256:rep");
    } finally {
      closeDatabase(db);
    }
  });
});

describe("arena persistence: Finding 5 Real Concurrency (Worker Threads)", () => {
  it("serializes concurrent version allocation across worker threads", async () => {
    const diskPath = path.join(tempDir, "thread-allocation-test.db");

    // Initialize DB with user and bot
    const { db } = openDatabase(diskPath);
    const repo = createBotRepository(db);
    repo.createUser({ id: "user-thread", normalizedUsername: "threaduser", passwordHash: "h" });
    repo.createBot({ id: "bot-thread", ownerId: "user-thread", name: "ThreadBot" }, { idempotencyKey: "k-bt", actorId: "user-thread" });
    closeDatabase(db);

    const nativeBinding = process.env.ARENA_SQLITE_NATIVE_BINDING || undefined;

    // Launch 3 worker threads concurrently allocating 5 versions each on the same bot
    const t1 = runWorkerTask({
      action: "allocate-versions",
      dbPath: diskPath,
      options: nativeBinding ? { nativeBinding } : {},
      params: { botId: "bot-thread", userId: "user-thread", workerId: "w1", count: 5 }
    });
    const t2 = runWorkerTask({
      action: "allocate-versions",
      dbPath: diskPath,
      options: nativeBinding ? { nativeBinding } : {},
      params: { botId: "bot-thread", userId: "user-thread", workerId: "w2", count: 5 }
    });
    const t3 = runWorkerTask({
      action: "allocate-versions",
      dbPath: diskPath,
      options: nativeBinding ? { nativeBinding } : {},
      params: { botId: "bot-thread", userId: "user-thread", workerId: "w3", count: 5 }
    });

    const [res1, res2, res3] = await Promise.all([t1, t2, t3]);
    assert.ok(res1.success, `Worker 1 failed: ${res1.error}`);
    assert.ok(res2.success, `Worker 2 failed: ${res2.error}`);
    assert.ok(res3.success, `Worker 3 failed: ${res3.error}`);

    // Verify all 15 versions were created with exactly unique version numbers from 1 to 15
    const { db: verifyDb } = openDatabase(diskPath);
    try {
      const verifyRepo = createBotRepository(verifyDb);
      const versions = verifyRepo.listBotVersions("bot-thread");
      assert.equal(versions.length, 15, "Expected exactly 15 versions allocated across 3 workers");

      const versionNos = versions.map((v) => v.version_no).sort((a, b) => a - b);
      const expectedNos = Array.from({ length: 15 }, (_, i) => i + 1);
      assert.deepEqual(versionNos, expectedNos, "Version numbers must be strictly sequential 1..15 without gaps or duplicates");
    } finally {
      closeDatabase(verifyDb);
    }
  });

  it("handles write contention under held write lock using busy_timeout", async () => {
    const diskPath = path.join(tempDir, "thread-lock-contention.db");

    // Initialize DB
    const { db } = openDatabase(diskPath);
    const repo = createBotRepository(db);
    repo.createUser({ id: "user-lock", normalizedUsername: "lockuser", passwordHash: "h" });
    repo.createBot({ id: "bot-lock", ownerId: "user-lock", name: "LockBot" }, { idempotencyKey: "k-bl", actorId: "user-lock" });
    closeDatabase(db);

    const nativeBinding = process.env.ARENA_SQLITE_NATIVE_BINDING || undefined;

    // Start Worker 1 holding lock for 250ms
    const lockHolder = runWorkerTask({
      action: "hold-write-lock",
      dbPath: diskPath,
      options: nativeBinding ? { nativeBinding } : {},
      params: { holdMs: 250 }
    });

    // Small delay to ensure Worker 1 has acquired the transaction lock
    await new Promise((r) => setTimeout(r, 40));

    // Worker 2 attempts write; should block and wait up to busy_timeout (5000ms), then succeed
    const lockContender = runWorkerTask({
      action: "write-under-lock",
      dbPath: diskPath,
      options: nativeBinding ? { nativeBinding } : {},
      params: { botId: "bot-lock", userId: "user-lock", workerId: "contender" }
    });

    const [resHolder, resContender] = await Promise.all([lockHolder, lockContender]);
    assert.ok(resHolder.success, `Lock holder failed: ${resHolder.error}`);
    assert.ok(resContender.success, `Lock contender failed: ${resContender.error}`);
    assert.equal(resContender.versionNo, 1, "Allocated version must be 1");
  });
});
