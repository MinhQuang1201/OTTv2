# Handoff Session: Worker Local Runtime Config

**Session name:** Worker Local Runtime Config and Browser Smoke
**Date:** 2026-09-29
**Repository:** `D:\Work\Study\OTTv2`
**Branch:** `hotfix/rule-game`
**Commit state:** Changes are not committed.

## Session Goal

Enable the existing online UI to receive a real local or production Worker
endpoint without adding a second WebSocket, fake transport, client-authorized
game state, or a fallback connection path.

## Completed In This Session

- Added public frontend runtime configuration through Vite variables:
  - `VITE_OTT_PLAYHTML_HOST`
  - `VITE_OTT_PLAYHTML_CONTROL_ENDPOINT`
- Added `apps/web/src/runtime-config.ts` and its tests.
- Made `apps/web/vite.config.ts` read the repository root `.env`.
- Added local Worker/runtime helpers under `config/` and `scripts/`.
- Updated `.env.example` and `README.md` with local endpoint setup.
- Ensured runtime config loads before `defaultOnlineGateway` is constructed in
  `apps/web/src/main.tsx`.
- Fixed the browser Worker fixture so it creates `.wrangler` when absent and
  returns the actual generated Worker origin.
- Updated the browser smoke test to use the current canonical A setup instead
  of assuming a piece exists at `A3`.

## Verification Evidence

- `npm test`: **218 passed**, 8 skipped.
- `npm run test:web`: **231 passed** across 25 test files.
- `npm run typecheck:web`: pass.
- `npm run build:web`: pass.
- `npm run test:browser-worker-runtime`: pass.
  - Two isolated browser profiles created and joined a room.
  - Both attached to the same Worker room.
  - Each profile used exactly one provider WebSocket.
  - A legal move propagated between profiles.
- `git diff --check`: pass.

The browser smoke used a temporary local `.dev.vars` containing only a dummy
`OTT_INTERNAL_SECRET`. That file was deleted afterward and no secret was
committed.

## Current Problems / Blockers

### 1. Production endpoint is not configured or deployed

There is no verified production Worker URL in this session and no production
frontend build using a real HTTPS endpoint. Production still needs:

- Worker deployment.
- Production `VITE_OTT_PLAYHTML_HOST`.
- Production `VITE_OTT_PLAYHTML_CONTROL_ENDPOINT`.
- Static frontend deployment built with those values.

Do not mark production online as ready until those values are deployed and
tested against the real Worker.

### 2. Real Worker integration tests are skipped without `.dev.vars`

The following tests intentionally skip when `.dev.vars` is absent:

- Real Worker runtime control tests in `tests/worker-runtime.test.js`.
- Browser Worker smoke setup when no local secret exists.

To run them locally, create an ignored `.dev.vars` with a local-only
`OTT_INTERNAL_SECRET`, run the tests, and remove the file afterward if it is
not needed.

### 3. Manual two-browser acceptance is still pending

Automated two-context browser smoke passes, but the required manual acceptance
has not been recorded. It still needs real browser profiles and evidence for:

- Create and join.
- Legal and invalid moves.
- Reload and reconnect.
- Disconnect grace and disconnect timeout.
- Explicit leave.
- Timeout.
- Token privacy.
- Local/AI fallback when online is unavailable.

Automated browser evidence must not be described as production acceptance.

### 4. Production PlayHTML/Worker rollout remains gated

The minimal local fork/runtime path is testable, but the broader production
gate remains blocked by the repository's existing authority and deployment
requirements. In particular, do not introduce:

- A second browser WebSocket or PartySocket transport.
- A fake `OTT_PLAYHTML_CONNECTION_FACTORY`.
- Client-forged internal routing markers.
- A process-global room registry as authorization.
- Game state stored in PlayHTML page/element data or presence.

`OTT_PLAYHTML_CONNECTION_FACTORY` remains the only approved integration seam
until the upstream/runtime evidence gate is satisfied.

### 5. Worktree contains many uncommitted changes

The session changes are mixed with earlier repository changes. Before creating
a commit, inspect and stage only intended files. Do not reset or discard the
other uncommitted work.

### 6. Dependency audit warnings remain

The earlier install reported 8 npm audit vulnerabilities. They were not
addressed in this session because running `npm audit fix --force` could change
the pinned runtime dependency graph.

## Relevant Files From This Session

- `apps/web/src/runtime-config.ts`
- `apps/web/src/runtime-config.test.ts`
- `apps/web/src/main.tsx`
- `apps/web/vite.config.ts`
- `.env.example`
- `config/local-runtime.js`
- `scripts/worker-dev.js`
- `tests/local-runtime-config.test.js`
- `tests/worker-dev.test.js`
- `tests/browser-worker-runtime.test.js`
- `tests/worker-runtime/fixture.js`
- `docs/superpowers/plans/2026-09-29-worker-local-runtime-config.md`

## Next Steps

1. Create local `.dev.vars` and run the real Worker runtime tests if local
   secret-backed evidence is required.
2. Start the local Worker and web app using the documented endpoint variables
   and perform manual two-browser acceptance.
3. Deploy the Worker to an HTTPS route.
4. Build and deploy the frontend with the production `VITE_*` endpoint values.
5. Run production security checks and manual acceptance before changing any
   production status to ready.

## Stop Rule

This session does **not** establish production readiness, Task 5/Task 8/Task
10 completion, or production two-profile acceptance. Keep online unavailable
when the approved runtime factory is absent; local and AI modes must continue
to work.
