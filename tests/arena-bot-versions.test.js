/**
 * tests/arena-bot-versions.test.js
 *
 * Task 9: Immutable bot version, upload & build job business usecase,
 * and fenced build completion integrating real ArtifactStore & BuildService.
 */

"use strict";

const { describe, it, before, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

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

const TEMP_BASE_DIR = path.resolve(os.tmpdir(), "arena-bot-versions-test-" + Date.now());

let openDatabase;
let closeDatabase;
let createArtifactStore;
let createBuildService;
let createProfileRegistry;
let createMatchRepository;
let createBotVersionService;
let StaleLeaseError;
let ProfileUnavailableError;
let PayloadTooLargeError;
let BotVersionNotReadyError;
let IdempotencyConflictError;
let OwnershipError;
let NotFoundError;

before(async () => {
  fs.mkdirSync(TEMP_BASE_DIR, { recursive: true });

  const dbMod = await import("../packages/arena-node/src/persistence/sqlite-database.mjs");
  openDatabase = dbMod.openDatabase;
  closeDatabase = dbMod.closeDatabase;

  const artifactMod = await import("../packages/arena-node/src/artifacts/artifact-store.mjs");
  createArtifactStore = artifactMod.createArtifactStore;

  const buildMod = await import("../packages/arena-node/src/execution/build-service.mjs");
  createBuildService = buildMod.createBuildService;

  const profileMod = await import("../packages/arena-node/src/execution/profile-registry.mjs");
  createProfileRegistry = profileMod.createProfileRegistry;

  const matchRepoMod = await import("../packages/arena-node/src/persistence/match-repository.mjs");
  createMatchRepository = matchRepoMod.createMatchRepository;

  const serviceMod = await import("../packages/arena-node/src/persistence/bot-version-service.mjs");
  createBotVersionService = serviceMod.createBotVersionService;
  StaleLeaseError = serviceMod.StaleLeaseError;
  ProfileUnavailableError = serviceMod.ProfileUnavailableError;
  PayloadTooLargeError = serviceMod.PayloadTooLargeError;
  BotVersionNotReadyError = serviceMod.BotVersionNotReadyError;
  IdempotencyConflictError = serviceMod.IdempotencyConflictError;
  OwnershipError = serviceMod.OwnershipError;
  NotFoundError = serviceMod.NotFoundError;
});

after(() => {
  try {
    fs.rmSync(TEMP_BASE_DIR, { recursive: true, force: true });
  } catch (_) {}
});

function setupTestEnvironment(subDir) {
  const dir = path.join(TEMP_BASE_DIR, subDir);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "arena.db");
  const storageDir = path.join(dir, "artifacts");

  const nativeBinding = process.env.ARENA_SQLITE_NATIVE_BINDING || undefined;
  const { db } = openDatabase(dbPath, nativeBinding ? { nativeBinding } : {});
  const artifactStore = createArtifactStore({ storageDir });
  const profileRegistry = createProfileRegistry();

  profileRegistry.registerProfile({
    id: "controlled-node",
    language: "node",
    revision: "node-v1",
    probe: () => ({ available: true })
  });

  // Create a controlled compiler for testing
  const fakeCompiler = {
    profileId: "controlled-node",
    profileRevision: "node-v1",
    compilerVersion: "fake-compiler 1.0",
    compile(options) {
      if (options.sourceContent && options.sourceContent.includes("SYNTAX_ERROR")) {
        return {
          status: 1,
          stdout: "",
          stderr: "CompileError: Unexpected token at line 1\n",
          error: "compilation_failed"
        };
      }
      return {
        status: 0,
        stdout: "Compiled successfully\n",
        stderr: "",
        artifactBytes: Buffer.from("compiled-executable-code", "utf8"),
        entrypoint: "bot.mjs"
      };
    }
  };

  const buildService = createBuildService({
    artifactStore,
    compilers: {
      "controlled-node": fakeCompiler
    }
  });

  const service = createBotVersionService({
    db,
    artifactStore,
    buildService,
    profileRegistry,
    maxSourceBytes: 1024 * 512 // 512 KiB
  });

  const matchRepo = createMatchRepository(db);

  // Helper to seed users and bot
  db.prepare(`
    INSERT INTO users (id, normalized_username, password_hash, role)
    VALUES
      ('user-alice', 'alice', 'hash1', 'author'),
      ('user-bob', 'bob', 'hash2', 'author'),
      ('user-admin', 'admin', 'hash3', 'admin')
  `).run();

  db.prepare(`
    INSERT INTO bots (id, owner_id, name)
    VALUES
      ('bot-alice', 'user-alice', 'AliceBot'),
      ('bot-bob', 'user-bob', 'BobBot')
  `).run();

  return {
    dir,
    dbPath,
    db,
    artifactStore,
    profileRegistry,
    buildService,
    service,
    matchRepo,
    cleanup() {
      closeDatabase(db);
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Upload & Bounded Source, Identity, and Digest Storage
// ─────────────────────────────────────────────────────────────────────────────

describe("BotVersionService: upload, bounded source UTF-8, and identity checks", () => {
  let env;

  beforeEach(() => {
    env = setupTestEnvironment("upload-tests-" + Math.random().toString(36).slice(2));
  });

  afterEach(() => {
    env?.cleanup();
  });

  it("enforces bounded UTF-8 source: rejects payload exceeding size limit with PayloadTooLargeError", async () => {
    const hugeSource = "A".repeat(1024 * 512 + 10); // > 512 KiB
    await assert.rejects(
      () => env.service.uploadBotVersion({
        botId: "bot-alice",
        sourceContent: hugeSource,
        profileId: "python"
      }, {
        actorId: "user-alice",
        idempotencyKey: "idem-huge-1"
      }),
      (err) => {
        assert.ok(err instanceof PayloadTooLargeError || err.code === "PAYLOAD_TOO_LARGE");
        return true;
      }
    );
  });

  it("stores source by SHA-256 digest in private storage without leaking client upload filename", async () => {
    const sourceCode = "def choose_move(state): return None\n";
    const result = await env.service.uploadBotVersion({
      botId: "bot-alice",
      sourceContent: sourceCode,
      profileId: "python",
      filename: "../../../etc/passwd" // Dangerous path should never be used as filesystem path
    }, {
      actorId: "user-alice",
      idempotencyKey: "idem-digest-1"
    });

    assert.ok(result.botVersion);
    assert.ok(result.botVersion.source_digest.startsWith("sha256:"));

    // Verify artifact is in artifactStore under sha256 address
    const artifact = await env.artifactStore.resolveArtifact(result.botVersion.source_digest);
    assert.ok(artifact);
    assert.ok(!artifact.path.includes("passwd"));
    assert.ok(artifact.path.startsWith(env.artifactStore.storageDir));

    // Verify artifact table in DB
    const dbRow = env.db.prepare("SELECT * FROM artifacts WHERE digest = ?").get(result.botVersion.source_digest);
    assert.ok(dbRow);
    assert.equal(dbRow.kind, "source");
    assert.ok(!dbRow.relative_private_path.includes("passwd"));
  });

  it("enforces DB ownership and rejects client role forgery", async () => {
    const sourceCode = "console.log('hi');";

    // 1. Bob tries to upload to Alice's bot -> Rejected with OwnershipError
    await assert.rejects(
      () => env.service.uploadBotVersion({
        botId: "bot-alice",
        sourceContent: sourceCode,
        profileId: "python"
      }, {
        actorId: "user-bob",
        idempotencyKey: "idem-bob-steal"
      }),
      (err) => {
        assert.ok(err instanceof OwnershipError || err.code === "OWNERSHIP_DENIED");
        return true;
      }
    );

    // 2. Bob tries to claim admin role in request parameter -> DB identity is checked, still rejected!
    await assert.rejects(
      () => env.service.uploadBotVersion({
        botId: "bot-alice",
        sourceContent: sourceCode,
        profileId: "python",
        role: "admin" // Client claim must be ignored
      }, {
        actorId: "user-bob",
        idempotencyKey: "idem-bob-forge"
      }),
      (err) => {
        assert.ok(err instanceof OwnershipError || err.code === "OWNERSHIP_DENIED");
        return true;
      }
    );

    // 3. Genuine DB admin can upload on behalf of Alice's bot
    const adminUpload = await env.service.uploadBotVersion({
      botId: "bot-alice",
      sourceContent: sourceCode,
      profileId: "python"
    }, {
      actorId: "user-admin",
      idempotencyKey: "idem-admin-1"
    });
    assert.ok(adminUpload.botVersion);
    assert.equal(adminUpload.botVersion.bot_id, "bot-alice");
  });

  it("validates execution profile: rejects unknown or unavailable profile", async () => {
    // 1. Unknown profile
    await assert.rejects(
      () => env.service.uploadBotVersion({
        botId: "bot-alice",
        sourceContent: "code",
        profileId: "nonexistent-language"
      }, {
        actorId: "user-alice",
        idempotencyKey: "idem-bad-profile"
      }),
      (err) => {
        assert.ok(err instanceof ProfileUnavailableError || err.code === "PROFILE_UNAVAILABLE" || err.code === "NOT_FOUND");
        return true;
      }
    );

    // 2. Profile registered but probe unavailable
    env.profileRegistry.registerProfile({
      id: "unsupported-arch",
      language: "asm",
      revision: "v1",
      probe: () => ({ available: false, error: "Missing toolchain" })
    });

    await assert.rejects(
      () => env.service.uploadBotVersion({
        botId: "bot-alice",
        sourceContent: "code",
        profileId: "unsupported-arch"
      }, {
        actorId: "user-alice",
        idempotencyKey: "idem-unsupported"
      }),
      (err) => {
        assert.ok(err instanceof ProfileUnavailableError || err.code === "PROFILE_UNAVAILABLE");
        return true;
      }
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Atomic Creation, Idempotency, and Concurrent Version Allocation
// ─────────────────────────────────────────────────────────────────────────────

describe("BotVersionService: atomic creation and idempotency", () => {
  let env;

  beforeEach(() => {
    env = setupTestEnvironment("idempotency-tests-" + Math.random().toString(36).slice(2));
  });

  afterEach(() => {
    env?.cleanup();
  });

  it("atomically creates bot version, queued build job, and idempotency record", async () => {
    const res = await env.service.uploadBotVersion({
      botId: "bot-alice",
      sourceContent: "print('hello')",
      profileId: "python"
    }, {
      actorId: "user-alice",
      idempotencyKey: "idem-atomic-1"
    });

    assert.ok(res.botVersion);
    assert.equal(res.botVersion.version_no, 1);
    assert.equal(res.botVersion.build_status, "pending");

    assert.ok(res.job);
    assert.equal(res.job.kind, "build");
    assert.equal(res.job.target_id, res.botVersion.id);
    assert.equal(res.job.status, "queued");
    assert.equal(res.job.attempt_no, 0);

    // Check api_requests
    const apiReq = env.db.prepare("SELECT * FROM api_requests WHERE actor_id = ? AND idempotency_key = ?")
      .get("user-alice", "idem-atomic-1");
    assert.ok(apiReq);
    assert.equal(apiReq.target_id, res.botVersion.id);
  });

  it("idempotency: same key with same payload returns existing version and job", async () => {
    const first = await env.service.uploadBotVersion({
      botId: "bot-alice",
      sourceContent: "code-v1",
      profileId: "python"
    }, {
      actorId: "user-alice",
      idempotencyKey: "idem-replay-1"
    });

    const second = await env.service.uploadBotVersion({
      botId: "bot-alice",
      sourceContent: "code-v1",
      profileId: "python"
    }, {
      actorId: "user-alice",
      idempotencyKey: "idem-replay-1"
    });

    assert.equal(second.botVersion.id, first.botVersion.id);
    assert.equal(second.job.id, first.job.id);
    assert.equal(second.botVersion.version_no, 1);
  });

  it("idempotency: same key with different payload throws IdempotencyConflictError", async () => {
    await env.service.uploadBotVersion({
      botId: "bot-alice",
      sourceContent: "code-v1",
      profileId: "python"
    }, {
      actorId: "user-alice",
      idempotencyKey: "idem-conflict-1"
    });

    await assert.rejects(
      () => env.service.uploadBotVersion({
        botId: "bot-alice",
        sourceContent: "DIFFERENT_CODE",
        profileId: "python"
      }, {
        actorId: "user-alice",
        idempotencyKey: "idem-conflict-1"
      }),
      (err) => {
        assert.ok(err instanceof IdempotencyConflictError || err.code === "IDEMPOTENCY_CONFLICT");
        return true;
      }
    );
  });

  it("idempotency: separate actors with same key string do not collide", async () => {
    const resAlice = await env.service.uploadBotVersion({
      botId: "bot-alice",
      sourceContent: "alice-code",
      profileId: "python"
    }, {
      actorId: "user-alice",
      idempotencyKey: "shared-key"
    });

    const resBob = await env.service.uploadBotVersion({
      botId: "bot-bob",
      sourceContent: "bob-code",
      profileId: "python"
    }, {
      actorId: "user-bob",
      idempotencyKey: "shared-key"
    });

    assert.notEqual(resAlice.botVersion.id, resBob.botVersion.id);
    assert.equal(resAlice.botVersion.bot_id, "bot-alice");
    assert.equal(resBob.botVersion.bot_id, "bot-bob");
  });

  it("allocates sequential version numbers sequentially and prevents overwrite of source digest", async () => {
    const v1 = await env.service.uploadBotVersion({
      botId: "bot-alice",
      sourceContent: "code 1",
      profileId: "python"
    }, {
      actorId: "user-alice",
      idempotencyKey: "key-v1"
    });

    const v2 = await env.service.uploadBotVersion({
      botId: "bot-alice",
      sourceContent: "code 2",
      profileId: "python"
    }, {
      actorId: "user-alice",
      idempotencyKey: "key-v2"
    });

    assert.equal(v1.botVersion.version_no, 1);
    assert.equal(v2.botVersion.version_no, 2);
    assert.notEqual(v1.botVersion.source_digest, v2.botVersion.source_digest);
  });

  it("serializes concurrent version allocation across worker threads", async () => {
    const { Worker } = require("node:worker_threads");
    const workerScript = path.resolve(__dirname, "fixtures/arena/concurrency-worker.mjs");
    const nativeBinding = process.env.ARENA_SQLITE_NATIVE_BINDING || undefined;

    function runWorkerTask(workerData) {
      return new Promise((resolve, reject) => {
        const worker = new Worker(workerScript, { workerData, env: process.env });
        worker.on("message", resolve);
        worker.on("error", reject);
        worker.on("exit", (code) => {
          if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
        });
      });
    }

    const t1 = runWorkerTask({
      action: "upload-service-versions",
      dbPath: env.dbPath,
      options: nativeBinding ? { nativeBinding } : {},
      params: { botId: "bot-alice", userId: "user-alice", workerId: "w1", count: 3, storageDir: env.artifactStore.storageDir }
    });
    const t2 = runWorkerTask({
      action: "upload-service-versions",
      dbPath: env.dbPath,
      options: nativeBinding ? { nativeBinding } : {},
      params: { botId: "bot-alice", userId: "user-alice", workerId: "w2", count: 3, storageDir: env.artifactStore.storageDir }
    });
    const t3 = runWorkerTask({
      action: "upload-service-versions",
      dbPath: env.dbPath,
      options: nativeBinding ? { nativeBinding } : {},
      params: { botId: "bot-alice", userId: "user-alice", workerId: "w3", count: 3, storageDir: env.artifactStore.storageDir }
    });

    const [r1, r2, r3] = await Promise.all([t1, t2, t3]);
    assert.ok(r1.success, `Worker 1 failed: ${r1.error}`);
    assert.ok(r2.success, `Worker 2 failed: ${r2.error}`);
    assert.ok(r3.success, `Worker 3 failed: ${r3.error}`);

    // Verify all 9 versions were created with exactly unique version numbers from 1 to 9
    const rows = env.db.prepare("SELECT version_no FROM bot_versions WHERE bot_id = 'bot-alice' ORDER BY version_no ASC").all();
    assert.equal(rows.length, 9, "Expected 9 versions allocated across 3 workers");
    assert.deepEqual(rows.map(r => r.version_no), [1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // Verify 9 queued build jobs were created
    const jobs = env.db.prepare("SELECT * FROM jobs WHERE kind = 'build'").all();
    assert.equal(jobs.length, 9, "Expected 9 build jobs created");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Fenced Build Completion and Artifact Publishing
// ─────────────────────────────────────────────────────────────────────────────

describe("BotVersionService: fenced build completion", () => {
  let env;

  beforeEach(() => {
    env = setupTestEnvironment("fenced-tests-" + Math.random().toString(36).slice(2));
  });

  afterEach(() => {
    env?.cleanup();
  });

  it("successfully publishes artifact before marking version READY", async () => {
    const upload = await env.service.uploadBotVersion({
      botId: "bot-alice",
      sourceContent: "console.log('valid');",
      profileId: "controlled-node"
    }, {
      actorId: "user-alice",
      idempotencyKey: "key-build-1"
    });

    // Claim build lease
    const lease = env.service.claimBuildJob({
      jobId: upload.job.id,
      leaseOwner: "build-worker-1",
      leaseDurationMs: 10000
    });

    assert.equal(lease.attemptNo, 1);
    assert.ok(lease.leaseToken);

    // Verify version is now 'building'
    const buildingVer = env.service.getBotVersion(upload.botVersion.id);
    assert.equal(buildingVer.build_status, "building");

    // Publish build artifact to ArtifactStore FIRST
    const compiledBytes = Buffer.from("executable-binary", "utf8");
    const storedArtifact = await env.artifactStore.storeArtifact("build", compiledBytes);

    // Complete build with valid lease
    const completion = await env.service.completeBuildJob({
      jobId: upload.job.id,
      attemptNo: lease.attemptNo,
      leaseToken: lease.leaseToken,
      success: true,
      artifactDigest: storedArtifact.digest,
      buildLog: "Build successful"
    });

    assert.equal(completion.job.status, "completed");
    assert.equal(completion.botVersion.build_status, "ready");
    assert.equal(completion.botVersion.artifact_digest, storedArtifact.digest);

    // Verify artifact is registered in DB artifacts table
    const artRow = env.db.prepare("SELECT * FROM artifacts WHERE digest = ?").get(storedArtifact.digest);
    assert.ok(artRow);
    assert.equal(artRow.kind, "build");
  });

  it("stale lease fence: expired lease cannot mark version READY", async () => {
    const upload = await env.service.uploadBotVersion({
      botId: "bot-alice",
      sourceContent: "code",
      profileId: "controlled-node"
    }, {
      actorId: "user-alice",
      idempotencyKey: "key-expired-1"
    });

    const lease = env.service.claimBuildJob({
      jobId: upload.job.id,
      leaseOwner: "worker-slow",
      leaseDurationMs: 10 // 10 ms lease (already expired by the time we complete)
    });

    // Manually force lease expiration in database
    env.db.prepare("UPDATE jobs SET lease_until = datetime('now', '-5 seconds') WHERE id = ?").run(upload.job.id);

    const artifact = await env.artifactStore.storeArtifact("build", Buffer.from("bin"));

    // Attempting to complete with expired lease must FAIL with StaleLeaseError
    await assert.rejects(
      () => env.service.completeBuildJob({
        jobId: upload.job.id,
        attemptNo: lease.attemptNo,
        leaseToken: lease.leaseToken,
        success: true,
        artifactDigest: artifact.digest,
        buildLog: "Attempt after timeout"
      }),
      (err) => {
        assert.ok(err instanceof StaleLeaseError || err.code === "STALE_LEASE");
        return true;
      }
    );

    // Bot version MUST NOT be marked ready!
    const ver = env.service.getBotVersion(upload.botVersion.id);
    assert.notEqual(ver.build_status, "ready");
  });

  it("stale lease fence: overtaken attempt number or mismatched token cannot mark version READY", async () => {
    const upload = await env.service.uploadBotVersion({
      botId: "bot-alice",
      sourceContent: "code",
      profileId: "controlled-node"
    }, {
      actorId: "user-alice",
      idempotencyKey: "key-overtaken-1"
    });

    const lease1 = env.service.claimBuildJob({
      jobId: upload.job.id,
      leaseOwner: "worker-1",
      leaseDurationMs: 50
    });

    // Worker 1 hangs, lease expires, Worker 2 claims attempt 2
    env.db.prepare("UPDATE jobs SET lease_until = datetime('now', '-1 second') WHERE id = ?").run(upload.job.id);

    const lease2 = env.service.claimBuildJob({
      jobId: upload.job.id,
      leaseOwner: "worker-2",
      leaseDurationMs: 10000
    });
    assert.equal(lease2.attemptNo, 2);

    const artifact1 = await env.artifactStore.storeArtifact("build", Buffer.from("bin-worker-1"));

    // Stale Worker 1 now tries to complete attempt 1 with its old leaseToken
    await assert.rejects(
      () => env.service.completeBuildJob({
        jobId: upload.job.id,
        attemptNo: lease1.attemptNo,
        leaseToken: lease1.leaseToken,
        success: true,
        artifactDigest: artifact1.digest
      }),
      (err) => {
        assert.ok(err instanceof StaleLeaseError || err.code === "STALE_LEASE");
        return true;
      }
    );

    // Check version still not ready
    const verAfterStale = env.service.getBotVersion(upload.botVersion.id);
    assert.notEqual(verAfterStale.build_status, "ready");

    // Worker 2 completes attempt 2 successfully
    const artifact2 = await env.artifactStore.storeArtifact("build", Buffer.from("bin-worker-2"));
    const completion2 = await env.service.completeBuildJob({
      jobId: upload.job.id,
      attemptNo: lease2.attemptNo,
      leaseToken: lease2.leaseToken,
      success: true,
      artifactDigest: artifact2.digest
    });

    assert.equal(completion2.botVersion.build_status, "ready");
    assert.equal(completion2.botVersion.artifact_digest, artifact2.digest);
  });

  it("records FAILED build status and diagnostic logs on compiler error", async () => {
    const upload = await env.service.uploadBotVersion({
      botId: "bot-alice",
      sourceContent: "SYNTAX_ERROR in code",
      profileId: "controlled-node"
    }, {
      actorId: "user-alice",
      idempotencyKey: "key-fail-1"
    });

    const lease = env.service.claimBuildJob({
      jobId: upload.job.id,
      leaseOwner: "worker-compile"
    });

    const completion = await env.service.completeBuildJob({
      jobId: upload.job.id,
      attemptNo: lease.attemptNo,
      leaseToken: lease.leaseToken,
      success: false,
      buildLog: "SyntaxError: Unexpected token",
      diagnostic: "compilation_failed"
    });

    assert.equal(completion.job.status, "failed");
    assert.equal(completion.botVersion.build_status, "failed");
    assert.ok(completion.botVersion.build_log.includes("SyntaxError"));
  });

  it("processBuildJob coordinates build service compilation and fenced completion", async () => {
    const upload = await env.service.uploadBotVersion({
      botId: "bot-alice",
      sourceContent: "console.log('runnable bot');",
      profileId: "controlled-node"
    }, {
      actorId: "user-alice",
      idempotencyKey: "key-process-1"
    });

    const result = await env.service.processBuildJob({
      jobId: upload.job.id,
      leaseOwner: "automated-builder"
    });

    assert.equal(result.buildResult.status, "READY");
    assert.equal(result.botVersion.build_status, "ready");
    assert.ok(result.botVersion.artifact_digest);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Artifact Verification, Tamper Quarantine, and Match Scheduling Gates
// ─────────────────────────────────────────────────────────────────────────────

describe("BotVersionService: tamper quarantine and match scheduling gates", () => {
  let env;

  beforeEach(() => {
    env = setupTestEnvironment("match-gate-tests-" + Math.random().toString(36).slice(2));
  });

  afterEach(() => {
    env?.cleanup();
  });

  it("tamper detection: corrupt artifact on disk triggers infrastructure quarantine, NOT bot loss", async () => {
    // 1. Create and complete a ready bot version
    const upload = await env.service.uploadBotVersion({
      botId: "bot-alice",
      sourceContent: "valid-source",
      profileId: "controlled-node"
    }, {
      actorId: "user-alice",
      idempotencyKey: "key-tamper-1"
    });

    const build = await env.service.processBuildJob({ jobId: upload.job.id });
    const readyVer = build.botVersion;
    assert.equal(readyVer.build_status, "ready");

    // 2. Corrupt the artifact file on disk
    const artifact = await env.artifactStore.resolveArtifact(readyVer.artifact_digest);
    assert.ok(artifact);
    fs.writeFileSync(artifact.path, "MALICIOUSLY_TAMPERED_BINARY", "utf8");

    // 3. Verifying version artifact must throw INFRASTRUCTURE error (quarantine), NOT bot loss
    await assert.rejects(
      () => env.service.verifyBotVersionArtifact(readyVer.id),
      (err) => {
        assert.equal(err.kind, "infrastructure_error");
        assert.equal(err.code, "tamper_detected");
        return true;
      }
    );
  });

  it("match scheduling guard: rejects non-READY bot versions (pending or failed)", async () => {
    // Bot A: ready
    const uploadA = await env.service.uploadBotVersion({
      botId: "bot-alice",
      sourceContent: "source A",
      profileId: "controlled-node"
    }, {
      actorId: "user-alice",
      idempotencyKey: "key-match-a"
    });
    await env.service.processBuildJob({ jobId: uploadA.job.id });

    // Bot B: pending
    const uploadB = await env.service.uploadBotVersion({
      botId: "bot-bob",
      sourceContent: "source B",
      profileId: "controlled-node"
    }, {
      actorId: "user-bob",
      idempotencyKey: "key-match-b"
    });

    // Attempt to schedule match between A (ready) and B (pending)
    assert.throws(
      () => env.matchRepo.createMatch({
        kind: "ranked",
        ladderId: "ladder-1",
        ruleset: { id: "ruleset-1" },
        policy: { id: "policy-1" },
        profile: { id: "profile-1" },
        initialState: { ply: 0 },
        participants: [
          { seat: "A", botVersionId: uploadA.botVersion.id },
          { seat: "B", botVersionId: uploadB.botVersion.id }
        ]
      }),
      (err) => {
        assert.equal(err.code, "BOT_VERSION_NOT_READY");
        return true;
      }
    );

    // Fail Bot B
    const leaseB = env.service.claimBuildJob({ jobId: uploadB.job.id });
    await env.service.completeBuildJob({
      jobId: uploadB.job.id,
      attemptNo: leaseB.attemptNo,
      leaseToken: leaseB.leaseToken,
      success: false,
      buildLog: "Compile failed"
    });

    // Attempt to schedule match between A (ready) and B (failed)
    assert.throws(
      () => env.matchRepo.createMatch({
        kind: "ranked",
        ladderId: "ladder-1",
        ruleset: { id: "ruleset-1" },
        policy: { id: "policy-1" },
        profile: { id: "profile-1" },
        initialState: { ply: 0 },
        participants: [
          { seat: "A", botVersionId: uploadA.botVersion.id },
          { seat: "B", botVersionId: uploadB.botVersion.id }
        ]
      }),
      (err) => {
        assert.equal(err.code, "BOT_VERSION_NOT_READY");
        return true;
      }
    );
  });

  it("match scheduling guard: rejects bot versions with unavailable runtime profile", async () => {
    // Register profile that becomes unavailable after build
    let isAvailable = true;
    env.profileRegistry.registerProfile({
      id: "flaky-profile",
      language: "node",
      revision: "flaky-v1",
      probe: () => ({ available: isAvailable })
    });

    const upload = await env.service.uploadBotVersion({
      botId: "bot-alice",
      sourceContent: "code",
      profileId: "flaky-profile"
    }, {
      actorId: "user-alice",
      idempotencyKey: "key-flaky-1"
    });

    // Mark ready
    const art = await env.artifactStore.storeArtifact("build", Buffer.from("bin"));
    const lease = env.service.claimBuildJob({ jobId: upload.job.id });
    await env.service.completeBuildJob({
      jobId: upload.job.id,
      attemptNo: lease.attemptNo,
      leaseToken: lease.leaseToken,
      success: true,
      artifactDigest: art.digest
    });

    // Profile becomes unavailable on host
    isAvailable = false;

    await assert.rejects(
      () => env.service.validateBotVersionForMatch(upload.botVersion.id),
      (err) => {
        assert.ok(err instanceof ProfileUnavailableError || err.code === "PROFILE_UNAVAILABLE");
        return true;
      }
    );
  });
});
