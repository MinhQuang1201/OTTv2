/**
 * Arena Runtime Acceptance Suite — Task 6 & 7 (Milestone M2 Multi-Language Matrix)
 * Executes actual Python, Node, C++, and Java matches, verifies BuildService compilation,
 * syntax validation, replay generation, turn timeouts, stderr logging, and process cleanup.
 *
 * NOTE: Configured enabled profiles preflight is MANDATORY. Missing runtime exits with code 1.
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const {
  createProfileRegistry,
  probeExecutable
} = require("../../packages/arena-node/src/execution/profile-registry.mjs");

const { createArtifactStore } = require("../../packages/arena-node/src/artifacts/artifact-store.mjs");
const { createBuildService } = require("../../packages/arena-node/src/execution/build-service.mjs");
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
const NODE_BOT_PATH = path.resolve(__dirname, "../../sdk/arena/examples/first_legal.mjs");
const CPP_BOT_PATH = path.resolve(__dirname, "../../sdk/arena/examples/first_legal.cpp");
const JAVA_BOT_PATH = path.resolve(__dirname, "../../sdk/arena/examples/FirstLegal.java");

const TEMP_DIR = path.resolve(os.tmpdir(), "arena-runtime-test-" + Date.now());

// ---------------------------------------------------------------------------
// MANDATORY PREFLIGHT MATRIX CHECK
// ---------------------------------------------------------------------------
const ENABLED_PROFILES_ENV = process.env.OTT_ARENA_ENABLED_PROFILES;
const ENABLED_PROFILES = ENABLED_PROFILES_ENV
  ? ENABLED_PROFILES_ENV.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  : ["python", "node", "cpp", "java"];

console.log(`[Matrix Preflight] Host OS: ${process.platform} (${os.release()})`);
console.log(`[Matrix Preflight] Configured profiles: ${ENABLED_PROFILES.join(", ")}`);

const preflightRegistry = createProfileRegistry();
const matrixReport = [];

for (const profileId of ENABLED_PROFILES) {
  const probe = preflightRegistry.probeProfile(profileId);
  if (!probe.available) {
    console.error(`FATAL: Mandatory profile '${profileId}' preflight check FAILED.`);
    console.error(`Error: ${probe.error || "unavailable"}`);
    console.error("Runtime acceptance requires all configured enabled profiles to pass preflight.");
    process.exit(1); // Exit 1, NOT skip / NOT pass
  }
  matrixReport.push({
    profile: profileId,
    executable: probe.executable,
    version: probe.version,
    os: process.platform,
    status: "PASS"
  });
  console.log(`[Matrix Preflight] Profile '${profileId}' OK: ${probe.executable} (version: ${probe.version})`);
}

// ---------------------------------------------------------------------------
// SUITE
// ---------------------------------------------------------------------------

let engine;
let clock;
let rulesetSnapshot;
let rulesetHash;
let engineRevision;
let registry;
let artifactStore;
let buildService;

before(() => {
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  engine = createNodeEngine();
  clock = createNodeClock();
  rulesetSnapshot = createCurrentRulesetSnapshot(coreConfig);
  rulesetHash = computeRulesetHash(rulesetSnapshot);
  engineRevision = computeCurrentEngineFingerprint();
  registry = createProfileRegistry();
  artifactStore = createArtifactStore({ storageDir: path.join(TEMP_DIR, "artifacts") });
  buildService = createBuildService({ artifactStore, profileRegistry: registry });
});

after(() => {
  try {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch (_) {}
});

describe("M2 Multi-Language Matrix: Python Acceptance", () => {
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

    const doc = journal.getDocument();
    assert.ok(doc, "Replay document must exist");
    const validation = validateReplayDocument(doc);
    assert.equal(validation.ok, true, `Replay validation errors: ${JSON.stringify(validation.errors)}`);
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

    assert.equal(isProcessAlive(pyBotA.pid), false);
    assert.equal(isProcessAlive(pyBotB.pid), false);
  });

  it("forfeits Python bot on turn timeout and forcefully terminates child process", async () => {
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
      turnTimeLimitMs: 200
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
    assert.equal(isProcessAlive(slowBotA.pid), false);
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
    assert.ok(capturedStderr.includes("DIAGNOSTIC_LOG_FROM_PYTHON_STDERR"));
    assert.equal(isProcessAlive(loggingBotA.pid), false);
  });
});

describe("M2 Multi-Language Matrix: Node.js Acceptance", () => {
  it("plays a full match with Node SDK bot vs FunctionBot to valid replay", async () => {
    const journal = createReplayJournal();

    const nodeBotA = registry.resolveBot(`node:${NODE_BOT_PATH}`, {
      botId: "real-node-bot-a",
      clock
    });

    const fnBotB = registry.resolveBot("first-legal", {
      botId: "first-legal-b"
    });

    const controller = createHeadlessMatchController({
      matchId: `rt-node-vs-fl-${Date.now()}`,
      engine,
      botA: nodeBotA,
      botB: fnBotB,
      clock,
      journal,
      policy: DEFAULT_MATCH_POLICY,
      rulesetSnapshot,
      rulesetHash,
      engineRevision,
      participants: {
        A: { botId: "real-node-bot-a", name: "node:first_legal.mjs", isFunctionBot: false },
        B: { botId: "first-legal-b", name: "first-legal", isFunctionBot: true }
      }
    });

    const result = await controller.run();
    assert.ok(result.outcome === "win" || result.outcome === "draw");
    assert.ok(result.acceptedPlies > 0);

    const doc = journal.getDocument();
    assert.ok(doc);
    const validation = validateReplayDocument(doc);
    assert.equal(validation.ok, true);
    assert.equal(isProcessAlive(nodeBotA.pid), false);
  });

  it("plays a cross-language match: Python SDK bot vs Node SDK bot", async () => {
    const journal = createReplayJournal();

    const pyBotA = registry.resolveBot(`python:${PYTHON_BOT_PATH}`, {
      botId: "real-py-bot-a",
      clock
    });

    const nodeBotB = registry.resolveBot(`node:${NODE_BOT_PATH}`, {
      botId: "real-node-bot-b",
      clock
    });

    const controller = createHeadlessMatchController({
      matchId: `rt-py-vs-node-${Date.now()}`,
      engine,
      botA: pyBotA,
      botB: nodeBotB,
      clock,
      journal,
      policy: DEFAULT_MATCH_POLICY,
      rulesetSnapshot,
      rulesetHash,
      engineRevision,
      participants: {
        A: { botId: "real-py-bot-a", name: "python:first_legal.py", isFunctionBot: false },
        B: { botId: "real-node-bot-b", name: "node:first_legal.mjs", isFunctionBot: false }
      }
    });

    const result = await controller.run();
    assert.ok(result.outcome === "win" || result.outcome === "draw");
    assert.ok(result.acceptedPlies > 0);

    const doc = journal.getDocument();
    assert.ok(doc);
    const validation = validateReplayDocument(doc);
    assert.equal(validation.ok, true);

    assert.equal(isProcessAlive(pyBotA.pid), false);
    assert.equal(isProcessAlive(nodeBotB.pid), false);
  });
});

describe("M2 Multi-Language Matrix: Syntax & Build Validation", () => {
  it("rejects invalid Python syntax during build validation", async () => {
    const invalidPySource = "def broken(\n  return 42"; // SyntaxError
    const res = await buildService.build({
      sourceContent: invalidPySource,
      profileId: "python"
    });

    assert.equal(res.status, "FAILED");
    assert.equal(res.error, "compile_failure");
    assert.equal(res.artifactDigest, null);
    assert.ok(res.logs.includes("SyntaxError") || res.logs.length > 0);
  });

  it("rejects invalid Node.js syntax during build validation", async () => {
    const invalidNodeSource = "const x = ;"; // SyntaxError
    const res = await buildService.build({
      sourceContent: invalidNodeSource,
      profileId: "node"
    });

    assert.equal(res.status, "FAILED");
    assert.equal(res.error, "compile_failure");
    assert.equal(res.artifactDigest, null);
    assert.ok(res.logs.includes("SyntaxError") || res.logs.includes("Unexpected token"));
  });
});

describe("M2 Multi-Language Matrix: C++17 Acceptance", () => {
  it("builds C++17 bot via BuildService and plays match to valid replay", async () => {
    if (!ENABLED_PROFILES.includes("cpp")) {
      return; // Disabled
    }

    const buildRes = await buildService.build({
      sourcePath: CPP_BOT_PATH,
      profileId: "cpp"
    });

    assert.equal(buildRes.status, "READY");
    assert.ok(buildRes.artifactDigest);
    assert.equal(buildRes.manifest.profileId, "cpp");

    const resolved = await artifactStore.resolveArtifact(buildRes.artifactDigest);
    assert.ok(resolved);
    assert.ok(fs.existsSync(resolved.path));

    // Play real match with compiled C++ binary
    const cppBotA = registry.resolveBot(`cpp:${resolved.path}`, {
      botId: "real-cpp-bot-a",
      clock
    });

    const fnBotB = registry.resolveBot("first-legal", {
      botId: "first-legal-b"
    });

    const journal = createReplayJournal();

    const controller = createHeadlessMatchController({
      matchId: `rt-cpp-vs-fl-${Date.now()}`,
      engine,
      botA: cppBotA,
      botB: fnBotB,
      clock,
      journal,
      policy: DEFAULT_MATCH_POLICY,
      rulesetSnapshot,
      rulesetHash,
      engineRevision,
      participants: {
        A: { botId: "real-cpp-bot-a", name: "cpp:first_legal", isFunctionBot: false },
        B: { botId: "first-legal-b", name: "first-legal", isFunctionBot: true }
      }
    });

    const matchRes = await controller.run();
    assert.ok(matchRes.outcome === "win" || matchRes.outcome === "draw");
    assert.ok(matchRes.acceptedPlies > 0);

    const doc = journal.getDocument();
    assert.ok(doc);
    const validation = validateReplayDocument(doc);
    assert.equal(validation.ok, true);
    assert.equal(isProcessAlive(cppBotA.pid), false);
  });

  it("records FAILED status on C++ compilation error", async () => {
    if (!ENABLED_PROFILES.includes("cpp")) {
      return;
    }

    const invalidCpp = "int main() { broken_syntax_here; }";
    const res = await buildService.build({
      sourceContent: invalidCpp,
      profileId: "cpp"
    });

    assert.equal(res.status, "FAILED");
    assert.equal(res.error, "compile_failure");
    assert.ok(res.logs.includes("error"));
  });
});

describe("M2 Multi-Language Matrix: Java 21 Acceptance", () => {
  it("builds Java 21 bot via BuildService and plays match to valid replay", async () => {
    if (!ENABLED_PROFILES.includes("java")) {
      return;
    }

    const buildRes = await buildService.build({
      sourcePath: JAVA_BOT_PATH,
      profileId: "java"
    });

    assert.equal(buildRes.status, "READY");
    assert.ok(buildRes.artifactDigest);
    assert.equal(buildRes.manifest.profileId, "java");

    const resolved = await artifactStore.resolveArtifact(buildRes.artifactDigest);
    assert.ok(resolved);
    assert.ok(fs.existsSync(resolved.path));

    // Play real match with compiled Java bot
    const javaBotA = registry.resolveBot(`java:${resolved.path}`, {
      botId: "real-java-bot-a",
      clock
    });

    const fnBotB = registry.resolveBot("first-legal", {
      botId: "first-legal-b"
    });

    const journal = createReplayJournal();

    const controller = createHeadlessMatchController({
      matchId: `rt-java-vs-fl-${Date.now()}`,
      engine,
      botA: javaBotA,
      botB: fnBotB,
      clock,
      journal,
      policy: DEFAULT_MATCH_POLICY,
      rulesetSnapshot,
      rulesetHash,
      engineRevision,
      participants: {
        A: { botId: "real-java-bot-a", name: "java:FirstLegal", isFunctionBot: false },
        B: { botId: "first-legal-b", name: "first-legal", isFunctionBot: true }
      }
    });

    const matchRes = await controller.run();
    assert.ok(matchRes.outcome === "win" || matchRes.outcome === "draw");
    assert.ok(matchRes.acceptedPlies > 0);

    const doc = journal.getDocument();
    assert.ok(doc);
    const validation = validateReplayDocument(doc);
    assert.equal(validation.ok, true);
    assert.equal(isProcessAlive(javaBotA.pid), false);
  });

  it("records FAILED status on Java compilation error", async () => {
    if (!ENABLED_PROFILES.includes("java")) {
      return;
    }

    const invalidJava = "public class BadJava { broken_syntax_here; }";
    const res = await buildService.build({
      sourceContent: invalidJava,
      profileId: "java"
    });

    assert.equal(res.status, "FAILED");
    assert.equal(res.error, "compile_failure");
    assert.ok(res.logs.includes("error") || res.logs.includes("BadJava"));
  });
});
