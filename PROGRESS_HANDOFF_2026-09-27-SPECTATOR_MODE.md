# Spectator Mode Handoff

Date: 2026-09-27
Branch: `feat/spectator-mode`
Worktree: `C:\Users\ADMIN\.config\superpowers\worktrees\OTTv2\spectator-mode`
Plan: `docs/superpowers/plans/2026-09-27-spectator-mode.md`
Design: `docs/superpowers/specs/2026-09-27-spectator-mode-design.md`

## Current Status

Implementation is complete through Task 6 of the plan. Task 7, the direct runtime
evidence gate for hibernating presence, was started and then stopped on request.
There is no evidence that spectator production can be enabled.

The canonical online rollout remains `BLOCKED`. No production feature flag,
lobby stream, spectator session, fallback transport, polling, second provider,
or fake connection factory was added.

## Completed

### Tasks 1-2: Contracts And Demos

- Added nullable `ViewerIdentity`, explicit `ViewerCapabilities`, spectator
  count, `PublicMatchView`, spectator session mode/start contract, and safe
  snapshot defaults.
- Updated snapshot producers and normalizers, including malformed online seat
  handling.
- Added deterministic scenarios:
  - `spectator-list`
  - `spectator-active`
  - `spectator-reconnecting`
  - `spectator-finished`
  - `spectator-room-gone`
- Demo scenarios are network/runtime isolated and visibly labeled.
- Generic player `room_unavailable` behavior remains separate from spectator
  room-gone behavior.

### Tasks 3-4: Web UI

- Board interaction is capability-driven and read-only for spectators/null
  viewers.
- Spectator board preserves all 81 accessible cells and blocks pointer,
  touch, and keyboard moves.
- Added neutral spectator labels, live badge/count, reconnect copy, direct
  spectator exit, and neutral terminal result presentation.
- Added separate `PublicMatchList` for active matches. Production active-match
  discovery remains unavailable until a real gateway/runtime source exists.

### Tasks 5-6: Protocol And Game Authority

- Added strict `ott:spectate` parsing.
- Preserved player capability v1 canonical tokens.
- Added seatless spectator capability v2 with separate expectations,
  signatures, TTL, room/purpose binding, and replay protection.
- Added role-aware public projections without credentials, tickets, nonces,
  connection objects, or private Room fields.
- Added immutable per-connection roles and per-connection reservation/generation
  handling.
- Spectator move/leave commands never reach `Room` or player adapter methods.
- Spectator attach/close presence fan-out and join/leave count updates exist in
  the Game server.
- Added a per-room operation queue for Room mutations, close, and alarm paths.
- Terminal projection is attempted before Lobby terminal cleanup; failures keep
  retry state.
- Failed player attach rollback restores the exact pre-attach Room snapshot,
  clock anchor, revision/events, deadlines, and live connections.
- `packages/game-core/src/room.js` and `rules.js` were not modified.

## Verification Evidence

Latest focused Task 6 evidence:

- Authority/storage tests: `64/64` passed.
- Worker TypeScript check: passed.
- Web tests: `190` passed.
- Web typecheck: passed.
- Web build: passed.
- `git diff --check`: passed.

Earlier task evidence includes protocol/auth tests `29/29` passed and the
Task 1-4 web suites passing through `190` tests.

The full repository unit suite is not green in this environment. It reports
pre-existing/legacy PartyKit and Wrangler harness failures, and the Worker
runtime harness can fail to bind local sockets with Windows `os error 10013`.
Do not reinterpret those failures as spectator authority test failures.

## Explicitly Not Done

### Task 7: Hibernating Presence Gate

Not implemented or passed. The required evidence is a deterministic cold wake
of the same original still-open sockets, with an instance-generation change,
original socket enumeration, attachment metadata/nonce proof reconstruction,
player A/B restoration before Room reconciliation, and correct spectator count.

A process restart followed by new reconnects is not evidence. Do not add an
estimated count, persisted authoritative count, fake probe, polling, or
fallback transport. If the pinned Wrangler/workerd runtime cannot force and
prove this condition, record `BLOCKED`, remove incomplete experiments, keep the
feature disabled, and run the plan's green blocked-state matrix.

### Tasks 8-11

Still pending:

1. Active discovery, spectator tickets, durable per-match summary sequence,
   lobby catalog revision, and the read-only `OttLobbyStreamServer`.
2. Dedicated `spectator-test` Worker configuration and authenticated test-only
   socket-close endpoint.
3. Sequential lobby/game provider rebind and disposal evidence. The current
   runtime is single-room-bound and this gate must pass before production
   spectator subscription/session work.
4. `SpectatorSession`, real ticket refresh/reconnect, and App lifecycle
   integration.
5. Multi-profile browser acceptance, documentation, and final rollout guard.

## Important Boundaries

- Current demos and UI are safe to use for rapid iteration but are not online
  production evidence.
- Task 6 intentionally does not reconstruct roles across hibernation; that is
  Task 7's runtime gate.
- The active match list is currently demo-backed only; no production list/ticket
  route exists yet.
- The current branch must not be described as spectator production-ready.
- Local and AI modes remain independent of the blocked online path.

## Commit Range

Implementation starts at `4af6996` and currently ends at `1e96375`.
Important milestone commits:

- `4af6996` viewer contracts
- `1ecedd1` spectator demo scenarios
- `db752fd` read-only spectator UI
- `6863749` public match list
- `d86de41` spectator capability protocol
- `3e0b919` immutable spectator roles
- `d90db96` serialized authoritative mutations
- `1e96375` exact rollback snapshot preservation

The worktree was checked clean after the stopped Task 7 attempt. The main
workspace also contains unrelated pre-existing untracked paths:
`appsweb/`, `opencode.json`, and `stitch_neon_glass_chess_ui/`; they were not
modified or staged.

## Next Action

Start with the Task 7 evidence spike from the plan. Do not implement Task 8 or
enable any spectator production path until Task 7 has a direct runtime result.
