# Worker Local Runtime Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the local Worker/Wrangler development and test runtime independent of Windows-excluded ports while keeping all local runtime settings easy to override.

**Architecture:** Add one small Node configuration module for the local host, optional port override, and dynamic port allocation. Wrangler `4.141.0` is declared once as a direct devDependency; the dev command and Worker harnesses invoke that local binary instead of carrying their own version strings or relying on a global install. `.env` contains non-secret local overrides, `.dev.vars` remains the Wrangler secret file, and no YAML file is introduced because no project tool consumes it.

**Tech Stack:** Node.js CommonJS, npm scripts, Wrangler `4.141.0`, Node test runner, `dotenv`.

---

## Scope And Invariants

- Do not change `packages/game-core`, Worker authority, Durable Object bindings, or production deployment behavior.
- Do not make the UI choose a game move or add a second transport.
- Do not stop/restart WinNAT or change the Windows dynamic port policy from project scripts.
- Do not commit `.env` or `.dev.vars`; only update `.env.example` and documentation.
- Keep an explicit `OTT_WORKER_PORT` override for debugging and CI, but leave it empty by default so Windows excluded ranges are avoided.
- Keep Wrangler version pinned to the repository-tested version rather than depending on a global installation.

## File Map

**Create:**

- `config/local-runtime.js` — loads non-secret local environment values, validates host/port values, formats the Worker origin, and obtains an available loopback port when no explicit port is configured.
- `scripts/worker-dev.js` — starts the local Wrangler Worker using the shared runtime configuration and forwards useful diagnostics.
- `tests/local-runtime-config.test.js` — unit tests for environment loading, host/port parsing, URL formatting, and dynamic allocation.
- `tests/worker-dev.test.js` — unit tests for the Wrangler argument builder without starting a child process.

**Modify:**

- `package.json` — add direct Wrangler and `dotenv` dependencies and route `worker:dev` through the wrapper.
- `package-lock.json` — update with `npm install`.
- `.env.example` — document the local static/Worker host and optional port override.
- `.gitignore` — keep the real `.env` file out of version control.
- `server.js` — load `.env` for the already-documented `PORT` setting without overriding process-provided environment variables.
- `tests/worker-test-harness-runtime.test.js` — remove global `8791`, allocate one port per harness, and retain child output for startup failures.
- `tests/worker-runtime.test.js` — remove default `8787`, use the shared resolver, and build request URLs from the started Worker instance.
- `tests/worker-runtime/fixture.js` — consume the shared port allocator instead of maintaining a duplicate implementation.
- `tests/no-legacy-online-transport.test.js` — update the README command contract to require the pinned local Wrangler launcher.
- `README.md` — document the local command, override behavior, and separation between `.env` and `.dev.vars`.

## Task 1: Add The Shared Local Runtime Configuration

**Files:**
- Create: `config/local-runtime.js`
- Create: `tests/local-runtime-config.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing tests for valid and invalid port configuration.**

  Cover these cases:
  - Empty `OTT_WORKER_PORT` resolves to an available `127.0.0.1` port.
  - A numeric string such as `8900` is returned unchanged.
  - Non-integer, zero, negative, and out-of-range values throw an actionable error.
  - `OTT_WORKER_HOST` defaults to `127.0.0.1`.
  - The available-port result can bind a temporary Node server and is a nonzero port.
  - `readWorkerHost` accepts only loopback-safe `127.0.0.1`, `localhost`, and `::1` values, and `workerOrigin` formats IPv6 as `[::1]`.
  - The local Wrangler launcher is `npx` on POSIX and `npx.cmd` on Windows; it is invoked with an argument array rather than a shell-joined command.

  Add `dotenv` to `dependencies` before running this focused test, because the shared module owns `.env` loading. Run `npm install` to update the lockfile.

- [ ] **Step 2: Run the focused test and verify it fails.**

  Run: `node --test tests/local-runtime-config.test.js`

  Expected: FAIL because `config/local-runtime.js` does not exist yet.

- [ ] **Step 3: Implement the minimal configuration module.**

  Export:
  - `DEFAULT_WORKER_HOST` set to `127.0.0.1`.
  - `loadLocalEnv()` using `dotenv` with `override: false`, so shell/CI values win over `.env`.
  - `readWorkerHost(value)` with a nonempty host contract and URL-safe formatting for IPv4 and IPv6 literals.
  - `readConfiguredPort(value)` with strict integer validation and a useful variable name in errors.
  - `availablePort(host)` using `net.createServer().listen(0, host)` and closing the server before resolving.
  - `resolveWorkerPort(value = process.env.OTT_WORKER_PORT)` returning the explicit validated port or an OS-assigned port.
  - `workerOrigin(host, port, protocol = "http")` for consistent URL construction; callers pass `"https"` for the browser fixture.
  - `wranglerLauncher()` returning `{ command: "npx" | "npx.cmd", argsPrefix: ["--no-install", "wrangler"] }` for the current platform.

  Call `loadLocalEnv()` once when the module is loaded so all Node entry points importing it receive the same non-overriding `.env` behavior. Do not parse `.dev.vars` in this module and do not put secrets in it. Do not add a Wrangler version environment variable; `package.json` is the single source for the pinned local Wrangler version.

- [ ] **Step 4: Run the focused test and verify it passes.**

  Run: `node --test tests/local-runtime-config.test.js`

  Expected: PASS.

- [ ] **Step 5: Commit the isolated configuration module and tests.**

  ```bash
  git add config/local-runtime.js tests/local-runtime-config.test.js package.json package-lock.json
  git commit -m "test: add local worker runtime port configuration"
  ```

## Task 2: Make The Dev Command Self-Contained

**Files:**
- Create: `scripts/worker-dev.js`
- Create: `tests/worker-dev.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.env.example`
- Modify: `.gitignore`
- Modify: `server.js`

- [ ] **Step 1: Add direct, pinned tooling dependencies.**

  Add `wrangler: 4.141.0` to `devDependencies`. `dotenv` is added in Task 1. Run `npm install` so `package-lock.json` records the exact resolution. Do not rely on a globally installed Wrangler or an unpinned `npx` download.

- [ ] **Step 2: Add the failing command-level behavior test or test seam.**

  Make the wrapper export a small `buildWranglerArgs(port, extraArgs)` function, then add `tests/worker-dev.test.js` to verify the repository config, loopback host, resolved port, local mode, `--inspector-port 0`, and non-interactive mode. Also test `main({ spawnProcess })` with a fake child that emits an `error` and with a fake child that exits with a nonzero code. Keep real process spawning behind `main()` so the module is testable without starting Wrangler.

- [ ] **Step 3: Implement `scripts/worker-dev.js`.**

  The wrapper should:
  - load `.env` without overriding explicit shell/CI variables;
  - resolve `OTT_WORKER_HOST` and `OTT_WORKER_PORT` through `config/local-runtime.js`;
  - invoke the local pinned Wrangler binary through `wranglerLauncher()` with `apps/worker/wrangler.jsonc` and `--local`; use `npx.cmd` and an argument array on Windows, never a shell-joined command string;
  - pass `--inspector-port 0` so Wrangler does not bind its default inspector port on Windows;
  - print the actual URL, including the dynamically selected port;
  - pipe stdout/stderr to the terminal;
  - forward termination signals and return Wrangler's exit code;
  - fail immediately if the local binary cannot be started.

  Do not use a hardcoded fallback such as `8787` or `8791`. If an explicit port is requested, validate it before spawning Wrangler.

  The interactive dev wrapper starts one attempt and reports bind diagnostics; it does not silently move a user-requested process between ports. Retry-on-bind is owned by the automated harnesses, where readiness and persistence cleanup can be controlled deterministically. If `OTT_WORKER_PORT` is set, harnesses must not retry on another port and must not silently replace the requested port.

- [ ] **Step 4: Route `worker:dev` through the wrapper.**

  Change the package script from direct `wrangler dev ... --port 8787` to `node scripts/worker-dev.js`. Keep the existing config path, local binding behavior, and inspector setting in the wrapper, not duplicated in the npm script.

- [ ] **Step 5: Make the existing `PORT` documentation functional.**

  Load `.env` at the start of `server.js` with `override: false`, preserving process-provided values. Since `config/local-runtime.js` is also imported by the Node test entry points, its `loadLocalEnv()` call must make the same `.env` values available to `npm test`, `npm run test:worker-runtime`, and the dev wrapper. Add these non-secret examples to `.env.example`:

  ```dotenv
  PORT=3000
  OTT_WORKER_HOST=127.0.0.1
  OTT_WORKER_PORT=
  ```

  Preserve the existing PlayHTML variables.

  Add `.env` to `.gitignore`; never create or commit the real file.

- [ ] **Step 6: Verify the dev command on the affected machine.**

  Run on Windows: `npm.cmd run worker:dev`

  Expected: Wrangler starts on an OS-selected port, with inspector disabled, and prints a reachable local URL. Set `$env:OTT_WORKER_PORT='8900'; npm.cmd run worker:dev` once to verify the explicit override, then remove the variable with `Remove-Item Env:OTT_WORKER_PORT` and stop the process cleanly.

- [ ] **Step 7: Commit the dev command changes.**

  ```bash
  git add package.json package-lock.json scripts/worker-dev.js tests/worker-dev.test.js server.js .env.example .gitignore
  git commit -m "fix: make local worker command use configurable ports"
  ```

## Task 3: Refactor The Test Harness To Use Per-Process Ports And Logs

**Files:**
- Modify: `tests/worker-test-harness-runtime.test.js`
- Modify: `tests/worker-runtime/fixture.js`

- [ ] **Step 1: Extract the shared allocator usage.**

  Import `availablePort`, `readWorkerHost`, `workerOrigin`, and `wranglerLauncher` from `config/local-runtime.js` into the browser fixture and remove its duplicate implementation. Keep the fixed static app port `3000` because that process is intentionally checked for collisions separately. Replace the fixture's versioned `npx wrangler@...` command with the platform-safe `wranglerLauncher()` result, and pass `--inspector-port 0` as well.

  Strengthen `stopProcess()` so it waits for normal exit, invokes `taskkill /t /f` on Windows when needed, waits again, and rechecks liveness before removing persistence. If the process tree is still alive after the forced-kill timeout, throw a cleanup error instead of silently continuing.

- [ ] **Step 2: Remove global harness URL state.**

  Change `startHarness(persistTo)` to resolve a host and port and return `{ child, host, port, base, output, exited }`. Pass the resolved host to Wrangler's `--ip` option. Make `waitForHarness`, `testRequest`, `issueInitialization`, `initialize`, and `consumeAttach` receive the harness context or base URL rather than reading module-level `port` and `base`. Start with a fresh dynamically allocated port per harness; an explicit `OTT_WORKER_PORT` override is documented as serialized/manual-only. Replace the versioned `npx --yes wrangler@...` array with `wranglerLauncher()`.

- [ ] **Step 3: Preserve diagnostics and detect early child exit.**

  Replace `stdio: "ignore"` with piped stdout/stderr, retain bounded logs, and make readiness polling reject as soon as the child exits. Include exit code, signal, stdout, and stderr in the final startup error. Keep the existing 30-second readiness deadline as the upper bound, not the only failure signal. Pass `--inspector-port 0` to the harness Wrangler command.

- [ ] **Step 4: Update each test to own and clean up its harness context.**

  Ensure every test starts one context, uses its `base`, and stops/removes its persistence directory in `finally`. Do not allow two tests to share a port or URL. Await the child exit after `taskkill` before removing persistence, then recheck and force-kill the process tree if it is still alive; fail cleanup rather than deleting state while a child remains. If the child exits immediately after the port allocator closes its probe socket, retry up to three times with a newly allocated port only for bind-related early exits; surface all other exits immediately. An explicit fixed-port override remains intentionally serialized/manual-only.

- [ ] **Step 5: Run the focused harness test against the previously excluded environment.**

  Run: `node --test --test-name-pattern="test-only Worker initializes Main" tests/worker-test-harness-runtime.test.js`

  Before asserting the test result, update every non-attach `inspect` deep-equality expectation in this file to include the current `attachNonce: false` field. Keep `attachNonce: true` only in the assertion after an attach ticket is consumed. This is a known test/Worker contract drift unrelated to port allocation. Then expect PASS without binding `8787` or `8791`; startup failures must include Wrangler diagnostics rather than only `test Worker did not start`.

- [ ] **Step 6: Commit the harness changes.**

  ```bash
  git add tests/worker-test-harness-runtime.test.js tests/worker-runtime/fixture.js
  git commit -m "test: allocate worker harness ports dynamically"
  ```

## Task 4: Refactor The Real Worker Runtime Test

**Files:**
- Modify: `tests/worker-runtime.test.js`

- [ ] **Step 1: Remove the module-level `8787` base URL.**

  Make `startWorker()` resolve a host and port and return them with the child, origin/base URL, logs, and persistence directory. Keep `assertPortIsFree` parameterized by the selected port. Use `wranglerLauncher()` and pass `--inspector-port 0` to Wrangler.

- [ ] **Step 2: Thread the Worker context through HTTP and WebSocket helpers.**

  Update `control`, `connectRoom`, and `waitForHttp` to use the started Worker context. Preserve all existing assertions and log capture. Keep `OTT_WORKER_PORT` as an explicit serialized/manual override for reproducing a fixed-port problem. If Wrangler exits before readiness due to bind failure, retry up to three times with a fresh dynamic port only when no explicit override is set; otherwise fail with captured diagnostics. Clean up and await each failed child before retrying.

- [ ] **Step 3: Run the runtime test in its supported local modes.**

  Run on Windows: `npm.cmd run test:worker-runtime`

  Expected: tests skip with the existing `.dev.vars` message when the local secret file is absent; when `.dev.vars` is present, the Worker starts on a dynamic or explicitly configured allowed port and does not bind the default inspector port.

- [ ] **Step 4: Commit the runtime test changes.**

  ```bash
  git add tests/worker-runtime.test.js
  git commit -m "test: configure worker runtime ports centrally"
  ```

## Task 5: Document The Configuration Contract And Remove Ambiguity

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the supported variables.**

  Add a local Worker subsection describing:
  - empty `OTT_WORKER_PORT` means automatic loopback port allocation;
  - setting `OTT_WORKER_PORT` is an explicit diagnostic/CI override;
  - `OTT_WORKER_HOST` defaults to `127.0.0.1`;
  - `.env` is for non-secret local process settings;
  - `.dev.vars` is for Worker local secrets and remains ignored.
  - `.env` is ignored by Git and must never contain the Worker secret used by `.dev.vars`.

- [ ] **Step 2: Document the command contract.**

  Replace the direct `npx wrangler dev` recommendation with `npm run worker:dev`, while retaining `npx --no-install wrangler dev|deploy ...` only as an advanced escape hatch. State that no WinNAT reset or Windows port-range mutation is required by the project.

- [ ] **Step 3: Check for stale fixed-port references.**

  Run: `rtk grep "8787|8791|worker:dev|OTT_WORKER_PORT"`

  Expected: no runtime default uses `8787` or `8791`; remaining references must be historical documentation, explicit test overrides, or explanatory text.

- [ ] **Step 4: Update the legacy-online configuration assertion.**

  Change `tests/no-legacy-online-transport.test.js` to assert the pinned local command form (`npx --no-install wrangler`) instead of the unpinned `npx wrangler` text. Do not rewrite historical evidence documents whose command output records an earlier environment.

- [ ] **Step 5: Commit the documentation and contract test.**

  ```bash
  git add README.md tests/no-legacy-online-transport.test.js
  git commit -m "docs: document configurable local worker runtime"
  ```

## Task 6: Full Verification

- [ ] **Step 1: Install and verify dependency resolution.**

  Run on Windows: `npm.cmd install`

  Expected: Wrangler is present in `node_modules/.bin`, and the lockfile is unchanged on a second install.

- [ ] **Step 2: Run unit tests.**

  Run on Windows: `npm.cmd test`

  Expected: the suite completes without the repeated 30-second harness startup failures.

- [ ] **Step 3: Run web checks because the root test command shares the repository install.**

  Run on Windows: `npm.cmd run test:web`

  Run on Windows: `npm.cmd run typecheck:web`

  Run on Windows: `npm.cmd run build:web`

  Expected: PASS; no frontend behavior is intentionally changed.

- [ ] **Step 4: Verify the manual local startup paths.**

  Run on Windows: `npm.cmd run worker:dev`

  Run on Windows: `$env:OTT_WORKER_PORT='8900'; npm.cmd run worker:dev`, then clean up with `Remove-Item Env:OTT_WORKER_PORT`.

  Expected: both dynamic and explicit allowed-port startup paths work; the process exits cleanly and does not leave a Wrangler/workerd child behind.

- [ ] **Step 5: Inspect the final diff and preserve unrelated worktree changes.**

  Run: `rtk git status --short` and `rtk git diff --check`.

  Expected: only the planned files are changed by this work. Existing unrelated modifications in the worktree must not be reverted.

## Deferred Or Explicitly Rejected

- No YAML configuration: there is no YAML consumer in this repository, and adding one would create configuration drift.
- No automatic WinNAT/Hyper-V manipulation: OS policy is outside application ownership and may disrupt Docker/WSL2.
- No global Wrangler installation requirement.
- No fixed default port selected solely because `8900` worked once; dynamic allocation is safer, while `OTT_WORKER_PORT=8900` remains available for manual use.
- No changes to production Worker deployment configuration beyond reusing the existing `wrangler.jsonc`.
