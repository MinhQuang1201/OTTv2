-- SQLite migration 002-competitions: competition lifecycle and entries
-- Apply with BEGIN IMMEDIATE; run once; idempotency via schema_migrations PK.

BEGIN IMMEDIATE;

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES ('002-competitions', datetime('now'));

-- ─── Competitions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS competitions (
  id             TEXT    NOT NULL PRIMARY KEY,
  name           TEXT    NOT NULL CHECK (length(name) > 0 AND length(name) <= 255),
  description    TEXT    NOT NULL DEFAULT '',
  phase          TEXT    NOT NULL DEFAULT 'registration'
                   CHECK (phase IN ('registration', 'preparation', 'locked', 'running', 'completed')),
  capacity       INTEGER NOT NULL DEFAULT 16 CHECK (capacity >= 2 AND capacity <= 128),
  ranked         INTEGER NOT NULL DEFAULT 1 CHECK (ranked IN (0, 1)),
  tournament_id  TEXT    REFERENCES tournaments(id) ON DELETE RESTRICT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_competitions_phase ON competitions(phase);
CREATE INDEX IF NOT EXISTS idx_competitions_tournament ON competitions(tournament_id) WHERE tournament_id IS NOT NULL;

-- ─── Competition Entries ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS competition_entries (
  competition_id  TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'accepted', 'declined')),
  bot_id          TEXT REFERENCES bots(id) ON DELETE RESTRICT,
  bot_version_id  TEXT REFERENCES bot_versions(id) ON DELETE RESTRICT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (competition_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_competition_entries_user ON competition_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_competition_entries_status ON competition_entries(competition_id, status);

COMMIT;
