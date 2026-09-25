# Online Rollout Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Khắc phục các lỗi review có thể giải quyết deterministically, đồng thời chỉ tích hợp online production sau khi có evidence trực tiếp cho PlayHTML worker fork và browser connection factory.

**Architecture:** Giữ `Room` là authority duy nhất. Lobby chỉ allocate/list/join waiting room và route resume tới room đã tồn tại; game party không nhận create trực tiếp. Một layer PlayHTML thực, khi và chỉ khi được chứng minh từ fork pinned, demultiplex upstream và OTT trên cùng connection; không dùng WebSocket/polling fallback. Durable storage/alarm quản lý clock, reconnect và lifecycle idempotent.

**Tech Stack:** Node.js >= 18, CommonJS/UMD, `node:test`, PartyKit `0.0.115`, PlayHTML `2.15.0`, pinned upstream commit `dc2a248839e52e60da796c0df359b8ed506028a1`.

---

## Dependency Rules And Gate Ownership

- Task 1 phải hoàn tất trước mọi merge khác vì đang có source exposure.
- Task 2 và 3 là authority-only work; chúng không được wiring/bật PartyKit + PlayHTML production entry trước Task 5.
- Task 5 là evidence gate duy nhất sở hữu trạng thái trong `docs/playhtml-upstream-lock.md`. Không task nào khác được đổi BLOCKED thành PASS.
- Task 5 chỉ PASS khi fork được chỉ định bằng commit mới đã được review riêng, có self-contained worker entry và source-backed evidence. Không được reconstruct worker local, coi local fake bridge là evidence runtime, hoặc chỉ sửa import private để coi là fork hợp lệ.
- Task 4 vẫn BLOCKED dù direct game `ott:create` đã bị từ chối: inspection PartyKit `0.0.115` xác nhận `Stub.socket()` trả `WebSocket` và `Server.onMessage` không có authenticated inter-party origin/route metadata. Không có secure lobby-driven game initialization cho đến khi có API/runtime evidence cho server-authenticated channel hoặc metadata.
- Không dùng internal payload marker forgeable, client relay hoặc process-global `Map` để giả lập Task 4 authorization/routing. Những cơ chế này không phải server authority, không durable, và không thể mở dependency của Task 7 hoặc acceptance.
- Nếu Task 5 không PASS, không được tạo `new WebSocket`, PartySocket, polling, second PlayHTML session hoặc fallback transport; `partykit.json` không được tuyên bố/gắn production PlayHTML bridge.
- Task 6 chỉ bắt đầu sau Task 5 được xác nhận PASS; nếu BLOCKED, chỉ hoàn thiện test seam/docs và giữ bootstrap unavailable.
- Task 7 phụ thuộc Task 3, 4; Task 8 phụ thuộc Task 6 hoặc giữ unavailable boundary của Task 5.
- Task 9 tích hợp sau Task 1-8. Task 10 là verification/acceptance cuối cùng.

### Task 1: Khóa Static Host Bằng Canonical Path

**Files:** Modify `server.js`, `tests/ott-lobby.test.js` (hoặc tạo `tests/server.test.js`).

- [ ] Viết test HTTP thật mở `server` trên ephemeral port, yêu cầu lower/mixed/upper variants của `server.js`, `room.js`, package files, `.env*`, `partykit.json`, `/partykit/**`, `/tests/**`, `/node_modules/**`; assert `403`, đồng thời assert asset public hợp lệ trả `200`.
- [ ] Chạy focused test và xác nhận RED cho ít nhất `/SERVER.JS`.
- [ ] Normalize path segments/basename với `toLowerCase()` trước private/deny checks; giữ malformed URI/traversal behavior và public asset behavior.
- [ ] Chạy focused test rồi `npm test`.

### Task 2: Siết Persisted Schema Và Fail-Closed Room Startup

**Files:** Modify `partykit/room-storage.js`, `partykit/ott-room.js`, `tests/partykit-room.test.js`.

- [ ] Viết failing tests cho fractional `remainingMs`, non-integer clock anchors/deadlines, unordered `lastEvents`, và corrupted storage nhận stable `ott:error`/unusable response không tạo initial Room mới.
- [ ] Run focused RED.
- [ ] Require integer non-negative timestamps/clocks; require strictly ascending event IDs; validate clone before assignment.
- [ ] Bọc hydrate error: giữ cờ `unusable`, không publish/create replacement state; mọi request trả stable server error không lộ lỗi validation.
- [ ] Run focused GREEN và full suite.

### Task 3: Khôi Phục Durable Connection Grace Sau Hibernation

**Files:** Modify `room.js`, `partykit/room-storage.js`, `partykit/ott-room.js`, `tests/room.test.js`, `tests/partykit-room.test.js`.

- [ ] Viết failing test hydrate một playing room persist khi A/B connected, assert cả hai thành disconnected có reconnect deadline tuyệt đối, alarm được schedule, token resume trước deadline được chấp nhận.
- [ ] Viết failing test waiting A disconnect -> alarm grace expiry -> room bị đánh dấu done/unjoinable, lobby record bị xóa, join/resume sau expiry bị từ chối. Mọi repeated onStart/alarm/notifier retry phải idempotent.
- [ ] Run focused RED.
- [ ] Thêm `Room.markPersistedConnectionsDisconnected(now)` hoặc helper tương đương tạo grace cho persisted live seats; không mutate token/seat/game state; persist đúng một lần trong `onStart`.
- [ ] Định nghĩa policy: waiting creator hết grace tạo terminal `disconnect_timeout` không winner, không còn join/resume, xóa listing; mở `expireReconnect`/deadline model theo policy đó, không tạo winner giả; notifier cleanup idempotent.
- [ ] Assert repeated hydration chỉ persist một lần cho settlement, chọn đúng một alarm deadline sớm nhất giữa active clock/grace/waiting expiry, resume reschedule và terminal không restart alarm.
- [ ] Run focused GREEN and `npm test`.

### Task 4: Tách Lobby Authorization Khỏi Resume Routing

**Files:** Modify `partykit/ott-lobby.js`, `partykit/ott-room.js`, `partykit/lobby.js`, `tests/ott-lobby.test.js`, `tests/partykit-room.test.js`.

**Trạng thái:** **BLOCKED**. Direct game `ott:create` đã bị từ chối. Inspection PartyKit `0.0.115` xác nhận `Stub.socket()` trả `WebSocket`, trong khi `Server.onMessage` không cung cấp authenticated origin/route metadata cho inter-party request; vì vậy secure lobby-driven game initialization chưa thể được chứng minh.

- [ ] Viết failing tests: resume active game sau khi waiting record bị xóa vẫn route tới party; join active/unknown vẫn reject; direct game `ott:create` reject và không mutate room; alarm terminal cleans registry without a client relay.
- [ ] Run RED.
- [x] Kiểm tra source/declarations PartyKit `0.0.115`: `Stub.socket()` trả `WebSocket`; `Server.onMessage` không có authenticated origin/route metadata cho inter-party request. Evidence này giữ production route BLOCKED, không phải evidence để bật lobby initialization.
- [ ] Chỉ tiếp tục nếu PartyKit có API/runtime evidence mới cho server-verifiable, room-bound, expiring route metadata/capability channel. Không tin command client, internal payload marker forgeable, client relay, process-global `Map` hoặc guessed RPC.
- [ ] Chỉ lobby allocate room; game party reject create/list và mọi direct join/resume/move/leave thiếu capability/route metadata server-issued, single-use or expiring, room-bound. Capability không được đưa vào public list/state/log/presence; lifecycle/expiry được persist và validate.
- [ ] Lobby chỉ cần waiting registry cho join; resume address existing game ID rồi room validates capability và opaque token. Không tạo room từ resume.
- [ ] Cài notifier durable/idempotent chỉ qua PartyKit API đã có runtime evidence; nếu không chứng minh được, giữ cleanup route BLOCKED, không dùng client relay/process Map hoặc internal payload marker thay thế.
- [ ] Run focused GREEN and full suite.

### Task 5: Evidence Gate Cho PlayHTML Fork Thật

**Files:** Modify/create `partykit/vendor/playhtml/**`, `partykit/playhtml-base.js`, `partykit/playhtml-ott-bridge.js`, `docs/playhtml-upstream-lock.md`, `tests/playhtml-bridge.test.js`, `partykit.json` only if gate passes.

- [ ] Inspect exact upstream checkout at pinned SHA and installed `playhtml@2.15.0` declarations/runtime; record concrete file/symbol/method signature for worker entry, connection lifecycle, custom-frame encode/decode, browser init with explicit host, `await playhtml.ready`, outbound/inbound raw custom frame path and licenses. Record concrete PartyKit `0.0.115` lifecycle/connection signatures used.
- [ ] Write a source-backed bridge test against the actual fork entry: all non-OTT text and binary frames forward unchanged in both directions; only parsed JSON `{ __ott: true, type: "ott:*" }` is intercepted; malformed claimed OTT yields verified rejection without state mutation; valid non-OTT JSON and text containing `ott:` remain upstream; outbound OTT response path preserves ordering.
- [ ] Run RED against real entry.
- [ ] Unit tests using injected/fake upstream handlers can never satisfy this gate. If separately reviewed fork source supplies a self-contained entry: copy minimal verbatim files with MIT notices, list mechanical import adjustments, implement at verified extension point, run PartyKit dev plus two-client non-game PlayHTML sync smoke test.
- [ ] If any requirement cannot be proven: do not guess/rewrite upstream protocol; keep `partykit.json` production OTT entry disabled, retain bootstrap unavailable, update lock evidence with exact blocker and failing command/result.

### Task 6: Browser Factory Trên Cùng Verified PlayHTML Connection

**Files:** Modify `playhtml-bootstrap.js`, `index.html`, `playhtml-game.html`, `tests/playhtml-game-client.test.js`, `.env.example`, `README.md`.

- [ ] Only when Task 5 PASS: write failing test asserting one explicit self-hosted init, await ready/initial sync, factory adapter `{ connect, send, on, close }`, OTT envelope on existing PlayHTML connection, non-OTT ignored.
- [ ] Run RED.
- [ ] Implement using only verified API; `await playhtml.ready` must resolve before factory registration; factory wraps the one already-initialized connection and its `connect()` cannot construct network transport. Load bootstrap before client/UI; expose only public host config; no game state through PlayHTML shared data.
- [ ] If Task 5 BLOCKED: test/page must show explicit unavailable status; do not assign fake factory or use fallback transport.
- [ ] Run focused tests and syntax checks.

### Task 7: Client Authoritative Session State Machine

**Files:** Modify `playhtml-game-client.js`, `game.js`, `tests/playhtml-game-client.test.js`.

- [ ] Write failing tests for: stored auto-resume followed by explicit create/join; leave then new game then close reconnect; cross-room state; envelope-less state; malformed state; valid newer same-room state/event dedupe.
- [ ] Run RED.
- [ ] Model explicit intents: reconnect may auto-resume only when no requested create/join exists; requested create/join clears/cancels pending resume deterministically.
- [ ] Reset intentional-close when opening a new session or close transport on leave; state cannot change active room; require `__ott: true` and complete valid response shape before mutation.
- [ ] Keep local/AI usable when factory unavailable; disable online create/join/resume and emit no OTT command/no resumable online state. Assert local/AI never writes PlayHTML data, presence, events, or page/element data; no client authority checks replacing server checks.
- [ ] Run focused GREEN and full suite.

### Task 8: Gắn UI Vào Authoritative Factory Và Failure UX

**Files:** Modify `index.html`, `game.js`, `playhtml-game.html`, `tests/playhtml-game-client.test.js`.

- [ ] Write failing page/script-order regression test or static script-order assertion plus UI behavior test for unavailable factory and local/AI fallback.
- [ ] Run RED.
- [ ] If factory is verified, ensure bootstrap precedes game client and game UI; explicit online unavailable messaging must not crash initial lobby.
- [ ] If gate remains BLOCKED, document/retain unavailable boundary and ensure no online action reports false connection state.
- [ ] Run focused tests.

### Task 9: Runtime Integration Security And Durable Flows

**Files:** Modify/add `tests/partykit-runtime.test.js`, relevant test helpers only.

- [ ] Build integration harness using actual PartyKit runtime/stubs only where runtime API is verified.
- [ ] Test direct game create rejection, create/list/join/resume transition chỉ khi Task 4 có secure lobby-driven initialization evidence, waiting disconnect expiry, restart/hydration resume, token privacy, one earliest alarm, static denial.
- [ ] If Task 5 PASS, test configured entry forwards PlayHTML upstream plus OTT on one connection. If BLOCKED, assert PartyKit config does not falsely claim production bridge integration.
- [ ] Run all integration tests.

### Task 10: Documentation, Verification, And Two-Profile Acceptance

**Files:** Modify `HANDOFF.md`, `README.md`, `CLAUDE.md`, `CONTEXT.md`, `PRODUCT.md`, `docs/PLAYHTML_AI_GUIDE.md`; reference-only `docs/playhtml-upstream-lock.md`.

- [ ] Update handoff statuses with resolved/unresolved evidence only. Task 10 may reference but never alter Task 5 technical gate state in `docs/playhtml-upstream-lock.md`.
- [ ] Run `node --check` for all runtime files, `npm test`, `git diff --check`, and denylist HTTP test.
- [ ] Always test blocked mode: no worker/bootstrap falsely configured, no online transport or forgeable lobby-to-game route constructed, unavailable UX explicit, local/AI works. When Task 4-6 have direct evidence, additionally perform two independent profile acceptance: create/list/join, legal/invalid move, timeout, explicit leave, disconnect/reload/resume, expiry, token isolation.
- [ ] Record command, version, host, date and each scenario outcome. If any gate remains BLOCKED, retain exact blocker and do not mark production ready.
