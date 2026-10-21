-- SQLite migration 003-competition-rounds: rounds, maps and modes extension
-- Apply with BEGIN IMMEDIATE; run once; idempotency via schema_migrations PK.

BEGIN IMMEDIATE;

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES ('003-competition-rounds', datetime('now'));

-- ─── Alter Competitions Table for Rounds, Maps and Modes ─────────────────────
ALTER TABLE competitions ADD COLUMN format_id TEXT NOT NULL DEFAULT 'double-round-robin';
ALTER TABLE competitions ADD COLUMN map_id TEXT NOT NULL DEFAULT 'classic';
ALTER TABLE competitions ADD COLUMN map_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE competitions ADD COLUMN map_snapshot_json TEXT;
ALTER TABLE competitions ADD COLUMN mode TEXT NOT NULL DEFAULT 'ranked' CHECK (mode IN ('ranked', 'practice'));
ALTER TABLE competitions ADD COLUMN round_count INTEGER NOT NULL DEFAULT 1 CHECK (round_count >= 1 AND round_count <= 254);
ALTER TABLE competitions ADD COLUMN current_round INTEGER NOT NULL DEFAULT 0 CHECK (current_round >= 0 AND current_round <= 254);
ALTER TABLE competitions ADD COLUMN is_extended INTEGER NOT NULL DEFAULT 0 CHECK (is_extended IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_competitions_is_extended ON competitions(is_extended);

-- ─── Competition Rounds ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS competition_rounds (
  competition_id  TEXT    NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  round_number    INTEGER NOT NULL CHECK (round_number >= 1 AND round_number <= 254),
  tournament_id   TEXT    NOT NULL UNIQUE REFERENCES tournaments(id) ON DELETE RESTRICT,
  status          TEXT    NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'completed')),
  pairings_json   TEXT    NOT NULL DEFAULT '[]',
  byes_json       TEXT    NOT NULL DEFAULT '[]',
  warnings_json   TEXT    NOT NULL DEFAULT '[]',
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT,
  PRIMARY KEY (competition_id, round_number)
);

CREATE INDEX IF NOT EXISTS idx_competition_rounds_comp ON competition_rounds(competition_id, round_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_competition_rounds_tournament ON competition_rounds(tournament_id);

-- ─── Competition Round Byes ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS competition_round_byes (
  competition_id  TEXT    NOT NULL,
  round_number    INTEGER NOT NULL CHECK (round_number >= 1 AND round_number <= 254),
  bot_id          TEXT    NOT NULL REFERENCES bots(id) ON DELETE RESTRICT,
  points          INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (competition_id, round_number, bot_id),
  FOREIGN KEY (competition_id, round_number) REFERENCES competition_rounds(competition_id, round_number) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_competition_round_byes_bot ON competition_round_byes(competition_id, bot_id);

COMMIT;
