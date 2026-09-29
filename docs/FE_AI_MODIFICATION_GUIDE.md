# OTTv2 FE AI Modification Guide

Tài liệu này là runbook cho AI hoặc kỹ sư cần đọc, sửa giao diện và thay đổi
logic phía frontend của OTTv2. Phạm vi chính là `apps/web`; một số boundary ở
`packages/game-core`, `packages/game-client` và `apps/worker` được mô tả để tránh
sửa sai lớp sở hữu.

## 1. Bối cảnh bắt buộc

OTTv2 là game bàn cờ 9 x 9. Luật canonical nằm trong
`packages/game-core/src/rules.js`. UI không được tự quyết định nước đi, kết quả,
đồng hồ authoritative hoặc state online. FE chỉ:

- Nhận `GameSnapshot` từ một `GameSession`.
- Hiển thị snapshot.
- Thu thập thao tác người dùng rồi gọi các phương thức của session.
- Hiển thị trạng thái đang chờ, lỗi, reconnect và kết quả.

Online chỉ được coi là state authoritative từ Worker/Room. Không thêm WebSocket,
polling, PlayHTML page data, element data, presence, cursor, event hoặc
transport dự phòng để đồng bộ ván đấu.

## 2. Cây thư mục cần biết

```text
apps/web/
  src/main.tsx                         # React/Vite entry
  src/app/
    App.tsx                            # app lifecycle, session selection, screens
    AppProviders.tsx                   # toast/provider boundary
    ScreenBoundary.tsx                 # error/retry/lobby boundary
    app.module.css                     # app shell
  src/features/
    lobby/                             # name, local/AI/online entry points
    game/                              # board, player HUD, turn, history, leave
    result/                            # result dialog
    chat/README.md                     # reserved, not implemented
    spectator/README.md                # reserved, not implemented
  src/sessions/
    contract.ts                        # GameSession and StartGameOptions
    useSessionSnapshot.ts              # React subscription adapter
    local/LocalSession.ts               # same-device rules + clock
    ai/AiSession.ts                     # LocalSession + delayed AI move
    online/OnlineSession.ts             # authoritative online client adapter
    online/OnlineLobbyGateway.ts        # create/join/list room boundary
    online/runtimeBridge.ts             # only runtime connection seam
    online/normalizeOnlineState.ts      # validate/normalize server messages
    core/gameCoreBridge.ts              # only browser bridge to game-core globals
    core/normalizeCoreState.ts          # core state -> UI snapshot
    demo/                               # deterministic fixtures/scenarios
  src/shared/
    model/game.ts                       # all FE state/view types
    model/format.ts                     # square, clock, result labels
    ui/                                 # reusable controls/dialog/toast primitives
    theme/                              # reset, global CSS, design tokens
    icons/                              # reusable SVG/icon components
  src/demo/                             # query-driven demo scenario switcher
  src/accessibility/                    # cross-screen accessibility contract
  static/playhtml-game.html             # diagnostic adapter page, not game UI

packages/game-core/src/
  rules.js                              # canonical rules/state transitions
  room.js                               # authoritative room/clock/reconnect
  ai.js                                 # canonical AI chooser

packages/game-client/src/
  playhtml-game-client.js               # ott:* adapter to online runtime
  playhtml-bootstrap.js                 # runtime bootstrap
```

## 3. Runtime data flow

### 3.1 App boot and screen selection

`main.tsx` renders `App`. `App` creates a session, subscribes through
`useSessionSnapshot`, and maps the session snapshot to an `AppState`:

```text
session.getSnapshot()
        |
useSessionSnapshot(session)
        |
App reducer: stateForSnapshot()
        |
LobbyScreen | GameScreen | error boundary | boot panel
```

Important `AppState.status` values:

- `boot`: session is being created or restarted.
- `lobby`: snapshot phase is `idle`.
- `preparing`: session is connecting/preparing.
- `playing`: active non-terminal game.
- `finished`: snapshot contains a valid result.
- `error`: safe, user-facing session error.

`generation` prevents updates from an old/disposed session overwriting a newer
session. Do not remove generation checks when changing lifecycle code.

The entry callbacks are in `App.tsx`:

- `onStartLocal(names)` creates `LocalSession`.
- `onStartAi(name)` creates `AiSession`.
- `startOnline(options)` creates `OnlineSession`.
- `onLobby()` disposes/restarts into the lobby scenario.

### 3.2 Session contract

Every game mode must implement `GameSession` from `src/sessions/contract.ts`:

```ts
interface GameSession {
  getSnapshot(): GameSnapshot;
  subscribe(listener: () => void): () => void;
  start(options: StartGameOptions): Promise<void>;
  getLegalMoves(from: Position): readonly Position[];
  move(from: Position, to: Position): Promise<MoveResult>;
  leave(): Promise<void>;
  dispose(): void;
}
```

The feature layer must use this contract, not concrete session internals.
Changing a session implementation normally requires session unit tests, not UI
state hacks.

### 3.3 Snapshot contract

`GameSnapshot` in `src/shared/model/game.ts` is the FE view model. Key fields:

- `mode`: `demo`, `local`, `ai`, `online`.
- `phase`: `idle`, `preparing`, `waiting`, `playing`, `finished`, `error`.
- `boardRevision`: changes when occupancy, turn, or terminal state changes.
- `viewerSeat`: seat controlled by this browser, or `null` for local/demo context.
- `turn`: seat whose turn it is, or `null` after game end.
- `board`: flat `PieceView[]`; each piece has one position.
- `players`: partial map of A/B player data, clock and counts.
- `connection`: offline/connecting/online/reconnecting/unavailable.
- `pendingMove`: online command sent but authoritative result not received.
- `aiThinking`: AI delay/turn is in progress.
- `roomId`: online room id or `null`.
- `result`: terminal winner/reason or `null`.
- `events`: normalized move/capture/loss/win events.
- `error`: normalized session error or `null`.

Do not add feature-specific fields to `GameSnapshot` casually. If a field is
shared by multiple modes, add it to the model and update every session's
normalization path and tests.

## 4. Feature map and safe edit points

### 4.1 Lobby

Entry: `features/lobby/LobbyScreen.tsx`.

- Stores the player name locally and persists it through `playerNameStorage.ts`.
- `ModeCard` starts same-device or AI mode through callbacks.
- `OnlineRoomPanel` owns create/join form validation and waiting-room controls.
- `WaitingRoomList` renders rooms and selection behavior.
- `lobby.module.css` owns layout and lobby-only visual rules.

Edit here when changing labels, form layout, mode cards, online room controls or
name handling. Do not instantiate a session in a lobby component. Do not call a
Worker or PlayHTML API directly from a feature component.

Name rule: trim before starting a session. Empty names are accepted by the UI;
session implementations provide the display fallback. Room id must be nonempty
before `onJoin` is called.

### 4.2 Game screen

Entry: `features/game/GameScreen.tsx`.

Responsibilities:

- Reads the current snapshot using `useSessionSnapshot`.
- Shows top bar, players, turn status, board and move history.
- Converts session events into short visual effects.
- Opens result dialog when `snapshot.result` appears.
- Uses confirmation only for online leave; local/AI leave immediately.

Subcomponents:

- `GameTopBar`: room and connection badge, leave action.
- `PlayerPanel`: player identity, connection, clock, piece counts.
- `TurnStatus`: turn, waiting, reconnecting and AI-thinking copy.
- `Board`: creates exactly 81 cells and maps pieces by `x:y`.
- `BoardCell`: accessible button, coordinate/test attributes, piece/legal state.
- `useBoardSelection`: two-click source/destination interaction.
- `MoveHistory`: normalized event list excluding win events.
- `ConfirmLeaveDialog`: online leave confirmation.

### 4.3 Board interaction

`Board` must remain a renderer. Selection semantics live in
`useBoardSelection.ts`:

1. `canInteract` requires `phase === "playing"`.
2. The viewer must exist and it must be the viewer's turn.
3. No pending move, AI thinking, or reconnecting state.
4. Selecting a friendly piece calls `session.getLegalMoves(position)`.
5. Selecting a legal destination calls `session.move(from, to)`.
6. Accepted moves are rendered after the session publishes a new snapshot.
7. Rejected moves go to `onError`; the hook does not invent a new state.

`BoardCell` accessibility and selectors are part of the contract:

- Exactly 81 buttons.
- `data-testid="board-cell-A3"` style square id.
- `data-x` and `data-y` are zero-based coordinates.
- `aria-label` includes square, piece type/seat, selected and legal state.
- Use `aria-pressed` for selected state.

Do not change coordinate orientation without updating rules, tests, accessible
labels and any browser tests together.

### 4.4 Result

`ResultDialog` consumes only `result`, `viewerSeat`, and player names. Result
reason labels come from `shared/model/format.ts`. Add a new result reason in the
canonical model/rules first, then update formatting, session normalization,
dialog tests and demo fixtures.

## 5. Session implementations

### LocalSession

`LocalSession` owns same-device game progression:

- Obtains the core bridge through `getGameCoreBridge()`.
- Creates initial core state on `start`.
- Calls core `applyMove` for every move.
- Calls core `elapseClock` on its interval.
- Converts core state/events into `GameSnapshot`.
- Stops its timer on finish or dispose.

Never duplicate rules in `LocalSession` or in a component. If a move rule is
wrong, fix/test `packages/game-core/src/rules.js`.

### AiSession

`AiSession` wraps `LocalSession`:

- Human is A by default, AI is B by default.
- After a valid human move, it sets `aiThinking` and schedules a delayed move.
- AI selection is injected through `chooseMove` in tests or uses the core AI.
- `dispose` cancels the timeout and the local subscription.

To change AI delay, inject/configure `delayMs`; do not use arbitrary component
timeouts. To change AI strategy, change the core AI boundary or the injected
chooser, not the board component.

### OnlineSession

`OnlineSession` is an adapter, not an authority:

1. `OnlineLobbyGateway` creates, joins or lists rooms.
2. Runtime/client attaches to an allocated room.
3. Client events (`joined`, `state`, `gameover`, `reconnecting`, `error`) update
   the session.
4. `normalizeOnlineState` validates untrusted payloads and creates a snapshot.
5. `move` sends a command and marks `pendingMove`; it does not mutate the board.
6. The Worker state message is the source of truth.

Online move legality may be used for selection hints through the bridge, but the
server remains authoritative. Never treat a successful `client.move()` call as a
confirmed move; only the next authoritative state confirms it.

`runtimeBridge.ts` is the only active connection seam. The factory is
`OTT_PLAYHTML_CONNECTION_FACTORY`. If runtime evidence is unavailable, online
must remain unavailable while local and AI remain usable.

## 6. Core and authority boundaries

### Allowed from FE

- Read canonical core functions through `gameCoreBridge.ts`.
- Render legal-move hints returned by the session.
- Send an online move command via `OnlineSession`.
- Normalize and reject malformed online state payloads.
- Show optimistic transport status such as `pendingMove`.

### Forbidden in FE

- Reimplement movement, capture, strike-loss, goal, elimination, no-moves or
  timeout rules in React/CSS/session UI code.
- Choose or mutate online board state locally.
- Create a second WebSocket, polling loop or fake transport.
- Put game state in PlayHTML shared page/element data, presence, awareness,
  cursor or events.
- Import Worker/Room internals directly into feature components.

If a requirement changes game semantics, edit `packages/game-core` and its tests,
then update the FE normalization/UI only as needed.

## 7. Shared UI and styling rules

Reusable primitives are in `src/shared/ui`:

- `Button`: variants and disabled behavior.
- `TextField`: label, error and input semantics.
- `Panel`: common surface/container.
- `Badge`: status indicator.
- `Dialog`: focus/close behavior.
- `ToastRegion` and `useToasts`: transient user feedback.
- `Spinner` and `VisuallyHidden`: loading/accessibility helpers.

Use these before creating a feature-specific duplicate. Feature CSS modules are
co-located with features. Global values belong in:

- `theme/reset.css`: browser reset.
- `theme/global.css`: document-level layout/type defaults.
- `theme/tokens.css`: surfaces, seats, board colors, spacing, typography,
  radii, shadows, motion and z-index.

Use token variables instead of repeating seat/board colors. Keep board geometry
explicit: a 9 x 9 board must declare both
`grid-template-columns: repeat(9, 1fr)` and
`grid-template-rows: repeat(9, 1fr)`, and preserve `aspect-ratio: 1`.

Responsive breakpoints currently target desktop, medium (`1080px`) and mobile
(`760px`). After layout changes, inspect at least 1910x906, 1080px and a narrow
mobile viewport.

## 8. Accessibility and test selectors

Preserve semantic controls and accessible names:

- Use real `<button>` and `<input>` controls.
- Every input has a visible or associated label.
- Dialog focus behavior belongs to `Dialog`; do not bypass it.
- Status/reconnect messages should remain readable by assistive technology.
- Board cells must keep 81 keyboard-operable buttons.
- Avoid using CSS-only text to communicate state.

Stable selectors already used by tests include:

- `[data-testid="app-state"]` with `data-state`.
- `[data-testid="game-screen"]`.
- `[data-testid="room-label"]`.
- `[data-testid^="board-cell-"]`.
- `[data-testid="board-cell-A3"]`.
- Accessible labels such as `Tên của bạn`, `Đánh với AI`, `Chơi cùng máy`,
  `Rời bàn`, `Bàn chơi`.

If a selector must change, update all related tests and explain why. Prefer role
and accessible-name assertions over implementation selectors.

## 9. Demo scenarios and debugging

The query-driven demo switcher is deterministic and intended for UI diagnostics,
not production transport. Supported scenario keys are defined in
`src/shared/model/game.ts`, with fixtures in `sessions/demo`:

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

Use demo fixtures to inspect visual states and accessibility without changing
session behavior. Use `LocalSession`/`AiSession` tests for actual interactions.

## 10. Change recipes

### Change a label or visual layout

1. Find the owning feature component.
2. Change the component text/markup or its co-located CSS module.
3. Reuse shared UI primitives and theme tokens.
4. Preserve roles, labels, test ids and responsive behavior.
5. Run the relevant component test, then `test:web` and `typecheck:web`.

### Add a new board visual state

1. Confirm the state already exists in `GameSnapshot` or add it to the shared
   model only if it is truly cross-mode.
2. Derive presentation in `Board`, `BoardCell`, `TurnStatus` or `GameScreen`.
3. Add a CSS module class using tokens.
4. Add a demo fixture if the state is difficult to reach deterministically.
5. Test mouse/keyboard behavior and accessible announcement.

### Change a user action

1. Identify the public callback from `App` to the feature.
2. Keep the feature callback-only; do not construct a session there.
3. Change session behavior behind `GameSession` when the action changes state.
4. Ensure `dispose`, stale generations and error handling remain correct.
5. Add/adjust session tests and a feature integration test.

### Add a new game rule or result

1. Update canonical core rules/config and core tests first.
2. Update `GameResultView`, `ResultReason` or event types if needed.
3. Update core normalization and online normalization.
4. Update result formatting and UI.
5. Update local, AI, online and demo tests as applicable.

### Change online behavior

1. Read `docs/PLAYHTML_AI_GUIDE.md` and `docs/playhtml-upstream-lock.md`.
2. Identify whether the change belongs to gateway, runtime bridge, client adapter,
   state normalization or UI.
3. Preserve server authority and the single connection seam.
4. Validate malformed payloads and revision ordering.
5. Run online session tests plus browser/worker runtime tests when available.

## 11. Verification commands

Run from repository root:

```powershell
npm.cmd run test:web
npm.cmd run typecheck:web
npm.cmd run build:web
```

For broader regressions:

```powershell
npm.cmd test
npm.cmd run test:browser-worker-runtime
```

The browser-worker test may require its runtime prerequisites and is distinct
from the deterministic React tests.

For visual/UI work, also run the app and inspect both dev and production-like
serving:

```powershell
npm.cmd run dev:web
npm.cmd run build:web
npm.cmd start
```

Use Playwright or browser devtools to check:

- Console/page errors.
- Board has 81 cells.
- Board and each cell are square.
- Keyboard can focus and activate cells.
- Mobile layout does not overflow horizontally.
- AI mode disables input while `aiThinking` is true.
- Online mode never changes board before authoritative state arrives.

## 12. AI operating checklist

Before editing:

- Read this guide, `apps/web/README.md` and the feature README.
- Locate the owning layer and inspect its tests.
- Check `git status`; do not revert unrelated worktree changes.
- Decide whether the request is presentation, session behavior, core rule or
  online authority.

While editing:

- Make the smallest change at the correct boundary.
- Keep UI stateless with respect to game authority.
- Preserve public types, selectors and accessibility unless intentionally changed.
- Add a failing/contract test for behavior changes before implementation when
  practical.
- Do not add compatibility code without a concrete persisted/external consumer.

Before reporting completion:

- Run the relevant tests, typecheck and build.
- Inspect the actual rendered UI for visual changes.
- Check all supported session modes affected by the change.
- Report changed files, root cause, verification output and any remaining gap.

## 13. Common wrong approaches

| Wrong approach | Correct approach |
| --- | --- |
| Put move legality in `Board.tsx` | Ask `session.getLegalMoves()` |
| Mutate board after an online click | Set `pendingMove`; wait for state message |
| Start a WebSocket from a component | Use `OnlineSession` and its runtime seam |
| Add a new color literal in feature CSS | Use `tokens.css` |
| Use a div as a board cell | Keep an accessible button |
| Fix a core rule in `useBoardSelection` | Fix `packages/game-core/src/rules.js` |
| Add arbitrary `setTimeout` to hide state | Model state in the session or use event-driven UI |
| Treat demo fixture as production behavior | Change the real session and keep fixture deterministic |
| Ignore `dispose` when replacing sessions | Cancel timers, unsubscribe and close clients |
| Remove generation guards as “unnecessary” | Keep them to reject stale session updates |
