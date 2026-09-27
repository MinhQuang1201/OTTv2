# Neon Glass Frontend Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-theme the working React application as a responsive neon-glass tactical arena while preserving its session contract, game authority boundaries, accessibility, and all supported local/AI/online flows.

**Architecture:** Treat the Stitch HTML screens as visual references only. Keep Vite, React, CSS Modules, shared CSS tokens, `GameSession`, and `GameSnapshot`; translate approved static visual patterns into the existing theme, shared primitives, lobby, game, and result feature modules. No game/session fields, Worker messages, or transport paths are added because every retained visual datum already exists in the current snapshot or component state.

**Tech Stack:** React 18, TypeScript, Vite, CSS Modules, CSS custom properties, Vitest, React Testing Library, Playwright for visual/browser verification.

---

## Scope Decision

### Retain and implement from Stitch

- Deep void background with restrained cyan/magenta ambient gradients and a subtle tactical grid.
- Liquid-glass panel treatment: translucent dark surfaces, hairline borders, mild backdrop blur, internal highlight, focused neon glow.
- Neon cyan for Seat B and neon magenta for Seat A while retaining color-independent labels and status text.
- Space Grotesk headings, Plus Jakarta Sans body copy, JetBrains Mono clocks/coordinates/data, with system fallbacks.
- Two-column lobby, board-preview illustration, clear local/AI actions, real online availability state and waiting room list.
- Desktop tactical table: compact match bar, seat cards, square 9 x 9 board, coordinate gutters, move-history rail.
- Distinct but semantic board states: goal, selected piece, legal destination, disabled input, active player, low clock, reconnecting and AI thinking.
- A focused result dialog whose victory/defeat visual treatment comes only from `GameResultView` and `viewerSeat`.
- Responsive layouts that retain a square board and keyboard-operable cells on tablet/mobile.

### Explicitly remove from the mockups

Do not render, stub, or attach no-op buttons for these mockup-only elements:

- Rating/ELO, rank, avatar images, win rate, match score/round, player ping, frame rate, server verification and security codes.
- Audio, language switching, rules modal, 2D/3D view, Zen mode, settings, board flip, sharing and broadcast controls.
- Offer draw, undo request, resign button separate from existing leave behavior, rematch, matchmaking, review/analysis, tactical tips, mini analysis board, AI evaluation, PGN export and match metrics.
- Capture inventory, reserve-piece buttons, tactical advantage counters and highlighted capture paths that claim information not represented by the current snapshot.
- In-game chat, reactions, spectator count, spectator UI, tournament/broadcast UI and live commentary.
- Hardcoded board positions, hardcoded names/room ids, emoji pieces and external avatar URLs.

These features need independent product decisions, model/session contracts, authority design, persistence/transport evidence and tests. They are not part of a visual upgrade.

## Current File Structure and Planned Changes

### Modify

- `apps/web/index.html`: replace the current single-font import with preconnect/font loading for Space Grotesk, Plus Jakarta Sans and JetBrains Mono; retain viewport, root and Vite entry semantics.
- `apps/web/src/shared/theme/tokens.css`: replace graphite tokens with the semantic neon-glass palette, typography, ambient/background, glass, board, interaction, motion and z-index tokens.
- `apps/web/src/shared/theme/global.css`: add the global arena background/grid and global selection/scrollbar behavior; avoid placing feature layout here.
- `apps/web/src/shared/ui/ui.module.css`: restyle shared primitives as consistent glass controls, panels, badges, fields, dialogs, toasts and focus rings.
- `apps/web/src/app/app.module.css`: refine app shell/brand/header/content width for the new visual system.
- `apps/web/src/features/lobby/LobbyScreen.tsx`: retain callbacks and input semantics but update markup only where required for the approved layout/visual hooks.
- `apps/web/src/features/lobby/ModeCard.tsx`: add explicit visual variants/classes needed for same-device and AI actions without changing callbacks.
- `apps/web/src/features/lobby/OnlineRoomPanel.tsx`: retain availability/disabled behavior; provide visual hooks for the truthful status panel and room controls.
- `apps/web/src/features/lobby/WaitingRoomList.tsx`: add visual hooks for loading, empty, unavailable, error and populated rows while retaining button behavior.
- `apps/web/src/features/lobby/lobby.module.css`: replace current lobby presentation and create a decorative, noninteractive board preview using existing markup.
- `apps/web/src/features/game/GameTopBar.tsx`: retain room id, connection state and leave action; remove any mockup-only controls from the intended layout and add a derived status presentation hook.
- `apps/web/src/features/game/PlayerPanel.tsx`: restyle existing player data only: seat, name, connected state, viewer state, clock, three type counts, and active turn.
- `apps/web/src/features/game/Board.tsx`: preserve the 81-cell renderer and selection contract; add only noninteractive wrappers/classes needed for neon board frame and coordinates.
- `apps/web/src/features/game/BoardCell.tsx`: preserve its accessible label/data attributes and click behavior; add CSS state hooks for selected/legal/goal/occupied/disabled visuals without adding game logic.
- `apps/web/src/features/game/Piece.tsx`: preserve local SVG `PieceIcon`; add seat/type state classes for neon-glass pieces without emoji or remote icons.
- `apps/web/src/features/game/TurnStatus.tsx`: refine copy/markup styling hooks while preserving its state mapping and live-region behavior.
- `apps/web/src/features/game/MoveHistory.tsx`: preserve events as input and add list/empty-state styling hooks; do not derive analytics from events.
- `apps/web/src/features/game/GameScreen.tsx`: preserve session subscription, leave confirmation, toast errors, event queue and result wiring; rearrange only the presentational wrappers if needed for responsive arena composition.
- `apps/web/src/features/game/game.module.css`: replace game table visual styling, using explicit `grid-template-columns` and `grid-template-rows` for the 9 x 9 board plus responsive rules.
- `apps/web/src/features/result/ResultDialog.tsx`: retain `result`, `viewerSeat`, names, close/lobby actions; add semantic win/loss data hook and compact participant summary based only on existing values.
- `apps/web/src/features/result/result.module.css`: make the dialog visually distinct for win/loss/reason while preserving focus/dialog behavior from the shared Dialog.
- Existing component tests under `apps/web/src/features/`, `apps/web/src/shared/ui/`, `apps/web/src/accessibility/`, and `apps/web/src/app/`: adjust only where markup changes affect public accessibility assertions.

### Create

- `apps/web/src/features/result/ResultDialog.visual.test.tsx`: verifies win/loss visual state derives only from result/viewer data and the two existing actions remain available.

### Do not modify

- `apps/web/src/shared/model/game.ts`, `apps/web/src/sessions/contract.ts`, `apps/web/src/sessions/local/`, `apps/web/src/sessions/ai/`, and `apps/web/src/sessions/online/` for this visual-only upgrade.
- `packages/game-core/`, `packages/game-client/`, `apps/worker/`, PlayHTML runtime configuration, Worker protocol, and authoritative Room logic.
- `stitch_neon_glass_chess_ui/**`; it is source reference material, not runtime application code.

## Task 1: Establish Visual Scope Tests Before Styling

**Files:**
- Modify: `apps/web/src/features/game/Board.test.tsx`
- Modify: `apps/web/src/features/result/ResultDialog.test.tsx`
- Create: `apps/web/src/features/result/ResultDialog.visual.test.tsx`
- Modify: `apps/web/src/accessibility/cross-screen.accessibility.test.tsx`

- [ ] **Step 1: Review and retain the existing board interaction contract.**

`BoardCell` already has CSS Module state hooks for goals, selection, legal moves and pieces. Do not add unstable CSS-name assertions merely to support the restyle. Confirm `Board.test.tsx` continues to cover 81 coordinate-aware buttons, legal selection and disabled input, then reserve visual geometry for browser verification in Task 7.

- [ ] **Step 2: Add a failing result visual contract test.**

Render a win and a loss from real `GameResultView` fixtures. Assert the dialog exposes a semantic visual hook such as `data-outcome="win"`/`"loss"`, retains `Xem bàn` and `Về sảnh`, and does not render unavailable actions such as rematch, ELO or analysis.

- [ ] **Step 3: Run the focused result test and confirm it fails.**

Run: `rtk npm run test:web -- --run src/features/result/ResultDialog.visual.test.tsx`

Expected: FAIL because the dialog lacks the new outcome hook.

- [ ] **Step 4: Extend cross-screen accessibility assertions.**

Keep current role/name assertions and add checks that the lobby/game/result still expose the real controls after markup changes. Do not change game-state behavior in these tests.

- [ ] **Step 5: Commit the red test and preserved contracts.**

```powershell
rtk git add apps/web/src/features/game/Board.test.tsx apps/web/src/features/result/ResultDialog.test.tsx apps/web/src/features/result/ResultDialog.visual.test.tsx apps/web/src/accessibility/cross-screen.accessibility.test.tsx
rtk git commit -m "test: define neon UI contracts"
```

## Task 2: Build the Shared Neon-Glass Theme Foundation

**Files:**
- Modify: `apps/web/index.html`
- Modify: `apps/web/src/shared/theme/tokens.css`
- Modify: `apps/web/src/shared/theme/global.css`
- Modify: `apps/web/src/shared/ui/ui.module.css`
- Modify: `apps/web/src/app/app.module.css`
- Test: `apps/web/src/shared/ui/ui.test.tsx`

- [ ] **Step 1: Add a failing shared UI assertion where appearance changes affect semantics.**

Only add tests for public behavior that needs preserving, such as disabled buttons, field errors, dialog close labels and visible focus behavior. Do not test colors or individual CSS declarations in jsdom.

- [ ] **Step 2: Run the focused shared UI test and confirm the intended assertion fails.**

Run: `rtk npm run test:web -- --run src/shared/ui/ui.test.tsx`

Expected: FAIL only for the newly added contract, if any is necessary.

- [ ] **Step 3: Replace theme tokens with semantic neon-glass tokens.**

Keep every consumer-facing token semantic. Add tokens for:

```css
--ui-canvas: #050811;
--ui-surface-0: rgb(10 14 24 / 88%);
--ui-surface-1: rgb(15 19 29 / 72%);
--ui-glass-border: rgb(223 242 255 / 12%);
--ui-seat-a: #ff4b89;
--ui-seat-b: #00dbe9;
--ui-amber: #ffba20;
--ui-board-light: rgb(23 32 52 / 92%);
--ui-board-dark: rgb(14 22 38 / 94%);
--ui-font-display: "Space Grotesk", "Segoe UI", sans-serif;
--ui-font-body: "Plus Jakarta Sans", "Segoe UI", sans-serif;
--ui-font-mono: "JetBrains Mono", "Cascadia Mono", ui-monospace, monospace;
```

Also define a small, shared glass shadow, seat glows, focus ring, reduced-motion-safe durations, and keep existing token names where practical to minimize churn. Do not copy Tailwind config values or utility classes into runtime code.

- [ ] **Step 4: Load fonts through `apps/web/index.html`.**

Use Google Fonts preconnect and a single stylesheet request for the three approved families. Ensure body text continues to have system fallbacks when the request fails. Do not add Lucide, Material Symbols, Tailwind CDN scripts or remote image assets.

- [ ] **Step 5: Apply global arena background only in `global.css`.**

Use a low-contrast fixed radial wash plus a faint CSS gradient grid. Keep it noninteractive and avoid expensive full-screen animated filters. Apply `font-family: var(--ui-font-body)` globally, use display and mono tokens only from component CSS.

- [ ] **Step 6: Restyle shared primitives without changing their public props.**

`ui.module.css` should define the consistent glass-panel/control vocabulary. Keep clear disabled contrast, keyboard focus outline, error text, dialog backdrop, close button and reduced-motion behavior. Make primary CTA cyan; make destructive/leave actions magenta/red only where the component already declares a semantic destructive state.

- [ ] **Step 7: Restyle the app shell and verify global CSS is not carrying feature layout.**

Update header/content width, visual brand treatment and padding in `app.module.css`. Keep lobby/game layout in their feature CSS modules.

- [ ] **Step 8: Run the focused shared UI tests.**

Run: `rtk npm run test:web -- --run src/shared/ui/ui.test.tsx`

Expected: PASS.

- [ ] **Step 9: Commit the theme foundation.**

```powershell
rtk git add apps/web/index.html apps/web/src/shared/theme/tokens.css apps/web/src/shared/theme/global.css apps/web/src/shared/ui/ui.module.css apps/web/src/app/app.module.css apps/web/src/shared/ui/ui.test.tsx
rtk git commit -m "feat: add neon glass theme foundation"
```

## Task 3: Rebuild the Lobby as a Real Neon-Glass Entry Screen

**Files:**
- Modify: `apps/web/src/features/lobby/LobbyScreen.tsx`
- Modify: `apps/web/src/features/lobby/ModeCard.tsx`
- Modify: `apps/web/src/features/lobby/OnlineRoomPanel.tsx`
- Modify: `apps/web/src/features/lobby/WaitingRoomList.tsx`
- Modify: `apps/web/src/features/lobby/lobby.module.css`
- Test: `apps/web/src/features/lobby/LobbyScreen.test.tsx`
- Test: `apps/web/src/features/lobby/OnlineRoomPanel.test.tsx`

- [ ] **Step 1: Add failing tests for preserved lobby actions.**

Verify the styled quick-play cards still invoke `onStartLocal` and `onStartAi` with trimmed names. Verify online remains disabled when unavailable and waiting room selection still invokes `onJoin` with the selected room id. Keep selectors role/name based.

- [ ] **Step 2: Run lobby-focused tests and confirm the new tests fail.**

Run: `rtk npm run test:web -- --run src/features/lobby/LobbyScreen.test.tsx src/features/lobby/OnlineRoomPanel.test.tsx`

Expected: FAIL only for any new markup-dependent contracts.

- [ ] **Step 3: Adapt lobby markup minimally.**

Retain `LobbyScreen` callbacks and local name storage. Add presentation-only wrappers/classes for a compact brand lockup, rule loop, decorative mini-board and labelled action cards. The mini-board remains `aria-hidden`; it must not expose 81 duplicate keyboard targets.

- [ ] **Step 4: Restyle local/AI controls through existing components.**

Keep `ModeCard` actions as actual buttons. Use visual variants to make AI the prominent cyan CTA and same-device play the secondary glass action. Do not add AI difficulty, sound, language, help or matchmaking controls.

- [ ] **Step 5: Restyle the online panel using real availability.**

Map `online`, `connecting`, and `unavailable` to color, icon-like CSS dot and truthful copy already present in `OnlineRoomPanel`. Preserve disabled `Tạo phòng`/`Vào phòng` controls when unavailable. Do not show fake player counts, online status, rooms or network telemetry.

- [ ] **Step 6: Implement responsive lobby CSS.**

Use a two-column composition on wide displays, collapse cleanly to one column, preserve readable input/CTA sizes, and limit the visual board preview independently from the playable board.

- [ ] **Step 7: Run focused lobby tests.**

Run: `rtk npm run test:web -- --run src/features/lobby/LobbyScreen.test.tsx src/features/lobby/OnlineRoomPanel.test.tsx`

Expected: PASS.

- [ ] **Step 8: Commit the lobby upgrade.**

```powershell
rtk git add apps/web/src/features/lobby/LobbyScreen.tsx apps/web/src/features/lobby/ModeCard.tsx apps/web/src/features/lobby/OnlineRoomPanel.tsx apps/web/src/features/lobby/WaitingRoomList.tsx apps/web/src/features/lobby/lobby.module.css apps/web/src/features/lobby/LobbyScreen.test.tsx apps/web/src/features/lobby/OnlineRoomPanel.test.tsx
rtk git commit -m "feat: restyle neon glass lobby"
```

## Task 4: Upgrade the Game HUD and Player Information Without New Data

**Files:**
- Modify: `apps/web/src/features/game/GameScreen.tsx`
- Modify: `apps/web/src/features/game/GameTopBar.tsx`
- Modify: `apps/web/src/features/game/PlayerPanel.tsx`
- Modify: `apps/web/src/features/game/TurnStatus.tsx`
- Modify: `apps/web/src/features/game/MoveHistory.tsx`
- Modify: `apps/web/src/features/game/game.module.css`
- Test: `apps/web/src/features/game/GameScreen.test.tsx`

- [ ] **Step 1: Add failing tests for real HUD values and no unavailable actions.**

Assert a game renders `Phòng {roomId}` when snapshot `roomId` exists and `Chơi trên thiết bị` when it is null, alongside connection status, both player names, clocks, current-turn state and move-history region. Assert the top bar contains the existing `Rời bàn` action and not mockup-only controls such as `Xin hòa`, `2D / 3D`, `Cài đặt`, `Xin lùi nước`, or `Đầu hàng`. Do not add a synthetic device/mode label field to `GameSnapshot`.

- [ ] **Step 2: Run the focused game screen test and confirm it fails.**

Run: `rtk npm run test:web -- --run src/features/game/GameScreen.test.tsx`

Expected: FAIL for the new exclusion/presentation assertions until the markup is finalized.

- [ ] **Step 3: Restructure presentational wrappers only.**

Keep `GameScreen`'s subscription, active snapshot fallback, event queue, leave flow, toast dispatch and result dialog untouched. Arrange existing components into a compact tactical match bar, left seat stack, central board column and right history rail. The rail remains `MoveHistory` only.

- [ ] **Step 4: Restyle the top bar from existing values.**

Use `roomId` and `connection` only. Keep the connection label/badge and leave button. It may include a purely decorative logo mark, but no button or datum lacking implementation.

- [ ] **Step 5: Restyle player cards using existing `PlayerView`.**

Show seat, name, viewer/opponent label, connected state, clock, type counts and active indicator. Keep counts as noninteractive information. Do not introduce rating, avatars, ping, captives, reserve selection or tactical action buttons.

- [ ] **Step 6: Restyle turn status and history.**

Use `TurnStatus` state mapping for truth. Make `MoveHistory` scroll within the rail at desktop but keep it naturally sized/mobile readable. Continue rendering only normalized event fields, including the existing event-id display; do not infer chess-style paired turns, game quality, captures by type, or tactical advice.

- [ ] **Step 7: Implement responsive game layout CSS.**

Keep current 3-column desktop intent; at 1080px use the existing two-column strategy and at 760px use one column. No panel may force horizontal viewport overflow. Keep `prefers-reduced-motion` disabling nonessential effects.

- [ ] **Step 8: Run the focused game screen test.**

Run: `rtk npm run test:web -- --run src/features/game/GameScreen.test.tsx`

Expected: PASS.

- [ ] **Step 9: Commit the HUD and layout update.**

```powershell
rtk git add apps/web/src/features/game/GameScreen.tsx apps/web/src/features/game/GameTopBar.tsx apps/web/src/features/game/PlayerPanel.tsx apps/web/src/features/game/TurnStatus.tsx apps/web/src/features/game/MoveHistory.tsx apps/web/src/features/game/game.module.css apps/web/src/features/game/GameScreen.test.tsx
rtk git commit -m "feat: restyle tactical game HUD"
```

## Task 5: Re-theme the Board and Pieces While Preserving Interaction

**Files:**
- Modify: `apps/web/src/features/game/Board.tsx`
- Modify: `apps/web/src/features/game/BoardCell.tsx`
- Modify: `apps/web/src/features/game/Piece.tsx`
- Modify: `apps/web/src/features/game/game.module.css`
- Test: `apps/web/src/features/game/Board.test.tsx`
- Test: `apps/web/src/accessibility/cross-screen.accessibility.test.tsx`

- [ ] **Step 1: Confirm existing board props provide every approved style state.**

`Board` and `BoardCell` already receive piece, selected, legal, goal and disabled state. Maintain the 81-item loop, positions, `data-testid`, `data-x`, `data-y`, `aria-label`, disabled state and the exact `onClickPosition` call. Do not add styling props, read rules or mutate state in the renderer. For this plan, both legal empty and legal occupied destinations use the same legal styling because the contract does not expose a distinct capture-target semantic.

- [ ] **Step 2: Restyle board geometry defensively.**

The playable grid must contain:

```css
grid-template-columns: repeat(9, minmax(0, 1fr));
grid-template-rows: repeat(9, minmax(0, 1fr));
aspect-ratio: 1;
```

Coordinate tracks must stay outside the grid and align with it. Use a small, consistent cell gap only if it remains visually clear and does not break focus/click targets. Preserve a fluid bounded width, including on mobile.

- [ ] **Step 3: Restyle pieces through the existing local icon component.**

Create neon glass ring/gradient/glow styling for `Piece` based on its seat class. `PieceIcon` is decorative; accessible piece type/seat text remains exclusively in the board cell `aria-label`. Avoid native emoji or external icon scripts. Hover/selected animation must be disabled or reduced under `prefers-reduced-motion`.

- [ ] **Step 4: Implement legible interaction states.**

Use more than color: selected gets ring/scale; legal targets get a dot/ring; goals get icon-free border/pattern; disabled gets cursor/opacity. Keep focus outline higher than the board-cell layer. Avoid continuous `animate-ping` on every cell.

- [ ] **Step 5: Run board and accessibility tests.**

Run: `rtk npm run test:web -- --run src/features/game/Board.test.tsx src/accessibility/cross-screen.accessibility.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit the board/piece update.**

```powershell
rtk git add apps/web/src/features/game/Board.tsx apps/web/src/features/game/BoardCell.tsx apps/web/src/features/game/Piece.tsx apps/web/src/features/game/game.module.css apps/web/src/features/game/Board.test.tsx apps/web/src/accessibility/cross-screen.accessibility.test.tsx
rtk git commit -m "feat: add neon tactical board styling"
```

## Task 6: Upgrade Result Presentation Using Only Existing Result Data

**Files:**
- Modify: `apps/web/src/features/result/ResultDialog.tsx`
- Modify: `apps/web/src/features/result/result.module.css`
- Test: `apps/web/src/features/result/ResultDialog.test.tsx`
- Test: `apps/web/src/features/result/ResultDialog.visual.test.tsx`

- [ ] **Step 1: Complete failing result contract tests.**

Cover player-won, player-lost and no-viewer result states. Each must retain Vietnamese reason copy from `resultReason`, the close action and the lobby action. No metrics, ratings, dates, duration, move count or rematch action may appear because the model does not supply them.

- [ ] **Step 2: Run focused result tests and confirm they fail.**

Run: `rtk npm run test:web -- --run src/features/result/ResultDialog.test.tsx src/features/result/ResultDialog.visual.test.tsx`

Expected: FAIL for the new visual outcome contract until implementation is added.

- [ ] **Step 3: Add semantic result presentation.**

Derive exactly one local value:

```ts
const outcome = result.winner && viewerSeat
  ? result.winner === viewerSeat ? "win" : "loss"
  : "neutral";
```

Expose it through a `data-outcome` attribute on a result wrapper. Display an accessible decorative emblem with `aria-hidden="true"`; retain text title and reason as the source of meaning. Optionally show existing winner/participant names, but not fabricated competitive data.

- [ ] **Step 4: Apply win/loss/neutral glass styling.**

Use amber/cyan emphasis for win, magenta/red for loss, and neutral cyan/violet for unknown viewer. Keep contrast readable, modal content scrollable on short screens, and actions consistently named `Xem bàn` and `Về sảnh`.

- [ ] **Step 5: Run focused result tests.**

Run: `rtk npm run test:web -- --run src/features/result/ResultDialog.test.tsx src/features/result/ResultDialog.visual.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit result styling.**

```powershell
rtk git add apps/web/src/features/result/ResultDialog.tsx apps/web/src/features/result/result.module.css apps/web/src/features/result/ResultDialog.test.tsx apps/web/src/features/result/ResultDialog.visual.test.tsx
rtk git commit -m "feat: add neon result dialog"
```

## Task 7: Verify Browser Geometry and Every Supported UI State

**Files:**
- Test: `apps/web/src/demo/ScenarioSwitcher.test.tsx`
- Test: `apps/web/src/app/App.test.tsx`

- [ ] **Step 1: Confirm demo coverage only for current supported states.**

Use the current `DemoScenario` union and fixture mapping as the source of truth. Verify that no existing scenario regresses:

```text
?demo=lobby-default
?demo=lobby-online-unavailable
?demo=lobby-online-connecting
?demo=lobby-rooms
?demo=game-waiting
?demo=game-active-a
?demo=game-piece-selected
?demo=game-move-rejected
?demo=game-capture
?demo=game-strike-loss
?demo=game-ai-thinking
?demo=game-reconnecting
?demo=game-clock-warning
?demo=game-recoverable-error
?demo=result-goal
?demo=result-elimination
?demo=result-no-moves
?demo=result-timeout
?demo=result-disconnect-timeout
?demo=result-leave
```

Do not create scenarios for chat, spectators, ratings, analysis or mockup-only features.

- [ ] **Step 2: Run focused app and scenario tests.**

Run: `rtk npm run test:web -- --run src/app/App.test.tsx src/demo/ScenarioSwitcher.test.tsx`

Expected: PASS.

- [ ] **Step 3: Run complete FE verification.**

Run:

```powershell
rtk npm run test:web
rtk npm run typecheck:web
rtk npm run build:web
```

Expected: all web tests pass, typecheck has no output/errors, production build succeeds.

- [ ] **Step 4: Perform Playwright geometry inspection using deterministic demos.**

Start `rtk npm run dev:web` in a managed terminal, because query-selected demo fixtures are intentionally enabled only when `import.meta.env.DEV` is true. Use a one-off Playwright command or script outside the repository to open `?demo=game-active-a` at 1910x906, 1080x900 and 390x844. It must assert exactly 81 cells, a square board/cell within one CSS pixel, no document horizontal overflow, and no console/page errors. Stop the dev server after inspection. This verifies visual geometry only and does not establish online transport correctness. `rtk npm run build:web` remains the separate production-bundle verification in Step 3.

- [ ] **Step 5: Perform the complete manual/demo matrix inspection.**

Inspect every scenario in Step 1. Confirm each remains readable, uses a square board where applicable, retains keyboard controls and has no fabricated product features.

- [ ] **Step 6: Commit verification-related tests only.**

```powershell
rtk git add apps/web/src/demo/ScenarioSwitcher.test.tsx apps/web/src/app/App.test.tsx
rtk git commit -m "test: cover neon UI states"
```

## Final Acceptance Checklist

- [ ] No Tailwind dependency, CDN script or utility class is introduced; CSS Modules and semantic token CSS remain the styling system.
- [ ] No external icon script, Material Symbols script, avatar URL, emoji piece or raw Stitch HTML is shipped.
- [ ] The UI includes only data/actions backed by current components, session contract and snapshots.
- [ ] `GameSession`, `GameSnapshot`, session implementations, game-core rules, Worker authority and PlayHTML transport are unchanged.
- [ ] Local and AI modes still start from the redesigned lobby and make legal moves.
- [ ] Online remains honestly unavailable when its runtime factory is absent, with local/AI still usable.
- [ ] Online board state is never locally mutated on click; the pending state remains authoritative.
- [ ] Board has exactly 81 accessible buttons, correct coordinate labels/test ids, square outer grid and square cells at desktop/tablet/mobile widths.
- [ ] Focus, disabled, selected, legal, goal, AI-thinking, reconnecting, low-clock and result states are visually distinct without relying on color alone.
- [ ] Result dialog supports all canonical reasons and contains only existing data/actions.
- [ ] `npm.cmd run test:web`, `npm.cmd run typecheck:web`, and `npm.cmd run build:web` pass.
- [ ] A managed Playwright inspection of deterministic development demo screens confirms square board/cells and no horizontal overflow at desktop, tablet and mobile widths.
