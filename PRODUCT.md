# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: HTML5 + CSS3 + JavaScript trên trình duyệt, Node.js HTTP + WebSocket phía máy chủ. Không framework. Luật chơi tách file `rules.js`, phòng tách `room.js`, kết nối khách qua Playfull.

## Users

Hai người chơi muốn một ván cờ chiến thuật ngắn trên trình duyệt, cùng máy, qua mạng LAN/internet, hoặc tập với máy. Họ cần thấy lượt, quân còn lại, nước hợp lệ và kết quả ngay.

## Product Purpose

OTTv2 là oẳn tù tì đưa lên bàn 9x9. Mỗi bên 9 quân (3 Đấm, 3 Lá, 3 Kéo), đi như vua, ăn theo vòng Đấm > Kéo > Lá > Đấm. Thắng khi đưa quân vào ô thắng của mình (A: a1, B: i9) hoặc khi đối phương tuyệt chủng một loại quân.

Success: hai người vào cùng một phòng, đi luân phiên, server là trọng tài, ván kết thúc đúng luật.

## Positioning

Không phải oẳn tù tì một lần chọn. Không phải cờ vua. Cơ chế riêng: cùng loại thì xếp chồng chứ không ăn; ô thắng nằm ở góc nhà mình; tuyệt chủng một loại là thắng, không cần ăn hết bàn.

## Capabilities

- Tạo phòng, vào bằng mã, nhiều phòng song song.
- Chơi hai người một máy và đấu với máy (AI thay thế được).
- Highlight quân đang chọn và ô đi được.
- Hiệu ứng ăn quân, đổi lượt, thắng/thua.
- Server kiểm tra nước đi và điều kiện thắng.

## Constraints

- Bàn 9x9, 9 quân mỗi bên, đối xứng 180 độ qua tâm.
- Không đặt quân lên a1/i9 lúc xếp.
- Quân không đứng kề ô thắng của mình lúc xếp (tránh thắng nước 1).
- Luật do server quyết khi chơi online.
- Tiếng Việt trên giao diện, hỗ trợ dấu thanh.

## Terminology

Xem CONTEXT.md. Ghế A/B, ô thắng, xếp chồng, tuyệt chủng, Playfull.

## Voice

Trực tiếp, ngắn, gọi đúng nước đi và kết quả. Không khẩu hiệu marketing.

## Accessibility

Bàn là nút ô, có nhãn tọa độ. Trạng thái lượt qua aria-live. Focus-visible. Tôn trọng prefers-reduced-motion.

## Inferred

Mọi mục trên suy từ đặc tả 2026-09-25. Chưa có phỏng vấn người dùng riêng.
