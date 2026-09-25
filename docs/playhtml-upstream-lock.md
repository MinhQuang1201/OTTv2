# PlayHTML Upstream Lock

## Status

**BLOCKED for production rollout.** Task 8 adds security regression coverage and documents the active architecture, but does not provide direct evidence for a real PlayHTML fork/bootstrap connection.

Task 1 is a compatibility spike, not a claim that the OTT authoritative worker
is ready. The package versions below are exact and reproducible, but the
upstream worker protocol is not verified as an extension point for OTT command
messages. Do not implement Task 2+ against these assumptions until the
extension check and a local two-client smoke test pass.

## Exact pins

| Component | Pin | Evidence |
| --- | --- | --- |
| `playhtml` | `2.15.0` | npm tarball integrity `sha512-u80i3QaU31DGEcVp4IKHwBHj9QuLCrmNefdPjtyxBfzt8kF/NLIMcAjf5LIasrrB7eN9HoiVzU8IdTentHW1dw==` |
| `partykit` CLI/runtime package | `0.0.115` | npm tarball integrity `sha512-WHmJIZsAzRWrm1lrtU7wcl0tpD4rg2vgmn4+hXGPjU4mnXgFxyjVq2ZzO547xRXa1IbETOP6J9INl/ergR99bA==` |
| `ws` existing server dependency | `8.21.3` | npm lockfile integrity; exact-pinned to prevent unrelated transport drift during the migration spike |

The generated `package-lock.json` is the authoritative dependency graph. No
direct dependency uses `latest`, a caret, or a range.

## Upstream source identity

- Repository: `https://github.com/spencerc99/playhtml`
- Verified commit: `dc2a248839e52e60da796c0df359b8ed506028a1`
- License: MIT for the `packages/` library; the repository also contains
  separately licensed non-library material. Only the published `playhtml`
  package is selected here.
- Published package manifest: `packages/playhtml/package.json`, version
  `2.15.0`, package directory `packages/playhtml`.
- Published package dependencies include exact `yjs` `13.6.18`, plus
  `y-partyserver`, `partysocket`, `@playhtml/common`, `lit-html`, and
  `@syncedstore/core` ranges. Their resolved versions are recorded in the
  lockfile.

## Worker/configuration findings

The verified upstream commit contains a TypeScript worker under `partykit/`,
including `party.ts`, presence/persistence modules, and
`partykit/wrangler.jsonc`. It does **not** contain an upstream `partykit.json`.
The upstream repository's current development command uses Wrangler, and the
published `playhtml` package does not publish that worker source as a package
entry point.

This repository therefore has a minimal `partykit.json` with the PartyKit
entry point reserved for the future `partykit/ott-room.js` implementation. That
file is configuration only at this task boundary; the entry point intentionally
does not exist yet. `npm run dev:partykit` must not be treated as a passing
worker smoke test until the later worker task adds it.

## Exact custom-message symbols

The inspected `playhtml@2.15.0` dependency graph contains a concrete private
Yjs custom-message convention; it is not an arbitrary raw-frame protocol.

- Server: `playhtml/node_modules/y-partyserver/dist/server/index.js`
  `YServer.handleMessage(connection, message)` accepts only string frames that
  start with `__YPS:`, removes the six-character prefix, then calls
  `onCustomMessage(connection, customMessage)` (lines 264-274). Its
  `sendCustomMessage` and `broadcastCustomMessage` add that prefix before
  sending (lines 229-262). The declarations are at
  `dist/server/index.d.ts` lines 32-35.
- Browser implementation: `playhtml/dist/index-CGjnJNJD.js` contains the
  bundled provider receiver at line 6461 and `sendMessage(t) {
  this.ws?.send(\`__YPS:${t}\`); }` at lines 6691-6692. The transitive
  `y-partyserver/dist/provider/index.js` has the same internal contract: it
  emits `custom-message` after stripping `__YPS:` (lines 102-104), and its
  `sendMessage` adds the prefix (lines 467-468). Published PlayHTML
  declarations expose `initPlayHTML({ host, room })`, but no public
  custom-message send/receive surface; see `playhtml/dist/main.d.ts` lines
  429-485.
- PartyKit separately declares generic worker frame hooks:
  `partykit@0.0.115/server.d.ts` lines 177-183 define
  `Server.onMessage(message, sender)` for string, `ArrayBuffer`, or
  `ArrayBufferView`; lines 280-286 define the legacy `PartyKitServer` form.
  These are not the PlayHTML/Yjs message boundary.
- The pinned upstream `partykit/party.ts` subclasses `YServer` and overrides
  `onCustomMessage`, but imports repository-local modules,
  `cloudflare:workers`, and worker bindings. The commit contains a multi-file
  `partykit/` application and `partykit/wrangler.jsonc`; neither published
  package contains a self-contained worker entry.

These symbols establish text framing and ordering (`__YPS:` first, then the
opaque custom string). They do not establish a public browser API OTT can call,
or a reviewed self-contained fork entry that this repository can run. They
cannot lift the gate or justify reconstructing the protocol around the injected
bridge.

## Extension-point result

**Raw custom-frame compatibility remains unverified and blocked for migration.**
The pinned `partykit/party.ts` defines an upstream `onCustomMessage` method for
its own worker/application messages, but it imports private modules from the
upstream repository and is not a self-contained worker entry in the published
package. This task therefore does not vendor that incomplete worker or claim
that arbitrary raw WebSocket frames are accepted by PlayHTML.

The local compatibility boundary is intentionally narrower: the tested bridge
recognizes only a parsed JSON object with `__ott: true` and a `type` beginning
with `ott:`. It dispatches that object to an injected OTT callback; every
other frame, including text or JSON containing `__ott` without that exact
envelope, is passed unchanged to an injected upstream handler. This is an
abstraction for future integration, not proof that the upstream runtime can
carry the envelope. The browser/runtime connection and a real fork worker
still need an explicit, source-backed extension point before Task 2+.

The plan's safety rule applies: game state must not be put into PlayHTML
`pageData`, element CRDT data, events, or presence as a substitute. Before
Task 2+, inspect the exact worker source and test whether custom messages are
accepted, isolated from PlayHTML protocol traffic, and preserved by the client.

## Verification performed

- npm registry metadata was fetched for `playhtml@2.15.0` and
  `partykit@0.0.115`, including tarball URLs and integrity values; the installed
  dependency graph resolves `playhtml@2.15.0`, `partykit@0.0.115`,
  `y-partyserver@2.2.0`, `partyserver@0.5.10`, and `partysocket@1.3.0`.
- Git remote heads and the PlayHTML commit tree were fetched successfully.
- The installed PlayHTML manifest exposes only the client bundle (`dist`) and
  declarations; it does not expose a worker entry. The PartyKit package is a
  CLI/runtime package, not the PlayHTML worker. The pinned source tree's
  `partykit/party.ts` was inspected and found to depend on private upstream
  modules, external worker bindings, and additional source files not available
  in either installed package.
- `node --test tests/playhtml-bridge.test.js` passed (6 tests). These are
  injected-adapter tests only: they prove neither the `__YPS:` binary/text
  boundary nor a PlayHTML browser-to-worker connection, and are explicitly not
  gate evidence.
- Local `docs/playhtml/` and `docs/PLAYHTML_AI_GUIDE.md` were inspected. They
  require an explicit self-hosted `host`, initial `await playhtml.ready`, and
  prohibit using shared-data primitives for unrelated authoritative state.
- The real local smoke was **not run**. It requires the exact PlayHTML browser
  runtime connected to a self-contained reviewed fork worker, with source-backed
  tests for `__YPS:` text framing and ordering. Neither a fork entry nor that
  executable pairing exists in this repository.

Task 8 does not change that gate: no manual two-profile acceptance is claimed,
and the local bridge/PartyKit test doubles must not be presented as proof that
the PlayHTML runtime accepts OTT frames.

## Vendored files

- `partykit/vendor/playhtml/NOTICE.md` records the exact upstream identity and
  why no upstream source file is copied at this boundary.
- No upstream source file was modified or copied. `partykit/playhtml-base.js`
  and `partykit/playhtml-ott-bridge.js` are local CommonJS adapters only.
- Vendoring a minimal real worker is blocked: the exact pinned worker entry is
  not present in the available packages and is not self-contained in the
  pinned repository source. No real entrypoint is wired as a substitute.

## Next safe step

Do not route production OTT traffic through this bridge until an explicitly
reviewed fork supplies a self-contained worker entry and proves the envelope
at the actual PlayHTML connection boundary. The two-browser PlayHTML sync
smoke test remains unrun because this task has no valid fork worker entry.
