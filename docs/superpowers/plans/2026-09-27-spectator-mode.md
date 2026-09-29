# Spectator Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an anonymous, read-only spectator experience for active online games, including deterministic demos, authoritative access control, real-time viewer counts, reconnection, and neutral game UI.

**Architecture:** Keep `Room` strictly A/B-only. Add explicit viewer identity and capabilities at the protocol, Game Durable Object, session, and UI boundaries; spectators use the same approved provider channel and Game DO as players. Build demo/UI slices first, then authority, presence, lobby publication, and browser acceptance; keep the server-side spectator flag off unless the hibernation and single-provider lifecycle gates pass with direct runtime evidence.

**Tech Stack:** TypeScript, React 18, Vitest/Testing Library, Node `node:test`, Cloudflare Workers/Durable Objects, PartyServer/YServer, YProvider/PlayHTML runtime bridge, Wrangler, Playwright.

---

## Source Of Truth And Safety Rules

- Read `docs/superpowers/specs/2026-09-27-spectator-mode-design.md` before starting.
- Read `docs/PLAYHTML_AI_GUIDE.md` and `docs/playhtml-upstream-lock.md` before any runtime/provider change.
- Use @test-driven-development for every behavior change and @systematic-debugging for every unexpected failure.
- Run @verification-before-completion before each commit and before changing any rollout/evidence statement.
- Do not modify `packages/game-core/src/room.js` or `packages/game-core/src/rules.js` for spectator behavior.
- Do not add polling, raw `WebSocket`, `PartySocket`, a second concurrent PlayHTML/YProvider session, a fake production factory, persisted authoritative viewer counts, or a spectator seat.
- A failed runtime evidence gate is a valid outcome: record it, retain demo/UI code if passing, and keep `OTT_SPECTATOR_ENABLED` off.
- Do not edit legacy `partykit/` protocol/runtime as the production implementation.
- Do not mark online or spectator mode production-ready from unit tests, fixtures, bridge mocks, or local deterministic demos.

## File Structure

### Create

- `apps/web/src/features/spectator/PublicMatchList.tsx`: render active public matches and emit watch intent.
- `apps/web/src/features/spectator/PublicMatchList.test.tsx`: public-list behavior and accessibility.
- `apps/web/src/sessions/spectator/SpectatorSession.ts`: read-only attach, state ordering, clock display, reconnect, and disposal.
- `apps/web/src/sessions/spectator/SpectatorSession.test.ts`: session contract, reconnect, malformed state, and no-write coverage.
- `apps/worker/src/lobby/ott-lobby-stream-server.ts`: read-only YServer that sends active-match summaries over the approved provider channel while the app is in the lobby.
- `apps/worker/wrangler.spectator-test.jsonc`: acceptance-only Worker config using test entry/classes plus real Lobby and Lobby-stream bindings; never deployed as production.

### Modify

- `apps/web/src/shared/model/game.ts`: viewer identity/capabilities, spectator count, public match type, and demo keys.
- `apps/web/src/sessions/contract.ts`: spectator start option and exported types.
- `apps/web/src/sessions/demo/{fixtureBuilders.ts,scenarios.ts,DemoSession.ts,DemoSession.test.ts}`: network-free spectator fixtures.
- `apps/web/src/features/game/{useBoardSelection.ts,Board.test.tsx,GameScreen.tsx,GameScreen.test.tsx,GameTopBar.tsx,TurnStatus.tsx,PlayerPanel.tsx,game.module.css}`: capability-driven shared read-only presentation.
- `apps/web/src/features/lobby/{LobbyScreen.tsx,OnlineRoomPanel.tsx,OnlineRoomPanel.test.tsx,lobby.module.css}`: separate active-match section.
- `apps/web/src/app/{App.tsx,App.test.tsx}`: discovery/session transitions and demo network isolation.
- `packages/protocol/src/index.ts`: strict `ott:spectate` command and viewer projection contracts.
- `apps/worker/src/auth/internal-auth.ts`: a separate seatless spectator capability variant.
- `apps/worker/src/persistence/room-storage.ts`: pure role-aware public projection; Room persistence remains unchanged.
- `apps/worker/src/game/ott-game-server.ts`: immutable connection roles, spectator authorization, fan-out, presence, and close handling.
- `apps/worker/src/lobby/ott-lobby-server.ts`: active discovery, spectator tickets, authenticated summary updates, feature flag.
- `apps/worker/src/lobby/ott-lobby-stream-server.ts`: public lobby subscription, initial resync, and update fan-out; no client-written shared state.
- `apps/worker/src/entry/ott-worker.ts`: spectator control route and any proven lobby provider route.
- `apps/worker/{worker-configuration.d.ts,wrangler.jsonc,wrangler.test.jsonc}`: disabled-by-default flag and test-only bindings.
- `packages/game-client/src/playhtml-game-client.js`: minimal spectator client surface only if shared framing cannot remain below the session.
- `vendor/playhtml-minimal/browser/runtime-entry.js`, `packages/game-client/src/playhtml-bootstrap.js`, `apps/web/src/sessions/online/runtimeBridge.ts`: reset/rebind lifecycle proven by tests.
- `vendor/playhtml-minimal/browser/{index.js,index.d.ts,runtime.d.ts}`: provider status surface and lifecycle declarations.
- `apps/web/src/sessions/online/{globals.d.ts,OnlineLobbyGateway.ts,OnlineLobbyGateway.test.ts}`: active-list and spectator-ticket contracts.
- `tests/{ott-playhtml-bridge.test.js,ott-authority.test.js,ott-game-room.test.js,worker-test-harness-runtime.test.js,worker-runtime.test.js,browser-worker-runtime.test.js,no-legacy-online-transport.test.js}`: authority and runtime evidence.
- `tests/playhtml-bootstrap.test.js`: bootstrap ownership, cleanup, and rebinding.
- `tests/worker-runtime/fixture.js`: restart/hibernation and multi-client support.
- `README.md`, `CONFIG.md`, `docs/playhtml-upstream-lock.md`: only verified behavior and evidence.

Avoid creating one file per type or helper. Extract a Worker presence/projection module only if `ott-game-server.ts` becomes difficult to understand after the minimal implementation.

### Task 1: Explicit Viewer Contracts And Safe Defaults

**Files:**
- Modify: `apps/web/src/shared/model/game.ts`
- Modify: `apps/web/src/sessions/contract.ts`
- Modify: `apps/web/src/sessions/demo/fixtureBuilders.ts`
- Modify: `apps/web/src/sessions/core/normalizeCoreState.ts`
- Modify: `apps/web/src/sessions/online/normalizeOnlineState.ts`
- Modify: `apps/web/src/sessions/local/LocalSession.ts`
- Modify: `apps/web/src/sessions/ai/AiSession.ts`
- Modify: `apps/web/src/sessions/online/OnlineSession.ts`
- Modify: `apps/web/src/sessions/{contract.test.ts,local/LocalSession.test.ts,ai/AiSession.test.ts,online/OnlineSession.test.ts}`

- [ ] **Step 1: Write failing contract tests**

Add assertions that every snapshot has explicit viewer data and capabilities:

```ts
expect(snapshot.viewer).toEqual({ role: "player", seat: "A" });
expect(snapshot.capabilities).toEqual({
  canMove: true,
  canLeaveGame: false,
  canSpectate: false,
});
expect(snapshot.spectatorCount).toBe(0);
```

Add type-level fixtures for:

```ts
type ViewerIdentity =
  | { readonly role: "player"; readonly seat: Seat }
  | { readonly role: "spectator" };

interface ViewerCapabilities {
  readonly canMove: boolean;
  readonly canLeaveGame: boolean;
  readonly canSpectate: boolean;
}

interface PublicMatchView {
  readonly allocationId: string;
  readonly roomId: string;
  readonly status: "playing";
  readonly players: Readonly<Record<Seat, Pick<PlayerView, "seat" | "name" | "connected" | "remainingMs">>>;
  readonly spectatorCount: number;
  readonly serverNow: number;
  readonly runningSeat: Seat | null;
}
```

Add one named carrier to `GameSnapshot` for deterministic lobby fixtures:

```ts
readonly publicMatches?: readonly PublicMatchView[];
```

Production lobby state may wrap this array in a loading/error discriminant, but
there is only one public match item contract.

- [ ] **Step 2: Run targeted tests and verify RED**

Run: `rtk npm run test:web -- src/sessions/contract.test.ts src/sessions/local/LocalSession.test.ts src/sessions/ai/AiSession.test.ts src/sessions/online/OnlineSession.test.ts`

Run: `rtk npm run typecheck:web`

Expected: FAIL because `viewer`, `capabilities`, `spectatorCount`, and spectator start contracts do not exist.

- [ ] **Step 3: Implement the minimal model**

Add the types above, add `mode: "spectator"` to `SessionMode`, and add this start option:

```ts
| { readonly mode: "spectator"; readonly allocationId: string; readonly roomId: string }
```

Define `viewer: ViewerIdentity | null`; idle, preparing, lobby, and pre-allocation/error snapshots use `viewer: null`, `viewerSeat: null`, and all-false capabilities. Keep `viewerSeat` temporarily as the rendering compatibility field. Update every snapshot producer and normalizer listed above. Define capabilities explicitly for local player (`true,false,false`), AI player (`true,false,false`), online player (`true,true,false`), and spectator (`false,false,true`); the existing phase/turn/connection checks remain additional gates. Demo/lobby snapshots cannot move. Board/UI guards require `snapshot.viewer?.role === "player"` before reading `seat`.

- [ ] **Step 4: Run targeted tests and typecheck**

Run: `rtk npm run test:web -- src/sessions/contract.test.ts src/sessions/local/LocalSession.test.ts src/sessions/ai/AiSession.test.ts src/sessions/online/OnlineSession.test.ts`

Run: `rtk npm run typecheck:web`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/web/src/shared/model/game.ts apps/web/src/sessions/contract.ts apps/web/src/sessions/contract.test.ts apps/web/src/sessions/demo/fixtureBuilders.ts apps/web/src/sessions/core/normalizeCoreState.ts apps/web/src/sessions/online/normalizeOnlineState.ts apps/web/src/sessions/local/LocalSession.ts apps/web/src/sessions/ai/AiSession.ts apps/web/src/sessions/online/OnlineSession.ts apps/web/src/sessions/local/LocalSession.test.ts apps/web/src/sessions/ai/AiSession.test.ts apps/web/src/sessions/online/OnlineSession.test.ts
rtk git commit -m "feat: add explicit viewer contracts"
```

### Task 2: Deterministic Spectator Demos

**Files:**
- Modify: `apps/web/src/shared/model/game.ts`
- Modify: `apps/web/src/sessions/demo/scenarios.ts`
- Modify: `apps/web/src/sessions/demo/DemoSession.ts`
- Modify: `apps/web/src/sessions/demo/DemoSession.test.ts`
- Modify: `apps/web/src/app/App.test.tsx`

- [ ] **Step 1: Write failing demo tests**

Cover these exact scenarios:

```text
spectator-list
spectator-active
spectator-reconnecting
spectator-finished
spectator-room-gone
```

Assert spectator game fixtures use:

```ts
viewer: { role: "spectator" }
viewerSeat: null
capabilities: { canMove: false, canLeaveGame: false, canSpectate: true }
spectatorCount: 12
```

Spy on the injected `OnlineLobbyGateway` and assert no list/ticket method runs for any `?demo=spectator-*` scenario.
Assert the app header visibly contains **Demo**, `spectator-room-gone` renders **Trận đấu không còn khả dụng** with **Về sảnh**, and returning to `spectator-list` refreshes fixture discovery without registering a runtime factory.

- [ ] **Step 2: Run demo tests and verify RED**

Run: `rtk npm run test:web -- src/sessions/demo/DemoSession.test.ts src/app/App.test.tsx`

Expected: FAIL because scenarios and demo isolation do not exist.

- [ ] **Step 3: Implement fixtures without transport**

Extend `DEMO_SCENARIOS`, `eventFor`, and `createScenarioFixture`. Put sample items in `snapshot.publicMatches` for `spectator-list`; model room-gone as a typed `room_unavailable` error. In `App.tsx`, skip online discovery whenever `demo.enabled` is true and render a visible demo label independent of network availability.

Do not instantiate `RuntimeBridge`, `OnlineLobbyGateway`, `PlayhtmlGameClient`, or fake tickets inside demo code.

- [ ] **Step 4: Run tests and build**

Run: `rtk npm run test:web -- src/sessions/demo/DemoSession.test.ts src/app/App.test.tsx`

Run: `rtk npm run typecheck:web`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/web/src/shared/model/game.ts apps/web/src/sessions/demo apps/web/src/app/App.tsx apps/web/src/app/App.test.tsx
rtk git commit -m "feat: add spectator demo scenarios"
```

### Task 3: Shared Read-Only Game UI

**Files:**
- Modify: `apps/web/src/features/game/useBoardSelection.ts`
- Modify: `apps/web/src/features/game/Board.test.tsx`
- Modify: `apps/web/src/features/game/GameScreen.tsx`
- Modify: `apps/web/src/features/game/GameScreen.test.tsx`
- Modify: `apps/web/src/features/game/GameTopBar.tsx`
- Modify: `apps/web/src/features/game/TurnStatus.tsx`
- Modify: `apps/web/src/features/game/PlayerPanel.tsx`
- Modify: `apps/web/src/features/game/game.module.css`
- Modify: `apps/web/src/features/result/ResultDialog.test.tsx`
- Modify: `apps/web/src/accessibility/cross-screen.accessibility.test.tsx`

- [ ] **Step 1: Write failing spectator UI tests**

Using `spectator-active`, assert:

- all 81 named board buttons exist and are disabled;
- click and keyboard activation call neither `getLegalMoves` nor `move`;
- the top bar shows **Đang xem trực tiếp**, `12 đang xem`, and **Rời chế độ xem**;
- turn copy is **Lượt của An**, never **Đến lượt bạn** or **Đối thủ đang đi**;
- player cards do not show **Bạn** or **Đối thủ**;
- exit calls `onLobby` without opening `ConfirmLeaveDialog` or calling player `leave`;
- reconnect copy is **Đang kết nối lại luồng trực tiếp...**;
- finished copy uses the player's name and keeps the final board after dialog close.

- [ ] **Step 2: Run UI tests and verify RED**

Run: `rtk npm run test:web -- src/features/game/Board.test.tsx src/features/game/GameScreen.test.tsx src/features/result/ResultDialog.test.tsx src/accessibility/cross-screen.accessibility.test.tsx`

Expected: FAIL on capability, labels, and exit behavior.

- [ ] **Step 3: Make interaction capability-driven**

Change the board gate to start with:

```ts
const canInteract = snapshot.capabilities.canMove
  && snapshot.phase === "playing"
  && snapshot.viewer?.role === "player"
  && snapshot.turn === snapshot.viewer.seat
  // retain pending/AI/reconnect checks
```

Use `snapshot.capabilities.canLeaveGame` instead of `mode === "online"` for forfeit confirmation. Pass viewer role/count to shared presentation components and render neutral spectator labels. Keep `ResultDialog` shared.
Add a null-viewer board test proving idle/error snapshots stay disabled and do not dereference a seat.

- [ ] **Step 4: Run UI tests, accessibility tests, and typecheck**

Run: `rtk npm run test:web -- src/features/game/Board.test.tsx src/features/game/GameScreen.test.tsx src/features/result/ResultDialog.test.tsx src/accessibility/cross-screen.accessibility.test.tsx`

Run: `rtk npm run typecheck:web`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/web/src/features/game apps/web/src/features/result/ResultDialog.test.tsx apps/web/src/accessibility/cross-screen.accessibility.test.tsx
rtk git commit -m "feat: render games in spectator mode"
```

### Task 4: Public Match List UI

**Files:**
- Create: `apps/web/src/features/spectator/PublicMatchList.tsx`
- Create: `apps/web/src/features/spectator/PublicMatchList.test.tsx`
- Modify: `apps/web/src/features/lobby/LobbyScreen.tsx`
- Modify: `apps/web/src/features/lobby/OnlineRoomPanel.tsx`
- Modify: `apps/web/src/features/lobby/OnlineRoomPanel.test.tsx`
- Modify: `apps/web/src/features/lobby/lobby.module.css`
- Modify: `apps/web/src/app/App.tsx`
- Modify: `apps/web/src/app/App.test.tsx`

- [ ] **Step 1: Write failing list tests**

Assert that **Trận đang diễn ra** is separate from **Phòng đang chờ**, renders A/B names, clocks, connection state, viewer count, and an accessible **Xem trận** button. Clicking it must emit only `{ allocationId, roomId }`; it must not read or submit the player-name field.

- [ ] **Step 2: Run list tests and verify RED**

Run: `rtk npm run test:web -- src/features/spectator/PublicMatchList.test.tsx src/features/lobby/OnlineRoomPanel.test.tsx src/app/App.test.tsx`

Expected: FAIL because the component and callbacks do not exist.

- [ ] **Step 3: Implement the smallest component boundary**

Create `PublicMatchList` with a discriminated state matching `WaitingRoomList` (`loading | ready | unavailable | error`) but do not merge the two components. Wire `spectator-list` demo data through `App` and `LobbyScreen`. Reuse `lobby.module.css`.

- [ ] **Step 4: Verify UI and build**

Run: `rtk npm run test:web -- src/features/spectator/PublicMatchList.test.tsx src/features/lobby/OnlineRoomPanel.test.tsx src/app/App.test.tsx`

Run: `rtk npm run build:web`

Expected: PASS; demo UI works without network.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/web/src/features/spectator apps/web/src/features/lobby apps/web/src/app/App.tsx apps/web/src/app/App.test.tsx
rtk git commit -m "feat: add public match list"
```

### Task 5: Strict Spectator Protocol And Capability Variant

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `apps/worker/src/auth/internal-auth.ts`
- Modify: `tests/ott-playhtml-bridge.test.js`
- Modify: `tests/ott-authority.test.js`

- [ ] **Step 1: Write failing protocol tests**

Bundle/import the active TypeScript protocol in the test and assert exact parsing of:

```js
{ __ott: true, roomId, type: "ott:spectate", ticket }
```

Reject missing/empty tickets, extra fields, wrong room type, oversized payloads, and unknown commands. Update source-smoke wording from “attach, move, leave” to include spectate.

- [ ] **Step 2: Write failing capability tests**

Test a discriminated union:

```ts
type CapabilityBase = {
  allocationId: string;
  roomId: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};
type PlayerCapability = CapabilityBase & {
  v: "ott-cap-v1";
  purpose: "game-init" | "attach" | "seat-update" | "lifecycle";
  seat: "A" | "B";
  revision?: number;
};
type SpectatorCapability = CapabilityBase & {
  v: "ott-cap-v2";
  purpose: "spectate";
  role: "spectator";
};
```

Assert exact canonical round-trip, wrong-room/wrong-purpose rejection, player-as-spectator rejection, spectator-as-player rejection, expiry, signature failure, and one successful mutation under parallel replay. Do not use `seat: "S"`.

Use these exact signed arrays:

```text
v1 player:    ["ott-cap-v1", allocationId, roomId, purpose, seat, issuedAt, expiresAt, nonce, revision?]
v2 spectator: ["ott-cap-v2", allocationId, roomId, "spectate", "spectator", issuedAt, expiresAt, nonce]
```

Keep v1 verification because create/join may issue a player ticket shortly before a deploy; its maximum compatibility window is the existing 60-second TTL and no ticket is persisted. New spectator issuance always uses v2. Define separate `PlayerCapabilityExpectations` and `SpectatorCapabilityExpectations` so callers cannot verify one variant as the other.

Add executable protocol contracts, not only source regexes:

```ts
type ViewerIdentity = { role: "player"; seat: "A" | "B" } | { role: "spectator" };
type SpectatorProjection = {
  roomId: string; status: "playing" | "finished"; revision: number;
  serverNow: number; players: unknown; state: unknown; events: readonly unknown[];
  viewer: { role: "spectator" }; spectatorCount: number;
};
```

- [ ] **Step 3: Run tests and verify RED**

Run: `rtk node --test tests/ott-playhtml-bridge.test.js tests/ott-authority.test.js`

Expected: FAIL because command/payload variants do not exist.

- [ ] **Step 4: Implement protocol and versioned canonical auth**

Add `ott:spectate` to exact command keys and implement the exact v1/v2 policy above. Export strict expectation overloads/helpers and projection types. Keep `attachWithCapabilityRecovery` player-only. Consume spectator nonces via `verifyCapabilityTransaction(..., { noncePrefix: "spectate-nonce" })` later at Game DO attach.

- [ ] **Step 5: Run tests and type/build checks**

Run: `rtk node --test tests/ott-playhtml-bridge.test.js tests/ott-authority.test.js`

Run: `rtk npx tsc -p apps/worker/tsconfig.json --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add packages/protocol/src/index.ts apps/worker/src/auth/internal-auth.ts tests/ott-playhtml-bridge.test.js tests/ott-authority.test.js
rtk git commit -m "feat: authorize spectator capabilities"
```

### Task 6: Pure Projection And Immutable Game Roles

**Files:**
- Modify: `apps/worker/src/persistence/room-storage.ts`
- Modify: `apps/worker/src/game/ott-game-server.ts`
- Modify: `tests/ott-game-room.test.js`
- Modify: `tests/ott-authority.test.js`
- Modify: `tests/worker-test-harness-runtime.test.js`

- [ ] **Step 1: Write failing pure projection tests**

Assert player projection includes `you`, spectator projection includes explicit spectator identity and count, and neither leaks `resumeToken`, capability, nonce, connection, storage receipt, or private Room fields.

- [ ] **Step 2: Write failing role authorization tests**

Cover:

- first successful attach fixes `{ role: "player", seat }` or `{ role: "spectator" }`;
- duplicate attach/spectate and mixed-role attempts are rejected before consuming another nonce;
- spectator `move`/`leave` return authorization errors without calling adapter methods or changing Room revision;
- spectator close does not call `adapter.close`;
- failed attach does not add presence;
- the attaching spectator's first projection includes itself in the count;
- existing spectators receive join/leave count changes;
- a failed send does not silently remove an otherwise live authenticated attachment;
- player close retains current `adapter.close` behavior while spectator close never enters the adapter;
- terminal commit queues spectator state before lobby terminalization for move, leave, clock timeout, reconnect timeout, goal, elimination, and no-moves paths.

- [ ] **Step 3: Run targeted tests and verify RED**

Run: `rtk node --test tests/ott-game-room.test.js tests/ott-authority.test.js tests/worker-test-harness-runtime.test.js`

Expected: FAIL on spectator projection and immutable roles.

- [ ] **Step 4: Implement pure projection and role dispatch**

Generalize `projectRoomPayload(payload, viewer, spectatorCount)` as a pure function. In `OttGameServer`, use one identity lookup instead of independent `attached`/seat assumptions. Check existing identity before ticket verification. Call `DurableRoomAdapter` only for players. Broadcast role-specific projections.

Use this attach order exactly:

1. Reject a connection that already has an identity, before ticket verification.
2. Verify the room-bound v2 ticket without consuming it.
3. Inside `verifyCapabilityTransaction`'s mutation callback, serialize pending attachment metadata `{ phase: "pending", role: "spectator", nonce }`; report accepted only after serialization succeeds.
4. Commit the nonce record `spectate-nonce:<nonce>` in the same durable transaction. If the transaction aborts, clear pending metadata; if compensation fails, close the connection fail-closed.
5. After transaction commit, promote attachment metadata to `{ phase: "authenticated", role: "spectator", nonce }`, then install the immutable in-memory identity.
6. Derive count only from attachment metadata whose phase is authenticated **and** whose nonce has a matching durable consumed-nonce record.
7. Send the initial projection to the new spectator and broadcast the new count to existing recipients.

On cold wake, pending metadata and authenticated metadata without durable nonce proof are never counted and their sockets are closed. A crash after nonce commit but before promotion is recoverable by validating durable nonce proof and promoting during rebuild. An initial-send failure after commit does not unconsume the nonce or silently decrement presence: the connection remains an authenticated live spectator until its close lifecycle runs. Test cold wake at every phase, attachment serialization failure, durable transaction failure after pending metadata, compensation failure/forced close, promotion failure, initial-send failure, and replay. `Room` is never called.

Refactor `DurableRoomAdapter` operations to return a committed outcome such as `{ result, payload, terminalReason }` without calling Lobby. After a durable write, `OttGameServer` queues the committed role-specific terminal projection to all currently attached recipients and only then calls/persists the authenticated Lobby terminal update. Apply the same helper to command and `onAlarm` paths. If Lobby cleanup fails, persist/schedule the existing retry marker without retracting the already committed Room state or terminal send attempt.

- [ ] **Step 5: Run authority tests**

Run: `rtk node --test tests/ott-game-room.test.js tests/ott-authority.test.js tests/worker-test-harness-runtime.test.js`

Expected: PASS, including observable terminal-before-lobby ordering.

- [ ] **Step 6: Commit**

```bash
rtk git add apps/worker/src/persistence/room-storage.ts apps/worker/src/game/ott-game-server.ts tests/ott-game-room.test.js tests/ott-authority.test.js tests/worker-test-harness-runtime.test.js
rtk git commit -m "feat: enforce immutable spectator roles"
```

### Task 7: Runtime Gate For Hibernating Presence

**Files:**
- Modify: `apps/worker/src/game/ott-test-game-server.ts`
- Modify: `apps/worker/src/entry/ott-test-worker.ts`
- Create: `apps/worker/wrangler.spectator-test.jsonc`
- Modify: `apps/worker/wrangler.test.jsonc`
- Modify: `tests/worker-test-harness-runtime.test.js`
- Modify: `tests/worker-runtime/fixture.js`
- Modify: `docs/playhtml-upstream-lock.md`

- [ ] **Step 1: Add a failing real-runtime hibernation scenario**

Use Wrangler/workerd, not source regexes or fake connections. Attach at least two authenticated spectator sockets and serialize immutable role metadata on each live socket attachment. Add a test-only instance-generation ID created in the Game DO constructor and exposed only through the authenticated test probe.

No deterministic hibernation trigger is currently known for pinned Wrangler/workerd. Therefore this task starts as an evidence spike with expected status **BLOCKED**, not as an assumed implementation task. Inspect the exact pinned runtime/CLI for a supported test hook or eviction control. A valid trigger must evict the Game DO instance while original sockets stay open; after triggering it, send through one original socket and prove generation changed, `getConnections()` enumerates the original socket IDs before any reconnect, role metadata survives, and count reconstructs.

Also test repeated close, close during wake, failed attach, and stale attachment filtering. Count must never become negative.

- [ ] **Step 2: Run the runtime test and record RED**

Run: `rtk node --test tests/worker-test-harness-runtime.test.js`

Expected: BLOCKED unless the pinned runtime exposes and the test invokes a deterministic same-socket hibernation trigger. A skip or a process restart that reconnects new sockets is not evidence and counts as a failed gate.

- [ ] **Step 3: Implement runtime-backed identity attachments**

Use PartyServer connection attachment APIs already provided by the pinned runtime. Store only minimal authenticated metadata such as:

```ts
{ ottViewer: { role: "spectator" } }
// or { ottViewer: { role: "player", seat: "A" } }
```

Only after discovering and documenting the exact trigger, implement cold-wake reconstruction in this order:

1. Enumerate original live connections and validate attachment metadata plus durable nonce proof.
2. Build the live A/B connection map from authenticated player metadata.
3. Hydrate `DurableRoomAdapter` with that map so each live player's connection is restored before `Room.reconcileHydration` can mark it disconnected or pause/start lifecycle behavior.
4. Rebuild immutable player identities.
5. Rebuild spectator identities/count from authenticated, nonce-proven spectator attachments.
6. Ignore/close malformed, pending-without-proof, or stale entries before accepting new attaches.

Add same-original-socket player tests proving cold wake starts no grace period, does not pause/change the running clock owner, and produces no result. Never persist a scalar authoritative count. Keep generation/eviction hooks test-only and unreachable in production builds.

- [ ] **Step 4: Re-run the direct runtime gate**

Run the exact newly documented trigger command, then: `rtk node --test tests/worker-test-harness-runtime.test.js`

Expected: PASS for attach, cold wake of the same original sockets, idempotent close, and nonnegative count. A process restart may be tested separately but cannot satisfy this gate.

- [ ] **Step 5A: PASS branch**

If the gate passes, record exact command, versions, generation IDs, original socket identities, result, and scope limitation. Do not change overall production rollout status.

- [ ] **Step 5B: BLOCKED branch**

If the pinned local runtime cannot force and prove cold hibernation with original sockets, do not treat restart/reconnect as equivalent and do not invent an estimate. Remove any intentionally failing runtime test or mark the experiment as an explicitly skipped non-evidence probe with a precise reason. Revert incomplete production presence wiring from this task while retaining independently green protocol/authority code and Tasks 1-4 demos/UI. Confirm `OTT_SPECTATOR_ENABLED` is absent/off, add the blocker and attempted command to `docs/playhtml-upstream-lock.md`, and stop before Tasks 8-11.

Run this green blocked-state matrix:

```bash
rtk node --test tests/ott-playhtml-bridge.test.js tests/ott-authority.test.js tests/ott-game-room.test.js
rtk npm test
rtk npm run test:web
rtk npm run typecheck:web
rtk npx tsc -p apps/worker/tsconfig.json --noEmit
rtk npm run build:web
rtk git diff --check
```

Expected: PASS; runtime probe is explicitly non-evidence, no production flag or fallback exists.

- [ ] **Step 6A: PASS commit**

```bash
rtk git add apps/worker/src/game/ott-test-game-server.ts apps/worker/src/entry/ott-test-worker.ts apps/worker/wrangler.test.jsonc apps/worker/wrangler.spectator-test.jsonc tests/worker-test-harness-runtime.test.js tests/worker-runtime/fixture.js docs/playhtml-upstream-lock.md apps/worker/src/game/ott-game-server.ts
rtk git commit -m "test: record spectator presence gate"
```

- [ ] **Step 6B: BLOCKED commit**

After removing failed experiment code and confirming the green matrix, stage only independently valid retained files and the evidence note:

```bash
rtk git add apps/worker/src/game/ott-game-server.ts apps/worker/src/persistence/room-storage.ts tests/ott-game-room.test.js tests/ott-authority.test.js docs/playhtml-upstream-lock.md
rtk git commit -m "docs: record spectator presence blocker"
```

Inspect `rtk git status --short` before staging; omit any listed source file if it contains incomplete hibernation behavior.

### Task 8: Active Discovery, Tickets, And Durable Count Publication

**Files:**
- Modify: `apps/worker/src/lobby/ott-lobby-server.ts`
- Create: `apps/worker/src/lobby/ott-lobby-stream-server.ts`
- Modify: `apps/worker/src/game/ott-game-server.ts`
- Modify: `apps/worker/src/entry/ott-worker.ts`
- Modify: `apps/worker/worker-configuration.d.ts`
- Modify: `apps/worker/wrangler.jsonc`
- Modify: `apps/worker/wrangler.test.jsonc`
- Create: `apps/worker/wrangler.spectator-test.jsonc`
- Modify: `tests/ott-authority.test.js`
- Modify: `tests/worker-runtime.test.js`
- Modify: `apps/web/src/sessions/online/OnlineLobbyGateway.ts`
- Modify: `apps/web/src/sessions/online/OnlineLobbyGateway.test.ts`

- [ ] **Step 1: Write failing lobby authority tests**

Cover separate `list` and `active` responses, server flag off by default, ticket issuance only for `playing`, anonymous request bodies, wrong/missing allocation, terminal race, per-action rate limiting, and no owner credential leakage.

Cover authenticated Game→Lobby summary updates using a per-allocation version `{ roomRevision, summarySequence }`, ordered lexicographically. The Game DO owns durable key `public-summary-sequence`, initialized to `0`, and increments it transactionally before every committed public-summary publication, including spectator join/leave that does not mutate Room. `roomRevision` is sampled from the committed Room payload. `OttLobbyServer` stores the latest pair per allocation and rejects non-increasing, wrong-room, or forged updates. Persisting the sequence is allowed because it orders publications and is not the authoritative viewer count.

Separately, `OttLobbyServer` owns durable key `public-catalog-revision`, initialized to `0`, and increments it transactionally whenever the visible catalog changes after accepting a match summary or terminal removal. Every full list envelope uses this scalar catalog revision:

```ts
{ __ott: true, type: "ott:active-matches", catalogRevision: number, matches: PublicMatchView[] }
```

A terminal update marks the allocation terminal, invalidates queued updates for that allocation, increments catalog revision, and ensures stale per-match versions cannot recreate it. A count publication failure must not invalidate game state.

Cover a concrete read-only lobby stream:

- class `OttLobbyStreamServer extends YServer`;
- binding name `Lobby`, exported class `OttLobbyStreamServer`, and PartyServer party `lobby`;
- one canonical provider room named `ott-lobby-public`;
- public route `/parties/lobby/ott-lobby-public`;
- custom messages `ott:lobby-subscribe` from client and `ott:active-matches` from server;
- exact server envelope `{ __ott: true, type: "ott:active-matches", revision, matches }`;
- initial full snapshot after subscribe and full-snapshot fan-out after each coalesced update;
- `isReadOnly()` returns true and non-subscribe custom messages are ignored;
- no client-authored Yjs/page/element state and no game command is accepted on this route.

Add `Env.Lobby: DurableObjectNamespace`, a `Lobby` binding in `wrangler.jsonc`, and a new SQLite migration tag after v2 creating `OttLobbyStreamServer`. Export the class from `ott-worker.ts`; route only the exact regex `^/parties/lobby/ott-lobby-public$` through `routePartykitRequest`. Configure YProvider with `party: "lobby"`.

`OttLobbyServer` remains the durable owner of allocations/summaries. After committing a newer catalog, it POSTs `{ catalogRevision, matches }` to `Lobby.idFromName("ott-lobby-public")` at `/internal/active-update` with `x-ott-internal-secret`; the stream validates and fans out only a higher catalog revision.

For every `ott:lobby-subscribe`, including cold start and resubscription, `OttLobbyStreamServer` POSTs an internal-secret-authenticated request to `OTT_LOBBY.idFromName("lobby")` at `/internal/public-active-snapshot` with `{}`. `OttLobbyServer` returns `{ catalogRevision, matches }` from durable allocation summaries. The stream validates the exact public shape, replaces its in-memory revision if newer, and sends a full `ott:active-matches` snapshot to that subscriber. If resync fails, send `ott:error` with `active_matches_unavailable` and no stale fabricated list. Test cold stream start, stream hibernation, missed update followed by subscribe resync, stale notification rejection, and reconnect/resubscribe.

- [ ] **Step 2: Run tests and verify RED**

Run: `rtk node --test tests/ott-authority.test.js tests/worker-runtime.test.js`

Run: `rtk npm run test:web -- src/sessions/online/OnlineLobbyGateway.test.ts`

Expected: FAIL because active list/ticket/update contracts do not exist.

- [ ] **Step 3: Implement fail-closed controls**

Add `OTT_SPECTATOR_ENABLED?: string` and the `Lobby` binding. Enable only on exact value `"true"`. Keep it absent in default and `demo`. `wrangler.spectator-test.jsonc` uses `ott-test-worker.ts` as its entry, exports/binds `OttTestGameServer` as `Main`, and binds the real `OttLobbyServer` as `OTT_LOBBY` plus real `OttLobbyStreamServer` as `Lobby`; give each test class an explicit SQLite migration. It sets the flag, probe secret, short test timings, and local browser origin. `tests/worker-runtime/fixture.js` launches this exact config only for spectator acceptance. Add a fail-closed assertion against default/demo. Test-only routes remain absent from `ott-worker.ts`.

Add control actions `active` and `spectate` using `createControlRequest`. `spectate` returns `{ allocationId, room, ticket }` with no seat, name, or resume credential. Store `{ version: { roomRevision, summarySequence }, summary }` in the allocation only as delayed discovery data. Coalesce rapid stream notifications only after `OttLobbyServer` has accepted updates and assigned a catalog revision; publish the newest full catalog. Terminal removal cancels queued publications and cannot be overwritten by an older per-match version.

Publish a summary after every committed public projection change: player attach/close, move, alarm clock settlement, spectator join/leave, and terminal outcome. Summary clocks are the latest authoritative remaining values plus `serverNow` and `runningSeat`; the lobby UI may interpolate display locally while the subscription is connected. Do not add periodic polling or mutate Room merely to refresh lobby clocks.

Implement the exact lobby stream route/envelopes above. The HTTP `active` action exists for initial diagnostics/fail-closed recovery only; production real-time UI in Task 10 obtains its initial and subsequent list from the single lobby provider subscription and does not poll it.

Split rate-limit keys by action/client classification so active-list/ticket traffic cannot consume player create/join/resume allowance globally.

- [ ] **Step 4: Verify lobby and gateway tests**

Run: `rtk node --test tests/ott-authority.test.js tests/worker-runtime.test.js`

Run: `rtk npm run test:web -- src/sessions/online/OnlineLobbyGateway.test.ts`

Expected: PASS with flag off unless explicitly enabled in tests.

- [ ] **Step 5: Commit**

```bash
rtk git add apps/worker/src/lobby/ott-lobby-server.ts apps/worker/src/lobby/ott-lobby-stream-server.ts apps/worker/src/game/ott-game-server.ts apps/worker/src/entry/ott-worker.ts apps/worker/worker-configuration.d.ts apps/worker/wrangler.jsonc apps/worker/wrangler.test.jsonc apps/worker/wrangler.spectator-test.jsonc tests/ott-authority.test.js tests/worker-runtime.test.js apps/web/src/sessions/online/OnlineLobbyGateway.ts apps/web/src/sessions/online/OnlineLobbyGateway.test.ts
rtk git commit -m "feat: publish active spectator matches"
```

### Task 9: Runtime Gate For Sequential Provider Rebinding

**Files:**
- Modify: `vendor/playhtml-minimal/browser/runtime-entry.js`
- Regenerate: `vendor/playhtml-minimal/browser/runtime.js`
- Modify: `vendor/playhtml-minimal/browser/runtime.d.ts`
- Modify: `vendor/playhtml-minimal/browser/index.js`
- Modify: `vendor/playhtml-minimal/browser/index.d.ts`
- Modify: `packages/game-client/src/playhtml-bootstrap.js`
- Modify: `apps/web/src/sessions/online/runtimeBridge.ts`
- Modify: `apps/web/src/sessions/online/globals.d.ts`
- Modify: `apps/web/src/sessions/online/runtimeBridge.test.ts`
- Modify: `apps/web/src/sessions/contract.ts`
- Modify: `apps/web/src/sessions/{local/LocalSession.ts,ai/AiSession.ts,online/OnlineSession.ts,demo/DemoSession.ts}`
- Modify: `apps/web/src/sessions/online/OnlineSession.test.ts`
- Modify: `apps/web/src/app/App.tsx`
- Modify: `apps/web/src/app/App.test.tsx`
- Modify: `tests/playhtml-bootstrap.test.js`
- Modify: `tests/playhtml-custom-channel.test.js`
- Modify: `tests/browser-worker-runtime.test.js`
- Modify: `scripts/run-browser-worker-runtime.js`
- Modify: `tests/worker-runtime/fixture.js`
- Modify: `apps/worker/src/game/ott-test-game-server.ts`
- Modify: `apps/worker/src/entry/ott-test-worker.ts`
- Modify: `docs/playhtml-upstream-lock.md`

- [ ] **Step 1: Write failing lifecycle tests**

First change `GameSession.dispose()` to `Promise<void> | void` and update Local/AI/Demo implementations without behavioral changes. Define one online ownership chain: `OnlineSession` or the lobby/spectator owner owns one `RuntimeBridge`; bridge owns one bootstrap binding; bootstrap owns one PlayHTML instance and the global connection factory it installed; that instance owns one YProvider. `OnlineSession.dispose()` awaits client/channel closure and then `RuntimeBridge.dispose()`. `RuntimeBridge.dispose()` calls bootstrap disposal, which closes channels/provider, removes only its own global factory, clears bootstrap config/promise, then calls runtime `reset()` to clear runtime instance/config.

Unit test this sequence:

```text
bootstrap lobby -> close/dispose -> bootstrap game -> close/dispose -> bootstrap lobby
```

Assert at most one provider exists at every point, old listeners cannot receive new-room messages, and concurrent/different-room bootstrap without disposal is rejected.
Also test idempotent disposal, disposal during initialization, failed bootstrap cleanup, provider connection `open/close/reconnecting` events, and preservation of a global factory not owned by the disposed binding.
Test App awaits disposal before each provider-backed transition: lobby→player game→lobby and lobby→spectator game→lobby.

- [ ] **Step 2: Run unit tests and verify RED**

Run: `rtk npm run test:web -- src/sessions/online/runtimeBridge.test.ts`

Run: `rtk node --test tests/playhtml-custom-channel.test.js`

Run: `rtk node --test tests/playhtml-bootstrap.test.js`

Expected: FAIL because `configuration`/bridge bindings cannot reset.

- [ ] **Step 3: Implement explicit disposal/rebind**

Implement exactly `RuntimeBridge.dispose(): Promise<void>`. Add `runtime.reset(): Promise<void> | void` and a bootstrap object `{ bootstrap(config), dispose() }` rather than a bare function; update declarations and callers together. Ensure close destroys the provider, removes listeners/factory state, clears configuration, cancels pending initialization safely, and permits the next room. Preserve rejection of two simultaneous room bindings. Surface provider connectivity through the existing connection adapter as `open`, `close`, and `reconnecting` events; do not create another socket.

Allow exactly two runtime room forms: canonical `ott-<uuid>` game rooms on party `main`, and fixed room `ott-lobby-public` on party `lobby`. Pass `party` as part of `RuntimeConfig`; reject every other party/room combination. This is routing metadata for the same single YProvider lifecycle, not a second transport.

Regenerate, never hand-edit, the browser bundle:

Run: `rtk npm run build:playhtml-browser`

Run: `rtk npm run typecheck:web`

Run: `rtk node --test tests/playhtml-bootstrap.test.js tests/playhtml-custom-channel.test.js`

- [ ] **Step 4: Run real-browser provider gate**

Extend the browser harness to observe provider/socket creation and execute the full lobby→game→lobby sequence against the pinned Worker runtime.

Run: `rtk npm run test:browser-worker-runtime`

Expected: PASS with one active provider at a time, successful resync after each transition, no polling, and no raw/second socket.

- [ ] **Step 5: Apply the stop rule**

If real sequential rebinding or a same-channel lobby provider route cannot be proven, record the blocker, keep the feature flag off, and do not connect production `SpectatorSession`/active-list subscription. Do not substitute HTTP polling for live counts.

If it passes, record exact browser/runtime evidence without changing the broader online rollout status.

- [ ] **Step 6: Commit**

```bash
rtk git add vendor/playhtml-minimal/browser/runtime-entry.js vendor/playhtml-minimal/browser/runtime.js vendor/playhtml-minimal/browser/runtime.d.ts vendor/playhtml-minimal/browser/index.js vendor/playhtml-minimal/browser/index.d.ts packages/game-client/src/playhtml-bootstrap.js apps/web/src/sessions/contract.ts apps/web/src/sessions/local/LocalSession.ts apps/web/src/sessions/ai/AiSession.ts apps/web/src/sessions/online/OnlineSession.ts apps/web/src/sessions/demo/DemoSession.ts apps/web/src/sessions/online/OnlineSession.test.ts apps/web/src/sessions/online/runtimeBridge.ts apps/web/src/sessions/online/runtimeBridge.test.ts apps/web/src/sessions/online/globals.d.ts apps/web/src/app/App.tsx apps/web/src/app/App.test.tsx tests/playhtml-bootstrap.test.js tests/playhtml-custom-channel.test.js tests/browser-worker-runtime.test.js scripts/run-browser-worker-runtime.js docs/playhtml-upstream-lock.md
rtk git commit -m "feat: support sequential provider sessions"
```

### Task 10: Spectator Session And App Integration

**Prerequisite:** Tasks 7 and 9 passed with direct runtime evidence. Otherwise leave production integration disabled and retain deterministic demos only.

> **Stop Rule Status (2026-09-27):** Task 7 runtime gate is explicitly **BLOCKED** on workerd cold hibernation evidence (`state.abort()` terminates sockets with code 1006). Therefore, this prerequisite is NOT satisfied. Production integration remains disabled (`publicMatchState()` returns `unavailable`), no live lobby subscription is connected in `App.tsx`, and Tasks 8-11 code remains experimental scaffolding. Overall status is **demo/authority complete, runtime blocked**.

**Files:**
- Create: `apps/web/src/sessions/spectator/SpectatorSession.ts`
- Create: `apps/web/src/sessions/spectator/SpectatorSession.test.ts`
- Modify: `packages/game-client/src/playhtml-game-client.js`
- Modify: `tests/playhtml-game-client.test.js`
- Modify: `apps/web/src/sessions/online/globals.d.ts`
- Modify: `apps/web/src/sessions/online/OnlineLobbyGateway.ts`
- Modify: `apps/web/src/app/App.tsx`
- Modify: `apps/web/src/app/App.test.tsx`
- Modify: `tests/browser-worker-runtime.test.js`
- Modify: `scripts/run-browser-worker-runtime.js`

- [ ] **Step 1: Write failing session tests**

Test:

- `start({ mode: "spectator", allocationId, roomId })` requests a ticket and sends `ott:spectate`;
- state normalization produces spectator identity/capabilities/count;
- old, duplicate, malformed, and cross-room revisions are ignored;
- display clocks interpolate locally without changing authority;
- `getLegalMoves` returns `[]`, `move` returns a read-only error, and exit/dispose sends no `ott:leave`;
- reconnect reuses transport behavior, requests a fresh one-use ticket when required, and resyncs current revision;
- terminal received while connected renders final state;
- missed terminal becomes `room_unavailable`, not terminal retention.

- [ ] **Step 2: Run tests and verify RED**

Run: `rtk npm run test:web -- src/sessions/spectator/SpectatorSession.test.ts src/app/App.test.tsx`

Run: `rtk node --test tests/playhtml-game-client.test.js`

Expected: FAIL because spectator transport/session does not exist.

- [ ] **Step 3: Define the spectator transport lifecycle**

Use one connection interface with provider-derived `open`, `close`, `reconnecting`, `message`, and `error` events. `SpectatorSession` owns one `{ allocationId, roomId }` watch intent, one active connection, one in-flight ticket request, and one monotonically increasing connection generation.

On every new provider connection generation:

1. Cancel/ignore ticket results belonging to an older generation.
2. Request exactly one fresh `spectate` ticket from `OnlineLobbyGateway`.
3. Send exactly one `ott:spectate` after `open` for that generation.
4. Accept state only after that attach succeeds and only for the intended room.
5. On transport close, enter reconnecting and let the same provider reconnect; when it emits a new `open`, repeat steps 1-4 with a fresh ticket/nonce.

Deduplicate parallel `open` notifications with the generation/in-flight promise. `dispose()` marks the session closed, invalidates the generation, aborts/ignores pending control requests, unsubscribes handlers, closes the channel through `RuntimeBridge.dispose()`, and never schedules another ticket request. No spectator credential is persisted and no player resume endpoint is used.

- [ ] **Step 4: Implement the dedicated session**

Follow `OnlineSession` patterns for subscriptions, revision ordering, event de-duplication, clock timer, and disposal, but do not copy game-state validation. Export/generalize the existing normalizer helpers where needed.

Keep player credential storage and `ott:leave` behavior out of spectator code. Add only the minimum shared client surface needed to send/receive strict OTT envelopes over the existing provider channel.

- [ ] **Step 5: Integrate one-provider app transitions**

While lobby is visible, bootstrap `{ party: "lobby", room: "ott-lobby-public" }`, send `ott:lobby-subscribe`, and render each full `ott:active-matches` snapshot. Before starting `SpectatorSession`, await disposal of that subscription/runtime. Then bootstrap `{ party: "main", room: selected.roomId }`. Before returning to lobby, await game session/runtime disposal, then recreate the lobby provider and wait for its initial full snapshot. Use HTTP control only for one-shot ticket issuance, not count polling.

- [ ] **Step 6: Add and run real reconnect evidence**

Extend browser acceptance now, before final verification: drop and restore the spectator provider transport without reloading the page. Observe one provider only, a newly issued ticket with a different nonce, one spectate command for the new connection generation, and the current authoritative revision after reattach.

Use an authenticated test-only endpoint in `ott-test-worker.ts` that targets a connection ID recorded by `OttTestGameServer` and closes exactly that server-side socket. It is protected by `OTT_TEST_PROBE_SECRET`, exists only through `wrangler.spectator-test.jsonc`, and is absent from `ott-worker.ts`. That config uses the test entry/Game subclass together with the real Lobby and Lobby-stream classes, as defined in Task 8. The browser harness obtains the old connection ID from the test probe, calls the close endpoint, waits for its close record, then waits for a distinct new server connection ID. Assert exactly one new v2 ticket nonce was issued and exactly one `ott:spectate` arrived for the new ID before current state. `tests/worker-runtime/fixture.js` launches `wrangler dev --config apps/worker/wrangler.spectator-test.jsonc` for this acceptance and tears it down before restoring normal fixture behavior.

Run: `rtk npm run test:browser-worker-runtime`

Expected before completed wiring: FAIL on the fresh-ticket/current-revision assertion; after minimal implementation: PASS.

- [ ] **Step 7: Run session/app tests and web verification**

Run: `rtk npm run test:web -- src/sessions/spectator/SpectatorSession.test.ts src/app/App.test.tsx src/features/spectator/PublicMatchList.test.tsx`

Run: `rtk node --test tests/playhtml-game-client.test.js tests/no-legacy-online-transport.test.js`

Run: `rtk npm run typecheck:web`

Run: `rtk npm run build:web`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
rtk git add apps/web/src/sessions/spectator packages/game-client/src/playhtml-game-client.js tests/playhtml-game-client.test.js apps/web/src/sessions/online apps/web/src/app/App.tsx apps/web/src/app/App.test.tsx tests/browser-worker-runtime.test.js scripts/run-browser-worker-runtime.js tests/worker-runtime/fixture.js apps/worker/src/game/ott-test-game-server.ts apps/worker/src/entry/ott-test-worker.ts apps/worker/wrangler.spectator-test.jsonc
rtk git commit -m "feat: connect spectator sessions"
```

### Task 11: End-To-End Verification, Documentation, And Rollout Guard

**Files:**
- Modify: `tests/browser-worker-runtime.test.js`
- Modify: `tests/worker-runtime/fixture.js`
- Modify: `tests/no-legacy-online-transport.test.js`
- Modify: `README.md`
- Modify: `CONFIG.md`
- Modify: `docs/playhtml-upstream-lock.md`

- [ ] **Step 1: Complete the multi-profile acceptance matrix**

Use two player contexts and at least two spectator contexts. Prove:

- active game appears publicly after B joins;
- anonymous watch entry works;
- count changes on attach/close and remains correct after the tested wake path;
- player move reaches all spectators without spectator mutation;
- spectator move/leave attempts are rejected and game state is unchanged;
- reconnect gets a fresh ticket and current snapshot;
- leaving watch mode does not affect clocks/result;
- terminal send is queued before discovery removal;
- a disconnected spectator that misses terminal sees unavailable;
- only one provider connection exists per browser profile at any time;
- Local/AI still work when spectator flag/runtime is unavailable.

- [ ] **Step 2: Run browser acceptance**

Run: `rtk npm run test:browser-worker-runtime`

Expected: PASS. This task is final verification, not a forced TDD RED step; behavioral RED-GREEN coverage was added in the preceding tasks before each implementation.

- [ ] **Step 3: If needed, make only minimal integration fixes**

If this step changes behavior, stop and write a focused failing regression test in the owning earlier task's test file before the fix. Stage every actual source/config/generated file changed in Step 7. Do not weaken assertions, add sleeps in place of deterministic synchronization, or introduce a fallback transport.

- [ ] **Step 4: Run the complete verification matrix**

Run:

```bash
rtk npm test
rtk npm run test:web
rtk npm run typecheck:web
rtk npx tsc -p apps/worker/tsconfig.json --noEmit
rtk npm run build:web
rtk npm run build:playhtml-browser
rtk git diff --exit-code -- vendor/playhtml-minimal/browser/runtime.js
rtk npm run test:worker-runtime
rtk node --test tests/worker-test-harness-runtime.test.js
rtk npm run test:browser-worker-runtime
```

Expected: all configured suites PASS; environment-gated skips must be listed explicitly and cannot support a readiness claim.

- [ ] **Step 5: Update documentation from evidence only**

Document demo URLs, module boundaries, server-side feature flag, and verified commands. Keep spectator disabled by default unless all spectator runtime gates and the broader online gates have passed. Do not change `docs/playhtml-upstream-lock.md` to production-ready unless its full existing evidence matrix independently permits that conclusion.

- [ ] **Step 6: Inspect final scope**

Run: `rtk git status --short`

Run: `rtk git diff --check`

Run: `rtk git diff --stat HEAD~10..HEAD`

Confirm no changes to `Room`/rules, no secrets, no unrelated untracked files, and no generated artifact except the intentional rebuilt browser runtime.

- [ ] **Step 7: Commit**

```bash
rtk git add tests/browser-worker-runtime.test.js tests/worker-runtime/fixture.js tests/no-legacy-online-transport.test.js README.md CONFIG.md docs/playhtml-upstream-lock.md
rtk git commit -m "test: verify spectator mode end to end"
```

If Step 3 changed additional files, include their exact paths in `git add` after inspecting `rtk git status --short`; do not use `git add .`.

## Completion States

The implementation may end in one of two honest states:

1. **Demo/authority complete, runtime blocked:** Tasks 1-6 pass, a runtime gate fails, deterministic demos remain available, server flag remains off, and the blocker/evidence is documented.
2. **Spectator acceptance complete:** All tasks and runtime gates pass, but production enablement still depends on the broader online rollout status owned by `docs/playhtml-upstream-lock.md`.

Neither state permits inventing a fallback transport or claiming production readiness without the required evidence.

### Current Recorded Plan Status (2026-09-27)

**Current Status: demo/authority complete, runtime blocked (State 1)**

- **Tasks 1-6:** Verified and complete. Viewer contracts, capability-driven UI, read-only board interaction, protocol parsing, and authority guarantees are fully passing in unit tests and deterministic demo scenarios (`?demo=spectator-*`).
- **Task 7:** Evaluated and recorded as **BLOCKED** in `docs/playhtml-upstream-lock.md`. On pinned Wrangler `4.141.0` / workerd `1.20240718.0`, `state.abort()` terminates open client WebSockets with code 1006 rather than preserving them across DO eviction.
- **Stop Rule Enforced:** Because Task 7 is blocked, Task 10's prerequisite is unmet. Production active discovery is intentionally disabled in the App shell (`publicMatchState()` returns `unavailable`), no live lobby subscription is established, and no two-profile browser acceptance is claimed.
- **Tasks 8-11 Code:** Code written for active match discovery, lobby stream, provider rebinding, and spectator sessions is experimental scaffolding. Browser multi-profile acceptance was not executed/passed.
- **Rollout Guard:** `OTT_SPECTATOR_ENABLED` remains disabled by default. Spectator mode fails closed.
