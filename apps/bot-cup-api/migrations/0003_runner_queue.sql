-- Bot Cup P4: runners, games, and the job queue the runners pull from.
-- Plan: docs/superpowers/plans/2026-10-23-uet-k71-bot-cup.md §3.2, §8.4, §9, §10.1, §10.3. Times are Unix epoch milliseconds.

-- One row per organiser machine. The bearer token is only stored hashed; revoking sets revoked_at.
CREATE TABLE runners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_seen_at INTEGER,
  version TEXT,
  image_id TEXT,
  slots INTEGER,
  active INTEGER,
  -- Set when the runner sent a result the rules refute (plan §8.4); the organisers decide what to do.
  suspect_at INTEGER,
  suspect_reason TEXT
);

-- One game. A seat is either a team's submission or a house bot (plan §7.4, §7.5a).
CREATE TABLE matches (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  stage TEXT NOT NULL CHECK (stage IN ('smoke', 'practice', 'gate', 'round_robin', 'swiss', 'knockout')),
  round INTEGER,
  pairing_id TEXT,
  game_index INTEGER NOT NULL DEFAULT 0,
  map_id TEXT NOT NULL CHECK (map_id IN ('classic', 'flanks', 'center')),
  policy_version TEXT NOT NULL,
  a_submission_id TEXT REFERENCES submissions(id),
  a_house TEXT,
  b_submission_id TEXT REFERENCES submissions(id),
  b_house TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'finished', 'failed', 'cancelled')),
  outcome TEXT CHECK (outcome IN ('win', 'draw', 'forfeit')),
  winner TEXT CHECK (winner IN ('A', 'B')),
  loser TEXT CHECK (loser IN ('A', 'B')),
  reason TEXT,
  plies INTEGER,
  replay_gz BLOB,
  replay_sha256 TEXT,
  stderr_a TEXT,
  stderr_b TEXT,
  runner_id TEXT REFERENCES runners(id),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  CHECK ((a_submission_id IS NULL) <> (a_house IS NULL)),
  CHECK ((b_submission_id IS NULL) <> (b_house IS NULL))
);
CREATE INDEX matches_a ON matches(a_submission_id);
CREATE INDEX matches_b ON matches(b_submission_id);
CREATE INDEX matches_stage ON matches(event_id, stage, round);

-- Work for runners. 'check' = syntax check of one submission in the container; 'match' = play one game.
-- Leases expire (plan §8.4: 5 minutes) and the job goes back to the queue; attempts counts every lease.
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  kind TEXT NOT NULL CHECK (kind IN ('check', 'match')),
  priority INTEGER NOT NULL,
  submission_id TEXT REFERENCES submissions(id),
  match_id TEXT REFERENCES matches(id),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'leased', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_runner_id TEXT REFERENCES runners(id),
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error TEXT,
  CHECK ((kind = 'check') = (submission_id IS NOT NULL)),
  CHECK ((kind = 'match') = (match_id IS NOT NULL))
);
CREATE INDEX jobs_queue ON jobs(status, priority, created_at);
CREATE INDEX jobs_lease ON jobs(status, lease_expires_at);
CREATE INDEX jobs_match ON jobs(match_id);
