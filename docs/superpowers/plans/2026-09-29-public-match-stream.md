# Public Match Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a third browser profile see active matches and enter a read-only spectator session through the existing Worker/PlayHTML lifecycle, first in the local spectator test runtime and only later in production after the evidence gates pass.

**Architecture:** Add a validated public-match contract to the shared protocol, make the Lobby catalog durable and recoverable, and expose it through `OttLobbyStreamServer`. Add a client lobby-stream adapter owned by one App transition coordinator; it must dispose the lobby provider before obtaining a spectator ticket and opening the game provider. Keep production fail-closed until direct runtime, hibernation/reconnect, security, and three-profile acceptance evidence exists.

**Tech Stack:** TypeScript, React/Vite, Cloudflare Workers/Durable Objects, `y-partyserver`, PlayHTML minimal runtime seam, Vitest, Node test runner, Wrangler, Vercel static deployment.

---

## File Map

- Modify `packages/protocol/src/index.ts`: define the public-match catalog types, exact envelope, bounds, and shared parser/validator.
- Create `apps/web/src/shared/model/publicMatch.test.ts`: Vitest coverage for the shared public-match parser/validator, ensuring the test is included by the existing web test runner.
- Modify `apps/web/src/shared/model/game.ts`: replace the duplicate `PublicMatchView` shape with the shared protocol type or an explicit type-only re-export.
- Create `apps/worker/src/lobby/public-match.ts`: Worker-side public-summary normalization and catalog validation helpers that enforce the shared protocol contract without leaking private fields.
- Modify `apps/worker/src/lobby/ott-lobby-server.ts`: validate summaries before persistence, store a revision-keyed notification retry record, retry/resync catalog updates, and preserve terminal removal delivery.
- Modify `apps/worker/src/lobby/ott-lobby-stream-server.ts`: validate cached catalog updates, send the current snapshot on subscribe, and handle bounded reconnect/resubscribe behavior.
- Create `apps/web/src/sessions/online/OnlineLobbyStream.ts`: browser adapter for the lobby provider connection and `ott:lobby-subscribe`/`ott:active-matches` messages.
- Create `apps/web/src/sessions/online/OnlineLobbyStream.test.ts`: adapter lifecycle, validation, reconnect, and disposal tests.
- Modify `apps/web/src/sessions/online/globals.d.ts`: add the minimal stream/client lifecycle types needed by the adapter and shared public-match types.
- Modify `apps/web/src/sessions/contract.ts`: carry an exact validated `PlayhtmlSpectatorAllocation` in `StartGameOptions` so game bootstrap cannot occur before ticket acquisition.
- Modify `apps/web/src/sessions/online/OnlineLobbyGateway.ts`: expose the typed spectator allocation used by the transition coordinator.
- Modify `apps/web/src/sessions/online/runtimeBridge.ts`: support an injected lifecycle owner and idempotent ready/dispose semantics without a second raw transport.
- Modify `apps/web/src/sessions/online/OnlineSession.ts`: accept the App-owned runtime bridge and stop constructing an independent bridge for the same lifecycle.
- Modify `apps/web/src/sessions/spectator/SpectatorSession.ts`: accept the App-owned bridge and require a validated ticket before game bootstrap.
- Modify `apps/web/src/app/App.tsx`: own the lobby stream, route active-match state into the lobby, serialize lobby-to-spectator transitions, and reopen the lobby stream after spectator exit or ticket failure.
- Modify `apps/web/src/app/App.test.tsx`: test ready/unavailable match list rendering and transition ordering.
- Modify `apps/web/src/sessions/spectator/SpectatorSession.test.ts`: test that no provider opens before ticket validation and that spectator remains read-only.
- Modify `tests/spectator-test-worker.test.js`: add Worker-level catalog validation, retry/resync, and terminal removal coverage.
- Modify `tests/worker-runtime.test.js` and/or `tests/browser-worker-runtime.test.js`: add real lobby-party subscription/fan-out/reconnect coverage where the existing harness supports it.
- Modify `tests/worker-runtime/fixture.js`: support a dedicated spectator Worker fixture using `apps/worker/wrangler.spectator-test.jsonc`; keep normal two-player tests on `wrangler.jsonc --env test/demo`.
- Modify `apps/worker/src/entry/ott-test-worker.ts` and the test-only game entry if needed: add an authenticated close/reconnect probe restricted to `/__test/*` and `OTT_TEST_PROBE_SECRET`.
- Modify `package.json`: add explicit `test:worker:spectator` and `test:browser-worker:spectator` commands that select the dedicated spectator fixture/config.
- Modify `tests/server.test.js`: retain request-level mixed-case static denylist coverage as a rollout prerequisite.
- Modify `apps/worker/wrangler.spectator-test.jsonc` only if the local stream harness needs an explicit test variable; do not copy test values into production config.
- Modify `DEPLOYMENT.md` and `HANDOFF.md` only after evidence is actually run, documenting commands and results rather than asserting readiness in advance.

## Task 1: Define The Public Match Contract

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Create: `apps/web/src/shared/model/publicMatch.test.ts`
- Create: `apps/worker/src/lobby/public-match.ts`
- Test: `tests/spectator-test-worker.test.js`

- [ ] **Step 1: Write failing protocol tests** in `apps/web/src/shared/model/publicMatch.test.ts` for valid `ott:active-matches` envelopes, stale revisions, duplicate IDs, invalid status, non-integer revisions, oversized names/counts, forbidden ticket fields, and payloads over `MAX_OTT_PAYLOAD_BYTES`.
- [ ] **Step 2: Run `rtk npm run test:web -- --run apps/web/src/shared/model/publicMatch.test.ts`** and confirm the new parser/validator tests fail before implementation.
- [ ] **Step 3: Add exact shared types and validation** for `PublicMatchView`, `PublicMatchCatalog`, and the custom-message envelope. Enforce finite bounded collections, canonical allocation/room IDs, `status: "playing"`, public player fields only, and UTF-8 payload size.
- [ ] **Step 4: Add Worker normalization** that maps an internal summary to the exact public contract and rejects unknown/private fields before persistence or fan-out.
- [ ] **Step 5: Run focused protocol and Worker tests** and confirm valid catalogs pass while all malformed cases are rejected.

## Task 2: Make Lobby Catalog Delivery Recoverable

**Files:**
- Modify: `apps/worker/src/lobby/ott-lobby-server.ts`
- Modify: `apps/worker/src/lobby/ott-lobby-stream-server.ts`
- Test: `tests/spectator-test-worker.test.js`

- [ ] **Step 1: Write failing tests** for a valid active update, a stale update, a malformed summary, a dropped stream notification, a stream resubscribe, and terminalization removing a match.
- [ ] **Step 2: Run the focused Worker tests** and confirm the dropped-notification and malformed-summary cases fail with the current best-effort implementation.
- [ ] **Step 3: Validate every active update server-side** before storing `allocation.summary`, `summaryVersion`, or broadcasting a catalog. Reject invalid revision/summary shapes and enforce the 8 KB bound.
- [ ] **Step 4: Add durable revision-keyed retry/resync state** in Lobby storage with bounded retry scheduling through the existing Durable Object alarm. Make updates and terminal removal idempotent and ensure a later subscription can always obtain the current durable snapshot.
- [ ] **Step 4a: Define the multiplexed alarm scheduler** so rate-limit cleanup and catalog retry deadlines share the one Durable Object alarm slot. Store a durable `public-catalog-notify` record containing `{ catalogRevision, attempt, nextAttemptMs, terminalRemovalPending }`; coalesce newer revisions transactionally, calculate the minimum of the next rate-limit cleanup and catalog retry deadlines, claim the record transactionally before delivery, and restore/reschedule it on failure.
- [ ] **Step 4b: Define retry exhaustion** as bounded logging plus a still-authoritative durable catalog; a later stream subscription/resync must recover the latest catalog. Never delete terminal-removal state before successful cache update or explicit bounded-exhaustion recording.
- [ ] **Step 4c: Define fan-out failure semantics**: stream-side sends are best-effort and need not acknowledge individual browser frames; `OttLobbyStreamServer` schedules a bounded resend of its cached latest catalog when a connection send fails, while Lobby retries failed stream-cache updates. Add tests for an already-connected client whose send throws.
- [ ] **Step 5: Validate stream cache input and output** before caching or sending `ott:active-matches`; disabled mode must remain HTTP 404/connection close and must not retry indefinitely.
- [ ] **Step 6: Run the focused Worker tests** and confirm notification loss recovery, terminal removal, stale revision rejection, and disabled fail-closed behavior pass.

## Task 3: Add The Browser Lobby Stream Adapter

**Files:**
- Create: `apps/web/src/sessions/online/OnlineLobbyStream.ts`
- Create: `apps/web/src/sessions/online/OnlineLobbyStream.test.ts`
- Modify: `apps/web/src/sessions/online/globals.d.ts`
- Modify: `apps/web/src/sessions/online/runtimeBridge.ts`

- [ ] **Step 1: Write failing adapter tests** for disabled 404 mapping to `unavailable`, already-connected bootstrap, open-event bootstrap, exactly one subscribe per generation, valid catalog delivery, stale catalog ignore, malformed message ignore, bounded reconnect, and awaited disposal.
- [ ] **Step 2: Run `rtk npm run test:web -- --run apps/web/src/sessions/online/OnlineLobbyStream.test.ts`** and confirm the new tests fail because the adapter does not exist.
- [ ] **Step 3: Implement the adapter** using the reviewed runtime/connection seam and `party: "lobby"`, `room: "ott-lobby-public"`; do not instantiate raw `WebSocket`, poll `/control/active`, or create a second transport.
- [ ] **Step 4: Implement an idempotent ready handshake** that handles a provider already connected as well as a later `open` event, then sends `ott:lobby-subscribe` only once for the active generation.
- [ ] **Step 5: Parse and validate all incoming envelopes** with the shared public-match contract, expose immutable `loading/ready/unavailable/error/reconnecting` state, and ignore stale or foreign generations.
- [ ] **Step 6: Implement awaited disposal** and bounded reconnect/resubscribe. Treat all pre-open failures, including disabled 404, as `unavailable`; reserve `reconnecting/error` for post-open failures.
- [ ] **Step 7: Run the adapter tests** and confirm all lifecycle and validation cases pass.

## Task 4: Serialize App, Player, And Spectator Provider Lifecycles

**Files:**
- Modify: `apps/web/src/sessions/online/OnlineSession.ts`
- Modify: `apps/web/src/sessions/spectator/SpectatorSession.ts`
- Modify: `apps/web/src/app/App.tsx`
- Modify: `apps/web/src/app/App.test.tsx`
- Modify: `apps/web/src/sessions/spectator/SpectatorSession.test.ts`

- [ ] **Step 1: Write failing tests** proving that the lobby stream is disposed before `/control/spectate`, the validated spectator allocation is passed through `StartGameOptions`, no game provider is bootstrapped before a valid spectator ticket, ticket failure reopens the lobby stream, and old generations cannot update the current UI.
- [ ] **Step 2: Run the focused App and spectator tests** and confirm the current `SpectatorSession.start()` ordering fails the new assertions.
- [ ] **Step 3: Add one App/session transition coordinator** that owns the runtime bridge and serializes create/join/spectate/return-lobby transitions. Await actual provider disposal before rebinding the runtime to a new room.
- [ ] **Step 4: Inject the exact validated `PlayhtmlSpectatorAllocation`** into `StartGameOptions` and `SpectatorSession.start()`. The coordinator must dispose the lobby stream, call `OnlineLobbyGateway.getSpectatorTicket()`, validate `allocationId`, `room`, and `ticket`, then pass that allocation to the session. Reconnect may request a fresh ticket, but initial start must not request one internally.
- [ ] **Step 5: Make the coordinator the only runtime disposer** for App-managed sessions. `OnlineSession.dispose()` and `SpectatorSession.dispose()` close their game client and timers but do not dispose the injected shared runtime; isolated unit-test runtimes may still be disposed by their explicit owner. Test lobby-to-player, lobby-to-spectator, return-lobby, and ticket-failure paths for exactly one awaited runtime disposal.
- [ ] **Step 6: Change spectator startup ordering** to bootstrap the game room only after the validated allocation is present, then attach the read-only client. Keep server-side spectator authorization unchanged.
- [ ] **Step 7: Wire `App` to `OnlineLobbyStream`** while in the real lobby, replace the production hard-coded `unavailable` state with the adapter state, and preserve deterministic demo fixtures.
- [ ] **Step 8: Wire watch/return transitions** so only the coordinator calls shared `RuntimeBridge.dispose()`, including unmount, ticket failure, stale-generation cancellation, and return-lobby. Lobby stream disposal itself must not dispose the shared bridge independently.
- [ ] **Step 9: Run `rtk npm run test:web -- --run apps/web/src/app/App.test.tsx apps/web/src/sessions/spectator/SpectatorSession.test.ts apps/web/src/sessions/online/OnlineLobbyStream.test.ts`** and confirm ordering, read-only, demo parity, and accessibility behavior pass.

## Task 5: Add Real Runtime Coverage

**Files:**
- Modify: `tests/spectator-test-worker.test.js`
- Modify: `tests/worker-runtime.test.js`
- Modify: `tests/browser-worker-runtime.test.js`
- Modify: `apps/worker/wrangler.spectator-test.jsonc` only if required by the harness

- [ ] **Step 1: Add a real Worker test** using the dedicated spectator fixture for `/parties/lobby/ott-lobby-public` with spectator enabled, custom subscribe, current catalog response, and a later catalog fan-out. Do not run this path against the disabled normal `wrangler.jsonc --env test/demo` configurations.
- [ ] **Step 2: Add reconnect/resubscribe coverage** that proves a new lobby connection obtains the current snapshot even when the prior notification was lost.
- [ ] **Step 2a: Add stream-side retry coverage** with a fake connected client whose send fails, proving the stream schedules a bounded resend of the cached latest catalog; the Lobby notification path must also retry updating the stream cache.
- [ ] **Step 3: Add three-profile browser acceptance coverage** against the dedicated spectator fixture: A creates, B joins, C sees the active match, C watches read-only, and terminalization removes the match.
- [ ] **Step 4: Assert credential isolation**: no ticket, resume credential, internal secret, or player command appears in public catalog/stream messages; C cannot send `ott:move` or `ott:leave` successfully.
- [ ] **Step 5: Extend `tests/worker-runtime/fixture.js` with an explicit config selector**: normal tests use `apps/worker/wrangler.jsonc --env test/demo`; spectator tests use `apps/worker/wrangler.spectator-test.jsonc` without the normal env. Require an ignored local `.dev.vars` containing only non-production test values required by the fixture, and fail with a clear setup message when it is absent.
- [ ] **Step 6: Define the authenticated test probe contract** in `/__test/close` or an equivalent explicit endpoint: require `x-ott-test-probe-secret`, reject missing/wrong secrets with 404, close only the requested test connection, and add tests for authorized and unauthorized calls.
- [ ] **Step 7: Add explicit npm commands** that pass the spectator config selector to the fixture and run the dedicated Worker/browser tests; do not leave the existing normal commands silently pointing at disabled configs.
- [ ] **Step 8: Run the real runtime commands** with the dedicated spectator config and local-only secret setup. Record exact command, commit, Node/Wrangler/PlayHTML versions, host, and per-scenario result. Do not turn skipped tests into PASS claims.

## Task 6: Verify Existing Security And Lifecycle Gates

**Files:**
- Modify: `tests/server.test.js` only if a missing mixed-case assertion is discovered
- Modify: `tests/worker-runtime.test.js` or the dedicated runtime test only for evidence assertions
- Modify: `HANDOFF.md` only with observed evidence
- Modify: `docs/playhtml-upstream-lock.md` only with observed evidence

- [ ] **Step 1: Run request-level static denylist tests** for `/SERVER.JS`, package files, runtime/private paths, traversal, and mixed-case variants.
- [ ] **Step 2: Run direct-game-create and authenticated lobby-to-game routing tests** and confirm no forgeable marker, client relay, or process map bypass exists.
- [ ] **Step 3: Run supported hibernation/reconnect evidence separately** for both lobby stream and spectator game connection. Do not treat process restart, `ctx.abort()`, or code `1006` as hibernation evidence.
- [ ] **Step 3a: If supported hibernation evidence is unavailable**, stop with production spectator disabled and document the missing gate; do not infer production readiness from restart or deterministic tests.
- [ ] **Step 3b: Use the authenticated test-only connection probe** to create deterministic ordinary close/reconnect evidence. Record it separately from the still-required supported hibernation evidence.
- [ ] **Step 4: Run the complete existing two-player matrix** including valid/invalid move, reload/resume, disconnect grace/expiry, timeout, leave, token privacy, local/AI fallback, and static security.
- [ ] **Step 5: Update handoff/evidence documents** with only the scenarios actually run and their exact results.

## Task 7: Build And Deploy In Separate Checkpoints

**Files:**
- Modify: `DEPLOYMENT.md` only if commands or current status changed
- Do not modify production `wrangler.jsonc` to enable spectator until all rollout criteria pass

- [ ] **Step 1: Run full verification**: `rtk npm test`, `rtk npm run test:web`, `rtk npm run typecheck:web`, `rtk npx --no-install tsc -p apps/worker/tsconfig.json --noEmit`, `rtk npm run build:web`, and `rtk git diff --check`.
- [ ] **Step 2: Verify the production build** contains no actual `OTT_INTERNAL_SECRET` value, test secret value, or other deployed secret. Separately verify that public catalog/stream payloads contain no ticket or resume credential; field names and client ticket-handling code are allowed in the frontend bundle.
- [ ] **Step 3: For local/test rollout only**, run the spectator Worker config with `OTT_SPECTATOR_ENABLED=true` and build the frontend against the local Worker origin.
- [ ] **Step 4: For production only after evidence approval**, add `"OTT_SPECTATOR_ENABLED": "true"` to the top-level production `vars` in `apps/worker/wrangler.jsonc`, store `OTT_INTERNAL_SECRET` with `rtk npx --no-install wrangler secret put OTT_INTERNAL_SECRET --config apps/worker/wrangler.jsonc --env=""`, and deploy explicitly to the top-level environment with `rtk npx --no-install wrangler deploy --config apps/worker/wrangler.jsonc --env=""`. Do not copy the test config's secret value or test bindings into production.
- [ ] **Step 5: Build and deploy the frontend reproducibly** by setting `$env:VITE_OTT_PLAYHTML_HOST` and `$env:VITE_OTT_PLAYHTML_CONTROL_ENDPOINT` to the deployed Worker HTTPS origin, running `rtk npm run build:web`, then running `rtk vercel --version` and `rtk vercel deploy apps/web/dist --prod --yes --scope lap-trinh-mang --project ottv2`.
- [ ] **Step 6: Re-run three-profile acceptance against the deployed URLs** and record the result. A deploy alone is not production acceptance.

## Verification Commands

- `rtk npm run test:web`
- `rtk npm run typecheck:web`
- `rtk npm test`
- `rtk npm run build:web`
- `rtk git diff --check`
- `rtk npm run test:worker-runtime`
- `rtk npm run test:browser-worker-runtime`
- `rtk npx --no-install tsc -p apps/worker/tsconfig.json --noEmit`
- `rtk npx --no-install wrangler deploy --config apps/worker/wrangler.jsonc --env="" --dry-run`

## Stop Conditions

- Do not add HTTP polling or a raw browser WebSocket fallback.
- Do not enable production spectator if direct lobby-party runtime evidence, supported hibernation evidence, or three-profile acceptance is missing.
- Do not claim `PASS`, `production-ready`, or rollout completion from deterministic tests alone.
- If the installed PlayHTML runtime cannot support the required lobby/game lifecycle without overlapping providers, stop and return to architecture review instead of adding a second transport.
