# OTTv2

Cờ chiến thuật hai người trên bàn 9x9. Mỗi quân là Đấm, Lá hoặc Kéo; ăn theo oẳn tù tì, thắng bằng ô thắng hoặc ăn hết quân đối phương.

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
Ô ghi bàn của một người chơi. Người A (Đỏ) thắng khi có quân trên a9. Người B (Xanh) thắng khi có quân trên i1. Rank 1 ở phía trên bàn, rank 9 ở phía dưới.
_Avoid_: king square, nhà, đích đối phương

**Chiếm ô**:
Mỗi ô chỉ có một quân. Quân không được đi vào ô có quân cùng phe hoặc quân đối phương cùng loại.
_Avoid_: stack, merge, đè

**Ăn**:
Quân đi vào ô có quân đối phương khác loại và thắng theo oẳn tù tì, quân đối phương rời bàn.
_Avoid_: giết, destroy, capture-as-chess-en-passant

**Đòn thua**:
Quân đi vào ô có quân đối phương khác loại và thua theo oẳn tù tì, quân đi bị loại, quân đứng yên tại chỗ.
_Avoid_: suicide như ý định tự hủy

**Lượt**:
Đúng một người chơi được đi đúng một quân mỗi lần, quân đi như vua cờ vua (8 hướng, 1 ô).
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

**PlayHTML/PartyKit (active)**:
Kiến trúc đích: adapter client gửi command `ott:*` tới worker authoritative đã kiểm chứng; worker/`Room` quyết định ghế, luật, đồng hồ và kết quả. Hiện rollout **BLOCKED**: fork/worker PlayHTML và bootstrap connection chưa có evidence runtime trực tiếp; đồng thời PartyKit `0.0.115` chỉ cho `Stub.socket()` trả `WebSocket` và `Server.onMessage` không có authenticated inter-party origin/route metadata. Direct game create bị từ chối, nhưng lobby không thể khởi tạo game qua channel đã chứng minh an toàn. Không thay bằng internal marker forgeable, client relay, process map, bridge/mock, unit test hay fallback transport; online UI phải unavailable, còn local/AI vẫn hoạt động.
_Avoid_: socket wrapper, netcode
