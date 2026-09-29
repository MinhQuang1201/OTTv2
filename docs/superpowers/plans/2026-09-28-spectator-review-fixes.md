# Spectator Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the remaining spectator/runtime authority defects found in review while leaving worker-test and harness failures unchanged.

**Architecture:** Preserve the existing single PlayHTML provider and authoritative Worker boundaries. Repair persistence projections, best-effort spectator fan-out, session cancellation/read-only contracts, and durable cleanup scheduling with focused regression tests.

**Tech Stack:** TypeScript, JavaScript Durable Objects, Vitest, Node test runner.

---

### Task 1: Repair hydrated payload projection

**Files:**
- Modify: `apps/worker/src/persistence/room-storage.ts`
- Test: `tests/worker-room-storage.test.js`, `tests/ott-authority.test.js`

- [ ] Add a regression test proving hydration reconciliation updates `lastPayload` revision/connectivity before a subsequent public projection.
- [ ] Run the focused test and observe the stale-payload failure.
- [ ] Refresh `lastPayload` after reconciliation and persistence.
- [ ] Run the focused storage and authority tests.

### Task 2: Make spectator admission resilient to stale sockets

**Files:**
- Modify: `apps/worker/src/game/ott-game-server.ts`
- Test: `tests/ott-authority.test.js`

- [ ] Add a regression test with one failing existing connection and one new spectator.
- [ ] Run the test and observe admission/summary failure.
- [ ] Send the new spectator projection independently, broadcast other recipients best-effort, and always attempt summary publication.
- [ ] Run the focused authority tests.

### Task 3: Enforce session disposal and spectator read-only behavior

**Files:**
- Modify: `apps/web/src/sessions/online/OnlineSession.ts`
- Modify: `apps/web/src/sessions/demo/DemoSession.ts`
- Modify: `apps/web/src/sessions/demo/scenarios.ts`
- Test: `apps/web/src/sessions/online/OnlineSession.test.ts`, `apps/web/src/sessions/demo/DemoSession.test.ts`

- [ ] Add tests for disposal during an in-flight allocation and direct spectator move attempts.
- [ ] Run the tests and observe the failures.
- [ ] Add disposed checks after asynchronous allocation and attach boundaries.
- [ ] Remove spectator fixture moves and guard demo moves by `canMove`.
- [ ] Run the focused web tests.

### Task 4: Repair spectator reconnect state and cleanup alarms

**Files:**
- Modify: `apps/web/src/sessions/spectator/SpectatorSession.ts`
- Modify: `apps/worker/src/persistence/room-storage.ts`
- Modify: `apps/worker/src/game/ott-game-server.ts`
- Test: `apps/web/src/sessions/spectator/SpectatorSession.test.ts`, `tests/ott-authority.test.js`, `tests/worker-room-storage.test.js`

- [ ] Add a reconnect recovery test and a nonce alarm scheduling test.
- [ ] Run them and observe failures.
- [ ] Clear transient session error state after successful reattach.
- [ ] Include nonce expiry in the shared earliest alarm and reschedule after purge.
- [ ] Run focused tests.

### Task 5: Bound lobby cleanup and authenticated disconnect effects

**Files:**
- Modify: `apps/worker/src/lobby/ott-lobby-server.ts`
- Modify: `apps/worker/src/game/ott-game-server.ts`
- Test: `tests/ott-lobby.test.js`, `tests/ott-authority.test.js`

- [ ] Add tests for rate-limit key cleanup and unauthenticated close behavior.
- [ ] Run the tests and observe failures.
- [ ] Add an alarm-based TTL sweep for rate-limit keys.
- [ ] Restrict close-time projection updates to authenticated spectators.
- [ ] Run focused tests.

### Task 6: Verify the supported scope

- [ ] Run `rtk npm run test:web`.
- [ ] Run `rtk npm run typecheck:web`.
- [ ] Run `rtk npx tsc -p apps/worker/tsconfig.json --noEmit`.
- [ ] Run `rtk npm run build:web`.
- [ ] Run selected Node authority, lobby, storage, bridge, and spectator tests, excluding worker-test/harness.
- [ ] Run `rtk git diff --check` and report the intentionally excluded harness failures.
