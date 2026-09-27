# React Game UI Redesign Design

**Date:** 2026-09-26

**Status:** Approved in conversation

**Scope:** End-to-end lobby, game table, and result experience

**Primary target:** Desktop and laptop; responsive refinement follows the working demo

## Objective

Replace the current static HTML and imperative DOM UI with a Vite-powered React and TypeScript application. The first milestone must produce a working, rapidly editable demo. Later milestones connect the same UI to local, AI, and online game sessions without allowing presentation code to own rules or authoritative online state.

The design optimizes for continued AI-assisted modification: small files, explicit interfaces, fixture-driven screens, stable visual tokens, and feature boundaries that let a future agent change one area without reading the entire application.

## Product Experience

The application covers the complete flow:

1. Enter the lobby.
2. Choose AI, same-device local play, or online play.
3. Create or join an online room when the online runtime is available.
4. Wait for the second player when necessary.
5. Play on the 9x9 board with clear legal-move, turn, clock, and connection feedback.
6. See the normalized result and return to the lobby or begin another supported session.

Local and AI modes remain available independently of online rollout status. An unavailable online runtime is represented honestly with disabled controls and a concrete status message; the UI must not create a fallback transport or simulate online availability.

## Visual Direction

Use a modern competitive board-game style inspired by contemporary online chess products and game clients:

- dark graphite and blue-black application surfaces;
- a large, restrained board as the primary visual anchor;
- cyan for Seat B and coral/magenta for Seat A;
- circular pieces with legible vector icons for Đấm, Lá, and Kéo;
- compact player panels with name, clock, remaining-piece counts, and turn state;
- short, purposeful motion for selection, legal moves, captures, defeat, and results;
- low visual noise, shallow elevation, and clear focus states rather than heavy neon or fantasy decoration.

The current amber “night zinc print shop” treatment is superseded for the React UI. Existing game terminology remains unchanged.

## Desktop Layout

### Lobby

The lobby uses a two-column desktop composition. The left side establishes the game identity, summarizes the rule loop, and shows a board/piece illustration. The right side contains task-oriented panels:

- quick play: “Đấu với máy” and “Hai người một máy”;
- online: create room, enter a room code, and join;
- public waiting-room list when online listing is available;
- runtime/connection status beside the online controls.

Mode selection must take one obvious action. Secondary information must not compete with the primary buttons.

### Game Table

The 9x9 board is centered and consumes most of the available height. A compact room/connection bar sits above it. Player information is arranged so the opponent is visually above or to the upper-left of the board and the current player below or to the lower-left. A right-side auxiliary rail is reserved for move history, contextual help, chat, or spectator information.

The auxiliary rail is an optional slot, not a dependency of the board. The demo may initially render move history or an empty-state panel. It must be possible to replace the rail without editing board logic.

The board uses CSS Grid, `aspect-ratio: 1`, and a bounded fluid size instead of fixed pixel dimensions. Coordinates remain visible and board cells are semantic buttons. Responsive optimization is deferred until the desktop demo works, but the base layout must not prevent a later one-column/mobile composition.

## Frontend Architecture

The React application lives under `apps/web`. Vite owns development and production bundling. The production static server serves the generated frontend while preserving the existing approved mounts needed by the online adapter and minimal PlayHTML runtime.

Proposed source structure:

```text
apps/web/
├── index.html
├── vite.config.ts
├── tsconfig.json
└── src/
    ├── app/
    │   ├── App.tsx
    │   ├── AppRouter.tsx
    │   └── AppProviders.tsx
    ├── features/
    │   ├── lobby/
    │   ├── game/
    │   └── result/
    ├── sessions/
    │   ├── contract.ts
    │   ├── local/
    │   ├── ai/
    │   ├── online/
    │   └── demo/
    ├── shared/
    │   ├── ui/
    │   ├── icons/
    │   ├── theme/
    │   └── model/
    ├── demo/
    ├── test/
    └── main.tsx
```

Files should have one clear responsibility. Screens compose feature components; feature components receive typed props; session adapters translate domain/runtime data; shared UI primitives contain no game rules.

## Application State

The application shell has a small explicit lifecycle:

```text
boot -> lobby -> preparing -> playing -> finished
                   |            |
                   +-> error <--+
```

Navigation does not require a full routing framework for the first version. The URL may carry a demo scenario or room hint, but screen transitions are driven by application state. A router should be added only when multiple durable URLs become a real requirement.

Session-specific state sits behind a common contract:

```ts
type SessionMode = "demo" | "local" | "ai" | "online";
type SessionPhase = "idle" | "preparing" | "waiting" | "playing" | "finished" | "error";
type Seat = "A" | "B";
type PieceType = "dam" | "la" | "keo";

interface Position {
  x: number;
  y: number;
}

interface PieceView {
  id: string;
  seat: Seat;
  type: PieceType;
  position: Position;
}

interface PlayerView {
  seat: Seat;
  name: string;
  connected: boolean;
  remainingMs: number;
  counts: Record<PieceType, number>;
}

interface GameResultView {
  winner: Seat | null;
  reason: "goal" | "elimination" | "no_moves" | "timeout" |
    "disconnect_timeout" | "leave";
}

interface GameSnapshot {
  mode: SessionMode;
  phase: SessionPhase;
  viewerSeat: Seat | null;
  turn: Seat | null;
  board: readonly PieceView[];
  players: Partial<Record<Seat, PlayerView>>;
  connection: "offline" | "connecting" | "online" | "reconnecting" | "unavailable";
  pendingMove: boolean;
  aiThinking: boolean;
  roomId: string | null;
  result: GameResultView | null;
  events: readonly GameEventView[];
  error: SessionErrorView | null;
}

type StartGameOptions =
  | { mode: "demo"; scenario: DemoScenario }
  | { mode: "local"; playerNames: [string, string] }
  | { mode: "ai"; playerName: string; humanSeat?: Seat }
  | { mode: "online"; intent: "create"; playerName: string }
  | { mode: "online"; intent: "join"; playerName: string; roomId: string };

type MoveResult =
  | { accepted: true }
  | { accepted: false; error: SessionErrorView };

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

React consumes this external store through a dedicated hook based on `useSyncExternalStore`. Components do not inspect which session implementation is active.

`GameEventView` and `SessionErrorView` are discriminated unions defined in the shared model. Every event has a stable monotonic `id` within its session so subscription updates and clock ticks cannot replay an animation. Events cover move/capture/losing-attack and terminal transitions; errors carry a stable code, a Vietnamese user message, and whether retry is allowed. The implementation plan must enumerate their canonical members from the current `game-core`, `Room`, and client event/error surfaces rather than accepting arbitrary strings.

`getLegalMoves` is the only legal-destination input consumed by React. `Board` must not import `game-core`. Local and AI sessions delegate it to the canonical rules module. The online session may use the same canonical pure rules against its latest authoritative snapshot to produce a visual preview, but that preview never authorizes or optimistically applies a move: the Worker remains the sole online validator, and a rejected command leaves the snapshot unchanged. If the public online projection proves insufficient to call the canonical rule function safely, the online session returns no preview until the protocol is explicitly extended; presentation code must not reconstruct rules.

Each session also owns its display-clock publication. Local and AI sessions calculate elapsed time from their session clock. The online session projects remaining time from the latest authoritative clock fields and the server-provided running reference, then performs display-only client ticks between snapshots. Those ticks never commit time, declare timeout, change turn, or generate terminal events; the next Worker snapshot always replaces the estimate.

### Session implementations

- `DemoSession` exposes deterministic fixtures and controlled transitions for UI development.
- `LocalSession` adapts `packages/game-core` state and rule calls for two people on one device.
- `AiSession` composes the local engine with `chooseMove`; it exposes an explicit “AI đang suy nghĩ” phase and prevents concurrent human input.
- `OnlineSession` wraps `PlayhtmlGameClient`, maps validated authoritative snapshots to `GameSnapshot`, and maps React intents back to client commands.

No session duplicates rule constants where a canonical value already exists in `game-core`.

## Core UI Components

### Application shell

- `App`: owns the lifecycle and selected session factory.
- `AppProviders`: theme and global feedback only; it is not a PlayHTML provider.
- `ScreenBoundary`: stable loading and recoverable-error presentation.

### Lobby

- `LobbyScreen`: layout and mode selection.
- `ModeCard`: reusable mode action with title, description, availability, and status.
- `OnlineRoomPanel`: name, create/join controls, runtime status, and room-code validation.
- `WaitingRoomList`: public projections only; loading, empty, error, and populated states.

### Game

- `GameScreen`: composes the table without implementing rules.
- `GameTopBar`: leave action, room identifier, and connection indicator.
- `PlayerPanel`: seat color, player name, active turn, clock, connection status, and counts.
- `Board`: coordinate frame and 81 cells.
- `BoardCell`: semantic button with coordinate label and interaction state.
- `Piece`: seat/type presentation using internal SVG icons.
- `TurnStatus`: persistent turn/wait/reconnect/AI status with `aria-live` where appropriate.
- `GameSideRail`: optional slot with `MoveHistory` as its initial content.

### Result and feedback

- `ResultDialog`: normalized winner/reason data; it never derives game outcome.
- `ToastRegion`: transient confirmations and recoverable errors.
- shared primitives: `Button`, `TextField`, `Badge`, `Panel`, `Dialog`, `Spinner`, and `VisuallyHidden`.

## Board Interaction

The interaction sequence is deterministic:

1. The user selects a controllable piece.
2. The session supplies the legal destinations.
3. The board marks selection and destinations.
4. The user selects a destination.
5. Input is disabled while the session resolves the intent.
6. The next snapshot is rendered.
7. Snapshot events drive transient visual effects.
8. Rejected moves preserve the previous snapshot and show a concise error.

The UI must not optimistically mutate authoritative online board state. It may display a pending affordance, but only the Worker snapshot moves online pieces.

Every square is a `<button>` with an accessible coordinate/type/owner label. Keyboard users can tab to squares and activate them. A later roving-tabindex enhancement is permitted but does not block the first demo.

## Required UI States

Fixtures and production rendering must cover:

- application boot/loading;
- empty lobby and populated waiting-room list;
- online unavailable, connecting, connected, and reconnecting;
- room waiting for the second player;
- active turn and inactive turn;
- selected piece and legal empty/occupied destinations;
- AI thinking;
- move rejected;
- capture and losing-attack event feedback;
- reconnect grace;
- clock warning and timeout;
- results for goal, elimination, no moves, timeout, disconnect timeout, and explicit leave;
- unexpected recoverable session error.

## Demo-First Delivery

The first runnable UI uses `DemoSession` and a scenario switcher enabled only in development. Each scenario renders the real production components with typed fixtures. It is not a separate mockup implementation.

Suggested scenarios:

- `lobby-default`;
- `lobby-online-unavailable`;
- `lobby-rooms`;
- `game-waiting`;
- `game-active-a`;
- `game-piece-selected`;
- `game-ai-thinking`;
- `game-reconnecting`;
- `game-clock-warning`;
- `result-goal`;
- `result-elimination`.

This milestone is accepted when `npm run dev:web` starts a usable desktop demo and the scenarios can be selected without the Worker.

## PlayHTML Decision

PlayHTML is not necessary for React rendering, component state, local play, AI play, or the UI demo. Do not install or use `@playhtml/react` for this redesign. Do not add a `PlayProvider`.

The repository's source-backed minimal PlayHTML/YProvider channel remains only inside the existing online transport boundary. `OnlineSession` may call `PlayhtmlGameClient`; it must not call PlayHTML data, presence, event, cursor, capability, or element APIs.

Specifically prohibited for game state:

- PlayHTML page data;
- element data or `can-play`;
- `can-mirror` or other `can-*` capabilities;
- presence/awareness;
- PlayHTML events;
- a second WebSocket, PartySocket, polling channel, or fallback connection.

Online state remains Worker-authoritative. This preserves the evidence and same-connection constraints documented in `docs/PLAYHTML_AI_GUIDE.md` and `docs/playhtml-upstream-lock.md`.

## Styling and Theming

Use plain, colocated CSS modules or narrowly scoped CSS files plus global theme tokens. Do not introduce a utility CSS framework for the first version.

Tokens cover:

- semantic colors and seat accents;
- board light/dark squares, goals, selection, and legal moves;
- typography scale;
- 4px spacing scale;
- radii, elevation, borders, and focus rings;
- board sizing and desktop panel widths;
- motion duration/easing;
- z-index roles.

Components consume semantic tokens, not raw repeated hex values. Theme changes should primarily edit token files.

Icons for Đấm, Lá, and Kéo should be local SVG React components so they scale crisply and can inherit state colors. Existing PNG assets may remain during transition but are not the target rendering mechanism.

## Accessibility

- Use Vietnamese labels and canonical terminology from `CONTEXT.md`.
- Preserve a logical heading hierarchy.
- Use actual buttons, inputs, lists, outputs, and dialogs.
- Give every board square an accessible coordinate and occupancy label.
- Announce turn, waiting, reconnecting, and result changes without announcing every decorative animation.
- Maintain visible `:focus-visible` styling.
- Do not rely on color alone for seat, selection, legal move, or network state.
- Meet WCAG AA text contrast for primary workflows.
- Disable nonessential movement under `prefers-reduced-motion: reduce`.

## Error Handling

Errors are normalized at the session boundary into user-facing categories. Components do not render raw transport exceptions.

- Validation errors remain beside their input.
- Rejected moves use a transient toast and stable board state.
- Connection state remains visible in the top bar and relevant player status.
- Recoverable session failures offer retry or return-to-lobby actions.
- Fatal initialization failure renders `ScreenBoundary`; local/AI options remain reachable where possible.
- Leaving an online game requires explicit confirmation because it may cause an immediate loss.

## Testing Strategy

Use Vitest, React Testing Library, and `@testing-library/user-event` for the React application. Use Playwright only for a small number of browser flows.

Test behavior and contracts rather than component internals:

- type/fixture builders produce valid snapshots;
- `DemoSession`, `LocalSession`, `AiSession`, and `OnlineSession` satisfy the same contract;
- board selection emits the correct intent and respects disabled/pending states;
- status and result mappings cover all canonical reasons;
- lobby mode availability follows runtime capability;
- keyboard and accessible-name checks cover the board and core forms;
- the demo scenarios render without console errors;
- local and AI browser smoke flows complete a move;
- the existing two-browser online Worker test continues to pass after its selectors are migrated to stable `data-testid`/role-based queries.

Game rules continue to be tested at `rules.applyMove` and `Room.handleMove`; React tests must not duplicate rule algorithms.

## Migration Strategy

Migration is incremental but the final UI has one React root:

1. Add Vite/React/TypeScript and the development demo without deleting the legacy entry point.
2. Build shared model, session contract, fixtures, and the themed application shell.
3. Implement lobby, board/HUD, and result components against `DemoSession`.
4. Integrate local play.
5. Integrate AI play.
6. Wrap the existing online client without changing its transport or authority boundary.
7. Update the static server and browser tests to the Vite production build.
8. Remove `apps/web/src/legacy/game.js` and obsolete static UI markup/styles only after parity checks pass.
9. Perform responsive refinement and production polish after the desktop flow is stable.

Each stage must leave a runnable application. Legacy files are removed only when their replacement is verified.

## Non-Goals for the First Delivery

- mobile parity;
- accounts, matchmaking ranks, or profiles;
- spectator mode implementation;
- persistent move history beyond available session data;
- chat;
- sound system;
- theme marketplace;
- replacing game rules, AI strategy, Worker authority, or the minimal online channel;
- adopting the full upstream PlayHTML React integration.

The layout reserves extension points for these features without implementing them prematurely.

## Acceptance Criteria

- A Vite React TypeScript desktop application runs locally.
- Lobby, game, waiting, reconnecting, AI-thinking, and result views are represented by real components and deterministic demo fixtures.
- Local and AI modes operate through the common session contract.
- Online mode uses only the existing authoritative client/connection path and never stores game state in PlayHTML collaborative primitives.
- The board remains the visual focus and all 81 cells are keyboard-accessible buttons with coordinate-aware labels.
- Core UI state is accessible without relying on color alone.
- The frontend build, unit/component tests, existing game-core tests, server security tests, and applicable browser Worker test pass.
- The legacy imperative UI is removed only after verified feature parity.
- The resulting file boundaries and typed interfaces allow future AI agents to replace individual components or add side-rail features without editing rules or transport code.
