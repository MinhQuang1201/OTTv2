# OTTv2 – Oẳn Tù Tì

Cờ chiến thuật hai người trên bàn 9×9. Mỗi quân là Đấm, Lá hoặc Kéo. Ăn theo oẳn tù tì. Thắng khi đưa quân vào ô thắng của mình, hoặc khi ăn hết toàn bộ quân đối phương.

- Người A (Đỏ) thắng trên **a9**. Người B (Xanh) thắng trên **i1**.
- Đi như vua cờ vua: 8 hướng, 1 ô.
- Cùng loại khác phe: nước đi bị từ chối; mỗi ô chỉ có một quân.
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

Hai người trên cùng máy có thể chơi ngay. Chế độ AI hoạt động local. Chế độ online là mục tiêu kiến trúc worker-authoritative, nhưng hiện chưa khả dụng khi rollout còn blocked.

Tài liệu adapter PlayHTML: [http://localhost:3000/playhtml-game.html](http://localhost:3000/playhtml-game.html)

## Luật tóm tắt

| | |
|---|---|
| Bàn | 9×9, file a–i, rank 1–9 |
| Quân | Mỗi bên 9 quân: 3 Đấm, 3 Lá, 3 Kéo |
| Vòng ăn | Đấm > Kéo > Lá > Đấm |
| Di chuyển | 1 ô, 8 hướng; không ra ngoài bàn; không vào ô có quân cùng phe |
| Cùng loại | Không được đi vào ô có quân đối phương cùng loại |
| Ô thắng | A: a9 · B: i1 — chỉ quân của chính mình |
| Ăn hết quân | Không còn quân nào của đối phương → thắng ngay |
| Thế trận | A ở A3:C5, B ở G5:I7, đối xứng 180°; không đặt quân lên a9/i1 lúc xếp |
| Đồng hồ | 10 phút mỗi ghế; server quyết định timeout |
| Kết nối lại | Grace 60 giây; `leave` xử thua ngay, `close` giữ ghế |

Chi tiết thuật ngữ: [CONTEXT.md](CONTEXT.md).

## Cấu trúc

```
config.js          Hằng số bàn, quân, cổng
rules.js           Luật thuần: đi, ăn, thắng
ai.js              Máy chọn nước (thay thế được)
room.js            Phòng, ghế A/B, trọng tài
server.js          HTTP tĩnh, không xử lý game online
playhtml-game-client.js Adapter lệnh authoritative PlayHTML/PartyKit
playhtml-game.html Tài liệu adapter PlayHTML
index.html         Giao diện
game.js            Sảnh, bàn, chế độ chơi
style.css          Bố cục
tokens.css         Màu, chữ, nhịp
assets/            Icon Đấm, Lá, Kéo
tests/             Luật và phòng
scripts/gen-assets.js
```

Luật không nằm trong UI. Khi online được mở sau các evidence gate, `Room.handleMove` gọi `rules.applyMove`; khách chỉ vẽ trạng thái worker gửi.

## Kiểm thử

```bash
npm test
```

`tests/rules.test.js` — phạm vi kiểm thử luật; chạy `npm test` để xác minh kết quả trên revision hiện tại.

`tests/room.test.js` — phạm vi kiểm thử `Room`; chạy `npm test` để xác minh kết quả trên revision hiện tại.

## Biến môi trường

`PORT` — cổng HTTP static, mặc định `3000`.
`OTT_PLAYHTML_HOST` — endpoint self-hosted dành cho adapter; không đặt secret trong frontend.

## Online qua PlayHTML/PartyKit

Kiến trúc đích dùng worker PartyKit/PlayHTML đã pin và kiểm chứng. Khi và chỉ khi evidence gate cho phép, `window.OTT_PLAYHTML_CONNECTION_FACTORY` được bootstrap từ cùng connection PlayHTML đã xác minh; adapter gửi các lệnh `ott:*` và chuyển tiếp message `ott:*` do worker trả về.

Không dùng public PlayHTML host cho dữ liệu ván và không tạo WebSocket thứ hai. Static server chỉ phục vụ file tĩnh; authority online thuộc worker. Local và AI không phụ thuộc worker.

Trạng thái rollout hiện tại: **BLOCKED**. Không có factory, WebSocket/PartySocket, polling, second PlayHTML session hoặc fallback transport nào được dùng để giả lập online. PartyKit `0.0.115` đã được kiểm tra: `Stub.socket()` chỉ trả `WebSocket` và `Server.onMessage` không có authenticated inter-party origin/route metadata. Direct game create bị từ chối, nhưng secure lobby-driven game initialization vẫn blocked; không thay bằng internal payload marker forgeable, client relay hoặc process map. UI phải báo online unavailable; local và AI vẫn dùng được. Không coi bridge/mock, unit test hoặc tài liệu là evidence runtime.

**Gate bắt buộc trước production:** Task 4 phải có evidence trực tiếp cho lobby-to-game channel/metadata server-authenticated; Task 5 vẫn phải có evidence trực tiếp theo `docs/playhtml-upstream-lock.md`; initial sync và OTT phải đi cùng một verified connection; routing/lifecycle/persistence phải qua runtime integration; static host phải từ chối private paths kể cả case variants; và two-profile acceptance phải ghi nhận create/list/join, legal/invalid move, timeout, leave, disconnect/reload/resume, expiry, token isolation, local/AI fallback. Không đánh dấu gate hoặc acceptance PASS nếu scenario chưa chạy.
