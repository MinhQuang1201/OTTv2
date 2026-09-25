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

- `config.js` — SIZE, TYPES, BEATS, GOAL, A_SETUP, PORT. A (Đỏ) khởi tạo phía trên bên phải; B (Xanh) là đối xứng 180° phía dưới bên trái.
- `rules.js` — `createInitialState`, `getLegalMoves`, `applyMove`, `detectWinner`, `publicState`. Không I/O.
- `room.js` — ghế A/B, `handleMove`, ngắt kết nối = đối phương thắng.
- `server.js` — file tĩnh + WS. Không chứa luật.
- `playfull.js` — khách WS. Không chứa luật.
- `game.js` — sảnh / bàn / local / AI. Online: chỉ gửi `pf.move`, vẽ `state` từ server.
- `ai.js` — `chooseMove(state, player)`. Thay file này khi gắn AI khác.

## Thuật ngữ

Dùng [CONTEXT.md](CONTEXT.md): Quân, Loại quân, Ô, Ô thắng, Xếp chồng, Ăn, Đòn thua, Lượt, Ván, Tuyệt chủng, Ghế, Phòng, Playfull.

Không gọi ô thắng là “nhà vua”. Không gọi xếp chồng là merge.

## Luật bất biến

- Đi 1 ô, 8 hướng.
- Không vào ô có quân cùng phe.
- Cùng loại → xếp chồng, không ăn.
- Thua oẳn tù tì → quân đi bị loại, quân đứng yên.
- A thắng trên a9, B thắng trên i1. Đứng ô thắng của đối phương không thắng.
- Tuyệt chủng toàn bộ quân của một ghế → ghế kia thắng ngay.
- Sau nước không thắng, lượt luôn chuyển sang ghế kia.
- Thế trận không cho bước 1 vào ô thắng của mình.

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
