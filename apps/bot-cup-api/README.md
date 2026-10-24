# `apps/bot-cup-api`

Cloudflare Worker for the Bot Cup (plan `docs/superpowers/plans/2026-10-23-uet-k71-bot-cup.md`): team accounts, email
OTP, member invites, login sessions, password reset (P1); bot submissions (P3). Rules live in `packages/bot-cup-core`.
The browser reaches it as `/api/t/*` through a Vercel rewrite, so the session cookie is first-party.

## Endpoints (`/api/t`)

| Method | Path | Notes |
|---|---|---|
| GET | `/event` | Public: dates, mode, eligibility rules, Turnstile site key |
| POST | `/register` | `{kind, handle, displayName, password, consent, showName, turnstileToken, captain: {fullName, mssv, email?}}` → OTP to the captain |
| POST | `/register/verify` | `{handle, otp}` → session cookie |
| POST | `/register/resend` | `{handle, turnstileToken}` |
| POST | `/login`, `/logout` | `{handle, password, turnstileToken}` |
| GET | `/me` | Team and members (emails masked) |
| POST | `/team/members` | `{fullName, mssv, email?}` → invite email (groups, ≤ 3 members) |
| DELETE | `/team/members/:mssv` | Not the captain |
| POST | `/team/members/:mssv/resend` | New invite link, old one stops working |
| GET | `/invites/:token` | Preview for the invite page |
| POST | `/invites/accept` | `{token, consent, showName}` |
| POST | `/password/reset/request` | `{handle, mssv?, turnstileToken}` → OTP to the captain or the named confirmed member |
| POST | `/password/reset/confirm` | `{handle, otp, newPassword}` → ends every session |
| POST | `/password/change` | `{currentPassword, newPassword}` → ends the other sessions |
| POST | `/sessions/revoke-all` | Logs out everywhere |
| GET | `/_dev/outbox?to=` | Only with `Authorization: Bearer $BOT_CUP_DEV_TOKEN`; reads mail in `outbox` mode |
| GET | `/submissions` | The team's versions (newest first), effective final submission, upload window, daily quota |
| POST | `/submissions` | `multipart/form-data`, field `file`: one `.py` / `.js` / `.mjs`, ≤ 200 KB, UTF-8 text. Active teams, from `practice_opens_at` until `code_freeze_at`, 10 per Vietnamese day, 200 in total |
| GET | `/submissions/:id`, `/submissions/:id/source` | Own team only (another team's id answers 404) |
| PUT | `/team/final-submission` | `{submissionId}` or `{submissionId: null}` for "newest eligible"; 409 `code_frozen` after `code_freeze_at` |

Submissions are append-only (D1 triggers); the bytes live in `submission_sources` keyed by SHA-256. Each upload's
normalised source (`bot-cup-core.normalizeSource`) is compared with other teams' submissions and with the public reference
files in `src/reference-hashes.mjs` (regenerate with `npm run bot-cup:reference-hashes`); a match adds a row to
`similarity_flags`, which teams never see. New submissions wait in `checking` until the runner (P4) checks syntax and
runs the smoke test.

Errors are `{ "error": "<code>", "field"?: "<field>" }`; the web app maps codes to Vietnamese messages.
Every non-GET request must carry an `Origin` listed in `BOT_CUP_ALLOWED_ORIGINS` (defaults to `BOT_CUP_WEB_ORIGIN`).

## Configuration

See `src/index.mjs` for the full list. Secrets: `OTP_PEPPER` (≥ 16 chars), `BREVO_API_KEY` (when
`BOT_CUP_EMAIL_MODE=brevo`), `TURNSTILE_SECRET` (unless bypassed in the local test env), `BOT_CUP_DEV_TOKEN` (optional).

## Tests

```bash
npm run test:bot-cup       # core + API on SQLite with the real migrations (part of test:unit)
npm run test:bot-cup:api   # wrangler dev --local + local D1 (part of test:integration)
```

## Staging

Deployed by hand on 2026-10-24 at `https://ottv2-bot-cup-api-staging.opticsquang.workers.dev` (no CI workflow yet).
Secrets were uploaded with `wrangler secret bulk <file.json>` from a temporary file. To rebuild it from scratch:

```bash
npx wrangler d1 migrations apply ottv2-bot-cup-staging --remote --env staging --config apps/bot-cup-api/wrangler.jsonc
npx wrangler d1 execute ottv2-bot-cup-staging --remote --env staging --config apps/bot-cup-api/wrangler.jsonc --file apps/bot-cup-api/seeds/staging-event.sql
npx wrangler secret put OTP_PEPPER --env staging --config apps/bot-cup-api/wrangler.jsonc
npx wrangler secret put BREVO_API_KEY --env staging --config apps/bot-cup-api/wrangler.jsonc
npx wrangler secret put BOT_CUP_EMAIL_SENDER --env staging --config apps/bot-cup-api/wrangler.jsonc   # a sender verified in Brevo
npx wrangler secret put TURNSTILE_SECRET --env staging --config apps/bot-cup-api/wrangler.jsonc   # 1x0000000000000000000000000000000AA until a real widget exists
npx wrangler deploy --env staging --config apps/bot-cup-api/wrangler.jsonc
```
