# Kế hoạch: Ổn định chơi online và cải thiện cảm giác ăn quân

Ngày: 2026-10-22 · Cơ sở: `main` @ `fbf26a5` (staging) và tag `v1.2.0` (production).

## 1. Bối cảnh và cách kiểm tra

Người dùng báo chơi online đang lỗi và chưa hài lòng với khoảnh khắc ăn quân. Lần rà soát này
chạy trình duyệt thật (Playwright, Chromium, 2 profile độc lập) trên:

- staging: `https://ottv2-staging.vercel.app` + Worker `ottv2-staging` (code `main`);
- production: `https://ottv2-psi.vercel.app` + Worker `ottv2-minimal` (tag `v1.2.0`).

Kịch bản: A tạo phòng → B vào → mỗi bên đi 3 nước (có ăn quân); B gõ mã phòng để vào; A tải
lại trang giữa chừng; A rời bàn. Ngoài ra kiểm tra từng tính năng ngoài online (mục 3).

## 2. Lỗi online đã tái hiện

| # | Mức | Lỗi | Bằng chứng | Nguyên nhân (đã xác minh trong code) |
|---|---|---|---|---|
| O1 | Critical | **Tải lại trang (hoặc đóng tab) giữa ván là mất ghế.** Người chơi về sảnh, không có cách vào lại; sau 60 giây đối thủ thắng `disconnect_timeout`. | Staging: A reload → về sảnh. | `playhtml-game-client.js` có lưu `resumeCredential` vào storage, Worker có action `resume`, nhưng app không đọc lại khi khởi động: `OnlineSession` chỉ được tạo khi bấm Tạo/Vào phòng. |
| O2 | High | **Kẹt "Đang kết nối online…" vĩnh viễn.** Nút Tạo phòng bị khoá, không báo lỗi, không có nút huỷ. | Production hỏng 2/8 lần hợp lệ (không tính 1 lần lỗi do chính script QA): lần 1 WebSocket của B đóng trước khi kết nối; lần 2 A gửi `ott:attach` nhưng không có phản hồi trong 15 giây. Staging 0/4 lần. | Client gửi `ott:attach` **đúng một lần**, không timeout, không thử lại (`playhtml-game-client.js:392-420`). Ở server, đường attach có nhiều nhánh `return` im lặng (`processOttCommand`, `validateAttach`, `dispatchOttMessage(...).catch(() => undefined)`). **Nguyên nhân gốc phía server chưa xác định** (nghi khởi động lạnh Durable Object); cần log để xác nhận. |
| O3 | High | **Không chia sẻ được mã phòng.** Màn hình ván chỉ hiện `Phòng ott-<uuid>`; gõ đúng chuỗi đó để vào thì nhận màn hình "Đã xảy ra sự cố **not_found**". | Staging: B gõ mã A đang thấy → `not_found`. | `OnlineLobbyGateway.joinRoom` gửi nguyên chuỗi làm `allocationId`, không bỏ tiền tố `ott-`. Alias ngắn (`K7N-M4P`) server có hỗ trợ trong `join` nhưng UI không bao giờ hiển thị cho người tạo phòng. |
| O4 | Medium | Mã lỗi thô hiện cho người dùng (`not_found`, `not_available`, …). | Ảnh chụp O3. | `clientMessage()` hiển thị nguyên `error` từ server. |
| O5 | Medium | **Khán giả không dùng được trên staging/production**: mục "Trận đang diễn ra" luôn "không khả dụng". | Cả hai môi trường. | `deploy.yml` build frontend không truyền `VITE_OTT_SPECTATOR_ENABLED`, trong khi Worker đã bật `OTT_SPECTATOR_ENABLED=true`. |
| O6 | Low | Lúc đang chờ người thứ hai, thẻ đối thủ vẫn ghi "Đã kết nối" và đồng hồ 10:00. | Ảnh staging, A sau khi tạo phòng. | Projection `players.B = null` được vẽ như người chơi đã kết nối. |

Đã chạy tốt (staging, 4/4 lần): tạo phòng, vào từ danh sách, 6 nước đi đồng bộ hai chiều, ăn quân,
đồng hồ chạy đúng lượt.

## 3. Rà soát các tính năng khác (staging)

| Tính năng | Kết quả | Ghi chú |
|---|---|---|
| Chơi cùng máy (81 ô, đi quân, ăn quân, lịch sử) | ✅ | Nhãn khó hiểu: badge "Ngoại tuyến", "Đối thủ · Đã kết nối", "Đến lượt bạn" cho cả hai bên. |
| Đấu AI dễ / trung bình / khó | ✅ | AI trả lời sau ~0,6–0,8 giây. |
| Xem lại trận (replay JSON) | ✅ | Mở được fixture `deterministic-match.json`. |
| Giải đấu người chơi (mở hộp thoại) | ✅ | Chưa thử luồng đầy đủ tạo giải → ghép trận. |
| Giao diện tối, xoay bàn, bật/tắt âm thanh | ✅ | |
| Điện thoại 390 px | ⚠️ | Không tràn ngang, ô 34 px; nhưng **bàn cờ nằm dưới ~750 px thanh công cụ + thẻ người chơi**, phải cuộn mới thấy. |
| Demo `?demo=…` | ℹ️ | Chỉ bật ở `npm run dev:web` (`import.meta.env.DEV`) — đúng thiết kế, README chưa nói rõ. |
| Khán giả | ❌ | Xem O5. |
| Arena | ℹ️ | Không có endpoint trên staging/production (chỉ chạy local). |
| `favicon.ico` | ⚠️ | 404 trên cả hai môi trường (chỉ là lỗi console). |

## 4. Hiện trạng khoảnh khắc ăn quân

Đọc code (`GameScreen.tsx`, `BoardCell.tsx`, `game.module.css`, `soundSynthesis.ts`) và ảnh chụp:

- Quân **dịch chuyển tức thời**; quân bị ăn **biến mất ngay**, không có chuyển động.
- Ô đích có viền đỏ + sáng lên 400 ms; cả bàn cờ "nảy" 200 ms; tiếng "bụp" 80 ms.
- Lịch sử chỉ ghi `Ăn quân · F3` — không biết quân nào ăn quân nào.
- Không có khay "quân đã ăn"; chỉ số đếm 3·4·3 giảm đi.
- Không giải thích vì sao không đi được vào ô có quân mạnh hơn (đòn thua bị loại khỏi nước hợp lệ).
- Mã UI còn xử lý sự kiện `strike_loss` ("Mất quân") của luật cũ; luật hiện tại coi đòn thua là nước không hợp lệ.
- Dữ liệu có sẵn đủ cho hiệu ứng: game-core phát `capture { pieceId, capturedId, capturedType, from, to }`;
  `normalizeCoreState.ts` hiện bỏ `capturedType` (loại quân suy ra được từ id như `A-keo-8`).

## 5. Kế hoạch triển khai

Mỗi giai đoạn là một PR riêng, có test, qua CI, kiểm tra trên staging trước khi gắn tag production.

### Giai đoạn 1 — Sửa chơi online (ưu tiên cao nhất)

| Việc | Nội dung | File chính | Kiểm thử / tiêu chí xong |
|---|---|---|---|
| 1.1 Vào lại sau khi tải trang (O1) | Khi app khởi động, nếu storage có ván dở (`__last_room__` + `resumeCredential` + `allocationId`) và ván chưa kết thúc: hiện thẻ "Bạn đang có ván dở — **Vào lại** / Bỏ". Bấm Vào lại → `OnlineSession.start({ intent: "resume" })` → `gateway.resumeRoom` → attach. Xoá dữ liệu khi ván kết thúc hoặc khi resume bị từ chối. | `App.tsx`, `OnlineSession.ts`, `contract.ts`, `LobbyScreen.tsx` | Vitest: có/không có dữ liệu, resume thành công, bị từ chối (xoá storage). Playwright staging: A reload giữa ván → vào lại đúng ghế, B thấy A "Đã kết nối" lại, đồng hồ đúng. |
| 1.2 Attach có timeout, thử lại và lối thoát (O2) | Sau khi gửi attach, nếu 8 giây chưa có `ott:state`: thử lại tối đa 2 lần (lấy ticket mới bằng `resume`), rồi báo lỗi có nút **Thử lại** / **Về sảnh**. Nút "Huỷ" khi đang kết nối ở sảnh. | `playhtml-game-client.js`, `OnlineSession.ts`, `OnlineRoomPanel.tsx` | Vitest với client giả không trả lời: retry đúng số lần, rồi `phase: "error"` có thể retry; không bao giờ kẹt `preparing`. |
| 1.3 Server không im lặng ở đường attach + log chẩn đoán (O2) | Thay các `return` im lặng trong `processOttCommand`/`validateAttach` bằng `ott:error` cụ thể (`attach_rejected`, `room_unavailable`); `logEvent` cho mọi lần attach thất bại (lý do, thời gian từ lúc khởi tạo DO, không ghi ticket). Theo dõi `wrangler tail`/Observability một tuần để tìm nguyên nhân gốc. | `ott-game-server.ts`, `observability/log.ts` | Node test: ticket sai/hết hạn/room sai → nhận `ott:error`, không im lặng. |
| 1.4 Mã phòng chia sẻ được (O3, O4) | Màn hình chờ hiện **alias** (`K7N-M4P`) to, có nút **Sao chép** và **Sao chép link** (`?join=K7N-M4P`). Join chấp nhận alias, `uuid`, `ott-uuid` (bỏ tiền tố ở cả client và Lobby). Bảng dịch mã lỗi → tiếng Việt (`not_found` → "Không tìm thấy phòng. Kiểm tra lại mã.", `not_available` → "Phòng đã đủ người hoặc đã bắt đầu."). | `GameTopBar.tsx`, `OnlineSession.ts`, `OnlineLobbyGateway.ts`, `ott-lobby-server.ts`, `App.tsx` (đọc `?join=`) | Vitest + node test cho 3 dạng mã; Playwright: B vào bằng alias và bằng link. |
| 1.5 Bật khán giả trong bản build deploy (O5) | Thêm `VITE_OTT_SPECTATOR_ENABLED` vào bước build của `deploy.yml` (lấy từ biến môi trường GitHub, mặc định `true` để khớp Worker); smoke test kiểm tra `/control/active` trả 200. | `.github/workflows/deploy.yml`, `scripts/smoke-deploy.js` | Staging: người thứ ba thấy trận và xem được read-only. |
| 1.6 Trạng thái chờ rõ ràng (O6) | Khi `players.B` rỗng: thẻ đối thủ hiện "Đang chờ người chơi…", ẩn đồng hồ đối thủ. | `PlayerPanel.tsx`, `normalizeOnlineState.ts` | Vitest snapshot trạng thái waiting. |

Sau giai đoạn 1: chạy `npm run test:e2e` (hai profile) + kịch bản QA trong mục 1 trên staging, rồi gắn tag `v1.3.0` cho production.

### Giai đoạn 2 — Cảm giác ăn quân (cần chốt hướng thiết kế, xem mục 6)

| Việc | Nội dung |
|---|---|
| 2.1 Quân trượt khi đi | Hoạt ảnh FLIP 160–200 ms từ ô đi tới ô đến, áp dụng mọi chế độ (local, AI, online, replay) — dựa trên sự kiện `move`/`capture` có `from`/`to`. |
| 2.2 Khoảnh khắc đối đầu | Khi `capture`: quân tấn công lao vào (scale + rung nhẹ), quân bị ăn **vỡ thành mảnh pixel** rồi mờ đi (~350 ms) trước khi bị gỡ khỏi DOM; nhãn nổi trên ô: **"✂ Kéo ăn 📄 Lá"** ~900 ms. |
| 2.3 Khay "quân đã ăn" | Dưới mỗi thẻ người chơi: biểu tượng các quân đã ăn được, quân mới nhất nhấp nháy. |
| 2.4 Lịch sử rõ nghĩa | `#6 Xanh · Kéo F4→F3 ăn Lá (Đỏ)` với biểu tượng loại quân; giữ `capturedType` khi normalize. |
| 2.5 Âm thanh & rung | Âm thanh khác nhau cho "mình ăn" / "bị ăn"; `navigator.vibrate(30)` trên điện thoại khi bị ăn (tôn trọng nút tắt âm thanh). |
| 2.6 Giải thích nước bị chặn | Khi chọn quân, ô có quân đối phương mạnh hơn hiện dấu khoá nhỏ + tooltip "Lá thua Kéo"; nhấn vào thì toast giải thích thay vì không có phản hồi. |
| 2.7 Dọn tàn dư | Bỏ `strike_loss` khỏi model/UI/demo; cập nhật test. |

Ràng buộc: hiệu ứng chỉ là trình bày từ sự kiện (không đổi luật, không chặn input quá 400 ms);
tắt hoặc rút gọn khi `prefers-reduced-motion`; online vẫn vẽ theo snapshot server; có test
Vitest cho thứ tự/hàng đợi hiệu ứng và trạng thái reduced-motion.

### Giai đoạn 3 — Hoàn thiện trải nghiệm

| Việc | Nội dung |
|---|---|
| 3.1 Bố cục điện thoại | Ở ≤ 600 px: bàn cờ lên đầu; thẻ người chơi thu gọn thành 1 dòng (tên · đồng hồ · số quân) trên/dưới bàn; thanh công cụ gọn thành biểu tượng. |
| 3.2 Nhãn chế độ chơi cùng máy | Badge "Chơi trên thiết bị" thay cho "Ngoại tuyến"; "Lượt của Đỏ/Xanh" thay cho "Đến lượt bạn"; bỏ "Đã kết nối". |
| 3.3 Favicon + README demo | Thêm favicon; README ghi rõ `?demo=` chỉ chạy ở `dev:web`. |
| 3.4 Test e2e online trong CI | Đưa kịch bản Playwright hai profile (tạo, vào bằng alias, đi, reload-resume, rời) vào một job CI chạy với Worker local. |

## 6. Quyết định (chốt ngày 2026-10-22)

1. **Hướng thiết kế ăn quân**: làm **đầy đủ** 2.1–2.7 (quân trượt, vỡ pixel, nhãn "Kéo ăn Lá", khay quân
   đã ăn, lịch sử rõ nghĩa, âm thanh/rung, giải thích nước bị chặn, dọn `strike_loss`).
2. **Vào lại sau tải trang**: hiện thẻ **"Bạn đang có ván dở — Vào lại / Bỏ"** ở sảnh, không tự động vào.
3. **Thứ tự**: làm **giai đoạn 1 trước**, kiểm tra staging và gắn tag production, rồi mới tới giai đoạn 2.
