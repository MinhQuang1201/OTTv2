-- Bot Cup P7: tournament control — sealed entries at code freeze, pairings, published result documents, appeals.
-- Plan: docs/superpowers/plans/2026-10-23-uet-k71-bot-cup.md §7, §8.2, §8.8. Times are Unix epoch milliseconds.

-- One row per team sealed at code freeze (plan §6.2): the exact submission that plays every official game.
CREATE TABLE entrants (
  event_id TEXT NOT NULL REFERENCES events(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  sha256 TEXT NOT NULL,
  submitted_at INTEGER NOT NULL,            -- the sealed version's upload time: the last tie-break (plan §7.5)
  sealed_at INTEGER NOT NULL,
  gate_points REAL,
  gate_status TEXT NOT NULL DEFAULT 'pending' CHECK (gate_status IN ('pending', 'qualified', 'not_qualified')),
  seed INTEGER,
  interview TEXT NOT NULL DEFAULT 'pending' CHECK (interview IN ('pending', 'pass', 'fail')),
  eliminated_at INTEGER,
  PRIMARY KEY (event_id, team_id)
);

CREATE TRIGGER entrants_sealed BEFORE UPDATE OF submission_id, sha256, submitted_at, sealed_at ON entrants
BEGIN
  SELECT RAISE(ABORT, 'sealed submissions cannot change');
END;

-- A pair of teams in a stage round, or a bye. Knockout pairings carry their bracket slot and seeds.
CREATE TABLE pairings (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  stage TEXT NOT NULL CHECK (stage IN ('round_robin', 'swiss', 'knockout')),
  round INTEGER NOT NULL,
  slot TEXT,
  team_a TEXT REFERENCES teams(id),
  team_b TEXT REFERENCES teams(id),
  seed_a INTEGER,
  seed_b INTEGER,
  bye_team TEXT REFERENCES teams(id),
  tiebreaks INTEGER NOT NULL DEFAULT 0,
  winner_team TEXT REFERENCES teams(id),
  decided_by_seed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX pairings_stage ON pairings(event_id, stage, round);

-- Result documents as published (plan §8.8): the exact JSON text and its SHA-256, never changed.
CREATE TABLE stage_results (
  event_id TEXT NOT NULL REFERENCES events(id),
  stage TEXT NOT NULL CHECK (stage IN ('sealed', 'gate', 'qualifying', 'final')),
  json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, stage)
);

CREATE TRIGGER stage_results_keep BEFORE UPDATE ON stage_results
BEGIN
  SELECT RAISE(ABORT, 'published results are immutable');
END;

CREATE TABLE appeals (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  stage TEXT NOT NULL,
  match_id TEXT REFERENCES matches(id),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered')),
  response TEXT,
  answered_by TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER
);
CREATE INDEX appeals_team ON appeals(team_id, stage);
