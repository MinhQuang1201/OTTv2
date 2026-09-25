# OTTv2 Rule Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the playable game, server referee, tests, and user-facing rule references conform to `C:\Users\buiho\Downloads\OTTv2-main\OTTv2-main\Rule.md`.

**Architecture:** Keep all gameplay invariants in the pure `rules.js` module and derive both local/AI and online behavior from it. Keep room/server code responsible only for transport and lifecycle, while the browser renders the server/local state and uses the same configured goals and coordinate system.

**Tech Stack:** Node.js 18+, Node built-in test runner, browser JavaScript, HTTP/WebSocket server via `ws`.

**Spec:** `C:\Users\buiho\Downloads\OTTv2-main\OTTv2-main\Rule.md`

## Global Constraints

- The board is 9×9 with files A–I and ranks 1–9.
- A piece moves exactly one square in one of eight directions.
- Same-player destination squares are illegal.
- Opposing pieces of the same type stack and neither is removed.
- Different types resolve as Rock beats Scissors, Scissors beats Paper, Paper beats Rock; the loser is removed and the winner occupies the destination.
- A player wins when any own piece reaches its own goal, or when the opponent has no pieces remaining.
- Red/A wins at A9; Blue/B wins at I1.
- Turns alternate after every non-winning move; the implementation must not invent a draw condition absent from the spec.

---

### Task 1: Lock the corrected rule behavior in tests

**Files:**
- Modify: `tests/rules.test.js`
- Modify: `tests/room.test.js` only if a rule-state contract changes

**Interfaces:**
- Consumes: `config.GOAL`, `rules.createInitialState`, `rules.applyMove`, `rules.detectWinner`, `Room.handleMove`
- Produces: independent regression coverage for goals, full elimination, same-type stacks, combat losses, and alternating turns

- [x] **Step 1: Replace goal examples with `A9` and `I1`**

Use the existing public `applyMove` seam and assert that a piece reaching `A9` wins for A, a piece reaching `I1` wins for B, and a piece reaching the opponent goal does not win.

- [x] **Step 2: Replace type-wipe coverage with full-elimination coverage**

Create a state where one opponent type is gone but other opponent pieces remain and assert no winner. Then capture the opponent's final piece and assert the mover wins with `reason === "elimination"`.

- [x] **Step 3: Add setup-orientation assertions**

Assert A's setup occupies the upper-right area in the Rule.md coordinate system, B's setup occupies the lower-left area, the goals are `A9`/`I1`, and the setup remains 180-degree symmetric.

- [x] **Step 4: Run the focused test file and observe the expected failures**

Run: `node --test tests/rules.test.js`

Expected: the old implementation fails on the corrected goal, elimination, and setup expectations before product code is changed.

### Task 2: Correct the pure rules and configuration

**Files:**
- Modify: `config.js`
- Modify: `rules.js`

**Interfaces:**
- Consumes: existing state shape and public rules API
- Produces: `GOAL`, initial setup, winner detection, and turn progression matching `Rule.md`

- [x] **Step 1: Set the canonical goals and setup orientation**

Set A's goal to `{ x: 0, y: 8 }` (`A9`) and B's goal to `{ x: 8, y: 0 }` (`I1`). Place A's nine-piece setup in the upper-right and retain B as its 180-degree rotation in the lower-left.

- [x] **Step 2: Make winner detection use full elimination**

Keep goal detection first. Then award the opponent only when a seat has zero pieces total; return `reason: "elimination"` and the eliminated seat, without checking per-type counts.

- [x] **Step 3: Remove the un specified draw/turn-skipping rule**

After a non-winning move, always toggle to the other seat. Keep the existing public move validation and combat behavior intact.

- [x] **Step 4: Run the focused tests**

Run: `node --test tests/rules.test.js`

Expected: all rules tests pass.

### Task 3: Propagate the canonical rule state through room, server, AI, and UI

**Files:**
- Modify: `room.js`
- Modify: `server.js`
- Modify: `ai.js` only if goal/state field names require it
- Modify: `game.js`
- Modify: `index.html`

**Interfaces:**
- Consumes: corrected `config.GOAL`, `rules.applyMove`, `rules.publicState`
- Produces: consistent local, AI, and online rendering with no stale draw/type-wipe branches

- [x] **Step 1: Update room/server terminal-state handling**

Treat any `state.winner` as terminal and stop checking for `reason === "draw"`. Broadcast the canonical winner reason without stale `wipeType` semantics.

- [x] **Step 2: Update the browser's goal labels and rendering order**

Read goal coordinates from `config.GOAL`, render rank 1 at the top and rank 9 at the bottom to match `Rule.md`, and use the canonical elimination message.

- [x] **Step 3: Update all local/AI/online terminal checks**

Open the result dialog only for a winner, keep online rendering server-authoritative, and retain the existing interaction behavior.

- [x] **Step 4: Run syntax and focused tests**

Run: `node --check rules.js; node --check room.js; node --check server.js; node --check game.js; npm test`

Expected: syntax checks and all tests pass.

### Task 4: Synchronize repository documentation and terminology

**Files:**
- Modify: `CONTEXT.md`
- Modify: `CLAUDE.md`
- Modify: `PRODUCT.md`
- Modify: `README.md`
- Modify: `DESIGN.md`

**Interfaces:**
- Consumes: final rule constants and state semantics
- Produces: no repository document claiming `a1/i9`, one-type extinction, or rank 9-to-1 top-down rendering

- [x] **Step 1: Update goals, setup orientation, and elimination wording**

Replace stale `a1/i9` and one-type extinction claims with `A9/I1` and full removal of the opposing player's pieces.

- [x] **Step 2: Update coordinate/rendering terminology**

Document rank 1 at the top, rank 9 at the bottom, and preserve A/B as seats mapped to Red/Blue.

- [x] **Step 3: Search for stale rule claims**

Run: `rg -n "a1|i9|A9|I1|tuyệt chủng một loại|hết quân|reason === \"draw\"|wipeType|rank 9→1|rank 1→9" -g '!node_modules' .`

Expected: only canonical `A9`/`I1` and intentional compatibility field references remain; no stale one-type win behavior remains.

### Task 5: Verify end-to-end behavior

**Files:**
- No product files unless a verification failure identifies a remaining owner

**Interfaces:**
- Consumes: completed implementation and tests
- Produces: fresh evidence for core rules, server room flow, static app boot, and remaining risk

- [x] **Step 1: Run the complete automated suite**

Run: `npm test`

Expected: zero failures.

- [x] **Step 2: Run a server smoke check**

Run: `node server.js` in a temporary process and request `http://localhost:3000/`; verify the response is the OTTv2 page, then terminate the process.

- [x] **Step 3: Attempt rendered frontend validation**

Check for the repository/browser automation path. If no browser plugin or Playwright runtime is available, record that limitation precisely rather than claiming screenshot validation.

- [x] **Step 4: Re-scan the rule matrix**

Compare each numbered rule in `Rule.md` against `config.js`, `rules.js`, `room.js`, `game.js`, and the tests; report any rule not mechanically testable or any remaining ambiguity about exact initial coordinates.
