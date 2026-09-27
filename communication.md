# Tổng Hợp Trao Đổi: PlayHTML, PartyKit Và Online Rollout

**Cập nhật:** 2026-09-25  
**Trạng thái:** Local/AI khả dụng; online production vẫn **BLOCKED**.

## Kết Luận Ngắn

Project không chỉ thiếu một package npm. Dependency cơ bản đã được cài, nhưng còn thiếu hai lớp tích hợp có evidence trực tiếp:

1. PlayHTML-compatible worker self-hosted, self-contained và chạy được.
2. Kênh server-authenticated để lobby khởi tạo game room an toàn.


```text
Trực tuyến chưa sẵn sàng: chưa có kết nối PlayHTML đã xác minh.
```

là kết quả đúng của safety gate, không phải một lỗi frontend đơn giản.

## Dependency Hiện Tại

`package.json` đã có:

```json
{
  "partykit": "0.0.115",
  "playhtml": "2.15.0"
}
```

Vì vậy chạy thêm các lệnh sau không giải quyết blocker:

```powershell
npm install playhtml
npm install partykit
```

Package `playhtml@2.15.0` cung cấp browser/client API, declarations và các dependency liên quan, nhưng không đồng nghĩa với việc project đã có một PlayHTML PartyKit worker self-contained có thể deploy ngay.

## Best Practice Của PlayHTML

Mô hình self-host đúng là:

```text
Browser
   |
   | playhtml.init({ host: YOUR_HOST })
   v
PlayHTML-compatible PartyKit worker
   |
   +-- PlayHTML/Yjs synchronization
   +-- custom server-side behavior
```

Không phải:

```text
Browser
   +-- PlayHTML WebSocket
   +-- Game WebSocket
```

Không nên tự chọc vào WebSocket nội bộ của PlayHTML hoặc tạo WebSocket thứ hai chỉ để game chạy online.

PlayHTML khuyến nghị self-host khi cần:

- kiểm soát infrastructure;
- custom server-side logic;
- data residency;
- worker tương thích với PlayHTML tại host riêng.

## PlayHTML API Không Thay Thế Game Authority

PlayHTML có các public abstraction như:

- `playhtml.init(...)`;
- custom elements;
- `can-play`;
- custom capabilities;
- custom events;
- page data;
- presence;
- PlayHTML client events.

Các API này phù hợp cho UI collaborative hoặc shared interaction, nhưng không tự giải quyết authorization của game.

Nếu client gửi:

```text
client -> ott:move
```

thì việc message đi qua PlayHTML không chứng minh client đó được phép:

- tạo game;
- giữ ghế A/B;
- resume;
- sử dụng token;
- thực hiện nước đi.

Vì vậy:

- PlayHTML là transport/collaboration layer;
- `Room`/Game Party là game authority;
- server phải validate seat, token, lượt, nước đi, clock và kết quả.

## Không Dùng PlayHTML Shared State Cho Secret Hoặc Authority

Không đưa các dữ liệu sau vào PlayHTML shared state, presence hoặc page data:

- resume token;
- secret/capability;
- ghế authoritative;
- clock authoritative;
- winner;
- game state cần server quyết định.

PlayHTML room identity chỉ chứng minh các client đang ở cùng room. Nó không chứng minh client nào được lobby cấp quyền tạo hoặc điều khiển game room.

## Hai Vấn Đề Độc Lập

### PlayHTML transport problem

Cần chứng minh cách để có một connection/worker chạy được:

- PlayHTML/Yjs protocol;
- initial sync;
- custom behavior;
- message/frame handling;
- browser-to-worker communication.

### Game authority problem

Cần server xác định:

- ai được tạo room;
- ai được join;
- ai giữ ghế A/B;
- ai được resume;
- token nào thuộc connection nào;
- nước đi có hợp lệ không.

Giải quyết PlayHTML transport không tự động giải quyết authorization của game.

## Worker Hiện Đang Thiếu

Repository upstream có worker source, nhưng evidence hiện tại cho thấy:

- worker source nằm trong upstream repository;
- pinned source không phải entry self-contained dễ import;
- worker phụ thuộc private modules, bindings và source nội bộ;
- `playhtml@2.15.0` không publish hoàn chỉnh worker entry tương ứng;
- project chưa vendor được một fork worker có thể chạy thật.

Project hiện có:

```text
partykit/playhtml-base.js
partykit/playhtml-ott-bridge.js
```

Đây chỉ là local adapter/test seam, không phải PlayHTML worker thật.

Các bridge test hiện tại chỉ chứng minh behavior của abstraction:

- nhận diện OTT envelope;
- chuyển frame non-OTT cho fake upstream;
- reject envelope malformed.

Chúng không chứng minh:

- browser PlayHTML thật gửi được OTT frame;
- worker thật nhận được OTT frame;
- Yjs/PlayHTML protocol vẫn hoạt động;
- frame đi qua cùng connection;
- PartyKit runtime thật chạy entry đó.

Nguồn trạng thái kỹ thuật duy nhất cho gate này là:

`docs/playhtml-upstream-lock.md`

## Browser Connection Factory

`game.js` kiểm tra:

```js
typeof window.OTT_PLAYHTML_CONNECTION_FACTORY === "function"
```

Nếu không có factory, UI dừng online flow và hiển thị:

```text
Trực tuyến chưa sẵn sàng: chưa có kết nối PlayHTML đã xác minh.
```

`playhtml-bootstrap.js` hiện là unavailable boundary có chủ ý. Nó chưa đăng ký:

```js
window.OTT_PLAYHTML_CONNECTION_FACTORY
```

Không nên viết factory bằng cách bọc WebSocket nội bộ chưa được xác minh. Nếu public PlayHTML API cung cấp một flow hợp lệ, adapter tương lai phải dùng flow đó, không tạo transport thứ hai.

Factory tương lai, nếu được chứng minh cần thiết, phải:

1. đọc public `OTT_PLAYHTML_HOST`;
2. gọi PlayHTML init đúng một lần;
3. chờ initial sync/`playhtml.ready`;
4. dùng connection PlayHTML đã mở;
5. không gọi `new WebSocket()`;
6. không gọi `new PartySocket()`;
7. không tạo PlayHTML session thứ hai;
8. không ghi game state vào page data, element data, presence hoặc CRDT.

Adapter chỉ được đăng ký sau khi worker/API đã có evidence.

## PartyKit Lobby-To-Game Blocker

PartyKit `0.0.115` đã được kiểm tra với contract:

```text
Stub.socket() -> WebSocket
Server.onMessage(message, sender)
```

Game party không biết socket/message đến từ lobby hay browser. `Server.onMessage()` không cung cấp authenticated:

- inter-party origin;
- route metadata;
- caller identity;
- server capability;
- trusted lobby context.

Vì vậy payload như sau không an toàn:

```json
{
  "type": "ott:internal-create"
}
```

Browser có thể gửi payload y hệt.

Không được dùng thay thế:

- internal payload marker;
- client relay;
- process-global `Map`;
- guessed PartyKit RPC;
- header/payload convention không được runtime xác minh.

Direct game `ott:create` đã bị chặn. Đây là logic bảo mật đúng, không phải bug cần hoàn tác.

## Kiến Trúc Mục Tiêu

```text
                    +----------------------+
                    |      Lobby Party     |
                    |                      |
Browser A --------->| create / join / list |
Browser B --------->| room registry        |
                    +----------+-----------+
                               |
                server-authenticated channel
                hoặc durable authority boundary
                               |
                               v
                    +----------------------+
                    |      Game Party      |
                    |                      |
                    | Room authority       |
                    | move validation      |
                    | seats                |
                    | resume tokens        |
                    | clock/alarm          |
                    +----------+-----------+
                               |
                               v
                    PlayHTML-compatible
                         connection
```

Trong mô hình này:

- PlayHTML cung cấp connection/collaboration infrastructure;
- Lobby quản lý waiting rooms;
- Game Party giữ authority ván;
- `Room` quyết định luật;
- token chỉ tồn tại trong server/private connection context;
- lobby không gửi token vào public list/state;
- browser không tự quyết định state.

## Hai Phương Án Authority

### Phương án A: Server-authenticated PartyKit channel

Cần evidence cho API có thể:

- xác định request đến từ lobby;
- truyền route metadata đáng tin;
- tạo capability server-issued;
- bind capability với `roomId`;
- giới hạn thời gian/số lần sử dụng;
- không forge được từ browser.

Flow:

```text
Browser -> Lobby
Lobby -> authenticated Game Party initialization
Game Party -> Room
```

### Phương án B: Đổi durable authority boundary

Nếu PartyKit `0.0.115` không có primitive phù hợp, cần đổi kiến trúc để lobby và game authority nằm trong cùng một boundary server đáng tin.

Ví dụ:

```text
Một durable Party authority
  - allocate room
  - validate create/join
  - giữ registry
  - tạo Room
  - xử lý game state
```

Không dùng process-global memory để thay thế durable authority.

## Những Gì Đã Được Hardening

- Direct game `ott:create` và `ott:list` bị từ chối.
- Online UI không giả vờ connected.
- Không dùng WebSocket thứ hai.
- Không dùng PartySocket fallback.
- Không dùng polling.
- Không fake `OTT_PLAYHTML_CONNECTION_FACTORY`.
- Local/AI vẫn hoạt động.
- Persistence fail-closed.
- Reconnect grace sau hydration được bổ sung.
- Revision/event ordering được bảo vệ.
- Cross-room state và malformed state bị loại.
- Static server chặn private paths kể cả case variants.
- Active-room resume không còn bị waiting list chặn ở lớp lobby.

## Những Gì Còn Thiếu

### PlayHTML layer

- PlayHTML worker fork self-contained;
- worker entry chạy thật;
- extension point source-backed;
- browser API cho custom game behavior;
- same-connection integration;
- runtime smoke test;
- two-profile acceptance.

### Authority layer

- authenticated lobby-to-game initialization;
- route/capability metadata không forgeable;
- lifecycle notifier durable giữa lobby và game;
- test setup không dùng direct client `ott:create`.

### Acceptance layer

- create/list/join thật;
- reconnect/resume thật;
- timeout thật;
- token isolation;
- two browser profiles;
- production-compatible PlayHTML transport.

## Vì Sao Không Chỉ Bỏ Toast

Không được sửa:

```js
return true;
```

hoặc:

```js
window.OTT_PLAYHTML_CONNECTION_FACTORY = fakeFactory;
```

hoặc:

```js
new WebSocket(...)
```

Các cách này chỉ ẩn thông báo nhưng không tạo ra:

- worker xử lý connection;
- route server;
- authorization;
- game state authority;
- resume token validation;
- persistence/alarm production;
- PlayHTML compatibility.

Kết quả có thể là UI báo online nhưng game không hoạt động hoặc có lỗ hổng bảo mật.

## Lộ Trình Xử Lý

1. Chốt phương án PartyKit authority: server-authenticated channel hoặc durable authority boundary khác.
2. Kiểm chứng hoặc xây self-contained PlayHTML-compatible worker fork tại commit cụ thể.
3. Viết runtime bridge test với worker thật, không dùng fake upstream làm gate evidence.
4. Xác định public PlayHTML browser integration và triển khai adapter trên cùng connection.
5. Nối lobby/game routing bằng channel server-authenticated.
6. Cập nhật runtime tests, loại direct client `ott:create` khỏi test setup.
7. Chạy full test suite với mục tiêu `0 failed`.
8. Chạy PartyKit/PlayHTML runtime smoke test.
9. Chạy two-profile acceptance:
   - create/list/join;
   - legal/invalid move;
   - timeout;
   - explicit leave;
   - disconnect/reload/resume;
   - reconnect expiry;
   - token isolation;
   - local/AI fallback.
10. Chỉ bỏ trạng thái BLOCKED khi mọi evidence được ghi lại trực tiếp.

## Cách Chạy Hiện Tại

Local/AI có thể chạy ngay:

```powershell
cd D:\Work\Study\OTTv2
npm install
npm start
```

Mở:

```text
http://localhost:3000
```

Chế độ dùng được:

- hai người trên cùng máy;
- đấu với AI;
- local offline.

Online create/join/resume chưa dùng được. Không cần chạy PartyKit cho local/AI.

## Tài Liệu Evidence Liên Quan

- `HANDOFF.md`: review findings, mức độ nghiêm trọng và rollout gates.
- `IMPLEMENTATION_STATUS.md`: trạng thái triển khai, verification và test fail còn lại.
- `docs/playhtml-upstream-lock.md`: nguồn trạng thái kỹ thuật duy nhất của PlayHTML Task 5.
- `docs/superpowers/plans/2026-09-25-online-rollout-remediation.md`: kế hoạch remediation 10 task.
- `README.md`: hướng dẫn chạy và trạng thái online.
- `CLAUDE.md`: module boundaries và guardrails bắt buộc.

## Kết Luận Cuối

Best practice phù hợp cho project là:

```text
playhtml package
        +
self-hosted PlayHTML-compatible worker
        +
public PlayHTML APIs
        +
authoritative game server
        +
server-side lobby/token authorization
```

Hiện project thiếu:

1. worker PlayHTML self-hosted chạy thật;
2. cách mở rộng worker để đưa game behavior qua cùng connection;
3. cơ chế server-authenticated từ lobby sang game authority.

Vì vậy toast unavailable đang phản ánh đúng trạng thái hệ thống. Local và AI có thể chơi ngay; online chỉ nên bật sau khi các integration gate trên có evidence trực tiếp.
