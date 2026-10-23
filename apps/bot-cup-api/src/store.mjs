/**
 * D1 access for the registration API. `db` is a D1Database (or the better-sqlite3 shim in tests).
 * Uniqueness is enforced by the schema; callers pre-check for friendly errors and map constraint failures as a backstop.
 */

const UNIQUE_ERRORS = [
  ["teams.event_id, teams.handle", "handle_taken"],
  ["teams.event_id, teams.display_key", "display_name_taken"],
  ["members.event_id, members.mssv", "mssv_taken"],
  ["members.event_id, members.email", "email_taken"],
  ["submissions.team_id, submissions.sha256", "submission_duplicate"]
];

/** @returns {string|null} the API error code for a UNIQUE constraint failure, or null for any other error. */
export function uniqueViolation(error) {
  const message = String(error?.message || error);
  if (!message.includes("UNIQUE constraint failed")) return null;
  return UNIQUE_ERRORS.find(([columns]) => message.includes(columns))?.[1] ?? "conflict";
}

function mapEvent(row) {
  if (!row) return null;
  let config = {};
  try {
    config = JSON.parse(row.config_json || "{}");
  } catch {
    config = {};
  }
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    phase: row.phase,
    registrationOpensAt: row.registration_opens_at,
    registrationClosesAt: row.registration_closes_at,
    practiceOpensAt: row.practice_opens_at,
    codeFreezeAt: row.code_freeze_at,
    finalsAt: row.finals_at,
    config
  };
}

export function createStore(db) {
  const first = (sql, ...args) => db.prepare(sql).bind(...args).first();
  const all = async (sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;
  const run = (sql, ...args) => db.prepare(sql).bind(...args).run();
  const statement = (sql, ...args) => db.prepare(sql).bind(...args);

  return {
    statement,
    batch: (statements) => db.batch(statements),

    async getEvent(id) {
      return mapEvent(await first("SELECT * FROM events WHERE id = ?", id));
    },

    /** Frees handles, names and MSSVs held by teams whose captain never verified (plan §5.2). */
    deleteStalePendingTeams(eventId, cutoff) {
      return run("DELETE FROM teams WHERE event_id = ? AND status = 'pending_captain' AND created_at < ?", eventId, cutoff);
    },

    /** Frees an MSSV or email held by an invited member whose invites have all expired. */
    deleteLapsedInvitees(eventId, mssv, email, now) {
      return run(
        `DELETE FROM members WHERE event_id = ? AND (mssv = ? OR email = ?) AND role = 'member' AND status = 'pending'
           AND NOT EXISTS (SELECT 1 FROM invites i WHERE i.event_id = members.event_id AND i.team_id = members.team_id
                           AND i.mssv = members.mssv AND i.accepted_at IS NULL AND i.expires_at > ?)`,
        eventId, mssv, email, now
      );
    },

    async findConflict(eventId, { handle, displayKey, mssv, email }) {
      if (handle && await first("SELECT 1 AS hit FROM teams WHERE event_id = ? AND handle = ?", eventId, handle)) return "handle_taken";
      if (displayKey && await first("SELECT 1 AS hit FROM teams WHERE event_id = ? AND display_key = ?", eventId, displayKey)) return "display_name_taken";
      if (mssv && await first("SELECT 1 AS hit FROM members WHERE event_id = ? AND mssv = ?", eventId, mssv)) return "mssv_taken";
      if (email && await first("SELECT 1 AS hit FROM members WHERE event_id = ? AND email = ?", eventId, email)) return "email_taken";
      return null;
    },

    getTeamByHandle(eventId, handle) {
      return first("SELECT * FROM teams WHERE event_id = ? AND handle = ?", eventId, handle);
    },

    getTeam(teamId) {
      return first("SELECT * FROM teams WHERE id = ?", teamId);
    },

    deleteTeam(teamId) {
      return run("DELETE FROM teams WHERE id = ?", teamId);
    },

    listMembers(teamId) {
      return all("SELECT * FROM members WHERE team_id = ? ORDER BY role = 'captain' DESC, created_at, mssv", teamId);
    },

    getMember(eventId, mssv) {
      return first("SELECT * FROM members WHERE event_id = ? AND mssv = ?", eventId, mssv);
    },

    setTeamStatus(teamId, status, activeAt) {
      return run("UPDATE teams SET status = ?, active_at = ? WHERE id = ?", status, activeAt, teamId);
    },

    countOtpSince(email, since) {
      return first("SELECT COUNT(*) AS n FROM otp_codes WHERE email = ? AND created_at > ?", email, since).then((row) => row.n);
    },

    latestOtp(teamId, purpose) {
      return first("SELECT * FROM otp_codes WHERE team_id = ? AND purpose = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", teamId, purpose);
    },

    insertOtp(row) {
      return statement(
        "INSERT INTO otp_codes (id, team_id, purpose, email, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        row.id, row.teamId, row.purpose, row.email, row.codeHash, row.createdAt, row.expiresAt
      );
    },

    retireOtps(teamId, purpose, now) {
      return statement("UPDATE otp_codes SET consumed_at = ? WHERE team_id = ? AND purpose = ? AND consumed_at IS NULL", now, teamId, purpose);
    },

    setOtpAttempts(id, attempts) {
      return run("UPDATE otp_codes SET attempts = ? WHERE id = ?", attempts, id);
    },

    consumeOtp(id, now) {
      return statement("UPDATE otp_codes SET consumed_at = ? WHERE id = ?", now, id);
    },

    countInvitesSince(eventId, mssv, since) {
      return first("SELECT COUNT(*) AS n FROM invites WHERE event_id = ? AND mssv = ? AND created_at > ?", eventId, mssv, since).then((row) => row.n);
    },

    getInvite(tokenHash) {
      return first("SELECT * FROM invites WHERE token_hash = ?", tokenHash);
    },

    insertSession(row) {
      return run(
        "INSERT INTO sessions (id_hash, team_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)",
        row.idHash, row.teamId, row.createdAt, row.expiresAt, row.userAgent
      );
    },

    getSessionTeam(idHash, now) {
      return first(
        "SELECT t.* FROM sessions s JOIN teams t ON t.id = s.team_id WHERE s.id_hash = ? AND s.expires_at > ?",
        idHash, now
      );
    },

    deleteSession(idHash) {
      return run("DELETE FROM sessions WHERE id_hash = ?", idHash);
    },

    deleteSessionsOfTeam(teamId, exceptIdHash = "") {
      return statement("DELETE FROM sessions WHERE team_id = ? AND id_hash <> ?", teamId, exceptIdHash);
    },

    setLoginState(teamId, failedLogins, lockedUntil) {
      return run("UPDATE teams SET failed_logins = ?, login_locked_until = ? WHERE id = ?", failedLogins, lockedUntil, teamId);
    },

    /**
     * Fixed-window counter. Returns the count including this hit.
     */
    async hit(bucket, windowStart) {
      const row = await first(
        `INSERT INTO rate_counters (bucket, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT (bucket) DO UPDATE SET
           count = CASE WHEN rate_counters.window_start = excluded.window_start THEN rate_counters.count + 1 ELSE 1 END,
           window_start = excluded.window_start
         RETURNING count`,
        bucket, windowStart
      );
      return row.count;
    },

    // ---------- submissions (P3) ----------

    /** Every version of a team, newest first, without the source bytes. */
    listSubmissions(teamId) {
      return all(
        `SELECT id, seq, language, filename, size, sha256, origin, created_at, status FROM submissions
         WHERE team_id = ? ORDER BY seq DESC`,
        teamId
      );
    },

    getSubmission(id) {
      return first("SELECT * FROM submissions WHERE id = ?", id);
    },

    findSubmissionBySha(teamId, sha256) {
      return first("SELECT id, seq FROM submissions WHERE team_id = ? AND sha256 = ?", teamId, sha256);
    },

    async getSourceBytes(sha256) {
      const row = await first("SELECT content FROM submission_sources WHERE sha256 = ?", sha256);
      // D1 returns a BLOB as an array of numbers, better-sqlite3 as a Buffer.
      return row ? new Uint8Array(row.content) : null;
    },

    countSubmissions(teamId, since) {
      return first(
        "SELECT COUNT(*) AS total, COUNT(CASE WHEN created_at >= ? THEN 1 END) AS today FROM submissions WHERE team_id = ?",
        since, teamId
      );
    },

    /** Submissions of other teams with the same normalised source, one (the earliest) per team. */
    normalizedMatches(eventId, teamId, normalizedHash, limit = 20) {
      return all(
        `SELECT team_id, MIN(id) AS id FROM submissions
         WHERE event_id = ? AND normalized_hash = ? AND team_id <> ?
         GROUP BY team_id LIMIT ?`,
        eventId, normalizedHash, teamId, limit
      );
    },

    setFinalSubmission(teamId, submissionId) {
      return run("UPDATE teams SET final_submission_id = ? WHERE id = ?", submissionId, teamId);
    },

    readOutbox(toEmail) {
      return all("SELECT id, to_email, subject, text_body, created_at FROM dev_outbox WHERE to_email = ? ORDER BY id DESC LIMIT 20", toEmail);
    }
  };
}
