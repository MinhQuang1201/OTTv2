# PlayHTML Authoritative Multiplayer Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thay transport online Playfull/WebSocket hiện tại bằng worker PartyKit self-hosted tương thích PlayHTML, trong khi giữ `rules.js` và `Room` là nguồn chuẩn duy nhất cho luật, ghế, đồng hồ và kết quả ván.

**Architecture:** Mỗi PartyKit room chạy một instance authoritative của `Room`; worker nhận command từ client, xác thực ghế theo connection/resume token, gọi `Room`, rồi broadcast snapshot do `Room.payload()` tạo ra. PlayHTML vẫn kết nối tới worker self-hosted cho các primitive riêng của thư viện, nhưng state ván không được lưu hoặc ghi bằng `pageData`, `can-play`, `can-mirror`, event hay presence. Client dùng một adapter `PlayhtmlGameClient` có surface gần tương đương `Playfull`, giúp `game.js` chỉ thay đổi điểm khởi tạo transport.

**Tech Stack:** Node.js >= 18; JavaScript CommonJS/UMD hiện có; PartyKit; PlayHTML version pin; `node:test`; browser JavaScript; PlayHTML self-hosted worker.

---

## Quyết Định Bắt Buộc

- `rules.js` tiếp tục là luật thuần, không I/O, dùng cho local, AI và authoritative online.
- `room.js` tiếp tục sở hữu ghế A/B, clock, reconnect grace 60 giây, kết quả `leave`, `timeout`, `disconnect_timeout`.
- Worker PartyKit là runtime online authoritative duy nhất; không giữ một Node WebSocket server thứ hai cho state ván.
- `server.js` sau migration chỉ static-host HTML/CSS/JS/assets và không chứa WebSocket game.
- Client không gọi `setData()` để ghi `state`, `players`, `clock`, `winner`, lịch sử nước đi hoặc danh sách phòng.
- `playhtml.users`, cursor và presence không phải authentication/authorization. Chúng chỉ phục vụ identity hiển thị và trạng thái ephemeral.
- Không dùng public PlayHTML host cho production: dữ liệu trên public service không được mã hóa, library beta và hạ tầng không thuộc OTTv2.
- Pin chính xác PlayHTML revision/package version, PartyKit version và worker source tương thích. Không dùng `latest`, `^` hoặc copy code từ `main` không khóa commit.
- Không dùng `can-mirror` cho bàn cờ hoặc state game.
- Không tự tạo WebSocket client bổ sung cho game. `PlayhtmlGameClient` phải sử dụng cùng connection/protocol có trong PlayHTML worker extension đã được kiểm chứng.

## Ranh Giới State

| Dữ liệu | Owner | Primitive / vị trí | Persistence |
| --- | --- | --- | --- |
| Quân, lượt, winner, reason, clock, sự kiện nước đi | `Room` trong worker | authoritative memory/storage của PartyKit room | Theo lifecycle authoritative room |
| Ghế A/B, tên đã sanitize, token reconnect, trạng thái connected | `Room` trong worker | authoritative room state | Theo lifecycle authoritative room |
| Danh sách phòng đang chờ | Lobby authority worker | snapshot server-to-client | Ephemeral/queryable, không client-write |
| Cursor, trạng thái đang xem bàn | PlayHTML | presence/awareness | Ephemeral |
| Hiệu ứng ăn quân, đòn thua, toast, âm thanh | Client | render từ authoritative `events` | Không persistent |
| Tên nhập trước khi join, quân đang chọn, ô hợp lệ, modal, animation | Browser | local variables/DOM/localStorage | Local-only |

## Protocol Authority

### Client Commands

| Command | Payload | Điều kiện |
| --- | --- | --- |
| `ott:list` | không có | Connection đã mở |
| `ott:create` | `{ name }` | Tên được sanitize trong worker |
| `ott:join` | `{ roomId, name }` | Mã phòng normalize uppercase |
| `ott:resume` | `{ roomId, resumeToken }` | Token opaque, không log |
| `ott:move` | `{ from: { x, y }, to: { x, y } }` | Bốn tọa độ là integer |
| `ott:leave` | không có | Ghế đang giữ bị xử thua ngay |
| `ott:ping` | không có | Không đổi state game |

### Worker Responses

| Message | Người nhận | Nội dung |
| --- | --- | --- |
| `ott:hello` | connection mới | Danh sách phòng chờ |
| `ott:rooms` | requester hoặc lobby subscribers | Danh sách phòng chờ server-derived |
| `ott:joined` | player vừa tạo/join/resume | `roomId`, `you`, `name`, `resumeToken`, `players`, `status`, `resumed` |
| `ott:state` | từng ghế connected | `roomId`, `you`, `status`, `serverNow`, `players`, public `state`, `events` |
| `ott:gameover` | ghế connected | `winner`, `reason`, `eliminatedPlayer` |
| `ott:left` | player leave | Xác nhận local state phải bị xóa |
| `ott:error` | requester | `{ message, code? }` |
| `ott:pong` | requester | Phản hồi keepalive |

### Invariants Protocol

- Mọi `ott:state` được xây từ `Room.payload()`, không từ payload client.
- `ott:move` chỉ gọi `Room.handleMove(connectionAdapter, from, to)`.
- Invalid command không đổi `Room.state`, `turn`, clock owner hay seat.
- Mỗi connection rate-limit tối thiểu 40 ms/packet, payload tối đa 8 KB.
- Worker kiểm tra `Number.isInteger` cho toàn bộ tọa độ trước khi gọi `Room`.
- `close` gọi `Room.disconnectPlayer`; `ott:leave` gọi `Room.leavePlayer`.
- Worker không bao giờ gửi `resumeToken` cho connection khác.
- Client xử lý message out-of-order an toàn: chỉ render snapshot worker; cosmetic event phải idempotent.

## File Structure

| File | Thay đổi | Trách nhiệm |
| --- | --- | --- |
| `package.json` | Modify | Scripts/dependencies PartyKit, PlayHTML version pin, test scripts |
| `partykit.json` | Create | Entry point, compatibility date, local/dev config |
| `partykit/ott-room.js` | Create | PartyKit authoritative room: connection lifecycle, protocol, broadcast, timers |
| `partykit/lobby.js` | Create | Registry/listing phòng chờ và routing create/join |
| `partykit/playhtml-base.js` | Create | Điểm tích hợp duy nhất với worker PlayHTML upstream đã pin |
| `partykit/connection.js` | Create | Adapter PartyKit connection sang interface `Room` cần |
| `partykit/protocol.js` | Create | Constants, schema predicates, encode/decode error helpers |
| `partykit/room-storage.js` | Create | Serialize/hydrate state authoritative |
| `room.js` | Modify | Tách phụ thuộc `ws`; nhận connection-like object |
| `server.js` | Modify | Bỏ WebSocketServer; chỉ static files |
| `playhtml-game-client.js` | Create | Adapter browser cho authoritative commands/events |
| `game.js` | Modify | Dùng `PlayhtmlGameClient`; không sửa luật online |
| `index.html` | Modify | Load client PlayHTML, bỏ `playfull.js` |
| `tests/partykit-protocol.test.js` | Create | Validation/rate-limit/authorization protocol |
| `tests/partykit-room.test.js` | Create | Lifecycle PartyKit authoritative |
| `tests/lobby.test.js` | Create | Waiting-room authority |

### Task 1: Compatibility Spike Và Version Lock

**Files:**
- Create: `docs/playhtml-upstream-lock.md`
- Modify: `package.json`, `package-lock.json`
- Create: PartyKit config theo version được chọn

- [ ] **Step 1: Xác định upstream worker thật sự của PlayHTML**
  - Clone/fetch source PlayHTML tại một commit cụ thể.
  - Xác minh package/workspace chứa worker, package manifest, entry point, PartyKit API version, protocol và persistence behavior.
  - Ghi commit SHA, license và các file upstream được vendor/fork vào `docs/playhtml-upstream-lock.md`.

- [ ] **Step 2: Kiểm tra extension point**
  - Xác minh worker có hook cho custom message type hoặc fork an toàn mà không phá PlayHTML protocol.
  - Xác minh custom messages không bị client bỏ/ghi đè.
  - Nếu không có extension point, dừng migration; không nhét game protocol vào `pageData`, event hay CRDT document.

- [ ] **Step 3: Pin dependency và scripts**
  - Add exact version, không caret/range, cho PlayHTML, PartyKit và worker dependencies.
  - Add `dev:game`, `dev:partykit`, `test:unit` và `test`.

- [ ] **Step 4: Smoke check self-host**
  - Chạy worker local; load page tối giản dùng `await playhtml.init({ host })`.
  - Xác nhận initial sync và một primitive thử nghiệm đồng bộ trên hai browser profile.
  - Xóa primitive thử nghiệm.

- [ ] **Step 5: Commit**
  ```bash
  git add package.json package-lock.json partykit.json docs/playhtml-upstream-lock.md
  git commit -m "chore: pin PlayHTML PartyKit runtime"
  ```

### Task 2: Tách Room Khỏi `ws`

**Files:**
- Modify: `room.js`, `tests/room.test.js`
- Create: `partykit/connection.js`

- [ ] **Step 1: Write failing connection abstraction tests**
  - Tạo fake PartyKit connection có `id`, `send` và trạng thái open/closed.
  - Xác nhận `Room.addPlayer`, `seatOf`, `handleMove`, `disconnectPlayer`, `leavePlayer`, `resumePlayer` không phụ thuộc class `ws`.

- [ ] **Step 2: Run targeted test**
  ```bash
  node --test tests/room.test.js
  ```
  Expected: FAIL trước refactor.

- [ ] **Step 3: Implement minimal refactor**
  - Đổi contract từ `ws` sang connection-like object.
  - Không import PartyKit vào `room.js`; giữ module runnable trong Node tests.
  - Không đổi luật, error text hoặc behavior.

- [ ] **Step 4: Verify**
  ```bash
  npm test
  ```
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add room.js tests/room.test.js partykit/connection.js
  git commit -m "refactor: decouple room from websocket runtime"
  ```

### Task 3: Protocol Validation

**Files:**
- Create: `partykit/protocol.js`, `tests/partykit-protocol.test.js`
- Modify: `config.js` nếu cần hằng số shared protocol

- [ ] **Step 1: Write failing decoder tests**
  - Reject JSON malformed, non-object, missing/unsupported type và payload lớn hơn `MAX_MESSAGE`.
  - Reject move có `NaN`, float, string, missing coordinates hoặc nested malicious object.
  - Normalize `roomId` uppercase và kiểm tra `ROOM_ID_LEN`.
  - Xác nhận errors không leak token, stack trace hoặc private state.

- [ ] **Step 2: Write failing rate-limit tests**
  - Cùng connection gửi hai packet dưới 40 ms: packet thứ hai bị reject, handler không chạy.
  - Rate limit theo connection, không global.

- [ ] **Step 3: Implement decoder**
  - Centralize command allowlist, validation và stable error codes.
  - Tách `parseClientMessage(raw)` khỏi dispatch để test không cần PartyKit.

- [ ] **Step 4: Verify and commit**
  ```bash
  node --test tests/partykit-protocol.test.js
  git add partykit/protocol.js tests/partykit-protocol.test.js config.js
  git commit -m "feat: validate authoritative game protocol"
  ```

### Task 4: Authoritative PartyKit Room

**Files:**
- Create: `partykit/ott-room.js`, `tests/partykit-room.test.js`
- Modify: `partykit/connection.js`

- [ ] **Step 1: Write failing lifecycle tests**
  - First join gets A, `ott:joined`, waiting snapshot; second gets B and both get playing snapshot.
  - Third player is rejected without state change.
  - A opening C3 -> D2 broadcasts a valid snapshot to A/B; B moving on A turn is rejected.
  - Cover goal, elimination, no-moves, timeout, leave and disconnect timeout.

- [ ] **Step 2: Implement adapter**
  - Construct `Room(this.id, deps)` using PartyKit-compatible `now`, `schedule`, `cancel`, `onUpdate`.
  - Map connection to `Room` interface, parse commands, dispatch them and broadcast recipient-specific snapshots.
  - Never expose raw players, connections or tokens.
  - `ott:gameover` broadcasts exactly once.

- [ ] **Step 3: Verify and commit**
  ```bash
  node --test tests/partykit-room.test.js tests/room.test.js
  git add partykit/ott-room.js partykit/connection.js tests/partykit-room.test.js
  git commit -m "feat: run authoritative rooms in PartyKit"
  ```

### Task 5: Persistence, Hibernation Và Clock

**Files:**
- Create: `partykit/room-storage.js`
- Modify: `partykit/ott-room.js`, `tests/partykit-room.test.js`

- [ ] **Step 1: Define persisted schema**
  - Persist public game state, player metadata excluding live connection, status, clock anchor, reconnect deadline and terminal marker.
  - Never persist connection, timer handles, cursor/presence, selected piece or UI state.
  - Version schema with `schemaVersion: 1` and validate on hydration.

- [ ] **Step 2: Write failing hydrate tests**
  - Restore playing board/turn/clock correctly after instance recreation.
  - Settle clock from elapsed wall time; calculate reconnect grace from absolute deadline.
  - Terminal rooms do not restart clock.
  - Corrupt data fails closed.

- [ ] **Step 3: Implement and verify**
  ```bash
  node --test tests/partykit-room.test.js
  npm test
  ```

- [ ] **Step 4: Commit**
  ```bash
  git add partykit/room-storage.js partykit/ott-room.js tests/partykit-room.test.js
  git commit -m "feat: persist authoritative PartyKit rooms"
  ```

### Task 6: Lobby Authority

**Files:**
- Create: `partykit/lobby.js`, `tests/lobby.test.js`
- Modify: `partykit/ott-room.js`, `tests/partykit-room.test.js`

- [ ] **Step 1: Write failing tests**
  - Generate unique 4-character code using current alphabet.
  - `ott:list` only exposes waiting rooms with `id`, `players`, sanitized names.
  - List never exposes tokens, state, connection ids.
  - Update lobby when room starts, leaves, grace expires or is cleaned up.

- [ ] **Step 2: Implement durable registry**
  - Use verified PartyKit durable facilities; do not use process-global `Map`.
  - Publish updates when waiting-list membership changes.

- [ ] **Step 3: Verify and commit**
  ```bash
  node --test tests/lobby.test.js tests/partykit-room.test.js
  git add partykit/lobby.js partykit/ott-room.js tests/lobby.test.js tests/partykit-room.test.js
  git commit -m "feat: add authoritative waiting-room lobby"
  ```

### Task 7: Browser PlayHTML Adapter

**Files:**
- Create: `playhtml-game-client.js`
- Create: `tests/playhtml-game-client.test.js` when extracted logic is testable
- Modify: `index.html`

- [ ] **Step 1: Preserve a minimal app transport surface**
  - Methods: `connect`, `create`, `join`, `resume`, `list`, `move`, `leave`, `close`, `on`.
  - Events: `open`, `close`, `reconnecting`, `resumed`, `error`, `rooms`, `hello`, `joined`, `state`, `gameover`, `left`.

- [ ] **Step 2: Write failing adapter tests**
  - Map all `ott:*` responses to existing application events.
  - Store `resumeToken` only in `sessionStorage` scoped by normalized room id.
  - Clear token after explicit leave, rejection or terminal failure.
  - Reject malformed local move as defense-in-depth.

- [ ] **Step 3: Implement bootstrap and reconnect**
  - Import pinned PlayHTML package, initialize once with explicit self-hosted host.
  - Await initial sync before presence/users or game protocol operations.
  - Exponential reconnect capped at 2 seconds; send `ott:resume` on recovery.
  - No `createPageData` for game state.

- [ ] **Step 4: Verify and commit**
  ```bash
  git add playhtml-game-client.js index.html tests/playhtml-game-client.test.js
  git commit -m "feat: add PlayHTML authoritative game client"
  ```

### Task 8: Migrate UI And Retire Playfull

**Files:**
- Modify: `game.js`, `index.html`, `README.md`, `CLAUDE.md`, `server.js`
- Create: `playhtml-game.html`, `.env.example`
- Delete: `playfull.js`, `playfull.html`

- [ ] **Step 1: Replace transport construction**
  - Rename `bindPlayfull` to `bindOnlineClient`; construct `window.PlayhtmlGameClient`.
  - UI may calculate local selection/highlights but online path sends only `move(from, to)`.
  - UI updates online `app.state` only from authoritative state message.
  - Do not call `rules.applyMove` in online flow.

- [ ] **Step 2: Preserve behavior**
  - Create/join by code, waiting list, names, server clock interpolation, reconnect status, win dialog and leave behavior.
  - Local and AI modes remain independent from PartyKit availability.

- [ ] **Step 3: Remove legacy server**
  - Remove `WebSocketServer`, global room/socket maps and old handlers from `server.js`.
  - Preserve static path containment and prohibit source, tests, package files, node modules, environment files and worker secrets.

- [ ] **Step 4: Update documentation/configuration**
  - Document local PartyKit/static commands, production host variable and secrets policy.
  - Update module boundaries in `CLAUDE.md`.
  - Replace Playfull document with `playhtml-game.html` adapter documentation.

- [ ] **Step 5: Verify no active legacy references**
  ```bash
  rg -n "Playfull|playfull\\.js|new WebSocket|WebSocketServer" --glob "!docs/playhtml/**"
  ```
  Expected: no active production reference.

- [ ] **Step 6: Commit**
  ```bash
  git add game.js index.html README.md CLAUDE.md server.js playhtml-game-client.js playhtml-game.html .env.example
  git rm playfull.js playfull.html
  git commit -m "feat: migrate online UI to PlayHTML authority"
  ```

### Task 9: Optional Presence And Cursors

**Files:**
- Modify: `playhtml-game-client.js`, `game.js`, `index.html`, `style.css`

- [ ] **Step 1: Add only after authoritative gameplay passes**
  - Enable cursors once during PlayHTML init, attached to stable cursor container.
  - Verify installed type/runtime before advanced options.

- [ ] **Step 2: Optional selection channel**
  - Use presence channel `ott-selection` with `{ roomId, x, y }` or `null`.
  - Throttle; clear on deselect, leave and unmount.
  - Remote selection never changes local `app.selected`.

- [ ] **Step 3: Commit**
  ```bash
  git add playhtml-game-client.js game.js index.html style.css
  git commit -m "feat: add PlayHTML game presence"
  ```

### Task 10: Full Verification And Rollout

**Files:**
- Modify: `README.md`, `docs/PLAYHTML_AI_GUIDE.md`

- [ ] **Step 1: Static checks**
  ```bash
  node --check config.js
  node --check rules.js
  node --check room.js
  node --check server.js
  node --check game.js
  node --check playhtml-game-client.js
  ```
  Expected: all exit with status 0.

- [ ] **Step 2: Full deterministic tests**
  ```bash
  npm test
  ```
  Expected: existing rules/Room tests plus protocol/worker tests pass.

- [ ] **Step 3: Manual two-profile acceptance**
  - Create/join flow and waiting list work.
  - A/B receive correct seat/name and synchronized snapshots.
  - Legal, invalid and wrong-turn moves behave correctly.
  - Goal, elimination, no-moves, timeout, leave and reconnect grace all match current rules.
  - Reload and late join do not diverge state.
  - Local and AI modes work while PartyKit is unavailable.

- [ ] **Step 4: Security review**
  - Attempt client mutation through PlayHTML APIs: must not affect game.
  - Attempt direct move as unseated connection: rejected.
  - Attempt token reuse, oversized/rate-limited/malformed packet: rejected.
  - Confirm token is not rendered, logged, listed or saved outside scoped session storage.

- [ ] **Step 5: Update PlayHTML guide**
  - Add authoritative-game exception: PlayHTML data primitives must not mutate game authority; only worker protocol may do so.
  - Retain stable-id, presence, mutator, lifecycle and feedback-loop guardrails for non-game UI.

- [ ] **Step 6: Final commit**
  ```bash
  git add README.md docs/PLAYHTML_AI_GUIDE.md
  git commit -m "docs: document authoritative PlayHTML multiplayer"
  ```

## Rollout Gates

- [ ] Upstream extension/fork is verified at the pinned source revision.
- [ ] No gameplay state is client-writeable through PlayHTML CRDT APIs.
- [ ] `npm test` passes.
- [ ] Two-profile manual acceptance matrix passes.
- [ ] Persistence/hydration and clock/reconnect deterministic tests pass.
- [ ] Production uses only self-hosted PartyKit/PlayHTML endpoint.
- [ ] Resume tokens are opaque, redacted and never shared.
- [ ] Static host does not serve private/runtime source files.
- [ ] Playfull is removed only after staging validates the new authority.

## Out Of Scope

- Accounts, login and anti-cheat beyond opaque reconnect tokens and worker validation.
- Ranked matchmaking, database match history, spectators, replay archive, chat and reactions.
- Rewriting UI in React or changing game rules.
- Syncing game state through `can-mirror`, `can-play`, `createPageData`, element data or PlayHTML events.
