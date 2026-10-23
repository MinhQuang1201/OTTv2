# `bot-cup-core`

Pure rules for the OTT Bot Cup (plan: `docs/superpowers/plans/2026-10-23-uet-k71-bot-cup.md`). No I/O, no clock,
no randomness of its own: callers pass `now` and a `getRandomValues` function.

- `eligibility.mjs` — demo/production modes, MSSV and email checks, email masking
- `team.mjs` — handle, display name and full-name validation, team status derived from members
- `policy.mjs` — OTP, invite, session and login limits, registration window

`apps/bot-cup-api` is the only consumer for now. Later phases add pairing, standings and replay verification here.
