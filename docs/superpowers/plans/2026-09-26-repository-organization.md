# Repository Organization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Introduce the CONFIG.md boundaries while preserving the current browser entrypoint, Worker runtime, and compatibility for existing Node consumers.

**Architecture:** Move reusable game logic into `packages/game-core`, protocol definitions into `packages/protocol`, PlayHTML/client code into `packages/game-client`, browser assets into `apps/web/public`, and Worker code into `apps/worker`. Keep PartyKit as legacy until its remaining adapter dependency is removed.

**Tech Stack:** CommonJS/UMD JavaScript, TypeScript Worker sources, Node test runner, existing static server.

---

### Task 1: Create the target package boundaries

**Files:**
- Create: `packages/game-core/src/`
- Create: `packages/protocol/src/`
- Create: `packages/game-client/src/`
- Create: `apps/web/src/legacy/`
- Create: `apps/worker/README.md`

- [x] Add package boundary documentation and explain which runtime remains transitional.

### Task 2: Relocate game-core modules

**Files:**
- Move: `config.js` -> `packages/game-core/src/config.js`
- Move: `rules.js` -> `packages/game-core/src/rules.js`
- Move: `ai.js` -> `packages/game-core/src/ai.js`
- Move: `room.js` -> `packages/game-core/src/room.js`
- Create: root compatibility entrypoints for existing Node imports.
- Modify: `workers/room-storage.ts` to import game-core from its new location.

- [x] Preserve UMD browser exports and CommonJS imports.
- [x] Verify pure rules and room tests resolve through compatibility entrypoints.

### Task 3: Relocate protocol and client modules

**Files:**
- Move: `workers/protocol.ts` -> `packages/protocol/src/index.ts`
- Create: `workers/protocol.ts` compatibility re-export.
- Move: `playhtml-bootstrap.js` -> `packages/game-client/src/playhtml-bootstrap.js`
- Move: `playhtml-game-client.js` -> `packages/game-client/src/playhtml-game-client.js`
- Move: `game.js` -> `apps/web/src/legacy/game.js`
- Create: browser-compatible root shims for the transitional HTML entrypoint.
- Modify: `index.html`, `playhtml-game.html` script paths.

- [x] Keep one PlayHTML connection and the existing authoritative state boundary.
- [x] Update source-inspection tests to read canonical paths.

### Task 4: Document deferred Worker migration

**Files:**
- Create: `apps/worker/README.md`
- Modify: `README.md`, `CLAUDE.md`, `CONFIG.md` where paths describe the new boundaries.

- [x] Explain why dependent `partykit/` remains at the repository root for now.

### Task 5: Verify the organization

- [x] Run targeted game, client, protocol, and server tests.
- [x] Run `git diff --check`.
- [x] Inspect status and confirm unrelated user changes remain untouched.
