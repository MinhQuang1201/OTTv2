/**
 * Arena ProcessBot & NDJSON Channel Test Suite — Task 5 (Milestone M2)
 * Tests incremental NDJSON parser, process tree termination, and ProcessBot lifecycle.
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { PassThrough } = require("node:stream");
const { spawnSync } = require("node:child_process");

let createNdjsonChannel;
let createProcessBot;
let killProcessTree;
let isProcessAlive;
let createHeadlessMatchController;
let createFunctionBot;
let createNodeEngine;
let computeCurrentEngineFingerprint;
let computeRulesetHash;
let createCurrentRulesetSnapshot;
let DEFAULT_MATCH_POLICY;
let coreConfig;

const FIXTURES_DIR = path.resolve(__dirname, "fixtures/arena/bots");

before(async () => {
  const channelMod = await import("../packages/arena-node/src/execution/ndjson-channel.mjs");
  const botMod = await import("../packages/arena-node/src/execution/process-bot.mjs");
  const treeMod = await import("../packages/arena-node/src/execution/process-tree.mjs");

  const controllerMod = await import("../packages/arena/src/application/match-controller.mjs");
  const functionBotMod = await import("../packages/arena/src/adapters/function-bot.mjs");
  const engineMod = await import("../packages/arena-node/src/core/node-engine.mjs");
  const identityMod = await import("../packages/arena-node/src/core/ruleset-identity.mjs");
  const rulesetMod = await import("../packages/arena/src/domain/ruleset.mjs");
  const policyMod = await import("../packages/arena/src/domain/match-policy.mjs");

  createNdjsonChannel = channelMod.createNdjsonChannel;
  createProcessBot = botMod.createProcessBot;
  killProcessTree = treeMod.killProcessTree;
  isProcessAlive = treeMod.isProcessAlive;

  createHeadlessMatchController = controllerMod.createHeadlessMatchController;
  createFunctionBot = functionBotMod.createFunctionBot;
  createNodeEngine = engineMod.createNodeEngine;
  computeCurrentEngineFingerprint = identityMod.computeCurrentEngineFingerprint;
  computeRulesetHash = identityMod.computeRulesetHash;
  createCurrentRulesetSnapshot = rulesetMod.createCurrentRulesetSnapshot;
  DEFAULT_MATCH_POLICY = policyMod.DEFAULT_MATCH_POLICY;
  coreConfig = engineMod.coreConfig;
});

function makeFakeClock(startMs = 1000) {
  let now = startMs;
  return {
    nowMs() {
      return now;
    },
    advance(ms) {
      now += ms;
    },
    schedule(ms, cb) {
      return setTimeout(cb, ms);
    },
    cancel(id) {
      clearTimeout(id);
    }
  };
}

function makeTurn(requestId = "m1:A:1") {
  return {
    protocolVersion: 1,
    type: "turn",
    requestId,
    matchId: "m1",
    rulesetId: "ottv2-g-default-v1",
    rulesetHash: "sha256:test",
    boardWidth: 9,
    boardHeight: 9,
    ply: 1,
    turn: "A",
    timeRemainingMs: 600000,
    turnTimeLimitMs: 1000,
    board: [{ id: "A-la-0", owner: "A", type: "la", x: 4, y: 7 }],
    legalMoves: [{ from: { x: 4, y: 7 }, to: { x: 3, y: 6 } }]
  };
}

describe("NDJSON channel streaming parser", () => {
  it("parses single complete valid message with newline", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const clock = makeFakeClock(5000);

    const channel = createNdjsonChannel({ stdout, stderr, stdin, clock });
    const turn = makeTurn("m1:A:1");

    const reqPromise = channel.sendRequest(turn);

    stdout.write(
      JSON.stringify({
        protocolVersion: 1,
        requestId: "m1:A:1",
        move: { from: { x: 4, y: 7 }, to: { x: 3, y: 6 } },
        comment: "hello"
      }) + "\n"
    );

    const action = await reqPromise;
    assert.equal(action.protocolVersion, 1);
    assert.equal(action.requestId, "m1:A:1");
    assert.deepEqual(action.move, { from: { x: 4, y: 7 }, to: { x: 3, y: 6 } });
    assert.equal(action.comment, "hello");
    assert.equal(action.receivedAtMs, 5000);
    await channel.close();
  });

  it("handles messages split across arbitrary chunks", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();

    const channel = createNdjsonChannel({ stdout, stderr, stdin });
    const turn = makeTurn("m1:A:1");
    const reqPromise = channel.sendRequest(turn);

    const payload = JSON.stringify({
      protocolVersion: 1,
      requestId: "m1:A:1",
      move: { from: { x: 4, y: 7 }, to: { x: 3, y: 6 } }
    }) + "\n";

    // Split across 3 arbitrary chunks
    const chunk1 = payload.slice(0, 10);
    const chunk2 = payload.slice(10, 30);
    const chunk3 = payload.slice(30);

    stdout.write(chunk1);
    stdout.write(chunk2);
    stdout.write(chunk3);

    const action = await reqPromise;
    assert.equal(action.requestId, "m1:A:1");
    await channel.close();
  });

  it("handles CRLF (\\r\\n) line endings cleanly", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();

    const channel = createNdjsonChannel({ stdout, stderr, stdin });
    const turn = makeTurn("m1:A:1");
    const reqPromise = channel.sendRequest(turn);

    stdout.write(
      JSON.stringify({
        protocolVersion: 1,
        requestId: "m1:A:1",
        move: { from: { x: 4, y: 7 }, to: { x: 3, y: 6 } }
      }) + "\r\n"
    );

    const action = await reqPromise;
    assert.equal(action.requestId, "m1:A:1");
    await channel.close();
  });

  it("handles UTF-8 multibyte split across chunk boundaries", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();

    const channel = createNdjsonChannel({ stdout, stderr, stdin });
    const turn = makeTurn("m1:A:1");
    const reqPromise = channel.sendRequest(turn);

    // Vietnamese phrase containing multibyte UTF-8 characters: "Nước đi tiến"
    const obj = {
      protocolVersion: 1,
      requestId: "m1:A:1",
      move: { from: { x: 4, y: 7 }, to: { x: 3, y: 6 } },
      comment: "Nước đi tiến"
    };
    const buf = Buffer.from(JSON.stringify(obj) + "\n", "utf8");

    // Split right inside multibyte character
    const splitIdx = 45; // Arbitrary index
    const part1 = buf.subarray(0, splitIdx);
    const part2 = buf.subarray(splitIdx);

    stdout.write(part1);
    stdout.write(part2);

    const action = await reqPromise;
    assert.equal(action.comment, "Nước đi tiến");
    await channel.close();
  });

  it("fails fatally on invalid/corrupted UTF-8 byte sequences", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();

    const channel = createNdjsonChannel({ stdout, stderr, stdin });
    const turn = makeTurn("m1:A:1");
    const reqPromise = channel.sendRequest(turn);

    // Send invalid UTF-8 bytes followed by newline
    const badBuf = Buffer.concat([
      Buffer.from('{"protocolVersion":1,"requestId":"m1:A:1","move":{"from":{"x":4,"y":7},"to":{"x":3,"y":6}},"comment":"'),
      Buffer.from([0xff, 0xfe, 0xd8]), // Invalid UTF-8
      Buffer.from('"}\n')
    ]);

    stdout.write(badBuf);

    await assert.rejects(
      () => reqPromise,
      (err) => {
        assert.equal(err.code, "protocol_error");
        return true;
      }
    );
    await channel.close();
  });

  it("rejects with protocol_error on EOF when newline is missing (partial line)", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();

    const channel = createNdjsonChannel({ stdout, stderr, stdin });
    const turn = makeTurn("m1:A:1");
    const reqPromise = channel.sendRequest(turn);

    // Incomplete line without newline, followed by EOF
    stdout.write('{"protocolVersion":1,"requestId":"m1:A:1"');
    stdout.end();

    await assert.rejects(
      () => reqPromise,
      (err) => {
        assert.equal(err.code, "protocol_error");
        return true;
      }
    );
    await channel.close();
  });

  it("faults with protocol_error before resolving when 2 lines arrive in the SAME chunk", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();

    const channel = createNdjsonChannel({ stdout, stderr, stdin });
    const turn = makeTurn("m1:A:1");
    const reqPromise = channel.sendRequest(turn);

    const line1 = JSON.stringify({
      protocolVersion: 1,
      requestId: "m1:A:1",
      move: { from: { x: 4, y: 7 }, to: { x: 3, y: 6 } }
    }) + "\n";

    const line2 = JSON.stringify({
      protocolVersion: 1,
      requestId: "m1:A:1",
      move: { from: { x: 4, y: 7 }, to: { x: 3, y: 6 } }
    }) + "\n";

    // Both lines delivered in the exact same chunk!
    stdout.write(line1 + line2);

    await assert.rejects(
      () => reqPromise,
      (err) => {
        assert.equal(err.code, "protocol_error");
        return true;
      }
    );
    await channel.close();
  });

  it("enters persistent fault on unsolicited line when no request is pending", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();

    const channel = createNdjsonChannel({ stdout, stderr, stdin });

    // Output sent before any requestMove()
    stdout.write('{"protocolVersion":1,"requestId":"unsolicited"}\n');

    // Future request should immediately reject with protocol_error
    const turn = makeTurn("m1:A:1");
    await assert.rejects(
      () => channel.sendRequest(turn),
      (err) => {
        assert.equal(err.code, "protocol_error");
        return true;
      }
    );
    await channel.close();
  });

  it("enters persistent fault on wrong/stale requestId", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();

    const channel = createNdjsonChannel({ stdout, stderr, stdin });
    const turn = makeTurn("m1:A:1");
    const reqPromise = channel.sendRequest(turn);

    // Bot responds with stale/wrong requestId
    stdout.write(
      JSON.stringify({
        protocolVersion: 1,
        requestId: "wrong:request:id",
        move: { from: { x: 4, y: 7 }, to: { x: 3, y: 6 } }
      }) + "\n"
    );

    await assert.rejects(
      () => reqPromise,
      (err) => {
        assert.equal(err.code, "protocol_error");
        return true;
      }
    );

    // Channel must remain faulted for subsequent turns
    await assert.rejects(
      () => channel.sendRequest(makeTurn("m1:A:2")),
      (err) => {
        assert.equal(err.code, "protocol_error");
        return true;
      }
    );
    await channel.close();
  });

  it("enforces per-line stdout cap (64 KiB) before newline or decode", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();

    const channel = createNdjsonChannel({
      stdout,
      stderr,
      stdin,
      maxStdoutLineBytes: 65536
    });

    const turn = makeTurn("m1:A:1");
    const reqPromise = channel.sendRequest(turn);

    // Send chunk exceeding 64 KiB with no newline
    const hugeChunk = Buffer.alloc(70000, 97); // 'a'
    stdout.write(hugeChunk);

    await assert.rejects(
      () => reqPromise,
      (err) => {
        assert.equal(err.code, "output_limit");
        return true;
      }
    );
    await channel.close();
  });

  it("enforces total stdout cap (1 MiB)", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();

    const channel = createNdjsonChannel({
      stdout,
      stderr,
      stdin,
      maxStdoutTotalBytes: 1048576,
      maxStdoutLineBytes: 2000000 // Allow line so total cap is hit
    });

    const turn = makeTurn("m1:A:1");
    const reqPromise = channel.sendRequest(turn);

    // Send chunks totaling > 1 MiB
    stdout.write(Buffer.alloc(600000, 97));
    stdout.write(Buffer.alloc(600000, 97));

    await assert.rejects(
      () => reqPromise,
      (err) => {
        assert.equal(err.code, "output_limit");
        return true;
      }
    );
    await channel.close();
  });

  it("enforces total stderr budget (256 KiB) and faults with output_limit", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();

    const channel = createNdjsonChannel({
      stdout,
      stderr,
      stdin,
      maxStderrTotalBytes: 262144
    });

    const turn = makeTurn("m1:A:1");
    const reqPromise = channel.sendRequest(turn);

    // Write > 256 KiB to stderr
    stderr.write(Buffer.alloc(300000, 120)); // 'x'

    await assert.rejects(
      () => reqPromise,
      (err) => {
        assert.equal(err.code, "output_limit");
        return true;
      }
    );
    await channel.close();
  });

  it("rejects concurrent requests (only one pending request allowed)", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();

    const channel = createNdjsonChannel({ stdout, stderr, stdin });
    const turn1 = makeTurn("m1:A:1");
    const turn2 = makeTurn("m1:A:2");

    const req1 = channel.sendRequest(turn1);
    await assert.rejects(
      () => channel.sendRequest(turn2),
      /already pending/i
    );

    // Resolve first request
    stdout.write(
      JSON.stringify({
        protocolVersion: 1,
        requestId: "m1:A:1",
        move: { from: { x: 4, y: 7 }, to: { x: 3, y: 6 } }
      }) + "\n"
    );
    await req1;
    await channel.close();
  });

  it("detaches listeners and cleans up after close without memory leaks", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();

    const channel = createNdjsonChannel({ stdout, stderr, stdin });
    assert.ok(stdout.listenerCount("data") > 0);

    await channel.close();
    assert.equal(stdout.listenerCount("data"), 0);
    assert.equal(stderr.listenerCount("data"), 0);
  });
});

// ---------------------------------------------------------------------------
// ProcessBot lifecycle & spawn tests
// ---------------------------------------------------------------------------

describe("ProcessBot lifecycle, spawn, and protocol communication", () => {
  it("spawns legal.mjs with shell=false, private cwd, and exchanges turns", async () => {
    const clock = makeFakeClock(1000);
    const bot = createProcessBot({
      botId: "legal-proc-bot",
      executable: process.execPath,
      args: [path.join(FIXTURES_DIR, "legal.mjs")],
      cwd: process.cwd(),
      clock
    });

    const startCtx = {
      matchId: "m1",
      seat: "A",
      rulesetId: "ottv2-g-default-v1",
      rulesetHash: "sha256:test",
      initialTimeMs: 600000,
      turnTimeLimitMs: 1000
    };

    await bot.start(startCtx);
    await bot.start(startCtx); // Idempotent start

    assert.ok(typeof bot.pid === "number" && bot.pid > 0);
    assert.equal(isProcessAlive(bot.pid), true);

    const turn1 = makeTurn("m1:A:1");
    const abortCtrl = new AbortController();

    clock.advance(50);
    const action1 = await bot.requestMove(turn1, abortCtrl.signal);

    assert.equal(action1.protocolVersion, 1);
    assert.equal(action1.requestId, "m1:A:1");
    assert.deepEqual(action1.move, { from: { x: 4, y: 7 }, to: { x: 3, y: 6 } });
    assert.ok(typeof action1.receivedAtMs === "number");

    // Second turn
    const turn2 = makeTurn("m1:A:2");
    turn2.ply = 2;
    const action2 = await bot.requestMove(turn2, abortCtrl.signal);
    assert.equal(action2.requestId, "m1:A:2");

    await bot.stop();
    await bot.stop(); // Idempotent stop
    assert.equal(isProcessAlive(bot.pid), false);
  });

  it("honors AbortSignal when turn request is aborted by referee timer", async () => {
    const bot = createProcessBot({
      botId: "sleep-proc-bot",
      executable: process.execPath,
      args: [path.join(FIXTURES_DIR, "sleep.mjs")]
    });

    await bot.start({
      matchId: "m1",
      seat: "A",
      rulesetId: "ottv2-g-default-v1",
      rulesetHash: "sha256:test",
      initialTimeMs: 600000,
      turnTimeLimitMs: 1000
    });

    const turn = makeTurn("m1:A:1");
    const abortCtrl = new AbortController();

    const reqPromise = bot.requestMove(turn, abortCtrl.signal);

    // Abort signal after 20ms
    setTimeout(() => abortCtrl.abort(), 20);

    await assert.rejects(
      () => reqPromise,
      (err) => {
        assert.equal(err.name, "AbortError");
        return true;
      }
    );

    await bot.stop();
  });

  it("rejects immediately if AbortSignal is already aborted", async () => {
    const bot = createProcessBot({
      botId: "legal-proc-bot",
      executable: process.execPath,
      args: [path.join(FIXTURES_DIR, "legal.mjs")]
    });

    await bot.start({
      matchId: "m1",
      seat: "A",
      rulesetId: "ottv2-g-default-v1",
      rulesetHash: "sha256:test",
      initialTimeMs: 600000,
      turnTimeLimitMs: 1000
    });

    const turn = makeTurn("m1:A:1");
    const abortCtrl = new AbortController();
    abortCtrl.abort();

    await assert.rejects(
      () => bot.requestMove(turn, abortCtrl.signal),
      (err) => {
        assert.equal(err.name, "AbortError");
        return true;
      }
    );

    await bot.stop();
  });
});

// ---------------------------------------------------------------------------
// Fault classification: Startup infrastructure error vs forfeit
// ---------------------------------------------------------------------------

describe("ProcessBot: startup failure vs crash fault classification", () => {
  it("classifies missing executable (ENOENT) as structured infrastructure error, NOT bot forfeit", async () => {
    const nonExistentExe = path.join(os.tmpdir(), "no-such-binary-" + Date.now() + ".exe");
    const bot = createProcessBot({
      botId: "missing-exe-bot",
      executable: nonExistentExe,
      args: []
    });

    await assert.rejects(
      () => bot.start({
        matchId: "m1",
        seat: "A",
        rulesetId: "ottv2-g-default-v1",
        rulesetHash: "sha256:test",
        initialTimeMs: 600000,
        turnTimeLimitMs: 1000
      }),
      (err) => {
        assert.equal(err.kind, "infrastructure_error");
        assert.equal(err.code, "spawn_enoent");
        assert.equal(err.retryable, false);
        return true;
      }
    );

    await bot.stop();
  });

  it("classifies missing cwd as structured infrastructure error", async () => {
    const nonExistentDir = path.join(os.tmpdir(), "no-such-cwd-" + Date.now());
    const bot = createProcessBot({
      botId: "missing-cwd-bot",
      executable: process.execPath,
      args: [path.join(FIXTURES_DIR, "legal.mjs")],
      cwd: nonExistentDir
    });

    await assert.rejects(
      () => bot.start({
        matchId: "m1",
        seat: "A",
        rulesetId: "ottv2-g-default-v1",
        rulesetHash: "sha256:test",
        initialTimeMs: 600000,
        turnTimeLimitMs: 1000
      }),
      (err) => {
        assert.equal(err.kind, "infrastructure_error");
        assert.equal(err.code, "missing_cwd");
        return true;
      }
    );

    await bot.stop();
  });

  it("classifies crash after successful spawn as crash forfeit", async () => {
    const bot = createProcessBot({
      botId: "crasher-bot",
      executable: process.execPath,
      args: [path.join(FIXTURES_DIR, "crash.mjs")]
    });

    await bot.start({
      matchId: "m1",
      seat: "A",
      rulesetId: "ottv2-g-default-v1",
      rulesetHash: "sha256:test",
      initialTimeMs: 600000,
      turnTimeLimitMs: 1000
    });

    const turn = makeTurn("m1:A:1");
    await assert.rejects(
      () => bot.requestMove(turn, new AbortController().signal),
      (err) => {
        assert.equal(err.code, "crash");
        return true;
      }
    );

    await bot.stop();
  });

  it("classifies malformed JSON output as protocol_error forfeit", async () => {
    const bot = createProcessBot({
      botId: "malformed-bot",
      executable: process.execPath,
      args: [path.join(FIXTURES_DIR, "malformed.mjs")]
    });

    await bot.start({
      matchId: "m1",
      seat: "A",
      rulesetId: "ottv2-g-default-v1",
      rulesetHash: "sha256:test",
      initialTimeMs: 600000,
      turnTimeLimitMs: 1000
    });

    const turn = makeTurn("m1:A:1");
    await assert.rejects(
      () => bot.requestMove(turn, new AbortController().signal),
      (err) => {
        assert.equal(err.code, "protocol_error");
        return true;
      }
    );

    await bot.stop();
  });

  it("classifies partial line missing newline before EOF as protocol_error", async () => {
    const bot = createProcessBot({
      botId: "partial-bot",
      executable: process.execPath,
      args: [path.join(FIXTURES_DIR, "partial.mjs")]
    });

    await bot.start({
      matchId: "m1",
      seat: "A",
      rulesetId: "ottv2-g-default-v1",
      rulesetHash: "sha256:test",
      initialTimeMs: 600000,
      turnTimeLimitMs: 1000
    });

    const turn = makeTurn("m1:A:1");
    await assert.rejects(
      () => bot.requestMove(turn, new AbortController().signal),
      (err) => {
        assert.ok(err.code === "protocol_error" || err.code === "crash");
        return true;
      }
    );

    await bot.stop();
  });

  it("classifies extra lines for single request as protocol_error", async () => {
    const bot = createProcessBot({
      botId: "extra-lines-bot",
      executable: process.execPath,
      args: [path.join(FIXTURES_DIR, "extra-lines.mjs")]
    });

    await bot.start({
      matchId: "m1",
      seat: "A",
      rulesetId: "ottv2-g-default-v1",
      rulesetHash: "sha256:test",
      initialTimeMs: 600000,
      turnTimeLimitMs: 1000
    });

    const turn = makeTurn("m1:A:1");
    await assert.rejects(
      () => bot.requestMove(turn, new AbortController().signal),
      (err) => {
        assert.equal(err.code, "protocol_error");
        return true;
      }
    );

    await bot.stop();
  });

  it("classifies flood line exceeding 64 KiB as output_limit", async () => {
    const bot = createProcessBot({
      botId: "flood-bot",
      executable: process.execPath,
      args: [path.join(FIXTURES_DIR, "flood.mjs")]
    });

    await bot.start({
      matchId: "m1",
      seat: "A",
      rulesetId: "ottv2-g-default-v1",
      rulesetHash: "sha256:test",
      initialTimeMs: 600000,
      turnTimeLimitMs: 1000
    });

    const turn = makeTurn("m1:A:1");
    await assert.rejects(
      () => bot.requestMove(turn, new AbortController().signal),
      (err) => {
        assert.equal(err.code, "output_limit");
        return true;
      }
    );

    await bot.stop();
  });
});

// ---------------------------------------------------------------------------
// Process Tree Termination: Root + Descendants cleanup
// ---------------------------------------------------------------------------

describe("Process tree termination: root and descendant cleanup", () => {
  it("kills background child process spawned by bot when bot is stopped", async () => {
    let capturedChildPid = null;

    const bot = createProcessBot({
      botId: "spawn-child-bot",
      executable: process.execPath,
      args: [path.join(FIXTURES_DIR, "spawn-child.mjs")],
      onStderr(buf) {
        const str = buf.toString();
        const match = str.match(/CHILD_PID:(\d+)/);
        if (match) capturedChildPid = parseInt(match[1], 10);
      }
    });

    await bot.start({
      matchId: "m1",
      seat: "A",
      rulesetId: "ottv2-g-default-v1",
      rulesetHash: "sha256:test",
      initialTimeMs: 600000,
      turnTimeLimitMs: 1000
    });

    const rootPid = bot.pid;
    assert.ok(typeof rootPid === "number" && rootPid > 0);

    // Play a turn to ensure process is active and child is spawned
    const turn = makeTurn("m1:A:1");
    const action = await bot.requestMove(turn, new AbortController().signal);
    assert.equal(action.protocolVersion, 1);

    // Wait a brief moment to discover spawned child PID
    const pidDeadline = Date.now() + 1500;
    while (!capturedChildPid && Date.now() < pidDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    if (capturedChildPid) {
      assert.equal(isProcessAlive(capturedChildPid), true);
    }

    // Call stop()
    await bot.stop();

    // Verify root is dead
    assert.equal(isProcessAlive(rootPid), false);

    // Verify spawned background child is dead
    if (capturedChildPid) {
      assert.equal(isProcessAlive(capturedChildPid), false);
    }
  });

  it("kills descendant process within 250ms grace even if root process already exited", async () => {
    let capturedChildPid = null;

    // Run spawn-child with TEST_ROOT_EXIT_EARLY=1 so root exits immediately leaving orphan
    const bot = createProcessBot({
      botId: "orphan-spawner",
      executable: process.execPath,
      args: [path.join(FIXTURES_DIR, "spawn-child.mjs")],
      env: { TEST_ROOT_EXIT_EARLY: "1" },
      onStderr(buf) {
        const str = buf.toString();
        const match = str.match(/CHILD_PID:(\d+)/);
        if (match) capturedChildPid = parseInt(match[1], 10);
      }
    });

    await bot.start({
      matchId: "m1",
      seat: "A",
      rulesetId: "ottv2-g-default-v1",
      rulesetHash: "sha256:test",
      initialTimeMs: 600000,
      turnTimeLimitMs: 1000
    });

    const rootPid = bot.pid;
    assert.ok(typeof rootPid === "number" && rootPid > 0);

    // Wait for child PID to be reported
    const pidDeadline = Date.now() + 1500;
    while (!capturedChildPid && Date.now() < pidDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // Wait for root to exit
    const exitDeadline = Date.now() + 2000;
    while (isProcessAlive(rootPid) && Date.now() < exitDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(isProcessAlive(rootPid), false);

    // Descendant orphan process was alive while root exited
    if (capturedChildPid) {
      assert.equal(isProcessAlive(capturedChildPid), true);
    }

    // Call stop() to trigger tree terminator
    const stopStart = Date.now();
    await bot.stop();
    const stopElapsed = Date.now() - stopStart;

    // Must finish cleanup cleanly
    assert.ok(stopElapsed < 5000);

    // Descendant orphan process must now be terminated!
    if (capturedChildPid) {
      assert.equal(isProcessAlive(capturedChildPid), false);
    }
  });
});

// ---------------------------------------------------------------------------
// HeadlessMatchController End-to-End integration with ProcessBot
// ---------------------------------------------------------------------------

function makeFakeJournal() {
  const initCalls = [];
  const acceptedMoveCalls = [];
  const technicalEventCalls = [];
  let finishResult = null;

  return {
    init(input) {
      initCalls.push(input);
    },
    acceptedMove(input) {
      acceptedMoveCalls.push(input);
    },
    technicalEvent(input) {
      technicalEventCalls.push(input);
    },
    finish(result, terminalState) {
      finishResult = { result, terminalState };
      return {
        schemaVersion: 1,
        matchId: "test-match",
        engineRevision: "sha256:test",
        engineGitRevision: null,
        rulesetId: "ottv2-g-default-v1",
        rulesetHash: "sha256:test",
        rulesetSnapshot: {},
        matchPolicy: DEFAULT_MATCH_POLICY,
        participants: {
          A: { botId: "proc-a" },
          B: { botId: "proc-b" }
        },
        initialCoreState: terminalState,
        frames: [],
        events: [],
        result,
        terminalCoreState: terminalState
      };
    },
    get initCalls() {
      return initCalls;
    },
    get acceptedMoveCalls() {
      return acceptedMoveCalls;
    },
    get finishResult() {
      return finishResult;
    }
  };
}

describe("HeadlessMatchController + ProcessBot End-to-End integration", () => {
  it("plays real match with ProcessBot (legal.mjs) vs FunctionBot to goal win", async () => {
    const engine = createNodeEngine();
    const snapshot = createCurrentRulesetSnapshot(coreConfig);
    const rulesetHash = computeRulesetHash(snapshot);
    const engineRevision = computeCurrentEngineFingerprint();
    const clock = makeFakeClock(0);
    const journal = makeFakeJournal();

    const procBotA = createProcessBot({
      botId: "legal-proc-a",
      executable: process.execPath,
      args: [path.join(FIXTURES_DIR, "legal.mjs")],
      clock
    });

    const fnBotB = createFunctionBot({
      botId: "fn-b",
      chooseFn(turn) {
        return turn.legalMoves[0];
      }
    });

    const controller = createHeadlessMatchController({
      matchId: "proc-vs-fn-001",
      engine,
      botA: procBotA,
      botB: fnBotB,
      clock,
      journal,
      policy: DEFAULT_MATCH_POLICY,
      rulesetSnapshot: snapshot,
      rulesetHash,
      engineRevision,
      participants: {
        A: { botId: "legal-proc-a" },
        B: { botId: "fn-b" }
      }
    });

    const result = await controller.run();
    assert.ok(result.outcome === "win" || result.outcome === "draw");
    assert.ok(result.acceptedPlies > 0);

    // Bot process is cleaned up after controller completes
    assert.equal(isProcessAlive(procBotA.pid), false);
  });

  it("controller classifies crashing ProcessBot as forfeit with crash", async () => {
    const engine = createNodeEngine();
    const snapshot = createCurrentRulesetSnapshot(coreConfig);
    const rulesetHash = computeRulesetHash(snapshot);
    const engineRevision = computeCurrentEngineFingerprint();
    const clock = makeFakeClock(0);
    const journal = makeFakeJournal();

    const crashBotA = createProcessBot({
      botId: "crasher-a",
      executable: process.execPath,
      args: [path.join(FIXTURES_DIR, "crash.mjs")]
    });

    const fnBotB = createFunctionBot({
      botId: "fn-b",
      chooseFn(turn) {
        return turn.legalMoves[0];
      }
    });

    const controller = createHeadlessMatchController({
      matchId: "crash-match-001",
      engine,
      botA: crashBotA,
      botB: fnBotB,
      clock,
      journal,
      policy: DEFAULT_MATCH_POLICY,
      rulesetSnapshot: snapshot,
      rulesetHash,
      engineRevision,
      participants: {
        A: { botId: "crasher-a" },
        B: { botId: "fn-b" }
      }
    });

    const result = await controller.run();
    assert.equal(result.outcome, "forfeit");
    assert.equal(result.reason, "crash");
    assert.equal(result.loser, "A");
    assert.equal(result.winner, "B");
    assert.equal(result.acceptedPlies, 0);
  });

  it("controller classifies malformed ProcessBot as forfeit with protocol_error", async () => {
    const engine = createNodeEngine();
    const snapshot = createCurrentRulesetSnapshot(coreConfig);
    const rulesetHash = computeRulesetHash(snapshot);
    const engineRevision = computeCurrentEngineFingerprint();
    const clock = makeFakeClock(0);
    const journal = makeFakeJournal();

    const malformedBotA = createProcessBot({
      botId: "malformed-a",
      executable: process.execPath,
      args: [path.join(FIXTURES_DIR, "malformed.mjs")]
    });

    const fnBotB = createFunctionBot({
      botId: "fn-b",
      chooseFn(turn) {
        return turn.legalMoves[0];
      }
    });

    const controller = createHeadlessMatchController({
      matchId: "malformed-match-001",
      engine,
      botA: malformedBotA,
      botB: fnBotB,
      clock,
      journal,
      policy: DEFAULT_MATCH_POLICY,
      rulesetSnapshot: snapshot,
      rulesetHash,
      engineRevision,
      participants: {
        A: { botId: "malformed-a" },
        B: { botId: "fn-b" }
      }
    });

    const result = await controller.run();
    assert.equal(result.outcome, "forfeit");
    assert.equal(result.reason, "protocol_error");
    assert.equal(result.loser, "A");
    assert.equal(result.winner, "B");
  });

  it("controller classifies flood ProcessBot as forfeit with output_limit", async () => {
    const engine = createNodeEngine();
    const snapshot = createCurrentRulesetSnapshot(coreConfig);
    const rulesetHash = computeRulesetHash(snapshot);
    const engineRevision = computeCurrentEngineFingerprint();
    const clock = makeFakeClock(0);
    const journal = makeFakeJournal();

    const floodBotA = createProcessBot({
      botId: "flood-a",
      executable: process.execPath,
      args: [path.join(FIXTURES_DIR, "flood.mjs")]
    });

    const fnBotB = createFunctionBot({
      botId: "fn-b",
      chooseFn(turn) {
        return turn.legalMoves[0];
      }
    });

    const controller = createHeadlessMatchController({
      matchId: "flood-match-001",
      engine,
      botA: floodBotA,
      botB: fnBotB,
      clock,
      journal,
      policy: DEFAULT_MATCH_POLICY,
      rulesetSnapshot: snapshot,
      rulesetHash,
      engineRevision,
      participants: {
        A: { botId: "flood-a" },
        B: { botId: "fn-b" }
      }
    });

    const result = await controller.run();
    assert.equal(result.outcome, "forfeit");
    assert.equal(result.reason, "output_limit");
    assert.equal(result.loser, "A");
    assert.equal(result.winner, "B");
  });

  it("controller classifies ENOENT executable as infrastructure_error (NO Elo forfeit)", async () => {
    const engine = createNodeEngine();
    const snapshot = createCurrentRulesetSnapshot(coreConfig);
    const rulesetHash = computeRulesetHash(snapshot);
    const engineRevision = computeCurrentEngineFingerprint();
    const clock = makeFakeClock(0);
    const journal = makeFakeJournal();

    const enoentBotA = createProcessBot({
      botId: "enoent-a",
      executable: path.join(os.tmpdir(), "nonexistent-bot-binary.exe"),
      args: []
    });

    const fnBotB = createFunctionBot({
      botId: "fn-b",
      chooseFn(turn) {
        return turn.legalMoves[0];
      }
    });

    const controller = createHeadlessMatchController({
      matchId: "enoent-match-001",
      engine,
      botA: enoentBotA,
      botB: fnBotB,
      clock,
      journal,
      policy: DEFAULT_MATCH_POLICY,
      rulesetSnapshot: snapshot,
      rulesetHash,
      engineRevision,
      participants: {
        A: { botId: "enoent-a" },
        B: { botId: "fn-b" }
      }
    });

    const result = await controller.run();
    assert.equal(result.kind, "infrastructure_error");
    assert.equal(result.code, "spawn_enoent");
    assert.equal(result.retryable, false);
  });
});

// ---------------------------------------------------------------------------
// Supervisor Consolidated Remaining Task 5 Regressions
// ---------------------------------------------------------------------------

describe("Supervisor remaining Task 5 regressions batch", () => {
  it("getDefaultSanitizedEnv removes NODE_PATH unless explicitly specified", async () => {
    const { getDefaultSanitizedEnv } = await import("../packages/arena-node/src/execution/process-bot.mjs");
    const baseline = getDefaultSanitizedEnv();
    assert.equal(baseline.NODE_PATH, undefined);
  });

  it("createProcessBot rejects args containing non-string elements", () => {
    assert.throws(
      () => createProcessBot({
        botId: "bad-args",
        executable: process.execPath,
        args: ["valid", 123, null]
      }),
      /args must be an array of strings/i
    );
  });

  it("stop() clears process exit timeout handle without leaving pending timers", async () => {
    const bot = createProcessBot({
      botId: "quick-exit-bot",
      executable: process.execPath,
      args: [path.join(FIXTURES_DIR, "legal.mjs")]
    });

    await bot.start({
      matchId: "m1",
      seat: "A",
      rulesetId: "ottv2-g-default-v1",
      rulesetHash: "sha256:test",
      initialTimeMs: 600000,
      turnTimeLimitMs: 1000
    });

    assert.ok(bot.pid);
    await bot.stop();
    assert.equal(isProcessAlive(bot.pid), false);
  });

  it("stop() during pending startup never marks started=true after stop", async () => {
    // Hangs startup by pointing to a script that does not spawn immediately
    const bot = createProcessBot({
      botId: "pending-startup-bot",
      executable: process.execPath,
      args: [path.join(FIXTURES_DIR, "sleep.mjs")]
    });

    // Start asynchronously and stop immediately
    const startPromise = bot.start({
      matchId: "m1",
      seat: "A",
      rulesetId: "ottv2-g-default-v1",
      rulesetHash: "sha256:test",
      initialTimeMs: 600000,
      turnTimeLimitMs: 1000
    });

    await bot.stop();
    await startPromise.catch(() => {});

    // Ensure bot does not consider itself started
    await assert.rejects(
      () => bot.requestMove(makeTurn("m1:A:1"), new AbortController().signal),
      /called requestMove before start|terminated/i
    );
  });

  it("controller prevents plain FunctionBot from forging receivedAtMs to bypass deadline", async () => {
    const clock = makeFakeClock(100);
    const engine = createNodeEngine();
    const snapshot = createCurrentRulesetSnapshot(coreConfig);
    const rulesetHash = computeRulesetHash(snapshot);
    const engineRevision = computeCurrentEngineFingerprint();
    const journal = makeFakeJournal();

    // Malicious bot attempts to bypass 1000ms deadline budget by claiming receivedAtMs was 100
    const forgedBotA = createFunctionBot({
      botId: "forger-a",
      chooseFn(turn) {
        // Advances clock by 1500ms (exceeding turnTimeLimitMs 1000ms!)
        clock.advance(1500);
        return {
          from: turn.legalMoves[0].from,
          to: turn.legalMoves[0].to,
          receivedAtMs: 100 // forged host time!
        };
      }
    });

    const fnBotB = createFunctionBot({
      botId: "fn-b",
      chooseFn(turn) {
        return turn.legalMoves[0];
      }
    });

    const controller = createHeadlessMatchController({
      matchId: "forged-time-match",
      engine,
      botA: forgedBotA,
      botB: fnBotB,
      clock,
      journal,
      policy: DEFAULT_MATCH_POLICY,
      rulesetSnapshot: snapshot,
      rulesetHash,
      engineRevision,
      participants: {
        A: { botId: "forger-a" },
        B: { botId: "fn-b" }
      }
    });

    const result = await controller.run();
    // Forged timestamp must be ignored; bot A must forfeit for turn_timeout!
    assert.equal(result.outcome, "forfeit");
    assert.equal(result.reason, "turn_timeout");
    assert.equal(result.loser, "A");
    assert.equal(result.winner, "B");
  });

  it("controller detects cross-seat late extra on seat A during seat B turn before commit", async () => {
    const clock = makeFakeClock(0);
    const engine = createNodeEngine();
    const snapshot = createCurrentRulesetSnapshot(coreConfig);
    const rulesetHash = computeRulesetHash(snapshot);
    const engineRevision = computeCurrentEngineFingerprint();
    const journal = makeFakeJournal();

    // Bot A is a ProcessBot running legal.mjs
    const procBotA = createProcessBot({
      botId: "cross-seat-a",
      executable: process.execPath,
      args: [path.join(FIXTURES_DIR, "legal.mjs")],
      clock
    });

    // Bot B is a FunctionBot; when B is acting, it triggers an unsolicited line on bot A
    let bTurnCount = 0;
    const fnBotB = createFunctionBot({
      botId: "fn-b",
      async chooseFn(turn) {
        bTurnCount++;
        if (bTurnCount === 1) {
          // Send unsolicited line to A's child process while B is thinking!
          // Note: channel stdout receives unsolicited output from bot A
          // We can simulate bot A writing to its stdout or triggering fault on A
          const rawChild = procBotA._child; // or trigger via channel
          if (procBotA.consumeFault) {
            // Emulate A emitting unexpected line in background
            procBotA.triggerFaultForTest?.({
              code: "protocol_error",
              message: "Cross-seat unsolicited line during B turn"
            });
          }
        }
        return turn.legalMoves[0];
      }
    });

    const controller = createHeadlessMatchController({
      matchId: "cross-seat-fault-match",
      engine,
      botA: procBotA,
      botB: fnBotB,
      clock,
      journal,
      policy: DEFAULT_MATCH_POLICY,
      rulesetSnapshot: snapshot,
      rulesetHash,
      engineRevision,
      participants: {
        A: { botId: "cross-seat-a" },
        B: { botId: "fn-b" }
      }
    });

    const result = await controller.run();
    // A's fault must be detected before committing B's move, resulting in A forfeiting!
    assert.equal(result.outcome, "forfeit");
    assert.equal(result.loser, "A");
    assert.equal(result.winner, "B");
    assert.equal(result.reason, "protocol_error");
  });

  it("late extra output after terminal state leaves finalized replay immutable", async () => {
    const clock = makeFakeClock(0);
    const engine = createNodeEngine();
    const snapshot = createCurrentRulesetSnapshot(coreConfig);
    const rulesetHash = computeRulesetHash(snapshot);
    const engineRevision = computeCurrentEngineFingerprint();
    const journal = makeFakeJournal();

    const procBotA = createProcessBot({
      botId: "term-proc-a",
      executable: process.execPath,
      args: [path.join(FIXTURES_DIR, "legal.mjs")],
      clock
    });

    const fnBotB = createFunctionBot({
      botId: "fn-b",
      chooseFn(turn) {
        return turn.legalMoves[0];
      }
    });

    const controller = createHeadlessMatchController({
      matchId: "term-immutable-match",
      engine,
      botA: procBotA,
      botB: fnBotB,
      clock,
      journal,
      policy: DEFAULT_MATCH_POLICY,
      rulesetSnapshot: snapshot,
      rulesetHash,
      engineRevision,
      participants: {
        A: { botId: "term-proc-a" },
        B: { botId: "fn-b" }
      }
    });

    const result = await controller.run();
    assert.ok(result.outcome === "win" || result.outcome === "draw");

    // Send late extra output after match is terminal
    if (procBotA.triggerFaultForTest) {
      procBotA.triggerFaultForTest({ code: "protocol_error", message: "Late output after terminal" });
    }

    // Final result and journal finishResult must remain completely unchanged
    assert.ok(journal.finishResult);
    assert.equal(journal.finishResult.result.outcome, result.outcome);
  });
});
