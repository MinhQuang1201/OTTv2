# React Game UI Redesign — Progress Handoff

**Ngày:** 2026-09-26  
**Workspace:** `D:\Work\Study\OTTv2`  
**Branch:** `frontend/game`  
**Trạng thái:** Tạm dừng theo yêu cầu người dùng

## Mục tiêu và tài liệu nguồn

Implementation đang bám theo:

- Design spec: `docs/superpowers/specs/2026-09-26-react-game-ui-redesign-design.md`
- Implementation plan: `docs/superpowers/plans/2026-09-26-react-game-ui-redesign.md`

Kiến trúc đã chọn: React/Vite/TypeScript, demo-first, desktop-first; UI chỉ phụ thuộc `GameSession` contract. PlayHTML chỉ được giữ làm transport online phía sau `OnlineSession`, không dùng `@playhtml/react`, `PlayProvider`, collaborative page state, polling, presence, awareness, cursor hoặc socket thứ hai.

## Đã hoàn tất và đã commit

### Tasks 1–5: nền tảng, contract, demo, primitives, app shell

- `c9bda5f` — React/Vite/Vitest toolchain.
- `c83d551` — ignore `apps/web/dist`.
- `2f20b32` — normalized game model/session contract.
- `bd54925`, `ebc5b0d`, `376a5d3`, `78790af` — deterministic `DemoSession` và toàn bộ demo scenarios.
- `d03e7f5`, `0cd1996`, `97077c9`, `f441f1a` — theme tokens, primitives, icons, dialog/toast accessibility.
- `9bafc77`, `ccda3e8`, `64cfe2c`, `351df82` — app lifecycle, demo routing, error boundary, stale-session/generation hardening.

Task 5 đã được spec review ✅ và quality review APPROVE.

### Task 6: Lobby

- `4093761` — Lobby components, online room panel, waiting-room states, player-name storage.
- `f3bf5fe` — disable waiting-room actions khi online đang connecting/unavailable.

Task 6 đã được spec review ✅ và quality review APPROVE.

### Task 7: interactive demo UI

- `818593f` — 9×9 board, accessible cells, HUD, players/clocks/counts, side rail, result dialog, leave dialog, ToastRegion integration, demo UI wiring.
- `859ba39` — connecting scenario dùng production LobbyScreen, event animation queue xử lý mọi visual event mới, online leave quay lại lobby, Board test assert `getLegalMoves({x: 0, y: 2})`.

Task 7 đã được spec review ✅ và quality review APPROVE.

### Task 8: canonical game-core bridge và LocalSession

- `82a56f8` — `gameCoreBridge`, state normalization, `LocalSession`, injected clock/timer tests, App local-mode wiring.
- `047f9dd` — idle initial snapshot, deep-frozen error snapshot, clear timer ngay khi terminal move.

Bridge duy nhất tới `OTT_CONFIG`, `OTT_RULES`, `OTT_AI` là `apps/web/src/sessions/core/gameCoreBridge.ts`. UI components không import game-core.

Task 8 đã được spec review ✅ và quality review APPROVE.

### Task 9: AiSession

- `1795312` — `AiSession` composition trên `LocalSession`, injected scheduler/chooser, AI thinking/pending state, dispose/leave cancellation, App AI wiring.
- `98381b4` — hỗ trợ `humanSeat: "B"` bằng cách schedule AI opening turn và thêm regression test.

Task 9 đã được spec review ✅ và quality review APPROVE.

## Verification evidence gần nhất

Sau Task 9:

```text
npm.cmd run test:web       -> 15 test files, 108 tests passed
npm.cmd run typecheck:web  -> passed
npm.cmd run build:web      -> passed
```

Các review độc lập cũng đã xác nhận:

- Task 7 focused tests: 25/25 pass; full web suite 96/96 pass.
- Task 8 core/local tests: 6/6 pass; game-core Node tests: 33/33 pass.
- Task 9 AI tests: 5/5 pass; full web suite 108/108 pass.

`git diff --check` đã pass ở các checkpoint đã commit.

## Trạng thái sau session 2026-09-26

Task 10–13 đã được triển khai trong workspace hiện tại. Các thay đổi vẫn **chưa được commit** vì workspace chứa nhiều thay đổi repository-organization/Worker migration ngoài phạm vi React UI. Không reset, checkout, clean hoặc stage toàn bộ workspace.

### Task 10 — online runtime/client ✅

Đã hoàn tất:

- `OnlineSession` với public event mapping cho `open`, `close`, `reconnecting`, `resumed`, `joined`, `state`, `gameover`, `left`, `error`.
- Lọc authoritative revision cũ/trùng và event ID trùng.
- `move` chỉ gọi `client.move(from, to)`; board không optimistic update.
- Display-only online clock ticks; snapshot authoritative tiếp theo thay thế estimate.
- `controlRequest`, `runtimeBridge`, `OnlineLobbyGateway` và tests.
- App/Lobby online create/list/join integration.
- Giữ one-room PlayHTML bootstrap invariant.

Các file online hiện tại đã được test và có thể tiếp tục review như implementation hoàn chỉnh, không còn là WIP chưa xác nhận:

```text
apps/web/src/sessions/online/controlRequest.ts
apps/web/src/sessions/online/globals.d.ts
apps/web/src/sessions/online/normalizeOnlineState.ts
apps/web/src/sessions/online/OnlineLobbyGateway.ts
apps/web/src/sessions/online/runtimeBridge.ts
```

### Task 11 — production static serving/browser tests ✅

- `server.js` chỉ phục vụ production build từ `apps/web/dist`.
- Giữ adapter diagnostic tại `apps/web/static/playhtml-game.html`.
- Server/security/browser tests dùng React build và stable roles/test IDs.
- Static boundary tests và two-profile Worker/browser smoke đã pass.

### Task 12 — retire legacy UI ✅

Đã parity-check trước khi xóa:

- `apps/web/src/legacy/game.js`
- `apps/web/public/index.html`
- `apps/web/public/style.css`
- `apps/web/public/tokens.css`
- `apps/web/public/assets/dam.png`
- `apps/web/public/assets/la.png`
- `apps/web/public/assets/keo.png`

Giữ `apps/web/static/playhtml-game.html` và `apps/web/public/assets/match.jpg` theo mục đích diagnostic/design reference. Đã xóa các legacy tests parse `legacy/game.js`. Đã cập nhật `README.md`, `CLAUDE.md`, `apps/web/README.md` và `CONFIG.md`.

### Task 13 — polish và final verification ✅

- Thêm `apps/web/src/accessibility/cross-screen.accessibility.test.tsx`.
- Kiểm tra landmarks, headings, form labels, live status, dialog focus, keyboard board và đủ 81 ô.
- Hoàn tất desktop width/polish cho 1440×900 và 1280×720.
- Responsive baseline: side rail collapse, player panels stack, board fill width dưới breakpoint.
- Reduced-motion rules và keyboard behavior đã được xác nhận.
- Sửa module detection của `packages/game-core/src/config.js`, `rules.js`, `ai.js` để Node/Vite/Wrangler bundle dùng đúng dependency path.

## Verification evidence sau session

Đã chạy lại các lệnh sau:

```text
npm.cmd run test:web                         -> 20 test files, 124 tests passed
npm.cmd run typecheck:web                    -> passed
npm.cmd run build:web                        -> passed
npm.cmd run build:playhtml-browser           -> passed
npm.cmd run test:browser-worker-runtime      -> passed
                                             -> 2 isolated profiles, 1 YProvider socket/profile,
                                                authoritative move propagation passed
node --test server/boundary focused suites   -> 14/14 passed
git diff --check                             -> passed
```

Guardrail scan trong `apps/web/src` không tìm thấy transport/state path cấm: WebSocket/PartySocket fallback, polling, page data, `can-play`, presence, awareness hoặc cursors.

### Node suite còn lỗi baseline ngoài React UI

`npm.cmd test` hiện chạy 184 tests, trong đó **163 passed, 18 failed, 3 skipped**. Các lỗi còn lại nằm ở dirty repository-organization/Worker migration, không thuộc các file React Task 10–13:

- PartyKit legacy room hydration/runtime contract.
- `worker-test-harness` contract cũ lệch schema `attachNonce`.
- Một test-only Worker initialize dùng room ID không khớp contract hiện tại.

Không được ghi nhận `npm.cmd test` là pass cho tới khi migration baseline này được xử lý riêng. Browser Worker runtime chính và two-profile smoke hiện đã pass sau khi sửa module bridge.

## Workspace caveat — thay đổi cũ không thuộc UI task

Workspace vốn đã dirty từ repository-organization/Worker migration trước khi React work bắt đầu. Không reset, checkout hoặc clean broad paths. Các nhóm dirty/untracked lớn gồm:

- legacy root files và `partykit/`, `workers/`, `tests/`.
- `apps/`, `packages/`, `appsweb/` và tài liệu organization.
- `CLAUDE.md`, `README.md`, `package.json` và các file migration khác.
- file cũ `PROGRESS_HANDOFF_2026-09-26.md` là handoff cho Worker/PlayHTML rollout, không phải handoff React này.

Chỉ stage file thuộc task đang làm; tuyệt đối không stage toàn bộ workspace bằng `git add .`.

## Cách tiếp tục ở phiên sau

1. Đọc file này và implementation plan trước.
2. Kiểm tra `git status --short` và giữ nguyên dirty changes ngoài phạm vi.
3. Không xóa hoặc reset các thay đổi migration/Worker hiện có.
4. Nếu tiếp tục React UI, bắt đầu từ focused feature/session tests và giữ các boundary đã xác nhận.
5. Nếu cần full green repository, xử lý riêng 18 lỗi `npm.cmd test` thuộc PartyKit/Worker migration; không trộn vào React UI task.
6. Trước khi commit, stage explicit paths của React/UI task; tuyệt đối không dùng `git add .`.

## Quyết định tại thời điểm pause

```text
React demo UI: COMPLETE
Lobby: COMPLETE
LocalSession/game-core bridge: COMPLETE
AiSession: COMPLETE
Online React session: COMPLETE / UNCOMMITTED
Production static migration: COMPLETE / UNCOMMITTED
Legacy UI removal: COMPLETE / UNCOMMITTED
Final accessibility/browser verification: COMPLETE
React web verification: PASS
Browser Worker smoke: PASS
Full npm test: BLOCKED BY PRE-EXISTING MIGRATION BASELINE FAILURES
```
