-- Bot Cup P3: bot submissions, their source bytes, and copy-detection flags.
-- Plan: docs/superpowers/plans/2026-10-23-uet-k71-bot-cup.md §6, §8.2, §8.5, §10.1. Times are Unix epoch milliseconds.

-- Exact uploaded bytes, keyed by SHA-256, shared when two submissions are byte-identical. Never changed.
CREATE TABLE submission_sources (
  sha256 TEXT PRIMARY KEY,
  content BLOB NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Append-only: only status and check_log change, when the runner reports (P4) — see the triggers below.
CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  seq INTEGER NOT NULL,                       -- version number within the team, from 1
  language TEXT NOT NULL CHECK (language IN ('python', 'node')),
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  normalized_hash TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'upload' CHECK (origin IN ('upload', 'github')),
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'checking' CHECK (status IN ('checking', 'ready', 'build_failed', 'smoke_failed')),
  check_log TEXT,
  UNIQUE (team_id, seq),
  UNIQUE (team_id, sha256)
);
CREATE INDEX submissions_team_created ON submissions(team_id, created_at);
CREATE INDEX submissions_normalized ON submissions(event_id, normalized_hash);

CREATE TRIGGER submissions_append_only
BEFORE UPDATE OF id, event_id, team_id, seq, language, filename, size, sha256, normalized_hash, origin, created_at ON submissions
BEGIN
  SELECT RAISE(ABORT, 'submissions are append-only');
END;

CREATE TRIGGER submissions_keep
BEFORE DELETE ON submissions
BEGIN
  SELECT RAISE(ABORT, 'submissions are append-only');
END;

CREATE TRIGGER submission_sources_keep
BEFORE UPDATE ON submission_sources
BEGIN
  SELECT RAISE(ABORT, 'submission sources are immutable');
END;

-- The team's explicit choice of final submission; NULL means "the newest eligible one" (plan §6.2).
ALTER TABLE teams ADD COLUMN final_submission_id TEXT;

-- Suspicions for the organisers to review (plan §8.5, §8.8). Never shown to teams.
CREATE TABLE similarity_flags (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  kind TEXT NOT NULL CHECK (kind IN ('hash', 'jplag', 'behavior', 'collusion')),
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  other_submission_id TEXT REFERENCES submissions(id),
  reference TEXT,                             -- a file from the public reference corpus, e.g. "packages/game-core/src/ai.js"
  score REAL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cleared', 'confirmed')),
  notes TEXT,
  created_at INTEGER NOT NULL,
  CHECK ((other_submission_id IS NULL) <> (reference IS NULL))
);
CREATE INDEX similarity_flags_submission ON similarity_flags(submission_id);
