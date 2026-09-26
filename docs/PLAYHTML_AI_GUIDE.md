# Hướng Dẫn PlayHTML Cho AI

Tài liệu này là hướng dẫn vận hành cho AI khi thêm hoặc sửa tính năng dùng PlayHTML. Nó tóm tắt tài liệu gốc tại `docs/docs/`; khi API, kiểu TypeScript hoặc hành vi runtime không chắc chắn, ưu tiên kiểm tra package đã cài và tài liệu gốc thay vì suy đoán.

## Mục tiêu và phạm vi

PlayHTML biến phần tử HTML thành đối tượng cộng tác realtime. Với OTTv2, PlayHTML không phải authority của state ván: worker PartyKit/`Room` mới là nguồn chuẩn. Không tự xây WebSocket thứ hai cho state ván, và không dùng PlayHTML data primitives để thay thế worker protocol.

Trước khi sinh mã, AI phải xác định:

1. Người dùng nhìn thấy interaction nào?
2. Dữ liệu nào thay đổi khi interaction xảy ra?
3. Người vào room muộn hoặc tải lại trang có phải thấy dữ liệu đó không?
4. Dữ liệu thuộc cả room, một phần tử, hay chỉ một người dùng?
5. Ứng dụng dùng HTML thuần hay React?

Nếu câu trả lời về persistence, phạm vi chia sẻ, trigger hoặc shape dữ liệu chưa rõ, phải hỏi lại thay vì chọn ngẫu nhiên.

## Ngoại lệ game authoritative

Với OTTv2, quân cờ, lượt, ghế, đồng hồ, kết quả và lịch sử sự kiện thuộc `Room` trong worker PartyKit. Không ghi hoặc sửa các dữ liệu này bằng `pageData`, element data, `can-play`, `can-mirror`, event hay presence. Khi gate được mở, client chỉ gửi command `ott:*` qua adapter đã kiểm chứng và chỉ render snapshot worker trả về. Hiện adapter/bootstrap thật **BLOCKED**; `docs/playhtml-upstream-lock.md` là nguồn technical gate của Task 5, và bridge/mock test không phải evidence runtime. Presence/cursor chỉ dành cho state ephemeral; không dùng chúng cho authentication, authorization hoặc resume token.

### Blocked mode và evidence gate

Khi Task 4 hoặc Task 5 chưa có evidence trực tiếp, không đăng ký `OTT_PLAYHTML_CONNECTION_FACTORY`, không tạo WebSocket/PartySocket, polling, second PlayHTML session, fake factory hoặc fallback transport. PartyKit `0.0.115` hiện chỉ chứng minh `Stub.socket()` trả `WebSocket`, còn `Server.onMessage` không có authenticated inter-party origin/route metadata: direct game create bị từ chối, nhưng secure lobby-driven initialization vẫn BLOCKED. Không thay bằng internal payload marker forgeable, client relay hoặc process map. Online UI phải báo unavailable; local/AI vẫn dùng được. Không gọi đây là production-ready và không đánh dấu Task 5 hoặc acceptance PASS.

Chỉ sau Task 4, Task 5 và Task 6 có evidence trực tiếp mới được chạy two-profile acceptance. Evidence mở rollout phải bao gồm lobby-to-game channel/metadata server-authenticated, fork/revision/license và extension API đã xác minh, initial sync và OTT trên cùng verified connection, runtime integration cho routing/lifecycle/persistence, static-host denial kể cả case variants, và ghi nhận từng scenario: create/list/join, legal/invalid move, timeout, leave, disconnect/reload/resume, reconnect expiry, token isolation, local/AI fallback. Mỗi kết quả phải kèm ngày, commit/revision, phiên bản, host và command; scenario chưa chạy là chưa chạy, không phải PASS.

## Chọn đúng primitive

| Nhu cầu | Dùng | Đặc tính |
| --- | --- | --- |
| State bền vững của một phần tử: vị trí, bật/tắt, counter, danh sách | Element data với `defaultData` và `setData` | Realtime, persistent, key theo capability + `id` |
| State bền vững không gắn DOM: tài liệu, bảng điểm, cấu hình room | Page data với `createPageData()` / `usePageData()` | Realtime, persistent, key theo tên channel |
| Con trỏ, hover, focus, drag preview, trạng thái đang gõ | Presence hoặc awareness | Ephemeral; tự mất khi rời room |
| Hiệu ứng một lần: âm thanh, toast, animation trigger | Event | Broadcast, không persistent, không replay cho người vào muộn |
| Tùy chọn chỉ của browser hiện tại | Local React/DOM state hoặc `localStorage` | Không đồng bộ |

Quy tắc quyết định: nếu người vào muộn cần thấy kết quả, không dùng event hay presence. Nếu dữ liệu chỉ có ý nghĩa trong lúc người dùng đang online, không ghi persistent state.

## Khởi tạo, room và điều hướng

### HTML thuần

Với trang tĩnh, script sau phần tử tự khởi tạo mặc định:

```html
<button id="lamp" can-toggle>lamp</button>
<script type="module" src="https://unpkg.com/playhtml/dist/init.es.js"></script>
```

Khi cần options, dùng package/CDN module và chờ initial sync:

```js
import { playhtml } from "playhtml";

await playhtml.init({
  cursors: { enabled: true },
  developmentMode: import.meta.env?.DEV,
});
```

`playhtml.init()` và `playhtml.ready` hoàn tất sau initial sync. `ready` có thể reject khi không kết nối được. Có thể gọi `init()` nhiều lần nhưng connection được tái dùng; options có hiệu lực là options của lần đầu, options mâu thuẫn chỉ bị bỏ qua kèm warning.

Nếu nhiều island không có một điểm bootstrap duy nhất, gọi `playhtml.configure(options)` trước. Hàm này chỉ lưu options, không mở connection; mỗi island sau đó gọi `playhtml.init()`.

### Room và SPA navigation

Room mặc định dựa trên `window.location.pathname + window.location.search` (có prefix hostname). `room` dạng string giữ nguyên qua navigation; dùng `room: () => ...` nếu muốn tính lại từ route.

Với router không được PlayHTML tự nhận diện, gọi `await playhtml.handleNavigation()` sau navigation. Khi room đổi, state hiện tại được thay bằng state room mới, nhưng room cũ không bị xóa. Navigation thành công phát DOM event `playhtml:navigated`, với `event.detail.room`.

## Quy tắc dữ liệu CRDT

### Cập nhật merge-friendly

Dùng mutator khi giá trị mới phụ thuộc state hiện tại hoặc có nhiều client cùng ghi:

```js
handle.setData((draft) => {
  draft.count += 1;
});
```

Chỉ thay snapshot khi toàn bộ object thật sự là một giá trị last-write-wins:

```js
handle.setData({ theme: "dark", compact: true });
```

Không đọc UI đã render để tính state mới. Không replace object cha nếu chỉ cần sửa một field sâu.

### Array và collection

Trong mutator array, chỉ dùng `push()` và `splice()`. Không dùng `pop()`, `shift()` hoặc gán trực tiếp `draft.items[index] = value`.

```js
handle.setData((draft) => {
  draft.entries.push({ id: crypto.randomUUID(), text });
  if (draft.entries.length > 20) draft.entries.splice(0, draft.entries.length - 20);
});
```

Dùng object key ổn định cho collection cần unique hoặc update cạnh tranh:

```js
handle.setData((draft) => {
  draft.votesByUser[userId] = choice;
});
```

Mọi danh sách tăng dần phải có giới hạn. Không lưu derived/computed state nếu có thể tính lại khi render. Debounce dữ liệu tần suất cao và không sync mỗi `mousemove`, `scroll`, keystroke hoặc physics tick.

### Cấm feedback loop

Không gọi `setData()` trong `updateElement`, render/view, hoặc effect/subscription phụ thuộc chính data đang được ghi, trừ khi có guard hội tụ rõ ràng và đã kiểm chứng. Các loop này có thể tạo hàng triệu CRDT operations.

## Identity ổn định và lifecycle phần tử

Mọi element chia sẻ phải có `id` duy nhất, ổn định theo thời gian:

```html
<div id="whiteboard-note-42" can-play></div>
```

Không dựa vào fallback hash của HTML. Không dùng `selector-id` cho danh sách có insert, remove hoặc reorder vì identity theo vị trí sẽ gán state nhầm phần tử. Nó chỉ phù hợp danh sách cố định có thứ tự bất biến.

Với phần tử thêm động sau init:

```js
playhtml.setupPlayElement(element);
// Hoặc quét một batch DOM:
playhtml.setupPlayElements();
```

Với lifecycle React/framework, tháo listener bằng `playhtml.removePlayElement(element)` khi unmount. Hàm này giữ shared data. Chỉ dùng `playhtml.deleteElementData(tag, elementId)` khi cố ý xóa vĩnh viễn dữ liệu của mọi client sau khi sync.

## API HTML thuần

### `register()` cho một phần tử

Đây là API ưu tiên cho custom behavior mới trong vanilla JavaScript. Có thể register bằng `id` trước khi DOM tồn tại hoặc truyền trực tiếp element.

```js
const note = playhtml.register("note-42", {
  defaultData: { text: "", color: "#fff" },
  updateElement({ data, element }) {
    element.textContent = data.text;
    element.style.background = data.color;
  },
  onClick(_event, { setData }) {
    setData((draft) => {
      draft.color = "#f5d78e";
    });
  },
});
```

Handle có các phương thức chính: `getElement()`, `getData()`, `setData()`, `setLocalData()`, `setMyAwareness()`, `requestUpdate()` và `unregister()`. Trước khi bind với element, read trả `undefined`/`null`; write bị drop. Không ghi trước khi element có mặt và sync sẵn sàng.

`unregister()` chỉ tháo handler local, không xóa shared data. API property trực tiếp như `element.defaultData` và `element.updateElement` đã deprecated, không dùng trong code vanilla mới.

### `define()` cho capability tái sử dụng

```js
playhtml.define("can-rating", {
  defaultData: { value: 0 },
  updateElement({ data, element }) {
    element.setAttribute("aria-valuenow", String(data.value));
  },
});
```

Sau đó dùng `<div id="rating-a" can-rating></div>`. Không đặt tên trùng built-in capability vì sẽ throw. Cũng có thể truyền capability qua `init({ extraCapabilities })`.

`updateElement` là API supported. Không kết hợp `updateElement` với `view`.

### Page data

Chỉ tạo page data sau `await playhtml.ready`:

```js
const scoreboard = playhtml.createPageData("scoreboard", { red: 0, blue: 0 });
scoreboard.setData((draft) => {
  draft.red += 1;
});
const stop = scoreboard.onUpdate((data) => renderScore(data));
// Khi không còn cần channel:
stop();
scoreboard.destroy();
```

`setData` với object/array nhận mutator draft; với primitive, mutator phải return giá trị mới. Các write đồng bộ được batch thành một callback cuối.

### Events

Đăng ký type trước rồi mới dispatch. Sender cũng nhận event. Handler phải idempotent vì concurrent events không bảo đảm thứ tự.

```js
const listenerId = playhtml.registerPlayEventListener("confetti", {
  onEvent: (payload) => showConfetti(payload),
});

playhtml.dispatchPlayEvent({ type: "confetti", eventPayload: { color: "gold" } });
playhtml.removePlayEventListener("confetti", listenerId);
```

Docs có mâu thuẫn về shape callback event: một reference ghi callback nhận wrapper `{ eventPayload }`, ví dụ khác destructure payload trực tiếp. Trước khi dùng production, kiểm tra TypeScript declaration/runtime package đang cài và chuẩn hóa một cách dùng trong dự án.

## Built-in capabilities

| Capability | Shared data/hành vi | Lưu ý |
| --- | --- | --- |
| `can-move` | `{ x, y }`, drag để dịch chuyển | Có bounds attributes; reset Shift-click |
| `can-spin` | `{ rotation }` | Reset Shift-click |
| `can-toggle` | `{ on }`, class `toggled` | Reset Shift-click |
| `can-grow` | `{ scale }`, click tăng, Alt-click giảm | Local max scale; reset Shift-click |
| `can-duplicate` | Danh sách id clone | Cần template/reference rõ ràng |
| `can-hover` | Awareness hover, không persistent | Dùng cho affordance tạm thời |
| `can-mirror` | Snapshot DOM giới hạn | Xem giới hạn bên dưới |
| `can-play` | Custom schema/hành vi | Dùng khi cần kiểm soát state rõ ràng |

Không gắn `can-move`, `can-spin` và `can-grow` cùng một element: chúng đều ghi `style.transform` và sẽ overwrite nhau. Dùng `can-play` để compose transform.

## `can-mirror` và custom rendering

`can-mirror` đồng bộ attributes của element, direct children (add/remove/reorder, text direct), giá trị form phổ biến và hover/focus awareness. Nó không đồng bộ arbitrary mutation sâu trong descendant, scroll position, media time, canvas/WebGL pixels, file input, hoặc bare nested text mutation.

Tạo nested `can-mirror` boundary nếu child tự quản lý thay đổi. Vì `can-mirror` còn evolving/experimental, dùng `can-play` khi cần schema rõ ràng, validation, migration hay full control.

`view` dùng lit-html và cũng experimental. `view` loại trừ `updateElement`, `onClick`, `onDrag`, `onDragStart`; state chỉ được ghi từ event handler trong template hoặc `onMount`, không phải trong render. Không dùng HTML không tin cậy; PlayHTML cố ý không export `unsafeHTML`.

## React

Cài đặt:

```bash
npm install playhtml @playhtml/react
```

Bao đúng một React root bằng một `PlayProvider`:

```tsx
import { PlayProvider } from "@playhtml/react";

export function App() {
  return (
    <PlayProvider initOptions={{ cursors: { enabled: true } }}>
      <Game />
    </PlayProvider>
  );
}
```

Với React Router hoặc Next, truyền route hiện tại để room thay đổi chính xác:

```tsx
<PlayProvider initOptions={options} pathname={pathname}>
  {children}
</PlayProvider>
```

Dùng `CanPlayElement` hoặc `withSharedState()` khi cần state schema tùy chỉnh. Render props cung cấp `data`, `setData`, `awareness`, `myAwareness`, `setMyAwareness` và `ref`.

```tsx
<CanPlayElement id="counter" defaultData={{ count: 0 }}>
  {({ data, setData }) => (
    <button onClick={() => setData((draft) => { draft.count += 1; })}>
      {data.count}
    </button>
  )}
</CanPlayElement>
```

Dùng hooks trong Provider: `usePageData`, `usePresence`, `usePresenceRoom`, `useUsers`, `usePlayerIdentity`, `useCursorPresences`, `useCursorZone` và `usePlayContext`. Trước khi sync xong, hooks trả default/empty và setter có thể no-op; UI phải chịu được trạng thái loading.

`standalone` chỉ dành cho island ngoài React tree không thể dùng Provider, không dùng để thay thế cấu trúc Provider chuẩn. Một số interface wrapper được docs liệt kê không đầy đủ; khi dùng props nâng cao, kiểm tra type package đang cài hoặc dùng `CanPlayElement` là surface đầy đủ hơn.

## Presence, users và cursors

Chỉ gọi `playhtml.presence`, `playhtml.users` hoặc `createPresenceRoom()` sau initial sync.

```js
playhtml.presence.setMyPresence("drag", { itemId: "42", x, y });
const unsubscribe = playhtml.presence.onPresenceChange("drag", renderRemoteDrags);
// Xóa state ephemeral khi xong:
playhtml.presence.setMyPresence("drag", null);
```

Presence set theo replacement semantics, không merge. Không dùng channel names reserved `playerIdentity`, `cursor`, `isMe`.

`playhtml.users` là roster/identity lâu bền hơn cursor: dùng `playhtml.users.me`, `getAll()` và `onChange()`. `PlayerIdentity` được giữ local theo browser, không phải hệ thống tài khoản. Không đặt secrets, profile riêng tư hay browser history vào đó.

Cursor hỗ trợ `enabled`, room, container, custom style/render và proximity callbacks. Nếu dùng canvas/transformed container, container cần positioning không static, `transform-origin: 0 0`, và chỉ nên dùng 2D affine transform. Một số docs mô tả cursor options không xuất hiện trong reference interface; xác minh type/runtime trước khi dùng chúng.

## Shared elements và quyền

Source chia sẻ capability cho các page/domain khác:

```html
<div id="couch" shared="read-only" can-move></div>
```

Consumer đọc source qua `data-source` và cần capability tương ứng:

```html
<div data-source="thissite.com/path#couch" data-source-read-only can-move></div>
```

`shared` hoặc `shared="read-write"` cho phép read-write; `shared="read-only"`/`"ro"` chỉ đọc. Consumer có thể tự ép local read-only với `data-source-read-only`. Dùng `playhtml.listSharedElements()` để debug binding/quyền.

Không coi read-only UI là biên bảo mật cho dữ liệu nhạy cảm. Validate mọi input người dùng trước khi đưa vào `href`, `src` hoặc style; với lit-html dùng `styleMap` thay vì ghép string style từ input không tin cậy.

## Kiểm thử và vận hành

1. Mở hai browser profile khác nhau, hoặc một cửa sổ thường và một cửa sổ private/incognito.
2. Xác nhận client thứ hai nhận update realtime.
3. Reload client thứ hai để xác nhận persistent state được khôi phục khi yêu cầu.
4. Vào room muộn để xác nhận event không bị replay và presence cũ biến mất.
5. Thử concurrent writes cho counter, list, vote hoặc drag ownership.
6. Thử navigation nếu room dựa theo route.
7. Bật `developmentMode: true` chỉ trong development để inspect store, element binding và connection.

Không đưa `developmentMode` hoặc công cụ reset/debug vào production. Với orphan cleanup endpoint, luôn `dryRun` trước và chỉ derive `activeIds` từ database đáng tin cậy của ứng dụng, không từ state sắp bị xóa.

## Checklist bắt buộc trước khi hoàn tất

- [ ] Mỗi element shared có `id` ổn định và duy nhất.
- [ ] Mỗi state đã được phân loại persistent element/page data, presence, event hoặc local-only.
- [ ] Update cạnh tranh dùng mutator; array mutator chỉ dùng `push`/`splice`.
- [ ] Không có render/update/effect tự ghi lại state mà nó đang theo dõi.
- [ ] Dữ liệu high-frequency được throttle/debounce; list có cap.
- [ ] Custom vanilla code dùng `register()`/`define()`, không dùng API property deprecated.
- [ ] React có đúng một `PlayProvider` mỗi root và chịu được loading.
- [ ] `can-mirror` chỉ dùng trong biên đồng bộ được hỗ trợ; state phức tạp dùng `can-play`.
- [ ] Event handler idempotent và event type được đăng ký trước dispatch.
- [ ] API có tài liệu mâu thuẫn đã được xác minh bằng exported type/runtime.
- [ ] Đã test ít nhất hai client và reload/late-join khi tính năng có persistence.

Đối với OTTv2, checklist hai client/manual acceptance chỉ được đánh dấu sau khi Task 4, Task 5 và Task 6 có evidence trực tiếp. Khi Task 4 hoặc Task 5 còn BLOCKED, xác minh blocked mode thay thế: factory/bootstrap không có, không tạo online transport hoặc forgeable lobby-to-game route, UI báo unavailable và local/AI hoạt động. Không đánh dấu Task 5 hoặc manual acceptance PASS tại tài liệu này; chỉ ghi nhận scenario thực sự đã chạy với evidence yêu cầu ở trên.

## Nguồn cần đọc khi cần chi tiết

- Khởi đầu và mô hình: `docs/docs/getting-started.mdx`, `docs/docs/concepts.md`.
- Hướng dẫn AI: `docs/docs/integrations/building-with-ai.md`.
- Client/options: `docs/docs/reference/playhtml-client.md`, `docs/docs/reference/init-options.md`.
- Initializer, handle, view: `docs/docs/reference/element-api.md`, `docs/docs/reference/view-api.md`.
- Data/merge/events: `docs/docs/data/data-essentials.md`, `docs/docs/data/page-data.mdx`, `docs/docs/data/events.mdx`, `docs/docs/advanced/merging-data.md`.
- Presence/cursors/users: `docs/docs/reference/presence.md`, `docs/docs/data/presence/`.
- React: `docs/docs/using-react.md`, `docs/docs/reference/react-api.md`.
- Capabilities/mirror/dynamic/navigation/shared: `docs/docs/reference/capabilities.md`, `docs/docs/custom-elements.mdx`, `docs/docs/advanced/`.
- Tham khảo pattern có thể chạy: `docs/docs/examples/`.
