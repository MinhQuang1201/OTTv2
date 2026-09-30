# OTTv2

**OTTv2** là game cờ chiến thuật realtime 9×9 lấy cảm hứng từ oẳn tù tì.
Hai người điều khiển các quân **Đấm**, **Lá** và **Kéo**, tìm cách đưa quân tới
ô thắng hoặc ăn hết quân của đối phương.

**Chơi bản production:** [ottv2-two.vercel.app](https://ottv2-two.vercel.app)

## Chạy nhanh

Yêu cầu **Node.js 18 trở lên**.

```bash
npm install
npm run dev:web
```

Mở [http://localhost:5173](http://localhost:5173).

Để chạy bản build giống production:

```bash
npm run build:web
npm start
```

Mở [http://localhost:3000](http://localhost:3000).

## Cách chơi

- Bàn cờ có 9×9 ô, mỗi bên có 10 quân: 3 Đấm, 4 Lá và 3 Kéo.
- Mỗi lượt, một quân đi đúng 1 ô theo một trong 8 hướng.
- Thứ tự thắng là **Đấm > Kéo > Lá > Đấm**.
- Quân chỉ ăn quân đối phương khác loại khi quân tấn công thắng theo oẳn tù tì.
- Đòn tấn công bị thua là nước không hợp lệ, không quân nào bị loại và trạng thái không đổi.
- Không thể đi vào quân cùng phe hoặc quân đối phương cùng loại.
- Người A (Đỏ) thắng khi có quân trên **a1**; Người B (Xanh) thắng trên **i9**.
- Ăn hết toàn bộ quân của đối phương cũng là chiến thắng.

## Chế độ chơi

- **Hai người trên một máy:** luân phiên trên cùng trình duyệt.
- **Đấu với máy:** chơi local với AI, không cần server.
- **Online:** rollout hiện chưa khả dụng và đang bị BLOCKED; local và AI vẫn hoạt động độc lập.

## Kiểm tra

```bash
npm test
npm run test:web
npm run typecheck:web
npm run build:web
```

## Ghi chú cho demo

Có thể mở các màn hình fixture bằng query parameter, ví dụ:

```text
http://localhost:5173/?demo=game-active-a
http://localhost:5173/?demo=result-goal
```

Các màn hình demo phục vụ kiểm tra giao diện, không thay thế authority của game
hoặc chứng minh online production đã sẵn sàng.
