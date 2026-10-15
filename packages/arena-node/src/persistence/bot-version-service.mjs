/**
 * packages/arena-node/src/persistence/bot-version-service.mjs
 *
 * Task 9 (Milestone M3): Immutable bot version and upload/build-job business usecase.
 *
 * Coordinates:
 * - Content-addressed bounded UTF-8 source storage (ArtifactStore)
 * - Controlled compiler execution (BuildService)
 * - Language execution profile availability probing (ProfileRegistry)
 * - Atomic transactional creation of bot_versions + jobs (kind: 'build') + api_requests (idempotency)
 * - Fenced build job lease completion with attempt token verification
 * - Pre-publish verification of build artifacts before marking version 'ready'
 * - Integrity tamper quarantine (infrastructure error, not bot forfeit)
 * - Match scheduling guards preventing unready versions or unavailable profiles
 */

import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";

import {
  IdempotencyConflictError,
  NotFoundError,
  OwnershipError
} from "./bot-repository.mjs";

export { IdempotencyConflictError, NotFoundError, OwnershipError };

// ── Custom Domain Errors ──────────────────────────────────────────────────────

export class StaleLeaseError extends Error {
  constructor(message = "Build job lease is stale, expired, or overtaken", details = {}) {
    super(message);
    this.name = "StaleLeaseError";
    this.code = "STALE_LEASE";
    this.details = details;
  }
}

export class ProfileUnavailableError extends Error {
  constructor(message = "Profile is unavailable", profileId = null) {
    super(message);
    this.name = "ProfileUnavailableError";
    this.code = "PROFILE_UNAVAILABLE";
    this.profileId = profileId;
  }
}

export class PayloadTooLargeError extends Error {
  constructor(message = "Payload exceeds size limit", bytes = 0, maxBytes = 0) {
    super(message);
    this.name = "PayloadTooLargeError";
    this.code = "PAYLOAD_TOO_LARGE";
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

export class BotVersionNotReadyError extends Error {
  constructor(message = "Bot version is not ready", status = "pending") {
    super(message);
    this.name = "BotVersionNotReadyError";
    this.code = "BOT_VERSION_NOT_READY";
    this.status = status;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sortKeys(val) {
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(sortKeys);
  const out = {};
  for (const k of Object.keys(val).sort()) out[k] = sortKeys(val[k]);
  return out;
}

function canonicalDigest(value) {
  const json = JSON.stringify(sortKeys(value));
  return createHash("sha256").update(json, "utf8").digest("hex");
}

function toBuffer(content) {
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof Uint8Array) return Buffer.from(content);
  if (typeof content === "string") return Buffer.from(content, "utf8");
  throw new TypeError("sourceContent must be a string, Buffer, or Uint8Array");
}

function formatSqliteDate(date) {
  return date.toISOString().replace("T", " ").replace(/\..+/, "");
}

// ── Service Factory ───────────────────────────────────────────────────────────

/**
 * Creates a BotVersionService instance.
 *
 * @param {object} options
 * @param {import('better-sqlite3').Database} options.db
 * @param {import('../artifacts/artifact-store.d.mts').ArtifactStore} options.artifactStore
 * @param {import('../execution/build-service.d.mts').BuildService} [options.buildService]
 * @param {import('../execution/profile-registry.d.mts').ProfileRegistry} [options.profileRegistry]
 * @param {number} [options.maxSourceBytes=524288] - Default 512 KiB limit for uploaded source
 */
export function createBotVersionService(options) {
  if (!options || !options.db) {
    throw new Error("createBotVersionService requires a database instance");
  }
  if (!options.artifactStore) {
    throw new Error("createBotVersionService requires an artifactStore instance");
  }

  const {
    db,
    artifactStore,
    buildService = null,
    profileRegistry = null,
    maxSourceBytes = 524288 // 512 KiB
  } = options;

  // ── Prepared SQL Statements ─────────────────────────────────────────────────

  const stmts = {
    selectUser: db.prepare("SELECT * FROM users WHERE id = ?"),
    selectBot: db.prepare("SELECT * FROM bots WHERE id = ?"),

    selectBotVersion: db.prepare("SELECT * FROM bot_versions WHERE id = ?"),
    allocateVersionNo: db.prepare(`
      SELECT COALESCE(MAX(version_no), 0) + 1 AS next_no
      FROM bot_versions WHERE bot_id = ?
    `),
    insertBotVersion: db.prepare(`
      INSERT INTO bot_versions (id, bot_id, version_no, source_digest, profile_id, profile_revision, build_status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `),
    updateBotVersionBuilding: db.prepare(`
      UPDATE bot_versions SET build_status = 'building' WHERE id = ?
    `),
    updateBotVersionReady: db.prepare(`
      UPDATE bot_versions SET build_status = 'ready', artifact_digest = ?, build_log = ? WHERE id = ?
    `),
    updateBotVersionFailed: db.prepare(`
      UPDATE bot_versions SET build_status = 'failed', build_log = ? WHERE id = ?
    `),

    insertJob: db.prepare(`
      INSERT INTO jobs (id, kind, target_id, status, attempt_no, max_attempts)
      VALUES (?, 'build', ?, 'queued', 0, ?)
    `),
    selectJob: db.prepare("SELECT * FROM jobs WHERE id = ?"),
    selectJobByTargetAndKind: db.prepare("SELECT * FROM jobs WHERE target_id = ? AND kind = ?"),
    updateJobClaimed: db.prepare(`
      UPDATE jobs
      SET status = 'claimed',
          attempt_no = ?,
          lease_owner = ?,
          lease_token = ?,
          lease_until = ?,
          heartbeat_at = datetime('now')
      WHERE id = ?
    `),
    fencedUpdateJob: db.prepare(`
      UPDATE jobs
      SET status = ?,
          heartbeat_at = datetime('now')
      WHERE id = ?
        AND kind = 'build'
        AND status = 'claimed'
        AND attempt_no = ?
        AND lease_token = ?
        AND (lease_until IS NULL OR datetime('now') <= lease_until)
    `),

    insertJobAttempt: db.prepare(`
      INSERT INTO job_attempts (job_id, attempt_no, lease_token, status, started_at)
      VALUES (?, ?, ?, 'active', datetime('now'))
    `),
    updateJobAttempt: db.prepare(`
      UPDATE job_attempts
      SET status = ?, finished_at = datetime('now'), diagnostic = ?
      WHERE job_id = ? AND attempt_no = ?
    `),
    fenceJobAttempt: db.prepare(`
      UPDATE job_attempts
      SET status = 'fenced', finished_at = datetime('now')
      WHERE job_id = ? AND attempt_no = ? AND status = 'active'
    `),
    listJobAttempts: db.prepare(`
      SELECT * FROM job_attempts WHERE job_id = ? ORDER BY attempt_no ASC
    `),

    insertArtifact: db.prepare(`
      INSERT OR IGNORE INTO artifacts (digest, kind, relative_private_path, bytes)
      VALUES (?, ?, ?, ?)
    `),
    selectArtifact: db.prepare("SELECT * FROM artifacts WHERE digest = ?"),

    selectApiRequest: db.prepare(
      "SELECT * FROM api_requests WHERE actor_id = ? AND operation = ? AND idempotency_key = ?"
    ),
    insertApiRequest: db.prepare(`
      INSERT INTO api_requests (actor_id, operation, idempotency_key, payload_digest, target_id, response_status)
      VALUES (?, ?, ?, ?, ?, 200)
    `)
  };

  // ── 1. Upload Bot Version & Queue Build Job (Atomic Use Case) ───────────────

  /**
   * Uploads a bot version, stores source in content-addressed ArtifactStore,
   * validates execution profile availability, enforces DB ownership, and atomically
   * inserts the version, a queued build job, and the idempotency request record.
   *
   * @param {object} input
   * @param {string} input.botId
   * @param {string|Buffer|Uint8Array} input.sourceContent
   * @param {string} input.profileId
   * @param {string} [input.profileRevision]
   * @param {string} [input.versionId]
   * @param {string} [input.jobId]
   * @param {string} [input.filename] - Sanitized client metadata only, never used as file path
   * @param {object} options
   * @param {string} options.actorId
   * @param {string} options.idempotencyKey
   */
  async function uploadBotVersion(input, options = {}) {
    const { actorId, idempotencyKey } = options;
    if (!actorId || typeof actorId !== "string") {
      throw new TypeError("options.actorId is required");
    }
    if (!idempotencyKey || typeof idempotencyKey !== "string") {
      throw new TypeError("options.idempotencyKey is required");
    }

    if (!input || typeof input !== "object") {
      throw new TypeError("input must be an object");
    }
    const { botId, sourceContent, profileId } = input;
    if (!botId || typeof botId !== "string") {
      throw new TypeError("input.botId is required");
    }
    if (!profileId || typeof profileId !== "string") {
      throw new TypeError("input.profileId is required");
    }

    // 1. Enforce bounded UTF-8 source limit
    const sourceBuf = toBuffer(sourceContent);
    if (sourceBuf.length > maxSourceBytes) {
      throw new PayloadTooLargeError(
        `Source content (${sourceBuf.length} bytes) exceeds maximum limit of ${maxSourceBytes} bytes`,
        sourceBuf.length,
        maxSourceBytes
      );
    }

    // 2. Validate profile in ProfileRegistry if configured
    let resolvedRevision = input.profileRevision;
    if (profileRegistry) {
      const profile = profileRegistry.getProfile(profileId);
      if (!profile) {
        throw new ProfileUnavailableError(`Unknown execution profile: "${profileId}"`, profileId);
      }
      const probeRes = profileRegistry.probeProfile(profileId);
      if (probeRes && !probeRes.available) {
        throw new ProfileUnavailableError(
          `Execution profile "${profileId}" is unavailable on host: ${probeRes.error || "not found"}`,
          profileId
        );
      }
      resolvedRevision = resolvedRevision || profile.revision || "v1";
    } else {
      resolvedRevision = resolvedRevision || "v1";
    }

    // 3. Store source content in ArtifactStore by SHA-256 digest
    // Path is generated by ArtifactStore under sources/<prefix>/<rest>; client filename is never in path!
    const storedSource = await artifactStore.storeArtifact("source", sourceBuf);
    const sourceDigest = storedSource.digest;

    // 4. Compute canonical payload digest for idempotency
    const payloadDigest = canonicalDigest({
      botId,
      sourceDigest,
      profileId,
      profileRevision: resolvedRevision,
      operation: "uploadBotVersion"
    });

    // 5. Atomic database transaction: Idempotency + Ownership + Sequential Version + Build Job
    return db.transaction(() => {
      // Idempotency check
      const existingReq = stmts.selectApiRequest.get(actorId, "uploadBotVersion", idempotencyKey);
      if (existingReq) {
        if (existingReq.payload_digest !== payloadDigest) {
          throw new IdempotencyConflictError(idempotencyKey, "uploadBotVersion");
        }
        const existingVer = stmts.selectBotVersion.get(existingReq.target_id);
        const existingJob = stmts.selectJobByTargetAndKind.get(existingReq.target_id, "build");
        return {
          botVersion: existingVer,
          job: existingJob,
          isReplay: true
        };
      }

      // Authoritative DB Identity & Ownership Check (Client role claims are ignored)
      const actor = stmts.selectUser.get(actorId);
      if (!actor) throw new NotFoundError("user", actorId);

      const bot = stmts.selectBot.get(botId);
      if (!bot) throw new NotFoundError("bot", botId);

      if (bot.owner_id !== actorId && actor.role !== "admin") {
        throw new OwnershipError("bot", botId, actorId);
      }

      // Allocate sequential version_no atomically
      const { next_no } = stmts.allocateVersionNo.get(botId);
      const versionId = input.versionId || `ver-${randomUUID()}`;
      const jobId = input.jobId || `job-${randomUUID()}`;

      // Insert bot version (immutable source & profile)
      stmts.insertBotVersion.run(
        versionId,
        botId,
        next_no,
        sourceDigest,
        profileId,
        resolvedRevision
      );

      // Insert build job atomically (kind: 'build', status: 'queued')
      stmts.insertJob.run(jobId, versionId, 3);

      // Register source artifact in artifacts table
      stmts.insertArtifact.run(sourceDigest, "source", storedSource.path, storedSource.bytes);

      // Insert idempotency record
      stmts.insertApiRequest.run(actorId, "uploadBotVersion", idempotencyKey, payloadDigest, versionId);

      return {
        botVersion: stmts.selectBotVersion.get(versionId),
        job: stmts.selectJob.get(jobId),
        isReplay: false
      };
    }).immediate();
  }

  // ── 2. Build Job Lease Claiming ─────────────────────────────────────────────

  /**
   * Claims a build job with an unexpired lease and attempt token.
   *
   * @param {object} params
   * @param {string} params.jobId
   * @param {string} [params.leaseOwner='worker']
   * @param {number} [params.leaseDurationMs=30000]
   */
  function claimBuildJob(params) {
    const { jobId, leaseOwner = "worker", leaseDurationMs = 30000 } = params;
    if (!jobId) throw new TypeError("jobId is required");

    return db.transaction(() => {
      const job = stmts.selectJob.get(jobId);
      if (!job) throw new NotFoundError("job", jobId);
      if (job.kind !== "build") throw new Error(`Job ${jobId} is not a build job`);

      if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
        throw new Error(`Job ${jobId} is already in terminal state: ${job.status}`);
      }

      // If claimed, check if existing lease is still active
      if (job.status === "claimed" && job.lease_until) {
        const checkActive = db.prepare("SELECT datetime('now') <= ? AS is_active").get(job.lease_until);
        if (checkActive && checkActive.is_active === 1) {
          throw new Error(`Job ${jobId} is currently leased by ${job.lease_owner} until ${job.lease_until}`);
        }
      }

      const nextAttempt = job.attempt_no + 1;
      if (nextAttempt > job.max_attempts) {
        stmts.fencedUpdateJob.run("failed", jobId, job.attempt_no, job.lease_token);
        throw new Error(`Job ${jobId} exceeded maximum attempts (${job.max_attempts})`);
      }

      const leaseToken = randomUUID();
      const leaseUntil = formatSqliteDate(new Date(Date.now() + leaseDurationMs));

      stmts.updateJobClaimed.run(nextAttempt, leaseOwner, leaseToken, leaseUntil, jobId);
      stmts.insertJobAttempt.run(jobId, nextAttempt, leaseToken);
      stmts.updateBotVersionBuilding.run(job.target_id);

      return {
        jobId,
        attemptNo: nextAttempt,
        leaseToken,
        leaseUntil,
        targetId: job.target_id
      };
    }).immediate();
  }

  // ── 3. Fenced Build Completion ──────────────────────────────────────────────

  /**
   * Completes a build job under an atomic fence.
   * Stale lease tokens, overtaken attempts, or expired leases will fail the fence
   * and refuse to mark the bot version 'ready'.
   *
   * @param {object} params
   * @param {string} params.jobId
   * @param {number} params.attemptNo
   * @param {string} params.leaseToken
   * @param {boolean} params.success
   * @param {string} [params.artifactDigest] - Required when success is true
   * @param {string} [params.buildLog='']
   * @param {string} [params.diagnostic=null]
   */
  async function completeBuildJob(params) {
    const {
      jobId,
      attemptNo,
      leaseToken,
      success,
      artifactDigest = null,
      buildLog = null,
      diagnostic = null
    } = params;

    if (!jobId) throw new TypeError("jobId is required");
    if (!attemptNo) throw new TypeError("attemptNo is required");
    if (!leaseToken) throw new TypeError("leaseToken is required");

    let storedBuild = null;
    if (success) {
      if (!artifactDigest || typeof artifactDigest !== "string") {
        throw new Error("Successful build completion requires an artifactDigest");
      }

      // Pre-condition: artifact must be published and resolvable in ArtifactStore BEFORE marking ready in DB
      storedBuild = await artifactStore.resolveArtifact(artifactDigest);
      if (!storedBuild) {
        const err = new Error(`Build artifact ${artifactDigest} not found in ArtifactStore before marking READY`);
        err.kind = "infrastructure_error";
        throw err;
      }
    }

    return db.transaction(() => {
      const nextStatus = success ? "completed" : "failed";

      // Atomic fence update: requires matching attempt_no, lease_token, AND unexpired lease
      const updateRes = stmts.fencedUpdateJob.run(nextStatus, jobId, attemptNo, leaseToken);

      if (updateRes.changes === 0) {
        // Fence tripped! Lease is stale, expired, or overtaken.
        // Mark attempt fenced in job_attempts to record the anomaly.
        stmts.fenceJobAttempt.run(jobId, attemptNo);
        throw new StaleLeaseError(
          `Build job lease is stale, expired, or overtaken; completion rejected (jobId: "${jobId}", attempt: ${attemptNo})`,
          { jobId, attemptNo, leaseToken }
        );
      }

      const job = stmts.selectJob.get(jobId);

      if (success) {
        stmts.updateJobAttempt.run("completed", diagnostic, jobId, attemptNo);
        // Register compiled build artifact in artifacts table
        stmts.insertArtifact.run(artifactDigest, "build", storedBuild.path, storedBuild.bytes);
        // Mark bot version ready
        stmts.updateBotVersionReady.run(artifactDigest, buildLog, job.target_id);
      } else {
        stmts.updateJobAttempt.run("failed", diagnostic, jobId, attemptNo);
        // Mark bot version failed
        stmts.updateBotVersionFailed.run(buildLog, job.target_id);
      }

      return {
        job: stmts.selectJob.get(jobId),
        botVersion: stmts.selectBotVersion.get(job.target_id)
      };
    }).immediate();
  }

  // ── 4. Integrated Build Processing ──────────────────────────────────────────

  /**
   * Convenience workflow integrating BuildService:
   * claims lease, reads source from ArtifactStore, compiles via BuildService,
   * publishes artifact, and applies fenced completion.
   */
  async function processBuildJob(params) {
    if (!buildService) {
      throw new Error("processBuildJob requires buildService in options");
    }
    const { jobId, leaseOwner = "worker", leaseDurationMs = 30000, claimedLease = null } = params;

    let lease;
    if (claimedLease) {
      if (
        claimedLease.jobId !== jobId ||
        (claimedLease.kind && claimedLease.kind !== "build") ||
        !claimedLease.leaseOwner ||
        claimedLease.leaseOwner !== leaseOwner ||
        typeof claimedLease.attemptNo !== "number" ||
        !claimedLease.leaseToken
      ) {
        throw new StaleLeaseError(`Build job lease does not match the requested job or worker`, {
          jobId,
          attemptNo: claimedLease.attemptNo,
          leaseToken: claimedLease.leaseToken
        });
      }

      const current = stmts.selectJob.get(jobId);
      const leaseActive = current && current.status === "claimed" && current.lease_owner === leaseOwner &&
        current.attempt_no === claimedLease.attemptNo && current.lease_token === claimedLease.leaseToken &&
        current.lease_until && db.prepare("SELECT datetime('now') <= ? AS is_active").get(current.lease_until)?.is_active === 1;
      if (!leaseActive) {
        throw new StaleLeaseError(`Build job lease is stale, expired, or overtaken`, {
          jobId,
          attemptNo: claimedLease.attemptNo,
          leaseToken: claimedLease.leaseToken
        });
      }

      lease = {
        jobId,
        attemptNo: current.attempt_no,
        leaseToken: current.lease_token,
        leaseUntil: current.lease_until,
        targetId: current.target_id
      };
    } else {
      lease = claimBuildJob({ jobId, leaseOwner, leaseDurationMs });
    }
    const botVer = stmts.selectBotVersion.get(lease.targetId);
    if (!botVer) throw new NotFoundError("bot_version", lease.targetId);

    const sourceArtifact = await artifactStore.resolveArtifact(botVer.source_digest);
    if (!sourceArtifact) {
      const err = new Error(`Source artifact ${botVer.source_digest} missing from store`);
      err.kind = "infrastructure_error";
      throw err;
    }

    const sourceContent = fs.readFileSync(sourceArtifact.path);

    const buildResult = await buildService.build({
      sourceContent,
      profileId: botVer.profile_id,
      profileRevision: botVer.profile_revision
    });

    const isSuccess = buildResult.status === "READY";
    const completion = await completeBuildJob({
      jobId,
      attemptNo: lease.attemptNo,
      leaseToken: lease.leaseToken,
      success: isSuccess,
      artifactDigest: buildResult.artifactDigest,
      buildLog: buildResult.logs,
      diagnostic: buildResult.error || null
    });

    return {
      lease,
      buildResult,
      botVersion: completion.botVersion,
      job: completion.job
    };
  }

  // ── 5. Artifact Verification & Tamper Quarantine ────────────────────────────

  /**
   * Verifies that the bot version's build artifact exists and has not been tampered with.
   * If tampered, throws an INFRASTRUCTURE error (quarantine), NOT a bot loss/forfeit.
   */
  async function verifyBotVersionArtifact(botVersionId) {
    const ver = stmts.selectBotVersion.get(botVersionId);
    if (!ver) throw new NotFoundError("bot_version", botVersionId);

    if (ver.build_status !== "ready") {
      throw new BotVersionNotReadyError(
        `Bot version ${botVersionId} is not ready (status: ${ver.build_status})`,
        ver.build_status
      );
    }

    if (!ver.artifact_digest) {
      throw new Error(`Bot version ${botVersionId} has no artifact_digest recorded`);
    }

    // ArtifactStore.resolveArtifact will verify SHA-256 digest on disk.
    // If mismatch, it throws infrastructure_error with tamper_detected.
    const artifact = await artifactStore.resolveArtifact(ver.artifact_digest);
    if (!artifact) {
      const err = new Error(`Artifact ${ver.artifact_digest} for bot version ${botVersionId} not found on disk`);
      err.kind = "infrastructure_error";
      err.code = "missing_artifact";
      throw err;
    }

    return { botVersion: ver, artifact };
  }

  // ── 6. Match Scheduling Guards ──────────────────────────────────────────────

  /**
   * Validates that a bot version is eligible for match scheduling:
   * must be READY, execution profile must be currently available on host,
   * and artifact must pass integrity verification.
   */
  async function validateBotVersionForMatch(botVersionId) {
    const ver = stmts.selectBotVersion.get(botVersionId);
    if (!ver) throw new NotFoundError("bot_version", botVersionId);

    if (ver.build_status !== "ready") {
      throw new BotVersionNotReadyError(
        `Bot version ${botVersionId} cannot be scheduled: status is ${ver.build_status}`,
        ver.build_status
      );
    }

    if (profileRegistry) {
      const probeRes = profileRegistry.probeProfile(ver.profile_id);
      if (probeRes && !probeRes.available) {
        throw new ProfileUnavailableError(
          `Execution profile "${ver.profile_id}" is unavailable for bot version ${botVersionId}`,
          ver.profile_id
        );
      }
    }

    await verifyBotVersionArtifact(botVersionId);
    return true;
  }

  // ── 7. Read Methods ─────────────────────────────────────────────────────────

  function getBotVersion(botVersionId) {
    return stmts.selectBotVersion.get(botVersionId) ?? undefined;
  }

  function getBuildJob(jobId) {
    return stmts.selectJob.get(jobId) ?? undefined;
  }

  function getBuildJobForVersion(botVersionId) {
    return stmts.selectJobByTargetAndKind.get(botVersionId, "build") ?? undefined;
  }

  function listJobAttempts(jobId) {
    return stmts.listJobAttempts.all(jobId);
  }

  return {
    uploadBotVersion,
    claimBuildJob,
    completeBuildJob,
    processBuildJob,
    verifyBotVersionArtifact,
    validateBotVersionForMatch,
    getBotVersion,
    getBuildJob,
    getBuildJobForVersion,
    listJobAttempts
  };
}
