# OTT Worker Runtime Evidence

Date: 2026-09-25  
Scope: LUNA implementation report Tasks 8-9  
Status: online rollout remains **BLOCKED**.

## Environment

- Node: `v22.19.0`
- npm: `11.12.1`
- Wrangler: `4.140.0`
- Worker config: `workers/wrangler.jsonc`
- Local secret: expected only in ignored `.dev.vars` as `OTT_INTERNAL_SECRET=...`; no secret is recorded here.

## Executed Checks

| Check | Result | Evidence |
| --- | --- | --- |
| Wrangler dry-run bundle | PASS | `npx wrangler --config workers/wrangler.jsonc deploy --dry-run`; all `Main`, `OTT_GAME`, and `OTT_LOBBY` bindings resolved. |
| Deterministic Worker/static/authority tests | PASS | Worker-specific tests cover routing, control projection, capability format, read-only Yjs policy, and transport denylist. |
| Real local Wrangler control/DO smoke | NOT RUN unless `.dev.vars` exists | `npm run test:worker-runtime`; starts actual `wrangler dev --local`, then checks create/list/join/resume, ticket isolation, direct-control rejection, and raw WebSocket upgrade. |
| Real YProvider two-client initial-sync/mutation smoke | NOT RUN | No installed `yjs` package or verified browser YProvider runner exists in this repository. No fake provider is used. |
| Task 9 two-profile manual acceptance | NOT RUN | No browser runner/profile evidence is available. No PASS is inferred from unit tests. |
| Capability forgery/replay | PASS at deterministic authority boundary | `tests/ott-authority.test.js` verifies HMAC, room/purpose binding, expiry, and nonce consumption paths; full Worker replay requires the local secret smoke. |
| Room alarms/hydration | PASS at deterministic room boundary | Existing room/storage tests cover alarm scheduling, hydration, persistence, reconnect grace, and terminal handling. |

## Full Suite Note

`npm test` was executed. It produced 110 passing tests, 1 skipped test, and 13 failing legacy PartyKit room/runtime tests. Those failures are outside the new Wrangler harness and are not converted into Worker runtime PASS claims. Worker-specific deterministic checks passed.

## Browser/Task 9 Blocker

The repository has a minimal source-backed custom-message adapter, but not a verified browser `YProvider`/Yjs runtime package and not a browser automation dependency. Therefore initial sync ordering, pre/post-attach Yjs mutation discard across two clients, DevTools single-connection inspection, and two-profile create/list/join/resume acceptance are **NOT RUN**. The Worker remains unavailable to the online UI and no production readiness is claimed.
