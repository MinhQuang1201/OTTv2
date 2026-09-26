# PlayHTML Minimal Fork Notice

This directory is reserved for the minimal PlayHTML fork selected for OTTv2.

Task 1 adds the Worker scaffold in `workers/`. The scaffold intentionally uses
the already-resolved workspace package runtime for `partyserver@0.5.10` and
`y-partyserver@2.2.0`; those package files are not copied into this directory.
This keeps the first scaffold small and avoids silently changing the root lock
file. The package paths and hashes used by the scaffold are recorded below.

## Selected Upstream

- Repository: https://github.com/spencerc99/playhtml
- Commit: `4008c42b7d2c6157065afe0071d829dbc561af01`
- Source package: `packages/playhtml`
- Source package version: `2.14.1`
- Source package license: MIT
- Root license scope: the upstream `LICENSE` applies MIT to `packages/`; other
  upstream directories are separately licensed under `LICENSE-ART`.

The OTT workspace currently resolves the published browser package as
`playhtml@2.15.0` (MIT), not as a vendored copy of this repository commit.

## Relevant Runtime Dependencies

These are the versions and licenses recorded for the baseline. They are not a
claim that all of them have been copied into this directory.

| Package | Version | License | Baseline source |
| --- | --- | --- | --- |
| `partyserver` | `0.5.10` in OTT lock; `0.5.5` in upstream `bun.lock` | ISC | `package-lock.json`, upstream `bun.lock` |
| `y-partyserver` | `2.2.0` | ISC | `package-lock.json`, upstream `bun.lock` |
| `yjs` | `13.6.18` | MIT | `package-lock.json`, upstream `bun.lock` |
| `partysocket` | `1.3.0` in OTT lock | MIT | `package-lock.json` |
| Wrangler | `4.81.1` in upstream `bun.lock` | MIT | upstream `bun.lock` |

The ISC notices for `partyserver` and `y-partyserver`, and the MIT notices for
`yjs` and `partysocket`, remain obligations of any future copied distribution.

## Future Copy Requirements

For every source file added here, append or update a manifest with:

1. upstream repository path;
2. pinned source commit;
3. copied-file SHA-256;
4. license and copyright source;
5. runtime/package dependency and version.

Do not copy upstream `db.ts`, `admin.ts`, `sharing.ts`, `bridgeAuth.ts`,
presence workers, or control-plane modules as part of the minimal OTT runtime
without a separately reviewed scope decision. The upstream `bridgeAuth.ts` is
documented as an authentication pattern only; it is not OTT authorization.

## Task 1 Scaffold Files

| Repository file | Origin | SHA-256 | License |
| --- | --- | --- | --- |
| `workers/ott-worker.ts` | OTTv2 Task 1 scaffold | `5de88ffebe8070d6da5d850f2873b1a1ff773a65388a3381194a8cc70d9d1826` | OTTv2 |
| `workers/ott-game-server.ts` | OTTv2 Task 1 scaffold; lifecycle symbols follow pinned `partykit/party.ts:209` and installed `y-partyserver@2.2.0` | `846366298a1a09b776fcad706959b60fce0947b4af1a4d98f3d6c4e5423229b2` | OTTv2 |
| `workers/wrangler.jsonc` | OTTv2 Task 1 scaffold; binding shape follows pinned `partykit/wrangler.jsonc:38-57` | `025694f7f2f46eb1c37660dc8fc02496a0f84a26dc9d29aa66ce7d1b4d75ec33` | OTTv2 |
| `workers/worker-configuration.d.ts` | OTTv2 Task 1 scaffold | `8864d6618437d822740abfd160879d9711c5484cb6a841e0d541cdc1c935d140` | OTTv2 |
| `workers/tsconfig.json` | OTTv2 Task 1 scaffold | `de13f464dbe54775388686d25f892feffd4d745745d0c316116ac8f8eaf86075` | OTTv2 |

The runtime imports are exact resolved package files, not copied source:

| Runtime | Resolved file | Version | License | Source hash |
| --- | --- | --- | --- | --- |
| `partyserver` routing/upgrade | `node_modules/playhtml/node_modules/partyserver/dist/index.js` | 0.5.10 | ISC | `3334ab3b1453a6855800879f12f35428947884cf8426ff216fa95e7dd42263a6` |
| `y-partyserver` YServer | `node_modules/playhtml/node_modules/y-partyserver/dist/server/index.js` | 2.2.0 | ISC | `e516fe4e8afea3666baf2177c66b11180401271839773feeae3de510f942d0fb` |

The pinned upstream source remains `https://github.com/spencerc99/playhtml`
at commit `4008c42b7d2c6157065afe0071d829dbc561af01`. No upstream
`db.ts`, `admin.ts`, `sharing.ts`, `bridgeAuth.ts`, presence worker, or
control-plane file is part of this runtime.

## Browser Surface

`browser/index.js` and `browser/index.d.ts` are a minimal source-backed fork
surface for the upstream browser provider boundary. They intentionally expose
only `createCustomMessageChannel()`, whose implementation delegates to the
provider's public `sendMessage()` and `on("custom-message")` methods. The
provider, socket, document, and data primitives are not returned to callers.

The browser runtime now initializes this surface with the pinned public
`y-partyserver@2.2.0` provider. It is used by the local OTT demo and covered by
the two-context Worker browser test; it is a minimal fork, not the full upstream
PlayHTML bundle or a production readiness claim.

| Repository file | Origin | SHA-256 | License |
| --- | --- | --- | --- |
| `vendor/playhtml-minimal/browser/index.js` | OTTv2 minimal fork boundary; API follows pinned upstream `packages/playhtml/src/index.ts:984-1000` | `9D5B5E840D0DE681C47A2D20E38DF4D6E16E795389BED86AE6572E598C5F527A` | OTTv2, source-backed by upstream MIT |
| `vendor/playhtml-minimal/browser/index.d.ts` | OTTv2 declaration for the minimal public channel | `A049342D1A27BE03D7D9FF390AFA7DD13F96A7DBBD917DE61E87A3FF5BEE3590` | OTTv2, source-backed by upstream MIT |

The browser runtime entry is local OTTv2 code that uses the public provider
surface (no upstream source is copied):

| Repository file | Origin | SHA-256 | License |
| --- | --- | --- | --- |
| `browser/runtime-entry.js` | OTTv2 minimal browser runtime; public `YProvider`/Yjs dependencies | `3D84BC16C1163AFE61310CDC8F066411F4567962C48D4EE1CD41AF91C5074CEB` | OTTv2 |
| `browser/runtime.js` | Generated bundle of `browser/runtime-entry.js` | `15145CE02BC5C3FD49C2504164E3B590E605A049B0B2047CC08D3A86C3B3EB02` | OTTv2 + dependency notices |
| `browser/runtime.d.ts` | OTTv2 browser runtime declarations | `00A50FA0411DC725203FC8C2F202BFBEE45D2949848DF3A555B80A93C65368DC` | OTTv2 |
