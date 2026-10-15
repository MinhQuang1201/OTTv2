/**
 * packages/arena-node/src/persistence/live-frame-store.mjs
 *
 * Incremental live frames persistence and cursor projection for Arena AI matches.
 *
 * Architecture & Guarantees:
 * - Fail-closed schema requirement: Throws MIGRATION_REQUIRED if match_live_frames table
 *   is absent; NEVER mutates existing database schema inside store constructor.
 * - Fenced transactional writes: recordFrame verifies match is active (rejects writes post-finalization
 *   or to completed/cancelled matches) and enforces job lease/attempt authority.
 * - Stale attempt cleanup: Deletes past attempt rows when a newer valid attempt writes.
 * - Storage retention bound: Enforces per-match bounded row count (keeping initial ply 0 frame + latest plies).
 * - Non-skipping cursor projection: Returns lastReturnedPly cursor so clients paginate without skipping gaps.
 */

import { withTransaction } from "./sqlite-database.mjs";

export const DEFAULT_MAX_RETAINED_FRAMES_PER_MATCH = 100;

export class FencedLiveFrameError extends Error {
  constructor(message, code = "FENCED_LIVE_FRAME") {
    super(message);
    this.name = "FencedLiveFrameError";
    this.code = code;
  }
}

/**
 * Creates an incremental LiveFrameStore bound to SQLite database.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [options]
 * @param {number} [options.maxRetainedFramesPerMatch=100]
 * @returns {import('./live-frame-store.d.mts').LiveFrameStore}
 */
export function createLiveFrameStore(db, options = {}) {
  if (!db) {
    throw new TypeError("createLiveFrameStore requires a database instance");
  }

  const maxRetainedFramesPerMatch =
    Number.isInteger(options.maxRetainedFramesPerMatch) && options.maxRetainedFramesPerMatch > 1
      ? options.maxRetainedFramesPerMatch
      : DEFAULT_MAX_RETAINED_FRAMES_PER_MATCH;

  // Startup migration integration: fail-closed if 004 table not yet migrated
  const hasTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'match_live_frames'")
    .get();
  if (!hasTable) {
    const err = new Error(
      "Table 'match_live_frames' does not exist. Apply schema migration '004-arena-live-frames' during application startup."
    );
    err.code = "MIGRATION_REQUIRED";
    throw err;
  }

  const selectMatchStmt = db.prepare(`
    SELECT id, status FROM matches WHERE id = ?
  `);

  const selectActiveJobStmt = db.prepare(`
    SELECT id, status, attempt_no, lease_token, lease_until,
           (lease_until IS NOT NULL AND datetime('now') > lease_until) AS is_expired
    FROM jobs
    WHERE kind = 'match' AND target_id = ?
  `);

  const deleteOldAttemptsStmt = db.prepare(`
    DELETE FROM match_live_frames WHERE match_id = ? AND attempt_no < ?
  `);

  const recordFrameStmt = db.prepare(`
    INSERT OR REPLACE INTO match_live_frames (
      match_id,
      attempt_no,
      ply,
      seat,
      move_json,
      frame_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const countFramesStmt = db.prepare(`
    SELECT COUNT(*) AS count FROM match_live_frames WHERE match_id = ? AND attempt_no = ?
  `);

  const pruneExcessFramesStmt = db.prepare(`
    DELETE FROM match_live_frames
    WHERE match_id = ?
      AND attempt_no = ?
      AND ply > 0
      AND ply NOT IN (
        SELECT ply FROM match_live_frames
        WHERE match_id = ? AND attempt_no = ? AND ply > 0
        ORDER BY ply DESC
        LIMIT ?
      )
  `);

  const selectMaxAttemptStmt = db.prepare(`
    SELECT MAX(attempt_no) AS max_attempt FROM match_live_frames WHERE match_id = ?
  `);

  const selectMaxPlyStmt = db.prepare(`
    SELECT MAX(ply) AS max_ply FROM match_live_frames WHERE match_id = ? AND attempt_no = ?
  `);

  const selectFramesStmt = db.prepare(`
    SELECT ply, seat, move_json, frame_json, created_at
    FROM match_live_frames
    WHERE match_id = ? AND attempt_no = ? AND ply > ?
    ORDER BY ply ASC
    LIMIT ?
  `);

  const deleteLiveFramesStmt = db.prepare(`
    DELETE FROM match_live_frames WHERE match_id = ?
  `);

  return {
    recordFrame({ matchId, attemptNo, leaseToken = null, ply, seat = null, move = null, frame }) {
      if (!matchId || typeof matchId !== "string") {
        throw new TypeError("matchId must be a non-empty string");
      }
      if (!Number.isInteger(attemptNo) || attemptNo < 1) {
        throw new TypeError("attemptNo must be an integer >= 1");
      }
      if (!Number.isInteger(ply) || ply < 0) {
        throw new TypeError("ply must be an integer >= 0");
      }
      if (!frame || typeof frame !== "object") {
        throw new TypeError("frame must be a non-null object");
      }

      withTransaction(db, () => {
        // 1. Terminal match fencing: reject writes to completed/cancelled matches
        const match = selectMatchStmt.get(matchId);
        if (!match) {
          throw new FencedLiveFrameError(`Match '${matchId}' not found`, "MATCH_NOT_FOUND");
        }
        if (match.status !== "active" && match.status !== "running") {
          throw new FencedLiveFrameError(
            `Cannot record live frame: match '${matchId}' is terminal (${match.status})`,
            "MATCH_TERMINAL"
          );
        }

        // 2. Queue lease & attempt fencing (authoritative check)
        const hasJobsTable = Boolean(
          db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get()
        );
        if (hasJobsTable) {
          const job = selectActiveJobStmt.get(matchId);
          if (job) {
            if (job.status !== "claimed") {
              throw new FencedLiveFrameError(
                `Cannot record live frame: job status is '${job.status}', expected 'claimed'`,
                "JOB_NOT_CLAIMED"
              );
            }
            if (job.attempt_no !== attemptNo) {
              throw new FencedLiveFrameError(
                `Cannot record live frame: authoritative attempt is ${job.attempt_no}, rejected write for attempt ${attemptNo}`,
                "ATTEMPT_MISMATCH"
              );
            }
            if (typeof leaseToken !== "string" || leaseToken.length === 0 || job.lease_token !== leaseToken) {
              throw new FencedLiveFrameError(
                `Cannot record live frame: lease token mismatch (fenced by newer claim)`,
                "LEASE_TOKEN_MISMATCH"
              );
            }
            if (job.is_expired) {
              throw new FencedLiveFrameError(
                `Cannot record live frame: worker lease has expired`,
                "LEASE_EXPIRED"
              );
            }
          }
        }

        // 3. Delete old attempts on new valid attempt
        deleteOldAttemptsStmt.run(matchId, attemptNo);

        // 4. Record current frame
        recordFrameStmt.run(
          matchId,
          attemptNo,
          ply,
          seat || null,
          move ? JSON.stringify(move) : null,
          JSON.stringify(frame)
        );

        // 5. Enforce per-match storage retention bound
        const countRow = countFramesStmt.get(matchId, attemptNo);
        if (countRow && countRow.count > maxRetainedFramesPerMatch) {
          // Keep ply 0 (initial state) + latest (maxRetainedFramesPerMatch - 1) plies
          pruneExcessFramesStmt.run(
            matchId,
            attemptNo,
            matchId,
            attemptNo,
            maxRetainedFramesPerMatch - 1
          );
        }
      });
    },

    getLiveFrames({ matchId, afterPly = -1, attemptNo = null, limit = 100 }) {
      if (!matchId || typeof matchId !== "string") {
        throw new TypeError("matchId must be a non-empty string");
      }

      const match = selectMatchStmt.get(matchId);
      if (!match) {
        return null;
      }

      if (match.status === "completed") {
        return {
          matchId,
          status: "completed",
          terminal: true,
          replayUrl: `/api/arena/v1/matches/${matchId}/replay`,
          frames: [],
          attemptNo: 0,
          afterPly,
          lastReturnedPly: afterPly,
          currentPly: 0,
          reset: false
        };
      }

      if (match.status === "cancelled") {
        return {
          matchId,
          status: "cancelled",
          terminal: true,
          replayUrl: null,
          frames: [],
          attemptNo: 0,
          afterPly,
          lastReturnedPly: afterPly,
          currentPly: 0,
          reset: false
        };
      }

      // Determine authoritative attempt
      let latestAttemptNo = 1;
      const hasJobsTable = Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get()
      );
      if (hasJobsTable) {
        const job = db
          .prepare("SELECT attempt_no FROM jobs WHERE kind = 'match' AND target_id = ?")
          .get(matchId);
        if (job && typeof job.attempt_no === "number" && job.attempt_no > 0) {
          latestAttemptNo = job.attempt_no;
        } else {
          const maxAttemptRow = selectMaxAttemptStmt.get(matchId);
          if (maxAttemptRow?.max_attempt) latestAttemptNo = maxAttemptRow.max_attempt;
        }
      } else {
        const maxAttemptRow = selectMaxAttemptStmt.get(matchId);
        if (maxAttemptRow?.max_attempt) latestAttemptNo = maxAttemptRow.max_attempt;
      }

      // Detect attempt reset
      const reset =
        attemptNo !== null &&
        attemptNo !== undefined &&
        attemptNo < latestAttemptNo;

      const effectiveAfterPly = reset
        ? -1
        : typeof afterPly === "number"
          ? afterPly
          : -1;

      const boundedLimit = Math.max(1, Math.min(250, Number.isInteger(limit) ? limit : 100));

      const rows = selectFramesStmt.all(
        matchId,
        latestAttemptNo,
        effectiveAfterPly,
        boundedLimit
      );

      const frames = rows.map((r) => {
        try {
          const parsed = JSON.parse(r.frame_json);
          if (typeof parsed === "object" && parsed !== null) {
            if (parsed.ply === undefined) parsed.ply = r.ply;
          }
          return parsed;
        } catch {
          return { ply: r.ply, seat: r.seat };
        }
      });

      const maxPlyRow = selectMaxPlyStmt.get(matchId, latestAttemptNo);
      const currentPly =
        maxPlyRow?.max_ply !== null && maxPlyRow?.max_ply !== undefined
          ? maxPlyRow.max_ply
          : -1;

      // lastReturnedPly cursor ensures clients advance incrementally without skipping gaps
      const lastReturnedPly =
        frames.length > 0
          ? rows[rows.length - 1].ply
          : effectiveAfterPly;

      return {
        matchId,
        status: match.status === "active" ? "running" : match.status,
        terminal: false,
        attemptNo: latestAttemptNo,
        afterPly,
        lastReturnedPly,
        currentPly,
        reset,
        frames
      };
    },

    pruneLiveFrames(matchId) {
      if (!matchId || typeof matchId !== "string") {
        throw new TypeError("matchId must be a non-empty string");
      }
      deleteLiveFramesStmt.run(matchId);
    }
  };
}
