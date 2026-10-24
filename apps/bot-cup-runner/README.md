# `apps/bot-cup-runner`

Runs OTT Bot Cup jobs on an organiser's machine (plan `docs/superpowers/plans/2026-10-23-uet-k71-bot-cup.md` §3.2, §8.3,
§8.4, §9.2). It only makes **outbound** HTTPS calls to the Bot Cup API (`/runner/*`); nothing listens on the machine.

- `check` job: syntax check of a submission inside the container (`py_compile` / `node --check`), in a child process.
- `match` job: one game under `bot-cup-policy-v1` (500 ms a move, 30 s bank, 300 plies, 5 s first-move grace), both seats
  in the container sandbox (`--network none`, read-only root, non-root, 256 MiB, 1 CPU, 32 pids). House bots
  (`easy`/`medium`/`hard` = `ai.js`, `sentinel`, `strategist`, `first-legal`) run in the same sandbox.
- The game is sent as a compact replay; the API plays it again with `rules.js` and refuses anything that does not match.
- A first move that times out before the bot moved at all is played again once (container start-up, not the team).
- Infrastructure errors go to `/runner/fail` and the job is retried on a later lease (3 leases at most).

## Setup (Windows + Docker Desktop/WSL2)

```bash
docker load -i ottv2-arena-runner.tar        # the image saved after P0 (plan §9.2), or build ops/arena/Dockerfile
docker inspect --format "{{.Id}}" ottv2-arena-runner:local
npm run test:arena:isolation                 # must pass on this machine before it takes real work
node scripts/bot-cup/runner-token.mjs <name> --env staging    # token -> var/bot-cup/runner-token-<name>.txt
```

## Run

```bash
BOT_CUP_RUNNER_URL=https://ottv2-bot-cup-api-staging.<account>.workers.dev \
BOT_CUP_RUNNER_TOKEN_FILE=var/bot-cup/runner-token-<name>.txt \
ARENA_RUNNER_IMAGE_ID=sha256:… \
npm run bot-cup:runner
```

Other variables: `ARENA_RUNNER_IMAGE` (default `ottv2-arena-runner:local`), `BOT_CUP_RUNNER_SLOTS` (default 4 — more
games at once makes the clocks unfair on Docker Desktop, P0), `BOT_CUP_RUNNER_POLL_MS` (default 15000),
`BOT_CUP_RUNNER_ONCE=true` (exit when the queue is empty). Logs are JSON lines on stdout. Stop with Ctrl+C: jobs in hand
finish first. Revoke a machine with `node scripts/bot-cup/runner-token.mjs <name> --revoke --env staging`.

## Tests

`tests/bot-cup-runner.test.js` (loop and executor, no Docker), `tests/bot-cup-runner-api.test.js` (API side),
`tests/bot-cup-policy.test.js`, `tests/bot-cup-replay.test.js`. The container path is exercised on the runner machine and
recorded in `docs/evidence/`.
