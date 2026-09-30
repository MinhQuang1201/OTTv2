# Báo Cáo Kiểm Thử Hệ Thống OTTv2

**Ngày kiểm thử:** 2026-09-29  
**Mục tiêu kiểm thử:** Kiểm thử toàn diện frontend, backend rules, arbitration engine, E2E browser và bảo mật ranh giới online của OTTv2 trên cả môi trường phát triển lẫn production deployment.  
**Địa chỉ website triển khai:** [https://ottv2-two.vercel.app](https://ottv2-two.vercel.app)  
**Vercel Project:** `lap-trinh-mang/ottv2`  
**Phương pháp thực thi:** Khởi tạo 7 subagent song song chuyên trách, kết hợp Playwright (Headless Chromium), Vitest, Node Test Runner, và static asset security audit.

---

## 1. Tổng Quan Kết Quả

| Hạng mục kiểm thử | Đơn vị thực thi | Công cụ / Môi trường | Trạng thái | Ghi chú |
| :--- | :--- | :--- | :---: | :--- |
| **HTTP, SSL/TLS & E2E Live Site** | Subagent 1 | Playwright Chromium, TLS inspection | **PASS** | 0 lỗi console, tải mượt trên Desktop/Mobile (1 defect favicon) |
| **Lobby & Mode Selection** | Subagent 2 | Playwright, Vitest | **PASS** | Điều hướng mượt, localStorage chuẩn (1 góp ý maxLength) |
| **Bàn cờ 9×9 & Tương tác quân** | Subagent 3 | Playwright, Vitest | **PASS** | 81 ô chuẩn, đối xứng 180° hoàn hảo, highlight 8 hướng |
| **Luật chơi thuần & Trọng tài** | Subagent 4 | Node Test Runner | **PASS** | 45/45 tests pass, bao quát Đấm-Lá-Kéo, Goal, Tuyệt chủng |
| **Gameplay Local & AI** | Subagent 5 | Playwright trên live site, Vitest | **PASS** | Chơi 4 nước thực tế, AI phản hồi tự động (~320ms) |
| **7 Kịch bản Demo & Result Dialog** | Subagent 6 | Playwright, Vitest | **PASS** | 61/61 tests pass, modal kết quả và reconnect banner chuẩn |
| **Bảo mật & Online Fail-Closed** | Subagent 7 | Node Test Runner, Bundle audit | **PASS** | 13/13 security tests pass, không rò rỉ secret, chặn Traversal |

---

## 2. Chi Tiết Kết Quả Từng Subagent

### Subagent 1: Live Website HTTP, SSL & E2E Inspection
- **Địa chỉ kiểm thử:** `https://ottv2-two.vercel.app`
- **Chứng chỉ SSL/TLS:**
  - Giao thức: TLSv1.3 (Cipher: `TLS_AES_128_GCM_SHA256`).
  - Nhà cấp phát: Google Trust Services (`CN=WR1`).
  - Tính hợp lệ: Còn hạn đến 27-11-2026, chuỗi chứng chỉ hợp lệ (`authorized: true`).
- **Phản hồi HTTP & Tài nguyên tĩnh:**
  - Redirect từ HTTP (`http://ottv2-two.vercel.app`) sang HTTPS (`308 Permanent Redirect`).
  - Trang chính (`/`): `HTTP 200 OK` (HTTP/1.1, ~128ms, Vercel Cache HIT, HSTS kích hoạt).
  - CSS Bundle (`/assets/index-e58xtQk7.css`): 31,160 bytes, nén Brotli, `HTTP 200 OK`.
  - JS Bundle (`/assets/index-cPf8RfvC.js`): 382,452 bytes, nén Brotli, `HTTP 200 OK`.
  - Font chữ: 9 tệp WOFF2 từ Google Fonts tải thành công với cache 1 năm.
- **Trình duyệt & Console:**
  - 0 lỗi JavaScript unhandled (`pageerror = 0`).
  - 0 cảnh báo hoặc lỗi console (`console.error = 0`, `console.warn = 0`).
  - 0 request mạng thất bại (`requestfailed = 0`).
- **Khả năng hiển thị Responsive:**
  - Desktop (`1280 × 800`): Hiển thị đầy đủ bảng điều khiển và bàn cờ, không có hiện tượng tràn ngang (`scrollWidth === clientWidth`).
  - Mobile (`375 × 667`): Các thẻ chế độ tự động xếp chồng theo một cột dọc, bàn cờ 9×9 tự động co giãn vừa vặn màn hình điện thoại.

---

### Subagent 2: Sảnh (Lobby) & Quản Lý Người Chơi
- **Tên người chơi:**
  - Trường nhập liệu "Tên của bạn" phản hồi mượt mà khi gõ.
  - Tự động cắt bỏ khoảng trắng thừa đầu/cuối chuỗi.
  - Dữ liệu được lưu trữ tự động vào `localStorage` với khóa `ottv2.playerName` và duy trì chính xác sau khi reload trang.
- **Thẻ chọn chế độ:**
  - **Cùng máy:** "Hai người chơi luân phiên trên một thiết bị" (Nút "Chơi cùng máy").
  - **Đấu với AI:** "Bạn đi trước, AI phản hồi sau mỗi nước hợp lệ" (Nút "Đánh với AI").
  - **Chơi online:** Panel kết nối phòng chơi từ xa.
  - **Trận đang diễn ra:** Bảng danh sách trận đấu dành cho khán giả xem trực tiếp.
- **Điều hướng màn hình:**
  - Bấm "Chơi cùng máy" điều hướng lập tức sang bàn cờ local. Bấm "Rời bàn" quay trở về sảnh chính.
  - Bấm "Đánh với AI" chuyển sang bàn cờ đấu máy. Bấm "Rời bàn" quay trở về sảnh chính an toàn.
- **Trạng thái Online Panel:**
  - Khi chưa cấu hình Worker endpoint, hệ thống hiển thị badge: `"Online hiện không khả dụng"`, thông báo `"Bạn có thể bắt đầu ván local hoặc đấu với AI ngay"`, và vô hiệu hóa 2 nút Tạo/Vào phòng.
- **Kết quả Unit Test:** `rtk npm run test:web -- apps/web/src/features/lobby/`: **15/15 tests passed** (2 files).

---

### Subagent 3: Bàn Cờ 9×9 & Tương Tác Quân Cờ
- **Lưới tọa độ 9×9:**
  - Đủ **81 ô cờ** với test ID từ `board-cell-A1` đến `board-cell-I9`.
  - Mỗi ô đều có nhãn trợ năng ARIA rõ ràng (`aria-label="Ô <Tọa độ> · <Trạng thái>"`).
  - Trục ngang hiển thị các cột `A B C D E F G H I`; trục dọc hiển thị các hàng `1 2 3 4 5 6 7 8 9`.
- **Khởi tạo và đối xứng 180°:**
  - Mỗi bên sở hữu 10 quân: 3 Đấm, 4 Lá, 3 Kéo (Tổng cộng 20 quân cờ trên bàn).
  - Người A (Đỏ): Chiếm các ô E8, F8, E7, F7, G7, F6, G6, H6, G5, H5.
  - Người B (Xanh): Đối xứng tâm qua tọa độ $(8-x, 8-y)$. Độ lệch đối xứng: **0** (Hoàn hảo 100%).
- **Thao tác chọn & Hủy chọn:**
  - Nhấp chọn quân E8 (Lá của Người A): Áp dụng hiệu ứng phát sáng neon (`cellSelected`), cập nhật `aria-pressed="true"`.
  - Hiển thị chính xác **5 ô mục tiêu hợp lệ** theo 8 hướng (`D7`, `D8`, `D9`, `E9`, `F9`), tự động loại trừ các ô có quân cùng phe (E7, F7, F8).
  - Nhấp vào ô trống bất kỳ ngoài phạm vi: Hủy chọn hoàn toàn, xóa bỏ toàn bộ dấu chấm chỉ hướng.
- **Thực thi nước đi:**
  - Đi quân từ E8 sang D7: Ô E8 trở thành ô trống, ô D7 chứa quân Lá của Người A.
  - Quyền đi lập tức chuyển sang Người B; Người B xuất hiện badge "Đang đi".
  - Thanh lịch sử HUD ghi nhận: `#1 Di chuyển · D7`.
- **Kết quả Unit Test:** `Board.test.tsx` & `GameScreen.test.tsx`: **13/13 tests passed** (2 files).

---

### Subagent 4: Luật Chơi Thuần & Trọng Tài (`packages/game-core`)
- **Di chuyển cơ bản:**
  - Đi 1 ô theo 8 hướng xung quanh.
  - Từ chối di chuyển quá 1 ô (ví dụ: E8 đến E6) hoặc di chuyển tại chỗ (E8 đến E8).
  - Từ chối tọa độ ngoài bàn cờ hoặc tọa độ thập phân.
  - Từ chối nước đi khi chưa tới lượt hoặc ghế không hợp lệ.
- **Vòng quy tắc oẳn tù tì:**
  - **Đấm ăn Kéo:** Quân Đấm vào ô quân Kéo đối phương → Ăn quân thành công, phát sinh sự kiện `capture`.
  - **Kéo ăn Lá:** Quân Kéo vào ô quân Lá đối phương → Ăn quân thành công.
  - **Lá ăn Đấm:** Quân Lá vào ô quân Đấm đối phương → Ăn quân thành công.
  - Đảm bảo bất biến một ô chỉ có tối đa một quân cờ sau mỗi nước ăn.
- **Nước đi bị cấm (Bảo vệ quân):**
  - Không được đi vào ô có quân cùng phe.
  - **Hòa cùng loại là cấm đi:** Không được đi vào quân đối phương cùng loại (Đấm vào Đấm, Lá vào Lá, Kéo vào Kéo). Nước đi bị từ chối hoàn toàn, trạng thái giữ nguyên.
  - **Đòn thua là cấm đi:** Quân yếu hơn không được đi vào quân khắc chế nó (Đấm không được đi vào Lá). Quân tấn công không bị loại do đòn đánh thua.
- **Quy tắc phân định thắng thua:**
  - **Chiếm ô thắng (Goal):** Người A thắng khi đưa quân vào `a1`; Người B thắng khi đưa quân vào `i9`. Cả 2 bên đều cách ô thắng tối thiểu 4 bước (không thể thắng ở nước 1). Đứng vào ô thắng của đối thủ không được tính thắng.
  - **Tuyệt chủng (Extinction):** Khi một bên bị ăn sạch toàn bộ 10 quân, bên còn lại thắng ngay lập tức.
  - **Hết nước đi (No Moves):** Nếu bên tới lượt không còn bất kỳ nước đi hợp lệ nào trên bàn cờ, người vừa thực hiện nước đi trước đó được xử thắng.
- **Đồng hồ & Trọng tài:**
  - Khởi tạo 10:00 (600,000 ms) cho mỗi bên. Đồng hồ chỉ đếm lùi ở bên đang tới lượt.
  - Chạm mốc 0ms bị xử thua `timeout`.
  - Mất kết nối mạng kích hoạt thời gian chờ kết nối lại (Grace Period: 60 giây). Quá 60 giây xử thua `disconnect_timeout`.
  - Tự ý rời trận xử thua ngay lập tức với lý do `leave`.
- **Kết quả Kiểm thử:** `node --test tests/rules.test.js tests/room.test.js`: **45/45 tests passed**.

---

### Subagent 5: Gameplay Thực Chiến Local & AI
- **Chế độ Chơi 2 người trên một máy (Local):**
  - Chơi liên tục 4 nước mở màn luân phiên trên web live:
    - Nước 1 (Người A): E8 → E9.
    - Nước 2 (Người B): E2 → E1.
    - Nước 3 (Người A): F8 → F9.
    - Nước 4 (Người B): D2 → D1.
  - Badge "Đang đi" chuyển đổi chính xác qua từng lượt; thông báo trạng thái cập nhật `"Đến lượt bạn"` theo lượt hiện tại.
  - Đồng hồ của bên đang đi đếm ngược chính xác (`10:00` → `09:58`), trong khi đồng hồ của đối phương tạm dừng.
  - Lịch sử nước đi ghi nhận đủ 4 dòng theo thứ tự tăng dần.
  - Hành động "Rời bàn" trong chế độ Local: Rời ngay về sảnh chính (do không có hình phạt xử thua người chơi từ xa).
- **Chế độ Đấu với máy (AI):**
  - Người chơi cầm quân Đỏ (Phe A), AI cầm quân Xanh (Phe B - nhãn `"Máy"`).
  - Khi người chơi thực hiện nước đi, giao diện hiển thị trạng thái: `"AI đang suy nghĩ…"` và tạm khóa thao tác bàn cờ.
  - Sau khoảng trễ tự nhiên ~320ms, thuật toán AI (`chooseMove`) tự động chọn và đi nước cờ hợp lệ (`#2 Di chuyển · E5`, `#4 Di chuyển · E6`).
  - Quyền đi trả lại cho người chơi với thông báo `"Đến lượt bạn"`.
- **Kết quả Unit Test:** `LocalSession.test.ts` & `AiSession.test.ts`: **11/11 tests passed**.

---

### Subagent 6: 7 Kịch Bản Demo & Hộp Thoại Kết Quả
- **Cơ chế Production Gating:**
  - Trên môi trường production, code được đóng gói với `import.meta.env.DEV = false`.
  - Khi người dùng cố tình truy cập link chứa `?demo=...` trên production, hệ thống kích hoạt cơ chế bảo vệ, tự động fallback về `lobby-default` an toàn để chống can thiệp trạng thái.
- **Kiểm thử chi tiết 7 kịch bản kết quả (Live Runtime):**
  1. `?demo=result-goal`: Hộp thoại "Bạn thắng" (Emblem 🏆, lý do: *"Đưa quân vào ô thắng A1"*).
  2. `?demo=result-elimination`: Hộp thoại "Bạn thắng" (Emblem 🏆, lý do: *"Đối phương không còn quân nào"*).
  3. `?demo=result-no-moves`: Hộp thoại "Bạn thua" (Emblem 💀, lý do: *"Đối phương không còn nước đi hợp lệ"*).
  4. `?demo=result-timeout`: Hộp thoại "Bạn thua" (Emblem 💀, lý do: *"Hết giờ"*).
  5. `?demo=result-disconnect-timeout`: Hộp thoại "Bạn thua" (Emblem 💀, lý do: *"Đối thủ không kết nối lại trong thời gian cho phép"*).
  6. `?demo=result-leave`: Hộp thoại "Bạn thua" (Emblem 💀, lý do: *"Đối thủ đã rời bàn"*).
  7. `?demo=game-reconnecting`: Badge cảnh báo "Đang kết nối lại…", khóa vô hiệu hóa toàn bộ 81 ô cờ trên bàn.
- **Tương tác hộp thoại:**
  - Nút **"Xem bàn"**: Đóng modal kết quả để người chơi quan sát lại toàn bộ thế trận cuối cùng.
  - Nút **"Về sảnh"**: Giải phóng session hoàn toàn (`dispose`) và đưa người chơi về màn hình sảnh chính.
- **Kết quả Unit Test:** `features/result`, `features/demo`, `sessions/demo`: **61/61 tests passed** (5 files).

---

### Subagent 7: Kiểm Toán Bảo Mật & Ranh Giới Online
- **Cơ chế Fail-Closed của chế độ Online:**
  - Khi frontend chưa nhận được địa chỉ Cloudflare Worker hợp lệ, ứng dụng tự động ngắt kết nối an toàn (`available: false`).
  - Tuyệt đối không tự ý khởi tạo `new WebSocket(...)` hay `new PartySocket(...)` vượt rào.
  - Màn hình hiển thị thông điệp thân thiện: `"Online hiện không khả dụng"`, vô hiệu hóa các nút tương tác tạo phòng/vào phòng.
- **Rà soát rò rỉ mã nguồn & Secrets trong JS Bundle:**
  - Đã quét toàn bộ bundle production (`apps/web/dist/assets/index-*.js` và bundle trên Vercel):
    - `OTT_INTERNAL_SECRET`: **0 matches** (Hoàn toàn không có trong client code).
    - `probe_secret` / `OTT_PROBE`: **0 matches**.
    - Token xác thực và secret nội bộ: **0 matches**.
  - Toàn bộ exception được chuyển đổi qua hàm `safeSessionError()`, ngăn chặn rò rỉ stack trace server ra giao diện người dùng.
- **Khóa tính năng Khán giả (Spectator Feature Flag):**
  - Khi `OTT_SPECTATOR_ENABLED` khác `"true"`, các route `/parties/lobby/*` trả về **HTTP 404**, kết nối WebSocket khán giả bị đóng với mã `1008 (spectator_disabled)`.
- **Bảo vệ máy chủ file tĩnh (`server.js`):**
  - Chặn đứng 100% tấn công Path Traversal (`/..`, `/%2e%2e`).
  - Chặn các biến thể chữ hoa/chữ thường đối với file nhạy cảm (`/SeRvEr.Js`, `/.ENV`, `/PACKAGE.JSON`).
  - Chặn truy cập vào các thư mục nội bộ `partykit/`, `workers/`, `tests/`, `node_modules/`.
  - Chặn kỹ thuật Symlink Breakout ra ngoài thư mục gốc.
- **Kết quả Kiểm thử:** `node --test tests/server.test.js ...`: **13/13 tests passed**.

---

## 3. Tổng Hợp Số Liệu Kiểm Thử Toàn Dự Án

```text
================================================================================
KẾT QUẢ KIỂM THỬ HỆ THỐNG
================================================================================
1. Unit & Integration Tests (Node Test Runner):
   - Tổng số test:       226 tests (218 passed, 8 skipped do cần .dev.vars)
   - Tỷ lệ thành công:   100% đối với các test có thể chạy tự động.

2. Web & UI Component Tests (Vitest):
   - Tổng số test:       232 tests (25 test files)
   - Tỷ lệ thành công:   232 / 232 passed (100%)
   - Thời gian thực thi: ~8.25 giây

3. Typecheck (TypeScript):
   - Lệnh thực thi:      tsc -p apps/web/tsconfig.json --noEmit
   - Kết quả:            0 errors, 0 warnings

4. Bundle Build (Vite):
   - Kết quả:            Build thành công trong ~1.13 giây
   - Asset size:         index.html (0.93 kB), CSS (31.16 kB), JS (380.58 kB)
================================================================================
```

---

## 4. Các Điểm Khuyết Thiếu Nhỏ & Khuyến Nghị Nâng Cấp

1. **Bổ sung Favicon (`/favicon.ico`):**
   - *Hiện trạng:* File `index.html` chưa khai báo `<link rel="icon">`, khi trình duyệt tự động gửi request lấy `/favicon.ico` thì nhận mã `404 Not Found`.
   - *Khuyến nghị:* Đặt một file `favicon.ico` hoặc `icon.svg` vào thư mục `apps/web/static/` hoặc `apps/web/public/`.
2. **Thêm giới hạn độ dài ký tự cho ô nhập tên (`maxLength`):**
   - *Hiện trạng:* Backend server khống chế độ dài tên tối đa là 20 ký tự (`NAME_MAX: 20`). Tuy nhiên trên thẻ `<input>` tại sảnh hiện chưa gắn thuộc tính `maxLength={20}`, cho phép người dùng gõ chuỗi dài hơn trước khi bị cắt lúc gửi đi.
   - *Khuyến nghị:* Thêm thuộc tính `maxLength={20}` vào component `<TextField>` của trường nhập tên tại `LobbyScreen.tsx`.

---

## 5. Kết Luận

Website **OTTv2** tại địa chỉ **[https://ottv2-two.vercel.app](https://ottv2-two.vercel.app)** đạt chất lượng cao:
- Giao diện trực quan, responsive tốt trên mọi kích thước màn hình.
- Các chế độ chơi **Chơi trên một thiết bị** và **Đấu với máy (AI)** hoạt động trơn tru, chuẩn xác theo từng điều luật oẳn tù tì 9×9.
- Hệ thống phòng thủ bảo mật vững chắc, tuân thủ nguyên tắc fail-closed và không để rò rỉ bất kỳ thông tin nhạy cảm nào ra môi trường client.
