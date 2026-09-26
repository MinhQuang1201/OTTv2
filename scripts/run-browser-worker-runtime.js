const { spawnSync } = require("node:child_process");

const result = spawnSync(process.execPath, ["--test", "tests/browser-worker-runtime.test.js"], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: { ...process.env, OTT_BROWSER_RUNTIME_TEST: "1" },
});

if (result.error) throw result.error;
process.exitCode = result.status === null ? 1 : result.status;
