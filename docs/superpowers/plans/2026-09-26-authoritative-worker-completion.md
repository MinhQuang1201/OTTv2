# Authoritative Worker Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the authoritative Cloudflare Worker path and gather the only evidence eligible to change online rollout status.

**Architecture:** Public PartyServer upgrades and trusted Lobby initialization resolve the same `Main` Game Durable Object by canonical lowercase room ID. Lobby owns allocation and owner-bound resume credentials; Game owns Room, attach ticket consumption and authoritative recipient projections. A reviewed browser YProvider runtime and two-context automation prove the same-connection boundary before manual acceptance/release documentation.

**Tech Stack:** Node 18+, Cloudflare Workers/Durable Objects, Wrangler 4.141.0, partyserver/y-partyserver, PlayHTML fork, Yjs, Playwright, node:test.

---

## File Map

| Path | Responsibility |
| --- | --- |
| `workers/wrangler.jsonc` | One `Main` Game DO binding; test-only environment config. |
| `workers/ott-worker.ts` | Canonical public route validation and control dispatch. |
| `workers/internal-auth.ts` | Canonical signed capability, single-use nonce verification, credential hashing/constant-time comparison helpers. |
| `workers/ott-lobby-server.ts` | Allocation lifecycle, owner-bound resume credential rotation, trusted Game requests and lifecycle receive endpoint. |
| `workers/ott-game-server.ts` | Game initialization, trusted B name update, attach nonce consumption, recipient projection and lifecycle notification. |
| `workers/room-storage.ts` | Seat-bound attach/resume adapters, alarm deadline metadata and deterministic test-time settings. |
| `workers/protocol.ts` | Canonical room validation and response shapes. |
| `vendor/playhtml-minimal/browser/**` | Pinned browser-loadable one-provider runtime and custom-message public API. |
| `playhtml-bootstrap.js` | Configure and await the real browser runtime exactly once. |
| `playhtml-game-client.js` | Preserve canonical room IDs and submit owner credential only to control resume. |
| `index.html`, `playhtml-game.html` | Load browser fork before bootstrap/client scripts. |
| `tests/worker-runtime/**` | Reusable Wrangler fixture and runtime behavioral suites. |
| `tests/worker-room-storage.test.js` | Deterministic Worker adapter/alarm regression tests. |
| `tests/browser-worker-runtime.test.js` | Playwright two-context same-connection tests. |
| `tests/partykit-*.test.js` | Remove only obsolete PartyKit transport assertions after Worker equivalents exist. |
| `docs/evidence/*.md` | Runtime and manual acceptance facts only. |
| `IMPLEMENTATION_STATUS.md`, `HANDOFF.md`, `README.md`, `CLAUDE.md`, `docs/playhtml-upstream-lock.md` | Evidence-backed final status. |

### Task 0: Close Static Source Exposure

**Files:**
- Modify: `server.js`
- Test: `tests/server.test.js`

- [ ] **Step 1: Write failing case-variant denylist test**

Probe `/SERVER.JS`, mixed-case `package.json`, `.env` variants, `workers/`, `tests/`, `node_modules/` and traversal encodings through the real static server. Assert each is denied while a public asset is served.

- [ ] **Step 2: Run test to verify failure**

Run: `node --test tests/server.test.js`

Expected: FAIL if any private Windows case variant is served.

- [ ] **Step 3: Implement minimal canonical denylist fix**

Normalize the decoded path segments and basename before denylist checks; preserve public asset serving and do not add game logic to static server.

- [ ] **Step 4: Run static-server test**

Run: `node --test tests/server.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server.js tests/server.test.js
git commit -m "fix: deny private static paths regardless of case"
```

### Task 1: Unify Game Durable Object Routing

**Files:**
- Modify: `workers/wrangler.jsonc`
- Modify: `workers/worker-configuration.d.ts`
- Modify: `workers/ott-worker.ts`
- Modify: `workers/ott-lobby-server.ts`
- Test: `tests/worker-entry.test.js`
- Test: `tests/worker-runtime.test.js`

- [ ] **Step 1: Write failing entry test for one `Main` binding and canonical room route**

Assert no `OTT_GAME` binding remains; assert Lobby resolves `env.Main.idFromName(roomId)` and public route only accepts lowercase `ott-<uuid>`.

- [ ] **Step 2: Run focused test to verify it fails**

Run: `node --test tests/worker-entry.test.js`

Expected: FAIL because `OTT_GAME` remains and Lobby uses allocation ID.

- [ ] **Step 3: Write failing Worker routing assertion for initialized room identity**

Use a real local control create plus a dedicated test-only authenticated probe to prove public PartyServer routing and Lobby initialization resolve the identical `env.Main.idFromName(roomId)` DO identity. Do not attempt browser attach before Task 7.

- [ ] **Step 4: Run runtime test to verify it fails at attach**

Run: `npm run test:worker-runtime`

Expected: FAIL because public route and Lobby currently resolve different bindings/names.

- [ ] **Step 5: Implement minimal unified routing**

Keep `Main: OttGameServer`; remove `OTT_GAME`. Make Lobby call `env.Main.get(env.Main.idFromName(allocation.roomId))`. Reject non-canonical public party route names before `routePartykitRequest`.

- [ ] **Step 6: Run focused and runtime tests**

Run: `node --test tests/worker-entry.test.js && npm run test:worker-runtime`

Expected: entry test passes; runtime reaches attach scenario.

- [ ] **Step 7: Commit**

```bash
git add workers/wrangler.jsonc workers/worker-configuration.d.ts workers/ott-worker.ts workers/ott-lobby-server.ts tests/worker-entry.test.js tests/worker-runtime.test.js
git commit -m "fix: route public ott rooms to initialized game objects"
```

### Task 2: Harden Initialization And Attach Capabilities

**Files:**
- Modify: `workers/internal-auth.ts`
- Modify: `workers/ott-game-server.ts`
- Modify: `workers/ott-lobby-server.ts`
- Test: `tests/ott-authority.test.js`
- Test: `tests/worker-runtime.test.js`

- [ ] **Step 1: Write failing behavioral tests for capability decode and replay**

Test canonical array encoding round-trips; test initialization capability replay and create/join/resume attach-ticket replay all fail without mutation.

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/ott-authority.test.js tests/worker-runtime.test.js`

Expected: FAIL because only some nonce paths are consumed and runtime attach is absent.

- [ ] **Step 3: Implement one transactional capability verifier**

Keep canonical array serialization. Verify version, allocation, room, purpose, seat, expiry, nonce and lifecycle revision where applicable. Use a DO storage transaction to consume nonce and perform the guarded mutation together. Add parallel-request tests proving only one initialize, attach, seat-update and lifecycle request can mutate. Do not log tokens or signature material.

- [ ] **Step 4: Make initialization idempotent and rollback safe**

Lobby stores `initializing` allocation hidden from `list` and `join`, including the server-derived creator-attach deadline, invokes Game, then commits `waiting`. Game transactionally persists an initialization receipt bound to allocation, canonical room and immutable initialization-payload hash. Retry returns the prior result only for that exact receipt; conflicting/replayed data fails. Test failures before/after persistence and concurrent retries. On failure, delete/terminalize the Lobby allocation.

- [ ] **Step 5: Run focused authority tests**

Run: `node --test tests/ott-authority.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add workers/internal-auth.ts workers/ott-game-server.ts workers/ott-lobby-server.ts tests/ott-authority.test.js tests/worker-runtime.test.js
git commit -m "fix: make ott authority capabilities single-use"
```

### Task 3: Add Owner-Bound Resume Credentials

**Files:**
- Modify: `workers/internal-auth.ts`
- Modify: `workers/ott-lobby-server.ts`
- Modify: `workers/ott-game-server.ts`
- Modify: `workers/room-storage.ts`
- Modify: `playhtml-game-client.js`
- Test: `tests/ott-authority.test.js`
- Test: `tests/playhtml-game-client.test.js`
- Test: `tests/worker-runtime.test.js`

- [ ] **Step 1: Write failing tests for resume ownership and rotation**

Create A and B. Assert resume without credential, with B credential for A, and with a used credential all fail. Assert valid owner resume returns a fresh attach ticket plus replacement credential, and never exposes either in public list/state.

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/ott-authority.test.js tests/playhtml-game-client.test.js`

Expected: FAIL because request accepts caller-selected seat.

- [ ] **Step 3: Implement opaque credential storage**

Generate high-entropy credential bytes; store a salted/hash representation keyed by allocation/seat. Compare in constant time where Worker APIs permit. In one Lobby storage transaction verify the old per-seat hash, replace it, issue/store the one-time ticket record, and return the replacement credential. `/control/resume` accepts `allocationId` and `resumeCredential`, never `seat`. Test concurrent double-resume: exactly one succeeds and only its replacement works. Delete hashes/salts/tickets on terminal/expiry and redact them from every non-owner response, lifecycle request and log.

- [ ] **Step 4: Make Game resume authenticated-seat based**

Attach capability selects the seat. `DurableRoomAdapter.attach` resumes that seat using its private stored `Room` resume token; it never passes an attach ticket to `Room.resumePlayer`.

- [ ] **Step 5: Update browser client storage/control request**

Preserve canonical room ID. Persist only the owner credential/ticket needed for reconnect. Send owner credential only to HTTPS resume control route and rotate local storage from the response.

- [ ] **Step 6: Run tests**

Run: `node --test tests/ott-authority.test.js tests/playhtml-game-client.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add workers/internal-auth.ts workers/ott-lobby-server.ts workers/ott-game-server.ts workers/room-storage.ts playhtml-game-client.js tests/ott-authority.test.js tests/playhtml-game-client.test.js tests/worker-runtime.test.js
git commit -m "fix: bind ott resume credentials to allocated seats"
```

### Task 4: Trusted Names, Recipient Projection, And Lifecycle

**Files:**
- Modify: `workers/internal-auth.ts`
- Modify: `workers/ott-lobby-server.ts`
- Modify: `workers/ott-game-server.ts`
- Modify: `workers/room-storage.ts`
- Test: `tests/ott-game-room.test.js`
- Test: `tests/worker-runtime.test.js`

- [ ] **Step 1: Write failing Game behavioral tests**

Assert trusted initialization stores A name; signed `seat-update` stores B name; browser attach cannot choose names; A and B receive projections with their own `you` seat; neither projection contains credentials.

- [ ] **Step 2: Run test to verify failure**

Run: `node --test tests/ott-game-room.test.js`

Expected: FAIL because adapter defaults to `Khách` and broadcasts a shared payload.

- [ ] **Step 3: Implement signed B seat update and join reservation**

Lobby transactionally reserves B as `joining`, sends a signed single-use `seat-update` through `env.Main`, then commits `playing` only after Game durably accepts the sanitized B name. Define rollback/idempotent recovery for request failure and test join/attach races.

- [ ] **Step 4: Implement recipient projections**

Build OTT state from `Room.payload()` plus recipient seat. Send only each recipient’s projection on attach/broadcast. Do not include Room resume token, attach ticket, resume credential, capability or internal state.

- [ ] **Step 5: Define lifecycle schema, then write failing lifecycle tests**

Extend canonical capability claims for `seat-update` and `lifecycle`. Define source transitions, terminal states, creator-never-attach versus waiting-disconnect expiry, monotonic revision allocation, and duplicate/stale/future revision outcomes. Then assert `initializing` is hidden; valid HMAC wrong purpose/allocation/room/seat/revision cannot mutate; stale update cannot revive allocation; waiting list/join is removed after expiry.

- [ ] **Step 6: Implement lifecycle request/receiver**

Game sends signed `lifecycle` request to Lobby after relevant persisted transition. Lobby consumes capability, applies only a newer revision, removes non-joinable waiting allocations, and remains idempotent on duplicate notifications.

- [ ] **Step 7: Run tests**

Run: `node --test tests/ott-game-room.test.js tests/ott-authority.test.js`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add workers/internal-auth.ts workers/ott-lobby-server.ts workers/ott-game-server.ts workers/room-storage.ts tests/ott-game-room.test.js tests/ott-authority.test.js tests/worker-runtime.test.js
git commit -m "feat: synchronize authoritative ott room lifecycle"
```

### Task 5: Durable Deadline Test Controls

**Files:**
- Modify: `workers/wrangler.jsonc`
- Modify: `workers/worker-configuration.d.ts`
- Modify: `workers/ott-game-server.ts`
- Modify: `workers/room-storage.ts`
- Test: `tests/worker-room-storage.test.js`
- Test: `tests/worker-runtime.test.js`

- [ ] **Step 1: Write failing deterministic adapter tests**

Test creator-never-attaches deadline, waiting disconnect deadline, earliest alarm selection, stale alarm idempotence, timeout, terminal alarm removal and hydration reconciliation with a fake DO storage/controlled clock.

- [ ] **Step 2: Run test to verify failure**

Run: `node --test tests/worker-room-storage.test.js`

Expected: FAIL because no attach deadline/test clock settings exist.

- [ ] **Step 3: Implement test-only Worker settings**

Use a non-production Wrangler environment binding for short clock, reconnect and creator-attach durations. Do not accept durations in browser/control payloads. Game and adapter derive time only from server-owned settings.

- [ ] **Step 4: Implement deadline persistence and lifecycle notification**

Use the creator deadline persisted at Task 2 initialization. Schedule earliest alarm; terminalize/unlist expired allocation exactly once; after restart, rebuild/schedule the same deadline without extending it or duplicating lifecycle notifications.

- [ ] **Step 5: Run deterministic tests**

Run: `node --test tests/worker-room-storage.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add workers/wrangler.jsonc workers/worker-configuration.d.ts workers/ott-game-server.ts workers/room-storage.ts tests/worker-room-storage.test.js tests/worker-runtime.test.js
git commit -m "feat: make ott durable deadlines testable"
```

### Task 6: Build The Browser-Loadable Minimal Fork

**Files:**
- Create: `vendor/playhtml-minimal/browser/runtime.js`
- Create: `vendor/playhtml-minimal/browser/runtime.d.ts`
- Modify: `vendor/playhtml-minimal/browser/index.js`
- Modify: `vendor/playhtml-minimal/browser/index.d.ts`
- Modify: `vendor/playhtml-minimal/NOTICE.md`
- Modify: `playhtml-bootstrap.js`
- Modify: `index.html`
- Modify: `playhtml-game.html`
- Modify: `package.json`
- Test: `tests/playhtml-custom-channel.test.js`
- Test: `tests/playhtml-bootstrap.test.js`

- [ ] **Step 1: Perform an extension-point spike before implementation**

Inspect and identify exact pinned browser/Worker source files and tested `__YPS:` framing/order. Create a real-YProvider local spike using only reviewed source. Record source identities, SHA, licenses, command and result in `docs/playhtml-upstream-lock.md`. If this fails, stop browser implementation, preserve BLOCKED and do not guess an API.

- [ ] **Step 1a: Apply the PlayHTML technical gate**

Only if the spike has direct fork/browser-to-Worker connection evidence and
`docs/playhtml-upstream-lock.md` records the technical gate PASS may Steps 2-8
vendor, load or register a browser factory. If it is FAIL or NOT RUN, retain
online unavailable behavior, record the evidence, and skip directly to the
release documentation task with Online BLOCKED.

- [ ] **Step 2: Write failing browser runtime contract tests**

Test a browser-loadable runtime configures one provider, blocks channel use before `ready`, exposes string-only send/subscribe after ready, and does not construct presence/cursor/awareness/PartySocket transports.

- [ ] **Step 3: Run tests to verify failure**

Run: `node --test tests/playhtml-custom-channel.test.js tests/playhtml-bootstrap.test.js`

Expected: FAIL because current adapter requires an injected fake provider and no page-loadable runtime exists.

- [ ] **Step 4: Vendor/build the reviewed browser runtime**

Copy only source required from the pinned PlayHTML/YProvider revision. Record every copied origin, SHA and license in NOTICE. Do not import worker code or private raw socket APIs. The runtime configures one provider and exposes only the public channel.

- [ ] **Step 5: Load runtime in HTML before bootstrap**

Ensure pages load browser runtime, then bootstrap, then game client/UI. Bootstrap calls configure/init once, awaits ready, and registers factory once.

- [ ] **Step 6: Define provider room lifecycle and preserve canonical room ID**

Remove client room uppercasing and reject non-canonical room input at boundaries. A different allocated room requires an explicit page reload/navigation before provider configuration; never silently reuse the first provider for another room. Test leave then new allocation requires reload and cannot send on the prior room.

- [ ] **Step 7: Run browser seam tests**

Run: `node --test tests/playhtml-custom-channel.test.js tests/playhtml-bootstrap.test.js tests/playhtml-game-client.test.js`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add vendor/playhtml-minimal playhtml-bootstrap.js playhtml-game-client.js index.html playhtml-game.html package.json tests/playhtml-custom-channel.test.js tests/playhtml-bootstrap.test.js tests/playhtml-game-client.test.js
git commit -m "feat: load verified playhtml ott browser runtime"
```

### Task 7: Add Two-Context Browser Runtime Harness

**Files:**
- Modify: `package.json`
- Create: `tests/worker-runtime/fixture.js`
- Create: `tests/browser-worker-runtime.test.js`
- Modify: `tests/worker-runtime.test.js`
- Modify: `.gitignore`

- [ ] **Step 1: Write failing Playwright runtime smoke**

Start Wrangler with unique persistence. Create two isolated contexts. A creates, B joins, both load the real browser page, configure allocated room and wait for `playhtml.ready`.

- [ ] **Step 2: Run test to verify failure**

Run: `npm run test:browser-worker-runtime`

Expected: FAIL because Playwright dependency/script and actual page runtime are absent.

- [ ] **Step 3: Add pinned browser automation dependency and script**

Add exact Playwright version and a dedicated test script. Document browser-install command without committing browser cache or secrets.

- [ ] **Step 4: Extract restart-capable Worker fixture**

Fixture must: allocate a free port, use explicit ignored `.dev.vars`, capture bounded logs, wait by HTTP, stop process tree, preserve `persistTo` across `restart()`, and delete it only final teardown.

- [ ] **Step 5: Instrument connections**

Install `addInitScript` before navigation to wrap `WebSocket`, then collect CDP/network WebSocket events and every browser request/response. Assert the endpoint is exactly the allocated canonical `/parties/main/ott-<uuid>` room, one expected provider connection per context (excluding documented reconnect retry only), and no browser-controlled room bypass, PartySocket/presence/cursor/awareness/polling connection or recurring HTTP request pattern.

- [ ] **Step 6: Implement first green browser smoke**

Assert both pages become ready, initial Yjs sync completes, and A/B attach through the custom channel reaches the initialized Game DO.

- [ ] **Step 7: Run browser smoke**

Run: `npm run test:browser-worker-runtime`

Expected: PASS for smoke; preserve artifacts/logs only on failure and redact credentials.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json .gitignore tests/worker-runtime/fixture.js tests/browser-worker-runtime.test.js tests/worker-runtime.test.js
git commit -m "test: run ott worker through two browser contexts"
```

### Task 8: Complete Worker And Browser Runtime Matrix

**Files:**
- Modify: `tests/browser-worker-runtime.test.js`
- Modify: `tests/worker-runtime.test.js`
- Modify: `tests/worker-runtime/fixture.js`
- Test: `tests/server.test.js`

- [ ] **Step 1: Write failing same-connection/Yjs discard test**

Use the reviewed fork-level test hook identified by Task 6 spike to apply and observe a real Yjs update without enabling page data, elements, presence, cursor or a second transport. Before attach, mutate A and assert B never sees it. Attach A, mutate again, assert B still never sees it. Restart Worker with same persistence and assert neither mutation survives. If no reviewed hook exists, keep this gate BLOCKED rather than inventing browser API.

- [ ] **Step 2: Run test to verify failure**

Run: `npm run test:browser-worker-runtime -- --test-name-pattern="Yjs"

Expected: FAIL until actual read-only behavior is proven.

- [ ] **Step 3: Write failing game command tests**

Exercise pre-attach command rejection, valid canonical opening, invalid move no revision change, ordering for both recipients, 40ms rate limit, 8KB rejection and explicit leave terminalization.

- [ ] **Step 3a: Run command tests to verify RED**

Run: `npm run test:browser-worker-runtime -- --test-name-pattern="command|move|leave"`

Expected: FAIL before any transport/projection/persistence fix required by these scenarios.

- [ ] **Step 4: Implement only fixes exposed by these tests**

Keep all rule decisions in `Room`; fix Worker/adapter transport, projection or persistence boundaries only.

- [ ] **Step 5: Write failing authority/lifecycle runtime tests**

Copy every browser-visible field to direct Game initialize and assert rejection/no mutation. Test wrong-room, expired and replay tickets. Test disconnect/resume, replayed credential rejection, reconnect expiry, clock timeout, restart/hydration, creator-never-attach expiry, waiting disconnect expiry and Lobby cleanup.

- [ ] **Step 5a: Run authority/lifecycle tests to verify RED**

Run: `npm run test:browser-worker-runtime -- --test-name-pattern="authority|lifecycle|resume|expiry|hydration"`

Expected: FAIL before an implementation change required by each added scenario.

- [ ] **Step 5b: Add client session-boundary regressions**

Test stored resume state plus explicit create/join cannot race; leave then reload/new allocation then unexpected close resumes only the new session; inbound state is accepted only after correlated attach and cannot select/switch room; malformed/envelope-less/foreign responses are ignored.

- [ ] **Step 5c: Run client session tests to verify RED**

Run: `node --test tests/playhtml-game-client.test.js`

Expected: FAIL before client session-boundary fixes.

- [ ] **Step 6: Implement only fixes exposed by these tests**

Use trusted requests, server-owned clock settings and DO alarms; never add browser relay/fallback.

- [ ] **Step 7: Add redaction and static-server verification**

Assert request URLs, headers and bodies; WebSocket/custom-message payloads; Yjs updates; browser console logs; Worker logs; public lists; and recipient projections omit credentials/capabilities/secrets. Run `tests/server.test.js` for lower/mixed/upper private paths as a separate static fixture.

- [ ] **Step 7a: Run redaction tests to verify RED**

Run: `npm run test:browser-worker-runtime -- --test-name-pattern="redaction|secret|credential"`

Expected: FAIL before any response/logging fix required by a newly added assertion.

- [ ] **Step 8: Run full runtime matrix**

Run: `npm run test:worker-runtime && npm run test:browser-worker-runtime && node --test tests/server.test.js`

Expected: PASS with no skipped Task 8 scenario.

- [ ] **Step 9: Record automated evidence**

Create `docs/evidence/2026-09-26-ott-worker-runtime.md` with command, host, Node/Wrangler/PlayHTML/browser versions, revision, exact scenario matrix and only observed PASS/FAIL/NOT RUN values.

- [ ] **Step 10: Commit**

```bash
git add tests docs/evidence/2026-09-26-ott-worker-runtime.md workers
git commit -m "test: verify authoritative ott worker runtime"
```

### Task 9: Migrate Legacy PartyKit Coverage

**Files:**
- Modify: `tests/partykit-room.test.js`
- Modify: `tests/partykit-runtime.test.js`
- Modify: `tests/no-legacy-online-transport.test.js`
- Modify: `package.json`

- [ ] **Step 1: List each obsolete PartyKit assertion beside its Worker replacement**

Document in test comments or migration manifest: direct create/join event, `ott:gameover`, PartyKit `onStart` and named socket assumptions are removed only when Task 4/5/8 tests cover their invariant.

- [ ] **Step 2: Remove obsolete legacy transport tests only after mapping**

For every removed assertion, record exact replacement file and test name from Tasks 3-5/8. Do not skip security tests; move them to Worker runtime suite.

- [ ] **Step 3: Run full deterministic suite**

Run: `npm test`

Expected: PASS, no legacy failures hidden by skip.

- [ ] **Step 4: Commit**

```bash
git add tests package.json
git commit -m "test: migrate legacy partykit authority coverage"
```

### Task 10: Manual Acceptance And Release Decision

**Files:**
- Create: `docs/evidence/2026-09-26-ott-two-profile-acceptance.md`
- Modify: `IMPLEMENTATION_STATUS.md`
- Modify: `HANDOFF.md`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/playhtml-upstream-lock.md`
- Modify: `LUNA_IMPLEMENTATION_REPORT.md`

- [ ] **Step 1: Prepare two isolated browser profiles**

Use separate browser contexts/profiles with independent cookies/session/local storage. Record browser versions, Worker host and Worker revision.

- [ ] **Step 2: Execute each acceptance scenario manually**

Record create/list/join, legal/invalid move, practical goal/no-moves/extinction, timeout, leave, reload/resume, reconnect expiry, creator/waiting expiry, credential isolation, one-connection DevTools evidence and Local/AI fallback. Record unrun scenarios as NOT RUN.

- [ ] **Step 3: Inspect DevTools network and shared state**

Record one YProvider connection only; no PartySocket/raw socket/polling/second session. Verify credentials/secrets/capabilities/seat authority/authoritative clock/winner do not enter shared data/presence/page data/public list.

- [ ] **Step 4: Write manual evidence**

Create the dated acceptance document with reproducible steps and observed PASS/FAIL/NOT RUN values only.

- [ ] **Step 5: Run final automated verification**

Run: `npm test`

Run: `npm run test:worker-runtime`

Run: `npm run test:browser-worker-runtime`

Run: `node --test tests/server.test.js`

Run: `npx --yes wrangler@4.141.0 deploy --config workers/wrangler.jsonc --dry-run`

Run: `node --check server.js room.js game.js playhtml-bootstrap.js playhtml-game-client.js`

Run: `npx tsc --noEmit -p workers/tsconfig.json`

Run: `git diff --check`

Expected: each command exits 0; otherwise retain BLOCKED and record actual result.

- [ ] **Step 6: Update release documents from evidence**

Update source pin/manifest, command/version/date/revision facts and every gate state. Only direct fork/connection evidence may change the technical Task 5 state in `docs/playhtml-upstream-lock.md`; unit, source-shape, bridge-double or static-runtime results cannot do so. Do not mark production ready if any test/evidence/manual scenario remains failing or NOT RUN.

- [ ] **Step 7: Commit**

```bash
git add docs IMPLEMENTATION_STATUS.md HANDOFF.md README.md CLAUDE.md LUNA_IMPLEMENTATION_REPORT.md
git commit -m "docs: record authoritative ott rollout evidence"
```
