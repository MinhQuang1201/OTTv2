const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");

// Tests that start a real `wrangler dev --local` process.
const INTEGRATION_TESTS = [
  "tests/worker-runtime.test.js",
  "tests/worker-test-harness-runtime.test.js",
];

// Opt-in browser tests; they need Playwright Chromium and are driven by their own scripts.
const E2E_TESTS = [
  "tests/browser-worker-runtime.test.js",
  "tests/browser-arena-registration-demo.test.js",
];

const SUITES = {
  unit: {
    files: () => fs.readdirSync(path.join(root, "tests"))
      .filter((name) => name.endsWith(".test.js"))
      .map((name) => `tests/${name}`)
      .filter((file) => !INTEGRATION_TESTS.includes(file) && !E2E_TESTS.includes(file))
      .sort(),
    timeoutMs: 120_000,
  },
  integration: {
    files: () => INTEGRATION_TESTS,
    timeoutMs: 300_000,
    concurrency: 1,
  },
};

function main(argv = process.argv.slice(2)) {
  const suiteName = argv[0];
  const suite = SUITES[suiteName];
  if (!suite) {
    console.error(`Usage: node scripts/run-node-tests.js <${Object.keys(SUITES).join("|")}>`);
    return 2;
  }
  const args = ["--test", `--test-timeout=${suite.timeoutMs}`];
  if (suite.concurrency) args.push(`--test-concurrency=${suite.concurrency}`);
  args.push(...suite.files());
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status === null ? 1 : result.status;
}

if (require.main === module) process.exitCode = main();

module.exports = { INTEGRATION_TESTS, E2E_TESTS, SUITES, main };
