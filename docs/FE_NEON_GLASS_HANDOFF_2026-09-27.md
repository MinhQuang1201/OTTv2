# FE Neon Glass Upgrade Handoff

**Ngày:** 2026-09-27  
**Branch:** `frontend/game`  
**Kế hoạch nguồn:** `docs/superpowers/plans/2026-09-26-neon-glass-frontend-upgrade.md`  
**Trạng thái:** Visual chính đã triển khai; Task 7 chưa hoàn tất.

## Mục Tiêu

Chuyển React FE sang visual language neon-glass dựa trên `stitch_neon_glass_chess_ui/`, nhưng giữ React/Vite, CSS Modules, session contracts, accessibility và online authority.

Không migrate sang Tailwind.

## Đã Hoàn Thành

### Theme foundation

Đã cập nhật `apps/web/index.html`, `src/shared/theme/tokens.css`, `global.css`, `src/shared/ui/ui.module.css` và `src/app/app.module.css`:

- Font Space Grotesk, Plus Jakarta Sans, JetBrains Mono.
- Void background, cyan/magenta/amber palette, glass surfaces, borders, glows và motion tokens.
- Shared Button, Input, Panel, Dialog, Badge, Toast theo neon-glass.
- Focus-visible và reduced-motion vẫn được giữ.

### Lobby

Đã restyle `apps/web/src/features/lobby/lobby.module.css`:

- Lobby hai cột desktop và responsive mobile.
- Decorative mini-board.
- Neon glass panels và CTA.
- Honest online availability styling.
- Waiting room có `data-testid="room-list"` ổn định.

Logic không đổi: local/AI vẫn hoạt động khi online unavailable; room id vẫn trim/validate; room full/unavailable vẫn disabled.

### Game HUD

Đã cập nhật `game.module.css`, `PlayerPanel.tsx`, `GameScreen.test.tsx` và các accessibility hooks liên quan:

- Top bar glass, seat A/B cards, active turn glow, clock warning, tactical counts và history rail.
- Player counts hiển thị glyph Đấm/Lá/Kéo cùng dữ liệu snapshot.
- Responsive desktop/tablet/mobile layout.
- Không thêm ELO, avatar, ping, capture inventory, reserve actions hoặc mock controls.

### Board and pieces

Board tiếp tục có explicit:

```css
grid-template-columns: repeat(9, minmax(0, 1fr));
grid-template-rows: repeat(9, minmax(0, 1fr));
```

Đã thêm neon goal/selected/legal/focus states, piece A/B radial glow và reduced-motion handling. Không sửa luật hoặc `useBoardSelection`.

### Result dialog

Đã cập nhật `ResultDialog.tsx` và `result.module.css`:

- Derive local `outcome`: `win`, `loss`, `neutral`.
- Thêm `data-testid="result-dialog-outcome"` và `data-outcome`.
- Chỉ dùng result/viewer/player names hiện có.
- Không thêm ELO, rematch, analysis, PGN hoặc metrics.

## Test Đã Pass

```text
npm run test:web
21 test files passed
128 tests passed

npm run typecheck:web
passed

npm run build:web
passed
```

Focused tests cho shared UI, lobby, game HUD, board, accessibility, result, app và scenarios đều pass.

## Commit Đã Tạo

```text
c227c67 test: define neon UI contracts
b2f9fde feat: add neon glass theme foundation
50c4577 feat: restyle neon glass lobby
d122629 feat: restyle tactical game HUD
d7618b8 feat: add neon tactical board styling
fc094fa feat: add neon result dialog
```

## Việc Chưa Hoàn Thành

### 1. Task 7 chưa hoàn tất

Chưa hoàn tất:

- Manual inspection toàn bộ demo matrix.
- Playwright geometry smoke ở `1910x906`, `1080x900`, `390x844`.
- Xác nhận 81 cells, board/cell square trong sai số 1px, không overflow và không console/page errors.

### 2. Playwright geometry smoke bị timeout

Script tạm nằm ngoài repo:

`C:\Users\ADMIN\AppData\Local\Temp\opencode\test-geometry.cjs`

Script đã thử spawn Vite bằng `npm` và `npm.cmd`, nhưng timeout chờ port `5199`. Cần tiếp tục bằng cách chạy server thủ công ở terminal riêng:

```powershell
npm.cmd run dev:web -- --port 5199
```

Sau đó chạy Playwright one-off với `require("D:\\Work\\Study\\OTTv2\\node_modules\\playwright")`.

Demo query chỉ hoạt động trong Vite dev mode vì `useDemoScenario.ts` kiểm tra `import.meta.env.DEV`; không dùng `npm start` cho `?demo=...`.

### 3. Một thay đổi FE chưa commit

Hiện còn:

```text
M apps/web/src/features/game/GameScreen.tsx
```

Thay đổi xóa hidden text bị mojibake `BÃ n chÆ¡i`, tránh duplicate/malformed accessible heading. Cần chạy:

```powershell
npm.cmd run test:web -- --run src/accessibility/cross-screen.accessibility.test.tsx src/features/game/GameScreen.test.tsx
rtk git add apps/web/src/features/game/GameScreen.tsx
rtk git commit -m "fix: remove malformed hidden game heading"
```

### 4. Full repository `npm test` đang fail

Lần chạy gần nhất:

```text
163 passed
18 failed
3 skipped
```

Failures nằm ở Worker/PartyKit harness, không nằm trong các file visual migration:

- `tests/worker-test-harness-runtime.test.js`: `/__test/initialize` trả 400; inspect response có thêm `attachNonce: false` nhưng assertions cũ không mong field này.
- `tests/partykit-room.test.js`: một số clock hydration/alarm/reconnect assertions fail.
- `tests/partykit-runtime.test.js`: một số lobby create không initialize allocated game party theo expectation.

Không trộn sửa các lỗi này vào visual migration nếu chưa mở task Worker/PartyKit riêng.

### 5. Review tự động nêu issue ngoài scope

- `OnlineSession` có thể thiếu `controlRequest` cho reconnect auto-resume.
- Waiting-room listing có thể stale khi quay lại lobby.
- Hidden heading mojibake đã xử lý bằng thay đổi chưa commit ở trên.
- Worker test harness contract mismatch.

Hai issue đầu là logic/session, cần task riêng.

## Worktree Cảnh Báo

Worktree đã dirty trước migration với nhiều modified/deleted/untracked files liên quan repository reorganization, Worker/PartyKit và docs. Không revert các file đó.

Trước khi tiếp tục:

```powershell
rtk git status --short
rtk git log --oneline -10
```

## Thứ Tự Tiếp Tục

1. Chạy focused test cho `GameScreen.tsx` và commit encoding fix.
2. Khởi động Vite dev server thủ công bằng `npm.cmd run dev:web -- --port 5199`.
3. Chạy Playwright geometry smoke trên `?demo=game-active-a` ở 3 viewport.
4. Kiểm tra toàn bộ demo matrix.
5. Chạy lại `npm.cmd run test:web`, `npm.cmd run typecheck:web`, `npm.cmd run build:web`.
6. Chỉ claim visual migration hoàn tất sau khi geometry smoke pass.
7. Không claim full repository xanh cho tới khi Worker/PartyKit failures được xử lý riêng.

## Ranh Giới Bắt Buộc

- Không thêm Tailwind CDN/dependency, Lucide/Material Symbols CDN hoặc raw Stitch HTML.
- Không thêm mock button cho tính năng chưa có logic.
- Không sửa `GameSnapshot`, `GameSession`, Worker authority hoặc online transport cho visual-only request.
- Không mutate online board state sau click; chờ authoritative snapshot.
- Không giảm board từ 81 accessible buttons.
