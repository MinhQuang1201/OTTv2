-- Staging event: demo mode, registration and submissions open for the whole development period, no code freeze.
-- npx wrangler d1 execute ottv2-bot-cup-staging --remote --env staging --config apps/bot-cup-api/wrangler.jsonc --file apps/bot-cup-api/seeds/staging-event.sql
INSERT INTO events (id, name, mode, phase, registration_opens_at, registration_closes_at, practice_opens_at, config_json)
VALUES (
  'staging-demo',
  'OTT Bot Cup (staging)',
  'demo',
  'registration',
  1761264000000, -- 2025-10-24T00:00:00Z
  1798761600000, -- 2027-01-01T00:00:00Z
  1792713600000, -- 2026-10-23T00:00:00Z: submissions open (P3)
  '{}'
)
ON CONFLICT (id) DO UPDATE SET
  name = excluded.name,
  mode = excluded.mode,
  registration_opens_at = excluded.registration_opens_at,
  registration_closes_at = excluded.registration_closes_at,
  practice_opens_at = excluded.practice_opens_at;
