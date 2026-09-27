# PlayHTML Minimal Fork Baseline

**Date:** 2026-09-25  
**Task:** Luna Task 0 only: reproducible baseline/evidence  
**Status:** Baseline recorded. The online rollout remains **BLOCKED**. No application feature, browser factory, Worker entry, or vendor source was added by this task.

## Repository And Source Pin

The selected source repository is `D:\Work\Study\playhtml`:

| Item | Exact value |
| --- | --- |
| Repository | `https://github.com/spencerc99/playhtml` |
| Commit | `4008c42b7d2c6157065afe0071d829dbc561af01` |
| Commit subject | `Release: @playhtml/extension v0.1.25 (#435)` |
| Source package | `packages/playhtml` |
| Source package version at this commit | `2.14.1` |
| Source package license | MIT |
| Worker configuration | `partykit/wrangler.jsonc` |
| Worker main | `partykit/party.ts` |

The OTT application currently depends on the separately published `playhtml@2.15.0` and `partykit@0.0.115`. The pinned repository commit is the selected fork source, not a claim that the published package contains its Worker entry.

## Runtime And Dependency Versions

Versions below are recorded separately by provenance so a future vendor step can reproduce the intended graph rather than silently mixing lockfiles.

### OTT workspace

| Component | Resolved value | Evidence |
| --- | --- | --- |
| Node | `v22.19.0` | `node --version` on 2026-09-25 |
| npm | `11.12.1` | `npm --version` on 2026-09-25 |
| `playhtml` | `2.15.0` | `package-lock.json` package entry, tarball integrity `sha512-u80i3QaU31DGEcVp4IKHwBHj9QuLCrmNefdPjtyxBfzt8kF/NLIMcAjf5LIasrrB7eN9HoiVzU8IdTentHW1dw==` |
| `partykit` | `0.0.115` | `package.json` and `package-lock.json` |
| `partyserver` | `0.5.10` | `package-lock.json` nested under `node_modules/playhtml`, integrity `sha512-t2B3mhTL1IOxCsj8rZgn4TxTuub7oLhypjc1/fGPNsbgnn9OsHms6uR3QEd5bFJ/7xrFo771j3DdUlll8cxgBg==` |
| `y-partyserver` | `2.2.0` | `package-lock.json`, integrity `sha512-AIsTEZ3jPicBe3VHO5c/VdSGSaFr0J9cAGj6+sgRL/RnXLTNSkP3oQXyXf1y8hQNeXv/j9zYDT5NnRv2k1eMGA==` |
| `yjs` | `13.6.18` | `package-lock.json`, integrity `sha512-GBTjO4QCmv2HFKFkYIJl7U77hIB1o22vSCSQD1Ge8ZxWbIbn8AltI4gyXbtL+g5/GJep67HCMq3Y5AmNwDSyEg==` |
| `partysocket` | `1.3.0` | `package-lock.json`, integrity `sha512-1zToNyolZFK/7nuAw/K2bZrNzFqaZyRoCEkS+9vG6WSC5ikrN6qWRe96q6ImU51uptz2r+dAwSkwhJVdQi4LiA==` |

The workspace does not currently install `partyserver`, `y-partyserver`, or Wrangler as root packages. They are available transitively below `node_modules/playhtml` where applicable. `npx wrangler --version` fetched `wrangler@4.140.0` because no local Wrangler binary was installed; this is an observation, not a lock pin.

### Selected upstream repository

The pinned repository's `bun.lock` records:

| Component | Upstream lock value |
| --- | --- |
| Bun lock/runtime package manager | `bun.lock` |
| `partyserver` | `0.5.5` |
| `y-partyserver` | `2.2.0` |
| `yjs` | `13.6.18` |
| Wrangler | `4.81.1` |
| TypeScript | `5.9.3` |

The source package manifest at this commit declares `y-partyserver: ^2.2.0`, `partysocket: ^1.2.0`, and exact `yjs: 13.6.18`. The manifest itself is `2.14.1`; the OTT published dependency is `2.15.0`, so source and package versions must remain explicit during vendoring.

## Exact Source Symbols

These are source-backed symbols observed at the pinned commit. Line numbers refer to that commit's checked-out files.

### Server lifecycle and custom messages

- `partykit/party.ts:209`: `export class PartyServer extends YServer`.
- `partykit/party.ts:210-212`: `PartyServer.options` enables `hibernate: true`.
- `partykit/party.ts:1587-1626`: `override async onCustomMessage(sender, message)` parses JSON and dispatches the upstream application message types. The continuation at `1620-1626` broadcasts other messages through the inherited custom-message behavior.
- The class imports `YServer` from `y-partyserver` at `partykit/party.ts:5` and imports `getServerByName` and `routePartykitRequest` from `partyserver` at `partykit/party.ts:4`.

The installed `y-partyserver@2.2.0` implementation provides the relevant lifecycle boundary:

- `YServer.onCustomMessage(connection, message)` in `dist/server/index.js:218-223`.
- `YServer.sendCustomMessage(connection, message)` in `dist/server/index.js:229-240`.
- `YServer.broadcastCustomMessage(message, excludeConnection)` in `dist/server/index.js:247-262`.
- `YServer.handleMessage(connection, message)` in `dist/server/index.js:264-279`; string frames beginning with `__YPS:` have the six-character prefix removed and are passed to `onCustomMessage`. Other string frames are rejected as non-prefixed custom messages; binary frames follow the Yjs protocol path.

### Browser/provider boundary

- `packages/playhtml/src/index.ts:984-991`: constructs `new YProvider(partykitHost, room, doc, ...)`.
- `packages/playhtml/src/index.ts:995`: subscribes to `sync`.
- `packages/playhtml/src/index.ts:997-1000`: subscribes once to `yprovider.on("custom-message", onMessage)` outside the sync callback.
- In installed `y-partyserver@2.2.0`, `dist/provider/index.js:467-469`: `YProvider.sendMessage(message)` sends `__YPS:${message}` on its WebSocket.
- In installed `y-partyserver@2.2.0`, `dist/provider/index.js:100-105`: text messages with `__YPS:` emit `custom-message` after prefix removal.

This is an internal/provider-backed convention, not a public `playhtml` custom-message API. The baseline therefore does not expose it to OTT code and does not treat it as a completed Task 2 implementation.

### Routing and room identity

- `partykit/party.ts:3300-3313`: the default Worker export calls `routePartykitRequest(request, workerEnv)` and returns `404` when it does not match.
- `partykit/party.ts:3234-3235`: `getServerByName(env.Main, peerRoomId)` obtains a Durable Object stub and calls `peerRoom.fetch(...)` for room-to-room HTTP.
- Installed `partyserver@0.5.10`, `dist/index.d.ts:116-129`: `getServerByName(namespace, name, options?)` uses `idFromName(name)` and returns a named Durable Object stub after `onStart` synchronization.
- Installed `partyserver@0.5.10`, `dist/index.d.ts:195-203`: `routePartykitRequest(req, env?, options?)` returns `Response | null`.
- Installed `partyserver@0.5.10`, `dist/index.js:468-544`: routing requires the default `/parties/{namespace}/{name}` path shape (or an explicit `prefix`), maps the namespace by converting the Durable Object binding name to kebab case, calls `idFromName(name)`, and forwards the request to that Durable Object. WebSocket upgrades are detected from `Upgrade: websocket`.
- Installed `partyserver@0.5.10`, `dist/index.js:435-440`: `getServerByName` maps the supplied room name directly through `idFromName(name)`.
- `partykit/wrangler.jsonc` maps `Main` to the `PartyServer` Durable Object and uses `main: "party.ts"`; it also includes `PresenceServer`, Supabase bindings/secrets, quarantine KV, migrations, and routes. Those are upstream application dependencies, not minimal-fork evidence.

The browser's upstream PlayHTML room identity is also not just an arbitrary raw room string. At `packages/playhtml/src/index.ts:182-194`, `normalizeRoomId(host, roomString)` normalizes the host, combines it with the pathname-like room, and URI-encodes the result. `YProvider` then receives the resolved `partykitHost` and normalized room at `:984`. A future fork must document the actual host URL and `/parties/{namespace}/{name}` mapping it chooses; this baseline does not invent that mapping.

### Server-only authentication pattern

- `partykit/bridgeAuth.ts:4-44` defines `BRIDGE_SECRET_HEADER`, validates a configured secret, and builds an internal JSON `Request` carrying the secret in a header.

This file is an upstream shared-element bridge pattern. It is not copied, enabled, or accepted as OTT authorization. The later OTT Worker tasks must implement and test their own trusted capability boundary.

## Licenses And Notice Scope

The pinned repository root `LICENSE` states that the `packages/` directory is MIT under copyright `(c) 2023-2026 Spencer Chang`; other upstream directories are separately licensed under `LICENSE-ART`. The selected `packages/playhtml` source is therefore recorded as MIT. Relevant resolved runtime packages record:

| Package | Version | License |
| --- | --- | --- |
| `playhtml` | `2.15.0` in OTT / `2.14.1` at source commit | MIT |
| `partyserver` | `0.5.10` in OTT / `0.5.5` in upstream bun lock | ISC |
| `y-partyserver` | `2.2.0` | ISC |
| `yjs` | `13.6.18` | MIT |
| `partysocket` | `1.3.0` | MIT |

`vendor/playhtml-minimal/NOTICE.md` records this provenance and explicitly says no source is copied yet. A future vendor change must add each copied file's upstream path, source commit, file hash, and applicable license before Task 1 claims a real fork.

## Baseline Commands And Results

Commands were run from `D:\Work\Study\OTTv2` on 2026-09-25:

| Command | Result |
| --- | --- |
| `rtk git status --short --branch` | `fix/playHTML...origin/fix/playHTML`; pre-existing untracked `LUNA_IMPLEMENTATION_REPORT.md` and `communication.md`; no user files reverted |
| `rtk node --version` | `v22.19.0` |
| `rtk npm --version` | `11.12.1` |
| `rtk bun --version` | `1.3.14` |
| `rtk npx wrangler --version` | fetched `wrangler@4.140.0`; no local Wrangler was present |
| `rtk npm test` | **91 passed, 13 failed, 1 skipped** (`105` tests total). Not a pass. The failures are the already-documented direct-client `ott:create`/PartyKit initialization blockers; the PlayHTML runtime forwarding test is intentionally skipped. |
| `rtk git diff --check` | passed |
| `Get-ChildItem -File -Filter *.js -Recurse ... | ForEach-Object { node --check $_.FullName }` | passed for every existing non-`node_modules`, non-`vendor` JavaScript file |

The requested JavaScript syntax check ran against the existing runtime file set. The exact command for the reproducible per-file check was:

```powershell
Get-ChildItem -File -Filter *.js -Recurse | Where-Object { $_.FullName -notmatch '\\node_modules\\|\\vendor\\' } | ForEach-Object { node --check $_.FullName }
```

## Gate Decision

Task 0 evidence is documentation-only. It does not prove a runnable self-contained Worker, a public browser custom-message API, same-connection OTT traffic, secure lobby-to-game initialization, or two-client PlayHTML sync. Keep the status in `docs/playhtml-upstream-lock.md` **BLOCKED** until those later tasks produce direct runtime evidence.
