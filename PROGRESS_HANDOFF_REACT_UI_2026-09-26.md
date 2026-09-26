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

## Điểm dừng hiện tại — Task 10 đang dang dở

Subagent Task 10 đã bị dừng trước khi commit. Workspace hiện có các file **uncommitted/untracked**:

```text
apps/web/src/sessions/online/controlRequest.ts
apps/web/src/sessions/online/globals.d.ts
apps/web/src/sessions/online/normalizeOnlineState.ts
apps/web/src/sessions/online/OnlineLobbyGateway.ts
apps/web/src/sessions/online/runtimeBridge.ts
```

Chưa xác nhận hoàn chỉnh và chưa có commit cho:

- `OnlineSession.ts` và event-mapping tests.
- `controlRequest`, runtime bridge, lobby gateway tests.
- App/Lobby online create/list/join integration.
- authoritative revision ordering và display-only online clocks.
- one-room bootstrap invariant khi leave online.

Vì vậy không được coi các file online hiện tại là production-ready; phiên sau cần đọc/review chúng như work-in-progress trước khi stage.

## Còn lại theo plan

### Task 10 — online runtime/client

Hoàn thiện `OnlineSession`, test public event mapping (`open`, `close`, `reconnecting`, `resumed`, `joined`, `state`, `gameover`, `left`, `error`), stale revision/duplicate event filtering, move chỉ gọi `client.move`, và board chỉ đổi sau authoritative state mới.

Chạy guardrail bắt buộc:

```powershell
npm.cmd run test:web -- apps/web/src/sessions/online
npm.cmd run typecheck:web
npm.cmd run build:web
rg -n "new\s+(WebSocket|PartySocket)|polling|createPageData|can-play|presence|awareness|cursors" apps/web/src
```

### Task 11 — production static serving/browser tests

- Serve only `apps/web/dist` from `server.js`.
- Add retained `apps/web/static/playhtml-game.html` adapter diagnostic page.
- Migrate server/security/browser tests to React build and stable roles/test IDs.
- Run build, static boundary tests, and Playwright Worker/browser smoke tests.

### Task 12 — retire legacy UI

Chỉ sau parity verification mới xóa legacy UI/assets:

- `apps/web/src/legacy/game.js`
- `apps/web/public/index.html`
- `apps/web/public/style.css`
- `apps/web/public/tokens.css`
- obsolete PNG assets nếu không còn dùng

Cập nhật `README.md`, `CLAUDE.md`, `apps/web/README.md` với dev/build/test/typecheck/demo scenario/session boundaries và PlayHTML restrictions.

### Task 13 — polish và final verification

- Cross-screen accessibility tests.
- Desktop 1440×900 và 1280×720 polish.
- Responsive baseline dưới desktop breakpoint.
- Keyboard operation và reduced-motion verification.
- Full matrix: web build/typecheck/tests, Worker/game-core tests, server-security tests, browser tests, `git diff --check`.
- Request final code review trước khi merge.

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
3. Review các file `sessions/online/` đang untracked; không giả định đã hoàn tất.
4. Tiếp tục Task 10 bằng subagent mới theo TDD, sau đó spec review và quality review độc lập.
5. Chỉ commit khi focused tests, typecheck, build và transport guardrails pass.
6. Sau Task 10 mới chuyển sang Task 11–13; không xóa legacy UI sớm.

## Quyết định tại thời điểm pause

```text
React demo UI: COMPLETE
Lobby: COMPLETE
LocalSession/game-core bridge: COMPLETE
AiSession: COMPLETE
Online React session: IN PROGRESS / UNCOMMITTED
Production static migration: NOT STARTED
Legacy UI removal: NOT STARTED
Final accessibility/browser verification: NOT STARTED
```

