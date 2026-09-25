# OTTv2 Rule Clarification Design

## Mục tiêu

Làm cho `Rule.md` xác định duy nhất một kết quả cho mọi nước đi và mọi trạng
thái phòng, đồng thời loại bỏ khả năng câu giờ không giới hạn. Giữ nguyên luật
hiện hành: một ô chỉ có tối đa một quân; quân cùng loại khác phe không thể đi
vào cùng ô và không xếp chồng.

## Phạm vi

Chỉ sửa `Rule.md`. Tài liệu mô tả luật chính thức sẽ bổ sung các giá trị cấu
hình thời gian; việc đồng bộ phần mềm là một công việc riêng.

## Quy tắc được bổ sung hoặc làm rõ

1. Một nước hợp lệ bắt đầu ở ô có quân của người đang tới lượt, đi một ô kề
   trong bàn, và có ô đích hợp lệ theo luật ô đích. Nước đánh thua vẫn hợp lệ.
2. Sau nước hợp lệ, xét theo thứ tự: ô thắng của người vừa đi; số quân còn lại
   của cả hai phe; rồi người sắp đi có nước hợp lệ hay không. Không chuyển lượt
   sang người đã hết quân.
3. Mỗi ghế có 10 phút tổng thời gian. Đồng hồ của người tới lượt chạy cho đến
   khi nước hợp lệ hoàn thành, ván kết thúc, hoặc họ hết giờ. Nước sai không
   dừng hay chuyển đồng hồ. Hết giờ là thua.
4. Khi mất kết nối, giữ ghế và dừng đồng hồ của người mất kết nối trong 60 giây.
   Nếu họ không quay lại đúng ghế trong thời hạn này, đối thủ thắng. Nếu quay
   lại đúng hạn, đồng hồ tiếp tục chạy theo lượt hiện tại. Không áp dụng xử thua
   sau khi ván đã kết thúc.
5. Bảng tương tác mô tả tình trạng của ô đích thay vì đặt quan hệ giữa hai quân
   vào cột “Quân đi”.

## Không thay đổi

- Không có hòa do lặp vị trí; đồng hồ là cơ chế chặn ván kéo dài.
- Đấm thắng Kéo, Kéo thắng Lá, Lá thắng Đấm.
- Đỏ/A đi trước, thắng tại A9; Xanh/B thắng tại I1.

## Kiểm tra tài liệu

- Mọi nhánh của giao chiến đều dẫn đến một người thắng hoặc người kế tiếp.
- Không có trạng thái đang chơi mà người sắp đi đã hết quân.
- Mọi nguyên nhân kết thúc có tên rõ ràng: ô thắng, hết quân, hết nước đi,
  hết giờ, hoặc đối thủ rời phòng/quá hạn kết nối lại.
