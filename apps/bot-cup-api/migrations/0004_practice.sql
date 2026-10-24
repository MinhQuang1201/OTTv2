-- Bot Cup P5: practice games a team asks for (plan §7.1 stage 1). The team is recorded on the game so the daily limit
-- can be checked inside the INSERT that creates it.
ALTER TABLE matches ADD COLUMN requested_by_team TEXT REFERENCES teams(id);
CREATE INDEX matches_requested ON matches(requested_by_team, created_at);
