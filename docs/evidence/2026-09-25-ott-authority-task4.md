# Task 4 Authority Evidence

## Verification

- `npx tsc -p workers/tsconfig.json --noEmit`: passed.
- `npx wrangler deploy --dry-run --config workers/wrangler.jsonc`: passed; Wrangler resolved `OttGameServer`, `OttLobbyServer`, `Main`, `OTT_GAME`, and `OTT_LOBBY` bindings.
- Focused authority, bridge, and Worker entry tests: passed.
- `git diff --check`: passed.

## Runtime limitation

No local Durable Object runtime or source-backed browser PlayHTML two-client connection was executed for this task. Node tests are deterministic source/security-boundary tests because importing the Worker modules directly would require Cloudflare's `cloudflare:workers` runtime and Durable Object storage. No fake Worker API, process registry, client relay, or placeholder ticket acceptance was added. The production rollout remains governed by `docs/playhtml-upstream-lock.md` and its existing BLOCKED status.
