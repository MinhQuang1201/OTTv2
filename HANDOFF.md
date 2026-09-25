# Bàn giao: Review PlayHTML Authoritative Rollout

**Ngày review:** 2026-09-25  
**Phạm vi:** Thay đổi chưa commit triển khai theo `docs/superpowers/plans/2026-09-25-playhtml-fork-blocker-resolution.md`.  
**Kết luận:** Không thể triển khai production. Trạng thái online PlayHTML/PartyKit là **BLOCKED** cho đến khi các evidence gate dưới đây được thực hiện và ghi nhận. Không suy diễn production readiness từ bridge/mock hoặc từ test deterministic.

## Trạng thái evidence

- Báo cáo review trước đó ghi nhận `GET /SERVER.JS` trả `200`; phải chạy lại denylist HTTP test trước khi coi vấn đề đã được xử lý.
- Inspection PartyKit `0.0.115` đã xác nhận `Stub.socket()` trả về `WebSocket`, còn `Server.onMessage` không cung cấp origin hoặc route metadata đã xác thực cho inter-party request. Vì vậy direct game `ott:create` đã bị từ chối, nhưng secure lobby-driven game initialization vẫn **BLOCKED**.
- Chưa có evidence trực tiếp trong handoff này cho PlayHTML worker fork thật, browser connection factory thật, compatibility smoke test hoặc manual acceptance hai browser profile.
- Không ghi Task 5 PASS hoặc acceptance PASS ở đây. `docs/playhtml-upstream-lock.md` là nguồn trạng thái kỹ thuật duy nhất của Task 5 và không thuộc phạm vi tài liệu này.

## Blocker Production

### 1. Trang game không thể khởi tạo online transport

**Mức độ:** Critical  
**Bằng chứng:**

- `index.html:145-150` chỉ load `playhtml-game-client.js`; không load `playhtml-bootstrap.js`.
- `game.js:346-350` truyền `window.OTT_PLAYHTML_CONNECTION_FACTORY` vào `PlayhtmlGameClient`.
- `playhtml-game-client.js:34-36` ném lỗi nếu factory không phải function.

**Tác động:** Không có factory nào được đăng ký, nên sảnh tự nối, create và join đều không thể hoạt động trong trang đang ship.

**Cần làm:** Chỉ sau khi xác minh được browser PlayHTML connection API thật, triển khai bootstrap, load nó trước game client/UI và thêm test trang thực tế cho thứ tự script cùng factory registration. Không thay bằng `WebSocket` độc lập.

### 2. PartyKit production entry không chạy PlayHTML bridge

**Mức độ:** Critical  
**Bằng chứng:**

- `partykit.json:3-7` trỏ trực tiếp tới `partykit/ott-lobby.js` và `partykit/ott-room.js`.
- `partykit/ott-lobby.js:42-53` parse tất cả inbound frame như OTT command.
- `partykit/playhtml-base.js` và `partykit/playhtml-ott-bridge.js` không được import hoặc instantiate bởi entry đang chạy.

**Tác động:** Không có cùng một PlayHTML/Yjs connection như kiến trúc yêu cầu; frame upstream không được chuyển tiếp; bridge test hiện chỉ là unit test với fake upstream.

**Cần làm:** Vendor fork PlayHTML tại revision pin, xác minh extension/lifecycle/frame API từ runtime thật, sau đó gắn bridge vào PartyKit entry thực tế. Chứng minh frame upstream đi byte-for-byte và OTT đi trên cùng connection bằng smoke test runtime.

### 3. Resume bị lobby chặn khi ván đã bắt đầu

**Mức độ:** Critical  
**Bằng chứng:**

- `partykit/ott-lobby.js:66-72` yêu cầu registry record cho cả `ott:join` lẫn `ott:resume`.
- `partykit/ott-lobby.js:105-110` xóa record khi nhận state `playing`.

**Tác động:** Sau khi B vào và game bắt đầu, mọi `ott:resume` hợp lệ bị trả `Không tìm thấy phòng` trước khi game room có thể kiểm tra token. Grace reconnect trong production vì thế không thể hoạt động.

**Cần làm:** Tách authorization của `join` và `resume`: chỉ `join` cần waiting record; `resume` phải route tới room ID đã validate và để `Room.resumePlayer()` xác thực token. Không để token xuất hiện trong lobby record/list.

## Lỗi Nghiêm Trọng

### 4. Lobby-to-game authority không có channel server-authenticated

**Mức độ:** High  
**Trạng thái:** Direct game `ott:create` đã bị từ chối; secure lobby-driven game initialization vẫn **BLOCKED**.  
**Bằng chứng:** Inspection source/declaration của PartyKit `0.0.115` xác nhận `Stub.socket()` trả `WebSocket`, không phải server-authenticated inter-party channel. `Server.onMessage` không có authenticated origin hoặc route metadata để phân biệt lobby request với client frame. 

**Tác động:** Không thể chứng minh rằng game party chỉ nhận khởi tạo từ lobby. Payload marker "internal", client relay, hoặc process-global `Map` đều forgeable/không durable và không được dùng thay cho server authorization.

**Cần làm:** Giữ direct `ott:create` bị từ chối. Chỉ mở lobby-driven initialization khi PartyKit có API/runtime evidence cho server-authenticated, room-bound, expiring route/capability metadata hoặc một server-side channel tương đương. Nếu không có, giữ route production BLOCKED; không dùng forgeable internal payload marker, client relay hoặc process map.

### 5. Waiting room bị bỏ quên vĩnh viễn khi creator mất kết nối

**Mức độ:** High  
**Bằng chứng:**

- `room.js:192-213` tạo reconnect deadline ngay cả khi room còn `waiting`.
- `room.js:265-266` không expire reconnect nếu status khác `playing`.
- `partykit/ott-room.js:10-18` không schedule alarm cho waiting room.

**Tác động:** Room A-only vẫn xuất hiện trong lobby vô hạn; B có thể join sau thời hạn grace đáng lẽ đã hết.

**Cần làm:** Định nghĩa lifecycle cho waiting creator disconnect: schedule durable deadline, hết hạn thì xóa/reject room và gửi notifier idempotent cho lobby. Bổ sung test disconnect -> grace expiry -> list không còn room -> join bị từ chối.

### 6. Restart PartyKit làm người chơi đã kết nối không thể resume

**Mức độ:** High  
**Bằng chứng:**

- `partykit/room-storage.js:55-58` hydrate mọi player thành `connected: false`, nhưng giữ `reconnectDeadlineMs` cũ.
- Player được persist khi còn connected có deadline `null`.
- `room.js:240-247` chỉ resume khi deadline không null và chưa hết hạn.
- `partykit/ott-room.js:33-48` không cấp deadline grace sau hydration.

**Tác động:** Sau hibernation/restart, player từng connected bị khóa vĩnh viễn khỏi ghế; game có thể chỉ chờ clock timeout.

**Cần làm:** Khi hydrate active room, chuyển mọi persisted player không có live connection vào reconnect grace có deadline tuyệt đối, persist một lần và schedule alarm sớm nhất. Xác minh restart rồi resume hợp lệ trước expiry.

### 7. Static server lộ private files qua case variant

**Mức độ:** High  
**Bằng chứng:**

- `server.js:38-41` dùng `DENY.has(base)` case-sensitive.
- Windows filesystem case-insensitive.
- Probe trực tiếp `GET /SERVER.JS` trả `200`.

**Tác động:** Lộ `server.js`, `package.json`, `package-lock.json`, `partykit.json` qua `/SERVER.JS`, `/PACKAGE.JSON`, `/PACKAGE-LOCK.JSON`, `/PARTYKIT.JSON`.

**Cần làm:** Normalize basename bằng `toLowerCase()` trước denylist comparison, đồng thời dùng allowlist public assets nếu phù hợp. Thêm HTTP integration tests cho mọi private file và biến thể mixed/case-uppercase.

### 8. Auto-resume đua với create/join chủ động

**Mức độ:** High  
**Bằng chứng:**

- `playhtml-game-client.js:100-113` tự gửi `ott:resume` khi open nếu session storage còn token.
- `game.js:472-483` gửi `ott:create` hoặc `ott:join` ngay sau `connect()` mà không chờ kết quả resume.
- Protocol áp rate limit 40ms/connection.

**Tác động:** User muốn join/create room mới có thể bị rate-limit, bị resume vào room cũ hoặc có command order không xác định.

**Cần làm:** Biến reconnect/resume thành intent rõ ràng. Create/join phải hủy hoặc chờ auto-resume trước; chỉ resume tự động cho session đang cần reconnect. Thêm test stored token + user create/join và command ordering.

### 9. Leave làm mất reconnect cho các game sau trên cùng transport

**Mức độ:** High  
**Bằng chứng:**

- `playhtml-game-client.js:201-205` đặt `intentionalClose = true` nhưng không close connection.
- `:78-81` return sớm nếu connection vẫn đang open nên không reset cờ.
- `:116-120` không schedule reconnect nếu cờ còn true.

**Tác động:** Sau leave rồi create/join game mới, close bất ngờ không kích hoạt reconnect.

**Cần làm:** Reset cờ intentional close khi bắt đầu một authoritative session mới, hoặc đóng transport thật khi leave. Test leave -> create/join -> close bất ngờ -> resume attempt.

### 10. State từ room khác có thể ghi đè UI hiện tại

**Mức độ:** High  
**Bằng chứng:**

- `playhtml-game-client.js:145-151` nhận state, gọi `setRoomId()` rồi mới check revision.
- `:214-223` reset revision/event ordering nếu room ID đổi.

**Tác động:** Snapshot stale/cross-room revision `0` trở thành hợp lệ sau reset và thay state UI hiện tại.

**Cần làm:** Chỉ nhận `ott:state` cho room ID/session đã được `ott:joined` xác nhận; tuyệt đối không đổi active room từ snapshot. Reset ordering chỉ từ joined/left đã correlate.

## Lỗi Trung Bình

### 11. Client không xác thực OTT envelope và shape state đầy đủ

**Mức độ:** Medium  
**Bằng chứng:**

- `playhtml-game-client.js:122-132` chỉ kiểm tra object và `type`, không yêu cầu `__ott: true`.
- `:145-153` chỉ check `revision` rồi nhận state arbitrary.
- `partykit/protocol.js:43-55` có `isValidStateResponse()` nhưng client không có kiểm tra tương đương.

**Tác động:** Non-OTT upstream message hoặc malformed object có colliding type có thể thay UI state.

**Cần làm:** Require envelope đúng tại transport adapter và validate state response trước mutate client state. Phân biệt lỗi protocol với event upstream hợp lệ không liên quan.

### 12. Persistence chấp nhận fractional clock và event không ordered

**Mức độ:** Medium  
**Bằng chứng:**

- `partykit/room-storage.js:86-89` dùng `Number.isFinite` thay vì `Number.isInteger` cho `remainingMs`.
- `:70-75` chỉ kiểm tra event ID unique, không yêu cầu tăng dần.
- `partykit/protocol.js:49-54` yêu cầu event IDs tăng dần.

**Tác động:** Corrupt state vẫn hydrate được nhưng có thể tạo deadline sai hoặc snapshot protocol-invalid.

**Cần làm:** Reject fractional clock values và require strictly ascending `lastEvents`; thêm corrupt-storage test tương ứng.

### 13. Corrupt persistence throw qua startup thay vì trả lỗi fail-closed ổn định

**Mức độ:** Medium  
**Bằng chứng:** `partykit/ott-room.js:33-37` gọi `hydrateRoom()` không catch validation error.

**Tác động:** Worker lifecycle có thể crash/retry mơ hồ thay vì room được đánh dấu unusable và client nhận stable error, như kế hoạch yêu cầu.

**Cần làm:** Catch validation failure, giữ room không usable, không tạo replacement initial state, trả mã lỗi server ổn định cho connect/command và log thông tin nội bộ không lộ ra client.

### 14. Production lifecycle cleanup không được nối vào game room

**Mức độ:** Medium  
**Bằng chứng:**

- `partykit/ott-room.js:195-207` khởi tạo `OttRoom` không truyền `lifecycle`.
- Callbacks ở `:87-91`, `:99-101`, `:113-118` không chạy production.
- `partykit/ott-lobby.js:92-110` chỉ cleanup khi có client relay state/gameover/left.

**Tác động:** Alarm-driven terminal transition hoặc transition không có routed client có thể để stale waiting record.

**Cần làm:** Thiết kế durable, idempotent lobby notifier có thể gọi từ game party lifecycle/alarm qua API PartyKit đã được xác minh; không dựa vào client relay.

## Khoảng Trống Test

- Browser/page-level test: bootstrap được load trước client, gọi PlayHTML init đúng một lần, await initial sync và đăng ký factory.
- Runtime integration test: entry PartyKit thật chạy PlayHTML upstream + OTT bridge, forward frame upstream byte-for-byte và OTT frame qua cùng connection.
- Resume qua lobby sau trạng thái `playing` và sau PartyKit hydration/restart.
- Direct named game party request bị từ chối cho `ott:create` và routing không hợp lệ.
- Waiting creator disconnect, alarm hết grace, registry cleanup, list/join behavior.
- HTTP request-level static security cho private paths với lower/mixed/upper case.
- Auto-resume kết hợp create/join, rate-limit và ordering.
- Leave -> game mới -> network close -> reconnect attempt.
- Cross-room state, envelope-less state, malformed state payload bị ignore.
- Corrupt persistence: fractional remaining time, unordered events, stable unusable-room client error.

## Thứ Tự Khắc Phục Khuyến Nghị

1. Sửa static-server case-insensitive denylist và thêm HTTP regression coverage ngay vì đây là source exposure đã tái hiện được.
2. Không mở production rollout trước khi vendor/verify PlayHTML fork và browser factory thật; thay đổi `partykit.json`/entry phải gắn runtime bridge đã kiểm chứng.
3. Giữ direct game create bị chặn và không mở lobby-to-game initialization cho đến khi PartyKit có server-authenticated routing evidence; không dùng internal marker forgeable, client relay hoặc process map.
4. Hoàn thiện durable lifecycle: waiting expiry, game lifecycle notifier, alarm handling và restart/hydration grace.
5. Sửa client session state machine: explicit resume intent, leave/reset behavior, room correlation, envelope/state validation.
6. Siết persistence validator và fail-closed startup behavior.
7. Chạy full deterministic suite, PartyKit + PlayHTML runtime smoke test và manual two-profile acceptance; chỉ ghi nhận pass cho các scenario đã thực hiện.

## Gate Xác Minh Và Mở Rollout

Không đánh dấu online production hoàn tất cho đến khi tất cả điều kiện sau có bằng chứng trực tiếp:

- Fork PlayHTML đúng revision, license/NOTICE, extension point và runtime compatibility được kiểm chứng.
- Initial sync PlayHTML và OTT commands dùng cùng một verified connection.
- Create/list/join/resume routing durable và không có process-global registry hay direct room creation bypass.
- Lobby-to-game initialization dùng channel hoặc metadata server-authenticated đã được runtime xác minh; không dựa vào payload marker forgeable, client relay hoặc process map.
- Một durable PartyKit alarm xử lý clock/reconnect và sống qua hydration/restart.
- Persistence invalid fail-closed, không tạo room replacement hay lộ lỗi nội bộ.
- Snapshot revision/event ordering và client dedupe/correlation hoạt động trên runtime integration.
- Static server từ chối tất cả source/runtime/test/package/environment private paths, kể cả case variants.
- Two-profile acceptance được chạy và ghi nhận: create/list/join, legal/invalid move, timeout, leave, disconnect/resume, reconnect expiry, reload/token privacy, local/AI fallback.

## Ghi Nhận Verification

Trước khi đổi bất kỳ trạng thái nào, ghi ngày, commit/revision, phiên bản Node/PartyKit/PlayHTML, host chạy thử, command đầy đủ và kết quả cho từng gate. Tối thiểu phải chạy `node --check` cho runtime files, `npm test`, `git diff --check` và denylist HTTP test. Evidence PartyKit hiện có chỉ xác nhận `Stub.socket()` trả `WebSocket` và `Server.onMessage` không có authenticated inter-party origin/route metadata; nó không mở Task 4. Khi Task 4 hoặc Task 5 còn BLOCKED, còn phải chứng minh blocked mode: không có authoritative online initialization/transport được cấu hình giả, UI báo unavailable rõ ràng, và local/AI vẫn hoạt động. Chỉ sau Task 4, Task 5 và Task 6 có evidence trực tiếp mới chạy two-profile acceptance; scenario nào chưa chạy phải ghi là chưa chạy, không suy ra PASS từ coverage khác.
