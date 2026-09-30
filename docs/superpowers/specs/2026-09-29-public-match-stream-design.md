# Public Match Stream Design

## Goal

Cho phép người thứ ba nhìn thấy các ván đang diễn ra trong sảnh và mở một phiên spectator read-only, trước hết qua local/test runtime và chỉ mở production sau khi đạt các evidence gate hiện hành.

## Constraints

- Worker/Durable Object vẫn là authority duy nhất cho trạng thái ván.
- Không dùng polling `/control/active` trong UI.
- Không tạo WebSocket hoặc PlayHTML session thứ hai cho cùng một trạng thái.
- Không ghi trạng thái ván vào page data, element data, event, presence hoặc cursor.
- `OTT_SPECTATOR_ENABLED` tiếp tục fail-closed mặc định.
- Local/AI phải tiếp tục hoạt động khi online spectator unavailable.
- Không deploy production spectator chỉ dựa trên deterministic unit tests.
- Không mở direct game creation hoặc lobby-to-game initialization bằng forgeable marker, client relay hoặc process map; các authority gates hiện có vẫn là prerequisite.

## Current Components

- `OttLobbyServer` lưu allocation, lọc phòng chờ và lưu public summaries.
- `OttGameServer.publishPublicSummary()` đẩy summary vào Lobby khi spectator feature được bật.
- `OttLobbyStreamServer` giữ catalog summary và phát `ott:active-matches` qua custom-message channel.
- `OnlineLobbyGateway` đang xử lý control requests và có API active-match diagnostic nhưng chưa nối vào App.
- `SpectatorSession` đã nhận spectator ticket và kết nối tới game room read-only.
- `App.publicMatchState()` hiện trả `unavailable` ngoài deterministic demo.

## Proposed Data Flow

1. Player A tạo phòng và Player B join.
2. Lobby allocation chuyển sang `playing`.
3. Game hoàn tất player attach và phát public summary nếu `OTT_SPECTATOR_ENABLED === "true"`.
4. Lobby lưu summary, tăng catalog revision và cập nhật `OttLobbyStreamServer` qua internal authenticated request.
5. Lobby UI khởi tạo một provider connection tới party `lobby`, room `ott-lobby-public`.
6. UI gửi `ott:lobby-subscribe` một lần qua custom-message channel.
7. UI nhận `ott:active-matches`, kiểm tra revision/shape và cập nhật public match list.
8. Khi người dùng chọn trận, UI đóng lobby stream trước, lấy và validate `/control/spectate`, rồi mới bootstrap game provider và khởi tạo `SpectatorSession` cho game room. Không mở game provider khi chưa có spectator ticket hợp lệ.
9. Khi quay lại sảnh, UI tạo lại lobby stream. Đây là lifecycle tuần tự, không phải hai transport đồng thời cho cùng state.
10. Khi ván kết thúc, Lobby xóa summary và phát catalog mới; match biến mất khỏi sảnh.

## Client Design

Thêm một adapter stream ở boundary `apps/web/src/sessions/online/`, không để React component biết protocol hoặc Worker internals. Một lifecycle owner duy nhất ở App/session boundary sẽ sở hữu adapter. Adapter sẽ:

- dùng runtime/connection seam đã có;
- expose trạng thái `loading`, `ready`, `unavailable`, `error`;
- expose snapshot matches immutable;
- gửi subscribe sau khi connection mở;
- nhận và xác thực envelope `__ott: true`, type `ott:active-matches`, catalog revision và match shape;
- chuyển close/reconnect thành trạng thái rõ ràng;
- dispose connection trước khi mở game/spectator session.

`App` sẽ dùng adapter state thay cho hàm hard-code `publicMatchState()`. Mọi `dispose()` phải được `await`; generation/cancellation phải ngăn stream cũ ghi state sau khi chuyển session. Nếu lấy spectator ticket thất bại, lobby stream phải được mở lại hoặc giữ trạng thái reconnectable. HTTP `listActiveMatches()` vẫn giữ cho diagnostic/test, không được gọi bởi UI.

Một transition coordinator ở App/session boundary sẽ sở hữu thứ tự chuyển đổi: await lobby stream disposal, lấy và validate spectator ticket, rồi mới bootstrap game provider và start spectator session. Nếu lấy ticket thất bại, coordinator mở lại lobby stream. `SpectatorSession` không tự bootstrap game provider trước khi ticket được cấp và không tự quyết định lifecycle lobby. App inject một runtime/provider bridge dùng chung cho lifecycle online; `OnlineSession` và `SpectatorSession` không tự tạo các bridge độc lập trên cùng global runtime. Bootstrap phải hỗ trợ cả provider đã connected và provider chờ open bằng handshake idempotent; mỗi generation chỉ subscribe một lần và phải resubscribe sau reconnect.

Mọi provider shutdown phải được await đến khi runtime thực sự có thể rebind room mới. Transition coordinator serialize create/join/spectate/return-lobby và hủy kết quả của generation cũ.

Một transition coordinator ở App/session boundary sẽ sở hữu thứ tự chuyển đổi: await lobby stream disposal, lấy và validate spectator ticket, rồi mới start spectator session. Nếu lấy ticket thất bại, coordinator mở lại lobby stream. `SpectatorSession` không tự quyết định lifecycle lobby. Bootstrap phải hỗ trợ cả provider đã connected và provider chờ open bằng handshake idempotent; mỗi generation chỉ subscribe một lần và phải resubscribe sau reconnect.

Không cho phép provider lobby và provider game cùng tồn tại trên một lifecycle. Runtime phải hoàn tất disposal trước khi rebind sang room khác, phù hợp với contract của `runtimeBridge.ts`.

## Public Summary Contract

Catalog và từng match phải được kiểm tra ở server cache boundary và client boundary. Contract tối thiểu:

- `catalogRevision`: số nguyên không âm;
- `matches`: collection hữu hạn, có giới hạn payload;
- mỗi match có `allocationId`, `roomId`, `status: "playing"`, hai player public seat/name/connected/remainingMs, `spectatorCount`, `serverNow`, và `runningSeat`;
- `allocationId` và `roomId` là duy nhất trong catalog;
- không có ticket, resume credential, internal secret, Room token hoặc private fields;
- stale hoặc duplicate revisions không được ghi đè snapshot mới hơn.

Một validator dùng chung ở server cache boundary và stream fan-out boundary phải kiểm tra integer/nonnegative revisions, canonical ID formats, exact public fields, bounded names/counts/clocks, finite unique match collections và UTF-8 payload size trong giới hạn 8 KB. Invalid summaries bị loại bỏ hoặc làm request lỗi; không được lưu vào durable catalog hay gửi tới clients. Client lặp lại validation trước khi mutate UI state.

Notification tới stream là best effort ở transport boundary. Vì một notification có thể mất trong khi stream vẫn còn kết nối, Lobby phải có durable revision-keyed outbox/retry hoặc bounded resync alarm độc lập với lần subscribe tiếp theo. Cơ chế này phải bao phủ cả catalog update và terminal removal, có giới hạn retry và idempotent revision handling. Resubscribe sau stream restart phải lấy snapshot hiện tại từ Lobby; terminalization và alarm retry phải không để match stale vĩnh viễn.

## Runtime and Configuration

- `wrangler.spectator-test.jsonc` là cấu hình local/test có `OTT_SPECTATOR_ENABLED: "true"`.
- Production `wrangler.jsonc` giữ spectator disabled cho đến khi evidence hibernation/reconnect và manual two-browser acceptance được ghi nhận.
- Frontend production chỉ được build với `VITE_OTT_PLAYHTML_HOST` và `VITE_OTT_PLAYHTML_CONTROL_ENDPOINT` trỏ tới Worker HTTPS thật.
- `OTT_INTERNAL_SECRET` chỉ là Worker secret.
- Frontend và Worker deploy độc lập: Worker deploy bằng Wrangler; frontend build rồi deploy `apps/web/dist` lên Vercel.

## Testing Strategy

Unit/contract tests:

- Lobby stream rejects disabled spectator access.
- Valid subscription receives current catalog.
- Newer catalog revisions replace matches; stale revisions are ignored.
- Malformed or foreign custom messages do not mutate match state.
- App renders ready active matches from a stream snapshot and unavailable/error states.
- Selecting a match disposes lobby stream before starting spectator session.
- Provider disposal is awaited; duplicate subscriptions, stale generations, and overlapping lobby/game providers are rejected.
- Disabled 404 và mọi lỗi trước khi provider mở thành công map tới `unavailable`; lỗi sau khi connection đã mở map tới `reconnecting/error` với retry bounded. Không expose raw HTTP status qua runtime seam và tuyệt đối không fallback sang polling.
- Already-connected bootstrap completes the same ready/subscribe handshake as an `open`-event connection.
- A real lobby-party runtime test covers subscribe, catalog fan-out, reconnect/resubscribe, and terminal removal.
- No spectator path sends `ott:move` or `ott:leave`; spectator ticket cannot attach a player seat.
- Stream/catalog payloads contain no ticket or resume credential.

Local runtime acceptance:

- Start spectator test Worker with its secret bindings.
- Use three independent browser profiles.
- A creates, B joins, C sees the playing match.
- C opens the match, receives authoritative read-only state, and cannot move or leave.
- Match terminalization removes it from the lobby stream.
- Dropped lobby notifications are recovered by server retry/resync without requiring a later client action.
- Verify the existing full two-player matrix: valid/invalid move, reload/resume, disconnect grace/expiry, timeout, leave, token privacy, local/AI fallback, and static-path security.
- Add a third spectator profile to verify discovery, read-only behavior, spectator reconnect, and terminal removal.
- Verify supported hibernating-presence behavior directly for both lobby stream and spectator game connection; a process restart test or `ctx.abort()`/code `1006` test is separate evidence and cannot substitute for hibernation evidence.
- Run request-level static denylist checks for `/SERVER.JS`, package files, runtime/private paths, and mixed-case variants.
- Record date, commit, Node/Worker/PlayHTML versions, host, commands, and per-scenario results.

## Rollout Criteria

Production flag remains disabled until all of the following have direct evidence:

- Browser/Worker stream connection uses the reviewed PlayHTML/YProvider seam.
- Existing direct-game-create rejection and server-authenticated lobby-to-game routing gates remain satisfied.
- Lobby stream has direct supported hibernation evidence; Durable Object restart/reconnect is recorded separately and is not a substitute.
- Spectator game reconnects within the configured grace period after the supported lifecycle event.
- Full two-player matrix and manual three-profile acceptance pass.
- Direct browser Worker evidence exists for `/parties/lobby/ott-lobby-public` subscription, fan-out, reconnect/resubscribe, and terminal removal.
- Direct supported hibernation/reconnect evidence exists for both lobby and spectator game connections.
- Request-level static denylist/security tests pass, including mixed-case paths.
- Production configuration check proves spectator is explicitly enabled only at rollout, test bindings/secrets are not copied, and `OTT_INTERNAL_SECRET` is absent from frontend artifacts.
- Full relevant web, Worker, typecheck and build verification passes.

Only after these criteria are met:

1. Set `OTT_SPECTATOR_ENABLED=true` in the production Worker environment.
2. Deploy Worker.
3. Build frontend with production Worker URL.
4. Deploy frontend to Vercel.
5. Re-run three-profile acceptance against the deployed URLs.

## Non-Goals

- No HTTP polling fallback.
- No client-authoritative active match list.
- No second raw WebSocket transport.
- No bypass of direct-create or authenticated lobby-to-game authority gates.
- No changes to game rules or Room authority.
- No production readiness claim before the existing handoff gates pass.

The test Worker may keep its local-only `OTT_INTERNAL_SECRET` fixture in `wrangler.spectator-test.jsonc`; production must use a Wrangler secret binding via `wrangler secret put`, and secret values must not appear in frontend artifacts or committed production config.
