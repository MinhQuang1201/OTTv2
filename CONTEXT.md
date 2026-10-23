# OTTv2

Cờ chiến thuật hai người trên bàn 9x9. Mỗi bên có 10 quân: 3 Đấm, 4 Lá và 3 Kéo; ăn theo oẳn tù tì, thắng bằng ô thắng hoặc ăn hết quân đối phương.

## Language

**Quân**:
Một đơn vị trên bàn thuộc đúng một người chơi và đúng một loại Đấm, Lá hoặc Kéo.
_Avoid_: quân cờ vua, pawn, token

**Loại quân**:
Đấm, Lá hoặc Kéo. Đấm thắng Kéo, Kéo thắng Lá, Lá thắng Đấm.
_Avoid_: hệ, class, element

**Ô**:
Một ô trên bàn 9x9, tọa độ file a–i và rank 1–9.
_Avoid_: tile, cell như khái niệm riêng

**Ô thắng**:
Ô ghi bàn của một người chơi. Người A (Đỏ) thắng khi có quân trên a1. Người B (Xanh) thắng khi có quân trên i9. Rank 1 ở phía trên bàn, rank 9 ở phía dưới.
_Avoid_: king square, nhà, đích đối phương

**Chiếm ô**:
Mỗi ô chỉ có một quân. Quân không được đi vào ô có quân cùng phe hoặc quân đối phương cùng loại.
_Avoid_: stack, merge, đè

**Ăn**:
Quân đi vào ô có quân đối phương khác loại và thắng theo oẳn tù tì, quân đối phương rời bàn.
_Avoid_: giết, destroy, capture-as-chess-en-passant

**Đòn thua**:
Nước định đi vào ô có quân đối phương khác loại nhưng thua theo oẳn tù tì. Đây là nước không hợp lệ: quân đi không bị loại, quân đứng yên và trạng thái không đổi.
_Avoid_: suicide như ý định tự hủy

**Lượt**:
Đúng một người chơi được đi đúng một quân mỗi lần; quân đi một ô theo một trong 8 hướng.
_Avoid_: phase, round như ván

**Ván**:
Một trận từ thế trận ban đầu đến khi có người thắng hoặc đối thủ rời phòng.
_Avoid_: match như tennis set, session

**Tuyệt chủng**:
Một người chơi không còn bất kỳ quân nào trên bàn. Đối phương thắng ngay.
_Avoid_: checkmate, wipe như slang

**Ghế**:
Chỗ Người A hoặc Người B trong một phòng. Người A đi trước.
_Avoid_: team, side như màu cờ vua trắng/đen

**Phòng**:
Một ván đang chờ hoặc đang chơi, có mã phòng, tối đa hai ghế.
_Avoid_: lobby như toàn server, table như poker

**Playfull (lịch sử)**:
Tên của adapter/thư viện khách trong kiến trúc cũ, kết nối WebSocket để tạo/vào phòng, gửi nước đi và nhận trạng thái. Không phải kiến trúc active.

**PlayHTML (active)**:
Kiến trúc online: adapter client gửi command `ott:*` qua kết nối PlayHTML tới Cloudflare Worker authoritative (`apps/worker`, `partyserver`/`y-partyserver`); Worker/`Room` quyết định ghế, luật, đồng hồ và kết quả. Lobby khởi tạo Room qua request nội bộ ký HMAC; client chỉ attach bằng ticket. Production đã deploy từ tag `v*` nhưng chưa nghiệm thu thủ công. Khi online không khả dụng, online UI phải unavailable, còn local/AI vẫn hoạt động; không thay bằng client relay, bridge/mock hay fallback transport.
_Avoid_: socket wrapper, netcode

## Bot Cup

Giải đấu bot cho sinh viên UET. Kế hoạch: `docs/superpowers/plans/2026-10-23-uet-k71-bot-cup.md`.

**Giải (event)**:
Một lần tổ chức Bot Cup, chạy ở chế độ Demo (khoảng 8 đội, sinh viên mọi khóa) hoặc Thực tế (chỉ K71, email `MSSV@vnu.edu.vn`).
_Avoid_: tournament khi nói về giải người chơi trong `features/tournaments`

**Đội**:
Một tài khoản thi đấu gồm 1–3 sinh viên, đăng nhập bằng handle và mật khẩu chung. Đội 1 người là đội cá nhân. Mỗi sinh viên chỉ thuộc một đội trong một giải.
_Avoid_: Ghế (ghế là A/B trong một ván), user, player account

**Đội trưởng**:
Người tạo đội, xác minh đội bằng OTP gửi tới email của mình.

**Bài nộp**:
Một file mã nguồn bot (Python hoặc JavaScript) đội đã gửi; bất biến, nhận diện bằng SHA-256.
_Avoid_: version như phiên bản Arena khi nói về luật giải

**Bản thi đấu**:
Bài nộp đội chọn để thi; bị niêm phong lúc Khóa code.

**Khóa code**:
Mốc giờ sau đó không đội nào được đổi Bản thi đấu, kể cả trước chung kết.

**Vòng kiểm tra**:
Mỗi bot đấu 6 ván với house bot Dễ; cần ít nhất 4 điểm để vào vòng loại.

**Cặp đấu**:
Hai đội gặp nhau trong một vòng: 2 ván đổi màu (Swiss) hoặc 6 ván, 3 bản đồ × 2 màu (vòng tròn, knockout).
_Avoid_: Ván (một ván là một trận cờ)

**Runner**:
Máy của BTC chạy bot trong container và gửi kết quả về API; không bao giờ là trình duyệt hay Worker.
