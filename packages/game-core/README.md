# `@ottv2/game-core`

Pure game rules and local game services. This package has no DOM, React,
Worker, PlayHTML, or network dependency.

Canonical sources currently live in `src/`:

- `config.js` — board and timing constants
- `rules.js` — state creation, legal moves, captures, wins, and public state
- `ai.js` — local move selection
- `room.js` — seats, clocks, reconnect grace, and room lifecycle

Consumers should import these modules from this package path. The old root
entrypoints have been removed so there is one source of truth.
