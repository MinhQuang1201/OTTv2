-- SQLite migration 001-arena: full persistence schema for arena M3
-- Apply with BEGIN IMMEDIATE; run once; idempotency via schema_migrations PK.
-- WAL mode, FK enforcement, and busy_timeout are set at connection open time,
-- not in migration SQL (PRAGMA changes inside transactions can be unreliable).

BEGIN IMMEDIATE;

-- ─── Migrations Tracking ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT NOT NULL PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Users ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                  TEXT NOT NULL PRIMARY KEY,
  normalized_username TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  role                TEXT NOT NULL DEFAULT 'author'
                        CHECK (role IN ('author', 'admin')),
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Auth Sessions ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash  TEXT NOT NULL PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at) WHERE revoked_at IS NULL;

-- ─── API Requests (idempotency) ───────────────────────────────────────────────
-- Scope: actor_id + operation + idempotency_key; created in same transaction as target.
CREATE TABLE IF NOT EXISTS api_requests (
  actor_id          TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation         TEXT    NOT NULL
                      CHECK (length(operation) > 0 AND length(operation) <= 128),
  idempotency_key   TEXT    NOT NULL
                      CHECK (length(idempotency_key) > 0 AND length(idempotency_key) <= 256),
  payload_digest    TEXT    NOT NULL,
  target_id         TEXT    NOT NULL,
  response_status   INTEGER NOT NULL CHECK (response_status > 0),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (actor_id, operation, idempotency_key)
);

-- ─── Bots ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bots (
  id         TEXT NOT NULL PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name       TEXT NOT NULL CHECK (length(name) > 0 AND length(name) <= 255),
  status     TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(owner_id);

-- ─── Bot Versions ─────────────────────────────────────────────────────────────
-- version_no allocated inside UNIQUE transaction, not via MAX+1.
-- source_digest and profile_id/revision are immutable once set (enforced by app).
CREATE TABLE IF NOT EXISTS bot_versions (
  id              TEXT    NOT NULL PRIMARY KEY,
  bot_id          TEXT    NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
  version_no      INTEGER NOT NULL CHECK (version_no >= 1),
  source_digest   TEXT    NOT NULL CHECK (length(source_digest) > 0),
  profile_id      TEXT    NOT NULL CHECK (length(profile_id) > 0),
  profile_revision TEXT   NOT NULL CHECK (length(profile_revision) > 0),
  build_status    TEXT    NOT NULL DEFAULT 'pending'
                    CHECK (build_status IN ('pending', 'building', 'ready', 'failed')),
  artifact_digest TEXT,
  build_log       TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (bot_id, version_no)
);

CREATE INDEX IF NOT EXISTS idx_bot_versions_bot ON bot_versions(bot_id);
CREATE INDEX IF NOT EXISTS idx_bot_versions_status ON bot_versions(build_status);

-- ─── Artifacts ───────────────────────────────────────────────────────────────
-- digest PK; kind: source | build.
-- relative_private_path is server-generated from ID/digest, NOT upload filename.
CREATE TABLE IF NOT EXISTS artifacts (
  digest                TEXT NOT NULL PRIMARY KEY
                           CHECK (length(digest) > 0),
  kind                  TEXT NOT NULL CHECK (kind IN ('source', 'build')),
  relative_private_path TEXT NOT NULL CHECK (length(relative_private_path) > 0),
  bytes                 INTEGER NOT NULL CHECK (bytes >= 0),
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Tournaments ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tournaments (
  id                TEXT NOT NULL PRIMARY KEY,
  name              TEXT NOT NULL CHECK (length(name) > 0),
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'active', 'completed', 'cancelled')),
  ruleset_json      TEXT NOT NULL,
  policy_json       TEXT NOT NULL,
  point_scheme      TEXT NOT NULL DEFAULT '3-1-0'
                      CHECK (point_scheme IN ('3-1-0')),
  ranked            INTEGER NOT NULL DEFAULT 1 CHECK (ranked IN (0, 1)),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Matches ──────────────────────────────────────────────────────────────────
-- kind: ranked | practice. tournament_id nullable for non-tournament matches.
-- All policy/ruleset/profile data snapshotted at creation time.
CREATE TABLE IF NOT EXISTS matches (
  id                  TEXT    NOT NULL PRIMARY KEY,
  kind                TEXT    NOT NULL CHECK (kind IN ('ranked', 'practice')),
  ladder_id           TEXT    NOT NULL CHECK (length(ladder_id) > 0),
  ruleset_json        TEXT    NOT NULL,
  policy_json         TEXT    NOT NULL,
  profile_json        TEXT    NOT NULL,
  initial_state_json  TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'active', 'completed', 'cancelled', 'error')),
  tournament_id       TEXT    REFERENCES tournaments(id) ON DELETE RESTRICT,
  schedule_index      INTEGER,
  settled_at          TEXT,
  settlement_seq      INTEGER,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (tournament_id IS NULL AND schedule_index IS NULL) OR
    (tournament_id IS NOT NULL AND schedule_index IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
CREATE INDEX IF NOT EXISTS idx_matches_kind ON matches(kind);
CREATE INDEX IF NOT EXISTS idx_matches_tournament ON matches(tournament_id) WHERE tournament_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_matches_ladder ON matches(ladder_id);
CREATE INDEX IF NOT EXISTS idx_matches_settled ON matches(settled_at) WHERE settled_at IS NOT NULL;

-- ─── Match Participants ───────────────────────────────────────────────────────
-- seat: A | B. Pins artifact_digest and profile_revision at match creation.
-- Bot or source updated afterwards does NOT change queued/finished match.
CREATE TABLE IF NOT EXISTS match_participants (
  match_id           TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seat               TEXT NOT NULL CHECK (seat IN ('A', 'B')),
  bot_id             TEXT NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
  bot_version_id     TEXT NOT NULL REFERENCES bot_versions(id) ON DELETE RESTRICT,
  artifact_digest    TEXT REFERENCES artifacts(digest) ON DELETE RESTRICT,
  profile_id         TEXT NOT NULL,
  profile_revision   TEXT NOT NULL,
  PRIMARY KEY (match_id, seat)
);

CREATE INDEX IF NOT EXISTS idx_match_participants_bot ON match_participants(bot_id);
CREATE INDEX IF NOT EXISTS idx_match_participants_version ON match_participants(bot_version_id);

-- ─── Jobs ────────────────────────────────────────────────────────────────────
-- kind: build | match. UNIQUE(kind, target_id) ensures one job per target.
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT    NOT NULL PRIMARY KEY,
  kind          TEXT    NOT NULL CHECK (kind IN ('build', 'match')),
  target_id     TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'claimed', 'completed', 'failed', 'cancelled')),
  attempt_no    INTEGER NOT NULL DEFAULT 0 CHECK (attempt_no >= 0),
  lease_owner   TEXT,
  lease_token   TEXT,
  lease_until   TEXT,
  heartbeat_at  TEXT,
  max_attempts  INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, target_id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_kind_status ON jobs(kind, status);
CREATE INDEX IF NOT EXISTS idx_jobs_lease_until ON jobs(lease_until) WHERE status = 'claimed';

-- ─── Job Attempts ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_attempts (
  job_id       TEXT    NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_no   INTEGER NOT NULL CHECK (attempt_no >= 1),
  lease_token  TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'completed', 'failed', 'fenced')),
  diagnostic   TEXT,
  started_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT,
  UNIQUE (job_id, attempt_no)
);

CREATE INDEX IF NOT EXISTS idx_job_attempts_job ON job_attempts(job_id);

-- ─── Match Results ────────────────────────────────────────────────────────────
-- insert-once; match_id is both PK and FK.
CREATE TABLE IF NOT EXISTS match_results (
  match_id           TEXT NOT NULL PRIMARY KEY REFERENCES matches(id) ON DELETE RESTRICT,
  result_json        TEXT NOT NULL,
  replay_json        TEXT NOT NULL,
  replay_digest      TEXT NOT NULL CHECK (length(replay_digest) > 0),
  completion_digest  TEXT NOT NULL CHECK (length(completion_digest) > 0),
  winning_attempt    INTEGER,
  finalized_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Bot Ratings ─────────────────────────────────────────────────────────────
-- Per-bot, per-ladder. Initial rating 1200.0.
-- Distinctbot-only; no author ratings.
CREATE TABLE IF NOT EXISTS bot_ratings (
  ladder_id   TEXT NOT NULL,
  bot_id      TEXT NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
  rating      REAL NOT NULL DEFAULT 1200.0 CHECK (rating >= 0.0),
  rated_games INTEGER NOT NULL DEFAULT 0 CHECK (rated_games >= 0),
  wins        INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
  draws       INTEGER NOT NULL DEFAULT 0 CHECK (draws >= 0),
  losses      INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ladder_id, bot_id)
);

CREATE INDEX IF NOT EXISTS idx_bot_ratings_ladder ON bot_ratings(ladder_id, rating DESC);

-- ─── Rating Changes ───────────────────────────────────────────────────────────
-- settlement_seq from settlement transaction.
CREATE TABLE IF NOT EXISTS rating_changes (
  match_id       TEXT NOT NULL REFERENCES matches(id) ON DELETE RESTRICT,
  bot_id         TEXT NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
  settlement_seq INTEGER NOT NULL CHECK (settlement_seq > 0),
  before_rating  REAL NOT NULL,
  after_rating   REAL NOT NULL,
  delta          REAL NOT NULL,
  k_factor       REAL NOT NULL CHECK (k_factor > 0.0),
  score          REAL NOT NULL CHECK (score >= 0.0 AND score <= 1.0),
  PRIMARY KEY (match_id, bot_id)
);

CREATE INDEX IF NOT EXISTS idx_rating_changes_seq ON rating_changes(settlement_seq);
CREATE INDEX IF NOT EXISTS idx_rating_changes_bot ON rating_changes(bot_id);

-- ─── Tournament Entries ───────────────────────────────────────────────────────
-- bot_version_id / artifact_digest / profile pinned at registration.
CREATE TABLE IF NOT EXISTS tournament_entries (
  tournament_id    TEXT NOT NULL REFERENCES tournaments(id) ON DELETE RESTRICT,
  bot_id           TEXT NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
  bot_version_id   TEXT NOT NULL REFERENCES bot_versions(id) ON DELETE RESTRICT,
  profile_id       TEXT NOT NULL,
  profile_revision TEXT NOT NULL,
  artifact_digest  TEXT REFERENCES artifacts(digest) ON DELETE RESTRICT,
  registered_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tournament_id, bot_id)
);

-- ─── Tournament Matches ───────────────────────────────────────────────────────
-- tournament_id + schedule_index uniquely identifies a round-robin slot.
-- match_id UNIQUE: one match per slot.
CREATE TABLE IF NOT EXISTS tournament_matches (
  tournament_id   TEXT    NOT NULL REFERENCES tournaments(id) ON DELETE RESTRICT,
  schedule_index  INTEGER NOT NULL CHECK (schedule_index >= 0),
  match_id        TEXT    NOT NULL UNIQUE REFERENCES matches(id) ON DELETE RESTRICT,
  PRIMARY KEY (tournament_id, schedule_index)
);

CREATE INDEX IF NOT EXISTS idx_tournament_matches_match ON tournament_matches(match_id);

-- ─── Tournament Standings ─────────────────────────────────────────────────────
-- Stable sort by botId for equal-points MVP (no implicit tiebreak).
CREATE TABLE IF NOT EXISTS tournament_standings (
  tournament_id TEXT    NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  bot_id        TEXT    NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
  played        INTEGER NOT NULL DEFAULT 0 CHECK (played >= 0),
  wins          INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
  draws         INTEGER NOT NULL DEFAULT 0 CHECK (draws >= 0),
  losses        INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
  points        INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tournament_id, bot_id)
);

CREATE INDEX IF NOT EXISTS idx_tournament_standings_points
  ON tournament_standings(tournament_id, points DESC, bot_id ASC);

-- ─── Stamp Migration ─────────────────────────────────────────────────────────
INSERT OR IGNORE INTO schema_migrations (version) VALUES ('001-arena');

COMMIT;
