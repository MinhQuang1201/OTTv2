# PlayHTML Upstream Lock

## Status

**Task 6 browser/Worker technical gate: PASS for the minimal OTT fork. Production rollout: BLOCKED pending the broader Task 8 matrix and Task 10 manual acceptance.** The dated Task 6/7 evidence at the end of this file supersedes earlier “browser NOT RUN” findings, which describe the state before the real-browser harness was added.

The original Task 1 compatibility spike did not establish a browser extension
point. Task 6 later supplied a minimal, source-backed browser fork using the
public `y-partyserver` provider channel; its direct two-context evidence is
recorded below. This is demo evidence, not a production readiness claim.

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

Clarification from the fresh spike below: `y-partyserver@2.2.0` itself does
publish a public `./provider` subpath with `YProvider.sendMessage()` and the
`custom-message` event, and its README documents the matching `YServer`
`onCustomMessage` / `sendCustomMessage` methods. Those are public exports of a
transitive package, not exports of `playhtml@2.15.0`; using them in the product
would require an explicit direct dependency and a reviewed browser bootstrap.
The local spike proves this package-level channel works with a Worker subclass,
but it does not prove the PlayHTML browser bundle or OTT application bootstrap.

## Fresh real-YProvider local spike (2026-09-26)

**Spike result: PASS, limited to Node `YProvider` to local Worker. Browser
PlayHTML integration: NOT RUN. Technical rollout gate: BLOCKED.**

The spike used the exact installed `y-partyserver@2.2.0` provider and server
exports. A temporary Worker extended public `YServer`; its public
`onCustomMessage(connection, message)` override echoed through public
`sendCustomMessage(connection, message)`. A real `YProvider` connected to that
Worker, completed Yjs initial sync, sent the string
`{"__ott":true,"type":"ott:probe","seq":1}`, and received the exact string
back as JSON data over the same provider WebSocket. No PlayHTML private API,
raw socket access, copied upstream source, or production file was used.

The test Worker and client existed only under
`%TEMP%\ottv2-task6-yprovider-spike` and were removed after the run. Their
SHA-256 identities before cleanup were:

| Temporary fixture | SHA-256 |
| --- | --- |
| `worker.mjs` | `22F272BF15807292E157AED827730CE5C1C3A77167873482495716F45B291AFC` |
| `client.mjs` | `19850AB96CA9C29D4B6A819DBCE31E9862C4C4723895879F7E4A6ADD08B0EB2D` |
| `wrangler.jsonc` | `E93163F791C46D343DD8BC45CCAAAFA3B283BD365E0A227146C751421C0F0B26` |

The reviewed installed sources and licenses were:

| Source | Version / license | SHA-256 |
| --- | --- | --- |
| `playhtml/dist/index-CGjnJNJD.js` | `playhtml@2.15.0`, MIT | `6919E792BD7E63B29825E4FFD8F31036AE2B0E8421A44E572D2F9DE4DF11CBAF` |
| `playhtml/dist/main.d.ts` | `playhtml@2.15.0`, MIT | `9CBC928ECDD9A6B12082DCA88EDEAE336827D1BF8382B4E69C8BB5D5A176AE6C` |
| `playhtml/node_modules/y-partyserver/dist/provider/index.js` | `y-partyserver@2.2.0`, ISC | `B89EB3826960A58D118D6C2DF375A7CE0BC0DD23DE8C726B9FD1DE15EBA46610` |
| `playhtml/node_modules/y-partyserver/dist/provider/index.d.ts` | `y-partyserver@2.2.0`, ISC | `E5183F5A80B1CF9F6DC17162B02460C6F7BD1D35B3B2882D3AB6453322A3CBC2` |
| `playhtml/node_modules/y-partyserver/dist/server/index.js` | `y-partyserver@2.2.0`, ISC | `E516FE4E8AFEA3666BAF2177C66B11180401271839773FEEAE3DE510F942D0FB` |
| `playhtml/node_modules/y-partyserver/dist/server/index.d.ts` | `y-partyserver@2.2.0`, ISC | `B68D3724997C10A2CC51DCFA8B8C8F58E25C6804FDA86484A45368F2BAD9C90C` |
| `yjs/dist/yjs.mjs` | `yjs@13.6.18`, MIT | `EDEADB5DD04F1107F440A5DA455BE7BF3184980DDD947A73BAD4141FB6C65084` |
| `playhtml/node_modules/partyserver` | `partyserver@0.5.10`, ISC | Package manifest; no source file copied |

Environment: Node `v22.19.0`, Wrangler `4.141.0`, Windows local Wrangler
runtime, port `8787`, lockfile-resolved PlayHTML/Y-partyserver/Yjs versions as
above. Wrangler ran with `XDG_CONFIG_HOME` set to the temporary `.xdg`
directory and `WRANGLER_SEND_METRICS=false`. The exact commands were:

```text
& { $env:XDG_CONFIG_HOME = 'C:\Users\ADMIN\AppData\Local\Temp\ottv2-task6-yprovider-spike\.xdg'; $env:WRANGLER_SEND_METRICS = 'false'; node 'C:\Users\ADMIN\AppData\Local\npm-cache\_npx\32026684e21afda6\node_modules\wrangler\bin\wrangler.js' dev --config 'C:\Users\ADMIN\AppData\Local\Temp\ottv2-task6-yprovider-spike\wrangler.jsonc' --local --ip 127.0.0.1 --port 8787 --persist-to 'C:\Users\ADMIN\AppData\Local\Temp\ottv2-task6-yprovider-spike\state' }
node client.mjs (working directory: C:\Users\ADMIN\AppData\Local\Temp\ottv2-task6-yprovider-spike)
```

Observed output was `result: PASS`, `yjsSynced: true`,
`customMessageRoundTrip: true`; the provider URL was
`ws://127.0.0.1:8787/parties/main/ott-task6-spike` with its generated `_pk`
query parameter. This confirms the documented package-level framing and
ordering across a real YProvider/Worker connection.

### Follow-up two-client Worker smoke (2026-09-26)

**Result: PASS for two independent Node YProviders and the temporary Worker;
browser/PlayHTML technical gate remains BLOCKED.**

Two `y-partyserver@2.2.0` `YProvider` instances connected to the same
`ott-task6-two-client-spike` room with distinct provider IDs and WebSocket
objects. Both completed initial sync. An update written by A appeared in B's
Yjs map, and an update written by B appeared in A's map. Each client then sent
one OTT-shaped custom string using `sendMessage()` and received exactly one
matching `onCustomMessage` echo on its own connection; the peer received no
echo. `disableBc: true` kept the sync evidence on the Worker connection.

The repeat used the same Node `v22.19.0` / Wrangler `4.141.0` command and
temporary `YServer` fixture described above, with room
`ott-task6-two-client-spike`. `node client.mjs` (working directory
`C:\Users\ADMIN\AppData\Local\Temp\ottv2-task6-yprovider-spike`) exited `0`
and printed:

```json
{"result":"PASS","provider":"y-partyserver@2.2.0 YProvider","room":"ott-task6-two-client-spike","independentConnections":true,"providerIdsDistinct":true,"yjsInitialSync":[true,true],"yjsUpdates":{"AtoB":"visible-to-B","BtoA":"visible-to-A"},"customMessageRoundTrips":{"A":true,"B":true},"websocketPaths":["/parties/main/ott-task6-two-client-spike","/parties/main/ott-task6-two-client-spike"]}
```

Follow-up fixture hashes: `worker.mjs`
`22F272BF15807292E157AED827730CE5C1C3A77167873482495716F45B291AFC`,
`client.mjs`
`31D355C8C599B9E0BC58FED4651B19E5E276D789F19C4E4EF833309AAEC36775`, and
`wrangler.jsonc`
`89288A5BCD716350F4C3D25A056C56CC2D5FC75D45A70242FDC6545CBBFB7B0B`.
This satisfies only the local two-client YProvider/Worker smoke prerequisite;
it is not an OTT allocation/attach test and does not provide browser or
PlayHTML-bootstrap evidence.

This is not a browser run: the client used Node's WebSocket implementation,
not `playhtml`'s browser bundle, page bootstrap, or an actual browser context.
It also did not exercise OTT allocation, attach authorization, state
projection, or browser two-client behavior. Those are still NOT RUN, so the
spikes do not satisfy Task 6 Step 1a and do not authorize vendoring, loading,
or registering a browser factory. Online remains unavailable pending direct
browser-to-Worker and application-level evidence.

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
- The real local Node-YProvider-to-Worker spike is recorded above. The actual
  PlayHTML browser smoke was **not run**: it requires a browser-loaded runtime
  connected to the reviewed fork worker, with source-backed tests for
  `__YPS:` text framing and ordering. That browser executable pairing does not
  exist in this repository.

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

Keep this path scoped to the local demo. Before production rollout, complete the
broader Worker/browser runtime matrix and manual acceptance, then review
deployment configuration and operational evidence. The earlier requirement for
a browser-to-Worker proof is satisfied for the minimal fork by the evidence
below; it is not evidence that the full upstream PlayHTML bundle is in use.

## Task 6/7 browser-to-Worker evidence (2026-09-26)

**Result: PASS for the minimal OTT browser fork and local demo path.** The
browser runtime is not PlayHTML's full upstream UI bundle: it is a deliberately
small, source-backed fork surface that uses the public `y-partyserver@2.2.0`
`YProvider` and public custom-message API, with Yjs shared-data features kept
out of OTT game state. It configures one provider for the canonical allocated
room and exposes only string send/subscribe after initial sync.

`npm run test:browser-worker-runtime` ran successfully on Node `v22.19.0`,
Wrangler `4.141.0`, Playwright `1.60.0`, and Chromium `148.0.7778.96`. Two
isolated browser contexts opened the real app, A created a room, B listed and
joined it, both attached through one YProvider WebSocket each, and a legal A
move appeared in B's UI. The endpoint observed in both contexts was exactly
`/parties/main/ott-<canonical-uuid>`. The test also checks no uncaught page or
console errors. This verifies the local demo flow only; it does not claim
deployment, reconnect/expiry acceptance, or production readiness.

During this run, the browser exposed a missing `roomId` in the client's
`ott:move`/`ott:leave` envelopes. The Worker correctly ignored the malformed
move. The client now supplies its current canonical room ID for those commands,
covered by `tests/playhtml-game-client.test.js` and the passing two-browser
test.

The browser fork and generated bundle identities are:

| Repository file | Origin | SHA-256 | License |
| --- | --- | --- | --- |
| `vendor/playhtml-minimal/browser/index.js` | Local minimal channel adapter; follows public provider API | `9D5B5E840D0DE681C47A2D20E38DF4D6E16E795389BED86AE6572E598C5F527A` | OTTv2 |
| `vendor/playhtml-minimal/browser/runtime-entry.js` | Local runtime entry using public `YProvider` and Yjs | `3D84BC16C1163AFE61310CDC8F066411F4567962C48D4EE1CD41AF91C5074CEB` | OTTv2 |
| `vendor/playhtml-minimal/browser/runtime.js` | Generated esbuild bundle from the entry above | `15145CE02BC5C3FD49C2504164E3B590E605A049B0B2047CC08D3A86C3B3EB02` | OTTv2 + dependency notices |
| `vendor/playhtml-minimal/browser/index.d.ts` | Local channel declarations | `A049342D1A27BE03D7D9FF390AFA7DD13F96A7DBBD917DE61E87A3FF5BEE3590` | OTTv2 |
| `vendor/playhtml-minimal/browser/runtime.d.ts` | Local browser runtime declarations | `00A50FA0411DC725203FC8C2F202BFBEE45D2949848DF3A555B80A93C65368DC` | OTTv2 |

Resolved source package hashes from `y-partyserver@2.2.0` are recorded in the
lockfile and here for reproducibility: provider JS
`B89EB3826960A58D118D6C2DF375A7CE0BC0DD23DE8C726B9FD1DE15EBA46610`,
provider declarations
`E5183F5A80B1CF9F6DC17162B02460C6F7BD1D35B3B2882D3AB6453322A3CBC2`, server
JS `E516FE4E8AFEA3666BAF2177C66B11180401271839773FEEAE3DE510F942D0FB`, and
server declarations
`B68D3724997C10A2CC51DCFA8B8C8F58E25C6804FDA86484A45368F2BAD9C90C` (all
ISC). `yjs@13.6.18` is MIT; `yjs/dist/yjs.mjs` SHA-256 is
`EDEADB5DD04F1107F440A5DA455BE7BF3184980DDD947A73BAD4141FB6C65084`.
The generated bundle is reproducibly rebuilt by `npm run build:playhtml-browser`.

Task 7 adds the Playwright two-context harness in
`tests/browser-worker-runtime.test.js` and its local Wrangler/static-app fixture
in `tests/worker-runtime/fixture.js`. The dedicated browser command passes;
the separate legacy Worker suite still skips its manual-acceptance placeholder
because human Task 10 acceptance has not been performed. Earlier “browser NOT
RUN” statements above are historical and superseded by this result.
