# OTTv2 – Oẳn Tù Tì

Cờ chiến thuật hai người trên bàn 9×9. Mỗi quân là Đấm, Lá hoặc Kéo. Ăn theo oẳn tù tì. Thắng khi đưa quân vào ô thắng của mình, hoặc khi ăn hết toàn bộ quân đối phương.

- Người A (Đỏ) thắng trên **a9**. Người B (Xanh) thắng trên **i1**.
- Đi như vua cờ vua: 8 hướng, 1 ô.
- Cùng loại: xếp chồng, không ăn.
- Khác loại: bên thắng oẳn tù tì ăn; bên thua mất quân đi (đòn thua).

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
2. **Tạo phòng** — nhận mã 4 ký tự, chờ người thứ hai.
3. **Vào phòng** — nhập mã, hoặc bấm một phòng đang chờ.
4. **Hai người một máy** — luân phiên trên cùng trình duyệt.
5. **Đấu với máy** — bạn là Người A; máy là Người B.

Hai máy / hai tab: một bên tạo phòng, bên kia vào bằng mã. Luật online do server quyết.

Tài liệu thư viện kết nối: [http://localhost:3000/playfull.html](http://localhost:3000/playfull.html)

## Luật tóm tắt

| | |
|---|---|
| Bàn | 9×9, file a–i, rank 1–9 |
| Quân | Mỗi bên 9 quân: 3 Đấm, 3 Lá, 3 Kéo |
| Vòng ăn | Đấm > Kéo > Lá > Đấm |
| Di chuyển | 1 ô, 8 hướng; không ra ngoài bàn; không vào ô có quân cùng phe |
| Xếp chồng | Hai quân đối địch cùng loại đứng chung ô |
| Ô thắng | A: a9 · B: i1 — chỉ quân của chính mình |
| Ăn hết quân | Không còn quân nào của đối phương → thắng ngay |
| Thế trận | A phía trên bên phải, B phía dưới bên trái, đối xứng 180°; không đặt quân lên a9/i1 lúc xếp |

Chi tiết thuật ngữ: [CONTEXT.md](CONTEXT.md).

## Cấu trúc

```
config.js          Hằng số bàn, quân, cổng
rules.js           Luật thuần: đi, ăn, thắng
ai.js              Máy chọn nước (thay thế được)
room.js            Phòng, ghế A/B, trọng tài
server.js          HTTP tĩnh + WebSocket
playfull.js        Thư viện khách realtime
playfull.html      Tài liệu Playfull
index.html         Giao diện
game.js            Sảnh, bàn, chế độ chơi
style.css          Bố cục
tokens.css         Màu, chữ, nhịp
assets/            Icon Đấm, Lá, Kéo
tests/             Luật và phòng
scripts/gen-assets.js
```

Luật không nằm trong UI. Khi chơi mạng, `Room.handleMove` gọi `rules.applyMove`; khách chỉ vẽ trạng thái server gửi.

## Kiểm thử

```bash
npm test
```

`tests/rules.test.js` — xếp quân, đối xứng, tám hướng, nước đi, ăn, đòn thua, xếp chồng, ô thắng, ăn hết quân.

`tests/room.test.js` — hai ghế, sai lượt, rời phòng, lọc tên.

## Biến môi trường

`PORT` — cổng HTTP/WS, mặc định `3000`.

## Playfull (khách)

```js
const pf = new Playfull();
await pf.connect();
pf.on("state", (msg) => render(msg.state));
pf.create("An");
pf.join("K7P2", "Bình");
pf.move({ x: 8, y: 2 }, { x: 8, y: 1 });
```

Sự kiện: `open`, `close`, `error`, `hello`, `rooms`, `joined`, `state`, `gameover`, `left`.
