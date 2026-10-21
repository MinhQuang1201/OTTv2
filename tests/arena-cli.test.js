/**
 * Arena CLI and Clock Tests — Task 4
 * Tests NodeClock implementation, CLI doctor command, match command with FunctionBot,
 * atomic replay output writing, argument validation (exit 2), infrastructure error (exit 1),
 * and actual CLI roundtrip smoke.
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const CLI_PATH = path.resolve(__dirname, "../apps/arena-cli/src/main.mjs");
const TEST_VAR_DIR = path.resolve(__dirname, "../var/arena/test-cli-" + Date.now());

let createNodeClock;
let runCli;
let validateReplayDocument;
let computeReplayDigest;

before(async () => {
  // Ensure test scratch dir exists under var/arena/
  fs.mkdirSync(TEST_VAR_DIR, { recursive: true });

  const clockMod = await import("../packages/arena-node/src/clock/node-clock.mjs");
  const cliMod = await import("../apps/arena-cli/src/main.mjs");
  const contractsMod = await import("../packages/arena/src/contracts/index.mjs");
  const identityMod = await import("../packages/arena-node/src/core/ruleset-identity.mjs");

  createNodeClock = clockMod.createNodeClock;
  runCli = cliMod.runCli;
  validateReplayDocument = contractsMod.validateReplayDocument;
  computeReplayDigest = identityMod.computeReplayDigest;
});

after(() => {
  try {
    fs.rmSync(TEST_VAR_DIR, { recursive: true, force: true });
  } catch (_) {}
});

describe("NodeClock (ClockPort implementation)", () => {
  it("conforms to ClockPort: nowMs returns monotonic numbers", () => {
    const clock = createNodeClock();
    const t1 = clock.nowMs();
    const t2 = clock.nowMs();
    assert.equal(typeof t1, "number");
    assert.equal(typeof t2, "number");
    assert.ok(Number.isFinite(t1));
    assert.ok(t2 >= t1, "clock must be monotonic");
  });

  it("conforms to ClockPort: schedule executes callback and cancel cancels timer", async () => {
    const clock = createNodeClock();
    let fired = false;

    const handle = clock.schedule(5, () => {
      fired = true;
    });
    assert.ok(handle, "schedule must return a handle");

    // Cancel before it fires
    clock.cancel(handle);

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(fired, false, "cancelled timer must not fire");

    // Test that non-cancelled timer fires
    let fired2 = false;
    clock.schedule(5, () => {
      fired2 = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(fired2, true, "active scheduled timer must fire");
  });
});

describe("Arena CLI: doctor command", () => {
  it("runs doctor command, outputs capabilities, ruleset identity, and exits with 0", async () => {
    let stdout = "";
    let stderr = "";

    const exitCode = await runCli(["doctor"], {
      stdout: (msg) => { stdout += msg + "\n"; },
      stderr: (msg) => { stderr += msg + "\n"; }
    });

    assert.equal(exitCode, 0, `doctor should exit 0, got ${exitCode}`);
    assert.equal(stderr, "");

    // Must output Node version
    assert.ok(stdout.includes(process.version), "stdout should include Node version");

    // Must output ruleset identity
    assert.ok(stdout.includes("ottv2-g-default-v1"), "stdout should include ruleset ID");
    assert.ok(stdout.includes("sha256:"), "stdout should include ruleset hash or fingerprint");

    // Must report execution capabilities truthfully
    assert.ok(stdout.includes("FunctionBot: in-process only"), "FunctionBot must be in-process only");
    assert.ok(stdout.includes("process runner: not implemented"), "process runner must be not implemented");
    assert.ok(stdout.includes("trusted-local: available"), "trusted-local must be available");
    assert.ok(stdout.includes("sandbox: unavailable"), "sandbox must be unavailable until Task 6");
    assert.ok(stdout.includes("compiler: unavailable"), "compiler must be unavailable until Task 6");
  });

  it("exits with code 1 if doctor setup/fingerprint encounters an unexpected I/O failure", async () => {
    let stderr = "";
    const exitCode = await runCli(["doctor"], {
      stdout: () => {},
      stderr: (msg) => { stderr += msg + "\n"; },
      getEngineFingerprint: () => {
        throw new Error("Simulated core file read failure");
      }
    });

    assert.equal(exitCode, 1, "setup/fingerprint failure must exit 1");
    assert.ok(stderr.includes("Simulated core file read failure") || stderr.includes("Infrastructure error"));
  });
});

describe("Arena CLI: argument validation and exit codes", () => {
  it("exits with code 2 on missing command or invalid command", async () => {
    let stderr = "";
    const exitCodeEmpty = await runCli([], {
      stdout: () => {},
      stderr: (msg) => { stderr += msg + "\n"; }
    });
    assert.equal(exitCodeEmpty, 2, "empty args should exit 2");

    stderr = "";
    const exitCodeInvalid = await runCli(["nonexistent-cmd"], {
      stdout: () => {},
      stderr: (msg) => { stderr += msg + "\n"; }
    });
    assert.equal(exitCodeInvalid, 2, "unknown command should exit 2");
    assert.ok(stderr.includes("Unknown command") || stderr.includes("Usage"));
  });

  it("exits with code 2 on missing --output argument for match", async () => {
    let stderr = "";
    const exitCode = await runCli(["match", "--bot-a", "first-legal", "--bot-b", "first-legal"], {
      stdout: () => {},
      stderr: (msg) => { stderr += msg + "\n"; }
    });
    assert.equal(exitCode, 2, "missing --output must exit 2");
    assert.ok(stderr.includes("--output"), "error message must mention --output");
  });

  it("exits with code 2 on unsupported bot identifier", async () => {
    let stderr = "";
    const outputPath = path.join(TEST_VAR_DIR, "bad-bot.json");
    const exitCode = await runCli(["match", "--bot-a", "evil-untrusted-bot", "--output", outputPath], {
      stdout: () => {},
      stderr: (msg) => { stderr += msg + "\n"; }
    });
    assert.equal(exitCode, 2, "unsupported bot must exit 2");
    assert.ok(stderr.includes("evil-untrusted-bot"));
  });

  it("exits with code 2 when destination file exists without --overwrite", async () => {
    const outputPath = path.join(TEST_VAR_DIR, "existing-file.json");
    fs.writeFileSync(outputPath, "already exists", "utf8");

    let stderr = "";
    const exitCode = await runCli([
      "match",
      "--bot-a", "first-legal",
      "--bot-b", "first-legal",
      "--output", outputPath
    ], {
      stdout: () => {},
      stderr: (msg) => { stderr += msg + "\n"; }
    });

    assert.equal(exitCode, 2, "existing file without --overwrite must exit 2");
    assert.ok(stderr.includes("--overwrite"));
    assert.equal(fs.readFileSync(outputPath, "utf8"), "already exists", "file must not be overwritten");
  });

  it("exits with code 2 on unknown flags", async () => {
    let stderr = "";
    const exitCode = await runCli(["match", "--unknown-flag", "--output", path.join(TEST_VAR_DIR, "out.json")], {
      stdout: () => {},
      stderr: (msg) => { stderr += msg + "\n"; }
    });
    assert.equal(exitCode, 2, "unknown flag must exit 2");
    assert.ok(stderr.includes("--unknown-flag"));
  });

  it("exits with code 2 on missing flag values", async () => {
    let stderr = "";
    const exitCode = await runCli(["match", "--bot-a"], {
      stdout: () => {},
      stderr: (msg) => { stderr += msg + "\n"; }
    });
    assert.equal(exitCode, 2, "missing flag value must exit 2");
    assert.ok(stderr.includes("--bot-a"));

    stderr = "";
    const exitCode2 = await runCli(["match", "--output"], {
      stdout: () => {},
      stderr: (msg) => { stderr += msg + "\n"; }
    });
    assert.equal(exitCode2, 2, "missing --output value must exit 2");
  });

  it("exits with code 2 on duplicate flags", async () => {
    let stderr = "";
    const p1 = path.join(TEST_VAR_DIR, "dup1.json");
    const p2 = path.join(TEST_VAR_DIR, "dup2.json");
    const exitCode = await runCli(["match", "--output", p1, "--output", p2], {
      stdout: () => {},
      stderr: (msg) => { stderr += msg + "\n"; }
    });
    assert.equal(exitCode, 2, "duplicate flags must exit 2");
    assert.ok(stderr.includes("Duplicate") || stderr.includes("duplicate"));
  });

  it("exits with code 2 on extra positional arguments", async () => {
    let stderr = "";
    const exitCode = await runCli(["match", "unexpected-arg", "--output", path.join(TEST_VAR_DIR, "out.json")], {
      stdout: () => {},
      stderr: (msg) => { stderr += msg + "\n"; }
    });
    assert.equal(exitCode, 2, "extra positional argument must exit 2");
    assert.ok(stderr.includes("unexpected-arg"));
  });

  it("exits with code 2 on non-practice kinds (ranked or invalid)", async () => {
    let stderr = "";
    const exitCodeRanked = await runCli([
      "match",
      "--kind", "ranked",
      "--output", path.join(TEST_VAR_DIR, "ranked.json")
    ], {
      stdout: () => {},
      stderr: (msg) => { stderr += msg + "\n"; }
    });
    assert.equal(exitCodeRanked, 2, "ranked kind must exit 2 in M1");
    assert.ok(stderr.includes("practice"));

    stderr = "";
    const exitCodeInvalid = await runCli([
      "match",
      "--kind", "tournament",
      "--output", path.join(TEST_VAR_DIR, "tourn.json")
    ], {
      stdout: () => {},
      stderr: (msg) => { stderr += msg + "\n"; }
    });
    assert.equal(exitCodeInvalid, 2, "invalid kind must exit 2");
    assert.ok(stderr.includes("tournament"));
  });
});

describe("Arena CLI: match command and atomic replay output", () => {
  it("runs match with first-legal bots, outputs valid replay atomically, and exits 0", async () => {
    const outputPath = path.join(TEST_VAR_DIR, "practice-match.json");
    let stdout = "";
    let stderr = "";

    const exitCode = await runCli([
      "match",
      "--bot-a", "first-legal",
      "--bot-b", "first-legal",
      "--kind", "practice",
      "--output", outputPath
    ], {
      stdout: (msg) => { stdout += msg + "\n"; },
      stderr: (msg) => { stderr += msg + "\n"; }
    });

    assert.equal(exitCode, 0, `match should exit 0 on completion, stderr: ${stderr}`);
    assert.ok(fs.existsSync(outputPath), "output file must exist");

    // Validate replay JSON schema and content
    const raw = fs.readFileSync(outputPath, "utf8");
    const replay = JSON.parse(raw);
    const validation = validateReplayDocument(replay);
    assert.equal(validation.ok, true, `replay must validate cleanly: ${JSON.stringify(validation.errors)}`);

    // Verify digest
    const digest = computeReplayDigest(replay);
    assert.ok(stdout.includes(digest), "stdout should contain replay digest");
    assert.ok(stdout.includes("Match completed"), "stdout should announce completion");
  });

  it("overwrites existing file when --overwrite is specified", async () => {
    const outputPath = path.join(TEST_VAR_DIR, "overwrite-test.json");
    fs.writeFileSync(outputPath, "old content", "utf8");

    let stdout = "";
    let stderr = "";
    const exitCode = await runCli([
      "match",
      "--bot-a", "first-legal",
      "--bot-b", "first-legal",
      "--output", outputPath,
      "--overwrite"
    ], {
      stdout: (msg) => { stdout += msg + "\n"; },
      stderr: (msg) => { stderr += msg + "\n"; }
    });

    assert.equal(exitCode, 0, `match with --overwrite should succeed, stderr: ${stderr}`);
    const raw = fs.readFileSync(outputPath, "utf8");
    assert.notEqual(raw, "old content");
    const replay = JSON.parse(raw);
    assert.equal(validateReplayDocument(replay).ok, true);
  });

  it("atomic no-clobber publish: preserves target file created during match when !overwrite, fails with exit 2, and cleans up temp", async () => {
    const outputPath = path.join(TEST_VAR_DIR, "race-match.json");
    let stderr = "";

    const exitCode = await runCli([
      "match",
      "--bot-a", "first-legal",
      "--bot-b", "first-legal",
      "--output", outputPath
    ], {
      stdout: () => {},
      stderr: (msg) => { stderr += msg + "\n"; },
      onBeforePublish: () => {
        // Concurrently create destination file before publish
        fs.writeFileSync(outputPath, "concurrently-created-content", "utf8");
      }
    });

    assert.equal(exitCode, 2, "concurrent target creation without --overwrite must exit 2");
    assert.ok(stderr.includes("exists") || stderr.includes("overwrite"));
    assert.equal(fs.readFileSync(outputPath, "utf8"), "concurrently-created-content");

    const files = fs.readdirSync(TEST_VAR_DIR);
    const orphanTemps = files.filter((f) => f.startsWith(".race-match.json.tmp-"));
    assert.equal(orphanTemps.length, 0, "temporary file must be cleaned up");
  });

  it("exits with code 1 if match setup encounters an infrastructure failure", async () => {
    const outputPath = path.join(TEST_VAR_DIR, "setup-fail.json");
    let stderr = "";

    const exitCode = await runCli([
      "match",
      "--bot-a", "first-legal",
      "--bot-b", "first-legal",
      "--output", outputPath
    ], {
      stdout: () => {},
      stderr: (msg) => { stderr += msg + "\n"; },
      getEngine: () => {
        throw new Error("Simulated engine initialization failure");
      }
    });

    assert.equal(exitCode, 1, "setup failure must exit 1");
    assert.ok(stderr.includes("Simulated engine initialization failure") || stderr.includes("Infrastructure error"));
    assert.equal(fs.existsSync(outputPath), false);
  });
});

describe("Arena CLI: child_process smoke test", () => {
  it("executes CLI doctor via real node process with exit code 0", () => {
    const output = execFileSync(process.execPath, [CLI_PATH, "doctor"], {
      encoding: "utf8",
      cwd: path.resolve(__dirname, "..")
    });
    assert.ok(output.includes("ottv2-g-default-v1"));
    assert.ok(output.includes("trusted-local: available"));
    assert.ok(output.includes("sandbox: unavailable"));
  });

  it("executes CLI match via real node process into var/arena and produces valid replay", () => {
    const outputPath = path.join(TEST_VAR_DIR, "real-smoke.json");
    const output = execFileSync(
      process.execPath,
      [CLI_PATH, "match", "--bot-a", "first-legal", "--bot-b", "first-legal", "--output", outputPath],
      {
        encoding: "utf8",
        cwd: path.resolve(__dirname, "..")
      }
    );

    assert.ok(output.includes("Match completed"));
    assert.ok(fs.existsSync(outputPath));
    const replay = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    const validation = validateReplayDocument(replay);
    assert.equal(validation.ok, true);
  });
});
