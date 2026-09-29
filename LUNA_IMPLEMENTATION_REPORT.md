# Kế Hoạch Luna: Fork Tối Thiểu PlayHTML Cho Online OTT

> **Dành cho Luna:** Bắt buộc làm từng task theo TDD, giữ checkbox cập nhật theo evidence. Không mở online hoặc đổi trạng thái release trước Task 10.

**Ngày cập nhật:** 2026-09-25  
**Quyết định kiến trúc:** Fork tối thiểu source PlayHTML local tại `D:\Work\Study\playhtml`, commit `4008c42b7d2c6157065afe0071d829dbc561af01`.  
**Mục tiêu:** Thay online boundary bị BLOCKED bởi một Cloudflare Worker/Durable Object tự chủ: PlayHTML/Yjs và OTT custom-message dùng cùng kết nối; lobby và game authority dùng trusted DO-to-DO request.  
**Trạng thái hiện tại:** Local/AI khả dụng. Online vẫn **BLOCKED** cho tới khi Task 10 PASS.

---

## 1. Kết luận đã thay đổi

Blocker “không có PlayHTML worker thật” đã có hướng giải quyết khả thi: source local có worker thực, không phải adapter giả.

| Evidence | Ý nghĩa cho OTT |
| --- | --- |
| `playhtml/partykit/party.ts:209` khai báo `PartyServer extends YServer` | Có worker Yjs/PlayHTML thật để fork. |
| `playhtml/partykit/party.ts:1587-1626` override `onCustomMessage(sender, message)` | Có extension point server sau boundary PlayHTML/Yjs; không cần parse raw WebSocket. |
| `playhtml/packages/playhtml/src/index.ts:984-1000` tạo `YProvider`, gửi `sendMessage` và subscribe `custom-message` | Browser và worker có cùng connection custom-message. |
| `playhtml/partykit/party.ts:3234-3235` dùng `getServerByName(...).fetch(...)` | Có DO-to-DO request thực. |
| `playhtml/partykit/bridgeAuth.ts:4-44` xác thực header bằng secret Worker environment | Có mẫu server-only authentication, không phải payload marker forgeable. |
| `playhtml/partykit/wrangler.jsonc` | Worker nguồn chạy trên Cloudflare Workers/Wrangler + Durable Objects, không phải entry drop-in cho PartyKit `0.0.115`. |

Do đó Luna **không tiếp tục cố gắng wiring `partykit.json`/PartyKit `0.0.115` hiện tại cho production online**. Online migration chuyển sang Cloudflare Workers + `partyserver`/`y-partyserver`, dùng minimal fork thay vì sao chép toàn bộ upstream application.

## 2. Kiến trúc đích

```text
Browser A/B
  |
  | HTTPS control API: create / list / join / resume allocation
  v
OTT Lobby Durable Object
  - create/list/join allocation
  - waiting room registry only
  - issues private route/capability
  - lifecycle cleanup
  |
  | trusted DO-to-DO Request
  | server-only secret + room-bound, expiring initialization capability
  |
  v
  | một PlayHTML YProvider connection / game room
  | custom-message OTT qua API public của fork
  | first accepted OTT custom message: opaque room-bound attach ticket
  v
OTT Game Durable Object
  - extends/fork YServer behavior
  - Yjs/PlayHTML sync
  - OTT onCustomMessage adapter
  - Room authority: seats, opaque resume token, move, clock, winner
  - durable Room persistence + alarm
```

### Bất biến kiến trúc

- `Room` trong `room.js` tiếp tục là authority của luật, ghế, token, clock và winner. Không chuyển luật vào browser hoặc CRDT.
- Game state authoritative không được ghi vào PlayHTML `pageData`, element data, `presence`, event hay Yjs shared data.
- Browser gửi OTT command chỉ qua custom-message channel của một YProvider đã khởi tạo. Không tạo `WebSocket`, PartySocket, polling hoặc PlayHTML session thứ hai.
- Fork browser OTT phải vô hiệu hóa users presence, cursor, element-awareness và page presence trước init, nên không được construct `PartySocket`. YProvider là connection PlayHTML duy nhất và là transport OTT duy nhất.
- Browser gọi create/list/join/resume **control plane** qua HTTPS Worker endpoint trước khi mở game room. Sau attach, move/leave/state/reconnect command của ván chỉ đi qua một PlayHTML connection.
- Lobby không trực tiếp tin browser để gọi Game DO. Browser payload không thể mang bí mật server-only.
- Lobby trả browser một opaque attach/resume ticket scoped theo room/seat/purpose/expiry. Ticket là credential của client nên chỉ giữ local/session storage tối thiểu; không đưa vào URL, public list, CRDT/page data/presence/log/error. Game xác thực ticket tại OTT custom message được chấp nhận đầu tiên, `ott:attach`, trước mọi command game. Yjs initial sync được phép đi trước attach, nhưng document của OTT room luôn read-only/unpersisted: mọi client Yjs mutation bị reject/discard và không ảnh hưởng client khác.
- Game DO từ chối direct create/list và mọi internal command không có trusted capability/route context.
- Public PlayHTML room identity chỉ chọn connection/collaboration room. Nó không là authorization và không mang resume token/capability/game state.
- Đã chọn minimal fork: không vendor Supabase persistence, admin routes, cross-room shared-element bridge, presence worker, quarantine/control plane hoặc feature upstream không phục vụ OTT.

## 3. Phạm vi file dự kiến

| File | Trách nhiệm |
| --- | --- |
| `workers/ott-worker.ts` | Cloudflare Worker entry; `partyserver` route/upgrade contract cho YProvider và HTTPS control routes. |
| `workers/ott-game-server.ts` | Minimal PlayHTML-compatible game DO; giữ YServer lifecycle, dispatch OTT qua `onCustomMessage`. |
| `workers/ott-lobby-server.ts` | Durable lobby allocation/list/join và trusted game initialization. |
| `workers/internal-auth.ts` | Xác thực DO-to-DO request; capability issue/verify; constant-time compare nếu runtime phù hợp. |
| `workers/protocol.ts` | Parse/validate OTT envelope, command và response; không chứa game rule. |
| `workers/room-storage.ts` | Adapter `Room` persistence vào DO storage; schema validation fail-closed. |
| `workers/wrangler.jsonc` | Worker entry, Durable Object bindings, migrations, environment bindings. |
| `vendor/playhtml-minimal/**` | Chỉ source upstream cần cho YServer runtime, pinned revision, NOTICE và manifest nguồn. |
| `playhtml-bootstrap.js` | Init PlayHTML đúng một lần với `{ host, room }`; chỉ register factory sau sync. |
| `playhtml-game-client.js` | Client authoritative session state machine, dùng public custom-message channel. |
| `game.js`, `index.html`, `playhtml-game.html` | UI online/fallback và script ordering. |
| `tests/**` | Unit, server-boundary, browser adapter và runtime tests. |

Không xóa PartyKit legacy ngay. Nó chỉ được loại sau khi Worker migration có test/runtime acceptance PASS; trong thời gian migration, production config không được có hai transport active.

## 4. Task triển khai

### Task 0: Baseline, version lock và license manifest

**Mục tiêu:** tạo base reproducible trước khi code migration.

**Files:** tạo `docs/evidence/2026-09-25-playhtml-minimal-fork-baseline.md`; sửa `package.json` chỉ khi cần script test Worker; tạo `vendor/playhtml-minimal/NOTICE.md`.

- [ ] Đọc `CLAUDE.md`, `CONTEXT.md`, `docs/PLAYHTML_AI_GUIDE.md`, `room.js`, `partykit/room-storage.js`, `playhtml-game-client.js` trước khi sửa.
- [ ] Chạy `rtk git status --short`; không revert file người khác.
- [ ] Ghi commit PlayHTML source `4008c42b7d2c6157065afe0071d829dbc561af01`, license MIT, Node/Bun/Wrangler/partyserver/y-partyserver/Yjs versions resolve thực tế.
- [ ] Ghi rõ source symbols được fork: `PartyServer`, `YServer` lifecycle, `onCustomMessage`, `YProvider.sendMessage`, `custom-message`, DO-to-DO fetch/auth pattern.
- [ ] Ghi exact `partyserver`/`y-partyserver` version và routing symbols `routePartykitRequest`, `getServerByName`, public upgrade URL/room normalization contract mà `YProvider(host, room)` dùng.
- [ ] Chạy baseline `npm test`, `git diff --check`, và `node --check` riêng từng file JS runtime hiện hữu; ghi result thật, không gọi suite đỏ là pass.
- [ ] Commit docs-only checkpoint: `docs: record minimal playhtml fork baseline`.

**Done:** evidence pin/license/runtime source đã ghi; Local/AI vẫn chạy.

### Task 1: Scaffold Worker tối thiểu, chưa có OTT

**Mục tiêu:** chạy được PlayHTML/Yjs worker nguồn tối thiểu ở Cloudflare local runtime mà không phụ thuộc Supabase hoặc upstream control plane.

**Files:** tạo `workers/ott-worker.ts`, `workers/ott-game-server.ts`, `workers/wrangler.jsonc`, `workers/worker-configuration.d.ts`, `vendor/playhtml-minimal/**`; tạo `tests/worker-entry.test.js` hoặc TypeScript test tương đương.

- [ ] Viết failing integration test: `YProvider(host, room)` thực hiện HTTP/WebSocket upgrade vào Worker local, reaches sync; assert normalized public room map tới đúng Game DO. Đây không chỉ là class-import test.
- [ ] Chạy test/check để xác nhận RED do entry chưa tồn tại.
- [ ] Vendor **tối thiểu** source/runtime dependency cần để `YServer` phục vụ Yjs sync và `partyserver` routing/upgrade. Mỗi file copied phải có source path, source SHA và license entry trong NOTICE.
- [ ] Không copy `db.ts`, `admin.ts`, `sharing.ts`, `bridgeAuth.ts` upstream như production dependency. `bridgeAuth.ts` chỉ là pattern tham khảo; OTT viết implementation nhỏ riêng ở Task 4.
- [ ] Implement `OttGameServer` chỉ khởi tạo YServer và delegate `onConnect`, `onMessage`, `onClose`; chưa nhận OTT command, chưa instantiate `Room`. Yjs document của OTT room không được persist và mọi incoming Yjs mutation phải bị discard/reject theo reviewed YServer hook, để unauthenticated sync không có shared state side effect.
- [ ] Fork browser initialization tối thiểu để không gọi `connectUsersPresenceTransport`, `buildCursors`, `buildElementAwarenessClient` hoặc `buildInnerPresenceAPI`; remove/guard imports dẫn tới `RealtimePresenceTransport`/`PartySocket`. Giữ `YProvider` sync duy nhất.
- [ ] Cấu hình Wrangler DO binding/migration và local dev command. Secrets phải đọc từ environment binding, không hard-code, không gửi ra client.
- [ ] Chạy typecheck/build và local Worker smoke: connect hai YProvider PlayHTML, chờ sync, reconnect không crash; assert fork browser không construct `PartySocket`/presence socket.
- [ ] Commit: `feat: add minimal playhtml worker scaffold`.

**Done:** self-contained local Worker sync được PlayHTML thật; không có Supabase/admin/shared-element/presence dependency trong runtime OTT.

**Gate ownership:** Trong Tasks 1-9, giữ nguyên trạng thái `BLOCKED` và rule gate của `docs/playhtml-upstream-lock.md`; chỉ được append dated evidence/reference. Chỉ Task 10 được đổi trạng thái lock, sau khi two-client browser-to-Worker smoke, custom-message boundary tests và runtime evidence đã hoàn tất/link trực tiếp.

### Task 2: Public custom-message channel trong fork browser API

**Mục tiêu:** browser OTT dùng một API public source-backed, không chạm `yprovider` module-private.

**Files:** sửa `vendor/playhtml-minimal/browser/**` hoặc fork package source; sửa declaration build; tạo `tests/playhtml-custom-channel.test.js`; cập nhật `vendor/playhtml-minimal/NOTICE.md` và evidence.

- [ ] Viết failing type/runtime test cho API nhỏ, ví dụ `playhtml.createCustomMessageChannel()` trả `{ send(message: string), subscribe(listener): () => void }`.
- [ ] Test `send` trước `playhtml.ready` reject rõ ràng; sau ready gửi đúng một custom message; unsubscribe ngăn listener chạy.
- [ ] Test channel không ghi page data, element data, presence hoặc syncedStore; fork OTT browser không construct presence/cursor/awareness transport hoặc `PartySocket`.
- [ ] Implement adapter trên `YProvider.sendMessage` và `yprovider.on("custom-message")` bên trong fork; không expose raw WebSocket/provider object.
- [ ] API chỉ nhận string; OTT layer tự JSON encode/decode. Không tự thêm raw-frame/binary forwarding contract.
- [ ] Chạy browser/unit tests và local two-client smoke xác minh PlayHTML sync không regression.
- [ ] Commit: `feat: expose playhtml custom message channel`.

**Done:** custom channel là public API có declaration/test; không dùng private hack và không tạo connection thứ hai.

### Task 3: OTT envelope dispatch tại PlayHTML custom-message boundary

**Mục tiêu:** chỉ intercept OTT envelope hợp lệ sau `YServer.onCustomMessage`; mọi upstream non-OTT behavior được giữ.

**Files:** tạo `workers/protocol.ts`, sửa `workers/ott-game-server.ts`; tạo `tests/ott-playhtml-bridge.test.js`.

- [ ] Viết failing tests: `{ "__ott": true, "type": "ott:move" }` dispatch OTT; missing `__ott`, non-string type, malformed JSON, unknown `ott:*` reject hoặc ignore theo protocol mà không mutate game state.
- [ ] Viết failing test policy: OTT game rooms reject/ignore mọi non-OTT custom message. Không gọi `super.onCustomMessage` với mục tiêu giữ behavior ứng dụng PlayHTML upstream, vì minimal fork không vendor sharing/event handlers đó. Không assert binary forwarding nếu source fork không có contract đó.
- [ ] Implement parse/validation trong `workers/protocol.ts`; cap payload 8KB, coordinates integer và reject object shape bất hợp lệ trước `Room`. Track `lastAcceptedOttPacketMs` per connection; reject/close packet nhận trong dưới 40ms, gồm move/leave/malformed burst, trước mọi `Room` mutation; clear state on close.
- [ ] Override `onCustomMessage(sender, message)` trong `OttGameServer`: OTT hợp lệ -> game command handler; non-OTT -> ignore/reject theo policy. `ott:attach` phải là OTT command được chấp nhận đầu tiên cho connection; command game trước attach bị reject. Initial Yjs sync được phép trước attach nhưng Yjs update từ client luôn không persist/không broadcast.
- [ ] Response OTT dùng `sendCustomMessage` tới đúng connection hoặc broadcast khi protocol yêu cầu; state response luôn có `__ott: true`, `roomId`, `revision` và valid shape.
- [ ] Chạy test bridge cùng smoke hai clients: Yjs sync + OTT echo/protocol validation đi trên cùng connection.
- [ ] Commit: `feat: route ott commands through playhtml custom messages`.

**Done:** source-backed same-connection custom-message bridge chạy runtime; fake injected handler không được dùng làm gate evidence.

### Task 4: Durable authority model và DO-to-DO authentication

**Mục tiêu:** thay PartyKit lobby-to-game blocker bằng trusted Cloudflare DO boundary.

**Files:** tạo `workers/ott-lobby-server.ts`, `workers/internal-auth.ts`; sửa `workers/ott-worker.ts`, `workers/wrangler.jsonc`; tạo `tests/ott-authority.test.js`.

- [ ] Viết failing tests cho capability: có `roomId`, purpose, expiry, nonce/single-use; browser payload không có server secret bị reject; expired/wrong-room/replay bị reject.
- [ ] Viết failing test Lobby DO allocate room -> Game DO internal initialization; Game DO direct browser `ott:create`/`ott:list` vẫn reject và không mutate state.
- [ ] Implement server-only secret as Wrangler secret `OTT_INTERNAL_SECRET`; không dùng secret chung từ browser config, query string, public state, log hoặc PlayHTML data.
- [ ] Implement signed/MACed capability using Web Crypto in Worker runtime. Payload serialized canonical; compare signature constant-time where API supports; persist consumed nonce/expiry state in DO storage.
- [ ] Lobby gọi Game DO bằng `env.OTT_GAME.get(id).fetch(new Request(...))`; Game chỉ accept initialization endpoint có valid secret + capability. Browser-facing WebSocket/custom-message route không gọi endpoint này.
- [ ] Expose narrow HTTPS control routes Worker -> Lobby DO: `create`, `list`, `join`, `resume`. Validate payload/rate limit; list never returns ticket, token, capability, seat authority or game state. Browser receives only opaque attach/resume ticket for its own allocated seat.
- [ ] Require first accepted OTT custom message in a new game connection to be `ott:attach` with that opaque room-bound, expiring ticket. Before attach, reject move/leave/resume and do not publish authoritative state. Initial Yjs protocol sync is allowed before attach, but pre/post-attach Yjs client mutations must neither persist nor affect another client. Persist/revoke ticket lifecycle consistently with `Room` seat/resume semantics.
- [ ] Chọn deterministic public PlayHTML room mapping, ví dụ opaque allocated game id -> one normalized PlayHTML room. Persist mapping in Game DO. Mapping không thay thế capability/token.
- [ ] Implement durable idempotent lifecycle notify Game -> Lobby bằng cùng trusted request model để xóa waiting listing khi game starts/terminal/waiting expiry; retry không tạo duplicate.
- [ ] Chạy server-boundary tests gồm restart/replay/expiry/unauthorized request.
- [ ] Commit: `feat: add trusted lobby to game durable authority`.

**Done:** authoritative game initialization có server-authenticated, room-bound, expiring, replay-resistant route; không có `Map` process-global, client relay, payload marker forgeable hay direct game create bypass.

### Task 5: Port Room persistence, alarm và lifecycle vào Game DO

**Mục tiêu:** Game DO dùng `Room` hiện có mà vẫn giữ durable behavior đã harden.

**Files:** tạo/sửa `workers/room-storage.ts`, `workers/ott-game-server.ts`; có thể trích pure validator từ `partykit/room-storage.js`; sửa `room.js` chỉ nếu shared pure helper cần thiết; tạo `tests/ott-game-room.test.js`.

- [ ] Viết failing tests cho `Room` initial state chỉ được tạo từ trusted initialization; corrupt persisted state trả `Phòng không khả dụng`, không replacement room.
- [ ] Port schema: timestamp/clock/deadline integer non-negative; event ID strictly ascending; clone/validate trước assignment.
- [ ] Define a dedicated DO `Room` adapter before implementation: inject non-scheduling `schedule`/`cancel` so Worker path never creates `setTimeout`/timer handles; persist only validated serializable state after every mutation; rebuild connection association exclusively from authenticated `ott:attach`.
- [ ] Define mutation order and idempotency: mutate `Room` -> validate/persist snapshot + deadline metadata in DO storage -> set one earliest DO alarm -> publish response/state. On storage failure fail closed and do not broadcast an unpersisted authoritative result.
- [ ] Wire `onAlarm`: recompute earliest active clock/reconnect/waiting deadline; stale/duplicate alarm and terminal state are no-op; terminal does not reschedule; alarm survives DO hydration/restart.
- [ ] Test no Node timer callback can execute in Worker path; persisted connected seats -> reconnect grace after hydration -> resume before deadline; duplicate/stale alarms cannot mutate terminal/resumed room; waiting creator expiry -> terminal `disconnect_timeout` no winner -> unjoinable + Lobby cleanup.
- [ ] Test legal/invalid move, extinction/no-moves/goal, timeout, explicit leave, reconnect expiry, token isolation.
- [ ] Commit: `feat: persist authoritative ott rooms in game durable objects`.

**Done:** Room authority/persistence/alarm behavior equivalent hoặc stricter hơn current hardening, verified without direct client create.

### Task 6: Browser bootstrap và authoritative client session adapter

**Mục tiêu:** UI init PlayHTML một lần và chỉ gửi/nhận OTT qua public channel sau sync.

**Files:** sửa `playhtml-bootstrap.js`, `playhtml-game-client.js`, `game.js`, `index.html`, `playhtml-game.html`, `.env.example`, `README.md`; sửa/tạo `tests/playhtml-game-client.test.js` và page script-order test.

- [ ] Viết failing page test: bootstrap load trước game client/UI; no factory trước ready; factory registered exactly once sau `playhtml.configure({ host, room })`, `playhtml.init()` và `await playhtml.ready`.
- [ ] Browser control flow calls HTTPS allocation endpoint first, then receives public host, allocation-derived public room and its opaque attach/resume ticket. It never receives `OTT_INTERNAL_SECRET` or the internal initialization capability. Ticket only lives in local/session storage needed for reconnect, never URL/page data/presence/shared state/public list/log.
- [ ] Implement factory adapter `{ connect, send, on, close }` trên `createCustomMessageChannel`; `connect()` không tạo network transport. `close()` chỉ cleanup local subscription/session intent, không tạo fallback connection.
- [ ] Preserve/extend client tests: require `__ott`, valid state response, active-room correlation, revision/event ordering, malformed/cross-room ignore.
- [ ] Model intent: user create/join cancels pending auto-resume; leave then next game resets intentional-close; unavailable worker keeps online disabled but Local/AI usable.
- [ ] Connect flow: lobby allocation/join must return or select authorized allocation before PlayHTML init with mapped room. PlayHTML room identity is never treated as authorization.
- [ ] Run browser tests, local dev smoke and static script-order verification.
- [ ] Commit: `feat: connect ott client through verified playhtml channel`.

**Done:** one verified PlayHTML connection; online commands never use raw WebSocket/PartySocket/polling; client never writes authoritative game state to CRDT primitives.

### Task 7: Retire PartyKit production path safely

**Mục tiêu:** tránh hai online backends hoặc stale direct-create surface sau migration.

**Files:** sửa `partykit.json`, `package.json`, legacy PartyKit files/tests, `README.md`; tạo `tests/no-legacy-online-transport.test.js` nếu phù hợp.

- [ ] Viết failing regression check that production documentation/config points only at Worker deployment for online.
- [ ] Remove production scripts/config that deploy/run `partykit/ott-lobby.js` and `partykit/ott-room.js` as online authority, only after Task 6 focused tests pass.
- [ ] Keep reusable pure `Room`/rules test coverage. Delete or quarantine legacy test setup that requires direct client `ott:create`; do not weaken security checks to retain it.
- [ ] Verify no `new WebSocket`, `PartySocket`, polling, fake `OTT_PLAYHTML_CONNECTION_FACTORY`, or second PlayHTML initialization was introduced for OTT.
- [ ] Update all docs to state legacy PartyKit route retired; source-bound PlayHTML Worker is active only if later release gates pass.
- [ ] Commit: `refactor: retire legacy partykit online route`.

**Done:** one production online architecture; Local/AI static server path remains unaffected.

### Task 8: Runtime integration test

**Mục tiêu:** chứng minh Worker entry thật, không chỉ class unit test.

**Files:** tạo `tests/worker-runtime/**` hoặc `smoke-tests/ott/**`; update scripts in `package.json`.

- [ ] Start Wrangler local Worker with test-only secret injected through approved local env file ignored by Git.
- [ ] Test two actual PlayHTML browser clients connect to the same mapped room and reach `playhtml.ready`.
- [ ] Test same YProvider connection carries Yjs sync and OTT command; fork browser constructs no presence/cursor/awareness `PartySocket` or second socket from OTT client layer.
- [ ] Test normal YProvider initial sync succeeds before `ott:attach`; a pre-attach and post-attach client Yjs update neither persists nor changes another client.
- [ ] Test Lobby -> Game init accepted only with server-issued capability; copy exact browser-visible payload to direct Game endpoint must fail.
- [ ] Test create/list/join, legal/invalid move, revision ordering, explicit leave, disconnect/resume, reconnect expiry, timeout, restart/hydration and waiting expiry cleanup.
- [ ] Test source exposure: static server still rejects private path lower/mixed/uppercase; Worker does not expose secret/capability in response/log fixture.
- [ ] Record actual command/version/host/date/result in `docs/evidence/YYYY-MM-DD-ott-worker-runtime.md`.
- [ ] Commit: `test: cover authoritative ott worker runtime`.

**Done:** runtime test covers the actual Worker entry and browser channel, with no fake upstream adapter as acceptance evidence.

### Task 9: Two-profile manual acceptance

**Mục tiêu:** validate user-visible deployment flow independently of automated test isolation.

**Files:** create `docs/evidence/YYYY-MM-DD-ott-two-profile-acceptance.md`.

- [ ] Use two isolated browser profiles with separate storage/cookies/session; record Worker host and deployment revision.
- [ ] Record PASS/FAIL for: create, list, join, legal move, invalid move, goal/no-moves/extinction outcome where practical, timeout, explicit leave, disconnect/reload/resume before grace, reconnect expiry, waiting creator expiry, token isolation, Local/AI fallback.
- [ ] Confirm DevTools network: exactly one YProvider PlayHTML connection used for online game; fork browser has no presence/cursor/awareness `PartySocket`, raw OTT WebSocket or polling transport.
- [ ] Confirm no resume token, internal capability, secret, seat authority, authoritative clock or winner exists in PlayHTML shared data/presence/page data or public list.
- [ ] Mark every unrun scenario `NOT RUN`; do not infer PASS.
- [ ] Commit: `docs: record ott two profile acceptance`.

**Done:** all scenario evidence is explicit and reproducible.

### Task 10: Final verification and release decision

**Mục tiêu:** update rollout state only from evidence.

**Files:** sửa `IMPLEMENTATION_STATUS.md`, `HANDOFF.md`, `README.md`, `CLAUDE.md`, `docs/playhtml-upstream-lock.md`, `LUNA_IMPLEMENTATION_REPORT.md`.

- [ ] Run `npm test`, Worker typecheck/build, Worker runtime suite, `git diff --check`, static HTTP denylist test, and two-profile acceptance.
- [ ] Run `node --check` separately for each remaining JavaScript runtime file; use Bun/Wrangler typecheck for TypeScript Worker files.
- [ ] Update source pin to local fork commit/revision and exact vendored file list + license notice.
- [ ] State `PASS`, `BLOCKED`, or `NOT RUN` per gate with command/date/version/commit/host evidence.
- [ ] Keep online BLOCKED if any Worker runtime test, authority test, two-profile scenario, secret isolation test, or same-connection assertion is missing/failing.
- [ ] Only if every release gate below passes: mark online production ready and enable deployment documentation.

## 5. Hard safety rules

- Do not restore direct browser `ott:create`/`ott:list` to make a demo or test pass.
- Do not use `new WebSocket()`, `new PartySocket()`, polling, client relay, fake factory or a second PlayHTML session.
- Do not parse/intercept raw Yjs/PlayHTML transport frames. OTT begins only at reviewed `onCustomMessage`/public custom-channel boundary.
- Do not let unauthenticated or attached browser Yjs mutations become game/shared state. Game rooms keep their Yjs document read-only/unpersisted; only `Room` persistence is authoritative.
- Do not copy full upstream `party.ts` blindly. Every vendored dependency must be necessary, reviewed, pinned and recorded.
- Do not import upstream Supabase persistence/admin/shared-element bridge just because it exists; OTT has independent `Room` persistence.
- Do not expose `OTT_INTERNAL_SECRET`, capability MAC/signature, initialization capability, or resume token to page data, presence, CRDT, URL, public list, logs, browser config or error text.
- Do not treat PlayHTML room id as a permission, identity, seat, token or authority decision.
- Do not claim runtime/production pass from injected bridge tests, unit tests, or unrun acceptance scenarios.

## 6. Release gates

All are required before online rollout:

- [ ] Minimal fork is pinned to `4008c42b7d2c6157065afe0071d829dbc561af01` or explicitly reviewed successor; NOTICE/source manifest complete.
- [ ] Worker is self-contained for its selected scope and runs under Wrangler/Cloudflare DO local runtime without Supabase/control-plane dependencies.
- [ ] Browser public custom-message API is declared, tested and waits for `playhtml.ready`.
- [ ] Fork browser disables all presence/cursor/awareness transports; no `PartySocket` is constructed for OTT.
- [ ] PlayHTML/Yjs sync and OTT custom message run through one verified connection.
- [ ] OTT non-raw boundary preserves required upstream behavior and rejects malformed OTT without state mutation.
- [ ] YProvider initial sync before attach succeeds, while pre/post-attach client Yjs mutations are discarded and never persist/broadcast.
- [ ] Per-connection OTT rate limit of at least 40ms and payload limit 8KB are enforced before state mutation.
- [ ] Lobby-to-Game initialization is server-authenticated, room-bound, expiry-limited, replay-resistant and durable across restart.
- [ ] Browser cannot create game directly by copying a payload; no client relay/process-global map/forgeable marker exists.
- [ ] `Room` persistence, clock/alarm, reconnect grace, waiting expiry, corrupt-storage fail-closed and lifecycle cleanup pass in Game DO.
- [ ] Client validates envelope, room correlation and revision/event order; create/join/resume intent races are resolved.
- [ ] Static host private path denylist remains green including Windows case variants.
- [ ] Runtime suite and two-profile acceptance pass with evidence; Local/AI works without Worker online connection.

## 7. Phân công và dependency

| Phase | Owner | Depends on | Deliverable |
| --- | --- | --- | --- |
| 0. Baseline | Luna | None | pin/license/evidence, clean starting facts |
| 1. Minimal Worker | Worker/backend owner | Phase 0 | Yjs/PlayHTML local sync Worker |
| 2. Public channel | Fork/frontend owner | Phase 1 | declared same-connection custom-message API |
| 3. OTT bridge | Worker/backend owner | Phases 1-2 | validated `onCustomMessage` dispatch |
| 4. Trusted authority | Backend/security owner | Phase 1 | Lobby/Game DO capability boundary |
| 5. Room DO | Backend owner | Phases 3-4 | durable authoritative game room |
| 6. Browser integration | Frontend owner | Phases 2, 4, 5 | bootstrap/factory/UI authoritative flow |
| 7. Legacy retirement | Luna | Phase 6 focused green | one production online route |
| 8. Runtime automation | QA + owners | Phases 5-7 | real Worker/browser integration evidence |
| 9. Manual acceptance | Luna/QA | Phase 8 | two-profile evidence |
| 10. Release decision | Luna | Phase 9 | evidence-backed status only |

Tasks 3 and 4 may proceed in parallel after Task 1. Task 5 needs both. Task 6 needs Task 2 plus the authority mapping from Task 4 and a working Game DO from Task 5.

## 8. Reporting contract for Luna

Every task handoff/PR must include:

1. Task number, dependency status and exact source/fork revision.
2. Files changed, with copied upstream file origin if vendored.
3. Threat model assertion being tested.
4. TDD command, expected result and actual result.
5. Runtime evidence: command, host, date, Node/Bun/Wrangler/package versions, commit.
6. State `PASS`, `BLOCKED`, or `NOT RUN` only.
7. If blocked: exact missing API/runtime behavior, attempts made, and safe next action. No workaround that changes the authority boundary silently.

## 9. Immediate next action

Luna starts **Task 0**, then **Task 1**. The first technical milestone is intentionally narrow: a local Cloudflare Worker with a minimal reviewed PlayHTML/Yjs worker that syncs two browsers. Do not implement game lobby, factory registration, or release UX until this smoke is green and recorded.
