-- Bot Cup P1: events, team accounts, members, invites, OTP codes, sessions, rate counters.
-- Plan: docs/superpowers/plans/2026-10-23-uet-k71-bot-cup.md §5, §10.1. Times are Unix epoch milliseconds.

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('demo', 'production')),
  phase TEXT NOT NULL DEFAULT 'registration',
  registration_opens_at INTEGER NOT NULL,
  registration_closes_at INTEGER NOT NULL,
  practice_opens_at INTEGER,
  code_freeze_at INTEGER,
  finals_at INTEGER,
  -- {"eligibility": {"mssvPrefix": "26", "emailDomain": "vnu.edu.vn", "allowExternalEmail": false}}
  config_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  handle TEXT NOT NULL,
  display_name TEXT NOT NULL,
  display_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('solo', 'group')),
  status TEXT NOT NULL,
  captain_mssv TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  active_at INTEGER,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  login_locked_until INTEGER,
  UNIQUE (event_id, handle),
  UNIQUE (event_id, display_key)
);

-- One row per student per event: the primary key is what makes "one student, one team" hold (plan §8.1).
CREATE TABLE members (
  event_id TEXT NOT NULL REFERENCES events(id),
  mssv TEXT NOT NULL,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('captain', 'member')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed')),
  show_name INTEGER NOT NULL DEFAULT 0,
  consent_at INTEGER,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  PRIMARY KEY (event_id, mssv),
  UNIQUE (event_id, email)
);
CREATE INDEX members_team ON members(team_id);

CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  mssv TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER
);
CREATE INDEX invites_member ON invites(event_id, mssv, created_at);

CREATE TABLE otp_codes (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'reset')),
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at INTEGER
);
CREATE INDEX otp_codes_email ON otp_codes(email, created_at);
CREATE INDEX otp_codes_team ON otp_codes(team_id, purpose, created_at);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);
CREATE INDEX sessions_team ON sessions(team_id);

CREATE TABLE rate_counters (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

-- Only written when BOT_CUP_EMAIL_MODE=outbox (local tests and staging before the email provider is set up).
CREATE TABLE dev_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
