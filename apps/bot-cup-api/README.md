# `apps/bot-cup-api`

Cloudflare Worker for Bot Cup registration (plan `docs/superpowers/plans/2026-10-23-uet-k71-bot-cup.md`, P1):
team accounts, email OTP, member invites, login sessions, password reset. Rules live in `packages/bot-cup-core`.
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

## Staging setup (not done yet; run when the web side needs it)

```bash
npx wrangler d1 migrations apply ottv2-bot-cup-staging --remote --env staging --config apps/bot-cup-api/wrangler.jsonc
npx wrangler d1 execute ottv2-bot-cup-staging --remote --env staging --config apps/bot-cup-api/wrangler.jsonc --file apps/bot-cup-api/seeds/staging-event.sql
npx wrangler secret put OTP_PEPPER --env staging --config apps/bot-cup-api/wrangler.jsonc
npx wrangler secret put TURNSTILE_SECRET --env staging --config apps/bot-cup-api/wrangler.jsonc   # 1x0000000000000000000000000000000AA until a real widget exists
npx wrangler secret put BOT_CUP_DEV_TOKEN --env staging --config apps/bot-cup-api/wrangler.jsonc
npx wrangler deploy --env staging --config apps/bot-cup-api/wrangler.jsonc
```
