# LUẬT CHƠI OTTv2 - ĐẤM, LÁ, KÉO

## 1. Tổng quan

OTTv2 là trò chơi chiến thuật dành cho hai người trên bàn cờ 9x9.

Mỗi người chơi điều khiển các quân thuộc ba loại:

- Đấm (Rock)
- Lá (Paper)
- Kéo (Scissors)

Hai người luân phiên di chuyển quân. Khi quân đi vào một ô đang có quân đối phương khác loại, hai quân giao chiến theo quy luật Đấm - Lá - Kéo.

Mục tiêu của ván là đạt một trong các điều kiện sau:

1. Đưa một quân của mình vào ô thắng của mình.
2. Làm cho đối phương không còn quân nào trên bàn.
3. Khi tới lượt, đối phương không còn nước đi hợp lệ.

Ván kết thúc ngay khi một điều kiện thắng được xác định.

---

## 2. Người chơi, ghế và ô thắng

Trò chơi có hai ghế:

| Ghế | Màu | Ô thắng | Thứ tự đi |
|---|---|---|---|
| A | Đỏ | A9 | Đi trước |
| B | Xanh | I1 | Đi sau |

Trong code, ghế được gọi là `A` và `B`. Trong giao diện hoặc tài liệu, ghế A tương ứng với Đỏ và ghế B tương ứng với Xanh.

Chỉ quân của chính người chơi mới có thể làm người chơi đó thắng trên ô thắng của mình. Đứng trên ô thắng của đối phương không tạo ra chiến thắng.

---

## 3. Bàn cờ và tọa độ

Bàn cờ có kích thước 9 hàng x 9 cột, tổng cộng 81 ô.

Các cột được gọi từ A đến I, các hàng được gọi từ 1 đến 9:

```text
      A B C D E F G H I
    +-------------------+
 1  |                   |
 2  |                   |
 3  |                   |
 4  |                   |
 5  |                   |
 6  |                   |
 7  |                   |
 8  |                   |
 9  |                   |
    +-------------------+
```

Theo quy ước này:

- `A1` là góc trên bên trái.
- `I1` là góc trên bên phải và là ô thắng của Xanh/B.
- `A9` là góc dưới bên trái và là ô thắng của Đỏ/A.
- `I9` là góc dưới bên phải.

Tọa độ không phân biệt chữ hoa và chữ thường khi nhập, nhưng tọa độ hợp lệ phải có một cột từ A đến I và một hàng từ 1 đến 9.

---

## 4. Quân và số lượng ban đầu

Mỗi người bắt đầu với 9 quân:

- 3 quân Đấm.
- 3 quân Lá.
- 3 quân Kéo.

Mỗi quân có đúng một chủ sở hữu và đúng một loại quân.

### Đội hình Đỏ/A

| Ô | Loại quân |
|---|---|
| A3 | Lá |
| B3 | Đấm |
| C3 | Kéo |
| A4 | Đấm |
| B4 | Kéo |
| C4 | Lá |
| A5 | Kéo |
| B5 | Lá |
| C5 | Đấm |

### Đội hình Xanh/B

Đội hình Xanh là ảnh xoay 180 độ của đội hình Đỏ, giữ nguyên loại quân. Với phép xoay tọa độ `(x, y) -> (8 - x, 8 - y)`, đội hình là:

| Ô | Loại quân |
|---|---|
| I7 | Lá |
| H7 | Đấm |
| G7 | Kéo |
| I6 | Đấm |
| H6 | Kéo |
| G6 | Lá |
| I5 | Kéo |
| H5 | Lá |
| G5 | Đấm |

Không quân nào được đặt sẵn trên `A9` hoặc `I1`. Không quân nào đứng kề ô thắng của chính mình ở trạng thái ban đầu, vì vậy không thể thắng ngay ở nước đầu tiên.

---

## 5. Quy tắc một quân trên một ô

Đây là quy tắc bắt buộc của bàn cờ:

> Mỗi ô chỉ được chứa tối đa một quân tại mọi thời điểm.

Vì vậy:

- Không có xếp chồng quân.
- Không có nhiều quân cùng đứng trên một ô.
- Không có tách chồng hoặc di chuyển một phần của chồng quân.
- Mọi nước đi chỉ có thể kết thúc ở ô trống hoặc kết thúc bằng giao chiến với đúng một quân ở ô đích.

Trạng thái có hai quân trên cùng một ô là trạng thái không hợp lệ.

---

## 6. Loại quân và vòng khắc chế

Ba loại quân khắc chế theo vòng:

```text
Đấm thắng Kéo
Kéo thắng Lá
Lá thắng Đấm
```

Viết ngắn gọn:

```text
Đấm > Kéo > Lá > Đấm
```

Hai quân cùng loại không khắc chế nhau.

---

## 7. Cách di chuyển

Quân di chuyển như quân Vua trong cờ vua:

- Mỗi lượt, một quân chỉ được đi đúng một ô.
- Có thể đi theo một trong tám hướng: ngang, dọc hoặc chéo.
- Không được đi ra ngoài bàn cờ.
- Không được đứng yên.
- Không được đi xa hơn một ô.

Ví dụ, quân ở `E5` có thể đi đến:

```text
D4 E4 F4
D5    F5
D6 E6 F6
```

Các nước như `E5 -> E7`, `E5 -> G5` hoặc `E5 -> G7` đều không hợp lệ.

---

## 8. Luật ô đích

### 8.1. Ô đích trống

Nếu ô đích không có quân:

- Quân được di chuyển đến ô đích.
- Không có quân nào bị loại.
- Nước đi được xem là hợp lệ.

### 8.2. Ô đích có quân cùng phe

Nếu ô đích có quân của cùng người chơi:

- Nước đi không hợp lệ.
- Quân đi giữ nguyên vị trí.
- Không có quân nào bị loại.
- Lượt không chuyển.

Quân cùng phe không được đứng chung một ô và không được ăn nhau.

### 8.3. Ô đích có quân đối phương cùng loại

Nếu quân đi và quân đứng ở ô đích thuộc hai phe khác nhau nhưng cùng loại:

- Nước đi không hợp lệ.
- Quân đi giữ nguyên vị trí.
- Quân ở ô đích giữ nguyên vị trí.
- Không có quân nào bị loại.
- Lượt không chuyển.

Ví dụ:

```text
Đỏ Đấm -> Xanh Đấm
```

Nước đi bị từ chối vì mỗi ô chỉ có thể chứa một quân và hai quân cùng loại không ăn nhau.

### 8.4. Ô đích có quân đối phương khác loại

Nếu quân đi và quân đứng ở ô đích khác loại, áp dụng vòng khắc chế:

- Nếu quân đi thắng, quân đứng ở ô đích bị loại; quân đi chiếm ô đích.
- Nếu quân đi thua, quân đi bị loại; quân ở ô đích giữ nguyên vị trí.
- Không bao giờ có hai quân cùng đứng trên một ô.
- Nước giao chiến đã thực hiện được xem là một nước hợp lệ và lượt chuyển sang đối phương, trừ khi ván đã kết thúc.

Ví dụ:

```text
Đỏ Đấm -> Xanh Kéo
```

Đấm thắng Kéo. Xanh Kéo bị loại và Đỏ Đấm chiếm ô đó.

```text
Đỏ Đấm -> Xanh Lá
```

Đấm thua Lá. Đỏ Đấm bị loại và Xanh Lá giữ nguyên ô.

---

## 9. Luật lượt chơi

Đỏ/A đi trước. Sau mỗi nước hợp lệ chưa kết thúc ván, lượt chuyển sang người còn lại.

Một lượt gồm các bước:

1. Người tới lượt chọn một quân của mình.
2. Người đó chọn một ô liền kề theo tám hướng.
3. Hệ thống kiểm tra nước đi.
4. Nếu hợp lệ, hệ thống thực hiện di chuyển hoặc giao chiến.
5. Hệ thống kiểm tra điều kiện thắng.
6. Nếu chưa có người thắng, chuyển lượt.

Nước đi không hợp lệ không làm thay đổi trạng thái bàn cờ và không làm chuyển lượt.

### Không còn nước đi hợp lệ

Nếu tới lượt một người chơi mà người đó không có bất kỳ nước đi hợp lệ nào:

- Người đó bị xử thua.
- Người còn lại thắng.
- Lý do kết thúc là `không còn nước đi`.

Không tự động bỏ lượt và không xử hòa trong trường hợp này.

---

## 10. Điều kiện thắng

### 10.1. Đến ô thắng

Đỏ/A thắng ngay khi một quân Đỏ/A đi vào `A9`.

Xanh/B thắng ngay khi một quân Xanh/B đi vào `I1`.

Quân chỉ được ghi nhận thắng trên ô thắng của chính phe mình. Đứng trên ô thắng của đối phương không tạo ra chiến thắng.

### 10.2. Đối phương không còn quân

Một người chơi thắng ngay khi đối phương không còn bất kỳ quân nào trên bàn.

Điều này nghĩa là:

- Mất toàn bộ 9 quân là thua.
- Mất toàn bộ quân của một loại nhưng vẫn còn quân khác chưa phải là thua.
- Không cần mỗi loại quân phải còn ít nhất một quân.

Ví dụ, nếu Xanh còn 2 quân Kéo nhưng không còn quân Đấm và Lá, Xanh vẫn còn quân trên bàn và chưa bị loại theo điều kiện này.

### 10.3. Đối phương không còn nước đi

Nếu tới lượt đối phương mà đối phương không thể thực hiện bất kỳ nước đi hợp lệ nào, người chơi còn lại thắng.

---

## 11. Thứ tự kiểm tra kết thúc ván

Sau khi một nước hợp lệ hoàn tất, hệ thống kiểm tra theo thứ tự:

1. Người vừa đi có quân trên ô thắng của mình không.
2. Đối phương còn quân nào trên bàn không.
3. Đối phương còn ít nhất một nước đi hợp lệ không.
4. Nếu chưa có điều kiện nào, chuyển lượt.

Nếu một nước vừa đưa quân vào ô thắng vừa loại quân cuối cùng của đối phương, người vừa đi thắng. Lý do ưu tiên là đến ô thắng.

Nếu quân đi bị loại trong giao chiến và đó là quân cuối cùng của người đi, người còn lại thắng do đối phương không còn quân.

Ván đã kết thúc thì mọi nước đi tiếp theo đều không hợp lệ.

---

## 12. Bảng tương tác

| Quân đi | Quân ở ô đích | Kết quả |
|---|---|---|
| Đấm | Kéo đối phương | Đấm thắng, Kéo bị loại, Đấm chiếm ô |
| Kéo | Lá đối phương | Kéo thắng, Lá bị loại, Kéo chiếm ô |
| Lá | Đấm đối phương | Lá thắng, Đấm bị loại, Lá chiếm ô |
| Đấm | Lá đối phương | Đấm thua, Đấm bị loại, Lá giữ ô |
| Lá | Kéo đối phương | Lá thua, Lá bị loại, Kéo giữ ô |
| Kéo | Đấm đối phương | Kéo thua, Kéo bị loại, Đấm giữ ô |
| Cùng loại, khác phe | Bất kỳ | Nước đi không hợp lệ, không quân nào bị loại |
| Cùng phe | Bất kỳ | Nước đi không hợp lệ |
| Ô trống | - | Di chuyển bình thường |

---

## 13. Ví dụ các tình huống thắng

### Đỏ đến ô thắng

Một quân Đỏ đi từ `A8` vào `A9`.

```text
Đỏ -> A9 -> Đỏ thắng
```

### Xanh đến ô thắng

Một quân Xanh đi từ `I2` vào `I1`.

```text
Xanh -> I1 -> Xanh thắng
```

### Ăn quân cuối cùng

Nếu Đỏ ăn quân cuối cùng của Xanh, Xanh không còn quân trên bàn và Đỏ thắng ngay.

### Bị khóa hoàn toàn

Nếu đến lượt Xanh nhưng mọi quân Xanh đều bị chặn bởi quân cùng phe hoặc các quân cùng loại của Đỏ, Xanh không có nước đi hợp lệ và Đỏ thắng.

---

## 14. Luật phòng chơi

Một ván có tối đa hai người, tương ứng với ghế A và B.

Nếu một người rời phòng hoặc mất kết nối trong khi ván đang diễn ra:

- Người còn lại thắng ngay.
- Lý do kết thúc là `đối thủ rời phòng`.

Đây là luật của phòng chơi và không thay đổi luật di chuyển, giao chiến hoặc ô thắng.

---

## 15. Đặc tả ngắn gọn

> OTTv2 là trò chơi chiến thuật hai người trên bàn cờ 9x9. Ghế A màu Đỏ đi trước và có ô thắng A9; ghế B màu Xanh đi sau và có ô thắng I1. Mỗi người có 9 quân gồm 3 Đấm, 3 Lá và 3 Kéo. Mỗi ô chỉ chứa tối đa một quân. Trong lượt của mình, người chơi di chuyển một quân đúng một ô theo một trong tám hướng. Không được đi vào ô có quân cùng phe. Nếu ô đích có quân đối phương cùng loại, nước đi không hợp lệ. Nếu ô đích có quân đối phương khác loại, Đấm thắng Kéo, Kéo thắng Lá và Lá thắng Đấm; quân thắng chiếm ô còn quân thua bị loại. Người chơi thắng khi đưa quân của mình vào ô thắng, khi đối phương không còn quân nào, hoặc khi đối phương tới lượt nhưng không còn nước đi hợp lệ. Nước đi không hợp lệ không chuyển lượt. Ván kết thúc ngay khi một điều kiện thắng được thỏa mãn.

---

## 16. Tóm tắt cực ngắn

```text
BÀN CỜ:          9 x 9
MỖI Ô:           Tối đa 1 quân
GHẾ A:           Đỏ, đi trước, thắng tại A9
GHẾ B:           Xanh, đi sau, thắng tại I1
QUÂN MỖI BÊN:    3 Đấm, 3 Lá, 3 Kéo
DI CHUYỂN:       Đúng 1 ô, 8 hướng
KHẮC CHẾ:        Đấm > Kéo > Lá > Đấm
CÙNG PHE:        Không được đi vào ô đã có quân
CÙNG LOẠI:       Nước đi không hợp lệ
KHÁC LOẠI:       Quân thắng chiếm ô, quân thua bị loại
THẮNG 1:         Vào ô thắng của mình
THẮNG 2:         Đối phương hết toàn bộ quân
THẮNG 3:         Đối phương không còn nước đi hợp lệ
NƯỚC SAI:        Không đổi trạng thái, không đổi lượt
KẾT THÚC:        Ngay khi có điều kiện thắng
```
