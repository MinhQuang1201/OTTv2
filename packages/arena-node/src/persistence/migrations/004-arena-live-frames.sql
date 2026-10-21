-- SQLite migration 004-arena-live-frames: incremental live frames projection
-- Apply with BEGIN IMMEDIATE; run once; idempotency via schema_migrations PK.

BEGIN IMMEDIATE;

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES ('004-arena-live-frames', datetime('now'));

-- ─── Live Match Frames Projection ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS match_live_frames (
  match_id    TEXT    NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  attempt_no  INTEGER NOT NULL CHECK (attempt_no >= 1),
  ply         INTEGER NOT NULL CHECK (ply >= 0),
  seat        TEXT    CHECK (seat IN ('A', 'B') OR seat IS NULL),
  move_json   TEXT,
  frame_json  TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (match_id, attempt_no, ply)
);

CREATE INDEX IF NOT EXISTS idx_match_live_frames_query
  ON match_live_frames(match_id, attempt_no, ply);

COMMIT;
