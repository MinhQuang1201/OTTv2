"use strict";

/**
 * apps/bot-cup-runner without Docker (P4): the loop keeps `slots` jobs going and refills at once, reports infrastructure
 * errors for retry, and the executor builds a replay the API accepts, checks source SHA-256, and spots a start-up timeout.
 * The container path itself is exercised on the runner machine (docs/evidence/…-bot-cup-p4.md).
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let runnerMod;
let executorMod;
let core;
let functionBot;
let artifacts;
before(async () => {
  runnerMod = await import("../apps/bot-cup-runner/src/runner.mjs");
  executorMod = await import("../apps/bot-cup-runner/src/executor.mjs");
  core = await import("../packages/bot-cup-core/src/index.mjs");
  functionBot = await import("../packages/arena/src/adapters/function-bot.mjs");
  artifacts = await import("../packages/arena-node/src/artifacts/artifact-store.mjs");
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const manualTimers = { setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {} };

describe("bot-cup runner loop", () => {
  it("keeps up to `slots` jobs running and claims again as soon as one ends", async () => {
    const queue = Array.from({ length: 6 }, (_, i) => ({ jobId: `j${i}`, attempt: 1, kind: "match", match: {} }));
    const gates = new Map(queue.map((job) => [job.jobId, deferred()]));
    const claims = [];
    const completed = [];
    const client = {
      async heartbeat() {},
      async claim(slots) {
        claims.push(slots);
        return queue.splice(0, slots);
      },
      async complete(body) {
        completed.push(body.jobId);
        return { ok: true };
      },
      async fail() {}
    };
    const executor = { async runMatch(job) { await gates.get(job.jobId).promise; return { replay: { result: {} }, stderr: {} }; } };
    const runner = runnerMod.createRunner({ client, executor, slots: 4, timers: manualTimers });
    await runner.start();
    assert.deepEqual(claims, [4]);
    assert.equal(runner.active, 4);
    gates.get("j1").resolve();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(completed, ["j1"]);
    assert.deepEqual(claims, [4, 1], "the freed slot is refilled right away");
    // Stopping finishes the jobs in hand and claims nothing more.
    const stopped = runner.stop();
    for (const gate of gates.values()) gate.resolve();
    await stopped;
    assert.equal(completed.length, 5);
    assert.deepEqual(queue.map((job) => job.jobId), ["j5"]);
  });

  it("reports infrastructure errors for retry but not a refused report", async () => {
    const failed = [];
    const jobs = [
      { jobId: "infra", attempt: 2, kind: "match", match: {} },
      { jobId: "refused", attempt: 1, kind: "match", match: {} }
    ];
    const client = {
      async heartbeat() {},
      async claim() { return jobs.splice(0); },
      async complete(body) {
        const error = new Error("422 replay_rejected");
        error.status = 422;
        if (body.jobId === "refused") throw error;
        return { ok: true };
      },
      async fail(body) { failed.push([body.jobId, body.attempt, body.detail]); }
    };
    const executor = {
      async runMatch(job) {
        if (job.jobId === "infra") throw new executorMod.InfrastructureError("docker: daemon not running");
        return { replay: { result: {} }, stderr: {} };
      }
    };
    const runner = runnerMod.createRunner({ client, executor, slots: 4, timers: manualTimers });
    await runner.start();
    await runner.stop();
    assert.deepEqual(failed, [["infra", 2, "docker: daemon not running"]]);
  });
});

describe("bot-cup runner executor", () => {
  function setup({ source = "x", sourceBytes, probeSets, chooseTeam } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-cup-exec-"));
    const bytes = Buffer.from(source);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const created = [];
    // In-process stand-ins for containers: the team's "bot" plays the first legal move, house bots the last one.
    const createBot = (options) => {
      created.push({ profileId: options.profileId, artifactDigest: options.artifactDigest, image: options.image });
      const house = options.artifactDigest !== `sha256:${sha256}`;
      return functionBot.createFunctionBot({ botId: options.botId, chooseFn: (turn) => (house ? turn.legalMoves.at(-1) : (chooseTeam ?? ((t) => t.legalMoves[0]))(turn)) });
    };
    const executor = executorMod.createExecutor({
      artifactStore: artifacts.createArtifactStore({ storageDir: dir }),
      image: "img",
      expectedImageId: "sha256:img",
      probe: () => ({ available: true, imageId: "sha256:img" }),
      fetchSource: async () => sourceBytes ?? bytes,
      houseSources: { easy: "// house easy\n" },
      probeSets,
      createBot,
      runCheckProcess: async (request) => (Buffer.from(request.sourceBase64, "base64").toString().includes("(:")
        ? { status: "FAILED", error: "compile_failure", logs: "  File \"/bot/source.py\", line 1\nSyntaxError: invalid syntax" }
        : { status: "READY", logs: "ok" })
    });
    return { executor, sha256, created, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }

  it("plays a game the API's replay check accepts", async () => {
    const t = setup();
    try {
      const job = { jobId: "j", attempt: 1, kind: "match", match: { id: "m-1", mapId: "flanks", policy: core.BOT_CUP_POLICY, seats: { A: { submission: { sha256: t.sha256, language: "python" } }, B: { house: "easy" } } } };
      const { replay, stderr } = await t.executor.runMatch(job);
      assert.deepEqual(stderr, { A: "", B: "" });
      assert.equal(core.verifyReplay(replay, { mapId: "flanks" }).ok, true);
      assert.deepEqual(t.created.map((bot) => bot.profileId), ["python", "node"]);
      assert.equal(t.created[0].artifactDigest, `sha256:${t.sha256}`);
    } finally {
      t.cleanup();
    }
  });

  it("answers a secret probe set with one bot per colour; a crash or a hang costs one position", async () => {
    const positions = core.generateProbePositions({ count: 24, random: core.seededRandom(5) });
    const set = "c".repeat(64);
    let calls = 0;
    const t = setup({
      probeSets: new Map([[set, positions]]),
      chooseTeam: async (turn) => {
        calls += 1;
        if (calls === 3) throw new Error("bot crashed");
        if (calls === 6) await new Promise((resolve) => setTimeout(resolve, 1500));
        return turn.legalMoves[0];
      }
    });
    try {
      const policy = { ...core.BOT_CUP_POLICY, turnTimeLimitMs: 200, firstMoveGraceMs: 400 };
      const job = { jobId: "probe-job-1", attempt: 1, kind: "probe", probe: { set, policy, submission: { sha256: t.sha256, language: "node" } } };
      const result = await t.executor.runProbe(job);
      assert.equal(result.moves.length, 24);
      assert.equal(result.answered, 22, "the crashed and the timed-out position stay empty");
      assert.equal(result.restarts, 2);
      const expected = positions.map((position) => core.moveKey(core.legalMovesOf(position)[0]));
      result.moves.forEach((move, index) => assert.ok(move === null || move === expected[index]));
      // Bots started: one per colour, plus one restart after each failure.
      assert.equal(t.created.length, 4);
      const house = await t.executor.runProbe({ ...job, jobId: "probe-job-2", probe: { set, policy, house: "easy" } });
      assert.deepEqual(house.moves, positions.map((position) => core.moveKey(core.legalMovesOf(position).at(-1))));
      await assert.rejects(t.executor.runProbe({ ...job, probe: { ...job.probe, set: "d".repeat(64) } }), /not on this runner/);
    } finally {
      t.cleanup();
    }
  });

  it("refuses downloaded source whose SHA-256 differs from the job's", async () => {
    const t = setup({ sourceBytes: Buffer.from("tampered") });
    try {
      const job = { match: { id: "m-2", mapId: "classic", policy: core.BOT_CUP_POLICY, seats: { A: { submission: { sha256: t.sha256, language: "node" } }, B: { house: "easy" } } } };
      await assert.rejects(t.executor.runMatch(job), executorMod.InfrastructureError);
      await assert.rejects(t.executor.runCheck({ submission: { sha256: t.sha256, language: "node" } }), /SHA-256/);
    } finally {
      t.cleanup();
    }
  });

  it("turns a syntax error into a failed check with the container's log", async () => {
    const broken = setup({ source: "def f(:\n" });
    const fine = setup({ source: "print(1)\n" });
    try {
      const bad = await broken.executor.runCheck({ submission: { sha256: broken.sha256, language: "python" } });
      assert.equal(bad.ok, false);
      assert.match(bad.log, /^Lỗi cú pháp:\n.*\/bot\/source\.py/s);
      assert.deepEqual(await fine.executor.runCheck({ submission: { sha256: fine.sha256, language: "python" } }), { ok: true, log: "Kiểm tra cú pháp: đạt." });
    } finally {
      broken.cleanup();
      fine.cleanup();
    }
  });

  it("spaces game launches so containers do not all start at once", async () => {
    let clock = 1000;
    const waits = [];
    const launch = executorMod.createLaunchGate(1000, { now: () => clock, sleep: async (ms) => { waits.push(ms); } });
    await Promise.all([launch(), launch(), launch()]);
    assert.deepEqual(waits, [1000, 2000]);
    clock = 10_000;
    waits.length = 0;
    await launch();
    assert.deepEqual(waits, [], "an idle runner launches at once");
  });

  it("shows teams only the SyntaxError from py_compile", () => {
    const logs = "Traceback (most recent call last):\n  File \"<string>\"...\npy_compile.PyCompileError:   File \"/bot/source.py\", line 1\n    def f(:\nSyntaxError: invalid syntax";
    assert.equal(executorMod.compilerMessage(logs), "File \"/bot/source.py\", line 1\n    def f(:\nSyntaxError: invalid syntax");
    assert.equal(executorMod.compilerMessage("/bot/source.mjs:1\nSyntaxError: Unexpected token"), "/bot/source.mjs:1\nSyntaxError: Unexpected token");
  });

  it("recognises a start-up timeout: the loser never moved", () => {
    const timeout = { outcome: "forfeit", reason: "turn_timeout", loser: "B" };
    assert.equal(executorMod.isStartupTimeout(timeout, [{ seat: "A" }]), true);
    assert.equal(executorMod.isStartupTimeout(timeout, [{ seat: "A" }, { seat: "B" }, { seat: "A" }]), false);
    assert.equal(executorMod.isStartupTimeout({ ...timeout, reason: "crash" }, [{ seat: "A" }]), false);
  });
});
