# OTTv2 – Oẳn Tù Tì

Cờ chiến thuật hai người trên bàn 9×9. Mỗi quân là Đấm, Lá hoặc Kéo. Ăn theo oẳn tù tì. Thắng khi đưa quân vào ô thắng của mình, hoặc khi ăn hết toàn bộ quân đối phương.

**Demo online:** [https://ottv2.tail05145a.ts.net/](https://ottv2.tail05145a.ts.net/)

- Người A (Đỏ) thắng trên **i1**. Người B (Xanh) thắng trên **a9**.
- Đi như vua cờ vua: 8 hướng, 1 ô.
- Cùng loại khác phe: nước đi bị từ chối; mỗi ô chỉ có một quân.
- Khác loại: bên thắng oẳn tù tì ăn; bên thua mất quân đi (đòn thua).
- Đội hình Duel theo `Rule.md`: A ở A3:C5; B là ảnh xoay 180 độ ở I7:G5.

## Chạy

Cần Node.js 18 trở lên.

```bash
cd D:\Projects\Oantuti
npm install
npm test
npm start
```

Mở trình duyệt: [http://localhost:3000](http://localhost:3000)

Sinh lại icon quân (nếu cần):

```bash
npm run assets
```

## Chơi

1. Đặt tên.
2. Chọn **Duel** (2 người) hoặc **Arena** (4 người).
3. **Tạo phòng** — nhận mã 4 ký tự, chờ đủ ghế.
4. **Vào phòng** / **Xem trận** — nhập mã, hoặc bấm một phòng trên sảnh.
5. **Hai người một máy** — luân phiên trên cùng trình duyệt.
6. **Đấu với máy** — bạn là Người A; máy là Người B.

Hai máy / hai tab: một bên tạo phòng, bên kia vào bằng mã. Luật online do server quyết.

Tài liệu thư viện kết nối: [http://localhost:3000/playfull.html](http://localhost:3000/playfull.html)

## Luật tóm tắt

| | |
|---|---|
| Bàn | 9×9, file a–i, rank 1–9 |
| Quân | Mỗi bên 9 quân: 3 Đấm, 3 Lá, 3 Kéo |
| Vòng ăn | Đấm > Kéo > Lá > Đấm |
| Di chuyển | 1 ô, 8 hướng; không ra ngoài bàn; không vào ô có quân cùng phe |
| Cùng loại | Không được đi vào ô có quân đối phương cùng loại |
| Ô thắng | A: i1 · B: a9 — chỉ quân của chính mình |
| Ăn hết quân | Không còn quân nào của đối phương → thắng ngay |
| Hết nước | Người tới lượt không còn nước hợp lệ → người vừa đi thắng |
| Hết giờ | Đồng hồ người chơi về 0 → đối thủ thắng |
| Thế trận | A ở A3:C5; B xoay 180 độ ở I7:G5; không đặt quân sẵn trên I1/A9 |
| Đồng hồ | 10 phút mỗi ghế; server quyết định timeout |
| Kết nối lại | Grace 60 giây; `leave` xử thua ngay, `close` giữ ghế |

Chi tiết thuật ngữ: [CONTEXT.md](CONTEXT.md).

## Cấu trúc

```
config.js          Hằng số bàn, quân, cổng, Duel/Arena
rules.js           Luật thuần: đi, ăn, thắng, 2 hoặc 4 ghế
ai.js              Máy chọn nước (thay thế được)
room.js            Phòng, ghế, khán giả, chat, trọng tài
persist.js         Thắng/thua, bảng xếp (JSON)
server.js          HTTP tĩnh + WebSocket
playfull.js        Thư viện khách realtime
playfull.html      Tài liệu Playfull
index.html         Giao diện
game.js            Sảnh, bàn, chế độ chơi
style.css          Bố cục
tokens.css         Màu, chữ, nhịp
assets/            Icon quân và sprite sheet rps-atlas.png
tests/             Luật và phòng
scripts/gen-assets.js
```

Luật không nằm trong UI. Khi chơi mạng, `Room.handleMove` gọi `rules.applyMove`; khách chỉ vẽ trạng thái server gửi.

## Kiểm thử

```bash
npm test
```

`tests/rules.test.js` — xếp quân, đối xứng, tám hướng, nước đi, ăn, đòn thua, ô thắng, no-moves và clock.

`tests/room.test.js` — hai ghế, sai lượt, rời phòng, lọc tên, Arena 4 ghế, khán giả, chat.

## UI / hiệu năng

- Bàn giữ sẵn 81 button cell và tái sử dụng khi render lại.
- Icon quân dùng `assets/rps-atlas.png`; `npm run assets` sinh lại cả icon đơn và atlas.
- Ô nhìn co theo viewport, nhưng hitbox mobile giữ tối thiểu 44×44 px và click được quy đổi theo tọa độ bàn.
- Âm thanh thao tác có thể bật/tắt ngay trên thanh bàn; lựa chọn lưu trong trình duyệt.

## Biến môi trường

`PORT` — cổng HTTP/WS, mặc định `3000`.

## Playfull (khách)

```js
const pf = new Playfull();
await pf.connect();
pf.on("state", (msg) => render(msg.state));
pf.create("An", { mode: "arena", roomName: "Rồng" });
pf.join("K7P2", "Bình");
pf.watch("K7P2", "Khán");
pf.move({ x: 8, y: 2 }, { x: 8, y: 1 });
pf.chat("GG");
pf.react("fire");
```

Sự kiện: `open`, `close`, `reconnecting`, `resumed`, `resumeFailed`, `error`, `hello`, `rooms`, `joined`, `state`, `chat`, `react`, `gameover`, `left`.
