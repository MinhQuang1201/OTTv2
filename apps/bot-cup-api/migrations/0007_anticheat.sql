-- Bot Cup P8: anti-cheat tools — behaviour fingerprints ('probe' jobs), JPlag imports and flag handling.
-- Plan: docs/superpowers/plans/2026-10-23-uet-k71-bot-cup.md §8.5, §8.7, §8.8. Times are Unix epoch milliseconds.

-- 'probe' = ask one bot (a submission or a house bot) for its move in each position of a secret set kept on the
-- organisers' runner machine (plan §8.5). The set is named by the SHA-256 of its file, so fingerprints from different
-- sets are never compared. SQLite cannot change a CHECK in place: the table is rebuilt (nothing references jobs).
CREATE TABLE jobs_p8 (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  kind TEXT NOT NULL CHECK (kind IN ('check', 'match', 'probe')),
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
  probe_house TEXT,
  probe_set TEXT,
  CHECK ((kind = 'match') = (match_id IS NOT NULL)),
  CHECK (kind <> 'check' OR submission_id IS NOT NULL),
  CHECK (kind <> 'probe' OR (probe_set IS NOT NULL AND (submission_id IS NULL) <> (probe_house IS NULL))),
  CHECK (kind = 'probe' OR (probe_house IS NULL AND probe_set IS NULL))
);
INSERT INTO jobs_p8 (id, event_id, kind, priority, submission_id, match_id, status, attempts, lease_runner_id, lease_expires_at,
                     created_at, updated_at, last_error)
  SELECT id, event_id, kind, priority, submission_id, match_id, status, attempts, lease_runner_id, lease_expires_at,
         created_at, updated_at, last_error
  FROM jobs;
DROP TABLE jobs;
ALTER TABLE jobs_p8 RENAME TO jobs;
CREATE INDEX jobs_queue ON jobs(status, priority, created_at);
CREATE INDEX jobs_lease ON jobs(status, lease_expires_at);
CREATE INDEX jobs_match ON jobs(match_id);
CREATE INDEX jobs_probe ON jobs(probe_set, submission_id, probe_house);

-- One bot's answers to one secret set: moves_json is an array with one "x,y-x,y" (or null: no legal answer) per position.
CREATE TABLE fingerprints (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  probe_set TEXT NOT NULL,
  submission_id TEXT REFERENCES submissions(id),
  house TEXT,
  moves_json TEXT NOT NULL,
  answered INTEGER NOT NULL,
  total INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK ((submission_id IS NULL) <> (house IS NULL))
);
CREATE UNIQUE INDEX fingerprints_submission ON fingerprints(probe_set, submission_id) WHERE submission_id IS NOT NULL;
CREATE UNIQUE INDEX fingerprints_house ON fingerprints(probe_set, house) WHERE house IS NOT NULL;

-- Flag handling (plan §8.8): evidence for the reviewers (JSON), and when the team was told (it then has 48 hours).
ALTER TABLE similarity_flags ADD COLUMN details TEXT;
ALTER TABLE similarity_flags ADD COLUMN notified_at INTEGER;
ALTER TABLE similarity_flags ADD COLUMN notified_by TEXT;
