Dưới đây là **bản tổng hợp đầy đủ luật chơi OTTv2** theo những gì bạn đã xác nhận, có thể dùng làm **đặc tả game, README hoặc báo cáo**.

# LUẬT CHƠI OTTv2 – ĐẤM, LÁ, KÉO

## 1. Tổng quan

OTTv2 là trò chơi chiến thuật dành cho **2 người chơi**, diễn ra trên **bàn cờ 9×9**.

Mỗi người chơi điều khiển các quân cờ thuộc 3 loại:

* ✊ **Đấm (Rock)**
* ✋ **Lá (Paper)**
* ✌️ **Kéo (Scissors)**

Hai người chơi lần lượt di chuyển quân trên bàn cờ và sử dụng quy luật **Đấm – Lá – Kéo** để ăn quân đối phương.

Mục tiêu cuối cùng là:

> **Ăn hết toàn bộ quân của đối phương hoặc đưa một quân của mình vào ô đích.**

---

# 2. Bàn cờ

Bàn chơi có kích thước:

**9 hàng × 9 cột = 81 ô.**

Có thể ký hiệu tọa độ:

```text
      A B C D E F G H I
    ┌───────────────────┐
 1  │                   │
 2  │                   │
 3  │                   │
 4  │                   │
 5  │                   │
 6  │                   │
 7  │                   │
 8  │                   │
 9  │                   │
    └───────────────────┘
```

Theo quy ước hiện tại:

* **Góc trên bên phải = I1** → đích của 🔵 Xanh.
* **Góc dưới bên trái = A9** → đích của 🔴 Đỏ.

---

# 3. Hai người chơi

Có hai bên:

### 🔴 Người chơi Đỏ

Điều khiển các quân màu đỏ.

### 🔵 Người chơi Xanh

Điều khiển các quân màu xanh.

Mỗi quân được xác định bởi **màu + loại quân**.

Ví dụ:

```text
🔴✊ = Đấm của Đỏ
🔴✋ = Lá của Đỏ
🔴✌️ = Kéo của Đỏ

🔵✊ = Đấm của Xanh
🔵✋ = Lá của Xanh
🔵✌️ = Kéo của Xanh
```

---

# 4. Các loại quân và luật khắc chế

OTTv2 sử dụng đúng quy luật Oẳn tù tì:

```text
✊ Đấm  >  ✌️ Kéo
✌️ Kéo  >  ✋ Lá
✋ Lá    >  ✊ Đấm
```

Nói bằng lời:

> **Đấm ăn Kéo, Kéo ăn Lá, Lá ăn Đấm.**

Đây là vòng khắc chế:

```text
             ✊ ĐẤM
              ↓
              ↓ ăn
              ↓
             ✌️ KÉO
              ↓
              ↓ ăn
              ↓
             ✋ LÁ
              ↓
              ↓ ăn
              └──────→ ✊ ĐẤM
```

---

# 5. Cách di chuyển quân

Quân cờ di chuyển **giống quân Vua trong cờ vua**.

Tuy nhiên:

> **Bàn cờ của OTTv2 là 9×9, còn cách di chuyển giống Vua trong cờ vua.**

Mỗi lượt, một quân chỉ được:

> **Di chuyển đúng 1 ô theo 1 trong 8 hướng.**

8 hướng gồm:

```text
↖  ↑  ↗
←  ●  →
↙  ↓  ↘
```

Trong đó `●` là vị trí hiện tại.

Ví dụ một quân đang ở `E5` có thể đi:

```text
D4  E4  F4
D5  ●   F5
D6  E6  F6
```

Không được đi quá một ô:

```text
E5 → E7  ✗
E5 → G5  ✗
E5 → G7  ✗
```

---

# 6. Luật lượt chơi

Hai người chơi **luân phiên nhau**.

Ví dụ:

```text
Lượt 1 → 🔴 Đỏ
Lượt 2 → 🔵 Xanh
Lượt 3 → 🔴 Đỏ
Lượt 4 → 🔵 Xanh
...
```

Trong lượt của mình, người chơi:

**Bước 1:** Chọn một quân của mình.

**Bước 2:** Chọn một ô liền kề trong 8 hướng.

**Bước 3:** Hệ thống kiểm tra nước đi.

**Bước 4:** Thực hiện di chuyển hoặc chiến đấu.

**Bước 5:** Kiểm tra điều kiện thắng.

**Bước 6:** Nếu chưa thắng, chuyển lượt cho đối phương.

---

# 7. Đi vào ô trống

Nếu ô đích đang trống:

```text
Quân → Ô trống
```

thì quân di chuyển bình thường.

Không có quân nào bị ăn.

Ví dụ:

```text
Trước:

□ □ □
□ 🔴✊ □
□ □ □

Sau:

□ □ □
□ □ 🔴✊
□ □ □
```

---

# 8. Quân cùng phe

Quân của cùng một người chơi **không được ăn nhau** và không thể đứng chung một ô.

Ví dụ:

```text
🔴✊ → 🔴✋
```

Nước đi này không hợp lệ nếu ô đích đang có quân đỏ.

---

# 9. Hai quân cùng loại

Đây là luật đặc biệt của OTTv2.

Nếu hai quân của hai người chơi **cùng loại**, chúng **không thể ăn nhau**.

Ví dụ:

```text
🔴✊ ↔ 🔵✊
```

→ Đấm không ăn Đấm.

Tương tự:

```text
🔴✋ ↔ 🔵✋
```

→ Lá không ăn Lá.

```text
🔴✌️ ↔ 🔵✌️
```

→ Kéo không ăn Kéo.

Khi hai quân cùng loại gặp nhau:

> **Hai quân chỉ chặn đường nhau.**

Không quân nào bị loại.

---

# 10. Ăn quân đối phương

Khi hai quân khác loại gặp nhau, áp dụng quy luật khắc chế.

### Đấm ăn Kéo

```text
🔴✊ → 🔵✌️
```

Đấm thắng Kéo.

→ 🔵✌️ bị loại.

→ 🔴✊ chiếm vị trí đó.

---

### Kéo ăn Lá

```text
🔵✌️ → 🔴✋
```

Kéo thắng Lá.

→ 🔴✋ bị loại.

→ 🔵✌️ chiếm vị trí đó.

---

### Lá ăn Đấm

```text
🔴✋ → 🔵✊
```

Lá thắng Đấm.

→ 🔵✊ bị loại.

→ 🔴✋ chiếm vị trí đó.

---

# 11. Nếu quân tấn công bị khắc chế

Ví dụ:

```text
✊ Đấm → ✋ Lá
```

Đấm thua Lá.

Về mặt cơ chế chiến đấu, có thể hiểu:

> **Quân mạnh hơn là quân thắng; quân thua bị loại khỏi bàn.**

Do đó:

```text
🔴✊ → 🔵✋
```

→ 🔴✊ bị ăn.

→ 🔵✋ vẫn ở vị trí ban đầu.

Đây là cách xử lý tự nhiên của cơ chế RPS: **quân thắng giữ ô, quân thua biến mất**.

---

# 12. Tóm tắt các tương tác

| Quân di chuyển | Quân tại ô đích | Kết quả                                 |
| -------------- | --------------- | --------------------------------------- |
| Đấm ✊          | Kéo ✌️          | Đấm thắng, Kéo bị ăn                    |
| Kéo ✌️         | Lá ✋            | Kéo thắng, Lá bị ăn                     |
| Lá ✋           | Đấm ✊           | Lá thắng, Đấm bị ăn                     |
| Đấm ✊          | Lá ✋            | Đấm thua, Đấm bị ăn                     |
| Lá ✋           | Kéo ✌️          | Lá thua, Lá bị ăn                       |
| Kéo ✌️         | Đấm ✊           | Kéo thua, Kéo bị ăn                     |
| Cùng loại      | Cùng loại       | Không ăn, hai quân chặn nhau            |
| Cùng phe       | Bất kỳ          | Không được đi vào ô đã có quân cùng phe |
| Ô trống        | —               | Di chuyển bình thường                   |

---

# 13. Điều kiện thắng thứ nhất – Ăn hết quân

Người chơi thắng khi:

> **Ăn hết toàn bộ quân của đối phương.**

Không phải ăn hết một loại.

Mà phải:

> **Không còn bất kỳ quân nào của đối phương trên bàn cờ.**

Ví dụ:

```text
🔵 Xanh còn:
✊ 0
✋ 0
✌️ 0
```

→ 🔵 không còn quân.

→ 🔴 **thắng ngay lập tức**.

Tương tự, nếu 🔴 không còn quân:

→ 🔵 **thắng**.

---

# 14. Điều kiện thắng thứ hai – Đi đến ô đích

Ngoài việc ăn hết quân đối phương, người chơi có thể thắng bằng cách đưa một quân của mình đến **góc đích**.

## 🔴 Đích của Đỏ

Đỏ phải đưa một quân bất kỳ đến:

> **Góc dưới cùng bên trái của bàn cờ – A9**

```text
A9 = Đích Đỏ
```

Ngay khi một quân 🔴 đi vào A9:

> **Đỏ thắng ngay.**

---

## 🔵 Đích của Xanh

Xanh phải đưa một quân bất kỳ đến:

> **Góc trên cùng bên phải của bàn cờ – I1**

```text
I1 = Đích Xanh
```

Ngay khi một quân 🔵 đi vào I1:

> **Xanh thắng ngay.**

---

# 15. Hai mục tiêu trên bàn cờ

```text
      A B C D E F G H I
    ┌───────────────────┐
 1  │                 🔵│ ← I1: Đích Xanh
    │                   │
 2  │                   │
 3  │                   │
 4  │                   │
 5  │       BÀN CỜ      │
 6  │        9×9        │
 7  │                   │
 8  │                   │
 9  │🔴                 │ ← A9: Đích Đỏ
    └───────────────────┘
```

Hai người xuất phát từ hai phía và cố gắng tiến quân về **góc đích đối diện**.

---

# 16. Hai cách chiến thắng

Toàn bộ trò chơi chỉ có **2 con đường chiến thắng**:

### Cách 1 – Tiêu diệt đối phương

```text
Ăn hết toàn bộ quân đối phương
             ↓
          THẮNG
```

### Cách 2 – Đưa quân về đích

```text
🔴 → A9 → Đỏ thắng

🔵 → I1 → Xanh thắng
```

Chỉ cần đạt **một trong hai điều kiện** là ván đấu kết thúc.

---

# 17. Kiểm tra thắng sau mỗi lượt

Sau khi hoàn thành một nước đi, hệ thống kiểm tra theo thứ tự:

```text
             Người chơi đi
                    │
                    ▼
          Quân có tới ô đích?
              /          \
            Có            Không
            │                │
            ▼                ▼
         THẮNG        Đối phương còn quân?
                            /       \
                          Không      Có
                           │          │
                           ▼          ▼
                         THẮNG    Chuyển lượt
```

Ví dụ:

* 🔴 vừa đi vào A9 → 🔴 thắng, không cần đánh tiếp.
* 🔵 vừa ăn quân cuối cùng của 🔴 → 🔵 thắng.
* Chưa đạt điều kiện nào → tiếp tục lượt của đối phương.

---

# 18. Vị trí khởi tạo

Theo hình minh họa bạn gửi:

* 🔴 **Đỏ xuất phát ở khu vực phía trên bên phải**.
* 🔵 **Xanh xuất phát ở khu vực phía dưới bên trái**.
* Hai bên có đội hình nằm ở hai phía đối diện của bàn cờ.
* Mỗi bên có các quân **Đấm, Lá, Kéo**.

Phần **tọa độ chính xác của từng quân ở trạng thái ban đầu** trong ảnh hiện không đủ rõ để mình khẳng định từng ô mà không có nguy cơ ghi sai. Vì vậy trong code, phần này nên lấy **đúng theo sơ đồ khởi tạo chính thức của giảng viên/đề bài**, thay vì tự đoán từ ảnh.

---

# 19. Luật đầy đủ ở dạng đặc tả

Bạn có thể đưa nguyên phần này vào báo cáo:

> **OTTv2 là trò chơi chiến thuật dành cho hai người chơi trên bàn cờ 9×9. Mỗi người chơi sở hữu các quân Đấm, Lá và Kéo. Hai người lần lượt thực hiện lượt chơi. Trong mỗi lượt, người chơi chọn một quân của mình và di chuyển quân đó đúng một ô theo một trong tám hướng, tương tự cách di chuyển của quân Vua trong cờ vua. Nếu ô đích trống, quân được di chuyển bình thường. Nếu ô đích có quân cùng phe, nước đi không hợp lệ. Nếu ô đích có quân đối phương, hai quân được so sánh theo quy luật Đấm thắng Kéo, Kéo thắng Lá và Lá thắng Đấm. Quân thắng được giữ vị trí, quân thua bị loại khỏi bàn. Trường hợp hai quân cùng loại, hai quân không thể ăn nhau và chỉ chặn đường nhau.**
>
> **Trò chơi có hai điều kiện chiến thắng. Thứ nhất, người chơi thắng khi ăn hết toàn bộ quân của đối phương. Thứ hai, người chơi thắng khi đưa được một quân bất kỳ của mình đến ô đích. Đích của quân Đỏ là góc dưới cùng bên trái của bàn cờ (A9), còn đích của quân Xanh là góc trên cùng bên phải của bàn cờ (I1). Ván đấu kết thúc ngay khi một trong hai điều kiện chiến thắng được thỏa mãn.**

## 20. Tóm tắt cực ngắn

```text
BÀN CỜ:             9 × 9

NGƯỜI CHƠI:         🔴 Đỏ và 🔵 Xanh

QUÂN:               ✊ Đấm
                    ✋ Lá
                    ✌️ Kéo

DI CHUYỂN:          1 ô/lượt
                    8 hướng
                    giống quân Vua

KHẮC CHẾ:           ✊ > ✌️
                    ✌️ > ✋
                    ✋ > ✊

CÙNG LOẠI:          Không ăn nhau
                    Chỉ chặn đường

THẮNG 1:            Ăn hết toàn bộ quân đối phương

THẮNG 2:
🔴 Đỏ               → A9 (góc dưới trái)
🔵 Xanh             → I1 (góc trên phải)

KẾT THÚC:           Khi đạt một trong hai điều kiện thắng
```

Đây là bộ luật mình sẽ coi là **phiên bản chuẩn của OTTv2** cho các bước tiếp theo.
