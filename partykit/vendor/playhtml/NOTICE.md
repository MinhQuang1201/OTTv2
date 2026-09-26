# PlayHTML Vendor Notice

This directory records the intended upstream source boundary for OTTv2. No
upstream worker source is copied because the pinned repository does not
publish a self-contained worker entry and its `partykit/party.ts` imports the
repository's private application modules, additional source files, and
external worker bindings. The installed `playhtml` package contains only the
client bundle and declarations; the installed `partykit` package contains the
CLI/runtime, not this worker.

- Repository: https://github.com/spencerc99/playhtml
- Commit: `dc2a248839e52e60da796c0df359b8ed506028a1`
- Published package: `playhtml` `2.15.0`
- Relevant upstream source: `partykit/party.ts`
- License: MIT for the upstream `packages/` library; see the upstream `LICENSE`
- Vendoring status: blocked; no real worker entrypoint is wired from the exact
  pins available in this repository.

The local bridge is not a modified copy of upstream code. It is a narrow,
transport-neutral seam that accepts an explicit `{ "__ott": true, "type":
"ott:*" }` JSON envelope and delegates every other frame, including text or
JSON containing `__ott` without that exact envelope, to an injected upstream
handler. It must not be treated as proof that the upstream
PlayHTML/Yjs worker accepts arbitrary raw WebSocket frames. A future fork may
replace the injected handler only after its exact source and lifecycle are
vendored and tested. Any mechanically adjusted upstream imports must be listed
here before source is added.
