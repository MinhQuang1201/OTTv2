# Handoff Tiến Độ Online Rollout

**Ngày:** 2026-09-26  
**Repository:** `D:\Work\Study\OTTv2`  
**Branch:** `fix/playHTML`  
**Kế hoạch:** `LUNA_IMPLEMENTATION_REPORT.md`  
**Release:** Online production **BLOCKED**; Local/AI khả dụng.

## Tóm tắt

Đã triển khai skeleton migration từ PartyKit `0.0.115` sang minimal PlayHTML Worker trên Cloudflare Workers/Durable Objects. Đã có protocol, authority, persistence adapter và browser flow cùng focused tests. Chưa có runtime evidence đầy đủ, chưa chạy two-profile acceptance, và full suite còn 13 legacy PartyKit failures.

```text
Task 0-7: có implementation tương ứng
Task 8-9: chưa hoàn tất runtime/acceptance evidence
Task 10: chưa thực hiện final verification/release decision
Production readiness: chưa đạt
```

## Đã triển khai

### Task 0: Baseline/evidence

Files:

- `docs/evidence/2026-09-25-playhtml-minimal-fork-baseline.md`
- `vendor/playhtml-minimal/NOTICE.md`

Source pin:

```text
D:\Work\Study\playhtml
Commit: 4008c42b7d2c6157065afe0071d829dbc561af01
```

Evidence đã ghi: `PartyServer extends YServer`, `onCustomMessage`, `YProvider.sendMessage`, `custom-message`, `routePartykitRequest`, `getServerByName`, DO-to-DO auth pattern, versions và license.

### Task 1: Minimal Worker scaffold

Files chính:

- `workers/ott-worker.ts`
- `workers/ott-game-server.ts`
- `workers/wrangler.jsonc`
- `workers/worker-configuration.d.ts`
- `workers/tsconfig.json`
- `tests/worker-entry.test.js`

Đã có Worker route `/parties/main/:room`, DO bindings, read-only Yjs scaffold và direct `/ott/create`/`/ott/list` rejection. Typecheck và Wrangler dry-run đã pass. Hai-browser smoke chưa có.

### Task 2: Public custom-message/browser seam

Files:

- `vendor/playhtml-minimal/browser/index.js`
- `vendor/playhtml-minimal/browser/index.d.ts`
- `tests/playhtml-custom-channel.test.js`

Đã test `ready`, string-only message, subscribe/unsubscribe, không expose raw provider/socket/Yjs, không tạo presence/cursor/awareness/PartySocket. Browser runtime thật chưa chứng minh.

### Task 3: OTT protocol bridge

Files:

- `workers/protocol.ts`
- `workers/ott-game-server.ts`
- `tests/ott-playhtml-bridge.test.js`

Đã có envelope `__ott`, `ott:attach/move/leave`, response validation, cap 8KB, integer coordinates, malformed/non-OTT rejection, rate limit 40ms, attach-before-command và no raw WebSocket parsing.

### Task 4: Lobby/Game authority

Files:

- `workers/internal-auth.ts`
- `workers/ott-lobby-server.ts`
- `tests/ott-authority.test.js`
- `docs/evidence/2026-09-25-ott-authority-task4.md`

Đã có control routes create/list/join/resume, HMAC-SHA-256 capability, room/allocation/purpose/seat binding, expiry, nonce replay protection, Worker-only `OTT_INTERNAL_SECRET`, public-list projection an toàn, DO mapping và direct browser rejection. Mới có deterministic evidence, chưa có đủ DO runtime evidence.

### Task 5: Room persistence/alarm adapter

Files:

- `workers/room-storage.ts`
- `workers/ott-game-server.ts`
- `room.js`
- `partykit/room-storage.js`

Đã có Worker path không dùng Node timer, validated persistence, fail-closed corrupt state, earliest alarm, hydration/reconnect grace, waiting expiry, duplicate/stale alarm handling và `disconnect_timeout`. DO restart/alarm runtime chưa chạy.

### Task 6: Browser integration

Files chính:

- `playhtml-bootstrap.js`
- `playhtml-game-client.js`
- `game.js`
- `index.html`
- `playhtml-game.html`
- `.env.example`
- `README.md`
- `tests/playhtml-bootstrap.test.js`
- `tests/playhtml-game-client.test.js`
- `tests/online-ui-boundary.test.js`

Đã có control API trước attach, init một lần/chờ ready, custom-channel adapter, session ticket tối thiểu, room/revision ordering, intent-vs-auto-resume, leave reset và Local/AI fallback. Online vẫn fail-closed nếu runtime/config thiếu.

### Task 7: Retire legacy production route

Đã xóa `partykit.json`, xóa `dev:partykit`, thêm `worker:dev`/`test:worker-runtime`, cập nhật README sang Worker/Wrangler và thêm `tests/no-legacy-online-transport.test.js`. Pure rules/Room tests vẫn giữ. `partykit/` còn lại chỉ là legacy/reference, không phải production route.

## Verification đã ghi nhận

Focused test counts theo agent:

```text
Worker entry/scaffold: pass
Custom channel: 7 pass
OTT bridge + Worker: 7 pass
Authority: 11 pass
Browser integration: 21 pass
Legacy retirement focused set: 34 pass
```

Full suite gần nhất:

```text
110 passed, 13 failed, 1 skipped
```

Failure:

- `tests/partykit-room.test.js`: 10 failure.
- `tests/partykit-runtime.test.js`: 3 failure.

Nguyên nhân: test cũ dùng direct client `ott:create`, PartyKit lobby/game route và lifecycle/protocol cũ. Không skip/xóa hàng loạt để che failure; cần migrate hoặc quarantine có lý do và giữ security coverage tương đương.

Static JavaScript checks, Worker typecheck, Wrangler dry-run và `git diff --check` đã pass ở các lần tương ứng.

## Runtime harness bị kẹt

File/script:

```text
tests/worker-runtime.test.js
npm run test:worker-runtime
```

**Không gọi lại command này trước khi sửa harness.** Harness tự spawn `npx wrangler dev`, chờ startup bằng regex log và có thể giữ process/cổng hoặc không cleanup chắc chắn. Lần chạy trước bị treo; retry không tạo evidence.

Trước khi chạy lại:

1. Sửa readiness bằng HTTP polling trực tiếp, không phụ thuộc log regex.
2. Thêm timeout tổng.
3. Dùng `try/finally` luôn kill child Wrangler.
4. Capture stdout/stderr khi startup fail.
5. Xử lý process/cổng còn sót.
6. Chỉ chạy một lần với timeout ngoài.
7. Nếu runtime không hỗ trợ, ghi `NOT RUN` và root cause; không retry vô hạn.

`.dev.vars` hiện tồn tại và được ignore trong `.gitignore`. Không commit secret.

## Chưa làm/chưa thực thi

### Task 8: Runtime integration

- [ ] Harness start/stop ổn định.
- [ ] Control create/list/join/resume trên DO thật.
- [ ] Direct game route reject và raw WebSocket upgrade runtime.
- [ ] Hai YProvider/browser client cùng room.
- [ ] Initial Yjs sync trước attach.
- [ ] Pre/post attach Yjs mutation discard, không persist/broadcast.
- [ ] OTT cùng YProvider connection.
- [ ] Không có PartySocket/presence/cursor/awareness socket.
- [ ] Capability wrong-room/expired/replay runtime reject.
- [ ] Room persistence/alarm/restart/hydration runtime.
- [ ] Waiting expiry/lifecycle cleanup runtime.

### Task 9: Two-profile acceptance

- [ ] Hai browser profile độc lập.
- [ ] Create/list/join, legal/invalid move.
- [ ] Goal/no-moves/extinction, timeout, explicit leave.
- [ ] Disconnect/reload/resume, reconnect expiry, waiting expiry.
- [ ] Token isolation và Local/AI fallback.
- [ ] DevTools xác nhận chỉ YProvider connection.

Scenario chưa chạy phải ghi `NOT RUN`, không suy ra PASS.

### Task 10: Final verification/release

- [ ] Migrate/quarantine 13 legacy failures có lý do.
- [ ] Full `npm test` và xử lý failure hợp lệ.
- [ ] Worker typecheck/build và static HTTP denylist.
- [ ] Cập nhật `IMPLEMENTATION_STATUS.md`, `HANDOFF.md`, `README.md`.
- [ ] Cập nhật `docs/playhtml-upstream-lock.md` chỉ sau evidence đủ.
- [ ] Tạo runtime evidence và two-profile evidence.
- [ ] Chỉ bỏ `BLOCKED` khi mọi release gate pass.

## Worktree hiện tại

### Modified

```text
.env.example
.gitignore
README.md
package.json
partykit/room-storage.js
playhtml-bootstrap.js
playhtml-game-client.js
playhtml-game.html
room.js
```

### Deleted

```text
partykit.json
```

### Untracked

```text
LUNA_IMPLEMENTATION_REPORT.md
PROGRESS_HANDOFF_2026-09-26.md
communication.md

Chưa commit trong phiên này. Không reset/checkout/revert các thay đổi hiện có.

## Việc đầu tiên phiên sau

1. Kiểm tra process/cổng Wrangler còn sót.
2. Sửa `tests/worker-runtime.test.js` để không thể treo.
3. Chạy một lần runtime harness với timeout ngoài.
4. Ghi PASS/FAIL/NOT RUN từng scenario.
5. Nếu runtime không khả dụng, chuyển sang migrate 13 legacy tests.

## Quyết định hiện tại

```text
Local/AI: AVAILABLE
Worker scaffold: IMPLEMENTED, runtime evidence incomplete
OTT bridge: IMPLEMENTED, runtime evidence incomplete
Authority: IMPLEMENTED, runtime evidence incomplete
Room DO adapter: IMPLEMENTED, runtime evidence incomplete
Browser integration: IMPLEMENTED, runtime evidence incomplete
Two-profile acceptance: NOT RUN
Full suite: 110 passed, 13 failed, 1 skipped
Online production: BLOCKED
```
