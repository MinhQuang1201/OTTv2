# React Game UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the imperative HTML UI with a demo-first, desktop-focused React and TypeScript application covering lobby, local/AI/online gameplay, and results while preserving Worker authority and the single verified PlayHTML transport.

**Architecture:** Vite builds one React root under `apps/web`. Typed `GameSession` adapters normalize demo, local, AI, and online state for feature components; UI components never import game rules or transport code. The existing minimal PlayHTML runtime stays behind `OnlineSession` and is not used as React state management.

**Tech Stack:** React, TypeScript, Vite, Vitest, React Testing Library, user-event, plain CSS/CSS Modules, existing JavaScript `game-core`, existing `PlayhtmlGameClient`, Playwright for browser smoke tests.

**Design spec:** `docs/superpowers/specs/2026-09-26-react-game-ui-redesign-design.md`

---

## Execution Notes

- The current working tree contains a large repository-organization change, including untracked `apps/` and `packages/` paths. Before implementation, preserve or commit that work explicitly. Do not create a clean worktree from `HEAD` until those required files are reachable from the chosen base commit.
- Never stage unrelated dirty files. Each commit below lists only files owned by that task.
- Do not install `@playhtml/react`, add `PlayProvider`, or use PlayHTML page/element data, events, presence, awareness, cursors, capabilities, polling, `PartySocket`, or a second WebSocket.
- Keep `packages/game-core/src/rules.js`, `packages/game-core/src/room.js`, and Worker authority semantics unchanged unless a failing integration test proves a separately reviewed change is necessary.
- Run the demo checkpoint after Task 7 before integrating local, AI, or online behavior. Visual polish must not delay that checkpoint.

## Target File Map

### Build and entry

- Create `apps/web/index.html` — Vite HTML entry with `#root` only.
- Create `apps/web/vite.config.ts` — root, build directory, and React plugin.
- Create `apps/web/vitest.config.ts` — jsdom test environment.
- Create `apps/web/tsconfig.json` — strict browser TypeScript settings.
- Create `apps/web/src/main.tsx` — React root bootstrap.
- Modify `package.json` and `package-lock.json` — React/Vite/test dependencies and scripts.

### Shared model and sessions

- Create `apps/web/src/shared/model/game.ts` — normalized UI model and discriminated unions.
- Create `apps/web/src/shared/model/format.ts` — coordinate, clock, and result text formatters.
- Create `apps/web/src/sessions/contract.ts` — `GameSession` contract and dependencies.
- Create `apps/web/src/sessions/useSessionSnapshot.ts` — React external-store hook.
- Create `apps/web/src/sessions/core/gameCoreBridge.ts` — the only browser bridge to legacy `game-core` globals.
- Create `apps/web/src/sessions/demo/*` — fixtures and deterministic demo session.
- Create `apps/web/src/sessions/local/*` — local rules/clock adapter.
- Create `apps/web/src/sessions/ai/*` — AI orchestration around local session behavior.
- Create `apps/web/src/sessions/online/*` — control endpoint, runtime bridge, lobby gateway, and online session.

### Application and features

- Create `apps/web/src/app/App.tsx`, `AppProviders.tsx`, `ScreenBoundary.tsx`, and app CSS.
- Create `apps/web/src/features/lobby/*` — mode selection and online room UI.
- Create `apps/web/src/features/game/*` — board, HUD, interaction, status, and optional side rail.
- Create `apps/web/src/features/result/*` — result dialog and reason presentation.
- Create `apps/web/src/shared/ui/*` — reusable primitives only.
- Create `apps/web/src/shared/icons/PieceIcon.tsx` — internal SVG icons.
- Create `apps/web/src/shared/theme/*` — tokens, reset, global styles, and motion rules.
- Create `apps/web/src/demo/*` — development-only scenario switcher.

### Production migration

- Create `apps/web/static/playhtml-game.html` — retained minimal adapter diagnostic page copied by Vite.
- Modify `server.js` — serve `apps/web/dist` only after the production migration.
- Modify browser/static-boundary tests for the React build and stable roles/test IDs.
- Delete `apps/web/src/legacy/game.js` and obsolete legacy public UI files only after parity verification.

---

### Task 1: Add the React/Vite/Test Toolchain and a Minimal Root

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `apps/web/index.html`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/vitest.config.ts`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/app/App.tsx`
- Create: `apps/web/src/test/setup.ts`
- Test: `apps/web/src/app/App.test.tsx`

- [ ] **Step 1: Add a failing application smoke test**

```tsx
// apps/web/src/app/App.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("renders the OTTv2 application landmark", () => {
    render(<App />);
    expect(screen.getByRole("main", { name: /OTTv2/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Install only the frontend dependencies**

Run:

```powershell
npm.cmd install --save-exact react@18.3.1 react-dom@18.3.1
npm.cmd install --save-dev --save-exact vite@5.4.14 typescript@5.7.3 @vitejs/plugin-react@4.3.4 vitest@2.1.8 jsdom@24.1.3 @testing-library/react@16.1.0 @testing-library/jest-dom@6.6.3 @testing-library/user-event@14.5.2 @types/react@18.3.18 @types/react-dom@18.3.5
```

These versions support the repository's declared Node 18 floor. Expected: `package.json` and `package-lock.json` change; `@playhtml/react` is absent. If the registry rejects a listed exact patch, stop and verify official engine/release metadata before selecting another exact Node-18-compatible version; do not silently install unconstrained latest packages.

- [ ] **Step 3: Add frontend scripts**

Add these exact script names to `package.json` while preserving Worker and existing test scripts:

```json
{
  "dev:web": "vite --config apps/web/vite.config.ts",
  "build:web": "vite build --config apps/web/vite.config.ts",
  "test:web": "vitest run --config apps/web/vitest.config.ts",
  "test:web:watch": "vitest --config apps/web/vitest.config.ts",
  "typecheck:web": "tsc -p apps/web/tsconfig.json --noEmit"
}
```

- [ ] **Step 4: Create strict Vite and TypeScript configuration**

`vite.config.ts` must set `root` to `apps/web`, `publicDir` to `static`, `build.outDir` to `dist`, and `emptyOutDir: true`. Do not point Vite at the legacy `apps/web/public` directory.

`tsconfig.json` must use `strict: true`, `noEmit: true`, `jsx: "react-jsx"`, `moduleResolution: "Bundler"`, `target: "ES2022"`, and include `src` plus both Vite config files.

- [ ] **Step 5: Add the minimal root**

`apps/web/index.html` contains metadata, font preconnect/stylesheet links, `<div id="root"></div>`, and `<script type="module" src="/src/main.tsx"></script>`. It must not load the PlayHTML runtime, bootstrap, or game client globally.

`App.tsx` initially renders:

```tsx
export function App() {
  return <main aria-label="OTTv2">OTTv2</main>;
}
```

- [ ] **Step 6: Run the test, typecheck, and build**

Run:

```powershell
npm.cmd run test:web -- apps/web/src/app/App.test.tsx
npm.cmd run typecheck:web
npm.cmd run build:web
```

Expected: all commands exit `0`; `apps/web/dist/index.html` exists.

- [ ] **Step 7: Commit the toolchain only**

```powershell
git add package.json package-lock.json apps/web/index.html apps/web/vite.config.ts apps/web/vitest.config.ts apps/web/tsconfig.json apps/web/src/main.tsx apps/web/src/app/App.tsx apps/web/src/app/App.test.tsx apps/web/src/test/setup.ts
git commit -m "build: add React web toolchain"
```

---

### Task 2: Define the Normalized Game Model and Session Contract

**Files:**

- Create: `apps/web/src/shared/model/game.ts`
- Create: `apps/web/src/shared/model/format.ts`
- Create: `apps/web/src/sessions/contract.ts`
- Create: `apps/web/src/sessions/useSessionSnapshot.ts`
- Test: `apps/web/src/shared/model/format.test.ts`
- Test: `apps/web/src/sessions/contract.test.ts`

- [ ] **Step 1: Write failing formatter and contract tests**

Cover at minimum:

```ts
expect(formatSquare({ x: 0, y: 0 })).toBe("A1");
expect(formatSquare({ x: 8, y: 8 })).toBe("I9");
expect(formatClock(599_001)).toBe("10:00");
expect(formatClock(0)).toBe("00:00");
expect(resultReason({ winner: "A", reason: "goal" })).toMatch(/A9/);
```

Add a compile-time fixture implementing `GameSession`; it must fail until `getSnapshot`, `subscribe`, `start`, `getLegalMoves`, `move`, `leave`, and `dispose` are defined.

- [ ] **Step 2: Implement the shared discriminated unions from the spec**

Define `Seat`, `PieceType`, `Position`, `PieceView`, `PlayerView`, `GameResultView`, `SessionMode`, `SessionPhase`, `ConnectionState`, `GameSnapshot`, `StartGameOptions`, and `MoveResult`.

Add `boardRevision: number` to `GameSnapshot`. It increments only when board occupancy, turn, or terminal state changes. Display-only clock ticks, connection labels, and other cosmetic publications retain the same board revision. Use these exact event/error boundaries:

```ts
export type GameEventView =
  | { id: number; type: "move"; pieceId: string; from: Position; to: Position }
  | { id: number; type: "capture"; pieceId: string; capturedId: string; from: Position; to: Position }
  | { id: number; type: "strike_loss"; pieceId: string; byId: string; from: Position; to: Position }
  | { id: number; type: "win"; winner: Seat; reason: ResultReason };

export type SessionErrorCode =
  | "invalid_input" | "invalid_move" | "online_unavailable"
  | "connection_failed" | "reconnect_failed" | "room_unavailable"
  | "session_failed";

export interface SessionErrorView {
  code: SessionErrorCode;
  message: string;
  retryable: boolean;
}
```

- [ ] **Step 3: Implement `GameSession` and `useSessionSnapshot`**

The hook is a thin wrapper:

```ts
export function useSessionSnapshot(session: GameSession | null) {
  return useSyncExternalStore(
    session ? session.subscribe : noopSubscribe,
    session ? session.getSnapshot : emptySnapshot,
    session ? session.getSnapshot : emptySnapshot,
  );
}
```

Bind class methods or expose arrow functions so passing them into `useSyncExternalStore` does not lose `this`.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```powershell
npm.cmd run test:web -- apps/web/src/shared/model apps/web/src/sessions/contract.test.ts
npm.cmd run typecheck:web
```

Expected: PASS.

- [ ] **Step 5: Commit the contract**

```powershell
git add apps/web/src/shared/model apps/web/src/sessions/contract.ts apps/web/src/sessions/contract.test.ts apps/web/src/sessions/useSessionSnapshot.ts
git commit -m "feat: define frontend game session contract"
```

---

### Task 3: Build Deterministic Fixtures and `DemoSession`

**Files:**

- Create: `apps/web/src/sessions/demo/scenarios.ts`
- Create: `apps/web/src/sessions/demo/fixtureBuilders.ts`
- Create: `apps/web/src/sessions/demo/DemoSession.ts`
- Test: `apps/web/src/sessions/demo/DemoSession.test.ts`

- [ ] **Step 1: Write failing scenario tests**

Assert that every required scenario builds a valid 9x9 snapshot and that subscriptions fire exactly once per transition:

```ts
const session = new DemoSession("game-piece-selected");
const listener = vi.fn();
const unsubscribe = session.subscribe(listener);
await session.move({ x: 0, y: 2 }, { x: 0, y: 1 });
expect(listener).toHaveBeenCalledTimes(1);
expect(session.getSnapshot().events.at(-1)?.id).toBeGreaterThan(0);
unsubscribe();
```

- [ ] **Step 2: Implement fixture builders instead of repeated object literals**

Provide `makePiece`, `makePlayer`, `makeSnapshot`, and `makeEvent`. Freeze returned fixture objects in development/tests so components cannot mutate them.

- [ ] **Step 3: Implement all approved scenarios**

Use the exact keys from the spec:

`lobby-default`, `lobby-online-unavailable`, `lobby-online-connecting`, `lobby-rooms`, `game-waiting`, `game-active-a`, `game-piece-selected`, `game-move-rejected`, `game-capture`, `game-strike-loss`, `game-ai-thinking`, `game-reconnecting`, `game-clock-warning`, `game-recoverable-error`, `result-goal`, `result-elimination`, `result-no-moves`, `result-timeout`, `result-disconnect-timeout`, and `result-leave`.

The fixture board must use canonical `A_SETUP` positions, not a visually convenient alternate setup.

- [ ] **Step 4: Implement deterministic demo transitions**

`DemoSession.move` accepts only destinations declared by the scenario, updates one immutable snapshot, allocates monotonic event IDs, and returns a typed rejection otherwise. For `game-move-rejected`, `getLegalMoves` deliberately advertises one destination while `move` deterministically rejects that same destination; this exercises the real production toast path without implementing rules in the fixture. It is a UI fixture, not a rules implementation.

- [ ] **Step 5: Verify and commit**

```powershell
npm.cmd run test:web -- apps/web/src/sessions/demo
npm.cmd run typecheck:web
git add apps/web/src/sessions/demo
git commit -m "feat: add deterministic UI demo session"
```

---

### Task 4: Establish Theme Tokens, UI Primitives, and Piece Icons

**Files:**

- Create: `apps/web/src/shared/theme/tokens.css`
- Create: `apps/web/src/shared/theme/reset.css`
- Create: `apps/web/src/shared/theme/global.css`
- Create: `apps/web/src/shared/ui/Button.tsx`
- Create: `apps/web/src/shared/ui/TextField.tsx`
- Create: `apps/web/src/shared/ui/Badge.tsx`
- Create: `apps/web/src/shared/ui/Panel.tsx`
- Create: `apps/web/src/shared/ui/Dialog.tsx`
- Create: `apps/web/src/shared/ui/Spinner.tsx`
- Create: `apps/web/src/shared/ui/VisuallyHidden.tsx`
- Create: `apps/web/src/shared/ui/ToastRegion.tsx`
- Create: `apps/web/src/shared/ui/useToasts.ts`
- Create: `apps/web/src/shared/ui/ui.module.css`
- Create: `apps/web/src/shared/icons/PieceIcon.tsx`
- Test: `apps/web/src/shared/ui/ui.test.tsx`
- Test: `apps/web/src/shared/icons/PieceIcon.test.tsx`

- [ ] **Step 1: Write failing accessibility tests for primitives**

Test disabled semantics, label association, dialog labeling, keyboard focus, and decorative icon behavior. Example:

```tsx
render(<TextField label="Mã phòng" name="room" error="Mã không hợp lệ" />);
expect(screen.getByLabelText("Mã phòng")).toHaveAccessibleDescription("Mã không hợp lệ");
```

- [ ] **Step 2: Define semantic tokens**

Include token groups for graphite surfaces, text, Seat A coral/magenta, Seat B cyan, light/dark board squares, both goal squares, selection, legal move, danger, focus ring, 4px spacing, radii, shadows, motion, board max size, side-panel width, and z-index roles.

No feature CSS may repeat raw seat colors. `prefers-reduced-motion: reduce` sets transition/animation duration to effectively zero for nonessential effects.

- [ ] **Step 3: Implement small semantic primitives**

Primitives forward native props and refs. Do not create a configuration-heavy design-system abstraction. Variants are limited to those already needed: primary, secondary, quiet, danger; status badges; standard panel.

`useToasts` owns a bounded queue with stable IDs and removes each transient message after 2200ms. `ToastRegion` renders one `role="status"`/polite region for normal feedback and uses an assertive announcement only for actionable errors. Session failures are normalized before entering the queue; raw exceptions are never rendered.

- [ ] **Step 4: Implement local SVG piece icons**

`PieceIcon` accepts `type`, `title`, and `decorative`. Render three consistent 24x24 SVG paths. When decorative, set `aria-hidden="true"`; otherwise expose `<title>` using canonical labels “Đấm”, “Lá”, and “Kéo”. Do not load PNG files.

- [ ] **Step 5: Import global styles once from `main.tsx`**

Order: reset, tokens, global. Feature styles remain feature-local.

- [ ] **Step 6: Verify and commit**

```powershell
npm.cmd run test:web -- apps/web/src/shared/ui apps/web/src/shared/icons
npm.cmd run typecheck:web
git add apps/web/src/shared/theme apps/web/src/shared/ui apps/web/src/shared/icons apps/web/src/main.tsx
git commit -m "feat: add competitive game UI foundation"
```

---

### Task 5: Implement the Demo-Driven Application Shell

**Files:**

- Modify: `apps/web/src/app/App.tsx`
- Create: `apps/web/src/app/AppProviders.tsx`
- Create: `apps/web/src/app/ScreenBoundary.tsx`
- Create: `apps/web/src/app/app.module.css`
- Create: `apps/web/src/demo/ScenarioSwitcher.tsx`
- Create: `apps/web/src/demo/useDemoScenario.ts`
- Test: `apps/web/src/app/App.test.tsx`
- Test: `apps/web/src/demo/ScenarioSwitcher.test.tsx`

- [ ] **Step 1: Replace the smoke test with failing lifecycle tests**

Test `boot -> lobby -> preparing -> playing -> finished`, disposal of the previous session, and recovery to lobby after a session error. Use a fake `SessionFactory`; do not inspect component internals.

- [ ] **Step 2: Implement the app lifecycle reducer**

Use an explicit discriminated union:

```ts
type AppState =
  | { screen: "boot" }
  | { screen: "lobby" }
  | { screen: "preparing"; mode: SessionMode }
  | { screen: "playing"; session: GameSession }
  | { screen: "finished"; session: GameSession; result: GameResultView }
  | { screen: "error"; error: SessionErrorView };
```

Do not add React Router.

- [ ] **Step 3: Add the development-only scenario switcher**

Read `?demo=<scenario>` only when `import.meta.env.DEV`. The switcher creates real `DemoSession` instances and renders production screens. Production builds must tree-shake or hide the control; production UI must not accept arbitrary fixture state from the URL.

- [ ] **Step 4: Implement `ScreenBoundary`**

Provide “Thử lại” only for retryable errors and always provide “Về sảnh”. Do not expose raw exception messages.

- [ ] **Step 5: Verify and commit**

```powershell
npm.cmd run test:web -- apps/web/src/app apps/web/src/demo
npm.cmd run typecheck:web
git add apps/web/src/app apps/web/src/demo
git commit -m "feat: add demo-driven application shell"
```

---

### Task 6: Implement the Lobby Experience

**Files:**

- Create: `apps/web/src/features/lobby/LobbyScreen.tsx`
- Create: `apps/web/src/features/lobby/ModeCard.tsx`
- Create: `apps/web/src/features/lobby/OnlineRoomPanel.tsx`
- Create: `apps/web/src/features/lobby/WaitingRoomList.tsx`
- Create: `apps/web/src/features/lobby/lobby.module.css`
- Test: `apps/web/src/features/lobby/LobbyScreen.test.tsx`
- Test: `apps/web/src/features/lobby/OnlineRoomPanel.test.tsx`

- [ ] **Step 1: Write failing user-flow tests**

Cover:

- AI and same-device buttons remain enabled when online is unavailable.
- Create sends trimmed player name.
- Join requires a nonempty room ID and displays an inline error.
- Clicking a waiting room fills/uses its exact allocation ID without uppercasing UUID-style IDs.
- Empty, loading, error, unavailable, and populated room states are distinct.

- [ ] **Step 2: Implement a presentational lobby contract**

`LobbyScreen` receives values/callbacks; it does not import a session or online gateway. Its callbacks are:

```ts
onStartLocal(names: [string, string]): void;
onStartAi(playerName: string): void;
onCreateOnline(playerName: string): void;
onJoinOnline(playerName: string, roomId: string): void;
```

- [ ] **Step 3: Build the two-column desktop layout**

Left: product title, concise rule loop, and decorative board composition. Right: quick-play panel followed by online panel/list. Use real product copy from `PRODUCT.md`; do not add fabricated player counts or marketing statistics.

- [ ] **Step 4: Persist only the player name locally**

Use a tiny `playerNameStorage.ts` helper with `localStorage` failure guards. Do not store game or room state in local storage; online resume remains owned by `PlayhtmlGameClient` session storage.

- [ ] **Step 5: Verify and commit**

```powershell
npm.cmd run test:web -- apps/web/src/features/lobby
npm.cmd run typecheck:web
git add apps/web/src/features/lobby
git commit -m "feat: build React game lobby"
```

---

### Task 7: Implement the Board, HUD, Result, and Complete UI Demo

**Files:**

- Modify: `apps/web/src/app/AppProviders.tsx`
- Create: `apps/web/src/features/game/GameScreen.tsx`
- Create: `apps/web/src/features/game/GameTopBar.tsx`
- Create: `apps/web/src/features/game/PlayerPanel.tsx`
- Create: `apps/web/src/features/game/Board.tsx`
- Create: `apps/web/src/features/game/BoardCell.tsx`
- Create: `apps/web/src/features/game/Piece.tsx`
- Create: `apps/web/src/features/game/TurnStatus.tsx`
- Create: `apps/web/src/features/game/MoveHistory.tsx`
- Create: `apps/web/src/features/game/ConfirmLeaveDialog.tsx`
- Create: `apps/web/src/features/game/useBoardSelection.ts`
- Create: `apps/web/src/features/game/game.module.css`
- Create: `apps/web/src/features/result/ResultDialog.tsx`
- Create: `apps/web/src/features/result/result.module.css`
- Test: `apps/web/src/features/game/Board.test.tsx`
- Test: `apps/web/src/features/game/GameScreen.test.tsx`
- Test: `apps/web/src/features/result/ResultDialog.test.tsx`

- [ ] **Step 1: Write failing board semantics and interaction tests**

Required assertions:

```tsx
expect(screen.getAllByRole("button", { name: /ô [A-I][1-9]/i })).toHaveLength(81);
await user.click(screen.getByRole("button", { name: /ô A3.*Lá.*Người A/i }));
expect(getLegalMoves).toHaveBeenCalledWith({ x: 0, y: 2 });
await user.click(screen.getByRole("button", { name: /ô A2.*nước hợp lệ/i }));
expect(onMove).toHaveBeenCalledWith({ x: 0, y: 2 }, { x: 0, y: 1 });
```

Also test pending input, inactive viewer, reconnecting, and AI-thinking states.

- [ ] **Step 2: Render coordinates and exactly 81 semantic cell buttons**

`Board` derives a coordinate-keyed lookup map once with `useMemo`, rather than scanning all pieces for every cell. `BoardCell` receives presentation state only. Keep `data-x`, `data-y`, and stable `data-testid="board-cell-A3"` hooks for browser diagnostics, but prefer accessible roles in tests.

- [ ] **Step 3: Keep selection in `useBoardSelection`**

The hook asks `session.getLegalMoves(from)` and never imports rules. Clear selection when turn, explicit `snapshot.boardRevision`, reconnect state, or pending state changes. Do not use `board` array identity because display-only clock ticks may publish a new snapshot without a board change. On a legal destination, await `session.move`; preserve the latest snapshot until the session publishes another one. If `MoveResult.accepted` is false, pass its normalized error to the app-level `useToasts`; do not leave the error only in a rejected promise.

- [ ] **Step 4: Implement HUD and persistent status**

Show both names, clocks, piece counts, active-turn marker, connection state, room label, and leave action. `TurnStatus` owns one polite live region for turn/wait/reconnect/AI messages. Do not announce the 250ms clock ticks. `AppProviders` renders the single shared `ToastRegion` so move rejection and recoverable session feedback stay visible across feature boundaries.

For online mode, activating “Rời bàn” opens `ConfirmLeaveDialog` with explicit copy that leaving may immediately lose the game. Only the confirm action calls `session.leave`; cancel returns focus to the leave button. Add tests that local/AI leaving follows the chosen direct behavior and online leaving never occurs without confirmation.

- [ ] **Step 5: Implement event-driven visual feedback**

Track the highest displayed event ID. Animate each new capture/strike/win once. CSS durations are 160–240ms and disabled by reduced-motion. Clock updates and identical snapshots must not replay effects.

- [ ] **Step 6: Implement the optional side rail**

Render `MoveHistory` from normalized events with an empty state. The board layout accepts the rail as a slot so chat/spectator functionality can replace it later without changing board code.

- [ ] **Step 7: Implement normalized results**

`ResultDialog` receives `GameResultView`, viewer seat, and player names. It renders “Bạn thắng”, “Bạn thua”, or the local winner name and uses `resultReason`; it must not infer a winner from board pieces.

- [ ] **Step 8: Connect every demo scenario through `App`**

Verify every Task 3 scenario uses production components. In particular, exercise connecting, move rejection through `ToastRegion`, capture/strike one-shot effects, recoverable error actions, and every canonical result reason.

- [ ] **Step 9: Run the first visual demo checkpoint**

Run:

```powershell
npm.cmd run dev:web
```

Open the printed local URL and manually check at desktop widths 1440x900 and 1280x720. Test each `?demo=` scenario. Expected: no Worker is required and browser console has no errors.

- [ ] **Step 10: Run automated checks and commit**

```powershell
npm.cmd run test:web -- apps/web/src/features/game apps/web/src/features/result
npm.cmd run typecheck:web
npm.cmd run build:web
git add apps/web/src/features/game apps/web/src/features/result apps/web/src/app/App.tsx apps/web/src/app/AppProviders.tsx
git commit -m "feat: complete interactive React UI demo"
```

---

### Task 8: Integrate Canonical Game Core Through `LocalSession`

**Files:**

- Create: `apps/web/src/sessions/core/globals.d.ts`
- Create: `apps/web/src/sessions/core/gameCoreBridge.ts`
- Create: `apps/web/src/sessions/core/normalizeCoreState.ts`
- Create: `apps/web/src/sessions/local/LocalSession.ts`
- Test: `apps/web/src/sessions/core/normalizeCoreState.test.ts`
- Test: `apps/web/src/sessions/local/LocalSession.test.ts`
- Modify: `apps/web/src/app/App.tsx`

- [ ] **Step 1: Write failing normalization tests against real core state**

Import canonical modules as side effects in this order:

```ts
import "../../../../../packages/game-core/src/config.js";
import "../../../../../packages/game-core/src/rules.js";
import "../../../../../packages/game-core/src/ai.js";
```

Then assert initial state yields 18 pieces, A turn, correct A/B counts, 10:00 clocks, and canonical goals. This bridge is the only React-side file allowed to reference `OTT_CONFIG`, `OTT_RULES`, or `OTT_AI`.

- [ ] **Step 2: Declare the smallest legacy global surface**

`globals.d.ts` describes only functions used by adapters. Do not copy all rule implementation types. Add runtime guards in `gameCoreBridge.ts` so a missing global fails with a stable `session_failed` error.

- [ ] **Step 3: Write failing local-session behavior tests using fake time**

Inject `now`, `setInterval`, and `clearInterval`. Test legal previews, accepted/rejected moves, turn changes, monotonic local event IDs, clock decrement, timeout, unsubscribe, leave, and timer cleanup in `dispose`.

- [ ] **Step 4: Implement `LocalSession`**

Only the session calls `createInitialState`, `getLegalMoves`, `applyMove`, `elapseClock`, and `countByType`. Publish immutable normalized snapshots. Increment `boardRevision` for accepted moves and terminal transitions, but retain it for display-only clock publications. Call `elapseClock` before applying a move so displayed and rule clocks share one time source.

- [ ] **Step 5: Wire same-device mode into `App`**

Starting local play creates one `LocalSession`, calls `start({ mode: "local", playerNames })`, and transitions to the game screen. Leaving calls `leave`, `dispose`, then returns to lobby.

- [ ] **Step 6: Verify core tests plus web tests**

```powershell
npm.cmd run test:web -- apps/web/src/sessions/core apps/web/src/sessions/local
node --test tests/rules.test.js tests/room.test.js
npm.cmd run typecheck:web
```

Expected: PASS; no React component imports a core module.

- [ ] **Step 7: Commit**

```powershell
git add apps/web/src/sessions/core apps/web/src/sessions/local apps/web/src/app/App.tsx
git commit -m "feat: connect local play to React UI"
```

---

### Task 9: Add `AiSession` Without Coupling AI to Components

**Files:**

- Create: `apps/web/src/sessions/ai/AiSession.ts`
- Test: `apps/web/src/sessions/ai/AiSession.test.ts`
- Modify: `apps/web/src/app/App.tsx`

- [ ] **Step 1: Write failing AI orchestration tests**

Inject `chooseMove` and a fake timeout scheduler. Assert:

- the human can act only on the human seat;
- `aiThinking` becomes true after an accepted human move;
- exactly one AI decision is scheduled;
- input remains disabled while thinking;
- the AI move is applied through canonical local rules;
- leave/dispose cancels pending AI work;
- no AI move runs after a terminal result.

- [ ] **Step 2: Implement `AiSession` by composition**

Compose a private `LocalSession`; do not subclass it and do not copy its rule or clock logic. Convert internal local snapshots to expose `mode: "ai"`, `viewerSeat`, and `aiThinking`. Use the injected `chooseMove` from `gameCoreBridge`.

- [ ] **Step 3: Wire AI mode and verify**

```powershell
npm.cmd run test:web -- apps/web/src/sessions/ai
npm.cmd run typecheck:web
npm.cmd run build:web
```

Manually play at least one human move and confirm the AI responds after the configured short delay.

- [ ] **Step 4: Commit**

```powershell
git add apps/web/src/sessions/ai apps/web/src/app/App.tsx
git commit -m "feat: connect AI play to React UI"
```

---

### Task 10: Wrap the Existing Online Runtime and Client

**Files:**

- Create: `apps/web/src/sessions/online/globals.d.ts`
- Create: `apps/web/src/sessions/online/controlRequest.ts`
- Create: `apps/web/src/sessions/online/runtimeBridge.ts`
- Create: `apps/web/src/sessions/online/OnlineLobbyGateway.ts`
- Create: `apps/web/src/sessions/online/normalizeOnlineState.ts`
- Create: `apps/web/src/sessions/online/OnlineSession.ts`
- Test: `apps/web/src/sessions/online/controlRequest.test.ts`
- Test: `apps/web/src/sessions/online/runtimeBridge.test.ts`
- Test: `apps/web/src/sessions/online/OnlineLobbyGateway.test.ts`
- Test: `apps/web/src/sessions/online/OnlineSession.test.ts`
- Modify: `apps/web/src/app/App.tsx`
- Modify: `apps/web/src/features/lobby/LobbyScreen.tsx`

- [ ] **Step 1: Port control-request tests before implementation**

Replace source-extraction testing with direct behavior tests. Require HTTPS, trim one trailing slash, send JSON to `/control/<action>`, parse JSON errors, and never retry/poll implicitly.

- [ ] **Step 2: Write a failing runtime-boundary test**

Mock the reviewed globals and assert `runtimeBridge`:

- initializes one bootstrap only after allocation supplies `{ host, room }`;
- awaits runtime readiness before exposing the connection factory;
- refuses a second room on the initialized page;
- never constructs `WebSocket`, `PartySocket`, polling, presence, cursor, or awareness paths.

- [ ] **Step 3: Import existing UMD/browser files only in `runtimeBridge.ts`**

Keep side-effect order explicit:

```ts
import "../../../../../vendor/playhtml-minimal/browser/runtime.js";
import "../../../../../packages/game-client/src/playhtml-bootstrap.js";
import "../../../../../packages/game-client/src/playhtml-game-client.js";
```

Use declarations for `OTT_PLAYHTML_RUNTIME`, `PlayhtmlBootstrap`, `PlayhtmlGameClient`, `OTT_PLAYHTML_CONTROL_ENDPOINT`, `OTT_PLAYHTML_HOST`, `OTT_PLAYHTML_BOOTSTRAP`, and `OTT_PLAYHTML_CONNECTION_FACTORY`. Do not reach into provider/private APIs.

- [ ] **Step 4: Implement `OnlineLobbyGateway` as control-plane HTTP only**

Expose availability and `listRooms()`. It must not open a WebSocket. Normalize only public waiting-room fields. If the endpoint/runtime is missing, return `online_unavailable` and leave local/AI enabled.

- [ ] **Step 5: Write failing `OnlineSession` event-mapping tests**

Use a fake `PlayhtmlGameClient` with the real public event names. Cover open, close, reconnecting, resumed, joined, state, gameover, left, error, stale revisions, duplicate event IDs, create/join, rejected move, leave, and dispose.

Assert that `move` only calls `client.move(from, to)` and never mutates the current board. The board changes only after a newer `state` event.

- [ ] **Step 6: Implement normalized online snapshots and display-only clocks**

Retain the latest validated raw state privately for `getLegalMoves`. Use canonical pure `getLegalMoves` only for a visual preview. If normalization lacks the required fields, return `[]`; never recreate the rule in TypeScript.

Between authoritative snapshots, publish display-only remaining time calculated from `performance.now`. These ticks retain the last authoritative `boardRevision` and cannot set winner, switch turn, emit events, or send messages. Each newer authoritative revision replaces the estimate and becomes the normalized `boardRevision`.

- [ ] **Step 7: Wire room list/create/join into the lobby**

Load the room list once on lobby entry and after returning from a non-online game. Do not poll. Create/join constructs one `OnlineSession`. When leaving an initialized online room, reload the page before permitting attachment to a different room, matching the existing bootstrap invariant.

- [ ] **Step 8: Verify online guardrails**

Run:

```powershell
npm.cmd run test:web -- apps/web/src/sessions/online
node --test tests/playhtml-bootstrap.test.js tests/playhtml-game-client.test.js tests/playhtml-custom-channel.test.js
npm.cmd run typecheck:web
```

Expected: PASS; a repository search finds no new transport:

```powershell
rg -n "new\s+(WebSocket|PartySocket)|polling|createPageData|can-play|presence|awareness|cursors" apps/web/src
```

Expected: no production online implementation matches except negative test text/type names where unavoidable.

- [ ] **Step 9: Commit**

```powershell
git add apps/web/src/sessions/online apps/web/src/app/App.tsx apps/web/src/features/lobby/LobbyScreen.tsx
git commit -m "feat: connect authoritative online play to React UI"
```

---

### Task 11: Switch Production Static Serving and Browser Tests to the React Build

**Files:**

- Create: `apps/web/static/playhtml-game.html`
- Modify: `server.js`
- Modify: `package.json`
- Modify: `tests/server.test.js`
- Modify: `tests/playhtml-bootstrap.test.js`
- Modify: `tests/online-ui-boundary.test.js`
- Modify: `tests/no-legacy-online-transport.test.js`
- Modify: `tests/browser-worker-runtime.test.js`
- Modify: `tests/worker-runtime/fixture.js`
- Delete: `tests/game-control-request.test.js`
- Delete: `tests/game-ui-control-route.test.js`
- Test replacement: `apps/web/src/sessions/online/controlRequest.test.ts`
- Test replacement: `apps/web/src/sessions/online/OnlineSession.test.ts`

- [ ] **Step 1: Make production-root tests fail first**

Update `tests/server.test.js` to require built `apps/web/dist/index.html`, hashed JS assets, `/playhtml-game.html`, correct MIME types, and unchanged denials for source/private paths. Ensure the test setup runs `npm.cmd run build:web` before requiring `server.js`, or make the dedicated command build first.

- [ ] **Step 2: Serve only `apps/web/dist` as the public root**

Change `PUBLIC_ROOT` to `apps/web/dist`. Remove the `apps/web/src/` public mount. Keep the reviewed `packages/` and `vendor/` mounts only if `playhtml-game.html` still requires them; otherwise remove them and verify online bundles contain the needed adapter code. Never weaken `isPrivatePath`, realpath containment, traversal denial, or symlink checks.

- [ ] **Step 3: Make browser test scripts reproducible**

Change `test:browser-worker-runtime` to run both `build:playhtml-browser` and `build:web` before the Playwright harness. Ensure `tests/worker-runtime/fixture.js` either verifies `apps/web/dist/index.html` exists or builds before starting `server.js`.

- [ ] **Step 4: Migrate Playwright selectors**

Use accessible roles and stable IDs/test IDs:

- player name: `getByLabel("Tên của bạn")`;
- create: `getByRole("button", { name: "Tạo phòng" })`;
- game screen: `[data-testid="game-screen"]`;
- room label: `[data-testid="room-label"]`;
- cells: `[data-testid="board-cell-A3"]` or coordinate/occupancy accessible names.

Keep all existing assertions for two isolated browser contexts, one YProvider WebSocket per context, no polling, no presence/cursor/awareness endpoint, authoritative move propagation, and no console/page errors.

- [ ] **Step 5: Replace source-shape legacy tests with behavior/boundary tests**

Delete the two tests that parse functions out of `legacy/game.js`; their behavior is now covered directly by Vitest. Update `online-ui-boundary.test.js` and `no-legacy-online-transport.test.js` to scan `apps/web/src/sessions/online` plus the retained client/bootstrap files. Update `playhtml-bootstrap.test.js` so it tests the direct bootstrap contract and `runtimeBridge` integration rather than `<script>` order in legacy HTML.

- [ ] **Step 6: Run static security and browser integration tests**

```powershell
npm.cmd run build:playhtml-browser
npm.cmd run build:web
node --test tests/server.test.js tests/online-ui-boundary.test.js tests/no-legacy-online-transport.test.js tests/playhtml-bootstrap.test.js
npm.cmd run test:browser-worker-runtime
```

Expected: all PASS; browser test still observes exactly one provider socket per player.

- [ ] **Step 7: Commit**

```powershell
git add server.js package.json package-lock.json apps/web/static tests/server.test.js tests/playhtml-bootstrap.test.js tests/online-ui-boundary.test.js tests/no-legacy-online-transport.test.js tests/browser-worker-runtime.test.js tests/worker-runtime/fixture.js apps/web/src/sessions/online
git add -u tests/game-control-request.test.js tests/game-ui-control-route.test.js
git commit -m "build: serve and verify React production UI"
```

---

### Task 12: Remove Legacy UI Only After Parity and Update Documentation

**Files:**

- Delete: `apps/web/src/legacy/game.js`
- Delete: `apps/web/public/index.html`
- Delete: `apps/web/public/style.css`
- Delete: `apps/web/public/tokens.css`
- Retain or relocate: `apps/web/public/assets/match.jpg` as a design reference only if still useful
- Delete if unused: `apps/web/public/assets/dam.png`
- Delete if unused: `apps/web/public/assets/la.png`
- Delete if unused: `apps/web/public/assets/keo.png`
- Delete or relocate: `apps/web/public/playhtml-game.html`
- Modify: `apps/web/README.md`
- Modify: `apps/web/public/README.md` or delete it with the obsolete directory
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Run a parity checklist before deletion**

Verify manually and in tests:

- AI and same-device modes start and can complete moves;
- create/list/join online paths work in the browser harness;
- waiting, reconnecting, results, leave, clocks, legal highlights, room labels, and player names are present;
- online unavailable leaves local/AI usable;
- every canonical result reason has visible copy;
- all 81 cells have accessible names and visible focus.

Do not delete legacy files if any item fails.

- [ ] **Step 2: Prove legacy assets are unused**

Run:

```powershell
rg -n "legacy/game|public/style.css|public/tokens.css|assets/(dam|la|keo)\.png|apps/web/public" apps packages tests server.js package.json README.md CLAUDE.md
```

Update or remove every valid reference before deletion. Preserve `match.jpg` outside the production bundle only if it remains a documented design reference.

- [ ] **Step 3: Remove obsolete UI files**

Use explicit paths only. Do not remove the entire `apps/web/public` directory recursively until each remaining file has been classified.

- [ ] **Step 4: Update developer documentation**

Document:

- `npm.cmd run dev:web` for the quick demo;
- `npm.cmd run build:web` followed by `npm.cmd start` for production-like static serving;
- `npm.cmd run test:web` and `npm.cmd run typecheck:web`;
- feature/session boundaries;
- demo scenario query keys;
- the prohibition on putting game state into PlayHTML collaborative primitives;
- that UI changes should target focused feature files and shared tokens.

- [ ] **Step 5: Verify and commit cleanup**

```powershell
npm.cmd run build:web
npm.cmd run test:web
npm.cmd run typecheck:web
npm.cmd test
git diff --check
git add apps/web README.md CLAUDE.md
git commit -m "refactor: retire legacy game UI"
```

Expected: all applicable checks pass before commit. If the repository's pre-existing Worker suite has known failures, record exact failing test names and confirm none are introduced by this UI work; do not claim the full suite passes.

---

### Task 13: Desktop Polish, Responsive Baseline, and Final Verification

**Files:**

- Modify: `apps/web/src/shared/theme/tokens.css`
- Modify: `apps/web/src/features/lobby/lobby.module.css`
- Modify: `apps/web/src/features/game/game.module.css`
- Modify: `apps/web/src/app/app.module.css`
- Create: `apps/web/src/test/accessibility.test.tsx`
- Modify: `tests/browser-worker-runtime.test.js` only if diagnostics reveal a real issue

- [ ] **Step 1: Add failing cross-screen accessibility tests**

Test unique landmarks/headings, labeled form controls, result-dialog focus, polite live regions, non-color status text, and all 81 board buttons. Do not add brittle snapshots.

- [ ] **Step 2: Polish the two approved desktop targets**

At 1440x900 and 1280x720 verify:

- the board is the dominant element and remains square;
- both clocks and names stay visible without scrolling;
- the side rail can collapse before the board becomes too small;
- lobby actions remain above the fold;
- text and controls meet comfortable hit sizes.

- [ ] **Step 3: Add only the responsive baseline**

Below the desktop breakpoint, collapse the side rail, stack player/status regions, and let the board fill available width. Do not attempt feature-parity mobile redesign in this task. Use container/media queries and existing tokens; do not fork mobile component markup.

- [ ] **Step 4: Verify reduced motion and keyboard operation manually**

Navigate lobby, select/move a piece, open/close results, and return to lobby using keyboard only. Emulate `prefers-reduced-motion: reduce` and confirm no capture/result animation is required to understand state.

- [ ] **Step 5: Run the complete verification matrix**

```powershell
npm.cmd run build:playhtml-browser
npm.cmd run build:web
npm.cmd run typecheck:web
npm.cmd run test:web
npm.cmd test
npm.cmd run test:browser-worker-runtime
git diff --check
```

Expected:

- frontend build/typecheck/tests pass;
- game-core, server security, client/bootstrap, and browser Worker tests pass;
- no new console errors;
- browser Worker test still reports one provider socket per profile and no polling/secondary collaboration path.

If a pre-existing unrelated test remains red, capture the baseline and final outputs side by side and obtain review before claiming completion.

- [ ] **Step 6: Request code review before merge**

Use `superpowers:requesting-code-review` with the design spec, this plan, the exact verification output, and explicit attention to authority/transport regressions.

- [ ] **Step 7: Commit final polish**

```powershell
git add apps/web/src/shared/theme apps/web/src/features/lobby apps/web/src/features/game apps/web/src/app apps/web/src/test
git commit -m "style: polish desktop game experience"
```

---

## Luna Handoff Checklist

Before marking the work complete, Luna must be able to answer “yes” to all items:

- [ ] Did the implementation start with a runnable fixture-backed demo before integrating sessions?
- [ ] Can local and AI run with online unavailable?
- [ ] Does every UI component depend on typed props/session contracts instead of rules or transport globals?
- [ ] Is `gameCoreBridge.ts` the only frontend bridge to `OTT_RULES`, `OTT_CONFIG`, and `OTT_AI`?
- [ ] Is `runtimeBridge.ts` the only frontend bridge to the minimal PlayHTML runtime/bootstrap/client globals?
- [ ] Is online board state changed only by newer authoritative snapshots?
- [ ] Does the app avoid `@playhtml/react`, `PlayProvider`, shared page/element state, capabilities, presence, cursors, awareness, polling, and a second socket?
- [ ] Are event animations deduplicated by stable IDs?
- [ ] Are online clock ticks display-only and replaced by authoritative snapshots?
- [ ] Do browser tests still observe exactly one provider WebSocket per player?
- [ ] Were legacy files removed only after parity checks passed?
- [ ] Are demo, local, AI, online, accessibility, build, typecheck, server-security, and browser checks recorded with exact results?
