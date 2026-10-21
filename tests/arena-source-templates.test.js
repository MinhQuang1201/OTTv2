/**
 * tests/arena-source-templates.test.js
 *
 * Real local execution smoke test of exported bot source templates:
 * - NODE_TEMPLATE: Executed via Node.js child process over stdin/stdout NDJSON.
 * - PYTHON_TEMPLATE: Executed via Python child process (if available).
 *
 * Verifies that the starter code:
 * 1. Conforms to the official Arena Protocol v1 without fabricated stubs.
 * 2. Parses valid NDJSON turn envelopes.
 * 3. Selects legal moves conforming to validateBotAction.
 * 4. Stays alive across multiple plies.
 * 5. Strictly keeps stdout clean for NDJSON responses (logs to stderr).
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");
const readline = require("node:readline");

const TEMP_BASE = path.resolve(os.tmpdir(), "arena-template-smoke-" + Date.now());

let NODE_TEMPLATE;
let PYTHON_TEMPLATE;
let validateBotTurn;
let validateBotAction;

function extractTemplatesFromSource() {
  const templatesPath = path.resolve(
    __dirname,
    "../apps/web/src/features/arena/bots/templates.ts"
  );
  const tsCode = fs.readFileSync(templatesPath, "utf8");

  // Transpile TypeScript to CommonJS using esbuild (or fallback to typescript)
  let cjsCode;
  try {
    const esbuild = require("esbuild");
    const result = esbuild.transformSync(tsCode, { loader: "ts", format: "cjs" });
    cjsCode = result.code;
  } catch {
    const ts = require("typescript");
    const result = ts.transpileModule(tsCode, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    });
    cjsCode = result.outputText;
  }

  const mod = { exports: {} };
  const fn = new Function("module", "exports", cjsCode);
  fn(mod, mod.exports);

  return {
    NODE_TEMPLATE: mod.exports.NODE_TEMPLATE,
    PYTHON_TEMPLATE: mod.exports.PYTHON_TEMPLATE
  };
}

/**
 * Helper to communicate with an NDJSON bot process.
 */
function createBotSession(command, args) {
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONUNBUFFERED: "1" }
  });

  const rl = readline.createInterface({
    input: child.stdout,
    terminal: false
  });

  const responseQueue = [];
  let pendingResolver = null;
  let stderrOutput = "";

  child.stderr.on("data", (chunk) => {
    stderrOutput += chunk.toString("utf8");
  });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (pendingResolver) {
      const resolve = pendingResolver;
      pendingResolver = null;
      resolve(trimmed);
    } else {
      responseQueue.push(trimmed);
    }
  });

  function sendTurn(turnPayload) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Bot timed out waiting for response to requestId=${turnPayload.requestId}`));
      }, 5000);

      const onGotLine = (line) => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(line);
          resolve(parsed);
        } catch (err) {
          reject(new Error(`Bot returned invalid JSON on stdout: "${line}" (${err.message})`));
        }
      };

      if (responseQueue.length > 0) {
        onGotLine(responseQueue.shift());
      } else {
        pendingResolver = onGotLine;
      }

      child.stdin.write(JSON.stringify(turnPayload) + "\n");
    });
  }

  function close() {
    return new Promise((resolve) => {
      rl.close();
      if (!child.killed) {
        child.stdin.end();
        child.kill();
      }
      child.on("close", () => resolve({ stderr: stderrOutput }));
      setTimeout(resolve, 500);
    });
  }

  return { child, sendTurn, close };
}

before(async () => {
  fs.mkdirSync(TEMP_BASE, { recursive: true });

  const templates = extractTemplatesFromSource();
  NODE_TEMPLATE = templates.NODE_TEMPLATE;
  PYTHON_TEMPLATE = templates.PYTHON_TEMPLATE;

  assert.ok(NODE_TEMPLATE, "NODE_TEMPLATE must be non-empty");
  assert.ok(PYTHON_TEMPLATE, "PYTHON_TEMPLATE must be non-empty");

  const contractsMod = await import("../packages/arena/src/contracts/index.mjs");
  validateBotTurn = contractsMod.validateBotTurn;
  validateBotAction = contractsMod.validateBotAction;
});

after(() => {
  try {
    fs.rmSync(TEMP_BASE, { recursive: true, force: true });
  } catch (_) {}
});

describe("Arena Bot Source Templates Execution Smoke", () => {
  it("NODE_TEMPLATE executes as a real process, handles multiple turns, and outputs valid actions", async () => {
    const botPath = path.join(TEMP_BASE, "node-bot.mjs");
    fs.writeFileSync(botPath, NODE_TEMPLATE, "utf8");

    const session = createBotSession(process.execPath, [botPath]);

    try {
      // ── Turn 1 (Ply 1) ──────────────────────────────────────────────────────
      const turn1 = {
        protocolVersion: 1,
        type: "turn",
        requestId: "turn-req-node-1",
        matchId: "match-smoke-node",
        rulesetId: "ruleset-default",
        rulesetHash: "hash-001",
        boardWidth: 9,
        boardHeight: 9,
        ply: 1,
        turn: "A",
        timeRemainingMs: 30000,
        turnTimeLimitMs: 5000,
        board: [{ id: "p1", owner: "A", type: "dam", x: 4, y: 0 }],
        legalMoves: [
          { from: { x: 4, y: 0 }, to: { x: 4, y: 1 } },
          { from: { x: 4, y: 0 }, to: { x: 5, y: 0 } }
        ]
      };

      const turnVal1 = validateBotTurn(turn1);
      assert.equal(turnVal1.ok, true, `Turn 1 must be valid: ${turnVal1.errors?.map((e) => e.message).join(", ")}`);

      const res1 = await session.sendTurn(turn1);

      // Validate response against official arena contracts
      const actionVal1 = validateBotAction(res1, turn1.requestId);
      assert.equal(actionVal1.ok, true, `Bot action must validate: ${actionVal1.errors?.map((e) => e.message).join(", ")}`);
      assert.equal(res1.protocolVersion, 1);
      assert.equal(res1.requestId, turn1.requestId);
      assert.deepEqual(res1.move, { from: { x: 4, y: 0 }, to: { x: 4, y: 1 } });
      assert.equal(typeof res1.comment, "string");

      // ── Turn 2 (Ply 2): verifies bot survives and handles sequential turns ──
      const turn2 = {
        protocolVersion: 1,
        type: "turn",
        requestId: "turn-req-node-2",
        matchId: "match-smoke-node",
        rulesetId: "ruleset-default",
        rulesetHash: "hash-001",
        boardWidth: 9,
        boardHeight: 9,
        ply: 2,
        turn: "A",
        timeRemainingMs: 29500,
        turnTimeLimitMs: 5000,
        board: [{ id: "p1", owner: "A", type: "dam", x: 4, y: 1 }],
        legalMoves: [
          { from: { x: 4, y: 1 }, to: { x: 4, y: 2 } }
        ]
      };

      const res2 = await session.sendTurn(turn2);
      const actionVal2 = validateBotAction(res2, turn2.requestId);
      assert.equal(actionVal2.ok, true);
      assert.equal(res2.requestId, turn2.requestId);
      assert.deepEqual(res2.move, { from: { x: 4, y: 1 }, to: { x: 4, y: 2 } });
    } finally {
      await session.close();
    }
  });

  it("PYTHON_TEMPLATE executes as a real process, handles turns, and outputs valid actions (if Python available)", async (t) => {
    let pyCommand = "python";
    const check = spawnSync(pyCommand, ["--version"], { encoding: "utf8" });
    if (check.error || check.status !== 0) {
      pyCommand = "python3";
      const check3 = spawnSync(pyCommand, ["--version"], { encoding: "utf8" });
      if (check3.error || check3.status !== 0) {
        t.skip("Python executable is not available on this machine");
        return;
      }
    }

    const botPath = path.join(TEMP_BASE, "python-bot.py");
    fs.writeFileSync(botPath, PYTHON_TEMPLATE, "utf8");

    const session = createBotSession(pyCommand, [botPath]);

    try {
      const turn1 = {
        protocolVersion: 1,
        type: "turn",
        requestId: "turn-req-py-1",
        matchId: "match-smoke-py",
        rulesetId: "ruleset-default",
        rulesetHash: "hash-001",
        boardWidth: 9,
        boardHeight: 9,
        ply: 1,
        turn: "A",
        timeRemainingMs: 30000,
        turnTimeLimitMs: 5000,
        board: [{ id: "p2", owner: "A", type: "la", x: 3, y: 0 }],
        legalMoves: [
          { from: { x: 3, y: 0 }, to: { x: 3, y: 1 } },
          { from: { x: 3, y: 0 }, to: { x: 2, y: 0 } }
        ]
      };

      const turnVal = validateBotTurn(turn1);
      assert.equal(turnVal.ok, true);

      const res1 = await session.sendTurn(turn1);

      const actionVal = validateBotAction(res1, turn1.requestId);
      assert.equal(actionVal.ok, true, `Python action must validate: ${actionVal.errors?.map((e) => e.message).join(", ")}`);
      assert.equal(res1.protocolVersion, 1);
      assert.equal(res1.requestId, turn1.requestId);
      assert.deepEqual(res1.move, { from: { x: 3, y: 0 }, to: { x: 3, y: 1 } });
    } finally {
      await session.close();
    }
  });

  it("ignores non-turn NDJSON packets and malformed input without terminating", async () => {
    const botPath = path.join(TEMP_BASE, "node-bot-resilient.mjs");
    fs.writeFileSync(botPath, NODE_TEMPLATE, "utf8");

    const session = createBotSession(process.execPath, [botPath]);

    try {
      // 1. Send blank lines and non-turn payload
      session.child.stdin.write("\n\n");
      session.child.stdin.write(JSON.stringify({ type: "heartbeat", ping: 123 }) + "\n");
      session.child.stdin.write("INVALID JSON LINE\n");

      // 2. Send valid turn immediately after: bot must still process valid turn cleanly
      const validTurn = {
        protocolVersion: 1,
        type: "turn",
        requestId: "turn-after-malformed",
        matchId: "m1",
        boardWidth: 9,
        boardHeight: 9,
        ply: 0,
        turn: "A",
        timeRemainingMs: 30000,
        turnTimeLimitMs: 5000,
        board: [],
        legalMoves: [{ from: { x: 0, y: 0 }, to: { x: 0, y: 1 } }]
      };

      const res = await session.sendTurn(validTurn);
      assert.equal(res.requestId, "turn-after-malformed");
      assert.deepEqual(res.move, { from: { x: 0, y: 0 }, to: { x: 0, y: 1 } });
    } finally {
      await session.close();
    }
  });
});
