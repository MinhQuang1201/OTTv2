const { spawnSync } = require("node:child_process");

const spectator = process.argv.includes("--spectator");
// The spectator variant reuses the two-profile smoke test against its own Worker config;
// the default run also covers the phase 1 online flow. Both fixtures bind the same app port, so run files one at a time.
const files = spectator
  ? ["tests/browser-worker-runtime.test.js"]
  : ["tests/browser-worker-runtime.test.js", "tests/browser-online-flow.test.js"];

const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: {
    ...process.env,
    OTT_BROWSER_RUNTIME_TEST: "1",
    OTT_SPECTATOR_RUNTIME_TEST: spectator ? "1" : process.env.OTT_SPECTATOR_RUNTIME_TEST,
    OTT_RECONNECT_RUNTIME_TEST: process.argv.includes("--reconnect") ? "1" : process.env.OTT_RECONNECT_RUNTIME_TEST,
  },
});

if (result.error) throw result.error;
process.exitCode = result.status === null ? 1 : result.status;
