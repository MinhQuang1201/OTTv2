/**
 * Arena Runtime Acceptance Suite — Task 6 (Milestone M2-Python Gate)
 * Executes actual Python 3.12 matches, verifies replay generation, turn timeouts,
 * stderr logging separation, and process cleanup.
 *
 * NOTE: Python runtime preflight is MANDATORY. Missing runtime exits with code 1 (not skip/pass).
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const {
  createProfileRegistry,
  probeExecutable,
  resolvePythonExecutable
} = require("../../packages/arena-node/src/execution/profile-registry.mjs");

const { isProcessAlive } = require("../../packages/arena-node/src/execution/process-tree.mjs");
const { createHeadlessMatchController } = require("../../packages/arena/src/application/match-controller.mjs");
const { createReplayJournal } = require("../../packages/arena/src/application/replay-journal.mjs");
const { createNodeEngine, coreConfig } = require("../../packages/arena-node/src/core/node-engine.mjs");
const {
  computeRulesetHash,
  computeCurrentEngineFingerprint
} = require("../../packages/arena-node/src/core/ruleset-identity.mjs");
const { createCurrentRulesetSnapshot, validateReplayDocument, DEFAULT_MATCH_POLICY } = require("../../packages/arena/src/contracts/index.mjs");
const { createNodeClock } = require("../../packages/arena-node/src/clock/node-clock.mjs");

const PYTHON_BOT_PATH = path.resolve(__dirname, "../../sdk/arena/examples/first_legal.py");
const TEMP_DIR = path.resolve(os.tmpdir(), "arena-runtime-test-" + Date.now());

// ---------------------------------------------------------------------------
// MANDATORY PREFLIGHT CHECK
// ---------------------------------------------------------------------------
const preflightPython = resolvePythonExecutable();
const preflightProbe = probeExecutable(preflightPython.executable, ["--version"], 2000);

if (!preflightProbe.ok) {
  console.error("FATAL: Mandatory Python runtime preflight check FAILED.");
  console.error(`Probed candidate: "${preflightPython.executable}" (${preflightPython.source})`);
  console.error(`Error: ${preflightProbe.error || preflightProbe.stderr || "non-zero exit"}`);
  console.error("M2-Python acceptance requires a working Python 3 installation on the host system.");
  process.exit(1); // Exit 1, NOT skip / NOT pass
}

console.log(`[Preflight] Mandatory Python runtime verified: ${preflightProbe.stdout.trim()} (${preflightPython.executable})`);

// ---------------------------------------------------------------------------
// SUITE
// ---------------------------------------------------------------------------

let engine;
let clock;
let rulesetSnapshot;
let rulesetHash;
let engineRevision;
let registry;

before(() => {
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  engine = createNodeEngine();
  clock = createNodeClock();
  rulesetSnapshot = createCurrentRulesetSnapshot(coreConfig);
  rulesetHash = computeRulesetHash(rulesetSnapshot);
  engineRevision = computeCurrentEngineFingerprint();
  registry = createProfileRegistry();
});

after(() => {
  try {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch (_) {}
});

describe("M2-Python Runtime Acceptance: Real Python SDK execution", () => {
  it("plays a full match with Python SDK bot vs FunctionBot to valid replay", async () => {
    const journal = createReplayJournal();

    const pyBotA = registry.resolveBot(`python:${PYTHON_BOT_PATH}`, {
      botId: "real-py-bot-a",
      clock
    });

    const fnBotB = registry.resolveBot("first-legal", {
      botId: "first-legal-b"
    });

    const controller = createHeadlessMatchController({
      matchId: `rt-py-vs-fl-${Date.now()}`,
      engine,
      botA: pyBotA,
      botB: fnBotB,
      clock,
      journal,
      policy: DEFAULT_MATCH_POLICY,
      rulesetSnapshot,
      rulesetHash,
      engineRevision,
      participants: {
        A: { botId: "real-py-bot-a", name: "python:first_legal.py", isFunctionBot: false },
        B: { botId: "first-legal-b", name: "first-legal", isFunctionBot: true }
      }
    });

    const result = await controller.run();
    assert.ok(result.outcome === "win" || result.outcome === "draw", `Expected normal outcome, got: ${result.outcome}`);
    assert.ok(result.acceptedPlies > 0, "Match must have accepted at least 1 ply");

    // Replay document validation
    const doc = journal.getDocument();
    assert.ok(doc, "Replay document must exist");
    const validation = validateReplayDocument(doc);
    assert.equal(validation.ok, true, `Replay validation errors: ${JSON.stringify(validation.errors)}`);

    // Verify Python bot process is cleaned up
    assert.equal(isProcessAlive(pyBotA.pid), false, "Python process must be terminated after match");
  });

  it("plays a real match between two Python SDK bots (Python vs Python)", async () => {
    const journal = createReplayJournal();

    const pyBotA = registry.resolveBot(`python:${PYTHON_BOT_PATH}`, {
      botId: "real-py-bot-a",
      clock
    });

    const pyBotB = registry.resolveBot(`python:${PYTHON_BOT_PATH}`, {
      botId: "real-py-bot-b",
      clock
    });

    const controller = createHeadlessMatchController({
      matchId: `rt-py-vs-py-${Date.now()}`,
      engine,
      botA: pyBotA,
      botB: pyBotB,
      clock,
      journal,
      policy: DEFAULT_MATCH_POLICY,
      rulesetSnapshot,
      rulesetHash,
      engineRevision,
      participants: {
        A: { botId: "real-py-bot-a", name: "python:first_legal.py", isFunctionBot: false },
        B: { botId: "real-py-bot-b", name: "python:first_legal.py", isFunctionBot: false }
      }
    });

    const result = await controller.run();
    assert.ok(result.outcome === "win" || result.outcome === "draw");
    assert.ok(result.acceptedPlies > 0);

    const doc = journal.getDocument();
    assert.ok(doc);
    const validation = validateReplayDocument(doc);
    assert.equal(validation.ok, true);

    // Verify both processes terminated
    assert.equal(isProcessAlive(pyBotA.pid), false);
    assert.equal(isProcessAlive(pyBotB.pid), false);
  });

  it("forfeits Python bot on turn timeout and forcefully terminates child process", async () => {
    // Create a slow Python bot that sleeps for 2 seconds
    const slowBotPath = path.join(TEMP_DIR, "slow_bot.py");
    fs.writeFileSync(
      slowBotPath,
      [
        "import time",
        "import sys",
        "from pathlib import Path",
        `sys.path.insert(0, r'${path.resolve(__dirname, "../../sdk/arena/python")}')`,
        "from ott_bot import run_bot",
        "def slow_choose(turn):",
        "    time.sleep(2.0)",
        "    return turn['legalMoves'][0]",
        "if __name__ == '__main__':",
        "    run_bot(slow_choose)"
      ].join("\n"),
      "utf8"
    );

    const journal = createReplayJournal();

    const slowBotA = registry.resolveBot(`python:${slowBotPath}`, {
      botId: "slow-py-bot-a",
      clock
    });

    const fnBotB = registry.resolveBot("first-legal", {
      botId: "first-legal-b"
    });

    const strictTimeoutPolicy = {
      ...DEFAULT_MATCH_POLICY,
      turnTimeLimitMs: 200 // 200ms limit
    };

    const controller = createHeadlessMatchController({
      matchId: `rt-py-timeout-${Date.now()}`,
      engine,
      botA: slowBotA,
      botB: fnBotB,
      clock,
      journal,
      policy: strictTimeoutPolicy,
      rulesetSnapshot,
      rulesetHash,
      engineRevision,
      participants: {
        A: { botId: "slow-py-bot-a", name: "slow-python", isFunctionBot: false },
        B: { botId: "first-legal-b", name: "first-legal", isFunctionBot: true }
      }
    });

    const result = await controller.run();
    assert.equal(result.outcome, "forfeit");
    assert.equal(result.reason, "turn_timeout");
    assert.equal(result.loser, "A");
    assert.equal(result.winner, "B");

    // Verify slow Python bot process was terminated
    assert.equal(isProcessAlive(slowBotA.pid), false, "Slow bot process must be dead after timeout");
  });

  it("separates stderr diagnostic logging from clean stdout NDJSON streams", async () => {
    const loggingBotPath = path.join(TEMP_DIR, "logging_bot.py");
    fs.writeFileSync(
      loggingBotPath,
      [
        "import sys",
        "from pathlib import Path",
        `sys.path.insert(0, r'${path.resolve(__dirname, "../../sdk/arena/python")}')`,
        "from ott_bot import run_bot, log",
        "def log_choose(turn):",
        "    log('DIAGNOSTIC_LOG_FROM_PYTHON_STDERR')",
        "    return turn['legalMoves'][0]",
        "if __name__ == '__main__':",
        "    run_bot(log_choose)"
      ].join("\n"),
      "utf8"
    );

    const journal = createReplayJournal();
    let capturedStderr = "";

    const loggingBotA = registry.resolveBot(`python:${loggingBotPath}`, {
      botId: "logging-py-bot-a",
      clock,
      onStderr(chunk) {
        capturedStderr += chunk.toString("utf8");
      }
    });

    const fnBotB = registry.resolveBot("first-legal", {
      botId: "first-legal-b"
    });

    const controller = createHeadlessMatchController({
      matchId: `rt-py-stderr-${Date.now()}`,
      engine,
      botA: loggingBotA,
      botB: fnBotB,
      clock,
      journal,
      policy: DEFAULT_MATCH_POLICY,
      rulesetSnapshot,
      rulesetHash,
      engineRevision,
      participants: {
        A: { botId: "logging-py-bot-a", name: "logging-python", isFunctionBot: false },
        B: { botId: "first-legal-b", name: "first-legal", isFunctionBot: true }
      }
    });

    const result = await controller.run();
    assert.ok(result.outcome === "win" || result.outcome === "draw");
    assert.ok(capturedStderr.includes("DIAGNOSTIC_LOG_FROM_PYTHON_STDERR"), "Stderr logs must be captured without corrupting stdout");
    assert.equal(isProcessAlive(loggingBotA.pid), false);
  });
});
