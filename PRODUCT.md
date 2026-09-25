# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: HTML5 + CSS3 + JavaScript trên trình duyệt, Node.js HTTP + WebSocket phía máy chủ. Không framework. Luật chơi tách file `rules.js`, phòng tách `room.js`, kết nối khách qua Playfull.

## Users

Hai người chơi muốn một ván cờ chiến thuật ngắn trên trình duyệt, cùng máy, qua mạng LAN/internet, hoặc tập với máy. Họ cần thấy lượt, quân còn lại, nước hợp lệ và kết quả ngay.

## Product Purpose

OTTv2 là oẳn tù tì đưa lên bàn 9x9. Mỗi bên 9 quân (3 Đấm, 3 Lá, 3 Kéo), đi như vua, ăn theo vòng Đấm > Kéo > Lá > Đấm. Thắng khi đưa quân vào ô thắng của mình (A: a9, B: i1) hoặc khi ăn hết toàn bộ quân đối phương.

Success: hai người vào cùng một phòng, đi luân phiên, server là trọng tài, ván kết thúc đúng luật.

## Positioning

Không phải oẳn tù tì một lần chọn. Không phải cờ vua. Cơ chế riêng: cùng loại khác phe không được đi vào cùng ô; ô thắng nằm ở góc đối diện; ăn hết toàn bộ quân đối phương là thắng.

## Capabilities

- Tạo phòng, vào bằng mã, nhiều phòng song song.
- Chơi hai người một máy và đấu với máy (AI thay thế được).
- Highlight quân đang chọn và ô đi được.
- Hiệu ứng ăn quân, đổi lượt, thắng/thua.
- Server kiểm tra nước đi, điều kiện thắng và đồng hồ 10 phút mỗi ghế.
- Mất kết nối giữ ghế 60 giây để kết nối lại; rời bàn chủ động xử thua ngay.

## Constraints

- Bàn 9x9, 9 quân mỗi bên, phản chiếu qua đường chéo a1–i9.
- Đường chéo a1–i9 là dải phân cách và không có quân đứng trên đó lúc khởi tạo.
- Mỗi bên có ba cánh Đấm–Lá–Kéo, cách dải phân cách ít nhất 3 lớp để không thể chiếm ranh giới hoặc giao chiến ở nước đầu.
- Không đặt quân lên a9/i1 lúc xếp.
- Quân không đứng kề ô thắng của mình lúc xếp (tránh thắng nước 1).
- Luật do server quyết khi chơi online.
- Tiếng Việt trên giao diện, hỗ trợ dấu thanh.

## Terminology

Xem CONTEXT.md. Ghế A/B, ô thắng, tuyệt chủng, Playfull.

## Voice

Trực tiếp, ngắn, gọi đúng nước đi và kết quả. Không khẩu hiệu marketing.

## Accessibility

Bàn là nút ô, có nhãn tọa độ. Trạng thái lượt qua aria-live. Focus-visible. Tôn trọng prefers-reduced-motion.

## Inferred

Mọi mục trên suy từ đặc tả 2026-09-25. Chưa có phỏng vấn người dùng riêng.
