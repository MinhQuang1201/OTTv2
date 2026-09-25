# OTTv2

Cờ chiến thuật realtime 9×9. Luật thuần trong `rules.js`. Phòng và trọng tài trong `room.js`. Khách nối máy chủ qua `playfull.js`. UI không được tự quyết nước đi khi chơi online.

## Lệnh

```bash
npm install
npm test
npm start
npm run assets
```

Node ≥ 18. Cổng mặc định 3000 (`PORT`).

## Ranh giới module

- `config.js` — SIZE, TYPES, BEATS, GOAL, ARENA_GOAL, MODES, A_SETUP, A_ARENA_SETUP, TIME_CONTROL, PORT. Duel: A trên-phải, B đối xứng 180°. Arena: bốn góc, xoay 90°.
- `rules.js` — `createInitialState(mode)`, `getLegalMoves`, `applyMove`, `detectWinner`, `publicState`. Không I/O.
- `room.js` — ghế Duel A/B hoặc Arena A–D, khán giả, chat, đồng hồ server-authoritative, grace reconnect và `handleMove`.
- `persist.js` — JSON `data/store.json`, thắng/thua, bảng xếp. Không chứa luật.
- `server.js` — file tĩnh + WS + `/api/leaderboard`. Không chứa luật.
- `playfull.js` — khách WS. Không chứa luật.
- `game.js` — sảnh / bàn / local / AI / xem. Online: chỉ gửi `pf.move`, vẽ `state` từ server.
- `ai.js` — `chooseMove(state, player)`. Thay file này khi gắn AI khác.

## Thuật ngữ

Dùng [CONTEXT.md](CONTEXT.md): Quân, Loại quân, Ô, Ô thắng, Xếp chồng, Ăn, Đòn thua, Lượt, Ván, Tuyệt chủng, Ghế, Phòng, Playfull, Duel, Arena, Khán giả, Chat phòng.

Không gọi ô thắng là “nhà vua”. Mỗi ô chỉ có một quân; không dùng khái niệm xếp chồng.

## Luật bất biến

- Đi 1 ô, 8 hướng.
- Không vào ô có quân cùng phe.
- Không vào ô có quân đối phương cùng loại.
- Thua oẳn tù tì → quân đi bị loại, quân đứng yên.
- A thắng trên a9, B thắng trên i1. Đứng ô thắng của đối phương không thắng.
- Tuyệt chủng toàn bộ quân của một ghế: Duel → ghế kia thắng ngay; Arena → loại ghế, ván tiếp nếu còn ≥2 ghế có quân.
- Sau nước không thắng, lượt chuyển sang ghế kế tiếp còn quân.
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
