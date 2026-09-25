# Trạng Thái Triển Khai Online Rollout

**Cập nhật:** 2026-09-25  
**Branch:** `fix/playHTML`  
**Kết luận:** Local/AI tiếp tục khả dụng. Online production vẫn **BLOCKED**; không được coi là sẵn sàng chỉ vì unit test hoặc bridge seam chạy được.

## Đã Thực Hiện

- Static host canonicalize denylist để chặn private/source/test/runtime path không phân biệt chữ hoa/thường trên Windows.
- Thêm HTTP regression tests cho `server.js`, `room.js`, package files, `.env*`, `partykit.json`, `partykit/`, `tests/` và `node_modules/`.
- Siết room persistence: clock/timestamp/deadline phải là số nguyên không âm; event IDs phải tăng dần; corrupt storage được fail-closed bằng response `Phòng không khả dụng`.
- Bổ sung hydration reconciliation: persisted connected seats được chuyển sang reconnect grace với deadline tuyệt đối; waiting creator hết grace trở thành terminal winnerless/unjoinable.
- Durable alarm chọn deadline sớm nhất cho active clock, playing reconnect grace và waiting reconnect grace.
- Direct named-game `ott:create` và `ott:list` bị từ chối để chặn arbitrary room creation bypass.
- Lobby chỉ giữ waiting-room check cho `join`; `resume` không còn bị waiting registry chặn sau khi game đã chuyển `playing`.
- Client yêu cầu inbound OTT envelope, bỏ malformed/envelope-less/cross-room snapshots, bảo toàn revision/event ordering, tránh race auto-resume với create/join, và reset reconnect behavior sau leave.
- UI load bootstrap trước client/UI; khi runtime gate blocked, online hiển thị unavailable, không tạo WebSocket/PartySocket/polling/fake factory; local/AI tiếp tục hoạt động.
- Bổ sung plan remediation, handoff, bootstrap/UI/static/persistence/runtime regression tests và tài liệu guardrail.

## Evidence Gate Còn Blocked

### PlayHTML Worker Và Browser Factory

- `playhtml@2.15.0` không public browser API để gửi/nhận custom message OTT.
- Pinned upstream worker `dc2a248839e52e60da796c0df359b8ed506028a1` phụ thuộc private modules, bindings và không có self-contained worker entry được publish.
- `tests/playhtml-bridge.test.js` dùng injected fake upstream handler; không phải evidence runtime.
- Không có PlayHTML fork runnable, same-connection browser factory, hoặc two-profile smoke test.
- Nguồn trạng thái kỹ thuật: `docs/playhtml-upstream-lock.md`.

### PartyKit Lobby-To-Game Authorization

- PartyKit `0.0.115` `Stub.socket()` trả một `WebSocket`.
- `Server.onMessage()` không nhận authenticated inter-party origin hoặc route metadata.
- Vì vậy lobby không thể gửi lệnh create tới game party với bằng chứng server-origin không forgeable qua API đã xác minh.
- Không dùng payload marker nội bộ, client relay, process-global `Map`, guessed RPC hoặc fallback transport để vượt qua giới hạn này.
- Direct `ott:create` đã bị chặn, nên secure lobby-driven game initialization vẫn **BLOCKED** cho tới khi có primitive server-authenticated hoặc đổi durable authority boundary.

## Verification Mới Nhất

- `node --check` cho `server.js`, `room.js`, PartyKit runtime files, bootstrap, client và UI: passed.
- `git diff --check`: passed.
- `npm test`: **91 passed, 13 failed, 1 skipped**.

## Test Fail Còn Lại

- 10 test legacy trong `tests/partykit-room.test.js` vẫn bootstrap ván bằng direct client `ott:create`; hành vi này hiện cố ý bị từ chối để đóng bypass authorization.
- 3 test trong `tests/partykit-runtime.test.js` cần lobby tạo game room an toàn; chúng không thể pass khi PartyKit 0.0.115 thiếu authenticated inter-party initialization channel.
- 1 test PlayHTML runtime forwarding được skip có chủ ý vì chưa có source-backed worker entry thật.

Các fail trên không phải evidence rằng online có thể mở. Trước khi đổi trạng thái rollout, cần một thiết kế có evidence cho secure lobby initialization, fork PlayHTML chạy được và acceptance hai profile được ghi nhận.

## Việc Tiếp Theo

1. Tìm hoặc bổ sung server-authenticated PartyKit primitive, hoặc gộp lobby/game vào một durable authority boundary có route authorization không forgeable.
2. Chỉ sau đó cập nhật test setup không còn dựa vào direct `ott:create` và chạy lại full suite.
3. Vendor một PlayHTML fork tự chứa với extension point đã kiểm chứng, rồi triển khai browser factory trên cùng connection.
4. Chạy runtime smoke test và two-profile acceptance, ghi bằng chứng thực tế trước khi bỏ BLOCKED.
