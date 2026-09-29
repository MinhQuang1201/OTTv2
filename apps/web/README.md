# Web application

The React application is rooted at `apps/web`, with `index.html` as its Vite
entrypoint. Vite copies only `apps/web/static` into the build, and `server.js`
serves the resulting `apps/web/dist` directory. The retained
`static/playhtml-game.html` page is an adapter diagnostic page, not a second game
UI.

## Development and verification

```powershell
npm.cmd run dev:web
npm.cmd run build:web
npm.cmd start
npm.cmd run test:web
npm.cmd run typecheck:web
```

Use `dev:web` for the fast local demo. Use `build:web` followed by `start` to
exercise production-like static serving. `test:web` runs focused React and
session tests; `typecheck:web` validates the TypeScript boundary.

Demo scenarios are enabled with query keys such as `?demo=result-goal`,
`?demo=result-elimination`, `?demo=result-no-moves`, `?demo=result-timeout`,
`?demo=result-disconnect-timeout`, `?demo=result-leave`, and
`?demo=game-reconnecting`. They are fixture-backed diagnostics, not a transport
or game-authority implementation.

## Boundaries

- `src/features/` owns React presentation and user interaction.
- `src/sessions/local/` and `src/sessions/ai/` own same-device session behavior.
- `src/sessions/online/` owns the client adapter for the authoritative Worker.
- `src/sessions/core/gameCoreBridge.ts` is the only browser bridge to game-core
  globals; the UI does not implement rules or choose online moves.
- `packages/game-core` remains the canonical rules, Room, clock, and AI source.
- `apps/worker` remains the online authority. Local and AI modes must continue to
  work when online is unavailable.

Do not put game state in PlayHTML page data, element data, capabilities, presence,
cursors, awareness, or events. Do not add polling, a second WebSocket, a fake
connection factory, or a fallback transport. The only connection seam is
`OTT_PLAYHTML_CONNECTION_FACTORY`, and it remains unavailable until the required
runtime evidence exists. Focus UI changes in the relevant feature/session file and
use shared theme tokens rather than reviving the deleted public UI.
