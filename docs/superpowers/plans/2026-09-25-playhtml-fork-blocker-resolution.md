# PlayHTML Fork Blocker Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hoàn thiện multiplayer authoritative bằng một fork PlayHTML self-hosted đã pin, để create/join/list/reconnect hoạt động qua cùng PlayHTML connection mà không cho client ghi state ván.

**Architecture:** Vendor fork worker PlayHTML ở revision `dc2a248839e52e60da796c0df359b8ed506028a1` và giữ handler PlayHTML/Yjs upstream nguyên trạng. Một extension bridge duy nhất nhận/ghi các frame `ott:*` trên connection đó, routing chúng tới lobby authority hoặc game room `Room`; game state không đi qua CRDT/page data/event/presence. Lobby cấp mã phòng durable, mỗi game room persist `Room` state và dùng PartyKit alarm duy nhất cho clock/reconnect deadlines; browser bootstrap PlayHTML tạo connection factory duy nhất cho `PlayhtmlGameClient`.

**Tech Stack:** Node.js >= 18, CommonJS/UMD browser JavaScript, PartyKit `0.0.115`, PlayHTML `2.15.0`, vendored PlayHTML worker commit `dc2a248839e52e60da796c0df359b8ed506028a1`, `node:test`.

---

## Mandatory Invariants

- `rules.js` và `Room` là authority duy nhất cho luật, ghế, đồng hồ và thắng thua.
- PlayHTML worker upstream phải tiếp tục xử lý protocol Yjs/PlayHTML của nó; OTT chỉ dùng extension bridge đã kiểm chứng, không thay protocol upstream bằng implementation tự đoán.
- Không tạo `new WebSocket`, `partysocket` thứ hai hoặc HTTP polling cho state ván.
- Không dùng `pageData`, element data, `can-play`, `can-mirror`, PlayHTML event hoặc presence để ghi quân, lượt, clock, winner, ghế, token hoặc waiting list.
- Mỗi request client có giới hạn 8KB và 40ms per connection trước khi chạm `Room`.
- Resume token opaque: chỉ gửi cho đúng connection vừa create/join/resume thành công, không nằm trong snapshot/lobby/log/document/presence.
- Một game room chỉ có một durable PartyKit alarm: luôn schedule deadline sớm nhất giữa running clock và reconnect deadlines. Không dùng process `setTimeout` cho production authority.
- `ott:state` mang `revision` tăng đơn điệu; events có `id` tăng đơn điệu. Client bỏ revision cũ và chỉ chạy cosmetic cho event ID chưa thấy.

## File Structure

| File | Responsibility |
| --- | --- |
| `partykit/vendor/playhtml/` | Fork source upstream tối thiểu, copy nguyên trạng tại revision lock và giữ license/notices. |
| `partykit/playhtml-base.js` | Adapter hẹp quanh API upstream đã vendor; chỉ điểm tích hợp allowed với protocol PlayHTML. |
| `partykit/playhtml-ott-bridge.js` | Demultiplex frame upstream/`ott:*`, map connection lifecycle, không giữ game state. |
| `partykit/ott-lobby.js` | Durable lobby PartyKit server: allocate IDs, public waiting list, route protocol request tới game room. |
| `partykit/ott-room.js` | Game-room PartyKit server: `Room`, validation dispatch, persistence, authoritative snapshots, alarm. |
| `partykit/lobby.js` | Pure durable-registry helpers/public projection shared by lobby worker tests. |
| `partykit/room-storage.js` | Versioned validated serialize/hydrate schema. |
| `partykit/protocol.js` | Pure OTT command/response schemas, rate-limit, version/event helpers. |
| `playhtml-bootstrap.js` | Browser-only PlayHTML init and verified connection factory registration. |
| `playhtml-game-client.js` | Browser game adapter; no direct transport construction. |
| `tests/playhtml-bridge.test.js` | Fork compatibility and upstream/OTT frame isolation. |
| `tests/ott-lobby.test.js` | Durable allocation/list/routing and privacy tests. |
| `tests/partykit-room.test.js` | Room lifecycle, alarm, storage, revisions and authorization tests. |
| `tests/playhtml-game-client.test.js` | Bootstrap/factory adapter, resume, revision/event idempotency tests. |

## Task 1: Vendor The Pinned PlayHTML Worker And Prove The Extension Boundary

**Files:**
- Create: `partykit/vendor/playhtml/NOTICE.md`
- Create: `partykit/vendor/playhtml/` files copied from exact upstream worker revision
- Create: `partykit/playhtml-base.js`
- Create: `tests/playhtml-bridge.test.js`
- Modify: `docs/playhtml-upstream-lock.md`, `package.json`, `partykit.json`

- [ ] **Step 1: Inspect the exact installed and upstream worker contract**
  - Read `node_modules/playhtml/package.json`, installed declarations/runtime and the upstream commit named in `docs/playhtml-upstream-lock.md`.
  - Record the exact upstream worker entry file, connection lifecycle method signatures, frame decoding/encoding location, persistence modules and license headers.
  - Do not use `main`, `latest`, a new tag or an unpinned tarball.

- [ ] **Step 2: Copy the minimal required upstream worker sources verbatim**
  - Vendor only the runtime files required to run PlayHTML self-hosted plus their required internal imports.
  - Preserve copyright/license headers and add `NOTICE.md` containing upstream repository URL, commit SHA, source paths, license and local modification policy.
  - Do not edit vendored files except mechanically adjusted import paths required by the fork; list every such adjustment in `NOTICE.md`.

- [ ] **Step 3: Write failing bridge isolation tests**
  - Add a fake upstream server that records input frames and outputs frames.
  - Verify a non-OTT upstream frame reaches the upstream handler byte-for-byte.
  - Verify `ott:ping` reaches the OTT dispatcher and never reaches the upstream handler.
  - Verify a malformed OTT JSON frame produces only `ott:error`, does not reach upstream and does not mutate dispatcher state.
  - Verify an upstream frame that happens to contain the text `ott:` but is not the defined OTT envelope remains upstream traffic.

- [ ] **Step 4: Run bridge tests to verify RED**
  ```bash
  node --test tests/playhtml-bridge.test.js
  ```
  Expected: FAIL because the base adapter/bridge does not exist.

- [ ] **Step 5: Implement the narrow base adapter**
  - `partykit/playhtml-base.js` exports only the verified factory/handler surface required by the bridge.
  - Do not expose upstream CRDT store to OTT code.
  - Configure `partykit.json` to the fork-compatible worker entry only after the entry exists.

- [ ] **Step 6: Implement frame demultiplexing**
  - Define a strict OTT envelope unambiguous from the verified upstream protocol, based on the real frame decoder found in Step 1.
  - Route only that envelope to a callback supplied by the authoritative layer.
  - Forward every other frame unchanged through the upstream server.
  - Ensure the bridge has no `Room`, lobby map or game state dependency.

- [ ] **Step 7: Verify GREEN and run a local compatibility smoke test**
  ```bash
  node --test tests/playhtml-bridge.test.js
  rtk npx partykit dev --port 1999
  ```
  Expected: bridge tests pass; PartyKit starts with no module/entrypoint error. Keep the dev process running only long enough to open a minimal page that runs `await playhtml.init({ host })` in two browser profiles and prove one non-game PlayHTML primitive syncs. Remove the primitive after the check.

- [ ] **Step 8: Update lock evidence and commit**
  - Update `docs/playhtml-upstream-lock.md` with the verified extension envelope, test evidence, vendored files and smoke-test result.
  ```bash
  git add partykit/vendor/playhtml partykit/playhtml-base.js tests/playhtml-bridge.test.js docs/playhtml-upstream-lock.md partykit.json package.json package-lock.json
  git commit -m "feat: vendor pinned PlayHTML worker bridge"
  ```

## Task 2: Make Protocol Responses Ordered And Safe For Replay

**Files:**
- Modify: `partykit/protocol.js`, `tests/partykit-protocol.test.js`
- Modify: `room.js`, `tests/room.test.js`

- [ ] **Step 1: Write failing tests for revision/event allocation**
  - A newly created Room has `revision === 0` and `nextEventId === 1`.
  - Every state-changing action accepted by `Room` increments revision exactly once.
  - Every emitted Room event has a numeric positive `id`, unique within the room, including timeout, leave and disconnect timeout events.
  - Invalid commands, rejected moves and ping do not increment revision or event counter.

- [ ] **Step 2: Run focused tests to verify RED**
  ```bash
  node --test tests/room.test.js tests/partykit-protocol.test.js
  ```
  Expected: FAIL because snapshots/events do not yet carry ordered IDs.

- [ ] **Step 3: Implement minimal ordered metadata in Room**
  - Keep revision/event counter on `Room`, not client input.
  - Centralize assignment when `lastEvents` is committed so all terminal paths behave uniformly.
  - Add `revision` to `Room.payload()` and persist it later in Task 5.
  - Do not alter rules, piece shapes or existing public state semantics.

- [ ] **Step 4: Extend protocol response helpers**
  - Add a pure response shape predicate or encoder for `ott:state` requiring `revision` integer and events with unique integer IDs.
  - Do not accept revision/event IDs from a client command.

- [ ] **Step 5: Verify and commit**
  ```bash
  node --test tests/room.test.js tests/partykit-protocol.test.js
  git add room.js partykit/protocol.js tests/room.test.js tests/partykit-protocol.test.js
  git commit -m "feat: order authoritative state snapshots"
  ```

## Task 3: Implement The Durable Lobby Party And Game-Room Routing

**Files:**
- Create: `partykit/ott-lobby.js`
- Modify: `partykit/lobby.js`, `partykit/playhtml-ott-bridge.js`, `partykit/ott-room.js`, `partykit.json`
- Create: `tests/ott-lobby.test.js`
- Modify: `tests/lobby.test.js`, `tests/partykit-room.test.js`

- [ ] **Step 1: Verify PartyKit context-party routing API at the pinned runtime**
  - Read the installed `partykit` declaration/runtime for `room.context.parties` and select the exact method that addresses a named party by ID.
  - Record this internal contract in a concise comment beside the routing adapter; do not guess URL shapes or cross-room APIs.

- [ ] **Step 2: Write failing durable lobby tests**
  - `ott:create` allocates one unique 4-character room code, creates a waiting record and returns `ott:joined` with that code only to the creator.
  - `ott:list` returns only waiting rooms with `{ id, players, names }`; it excludes tokens, connection IDs, room state and internal storage keys.
  - `ott:join` routes to the named game room and returns a stable error for unknown/non-waiting ID without creating a replacement room.
  - A room transitioning waiting -> playing disappears from list; an eligible waiting room reappears only if the authority explicitly defines that state transition.
  - Create collisions retry against durable storage; no process-global `Map` is used.

- [ ] **Step 3: Run lobby tests to verify RED**
  ```bash
  node --test tests/lobby.test.js tests/ott-lobby.test.js
  ```
  Expected: FAIL because no runtime lobby server/routing exists.

- [ ] **Step 4: Implement `OttLobby` as its own PartyKit server**
  - Construct `WaitingRoomRegistry` with the lobby PartyKit storage.
  - Authenticate/parse only through `parseClientMessage` and rate limit by connection ID.
  - On `ott:create`, allocate durable ID before creating or addressing the game room; pass only sanitized requested name through the server-side route.
  - On `ott:list`, derive and send public projection from registry.
  - On `ott:join`/`ott:resume`, address the named game room through the verified PartyKit context API; never trust caller-provided player/seat/token metadata beyond validated command fields.

- [ ] **Step 5: Integrate game room lifecycle callbacks**
  - Inject a narrow lobby notifier into `OttRoom`, not the registry object itself.
  - Publish waiting record after first seat joins.
  - Remove record immediately once B joins/playing begins, explicit leave ends the game, or reconnect grace produces terminal result.
  - Make callbacks idempotent so alarm retry/instance recreation cannot leak stale waiting rooms.

- [ ] **Step 6: Configure named parties and bridge routing**
  - Register lobby and game party names exactly as required by PartyKit `0.0.115` configuration.
  - Extend bridge only to select lobby versus game target from verified route metadata; it must still preserve upstream frames.
  - Do not expose a user-selectable arbitrary PartyKit URL in browser code.

- [ ] **Step 7: Verify and commit**
  ```bash
  node --test tests/lobby.test.js tests/ott-lobby.test.js tests/partykit-room.test.js
  git add partykit/ott-lobby.js partykit/lobby.js partykit/playhtml-ott-bridge.js partykit/ott-room.js partykit.json tests/lobby.test.js tests/ott-lobby.test.js tests/partykit-room.test.js
  git commit -m "feat: route authoritative rooms through durable lobby"
  ```

## Task 4: Replace Process Timers With One Durable PartyKit Alarm

**Files:**
- Modify: `partykit/ott-room.js`, `partykit/room-storage.js`
- Modify: `tests/partykit-room.test.js`

- [ ] **Step 1: Write failing alarm scheduling tests**
  - Starting a game calls `storage.setAlarm(clockDeadline)` once for the active seat’s absolute deadline.
  - Disconnecting a player schedules the earlier of clock deadline and reconnect deadline.
  - Resume clears the reconnect deadline and reschedules the active clock deadline.
  - `onAlarm()` settles wall-clock time, expires every eligible reconnect deadline, broadcasts one terminal state/gameover when needed, persists once and schedules the next deadline when game remains active.
  - A terminal room clears the alarm and never restarts its clock.

- [ ] **Step 2: Run focused test to verify RED**
  ```bash
  node --test tests/partykit-room.test.js
  ```
  Expected: FAIL because current wrapper stores callback objects and does not deterministically compute/clear the next durable deadline.

- [ ] **Step 3: Implement a single deadline calculator**
  - Add a pure helper returning the minimum valid absolute deadline from running-seat remaining time and disconnected-player deadlines.
  - Store no timer handles in durable data.
  - In production PartyKit adapter, call `storage.setAlarm(deadline)` or `storage.deleteAlarm()` only through this centralized method.
  - Keep injected scheduler only for deterministic unit tests; its behavior must mirror the absolute deadline model.

- [ ] **Step 4: Make `onAlarm()` authoritative**
  - Load/hydrate first if necessary.
  - Call `Room.settleClock(now)` and `Room.expireReconnect(now)` before broadcasting.
  - Persist/broadcast exactly once if state changed; then schedule the next deadline.
  - Do not call production `setTimeout` or rely on an in-memory callback surviving hibernation.

- [ ] **Step 5: Verify and commit**
  ```bash
  node --test tests/partykit-room.test.js tests/room.test.js
  git add partykit/ott-room.js partykit/room-storage.js tests/partykit-room.test.js
  git commit -m "fix: schedule authority with PartyKit alarms"
  ```

## Task 5: Validate Persistence Fully And Fail Closed

**Files:**
- Modify: `partykit/room-storage.js`, `partykit/ott-room.js`
- Modify: `tests/partykit-room.test.js`

- [ ] **Step 1: Write corrupt-storage tests**
  - Reject wrong `status`, missing/invalid clock, fractional/negative remaining clock, invalid turn/winner/reason, malformed piece list, duplicate piece IDs/occupancy, invalid player seat/name/token, invalid reconnect deadline, and terminal room with running clock.
  - Reject saved revision/event IDs that are negative, non-integer or inconsistent with stored events.
  - On invalid saved data, worker sends stable server error/marks room unusable without creating an initial game over corrupted identity.

- [ ] **Step 2: Run test to verify RED**
  ```bash
  node --test tests/partykit-room.test.js
  ```
  Expected: FAIL because hydration currently checks only top-level presence/schema ID.

- [ ] **Step 3: Implement explicit schema validation**
  - Use small predicates in `room-storage.js`; do not introduce a broad dependency for a small fixed schema.
  - Validate a clone before constructing `Room` and before assigning any restored property.
  - Persist `revision`, next event ID, absolute `clockAnchorMs`, reconnect deadlines and terminal marker.
  - Rehydrate connections as `null`, timers as absent, and all persisted players disconnected if the actual PartyKit connection is not live.

- [ ] **Step 4: Verify and commit**
  ```bash
  node --test tests/partykit-room.test.js
  git add partykit/room-storage.js partykit/ott-room.js tests/partykit-room.test.js
  git commit -m "feat: validate persisted authoritative rooms"
  ```

## Task 6: Build The Verified Browser PlayHTML Transport Factory

**Files:**
- Create: `playhtml-bootstrap.js`
- Modify: `index.html`, `playhtml-game-client.js`, `playhtml-game.html`
- Modify: `tests/playhtml-game-client.test.js`
- Modify: `README.md`, `.env.example`

- [ ] **Step 1: Inspect installed PlayHTML runtime for the verified connection surface**
  - Inspect the exact installed `playhtml@2.15.0` declarations/runtime plus the fork in Task 1.
  - Identify how the browser connection is opened, how raw custom frames are sent/received and what lifecycle hooks are supported.
  - If raw custom frames cannot be exposed without bypassing PlayHTML, stop and correct Task 1’s fork bridge. Do not add a native WebSocket fallback.

- [ ] **Step 2: Write failing bootstrap/factory tests**
  - Bootstrap calls `await playhtml.init({ host })` exactly once with explicit self-hosted host before factory resolves.
  - Factory returns only the adapter contract expected by `PlayhtmlGameClient`: `connect`, `send`, `on`, `close`.
  - Sending a game command produces the verified custom OTT envelope on the existing PlayHTML connection, not a new socket.
  - Incoming non-OTT PlayHTML traffic is ignored by game client; incoming valid OTT response is delivered.
  - Factory failure rejects connect and UI remains usable in local/AI mode.

- [ ] **Step 3: Run client tests to verify RED**
  ```bash
  node --test tests/playhtml-game-client.test.js
  ```
  Expected: FAIL because bootstrap/factory does not exist.

- [ ] **Step 4: Implement `playhtml-bootstrap.js`**
  - Load the exact pinned PlayHTML browser module through a controlled local build/import path, not `unpkg`/`latest`.
  - Read public `OTT_PLAYHTML_HOST` build/runtime config only; never expose worker secret values.
  - Initialize once, await initial sync, then assign `window.OTT_PLAYHTML_CONNECTION_FACTORY`.
  - Do not create or write page/element data for game state.

- [ ] **Step 5: Harden `PlayhtmlGameClient` ordering**
  - Normalize `roomId` on every joined/state path.
  - Keep `lastRevision`; ignore `ott:state` with revision lower than or equal to the last accepted revision.
  - Maintain a bounded set of applied event IDs; pass only unseen events to UI and evict oldest IDs deterministically.
  - Clear token only after explicit `ott:left`, terminal failure, or a stable resume rejection code, never after ordinary command error.

- [ ] **Step 6: Load bootstrap before game UI and document configuration**
  - Add `playhtml-bootstrap.js` before `playhtml-game-client.js`/`game.js`.
  - Show an explicit unavailable status when bootstrap has not connected; do not throw during page load.
  - Update `playhtml-game.html`, `README.md` and `.env.example` with self-host host setup and no-secret rule.

- [ ] **Step 7: Verify and commit**
  ```bash
  node --test tests/playhtml-game-client.test.js
  node --check playhtml-bootstrap.js
  node --check playhtml-game-client.js
  git add playhtml-bootstrap.js playhtml-game-client.js index.html playhtml-game.html tests/playhtml-game-client.test.js README.md .env.example
  git commit -m "feat: connect game adapter through PlayHTML fork"
  ```

## Task 7: Integrate UI Create/Join/List/Reconnect With Authoritative Routing

**Files:**
- Modify: `game.js`, `playhtml-game-client.js`, `tests/playhtml-game-client.test.js`
- Modify: `tests/partykit-room.test.js`, `tests/ott-lobby.test.js`

- [ ] **Step 1: Write failing end-to-end adapter tests**
  - Client connects to lobby, creates a room, receives authoritative `ott:joined` room ID and stores only its own normalized token.
  - Client lists waiting rooms, joins selected code, gets B seat, and does not infer state locally.
  - A reconnect receives `ott:joined` with `resumed`, then an increasing state revision.
  - A direct move from unseated connection gets `ott:error` and no revision increment.
  - An old `ott:state` does not overwrite newer UI state; duplicate event ID does not duplicate client-visible `events`.

- [ ] **Step 2: Run tests to verify RED**
  ```bash
  node --test tests/playhtml-game-client.test.js tests/ott-lobby.test.js tests/partykit-room.test.js
  ```
  Expected: FAIL until lobby routing and revision-aware client behavior are wired together.

- [ ] **Step 3: Make UI transport state explicit**
  - Rename any remaining generic `pf` variable to `onlineClient` only if it can be changed without broad churn.
  - Keep selection/highlighting local, but online `attemptMove` must only call `onlineClient.move(from, to)`.
  - Update online `app.state`, names, status, clock baseline and events only from accepted authoritative `ott:state`.
  - List formatting must accept the public lobby `{ names: { A?, B? } }` shape.

- [ ] **Step 4: Verify and commit**
  ```bash
  node --test tests/playhtml-game-client.test.js tests/ott-lobby.test.js tests/partykit-room.test.js
  git add game.js playhtml-game-client.js tests/playhtml-game-client.test.js tests/ott-lobby.test.js tests/partykit-room.test.js
  git commit -m "feat: wire UI to authoritative lobby routing"
  ```

## Task 8: Security, Acceptance, Documentation And Cleanup

**Files:**
- Modify: `server.js`, `README.md`, `CLAUDE.md`, `CONTEXT.md`, `PRODUCT.md`, `docs/PLAYHTML_AI_GUIDE.md`, `docs/playhtml-upstream-lock.md`
- Modify: `tests/partykit-protocol.test.js`, `tests/partykit-room.test.js`, `tests/ott-lobby.test.js`

- [ ] **Step 1: Write missing security regression tests**
  - Oversized/malformed/rate-limited commands do not mutate room revision, clock owner, seats or lobby data.
  - Token reuse from a different connection is rejected; token never appears in lobby/list/state messages.
  - Static server returns 403 for `/partykit/ott-room.js`, `/tests/...`, `.env`, package manifests and path traversal.
  - Client-side PlayHTML data mutation attempts cannot change authoritative game state.

- [ ] **Step 2: Run security tests to verify RED where coverage is absent**
  ```bash
  node --test tests/partykit-protocol.test.js tests/partykit-room.test.js tests/ott-lobby.test.js
  ```
  Expected: newly added cases fail until missing guards/tests are implemented.

- [ ] **Step 3: Implement only identified guards**
  - Keep protocol rejection before authority dispatch.
  - Keep private worker source denied by static host.
  - Do not add client-side authority checks as a substitute for worker validation.

- [ ] **Step 4: Run complete deterministic verification**
  ```bash
  node --check config.js
  node --check rules.js
  node --check room.js
  node --check server.js
  node --check partykit/playhtml-base.js
  node --check partykit/playhtml-ott-bridge.js
  node --check partykit/ott-lobby.js
  node --check partykit/ott-room.js
  node --check partykit/room-storage.js
  node --check playhtml-bootstrap.js
  node --check playhtml-game-client.js
  npm test
  git diff --check
  ```
  Expected: every syntax check exits 0; all tests pass; no whitespace errors.

- [ ] **Step 5: Perform and record two-profile acceptance**
  - Start static server and self-hosted PartyKit fork using documented commands.
  - In two independent browser profiles: create/list/join; verify A/B seats/names; legal/wrong-turn/invalid moves; goal/elimination/no-moves; timeout; explicit leave; disconnect/reload/resume within grace; reconnect expiry.
  - Verify late join cannot alter active game and reload never obtains another player token.
  - Verify local and AI still work when PartyKit endpoint is unavailable.
  - Record date, pinned version, host, scenarios and results in `docs/playhtml-upstream-lock.md` or a dedicated acceptance note. Do not mark an unperformed scenario passed.

- [ ] **Step 6: Remove stale legacy documentation**
  - Update `CONTEXT.md` and `PRODUCT.md` so Playfull/WebSocket are historical only or removed entirely.
  - Ensure README and CLAUDE module boundaries name PlayHTML fork/PartyKit authority and bootstrap factory.
  - Retain the guardrail that no PlayHTML data primitive mutates game state.

- [ ] **Step 7: Verify no active legacy transport references and commit**
  ```bash
  rg -n "Playfull|playfull\\.js|new WebSocket|WebSocketServer" --glob "!docs/superpowers/**" --glob "!docs/playhtml/**"
  git add server.js README.md CLAUDE.md CONTEXT.md PRODUCT.md docs/PLAYHTML_AI_GUIDE.md docs/playhtml-upstream-lock.md tests
  git commit -m "docs: verify PlayHTML authoritative rollout"
  ```
  Expected: search has no active production references; any intentional historical mention is removed or moved under the excluded plan/history documentation.

## Rollout Gates

- [ ] Fork source, license, commit SHA and extension envelope are documented and compatibility-tested.
- [ ] PlayHTML initial sync and OTT frame transport use the same verified self-hosted connection.
- [ ] Lobby allocates/routes rooms durably; create/list/join/resume works without a process-global game registry.
- [ ] All authoritative timers use PartyKit durable alarm semantics and survive hydration.
- [ ] Invalid persisted data fails closed.
- [ ] State snapshots are revision ordered and cosmetic events are idempotent.
- [ ] All deterministic tests pass.
- [ ] Manual two-profile acceptance is recorded and passes.
- [ ] No gameplay state is client-writeable through PlayHTML primitives.
- [ ] Static host does not serve worker/source/tests/package/environment files.
