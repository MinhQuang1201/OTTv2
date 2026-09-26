# Authoritative Worker Completion Design

**Date:** 2026-09-26

## Goal

Complete the Cloudflare Worker online architecture without weakening the
authority boundary, then provide evidence-backed runtime and manual acceptance
results. Online remains BLOCKED until every release gate passes.

## Constraints

- `Room` remains the authority for rules, seats, clocks and winners.
- Browser game state is rendered only from Worker-authoritative responses.
- A browser game uses exactly one PlayHTML/YProvider connection. No raw OTT
  socket, PartySocket, polling, fake factory or second session is allowed.
- Game initialization is Lobby-to-Game only through a trusted DO request.
- Credentials, internal capabilities, HMAC material and secrets never enter
  URLs, public lists, Yjs state, PlayHTML data, presence or client logs.
- Unrun manual scenarios are recorded as NOT RUN, never inferred as PASS.

## Authority And Routing

Use one `OttGameServer` Durable Object namespace for both paths. Retain
`Main: OttGameServer`, because PartyServer resolves `/parties/main/:room`
through `env.Main`; remove only the duplicate `OTT_GAME` binding. Lobby also
uses `env.Main.idFromName(canonicalRoomId)`. The canonical Game DO name is the
exact, lowercase public room ID `ott-<uuid>`:

1. The public PartyServer route `/parties/main/:room` accepts only that
   canonical room ID and resolves it through `env.Main`.
2. Lobby initialization resolves the exact same canonical room ID in the same
   namespace.
3. The Game DO persists the allocation and public-room identity only after it
   verifies the signed, room-bound, single-use initialization capability.
4. A public route is only transport selection. Attach-ticket verification,
   seat assignment and game-state authorization remain inside the Game DO.

This removes the current `Main` versus `OTT_GAME` namespace split, where a
successful WebSocket upgrade could reach a different DO than the initialized
authoritative room.

Lobby initially stores an allocation as `initializing`, which is neither listed
nor joinable. It becomes `waiting` only after Game initialization succeeds. A
failed initialization deletes or terminalizes the allocation before returning
an error. Initialization is idempotent for the allocation identity, so retry
does not require reusing a consumed one-time capability. Creation also stores a
durable creator-attach deadline. If A never attaches before that deadline,
Lobby/Game terminalize the allocation and remove it from public listing through
the same idempotent lifecycle protocol.

## Credentials

Lobby grants an initial attach ticket only to its allocated seat. Every attach
ticket is HMAC-signed, room/seat/purpose/expiry-bound, includes a high-entropy
nonce, and Game atomically consumes that nonce in durable storage before it
binds a connection. This applies to create, join and resume tickets. In
addition, Lobby grants that browser a high-entropy opaque resume credential scoped to the
allocation and seat. The browser stores it only in session/local storage needed
for reconnect and never sends it to the Game channel. The initial credential is
issued when the seat is allocated, not inferred from a public allocation ID.

`/control/resume` requires the allocation ID plus the resume credential. It:

1. Looks up the stored credential hash for that allocation/seat.
2. Constant-time verifies the submitted credential.
3. Rotates it atomically on success.
4. Returns a newly signed, one-time attach ticket for only that seat and the
   rotated resume credential.

The caller cannot choose a seat, cannot mint a ticket for another seat, and
cannot replay the old resume credential. Credentials are stored as hashes and
are redacted from all public projections and protocol responses. The signed
attach ticket authenticates the Game channel only; it is never substituted for
the private `Room` resume token. The Game adapter resumes the already
authenticated seat through an internal seat-bound adapter operation, preserving
`Room` token privacy and grace semantics.

## Game To Lobby Lifecycle

Game sends an idempotent, signed DO-to-DO lifecycle request to Lobby when the
room enters playing, terminal, or waiting expiry. The request is bound to the
allocation, room and expected lifecycle revision. Lobby records the newest
state only and removes waiting entries when they are no longer joinable.

Lobby join verifies the durable allocation status before issuing a B ticket.
This prevents a stale waiting entry from allocating a seat after Game terminal
state or waiting-creator expiry.

Sanitized seat names are part of the trusted initialization payload and stored
with the Game allocation state. On attach, Game passes only this stored name to
`Room`; it never accepts a browser-provided name or falls back to a shared
placeholder. Public state may project these names, but never credentials.

A is included in the initial Game initialization. When Lobby accepts B's join,
it sends one signed, room-bound, nonce-backed `seat-update` DO request to the
same Game DO containing B's already-sanitized name and seat. Game consumes the
capability before persisting that name. B's attach ticket contains no name and
cannot alter a trusted seat record.

Internal initialization, seat-update and lifecycle requests are ordinary
`stub.fetch(Request)` calls to the named `Main` Game/Lobby DO. Each request has
an internal-secret header plus a canonical HMAC capability containing version,
allocation ID, room ID, purpose, lifecycle revision where applicable, expiry
and nonce. The receiving DO verifies the signature, expected claims and expiry,
then atomically consumes the nonce in its own durable storage before mutation.
Lifecycle updates are idempotent by stored allocation lifecycle revision:
duplicates and stale revisions are no-ops. Runtime tests must exercise these
requests through real local DO stubs, including wrong-room, expiry and replay.

## Browser Runtime

Vendor or build a reviewed browser-loadable PlayHTML integration from the
pinned source revision. It must ship with an origin/SHA/license manifest and
must not import Worker runtime modules from nested `node_modules`. It:

1. Configures one real YProvider with the allocated host and public room.
2. Waits for `playhtml.ready` before registering the connection factory.
3. Exposes the small public string-only custom-message channel.
4. Disables users presence, cursor, element awareness and all PartySocket
   transports before provider construction.
5. Provides only `{ connect, send, on, close }` to `PlayhtmlGameClient`.

The provider initial Yjs sync is permitted before attach. The Game DO remains
read-only for incoming Yjs client updates, so mutations before and after attach
are neither broadcast nor persisted. Only custom OTT messages can mutate Room.

The canonical room ID is case-sensitive and passed unchanged through allocation
response, provider configuration, client session, OTT envelope and Game lookup.
Non-canonical IDs are rejected; the client must not uppercase or otherwise
transform them.

Game emits a per-recipient public projection. It includes the recipient's
`you` seat and public authoritative state, but never any attach ticket, resume
credential, capability, MAC, secret, or another seat's credential. This lets
the UI authorize moves from its authoritative seat without exposing private
room internals.

## Runtime Tests

Use a reusable Wrangler fixture with unique local DO persistence, explicit
ignored `.dev.vars`, HTTP readiness polling, bounded logs, process-tree
cleanup, and restart support that preserves the selected state directory until
the final fixture teardown.

Use Playwright with two isolated browser contexts for real PlayHTML clients.
Instrumentation records WebSocket construction and browser network traffic.
Runtime assertions cover:

- two `playhtml.ready` clients on the same initialized Game DO;
- exactly one YProvider connection per client and no auxiliary transport;
- Yjs initial sync and pre/post attach mutation discard;
- attach, legal/invalid move, revision ordering and leave;
- replay rejection for create, join and resumed attach tickets;
- browser-visible payload copied to direct Game init rejection;
- ticket/capability/secret redaction in HTTP, OTT state and logs;
- disconnect/resume before grace, replay rejection and reconnect expiry;
- clock timeout, restart/hydration and durable alarm behavior;
- creator-never-attaches expiry, waiting disconnect expiry, and Lobby list/join
  cleanup.

Short test-only clock/grace durations are injected through a Worker test config,
not browser-controlled input and never production bindings.

## Legacy Test Migration

Replace obsolete PartyKit command/event assertions with behavioral Worker tests.
Keep pure Room and serializer tests. Migrate persistence, alarm, terminal
idempotence, invalid-move and credential-redaction intent to Worker adapter and
runtime suites. Remove PartyKit transport-specific tests only after an
equivalent Worker test is present.

No current security test is silently skipped: resume ownership, credential
replay and waiting cleanup become explicit Worker regression tests.

The current source-shape tests are retained only as fast architecture checks.
Every release-gate assertion also has behavioral Worker or browser runtime
coverage; a raw WebSocket upgrade alone is not connection evidence.

## Acceptance And Release

Task 9 uses two manually isolated browser profiles against the actual Worker
host. Its evidence file records each required scenario as PASS, FAIL or NOT
RUN, host/revision/browser versions, and DevTools proof of a single connection.

Task 10 runs the full deterministic suite, Worker bundle/type check, runtime
suite, static-server denylist test, JavaScript syntax checks, diff check and
two-profile acceptance. Status documents are updated from those results only.
Any missing or failing gate preserves `Online production: BLOCKED`.

All status documents are reconciled to the strictest direct evidence. Until the
vendored browser/Worker pairing and two-client runtime suite pass, the upstream
lock remains BLOCKED and provisional implementation claims are not release
evidence.
