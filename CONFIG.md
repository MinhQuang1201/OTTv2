# Phương án tổ chức repository OTTv2

> Trạng thái: đang áp dụng theo từng giai đoạn. Cây thư mục bên dưới là cấu trúc đích; một số phần legacy còn được giữ tương thích.

Phần nền tảng của phương án đã được áp dụng: `packages/game-core`,
`packages/protocol`, `packages/game-client` và `apps/web/src/legacy` hiện chứa
các module canonical. Các entrypoint ở gốc chỉ giữ tương thích tạm thời.
`apps/worker/` hiện là Worker active. `partykit/` vẫn ở gốc vì là mã legacy
được test và adapter lưu trữ còn tham chiếu.

## Mục tiêu

- Chuyển giao diện HTML/JavaScript hiện tại sang React mà không phải viết lại luật chơi hoặc phần online.
- Bổ sung chat, khán giả và các tính năng phòng chơi bằng những module có trách nhiệm rõ ràng.
- Giữ Worker/Durable Object làm nơi quyết định trạng thái ván online. Trình duyệt chỉ gửi hành động và hiển thị kết quả được trả về.
- Giữ chế độ Local/AI hoạt động độc lập với dịch vụ online.

## Hiện trạng liên quan

| Thành phần | Vai trò hiện tại | Hướng chuyển |
| --- | --- | --- |
| `packages/game-core/src/config.js`, `rules.js`, `ai.js` | Cấu hình, luật thuần, AI local | Đã tổ chức |
| `packages/game-core/src/room.js` | Ghế A/B, đồng hồ, kết nối lại và xử lý nước đi | Module `game` phía Worker; giữ phần logic độc lập với hạ tầng |
| `apps/web/src/features/`, `apps/web/src/sessions/` | Sảnh, bàn cờ và ba chế độ chơi | React features và session boundaries hiện hành |
| `packages/game-client/src/` | Kết nối PlayHTML và client online | Đã tổ chức |
| `apps/worker/` | HTTP, lobby, Game Durable Object, quyền truy cập, lưu trữ | Đã tổ chức theo `entry`, `lobby`, `game`, `auth`, `persistence` |
| `packages/protocol/src/index.ts` | Kiểm tra lệnh và phản hồi online | Hợp đồng dùng chung; parser phía Worker vẫn kiểm tra đầu vào |
| `partykit/` | Mã cũ và một số phần còn được Worker dùng | Tách phụ thuộc đang dùng trước khi đưa mã không còn chạy vào `legacy/` |
| `vendor/playhtml-minimal/` | Runtime PlayHTML đã ghim | Giữ trong `vendor/`, có tài liệu nguồn và phiên bản |

React đã thay thế UI imperative cũ. `apps/worker/src/persistence/room-storage.ts` còn dùng `partykit/room-storage.js`, vì vậy chưa được chuyển toàn bộ `partykit/` sang `legacy/`.

## Cấu trúc đích

```text
apps/
  web/
    src/
      app/                 # Khởi tạo ứng dụng, routes, cấu hình frontend
      features/
        lobby/             # Tạo phòng, vào phòng, danh sách phòng
        game/              # Bàn cờ, HUD, đồng hồ, thao tác người chơi
        chat/              # Giao diện chat
        spectator/         # Giao diện khán giả
      shared/              # Component, theme và tiện ích thực sự dùng chung
    public/assets/

  worker/
    src/
      entry/               # HTTP routes và gắn kết transport
      lobby/               # Phòng chờ, create/join/resume
      game/                # Authority của ván, ghế, đồng hồ, kết quả
      chat/                # Quyền chat, giới hạn và lưu trữ khi cần
      auth/                # Ticket, capability và kiểm tra quyền
      persistence/         # Durable Object storage, alarm, khôi phục

packages/
  game-core/               # Luật, kiểu dữ liệu ván, AI local
  protocol/                # Lệnh, sự kiện, schema và phiên bản giao thức
  game-client/             # API cho frontend và adapter PlayHTML

tests/                     # Kiểm tra theo ranh giới game-core, worker, web
docs/                      # Kiến trúc, quyết định và bằng chứng vận hành
vendor/                    # Mã bên ngoài đã ghim phiên bản
legacy/                    # Mã cũ sau khi đã bỏ hết phụ thuộc runtime
```

Chỉ tạo thêm package như `packages/ui` khi có nhiều nơi dùng chung component thật sự. Không cần chia thành nhiều repository hoặc dịch vụ cho từng tính năng ở giai đoạn này.

## Quy tắc phụ thuộc

```text
apps/web    -> packages/game-client, packages/protocol, packages/game-core (Local/AI)
apps/worker -> packages/game-core, packages/protocol
game-client -> protocol, adapter PlayHTML
game-core   -> không phụ thuộc DOM, React, Worker hoặc PlayHTML
```

- UI không gọi trực tiếp hàm nội bộ của Durable Object hoặc sửa trạng thái ván online.
- `game-core` chứa logic thuần; các thao tác lưu trữ, đồng hồ hệ thống, kết nối và xác thực ở lớp bên ngoài.
- `protocol` định nghĩa hợp đồng lệnh/sự kiện và kiểm tra dữ liệu ở ranh giới mạng. Các thay đổi không tương thích cần có phiên bản giao thức rõ ràng.
- `game-client` cung cấp API như `createRoom`, `joinRoom`, `resumeRoom`, `move`, `leave` và đăng ký sự kiện. Component không phụ thuộc trực tiếp vào chi tiết PlayHTML.
- Worker chỉ trả cho từng vai trò phần dữ liệu họ được phép xem; không đưa credential, secret hoặc token nội bộ vào trạng thái công khai.

## Frontend: React hay Next.js

**Khuyến nghị trước mắt:** React với Vite trong `apps/web`. Ứng dụng hiện tập trung vào bàn cờ tương tác realtime; cách này chuyển dần giao diện với ít hạ tầng mới.

Nếu sau này cần trang công khai có SEO, nội dung hoặc render phía server, có thể dùng Next.js cho `apps/web`. Cấu trúc `packages/` và Worker vẫn giữ nguyên. Next.js không thay thế authority của Worker và không được trở thành nơi xử lý nước đi online.

## Thiết kế cho tính năng mới

### Chat

Thêm lệnh/sự kiện chat vào `protocol`; Worker kiểm tra vai trò, độ dài tin nhắn, tần suất gửi và chính sách lưu trữ; `features/chat` chỉ hiển thị và gửi ý định. Dùng kênh realtime PlayHTML hiện có cho cùng ván, không mở kết nối thứ hai. Quyết định có lưu lịch sử và giữ bao lâu trước khi triển khai persistence.

### Khán giả

Thêm vai trò `spectator` và vé truy cập riêng. Worker tạo bản chiếu trạng thái công khai cho khán giả, đồng thời từ chối lệnh `move`, `leave` và mọi thao tác dành riêng cho ghế A/B. Quyền xem ván, quyền chat và quyền xem lịch sử là các quyền riêng, cần được định nghĩa trong hợp đồng truy cập.

## Lộ trình chuyển đổi

1. Tách `game.js` theo ba trách nhiệm: trạng thái/giao diện, điều phối chế độ Local/AI/online, và adapter kết nối. Giữ hành vi hiện tại trong bước này.
2. Đưa luật và kiểu dữ liệu ván vào `game-core`; định nghĩa hợp đồng lệnh/sự kiện trong `protocol`. Chuyển dần khỏi kiểu import qua biến `window` và CommonJS sang module có thể dùng ở browser và Worker.
3. Tạo `apps/web`; chuyển sảnh và bàn cờ sang React từng phần. Local/AI dùng `game-core`; online dùng `game-client` và chỉ hiển thị trạng thái từ Worker.
4. Worker đã nằm trong `apps/worker`; bước tiếp theo là tách các adapter còn dùng `partykit/` trước khi chuyển mã PartyKit cũ vào `legacy/`.
5. Thêm chat và khán giả theo hợp đồng quyền truy cập mới, từng tính năng một.

Mỗi giai đoạn nên có đường chạy và kiểm tra tương ứng trước khi bỏ đường cũ. Trạng thái online production hiện vẫn phải theo các điều kiện và bằng chứng trong `README.md` cùng `docs/evidence/`; việc đổi cấu trúc thư mục không tự làm thay đổi trạng thái phát hành.
