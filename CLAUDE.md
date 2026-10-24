# OTTv2

Cờ chiến thuật realtime 9×9. Luật thuần trong `packages/game-core/src/rules.js`. Phòng và trọng tài trong `packages/game-core/src/room.js`. Online dùng Worker/PlayHTML, đã deploy production từ tag `v*` qua CI nhưng chưa qua nghiệm thu thủ công (giai đoạn 4 trong `OTTv2-ke-hoach-trien-khai.md`); UI không được tự quyết nước đi.

## Lệnh

```bash
npm ci
npm test
npm start
npm run dev:web
npm run build:web
npm run test:web
npm run typecheck:web
```

Node ≥ 22 (`.nvmrc`). Cổng mặc định 3000 (`PORT`).

## Ranh giới module

- `packages/game-core/src/config.js` — SIZE, TYPES, BEATS, GOAL, A_SETUP, TIME_CONTROL, PORT. A (Đỏ) khởi tạo ở khu vực E8:H5; B (Xanh) là đối xứng 180°.
- `packages/game-core/src/rules.js` — `createInitialState`, `getLegalMoves`, `applyMove`, `detectWinner`, `publicState`. Không I/O.
- `packages/game-core/src/room.js` — ghế A/B, `handleMove`, clock server-authoritative và grace reconnect.
- `server.js` — chỉ file tĩnh, không chứa game WebSocket hay luật; phục vụ `apps/web/dist` sau `npm run build:web`, từ chối source/runtime private paths.
- `packages/game-client/src/playhtml-game-client.js` — seam adapter lệnh `ott:*`; không chứa luật. Chỉ nhận factory sau evidence gate.
- `apps/web/src/features/` — React lobby, board, result, and shared UI. Không nhét luật vào component.
- `apps/web/src/sessions/` — local, AI, demo, and online session boundaries. Online chỉ gửi lệnh và vẽ snapshot authoritative.
- `apps/web/static/playhtml-game.html` — retained adapter diagnostic page; không phải game UI thứ hai.
- `packages/game-core/src/ai.js` — `chooseMove(state, player, { level })` với level `easy`/`medium`/`hard` (mặc định `hard`): minimax cắt tỉa alpha-beta có giới hạn số nút. UI chạy nó trong Web Worker (`apps/web/src/sessions/ai/`). Thay file này khi gắn AI khác.
- `packages/bot-cup-core/src/` — luật thuần của Bot Cup: điều kiện tham gia theo chế độ `demo`/`production`, đội, OTP, khung đăng ký. Không I/O. Kế hoạch: `docs/superpowers/plans/2026-10-23-uet-k71-bot-cup.md`.
- `apps/bot-cup-api/` — Worker đăng ký Bot Cup (D1 binding `DB`, migration trong `migrations/`), phục vụ `/api/t/*` qua Vercel rewrite. Tách hẳn `apps/worker` và PlayHTML; mã bot của đội không bao giờ chạy ở Worker hay trình duyệt. Điều phối giải ở `src/tournament/engine.mjs` (trang BTC gọi): mỗi bước kiểm tra giai đoạn, chờ mọi ván xong, trả về một batch; bài niêm phong (`entrants`) và tài liệu công bố (`stage_results`) có trigger chặn sửa.
- `apps/bot-cup-runner/` — runner Node trên máy BTC: kéo job từ `/runner/*` (token), chạy check và ván trong container sandbox theo `bot-cup-policy-v1`, gửi replay gọn; Worker chơi lại replay bằng `rules.js` (`bot-cup-core.verifyReplay`) trước khi ghi. Mã đội chỉ chạy trong container; không dọn container đồng bộ (làm sai đồng hồ ván khác).
- `apps/bot-cup-admin/` — trang BTC (Worker riêng, cùng D1): Access JWT hoặc mật khẩu+TOTP (`ADMIN_AUTH_MODE`), email phải có trong `admins`; mọi lệnh ghi kèm đúng một dòng audit chuỗi băm trong cùng batch; loại đội/sửa kết quả/xác nhận vi phạm cần admin thứ hai duyệt. Không liên kết từ web người chơi. Chống gian lận (P8): JPlag chạy trên máy BTC (`scripts/bot-cup/similarity.mjs`, template là base code); vân tay hành vi qua job `probe` với bộ thế cờ bí mật chỉ nằm trên máy runner (`var/bot-cup/probe-sets/`, không bao giờ commit hay gửi lên Worker); Worker chỉ biết SHA-256 của bộ.
- `sdk/bot-cup/` — starter kit cho đội (template Python/JS, `judge.mjs` trọng tài cục bộ, `GUIDE.vi.md`); `npm run bot-cup:kit` đóng gói. Đổi template hoặc bot tham chiếu thì chạy `npm run bot-cup:reference-hashes` (test kiểm tra).
- `apps/web/src/features/bot-cup/` — banner sảnh và màn hình giải (tải lười). Chỉ gọi `/api/t` qua `BotCupApiGateway`; mọi mã lỗi API phải có thông điệp trong `botCupMessages.ts` (có test).

## Thuật ngữ

Dùng [CONTEXT.md](CONTEXT.md): Quân, Loại quân, Ô, Ô thắng, Ăn, Đòn thua, Lượt, Ván, Tuyệt chủng, Ghế, Phòng, PlayHTML.

Không gọi ô thắng là “nhà vua”. Mỗi ô chỉ có một quân; không dùng khái niệm xếp chồng.

## Luật bất biến

- Đi 1 ô, 8 hướng.
- Không vào ô có quân cùng phe.
- Không vào ô có quân đối phương cùng loại.
- Nước thua oẳn tù tì là nước không hợp lệ → không có quân nào bị loại, trạng thái không đổi.
- A thắng trên a1, B thắng trên i9. Đứng ô thắng của đối phương không thắng.
- Tuyệt chủng toàn bộ quân của một ghế → ghế kia thắng ngay.
- Sau nước không thắng, nếu ghế kia không có nước hợp lệ thì người vừa đi thắng với `no_moves`; nếu có, lượt chuyển sang ghế kia.
- Thế trận không cho bước 1 vào ô thắng của mình.
- Mỗi ghế có 10 phút; đồng hồ chỉ chạy ở ghế đang tới lượt và dừng khi ván kết thúc.
- `close` mạng bắt đầu grace reconnect 60 giây; `leave` chủ động xử thua ngay.

## Kiểm thử

Viết test tại `rules.applyMove` và `Room.handleMove`. Không test nội bộ UI.

```bash
npm ci
npm run build:web        # server.test.js kiểm tra bản build thật, nên build trước
npm run test:unit        # = npm test; không cần Worker thật
npm run test:web
npm run typecheck:web
npm run typecheck:worker
npm run test:integration # wrangler dev --local, có timeout
npm run test:e2e         # Playwright hai context trên Worker local
npm run test:bot-cup     # Bot Cup: lõi + API trên SQLite (nằm trong test:unit)
npm run test:bot-cup:api # Bot Cup Worker qua wrangler dev --local + D1 local (nằm trong test:integration)
npm run bot-cup:api:dev  # Bot Cup API local cổng 8789 cho dev:web (bật VITE_OTT_BOT_CUP_ENABLED=true)
```

React parity/accessibility tests dùng feature/session contracts; board phải expose
đủ 81 ô có tên accessible. Demo scenarios gồm `?demo=result-goal`,
`result-elimination`, `result-no-moves`, `result-timeout`,
`result-disconnect-timeout`, `result-leave`, và `game-reconnecting`.

## An toàn máy chủ

- `publicPath` nhốt trong thư mục dự án.
- Không phục vụ `server.js`, `packages/game-core/src/room.js`, `package.json`, `node_modules`, `tests`.
- Tên người chơi: strip thẻ HTML, cắt `NAME_MAX`.
- `maxPayload` 8KB, cách 40ms một gói, tọa độ phải là số nguyên.

## Giao diện

Giao diện React dùng shared tokens trong `apps/web/src/shared/theme/tokens.css`. Không nhét luật vào CSS.

## PlayHTML

Đọc [docs/PLAYHTML_AI_GUIDE.md](docs/PLAYHTML_AI_GUIDE.md) trước khi thêm hoặc sửa PlayHTML. Guardrail bắt buộc:

- Mỗi phần tử chia sẻ có `id` duy nhất, ổn định; chỉ dùng `selector-id` cho danh sách cố định, không reorder.
- Phân loại state đúng: persistent element/page data, ephemeral presence/awareness, event một lần, hoặc local-only. Không tự dựng kênh WebSocket thứ hai cho cùng state.
- Dùng `setData` mutator cho update phụ thuộc state hiện tại; trong array mutator chỉ dùng `push` và `splice`; luôn giới hạn collection tăng dần.
- Không ghi shared state trong render, `updateElement`, hoặc effect/subscription theo dõi chính state đó. Không đồng bộ input tần suất cao ở từng event.
- Vanilla code mới dùng `register()`/`define()`, không dùng property API deprecated. React dùng một `PlayProvider` cho mỗi root.
- Không gắn `can-move`, `can-spin`, `can-grow` cùng element. Chỉ dùng `can-mirror` trong phạm vi nó hỗ trợ; state cần schema/validation dùng `can-play`.
- Với event payload, cursor options và React wrapper props có docs không nhất quán, kiểm tra declaration/runtime của package đang cài trước khi dùng.
- State ván online chỉ do worker/Room quyết định. Không ghi state bằng page data, element data, can-play, event hoặc presence; không tạo WebSocket client thứ hai.
- Playfull/WebSocket trong tài liệu lịch sử chỉ mô tả kiến trúc cũ. Kiến trúc active: Cloudflare Worker `apps/worker` (`partyserver@0.5.10`, `y-partyserver@2.2.0`) và fork PlayHTML tối giản `vendor/playhtml-minimal`. Package `partykit` không còn được dùng; thư mục `partykit/` là mã cũ chờ dọn, không sửa nó thay cho `apps/worker`.
- `OTT_PLAYHTML_CONNECTION_FACTORY` (đọc trong `apps/web/src/sessions/online/runtimeBridge.ts`) là điểm tích hợp connection duy nhất phía web. Không tự suy đoán API upstream.
- Khi online không khả dụng (thiếu endpoint, Worker lỗi): không tạo WebSocket/PartySocket, polling, second PlayHTML session, fake factory hoặc fallback transport; online UI phải unavailable và local/AI phải còn hoạt động.
- Authority boundary: Lobby khởi tạo Room và cập nhật ghế qua DO stub fetch `/internal/initialize`, `/internal/seat-update` có capability ký HMAC bằng `OTT_INTERNAL_SECRET` (`apps/worker/src/auth/internal-auth.ts`). Client chỉ vào Room bằng ticket `ott:attach`; route tạo trực tiếp `/ott/create` trả 404. Không dùng internal payload marker forgeable, client relay hoặc process map làm authorization/routing.
- Production đã deploy từ tag `v*` qua CI (`DEPLOYMENT.md`) nhưng chưa nghiệm thu thủ công. Không ghi Task 5 PASS, production-ready hoặc two-profile acceptance PASS nếu không có bằng chứng trực tiếp. Xem gate/evidence tại `HANDOFF.md`; trạng thái kỹ thuật chỉ do `docs/playhtml-upstream-lock.md` sở hữu.
