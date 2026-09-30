# Bàn giao: Review PlayHTML Authoritative Rollout

## Handoff Tiếp Tục Public Match Stream (2026-09-30)

### Mục Tiêu

Đang triển khai tính năng để Người 3 nhìn thấy trận đang diễn ra trong sảnh và mở spectator read-only. Thiết kế đã được duyệt tại:

- `docs/superpowers/specs/2026-09-29-public-match-stream-design.md`
- `docs/superpowers/plans/2026-09-29-public-match-stream.md`

Người dùng yêu cầu **không tạo worktree riêng**, nên toàn bộ thay đổi nằm trong workspace hiện tại.

### Trạng Thái Task

- **Task 1: Public match contract:** đã triển khai và đã qua spec review + code-quality review.
- **Task 2: Lobby catalog retry/resync:** phần implementation đã xong và đã qua spec review; code-quality review còn findings cần sửa.
- **Task 3: Browser lobby stream adapter:** implementation đã xong; spec review còn findings cần sửa; chưa chạy code-quality review cuối.
- **Task 4: App/session lifecycle integration:** đã triển khai; còn cần xử lý riêng race review khi dispose runtime đang pending rồi được reuse.
- **Task 5: Runtime và three-profile coverage:** local spectator runtime **PASS** với A tạo, B join, C read-only.
- **Task 6: Security/lifecycle gates:** deterministic suite và production CORS/fail-closed checks **PASS**; spectator đã bật production sau smoke test.
- **Task 7: Build/deploy checkpoints:** Worker và Vercel production đã deploy; alias Vercel không đổi.
- **Production spectator:** đã **ENABLED** với `OTT_SPECTATOR_ENABLED=true`.
- **Deploy:** Worker `d1d44b8e-9fd0-4cc8-a3cd-cec43ba0047d`; Vercel alias `https://ottv2-two.vercel.app`.
- **Commit:** mục này ghi nhận trạng thái trước commit; commit cuối được ghi
  nhận trong git history sau bước verification.

### Trạng Thái Hiện Tại Và Vấn Đề Còn Lại (2026-09-30)

Đây là trạng thái authoritative mới nhất; các mục review lịch sử ở phía dưới
được giữ lại để truy nguyên quyết định và không được dùng thay cho mục này.

#### Đã Xác Nhận

- Spectator production đang **ENABLED** bằng `OTT_SPECTATOR_ENABLED=true`.
- Worker production: `https://ottv2-minimal.haixcxt.workers.dev`.
- Worker version: `d1d44b8e-9fd0-4cc8-a3cd-cec43ba0047d`.
- Vercel production giữ nguyên alias `https://ottv2-two.vercel.app`.
- Production browser acceptance với spectator đã PASS: A tạo phòng, B tham gia,
  C xem read-only, provider/public lobby stream hoạt động, không có lỗi console.

#### Vấn Đề Còn Lại

1. **Chưa có evidence hibernation/eviction thực tế.** Chưa chứng minh được
   Durable Object bị eviction/hibernation rồi reconnect vẫn giữ đúng room state,
   seat, spectator state và authoritative revision. Đây là gap runtime lớn nhất.
2. **Manual acceptance chưa chạy.** Automated production browser acceptance đã
   PASS, nhưng manual acceptance với các browser profile độc lập chưa được ghi
   nhận. Không suy diễn manual PASS từ automated test.
3. **Tám test Node vẫn skip.** Các test cần `.dev.vars` với secret thật và
   placeholder manual acceptance chưa chạy trong môi trường hiện tại.
4. **Clean install còn peer conflict upstream.** `npm ci` không có cờ bổ sung
   fail do `y-partyserver@2.2.0` yêu cầu `@cloudflare/workers-types` v4 trong
   khi Wrangler/PartyServer kéo v5. Verification hiện dùng
   `npm ci --legacy-peer-deps`. `@testing-library/dom@10.4.2` đã được khai báo
   trực tiếp để `@testing-library/react` cài đủ peer dependency.
5. **Dependency audit còn cảnh báo.** Full audit báo 8 vulnerabilities; audit
   production dependency báo 4 vấn đề trong `esbuild`/`undici`. Chưa chạy
   `npm audit fix --force` vì có thể kéo breaking change vào PartyKit/Miniflare.
6. **Một số tài liệu lịch sử còn ghi trạng thái cũ** như production disabled,
   Worker typecheck blocked hoặc online initialization blocked. Các đoạn đó là
   historical rationale; nếu cần handoff ngắn gọn, phải cập nhật chúng để không
   mâu thuẫn với mục trạng thái hiện tại ở trên.

#### Verification Mới Nhất

- `npm test`: **266 passed, 8 skipped, 0 failed**.
- `npm run test:web`: **314 passed, 0 failed**.
- `npm run typecheck:web`: **PASS**.
- `npx tsc -p apps/worker/tsconfig.json --noEmit`: **PASS**.
- `npm run test:worker:spectator`: **40 passed, 0 failed**.
- `npm run build:web`: **PASS**.
- `npm run test:browser-worker:spectator` với production app/Worker origins:
  **1 passed, 0 failed**.
- `git diff --check`: **PASS**.

### Files Đã Thay Đổi

Các file do implementation hiện tại chạm tới:

- `packages/protocol/src/index.ts`
- `apps/web/src/shared/model/game.ts`
- `apps/web/src/shared/model/publicMatch.test.ts`
- `apps/worker/src/lobby/public-match.ts`
- `apps/worker/src/lobby/ott-lobby-server.ts`
- `apps/worker/src/lobby/ott-lobby-stream-server.ts`
- `apps/web/src/sessions/online/globals.d.ts`
- `apps/web/src/sessions/online/runtimeBridge.ts`
- `apps/web/src/sessions/online/runtimeBridge.test.ts`
- `apps/web/src/sessions/online/OnlineLobbyStream.ts`
- `apps/web/src/sessions/online/OnlineLobbyStream.test.ts`
- `tests/spectator-test-worker.test.js`

Tài liệu được tạo:

- `docs/superpowers/specs/2026-09-29-public-match-stream-design.md`
- `docs/superpowers/plans/2026-09-29-public-match-stream.md`


#### Task 1

- Shared protocol có public-match types/envelope/parser/validator.
- Kiểm tra revision, canonical IDs, `status: "playing"`, player fields, bounds, duplicate IDs, private fields và UTF-8 payload tối đa 8 KB.
- Worker normalization tại `apps/worker/src/lobby/public-match.ts`.
- Web model dùng shared `PublicMatchView` thay vì contract divergent.

#### Task 2

- `OttLobbyServer` validate summary trước khi lưu/fan-out.
- Có retry/resync durable theo revision, backoff bounded và retry exhaustion state bounded.
- Alarm Lobby đã multiplex rate-limit cleanup và catalog retry.
- Terminal removal được giữ để retry.
- Internal body limits dùng capped UTF-8 reader.
- `OttLobbyStreamServer` validate catalog, load durable cache sau cold wake và dùng exact `__YPS:` framing để quan sát lỗi `connection.send()`.
- Stream resend bounded; disabled spectator alarm xóa pending resend và không retry.
- `waitUntil()` đã được thêm cho async subscribe resync.

#### Task 3

- Đã tạo `OnlineLobbyStream` dùng runtime seam, party `lobby`, room `ott-lobby-public`.
- Không dùng raw WebSocket hoặc polling `/control/active`.
- Có catalog validation, immutable snapshot, generation guards, pre-open unavailable mapping, reconnect/error state, subscribe retry và concurrent disposal promise.
- `runtimeBridge` đã có lifecycle-owner seam.

### Findings Cần Xử Lý Trước Khi Đi Tiếp

#### Task 2 Quality Review

1. Nếu `loadCachedCatalog()` hoặc `currentPublicCatalog()` throw sau khi retry record đã claim, phải restore retry record; hiện có nguy cơ mất retry.
2. `scheduleAlarm()` cần race-safe. Read rồi `setAlarm/deleteAlarm` không được phép xóa alarm mới hơn do scheduler cũ.
3. `/control/active` phải đi qua `currentPublicCatalog()`/normalization, không trả raw persisted summary; thêm test summary có private fields.
4. Thêm test storage failure sau claim và interleaving scheduler/notification.

#### Task 3 Spec Review

1. Provider đã connected hiện không được hỗ trợ đúng: `connect()` resolve nhưng không phát `open`; adapter đang chờ `open` nên có thể không subscribe.
2. Subscribe bị reject có thể treo vì chờ một `open` event lần nữa vốn không đến.
3. Message có thể được nhận trước khi subscribe thành công hoặc sau close; cần chặn message theo connection/generation/subscribed state.

Không tiếp tục Task 4 cho đến khi các findings trên được sửa và cả hai review stage của Task 2/3 đều APPROVED.

### Verification Đã Báo Cáo

Kết quả do subagents báo cáo, cần chạy lại fresh trước khi kết luận cuối:

- Task 1 web contract: 13 tests passed.
- Task 2 focused Worker: các lần chạy cuối báo 26 tests passed; full Node suite báo 252 passed, 8 skipped.
- Task 3 focused adapter: 10 tests passed; full web suite báo 256 passed.
- Web typecheck/build và `git diff --check` đã được báo PASS ở các checkpoint cuối.
- Worker typecheck: các checkpoint đầu báo thiếu `@cloudflare/workers-types`; checkpoint quality cuối báo đã PASS. Cần chạy lại để xác nhận trạng thái hiện tại.
- Chưa có evidence supported hibernation thực tế hoặc manual three-profile production acceptance.

### Thay Đổi Có Sẵn Từ Trước

Không được revert hoặc chỉnh sửa nếu không liên quan:

- `tests/rules.test.js` đã modified trước đó.
- `TEST_REPORT.md` đã tồn tại dưới dạng untracked trước implementation.

### Cách Tiếp Tục Ngày Mai

1. Sửa Task 2 findings bằng subagent riêng; chạy spec review rồi code-quality review lại.
2. Sửa Task 3 findings bằng subagent riêng; chạy spec review rồi code-quality review.
3. Task 2/3 approved thì triển khai Task 4: App transition coordinator, truyền exact `PlayhtmlSpectatorAllocation` trước game bootstrap, và nối `OnlineLobbyStream` vào lobby UI.
4. Triển khai Task 5 với fixture riêng dùng `apps/worker/wrangler.spectator-test.jsonc`; không dùng normal `wrangler.jsonc --env test/demo` cho spectator.
5. Chạy Task 6 gates. Nếu chưa có supported hibernation evidence, giữ production disabled.
6. Chỉ sau khi đủ evidence mới chạy Task 7 deploy Worker rồi build/deploy Vercel.

Lệnh verification chính:

```powershell
rtk npm test
rtk npm run test:web
rtk npm run typecheck:web
rtk npx --no-install tsc -p apps/worker/tsconfig.json --noEmit
rtk npm run build:web
rtk git diff --check
```

Không dùng `git reset`, `git checkout --`, hoặc lệnh dọn worktree để xử lý các thay đổi có sẵn.

**Ngày review:** 2026-09-25  
**Phạm vi:** Thay đổi chưa commit triển khai theo `docs/superpowers/plans/2026-09-25-playhtml-fork-blocker-resolution.md`.  
**Kết luận:** Không thể triển khai production. Trạng thái online PlayHTML/PartyKit là **BLOCKED** cho đến khi các evidence gate dưới đây được thực hiện và ghi nhận. Không suy diễn production readiness từ bridge/mock hoặc từ test deterministic.

## Cập Nhật Trạng Thái Spectator Mode (2026-09-28)

Phần này là trạng thái hiện tại của worktree `feat/spectator-mode`. Các mục review bên dưới vẫn được giữ làm lịch sử/rationale; các đường dẫn PartyKit cũ trong những mục đó không thay thế cho evidence của kiến trúc Worker/ Durable Objects đang hoạt động.

- **Implementation:** Đã hoàn tất các sửa lỗi authority, persistence, spectator fan-out, reconnect, dispose lifecycle và spectator read-only. UI spectator, demo scenarios và regression coverage đã có.
- **Web tests:** `npm run test:web` đạt **228/228** trên 24 test files.
- **Supported Node tests:** explicit regression suite đạt **199/199** trên 19 test files. Các suite `spectator-test-worker.test.js`, `worker-runtime.test.js`, `browser-worker-runtime.test.js` và `worker-test-harness-runtime.test.js` được cố ý loại khỏi scope theo yêu cầu review.
- **Typechecks:** `npm run typecheck:web` và `npx tsc -p apps/worker/tsconfig.json --noEmit` đều PASS.
- **Build:** `npm run build:web` PASS.
- **Diff hygiene:** `git diff --check` PASS. Các cảnh báo LF/CRLF của Git chỉ là cảnh báo chuyển line ending.
- **Commit state:** Thay đổi hiện chưa được commit.
- **Production gate:** Spectator production vẫn **BLOCKED**. `OTT_SPECTATOR_ENABLED` phải tiếp tục fail-closed; chưa có evidence hibernation/reconnect qua Durable Object eviction hoặc manual two-browser acceptance.
- **Local/AI:** Không bị ảnh hưởng và tiếp tục là đường chạy được khi online spectator unavailable.

### Stop Rule Hiện Tại

Không ghi production-ready, Task 7 PASS hoặc two-profile acceptance PASS dựa trên các test deterministic ở trên. Chỉ mở rollout sau khi có evidence trực tiếp cho hibernating presence, reconnect sau eviction/restart và acceptance hai browser profile. `docs/playhtml-upstream-lock.md` tiếp tục là nguồn trạng thái kỹ thuật duy nhất cho gate upstream.

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

## Handoff Tiếp Tục Sau Phiên 2026-09-30

### Trạng Thái Phiên

- Task 1: đã triển khai và review trước phiên này.
- Task 2: đã sửa findings về lobby catalog retry/race/normalization/cache. Focused Worker suite cuối được báo cáo **39/39 PASS**; không còn finding chức năng sau review.
- Task 3: đã sửa lifecycle của `OnlineLobbyStream`, gồm connected-without-open, subscribe rejection, generation/message gating, reconnect overlap, source replacement, disposal và bounded retry. Review cuối được báo cáo **APPROVED**.
- Task 4: đã triển khai phần lớn App/session lifecycle integration, nhưng **CHƯA APPROVED**.
- Task 5/6/7: chưa triển khai/verify; production spectator vẫn **DISABLED/BLOCKED**.
- Không tạo commit trong phiên này.

### Files Task 4 Đã Chạm

- `apps/web/src/app/AppLifecycleCoordinator.ts` (mới)
- `apps/web/src/app/App.tsx`, `apps/web/src/app/App.test.tsx`
- `apps/web/src/sessions/contract.ts`, `apps/web/src/sessions/contract.test.ts`
- `apps/web/src/sessions/online/OnlineSession.ts`, `OnlineSession.test.ts`
- `apps/web/src/sessions/online/runtimeBridge.ts`, `runtimeBridge.test.ts`, `globals.d.ts`
- `apps/web/src/sessions/spectator/SpectatorSession.ts`, `SpectatorSession.test.ts`

Task 2/3 files and tests remain uncommitted as listed above. Do not revert existing changes such as `tests/rules.test.js` and `TEST_REPORT.md`.

### Task 4 Đã Đạt Được

- Có coordinator dùng chung runtime, serialize các transition và fallback lobby.
- Spectator initial path dùng allocation đã validate, lấy ticket trước game bootstrap; reconnect có ticket dedupe.
- Attach spectator yêu cầu API hợp lệ và kết quả thành công.
- Có generation guards cho transition, ticket, client callback; terminal/leave cleanup và clock gating đã được bổ sung.
- App dùng `OnlineLobbyStream` thay vì polling `/control/active`; stream được truyền runtime facade không sở hữu để tránh tự dispose shared runtime.
- Local/AI/demo vẫn có đường chạy riêng; không bật `OTT_SPECTATOR_ENABLED` và không thêm raw WebSocket/fake transport.
- Subagent báo cáo web suite cuối **302 PASS**, typecheck/build/diff check PASS. Đây là checkpoint do subagent báo cáo, controller cần chạy lại sau khi tiếp tục.

### Findings Còn Mở Trước Khi Ghi Task 4 APPROVED

Review cuối yêu cầu sửa các lỗi sau. Implementer đã nhận danh sách nhưng phiên bị dừng trước khi hoàn tất vòng sửa; không giả định các mục này đã được sửa.

1. `OnlineSession` có thể nhận kết quả create/join sau `dispose()`, gán `allocation` chứa `resumeCredential` rồi giữ lại. Cần guard trước assignment và clear allocation trong cleanup.
2. Coordinator failure cleanup có thể gọi release trên ownership mutable và dispose nhầm runtime/session của generation mới. Cleanup phải capture ownership token và serialized/ownership-safe.
3. `OnlineSession` sau `leave()`/`gameover` còn nhận state callback trễ, có thể resurrect `finished` thành `playing`. Cần invalidate transport generation và guard `applyState`/callbacks.
4. `OnlineSession.start()` lặp/concurrent có thể attach allocation cũ vào room mới; cần start epoch/serialization và reset toàn bộ per-room state: revision, event IDs, fingerprint, board revision, raw state, snapshot.
5. Runtime dependency retirement theo chuỗi A -> B -> A có thể dispose runtime đang được chọn lại; phải recheck current dependency trước disposal.
6. `OnlineLobbyStream` khi reconnect thay source chưa chắc đóng/await mọi connection cũ; cần track toàn bộ owned sources và dispose tất cả.
7. `SpectatorSession` repeated start có thể bootstrap runtime chồng nhau trước khi bootstrap cũ settle; cần serialize start/cleanup.

### Verification Checkpoint

Controller đã chạy fresh trước vòng Task 4 cuối:

- `rtk npm test`: **265 passed, 8 skipped, 0 failed**.
- `rtk npm run test:web`: **268 passed, 27 files** ở checkpoint trước Task 4 remediation.
- `rtk npm run typecheck:web`: PASS.
- `rtk npm run build:web`: PASS.
- `rtk git diff --check`: PASS.
- `rtk npx --no-install tsc -p apps/worker/tsconfig.json --noEmit`: **BLOCKED** trước compile bởi `TS2688`, thiếu `../../node_modules/playhtml/node_modules/@cloudflare/workers-types`.

Sau các remediation Task 4, subagent báo cáo web suite 302 tests PASS, nhưng controller chưa chạy lại fresh sau checkpoint đó. Khi tiếp tục, chạy lại tối thiểu:

```powershell
rtk npm test
rtk npm run test:web
rtk npm run typecheck:web
rtk npx --no-install tsc -p apps/worker/tsconfig.json --noEmit
rtk npm run build:web
rtk git diff --check
```

### Tiếp Tục Đề Xuất

1. Đọc lại các file Task 4 hiện tại và sửa 7 findings ở trên bằng TDD, không tạo worktree/commit nếu chưa được yêu cầu.
2. Chạy spec review rồi code-quality review lại Task 4; chỉ ghi APPROVED khi cả hai không còn finding.
3. Chạy lại full verification và ghi rõ Worker typecheck blocker nếu dependency vẫn thiếu.
4. Không triển khai Task 5/6/7, không bật spectator production, và không ghi production-ready/two-profile acceptance PASS khi chưa có evidence runtime trực tiếp.

## Cập Nhật Nhanh Sau Phiên 2026-09-30

- Đã thêm command riêng cho spectator runtime:
  - `npm run test:worker:spectator`
  - `npm run test:browser-worker:spectator`
- `tests/worker-runtime/fixture.js` hỗ trợ chọn `wrangler.spectator-test.jsonc` mà không dùng `--env demo`; production config không bị bật spectator.
- Browser runtime test có nhánh spectator three-profile: A tạo, B vào, C thấy trận, mở read-only và kiểm tra ô cờ bị disable.
- Deterministic spectator Worker suite: **39/39 PASS**.
- Full Node suite: **265 PASS, 8 SKIP, 0 FAIL**. Các test runtime cần `.dev.vars` vẫn skip.
- Full web suite: **314 PASS, 27 files**.
- Web build: **PASS**; production bundle không chứa `OTT_INTERNAL_SECRET`, test secret hoặc probe secret.
- Static denylist và spectator fail-closed tests: **PASS** trong full Node suite.
- Browser spectator runtime command ban đầu bị chặn bởi fixture `.dev.vars`; sau khi tách spectator fixture, three-profile runtime đã **PASS**.
- Worker typecheck vẫn **BLOCKED** trước compile do thiếu `../../node_modules/playhtml/node_modules/@cloudflare/workers-types` (`TS2688`).
- `git diff --check`: **PASS**.
- Production spectator vẫn **DISABLED/BLOCKED**; local three-profile runtime đã PASS nhưng chưa ghi production spectator acceptance PASS.

## Evidence Deploy 2026-09-30

- Spectator deterministic suite: **39/39 PASS**.
- Local spectator browser runtime: **PASS** với three-profile flow A tạo, B join, C xem read-only; C không thể thao tác ô cờ.
- Production Worker deployed at `https://ottv2-minimal.haixcxt.workers.dev`.
- Production Worker version: `d1d44b8e-9fd0-4cc8-a3cd-cec43ba0047d`.
- Production Worker `/control/active` with origin `https://ottv2-two.vercel.app`: **HTTP 200**, body `{"matches":[]}`.
- Production spectator lobby path is no longer fail-closed; it reaches the enabled public lobby route.
- Production frontend deployment: `https://ottv2-ixbkhp8k6-lap-trinh-mang.vercel.app`.
- Production alias unchanged: `https://ottv2-two.vercel.app`, **HTTP 200**.
- Bundle `apps/web/dist`: no `OTT_INTERNAL_SECRET`, test secret, or probe secret matches.
- Production browser spectator runtime: **PASS** with A tạo phòng, B tham gia, C xem read-only trên `https://ottv2-two.vercel.app` và Worker production.
- `OTT_SPECTATOR_ENABLED` is enabled in production; C's board was disabled and no browser errors occurred.
- Rollback targets: Vercel deployment URL above and Worker version ID above.
