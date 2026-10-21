/**
 * packages/arena-node/src/persistence/job-queue.mjs
 *
 * Durable SQLite-backed job queue for OTTv2 Arena (Milestone M3).
 *
 * Implements:
 * - FIFO eligible claim under BEGIN IMMEDIATE transaction
 * - Concurrency limit: 1 active job per worker
 * - Lease duration (default 30s), heartbeat interval (default 5s), max attempts (default 3)
 * - Monotonic attempt_no increment, random unique lease_token
 * - Heartbeat/renewal verifying matching lease_token, attempt_no, and unexpired lease
 * - Graceful job release: returns job to 'queued', match to 'pending', marks attempt 'fenced'
 * - Recovery of expired jobs: marks attempt 'fenced', re-enqueues same job identity from scratch,
 *   or marks 'failed' and match 'error' when max_attempts reached
 */

import { randomUUID } from "node:crypto";
import { withTransaction } from "./sqlite-database.mjs";

/**
 * Creates a JobQueue instance bound to an open SQLite database.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [options]
 * @param {number} [options.defaultLeaseDurationMs=30000]
 * @param {number} [options.defaultHeartbeatIntervalMs=5000]
 * @param {number} [options.defaultMaxAttempts=3]
 */
export function createJobQueue(db, options = {}) {
  if (!db) {
    throw new TypeError("createJobQueue requires a database instance");
  }

  const defaultLeaseDurationMs = options.defaultLeaseDurationMs ?? 30000;
  const defaultHeartbeatIntervalMs = options.defaultHeartbeatIntervalMs ?? 5000;
  const defaultMaxAttempts = options.defaultMaxAttempts ?? 3;

  // Prepared SQL statements
  const stmts = {
    insertJob: db.prepare(`
      INSERT INTO jobs (id, kind, target_id, status, attempt_no, max_attempts)
      VALUES (?, ?, ?, 'queued', 0, ?)
    `),
    selectJobById: db.prepare("SELECT * FROM jobs WHERE id = ?"),
    selectJobByTarget: db.prepare("SELECT * FROM jobs WHERE kind = ? AND target_id = ?"),
    selectActiveClaimByOwner: db.prepare(`
      SELECT * FROM jobs
      WHERE lease_owner = ?
        AND status = 'claimed'
        AND (lease_until IS NULL OR datetime('now') <= lease_until)
      LIMIT 1
    `),
    selectOldestQueuedJob: db.prepare(`
      SELECT * FROM jobs
      WHERE status = 'queued'
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `),
    updateClaimJob: db.prepare(`
      UPDATE jobs
      SET status = 'claimed',
          attempt_no = ?,
          lease_owner = ?,
          lease_token = ?,
          lease_until = datetime('now', ?),
          heartbeat_at = datetime('now')
      WHERE id = ?
    `),
    insertJobAttempt: db.prepare(`
      INSERT INTO job_attempts (job_id, attempt_no, lease_token, status, started_at)
      VALUES (?, ?, ?, 'active', datetime('now'))
    `),
    updateMatchActive: db.prepare(`
      UPDATE matches SET status = 'active' WHERE id = ? AND status = 'pending'
    `),
    updateBotVersionBuilding: db.prepare(`
      UPDATE bot_versions SET build_status = 'building' WHERE id = ? AND build_status = 'pending'
    `),
    heartbeatJob: db.prepare(`
      UPDATE jobs
      SET heartbeat_at = datetime('now'),
          lease_until = datetime('now', ?)
      WHERE id = ?
        AND lease_token = ?
        AND attempt_no = ?
        AND status = 'claimed'
        AND (lease_until IS NULL OR datetime('now') <= lease_until)
    `),
    selectJobAttempts: db.prepare(`
      SELECT * FROM job_attempts WHERE job_id = ? ORDER BY attempt_no ASC
    `),
    fenceJobAttempt: db.prepare(`
      UPDATE job_attempts
      SET status = 'fenced',
          finished_at = datetime('now'),
          diagnostic = ?
      WHERE job_id = ? AND attempt_no = ? AND status = 'active'
    `),
    resetJobToQueued: db.prepare(`
      UPDATE jobs
      SET status = 'queued',
          lease_owner = NULL,
          lease_token = NULL,
          lease_until = NULL,
          heartbeat_at = NULL
      WHERE id = ?
    `),
    updateJobFailed: db.prepare(`
      UPDATE jobs
      SET status = 'failed',
          lease_owner = NULL,
          lease_token = NULL,
          lease_until = NULL
      WHERE id = ?
    `),
    resetMatchPending: db.prepare(`
      UPDATE matches SET status = 'pending' WHERE id = ? AND status = 'active'
    `),
    resetBotVersionPending: db.prepare(`
      UPDATE bot_versions SET build_status = 'pending' WHERE id = ? AND build_status = 'building'
    `),
    setMatchError: db.prepare(`
      UPDATE matches SET status = 'error' WHERE id = ?
    `),
    setBotVersionFailed: db.prepare(`
      UPDATE bot_versions SET build_status = 'failed' WHERE id = ?
    `),
    selectExpiredClaimedJobs: db.prepare(`
      SELECT * FROM jobs
      WHERE status = 'claimed'
        AND lease_until IS NOT NULL
        AND datetime('now') > lease_until
    `)
  };

  /**
   * Enqueues a new job or returns existing job for (kind, target_id).
   */
  function enqueueJob(params) {
    if (!params || !params.kind || !params.targetId) {
      throw new TypeError("enqueueJob requires kind and targetId");
    }

    const { kind, targetId, maxAttempts = defaultMaxAttempts, id = null } = params;
    const jobId = id || `job-${kind}-${targetId}`;

    return withTransaction(db, () => {
      const existing = stmts.selectJobByTarget.get(kind, targetId);
      if (existing) {
        return existing;
      }

      stmts.insertJob.run(jobId, kind, targetId, maxAttempts);
      return stmts.selectJobById.get(jobId);
    });
  }

  /**
   * Atomically claims the next eligible FIFO job under BEGIN IMMEDIATE.
   * Enforces concurrency limit: returns null if the worker currently holds an active lease.
   */
  function claimNextJob(params = {}) {
    const {
      workerId = "default-worker",
      leaseDurationMs = defaultLeaseDurationMs,
      allowedKinds = null
    } = params;

    return withTransaction(db, () => {
      // 1. Concurrency limit 1 per worker
      const activeClaim = stmts.selectActiveClaimByOwner.get(workerId);
      if (activeClaim) {
        return null;
      }

      // 2. Select oldest queued job (FIFO)
      let job;
      if (Array.isArray(allowedKinds) && allowedKinds.length > 0) {
        const placeholders = allowedKinds.map(() => "?").join(",");
        job = db.prepare(`
          SELECT * FROM jobs
          WHERE status = 'queued' AND kind IN (${placeholders})
          ORDER BY created_at ASC, id ASC
          LIMIT 1
        `).get(...allowedKinds);
      } else {
        job = stmts.selectOldestQueuedJob.get();
      }

      if (!job) {
        return null;
      }

      const nextAttempt = job.attempt_no + 1;
      if (nextAttempt > job.max_attempts) {
        stmts.updateJobFailed.run(job.id);
        if (job.kind === "match") {
          stmts.setMatchError.run(job.target_id);
        } else if (job.kind === "build") {
          stmts.setBotVersionFailed.run(job.target_id);
        }
        return null;
      }

      const leaseToken = randomUUID();
      const seconds = Math.max(1, Math.ceil(leaseDurationMs / 1000));
      const modifier = `+${seconds} seconds`;

      stmts.updateClaimJob.run(nextAttempt, workerId, leaseToken, modifier, job.id);
      stmts.insertJobAttempt.run(job.id, nextAttempt, leaseToken);

      if (job.kind === "match") {
        stmts.updateMatchActive.run(job.target_id);
      } else if (job.kind === "build") {
        stmts.updateBotVersionBuilding.run(job.target_id);
      }

      const updated = stmts.selectJobById.get(job.id);
      return {
        jobId: updated.id,
        kind: updated.kind,
        targetId: updated.target_id,
        attemptNo: updated.attempt_no,
        leaseToken: updated.lease_token,
        leaseOwner: updated.lease_owner,
        leaseUntil: updated.lease_until,
        heartbeatAt: updated.heartbeat_at,
        maxAttempts: updated.max_attempts
      };
    });
  }

  /**
   * Heartbeat to extend lease on active job.
   * Returns true on successful extension, false on mismatch or lease expiration.
   */
  function heartbeatJob(params = {}) {
    const {
      jobId,
      leaseToken,
      attemptNo,
      extendDurationMs = defaultLeaseDurationMs
    } = params;

    if (!jobId || !leaseToken || typeof attemptNo !== "number") {
      return false;
    }

    const seconds = Math.max(1, Math.ceil(extendDurationMs / 1000));
    const modifier = `+${seconds} seconds`;

    return withTransaction(db, () => {
      const res = stmts.heartbeatJob.run(modifier, jobId, leaseToken, attemptNo);
      return res.changes === 1;
    });
  }

  /**
   * Releases an active claim gracefully, re-enqueueing the job and marking the attempt fenced.
   */
  function releaseJob(params = {}) {
    const {
      jobId,
      leaseToken,
      attemptNo,
      reason = "graceful_stop"
    } = params;

    if (!jobId || !leaseToken || typeof attemptNo !== "number") {
      return false;
    }

    return withTransaction(db, () => {
      const job = stmts.selectJobById.get(jobId);
      if (
        !job ||
        job.status !== "claimed" ||
        job.lease_token !== leaseToken ||
        job.attempt_no !== attemptNo
      ) {
        return false;
      }

      stmts.fenceJobAttempt.run(reason, jobId, attemptNo);
      stmts.resetJobToQueued.run(jobId);

      if (job.kind === "match") {
        stmts.resetMatchPending.run(job.target_id);
      } else if (job.kind === "build") {
        stmts.resetBotVersionPending.run(job.target_id);
      }

      return true;
    });
  }

  /**
   * Recovers expired claimed jobs whose lease_until has lapsed.
   * Marks attempt fenced.
   * If attempts reach max_attempts: marks job failed and match error.
   * Otherwise: resets job to queued and match to pending for restart from scratch.
   */
  function recoverExpiredJobs() {
    return withTransaction(db, () => {
      const expiredJobs = stmts.selectExpiredClaimedJobs.all();
      const results = [];

      for (const job of expiredJobs) {
        stmts.fenceJobAttempt.run("lease_expired", job.id, job.attempt_no);

        if (job.attempt_no >= job.max_attempts) {
          stmts.updateJobFailed.run(job.id);
          if (job.kind === "match") {
            stmts.setMatchError.run(job.target_id);
          } else if (job.kind === "build") {
            stmts.setBotVersionFailed.run(job.target_id);
          }
          results.push({
            jobId: job.id,
            kind: job.kind,
            targetId: job.target_id,
            attemptNo: job.attempt_no,
            action: "failed"
          });
        } else {
          stmts.resetJobToQueued.run(job.id);
          if (job.kind === "match") {
            stmts.resetMatchPending.run(job.target_id);
          } else if (job.kind === "build") {
            stmts.resetBotVersionPending.run(job.target_id);
          }
          results.push({
            jobId: job.id,
            kind: job.kind,
            targetId: job.target_id,
            attemptNo: job.attempt_no,
            action: "requeued"
          });
        }
      }

      return results;
    });
  }

  function getJob(jobId) {
    return stmts.selectJobById.get(jobId) ?? null;
  }

  function getJobByTarget(kind, targetId) {
    return stmts.selectJobByTarget.get(kind, targetId) ?? null;
  }

  function getJobAttempts(jobId) {
    return stmts.selectJobAttempts.all(jobId);
  }

  return {
    enqueueJob,
    claimNextJob,
    heartbeatJob,
    releaseJob,
    recoverExpiredJobs,
    getJob,
    getJobByTarget,
    getJobAttempts
  };
}
