# Spectator Mode Code Review

Date: 2026-09-27  
Branch: `feat/spectator-mode`  
Base reviewed: `ad4d0e0`  
Head reviewed: `3431a71`  
Additional scope: all uncommitted and untracked changes in the `spectator-mode` worktree

## Review Scope

The review covered:

- committed changes in `ad4d0e0...3431a71`;
- all current dirty and untracked spectator-mode changes;
- `docs/superpowers/plans/2026-09-27-spectator-mode.md`;
- `docs/superpowers/specs/2026-09-27-spectator-mode-design.md`;
- `PROGRESS_HANDOFF_2026-09-27-SPECTATOR_MODE.md`;
- `docs/playhtml-upstream-lock.md`;
- web session/UI, game client, PlayHTML runtime bridge, Worker authority, Lobby, capability, presence, and rollout boundaries.

No full test suite was run. The review used source inspection and `git diff --check` only.

## Findings

### 1. Critical: Feature flag does not fail closed

Locations:

- `apps/worker/src/entry/ott-worker.ts:6-27`
- `apps/worker/src/lobby/ott-lobby-stream-server.ts:35-50`
- `apps/worker/src/game/ott-game-server.ts:583-639`

The public route `/parties/lobby/ott-lobby-public` is always exposed, the Game Durable Object always publishes summaries, and the stream returns player names, room IDs, clocks, and spectator counts even when `OTT_SPECTATOR_ENABLED` is not exactly `"true"`.

The current flag only protects the HTTP `active` and `spectate` actions. It does not protect route admission, summary publication/storage, stream resync, stream fan-out, or Game spectator attachment.

Delegated task: apply the exact `"true"` guard at every spectator publication and admission boundary. Add default and demo environment tests proving that no public catalog or spectator attachment is available while the flag is disabled.

### 2. High: Handoff violates the implementation stop rule

Locations:

- `PROGRESS_HANDOFF_2026-09-27-SPECTATOR_MODE.md:11-15`
- `PROGRESS_HANDOFF_2026-09-27-SPECTATOR_MODE.md:77-94`
- `docs/superpowers/plans/2026-09-27-spectator-mode.md:721-736`
- `docs/superpowers/plans/2026-09-27-spectator-mode.md:902-907`

Task 7 is explicitly `BLOCKED`, so Task 10 production integration does not meet its prerequisite. The handoff nevertheless states that Tasks 1-11 are complete and verified.

The listed verification evidence also omits the browser acceptance required by Tasks 10 and 11. Production active discovery is not connected in the App.

Delegated task: change the status to `demo/authority complete, runtime blocked`, separate experimental Tasks 8-11 code from passed evidence, and list only commands and runtime behavior that were directly observed.

### 3. High: Spectator does not reattach after provider reconnect

Locations:

- `apps/web/src/sessions/spectator/SpectatorSession.ts:171-224`
- `apps/web/src/sessions/spectator/SpectatorSession.ts:232-245`

After a provider `close` followed by a new `open`, the session only changes its connection status to `online`. It does not advance the connection generation, request a fresh one-use ticket, or send another `ott:spectate` command.

The new connection remains unauthenticated and stops receiving authoritative state.

Delegated task: make each distinct provider-open generation request exactly one fresh ticket and attach exactly once. Ignore stale asynchronous ticket results and test close/open recovery with a distinct nonce and current-state resync.

### 4. High: App leaks sessions/providers and does not serialize disposal

Locations:

- `apps/web/src/app/App.tsx:154-177`
- `apps/web/src/app/App.tsx:180-230`

The effect cleanup captures only the session created during the boot effect. It does not necessarily dispose the currently active online or spectator session that replaced it.

Transitions call asynchronous `dispose()` without awaiting it and immediately construct the next session. The old and new providers may therefore coexist, violating the single-provider lifecycle requirement.

Delegated task: centralize session transitions in an asynchronous lifecycle operation that disposes the actual active session and awaits disposal before creating the next session. Cover lobby-to-game-to-lobby, spectator-to-lobby, rapid replacement, and component unmount.

### 5. High: Public match summaries read nonexistent Room fields

Locations:

- `apps/worker/src/game/ott-game-server.ts:601-627`
- actual Room payload: `packages/game-core/src/room.js:332-343`

The summary builder reads `room.playerA`, `room.playerB`, `room.clock`, and `room.runningSeat`. Room actually exposes players through `room.players` and clocks through `room.state.clock`; the committed payload also contains the correct public values.

Published summaries therefore use fallback names, mark players disconnected, report zero clocks, and set `runningSeat` to `null`.

Delegated task: build summaries from the committed payload or the actual `room.players` and `room.state.clock` fields after clock settlement. Add a focused catalog projection test for names, connectivity, clocks, and running seat.

### 6. High: Spectator acceptance config cannot route provider traffic

Locations:

- `apps/worker/wrangler.spectator-test.jsonc:4-35`
- `apps/worker/src/entry/ott-test-worker.ts:1-14`

The config binds `OttLobbyServer` and `OttLobbyStreamServer`, but the test entry exports only `OttTestGameServer`. The entry rejects every request without the test probe secret and never calls `routePartykitRequest`.

Lobby and game provider WebSockets cannot reach the configured Durable Object classes, so the planned browser acceptance path cannot run.

Delegated task: export all bound classes, route exact provider paths before handling probe routes, and require `OTT_TEST_PROBE_SECRET` only for `/__test/*` endpoints.

### 7. High: Same-revision count updates and reconnect snapshots are discarded

Locations:

- `apps/worker/src/game/ott-game-server.ts:670-681`
- `apps/worker/src/game/ott-game-server.ts:742-748`
- `packages/game-client/src/playhtml-game-client.js:188-196`
- `apps/web/src/sessions/spectator/SpectatorSession.ts:264-268`

Spectator join and leave change `spectatorCount` without changing the authoritative Room revision. The server broadcasts the new count, but both the game client and `SpectatorSession` reject every message whose revision is less than or equal to the previous revision.

A reconnect snapshot at the last Room revision is rejected for the same reason.

Delegated task: introduce separate stream/projection ordering, or accept same-revision metadata refreshes while independently deduplicating board state and events. Cover count-only updates and reconnect at an unchanged Room revision.

### 8. High: A spectator ticket can attach after the game is terminal

Locations:

- `apps/worker/src/game/ott-game-server.ts:457-500`
- `apps/worker/src/game/ott-game-server.ts:670-690`

`attachSpectator()` consumes the ticket nonce without first checking that the authoritative Room is still `playing`. `publishSpectatorInitial()` also accepts a Room whose status is `done` if its payload is still available.

A ticket issued immediately before terminalization can therefore be redeemed after completion and retrieve the retained final Room.

Delegated task: verify authoritative Room status before capability consumption and identity promotion. Return typed `room_unavailable` for terminal rooms and add a ticket-before-terminal/attach-after-terminal race test.

### 9. High: A failed socket send can block terminal cleanup indefinitely

Locations:

- `apps/worker/src/game/ott-game-server.ts:577-580`
- `apps/worker/src/game/ott-game-server.ts:645-667`

`broadcastState()` succeeds only when every recipient send returns successfully. A single stale or broken connection makes `publishCommitted()` postpone `terminalizeAllocation()`.

The design guarantees a server send attempt before discovery removal, not successful delivery to every socket. The current behavior can leave a terminal allocation publicly discoverable indefinitely.

Delegated task: proceed with terminalization after all final send attempts have been queued. Retry Lobby cleanup separately instead of retaining the allocation because one socket send failed.

### 10. High: Production active-match discovery is not integrated

Locations:

- `apps/web/src/app/App.tsx:317-320`
- `apps/web/src/sessions/online/OnlineLobbyGateway.ts:75-79`

Outside deterministic demos, `publicMatchState()` always returns `unavailable`. `listActiveMatches()` is not used, and no lobby provider subscription is created.

Even with the spectator test flag enabled, users cannot discover or select a match to watch.

Delegated task: because Task 7 remains blocked, either remove the completion claim and keep production integration disabled, or implement the planned single-provider lobby subscription only after the prerequisite runtime gate passes. Do not substitute polling.

### 11. High: Room-gone errors are ignored and transient failures become permanent

Locations:

- `apps/web/src/sessions/spectator/SpectatorSession.ts:175-188`
- `apps/web/src/sessions/spectator/SpectatorSession.ts:251-260`
- `apps/worker/src/game/ott-game-server.ts:504-507`

The session checks `payload.message`, while the Worker error envelope uses the `error` field. A genuine `room_unavailable` response can therefore leave the UI stuck.

Conversely, every ticket request failure, including network failures, overload, HTTP 429, or HTTP 503, is converted to a non-retryable `room_unavailable` error.

Delegated task: decode typed `error`, status, and code fields. Distinguish terminal/not-found outcomes from retryable transport and overload failures, and test both paths.

### 12. High: SpectatorSession does not validate the watch intent

Locations:

- `apps/web/src/sessions/spectator/SpectatorSession.ts:190-224`
- `apps/web/src/sessions/spectator/SpectatorSession.ts:264-284`

The ticket response is not checked against the requested allocation and room. Incoming state is not required to identify the intended room or an explicit spectator viewer before the session overwrites the normalized identity with `{ role: "spectator" }`.

A malformed gateway response can make the session hang or conceal a projection with the wrong role.

Delegated task: fail closed unless the ticket allocation, room, and every accepted projection match the watch intent and explicit spectator role. Add wrong-allocation, cross-room, player-projection, and pre-attach-state tests.

### 13. Medium: Bootstrap disposal can race pending initialization

Locations:

- `apps/web/src/sessions/online/runtimeBridge.ts:34-76`
- `packages/game-client/src/playhtml-bootstrap.js:26-100`

Disposal clears local state but does not invalidate or await a pending bootstrap. The stale promise may later set `ready = true` or install its global connection factory after disposal.

Delegated task: add a lifecycle epoch or serialize bootstrap and disposal. Clean up rejected initialization and test dispose-during-init, failed init, and concurrent rebind behavior.

### 14. Medium: Waiting online players lose their viewer identity

Location:

- `apps/web/src/sessions/online/normalizeOnlineState.ts:123-140`

When the phase is `waiting`, the normalizer forces `viewerSeat` to `null`, even when the server provides `you: "A"` or `you: "B"`. This conflicts with the online-player contract and can bypass player-specific leave behavior.

Delegated task: preserve player identity and online capabilities during the waiting phase. Continue using phase checks to block moves and add waiting-room identity and leave-confirmation coverage.

### 15. Medium: Lobby rate limiting is global per action

Location:

- `apps/worker/src/lobby/ott-lobby-server.ts:81-87`

The key `rate:last:${action}` is shared by all callers. One anonymous caller can continuously consume the allowance for `active`, `spectate`, or player control actions and force every other caller to receive HTTP 429.

Delegated task: include a trusted client or edge classification in each rate-limit key and add concurrent-client coverage proving that one caller cannot consume another caller's allowance.

### 16. Medium: Consumed capability nonce records grow without bound

Locations:

- `apps/worker/src/auth/internal-auth.ts:547-552`
- `apps/worker/src/game/ott-game-server.ts:548-555`

Every consumed spectator ticket creates a durable nonce key containing its expiry, but no cleanup path removes expired nonce records. Storage grows with the total historical number of spectator attachments.

Delegated task: implement expiry-aware nonce garbage collection while preserving replay protection and proof required by live attachments. Test repeated attach/close cycles with controlled time and bounded storage.

### 17. Medium: Deterministic spectator demos do not fully represent the intended flow

Locations:

- `apps/web/src/sessions/demo/scenarios.ts:155-157`
- `apps/web/src/features/lobby/OnlineRoomPanel.tsx:82`

The `spectator-finished` fixture uses `{ winner: null, reason: "goal" }`, which can render a no-winner result instead of the winning player's name.

The `spectator-list` demo disables the watch action when the production online gateway is unavailable, so the primary deterministic demo path cannot enter the selected match without an injected fake available gateway.

Delegated task: assign a real winner to the finished fixture and allow deterministic demo watch intent without opening a transport. Add App-level tests using the default unavailable production gateway.

## Recommendation

**REQUEST CHANGES**

The highest-priority work is:

1. restore the fail-closed feature boundary;
2. correct handoff and rollout claims;
3. repair provider/session lifecycle and reconnect behavior;
4. fix public summary generation and terminal ordering;
5. make the acceptance Worker config runnable;
6. add focused regression tests for the lifecycle and authority races listed above.
