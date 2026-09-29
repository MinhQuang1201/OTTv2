# Spectator Mode Design

## Status

Approved design. This document defines the spectator-mode MVP for OTTv2.

The existing online production rollout remains gated by
`docs/playhtml-upstream-lock.md`. Spectator mode does not relax that gate and
must not add a fallback WebSocket, polling transport, second PlayHTML session,
or fake production connection factory. Deterministic spectator demos are UI
development aids, not production-readiness evidence.

## Goals

- Let anonymous visitors discover and watch active online games in real time.
- Show a real-time spectator count in the lobby and game screen.
- Keep spectators strictly read-only and outside player-seat lifecycle logic.
- Reconnect spectators automatically without reserving identity or a seat.
- Reuse the authoritative game snapshot and existing game UI.
- Make each layer small and contract-driven so AI-assisted changes can be
  tested and demonstrated independently.

## Non-Goals

- Watching waiting rooms or archived games.
- Replay or long-term game retention.
- Spectator chat, names, profiles, moderation, or a viewer roster.
- A product-level hard cap on spectators per game.
- Hidden-information protection or delayed broadcasts. Games are shown live.
- New roles such as moderator, commentator, or replay viewer.
- Enabling online production before its existing evidence gates pass.

## Product Decisions

- Every online game in `playing` state is listed publicly and automatically.
- Waiting and terminal games are not listed.
- A spectator does not enter a name.
- Spectators receive live authoritative updates without intentional delay.
- Each authenticated spectator connection or browser tab counts as one viewer.
- Leaving spectator mode never affects the game.
- A spectator who loses the connection automatically reconnects and
  resynchronizes to the latest revision.
- On game completion, the spectator sees a neutral result dialog and may close
  it to inspect the final board or return to the lobby.

## Architecture

### Chosen Approach

Spectators connect to the same Game Durable Object and the same approved
PlayHTML/YProvider real-time channel as players. They receive a separate,
short-lived spectator capability and a role-specific public projection.

This keeps one game authority and one snapshot stream. A separate broadcast
Durable Object was rejected for the MVP because it would add synchronization,
failure, and stale-state paths. HTTP polling was rejected because it does not
meet the real-time presence requirement and conflicts with the current online
transport guardrails.

### Authority Boundary

`packages/game-core/src/room.js` remains a two-seat authority. Spectators are
never inserted into `Room.players` and never participate in:

- seat assignment;
- legal-move checks;
- clocks;
- reconnect grace;
- leave/disconnect outcomes; or
- winner determination.

The Game Durable Object owns authenticated spectator connections, presence,
command authorization, and role-specific fan-out around the `Room` authority.

Each live connection has exactly one immutable authenticated identity. Its
first successful player attach or spectator attach fixes that identity until
the connection closes. Repeated attach, repeated spectate, and player-to-
spectator or spectator-to-player role-switch attempts are rejected before a
new capability is consumed. These attempts cannot change presence or call
`Room`.

### Viewer Identity

The system represents viewer identity explicitly rather than inventing a third
seat or relying only on `viewerSeat === null`:

```ts
type ViewerIdentity =
  | { role: "player"; seat: "A" | "B" }
  | { role: "spectator" };
```

UI state also exposes explicit capabilities. Components do not infer write
permission from missing seat data:

```ts
interface ViewerCapabilities {
  readonly canMove: boolean;
  readonly canLeaveGame: boolean;
  readonly canSpectate: boolean;
}
```

For a spectator, `viewerSeat` remains `null`, `canMove` and `canLeaveGame` are
false, and `canSpectate` is true.

## Access And Protocol

### Spectator Capability

The Lobby Durable Object issues a short-lived, signed capability bound to:

```ts
{
  allocationId,
  roomId,
  purpose: "spectate",
  role: "spectator",
  issuedAt,
  expiresAt,
  nonce
}
```

The capability is valid only for its allocation and room. Its purpose cannot
be interpreted as a player attach capability. The nonce is consumed once to
prevent replay. The capability carries no spectator name or durable identity.

The exact payload should extend the existing capability implementation rather
than create a second signing mechanism. If the existing discriminated union
cannot express a role without weakening its `seat` invariant, spectator and
player payload variants must be separate union members; do not use a fake
`seat: "S"`.

### Commands

Add one spectator attach intent:

```ts
type SpectatorCommand = {
  __ott: true;
  roomId: string;
  type: "ott:spectate";
  ticket: string;
};
```

After successful attach, a spectator has no mutating command. If the connection
sends `ott:move` or `ott:leave`, the Game Durable Object returns an authorization
error without calling `Room.handleMove`, `Room.leavePlayer`, or another Room
mutation. Unknown fields, malformed coordinates, oversized payloads, and
cross-room envelopes remain rejected by the shared protocol parser.

`ott:spectate` is valid only as the first successful role assignment on a live
connection. A connection with either authenticated role cannot attach again or
switch roles, even with another otherwise valid capability.

### Public Game Projection

The spectator response uses the existing OTT response envelope and carries a
role-appropriate public projection:

```ts
interface SpectatorGameProjection {
  readonly roomId: string;
  readonly status: "playing" | "finished";
  readonly revision: number;
  readonly serverNow: number;
  readonly players: PublicPlayers;
  readonly state: PublicGameState;
  readonly events: readonly PublicGameEvent[];
  readonly spectatorCount: number;
}
```

The projection contains only information required to render the public game.
It must never contain resume credentials, attach tickets, capability payloads,
nonces, connection objects, Durable Object storage records, or private runtime
state.

Projection should be a pure function of a room payload, viewer identity, and
spectator count. This makes disclosure rules testable without a running Worker.

## Public Match Discovery

### Match Summary

The lobby exposes active public games separately from waiting rooms. A summary
contains only:

- allocation and room identifiers needed by the watch flow;
- player A and B public names and connection state;
- displayed remaining time for both players;
- `playing` status; and
- the latest spectator count.

The response does not contain any owner credential or ticket. Terminal games
are removed from the public list as part of the authenticated lifecycle update.

### Count Propagation

The game screen receives the count directly from the Game Durable Object and is
the real-time source of truth. The lobby list may show a slightly delayed count.
The Game Durable Object must publish count changes to the lobby through an
authenticated, durable-compatible route; a process-local map is not an
acceptable source for the public list.

The implementation plan must choose the smallest mechanism compatible with the
existing lifecycle authorization. Count updates may be coalesced to avoid a
write for every rapid connect/disconnect burst, but the eventual terminal
lifecycle update must remove the match from discovery.

While the lobby is visible, one lobby subscription receives active-match and
coalesced count updates over the approved provider/runtime lifecycle. Entering
a game disposes that lobby subscription before creating the game subscription;
returning to the lobby disposes the game subscription before recreating and
resynchronizing the lobby subscription. Lobby and game provider sessions must
not coexist, and no polling or second fallback transport is introduced. The
implementation must prove this lobby subscription on the approved runtime
before realtime counts can be enabled outside deterministic demos.

## Presence

- Presence is the number of currently authenticated spectator connections.
- Presence is ephemeral and is not part of `Room` persistence.
- Increment occurs only after a spectator attach capability is verified and
  consumed successfully.
- Decrement occurs when that authenticated connection closes.
- Failed or duplicate attach attempts do not change the count.
- Refreshes and multiple tabs may temporarily change the count; the MVP does
  not attempt to identify unique humans.
- Authenticated role metadata must be stored in runtime-supported live socket
  attachments. After hibernation or restart, the Game Durable Object rebuilds
  presence by enumerating current attachments and counting only valid spectator
  roles; it never restores a persisted scalar count.
- Close processing is idempotent and count cannot become negative, including
  close/wake races and repeated close notifications.

Realtime spectator counting is gated on direct evidence that the approved
runtime preserves and enumerates authenticated socket attachment metadata
across hibernation. If it cannot, spectator mode remains disabled outside demos
until a reviewed same-runtime solution exists; the implementation must not
estimate presence or weaken the count semantics.

There is no product-visible maximum spectator count. Infrastructure still
applies rate limits to listing and ticket issuance, edge abuse protection, and
controlled overload rejection. These operational safeguards are not presented
as spectator seats.

## Data Flow

### Entering A Game

1. The web app requests the public active-match list from the lobby.
2. The lobby returns only `playing` match summaries.
3. The visitor selects **Xem trận** without entering a name.
4. The web app requests a spectator ticket for that allocation.
5. The lobby confirms the allocation is still `playing` and issues a
   room-bound, short-lived `spectate` capability.
6. `SpectatorSession` connects through the existing runtime bridge and sends
   `ott:spectate` over the same approved provider channel.
7. The Game Durable Object verifies and consumes the capability, registers the
   connection as a spectator, updates presence, and sends the latest
   authoritative projection.
8. Subsequent game revisions fan out a player projection to each player and a
   spectator projection to each spectator.

A race in which the selected game becomes terminal before ticket issuance or
attach returns a typed room-unavailable/terminal result. The client refreshes
the list and provides a direct route back to the lobby.

### Reconnection

`SpectatorSession` retains the last valid snapshot while showing a reconnecting
overlay. It first follows the existing transport reconnect behavior. If attach
requires a new one-use ticket or the ticket expired, it requests a fresh
spectator capability from the lobby and attaches again.

On successful reattach, the session accepts the current authoritative snapshot
and resumes normal revision ordering. It does not reserve a spectator identity,
start a 60-second grace period, or mutate the game clock. Stale, malformed, or
cross-room snapshots remain rejected.

If the game became terminal while disconnected, terminal delivery is
best-effort: an already queued/fetched final snapshot may be displayed, but the
MVP does not retain a terminal room or issue a new spectator ticket solely to
recover the result. Otherwise the client displays **Trận đấu không còn khả
dụng** and offers **Về sảnh**.

### Game Completion

When the Room commits a terminal revision, the Game Durable Object synchronously
queues that revision to spectators that are attached at that moment before it
starts normal reclamation and before the lobby removes the match from discovery.
This guarantees the server send attempt, not network delivery. New spectator
tickets are no longer issued for the terminal allocation, and the MVP adds no
terminal-retention or archive period. An attached client that receives the
revision shows a neutral result dialog; a disconnected client follows the
best-effort rule above.

## Web Session And UI

### Session Boundary

Create a dedicated spectator session adapter rather than adding spectator
branches throughout `OnlineSession`. The adapter implements the common session
contract needed by shared game components, but its write operations always
return a read-only rejection and never send a player command.

The expected boundary is:

```text
public match summary -> spectator allocation/ticket
spectator projection -> normalized GameSnapshot
GameSnapshot + viewer capabilities -> shared game UI
```

`SpectatorSession` owns ticket acquisition, attach, revision ordering,
normalization, display-clock interpolation, reconnect, and disposal. It does
not contain game rules.

### Lobby

The Online panel contains a distinct **Trận đang diễn ra** section, separate
from **Phòng đang chờ**. Each match row shows A versus B, clocks, spectator
count, and **Xem trận**. Separating the lists prevents confusion between taking
a player seat and entering read-only mode.

Only active games appear. When a match disappears during selection, the UI
shows a friendly unavailable message and refreshes discovery.

### Game Screen

Reuse `GameScreen`, `Board`, `PlayerPanel`, `MoveHistory`, and `ResultDialog`.
Do not fork a second board UI. Small spectator-specific components may provide:

- a **Đang xem trực tiếp** badge;
- the spectator count;
- neutral turn copy; and
- reconnect/unavailable messaging.

Spectator behavior differs from player behavior as follows:

- The exit action is **Rời chế độ xem** and returns directly to the lobby.
- No leave-forfeit confirmation is shown and no `ott:leave` is sent.
- All 81 board cells retain accessible names but are not selectable.
- Pointer, touch, and keyboard input cannot request legal moves or send moves.
- The UI does not show pending-move state or "your turn" language.
- Neither player panel marks the spectator as A or B.
- Turn status uses neutral copy such as **Lượt của An**.
- Reconnect copy is **Đang kết nối lại luồng trực tiếp...**.

At completion, the result uses the winning player's name instead of
"you won"/"you lost". The spectator can close the dialog to inspect the final
board or return to the lobby. Closing does not start a replay.

## Demo-First Development

Add deterministic scenarios:

```text
?demo=spectator-list
?demo=spectator-active
?demo=spectator-reconnecting
?demo=spectator-finished
?demo=spectator-room-gone
```

These scenarios reuse production feature contracts and components but use
fixtures through `DemoSession`. They must:

- be visibly labeled as demos;
- perform no lobby request;
- open no transport;
- issue no fake capability;
- not register a production connection factory; and
- never activate as a fallback when online is unavailable.

This permits rapid visual iteration and AI-assisted repair without claiming
that the online path works. The architecture in this document remains the
canonical V1; demo-first and AI-first are implementation criteria, not a
parallel architecture.

## Module Boundaries

- `packages/game-core/src/room.js`: unchanged two-seat game authority.
- `packages/protocol/src/`: exact spectator command, role, projection, and
  response contracts.
- `apps/worker/src/auth/`: capability issue/verify/consume logic.
- `apps/worker/src/lobby/`: public active-match discovery and ticket issuance.
- `apps/worker/src/game/`: viewer role registry, ephemeral presence,
  authorization, projection, and fan-out.
- `apps/web/src/sessions/spectator/`: spectator transport/session adapter and
  normalization.
- `apps/web/src/features/spectator/`: public match list and spectator-specific
  presentation.
- Existing game features: shared rendering controlled by explicit viewer
  capabilities.
- `apps/web/src/sessions/demo/`: network-free deterministic fixtures.

File names may remain consolidated until a responsibility has enough behavior
to justify extraction. The design favors small, pure boundaries but does not
require speculative abstractions or one-file-per-type structure.

## Error Handling

- Invalid, expired, replayed, wrong-room, or wrong-purpose tickets fail closed.
- A spectator command requiring player authority returns an authorization
  error and cannot mutate state.
- Failed presence publication must not compromise game authority. The game
  snapshot remains correct even if the lobby temporarily shows a stale count.
- A malformed or cross-room server envelope is ignored by the client.
- A missing production runtime keeps spectator and online UI unavailable while
  Local and AI modes continue to work.
- Operational overload returns a retryable unavailable response; it never
  silently grants access or falls back to another transport.

## Testing Strategy

### Protocol And Authorization

- Parse the exact `ott:spectate` envelope and reject extra/malformed fields.
- Accept a spectator capability only for its allocation, room, role, purpose,
  lifetime, and unused nonce.
- Reject interpreting player tickets as spectator tickets and vice versa.
- Reject replayed spectator capabilities.

### Worker Authority

- Spectator attach does not add or replace a Room player.
- The first successful role assignment is immutable for the connection;
  duplicate attach/spectate and mixed-role attempts consume no additional
  capability and change neither Room nor presence.
- Spectator `ott:move` is rejected and room state/revision remain unchanged.
- Spectator `ott:leave` is rejected and cannot produce a winner.
- Spectator disconnect does not stop clocks, start grace, or affect results.
- Presence increments after successful attach and decrements after close.
- Failed and duplicate attaches do not change presence.
- Hibernation/restart reconstructs presence from authenticated live attachment
  metadata; stale attachments are excluded and close races are idempotent and
  nonnegative.
- Player updates fan out the correct public projection to spectators.
- Terminal commit queues a send to every spectator attached at commit time;
  delivery to disconnected spectators is explicitly best-effort.
- Terminal games disappear from public discovery.
- Lobby count changes fan out over its single approved provider subscription,
  reconnect resynchronizes the list, and transition to a game disposes that
  subscription before creating the game subscription.
- Projection tests prove credentials, tickets, nonces, connections, and private
  storage fields are absent.
- Ticket/list rate limiting does not change player command behavior.

Room game-rule behavior continues to be tested at `Room.handleMove`; spectator
authorization is tested at the Game Durable Object boundary because it must
never enter `Room`.

### Client And Features

- Public discovery displays only `playing` games.
- **Xem trận** does not require or submit a player name.
- Spectator snapshots have explicit spectator identity and `viewerSeat: null`.
- Pointer, touch, and keyboard board interaction sends no move.
- The board exposes all 81 accessible cells.
- Player-relative language is absent from spectator views.
- **Rời chế độ xem** sends no `ott:leave` and opens no forfeit confirmation.
- Reconnect acquires a new ticket when required and resynchronizes the current
  room revision.
- A disconnect concurrent with terminal commit either renders a received final
  snapshot or follows the documented unavailable path; it never creates a
  terminal-retention dependency.
- Stale, malformed, and cross-room states are ignored.
- Terminal results use neutral player-name copy and retain the final board.
- Every spectator demo renders without network access or a production factory.
- Passing only fixtures or mock bridges leaves the spectator feature flag off
  and does not change the online `BLOCKED` status.

Feature tests assert behavior through session/component contracts rather than
testing internal React implementation details.

## Rollout

1. Add contracts and deterministic demo fixtures.
2. Build the public match and read-only game UI against demo sessions.
3. Add spectator capability and authorization tests.
4. Add Game Durable Object role tracking, projection, and presence.
5. Add lobby active-match discovery, count propagation, and ticket issuance.
6. Connect `SpectatorSession` through the approved runtime bridge.
7. Run Worker integration coverage with two players and multiple spectators.
8. Complete browser acceptance for listing, live updates, reconnect, leave,
   terminal result, and unavailable states.

Use a dedicated spectator feature flag at lobby listing/ticket issuance so the
capability can be disabled without affecting Local, AI, or online player flow.
Do not enable that flag in production until the broader online rollout gates in
`docs/playhtml-upstream-lock.md` have passed. Fixtures, bridge mocks, and unit
tests are not sufficient production evidence.

## MVP Acceptance Criteria

- A visitor can see active games and their spectator counts.
- A visitor can enter a game without providing a name.
- The board, clocks, players, history, and spectator count update from
  authoritative snapshots in real time while the game connection is active.
- Spectator interaction is strictly read-only at both UI and Worker layers.
- Disconnect/reconnect does not create a seat, grace period, or game mutation.
- Leaving spectator mode has no effect on the game.
- Attached spectators are sent the terminal revision; clients that receive it
  show neutral result language and keep the final board inspectable. Recovery
  after a disconnected client misses that revision is outside the MVP.
- No credential or private authority state appears in public projections.
- All spectator states can be demonstrated without a working online runtime.
- Local and AI remain operational when spectator/online service is unavailable.
- Production rollout status remains governed by the existing evidence gate.
