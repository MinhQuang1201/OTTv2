# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: HTML5 + CSS3 + JavaScript trên trình duyệt, Node.js HTTP static và kiến trúc đích worker PartyKit/PlayHTML cho online. Không framework. Luật chơi tách file `rules.js`, phòng tách `room.js`; khi online được mở, authority thuộc worker. Playfull/WebSocket là tham chiếu lịch sử. Rollout online hiện BLOCKED, không phải capability đã hoàn tất.

## Users

Hai người chơi muốn một ván cờ chiến thuật ngắn trên trình duyệt, cùng máy, qua mạng LAN/internet, hoặc tập với máy. Họ cần thấy lượt, quân còn lại, nước hợp lệ và kết quả ngay.

## Product Purpose

OTTv2 là oẳn tù tì đưa lên bàn 9x9. Mỗi bên 9 quân (3 Đấm, 3 Lá, 3 Kéo), đi như vua, ăn theo vòng Đấm > Kéo > Lá > Đấm. Thắng khi đưa quân vào ô thắng của mình (A: a9, B: i1) hoặc khi ăn hết toàn bộ quân đối phương.

Success (khi online được mở sau evidence gate): hai người vào cùng một phòng, đi luân phiên, worker là trọng tài, ván kết thúc đúng luật. Hiện local và AI là các mode khả dụng; không tuyên bố online production ready.

## Positioning

Không phải oẳn tù tì một lần chọn. Không phải cờ vua. Cơ chế riêng: cùng loại khác phe không được đi vào cùng ô; ô thắng nằm ở góc đối diện; ăn hết toàn bộ quân đối phương là thắng.

## Capabilities

- Mục tiêu online sau evidence gate: tạo phòng, vào bằng mã, nhiều phòng song song.
- Chơi hai người một máy và đấu với máy (AI thay thế được).
- Highlight quân đang chọn và ô đi được.
- Hiệu ứng ăn quân, đổi lượt, thắng/thua.
- Khi online được mở, worker kiểm tra nước đi, điều kiện thắng và đồng hồ 10 phút mỗi ghế.
- Khi online được mở, mất kết nối giữ ghế 60 giây để kết nối lại; rời bàn chủ động xử thua ngay.

## Constraints

- Bàn 9x9, 9 quân mỗi bên, đối xứng 180 độ qua tâm.
- A khởi tạo ở A3:C5, B khởi tạo ở G5:I7 và hai đội đối xứng 180°.
- Không đặt quân lên a9/i1 lúc xếp.
- Quân không đứng kề ô thắng của mình lúc xếp (tránh thắng nước 1).
- Luật do server quyết khi chơi online.
- Online production chỉ mở sau evidence trực tiếp cho lobby-to-game authorization server-authenticated, fork/bootstrap PlayHTML, same-connection transport, routing/lifecycle/persistence, static-host denial và two-profile acceptance. PartyKit `0.0.115` hiện chưa chứng minh được channel này (`Stub.socket()` trả `WebSocket`; `Server.onMessage` không có authenticated origin/route metadata), nên secure lobby-driven initialization vẫn BLOCKED; không dùng internal marker forgeable, client relay hoặc process map. Không coi gate nào PASS nếu chưa chạy.
- Tiếng Việt trên giao diện, hỗ trợ dấu thanh.

## Terminology

Xem CONTEXT.md. Ghế A/B, ô thắng, tuyệt chủng, PlayHTML/PartyKit. Playfull là thuật ngữ lịch sử.

## Voice

Trực tiếp, ngắn, gọi đúng nước đi và kết quả. Không khẩu hiệu marketing.

## Accessibility

Bàn là nút ô, có nhãn tọa độ. Trạng thái lượt qua aria-live. Focus-visible. Tôn trọng prefers-reduced-motion.

## Inferred

Mọi mục trên suy từ đặc tả 2026-09-25. Chưa có phỏng vấn người dùng riêng.
