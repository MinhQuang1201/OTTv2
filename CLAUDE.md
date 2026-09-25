# OTTv2

Cờ chiến thuật realtime 9×9. Luật thuần trong `rules.js`. Phòng và trọng tài trong `room.js`. Online được thiết kế dùng worker PartyKit/PlayHTML, nhưng rollout hiện BLOCKED; UI không được tự quyết nước đi.

## Lệnh

```bash
npm install
npm test
npm start
npm run assets
```

Node ≥ 18. Cổng mặc định 3000 (`PORT`).

## Ranh giới module

- `config.js` — SIZE, TYPES, BEATS, GOAL, A_SETUP, TIME_CONTROL, PORT. A (Đỏ) khởi tạo ở A3:C5; B (Xanh) là đối xứng 180° ở G5:I7.
- `rules.js` — `createInitialState`, `getLegalMoves`, `applyMove`, `detectWinner`, `publicState`. Không I/O.
- `room.js` — ghế A/B, `handleMove`, clock server-authoritative và grace reconnect.
- `server.js` — chỉ file tĩnh, không chứa game WebSocket hay luật; từ chối source/runtime private paths.
- `playhtml-game-client.js` — seam adapter lệnh `ott:*`; không chứa luật. Chỉ nhận factory sau evidence gate.
- `game.js` — sảnh / bàn / local / AI. Khi online được mở, chỉ gửi `move`, vẽ state authoritative từ worker.
- `ai.js` — `chooseMove(state, player)`. Thay file này khi gắn AI khác.

## Thuật ngữ

Dùng [CONTEXT.md](CONTEXT.md): Quân, Loại quân, Ô, Ô thắng, Ăn, Đòn thua, Lượt, Ván, Tuyệt chủng, Ghế, Phòng, PlayHTML.

Không gọi ô thắng là “nhà vua”. Mỗi ô chỉ có một quân; không dùng khái niệm xếp chồng.

## Luật bất biến

- Đi 1 ô, 8 hướng.
- Không vào ô có quân cùng phe.
- Không vào ô có quân đối phương cùng loại.
- Thua oẳn tù tì → quân đi bị loại, quân đứng yên.
- A thắng trên a9, B thắng trên i1. Đứng ô thắng của đối phương không thắng.
- Tuyệt chủng toàn bộ quân của một ghế → ghế kia thắng ngay.
- Sau nước không thắng, nếu ghế kia không có nước hợp lệ thì người vừa đi thắng với `no_moves`; nếu có, lượt chuyển sang ghế kia.
- Thế trận không cho bước 1 vào ô thắng của mình.
- Mỗi ghế có 10 phút; đồng hồ chỉ chạy ở ghế đang tới lượt và dừng khi ván kết thúc.
- `close` mạng bắt đầu grace reconnect 60 giây; `leave` chủ động xử thua ngay.

## Kiểm thử

Viết test tại `rules.applyMove` và `Room.handleMove`. Không test nội bộ UI.

```bash
npm test
```

## An toàn máy chủ

- `publicPath` nhốt trong thư mục dự án.
- Không phục vụ `server.js`, `room.js`, `package.json`, `node_modules`, `tests`.
- Tên người chơi: strip thẻ HTML, cắt `NAME_MAX`.
- `maxPayload` 8KB, cách 40ms một gói, tọa độ phải là số nguyên.

## Giao diện

Hallmark: Workbench, night zinc print shop, accent hue 35. Token trong `tokens.css`. Không nhét luật vào CSS.

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
- Playfull/WebSocket trong tài liệu lịch sử chỉ mô tả kiến trúc cũ; kiến trúc active là PartyKit/PlayHTML. Fork/worker PlayHTML thật và bootstrap connection vẫn BLOCKED cho tới khi có evidence trực tiếp.
- `OTT_PLAYHTML_CONNECTION_FACTORY` là điểm tích hợp duy nhất khi runtime PlayHTML/PartyKit chưa có trong repository. Không tự suy đoán API upstream.
- Khi BLOCKED: không tạo WebSocket/PartySocket, polling, second PlayHTML session, fake factory hoặc fallback transport; online UI phải unavailable và local/AI phải còn hoạt động.
- Authority boundary PartyKit `0.0.115`: `Stub.socket()` trả `WebSocket`, còn `Server.onMessage` không có authenticated inter-party origin/route metadata. Direct game `ott:create` phải bị từ chối; secure lobby-driven initialization vẫn BLOCKED. Không dùng internal payload marker forgeable, client relay hoặc process map làm authorization/routing.
- Không ghi Task 5 PASS, production-ready hoặc two-profile acceptance PASS nếu không có bằng chứng trực tiếp. Xem gate/evidence tại `HANDOFF.md`; trạng thái kỹ thuật Task 5 chỉ do `docs/playhtml-upstream-lock.md` sở hữu.
