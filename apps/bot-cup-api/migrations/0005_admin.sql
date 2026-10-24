-- Bot Cup P6: organisers (BTC), their sessions, the hash-chained audit log, two-person approvals, announcements.
-- Plan: docs/superpowers/plans/2026-10-23-uet-k71-bot-cup.md §4.2, §8.8, §10.4, §11.4. Times are Unix epoch milliseconds.

-- Who may use the admin site. With Cloudflare Access the email comes from the Access JWT; the password + TOTP columns are
-- only used when the admin Worker runs with ADMIN_AUTH_MODE=password (staging before Access is set up).
CREATE TABLE admins (
  email TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
  added_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  password_hash TEXT,
  totp_secret TEXT,
  disabled_at INTEGER,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  login_locked_until INTEGER
);

CREATE TABLE admin_sessions (
  id_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL REFERENCES admins(email),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Every admin write adds one row. hash = SHA-256(prev_hash || canonical row); UNIQUE(prev_hash) makes two concurrent
-- writers unable to fork the chain (the loser retries). Rows can be neither changed nor deleted.
CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  reason TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  prev_hash TEXT NOT NULL UNIQUE,
  hash TEXT NOT NULL UNIQUE
);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit log is append-only');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit log is append-only');
END;

-- Disqualifying a team and changing a result need a second admin (plan §8.8).
CREATE TABLE pending_actions (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);

CREATE TABLE announcements (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  withdrawn_at INTEGER
);

-- Disqualification is kept apart from the registration status, which is recomputed from members.
ALTER TABLE teams ADD COLUMN disqualified_at INTEGER;
ALTER TABLE teams ADD COLUMN dq_reason TEXT;
