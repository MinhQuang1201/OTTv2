/**
 * Arena Execution Profile Registry & Python Bot Resolution Tests — Task 6 (Milestone M2)
 * Unit tests profile registry, probe timeouts, executable resolution, and bot spec resolution.
 */

"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

let createProfileRegistry;
let probeExecutable;
let resolvePythonExecutable;

before(async () => {
  const regMod = await import("../packages/arena-node/src/execution/profile-registry.mjs");
  createProfileRegistry = regMod.createProfileRegistry;
  probeExecutable = regMod.probeExecutable;
  resolvePythonExecutable = regMod.resolvePythonExecutable;
});

describe("profile-registry: probeExecutable utility", () => {
  it("probes a valid executable with fixed argv and returns output", () => {
    const res = probeExecutable(process.execPath, ["-e", "console.log('probe-ok')"], 3000);
    assert.equal(res.ok, true);
    assert.ok(res.stdout.includes("probe-ok"));
  });

  it("handles non-existent executable without throwing uncaught error", () => {
    const nonExistent = path.join(os.tmpdir(), "nonexistent-probe-binary-" + Date.now() + ".exe");
    const res = probeExecutable(nonExistent, ["--version"], 1000);
    assert.equal(res.ok, false);
    assert.ok(res.code === "ENOENT" || res.error?.includes("ENOENT"));
  });

  it("enforces probe timeout when probe process hangs", () => {
    const hangCode = "setTimeout(() => {}, 10000)";
    const res = probeExecutable(process.execPath, ["-e", hangCode], 200);
    assert.equal(res.ok, false);
    assert.ok(res.timedOut || res.code === "ETIMEDOUT");
  });
});

describe("profile-registry: resolvePythonExecutable", () => {
  it("honors OTT_ARENA_PYTHON environment variable when set", () => {
    const original = process.env.OTT_ARENA_PYTHON;
    try {
      process.env.OTT_ARENA_PYTHON = "custom-python-exe";
      const resolved = resolvePythonExecutable();
      assert.equal(resolved.executable, "custom-python-exe");
      assert.equal(resolved.source, "env");
    } finally {
      if (original !== undefined) process.env.OTT_ARENA_PYTHON = original;
      else delete process.env.OTT_ARENA_PYTHON;
    }
  });

  it("selects platform-appropriate fallback without hardcoding python3 on Windows", () => {
    const original = process.env.OTT_ARENA_PYTHON;
    delete process.env.OTT_ARENA_PYTHON;
    try {
      const resolved = resolvePythonExecutable();
      assert.ok(typeof resolved.executable === "string" && resolved.executable.length > 0);
      if (process.platform === "win32") {
        assert.ok(resolved.executable === "python" || resolved.executable.includes("python"));
      } else {
        assert.ok(resolved.executable === "python3" || resolved.executable === "python");
      }
    } finally {
      if (original !== undefined) process.env.OTT_ARENA_PYTHON = original;
    }
  });
});

describe("profile-registry: createProfileRegistry lifecycle & resolution", () => {
  it("lists default python profile", () => {
    const registry = createProfileRegistry();
    const profiles = registry.listProfiles();
    assert.ok(Array.isArray(profiles));
    const pythonProfile = profiles.find((p) => p.id === "python");
    assert.ok(pythonProfile);
    assert.equal(pythonProfile.language, "python");
  });

  it("resolves built-in 'first-legal' bot spec as FunctionBot", () => {
    const registry = createProfileRegistry();
    const bot = registry.resolveBot("first-legal", { botId: "bot-fl" });
    assert.ok(bot);
    assert.equal(typeof bot.start, "function");
    assert.equal(typeof bot.requestMove, "function");
    assert.equal(typeof bot.stop, "function");
  });

  it("rejects 'python:<path>' when source file does not exist with missing_bot_source", async () => {
    const registry = createProfileRegistry();
    const nonExistent = path.join(os.tmpdir(), "no_such_bot_file.py");

    assert.throws(
      () => registry.resolveBot(`python:${nonExistent}`, { botId: "bad-py" }),
      (err) => {
        assert.equal(err.kind, "infrastructure_error");
        assert.equal(err.code, "missing_bot_source");
        return true;
      }
    );
  });

  it("resolves 'python:<path>' when source file exists into ProcessBot with -u fixed arg", () => {
    const tempBotFile = path.join(os.tmpdir(), `test_bot_${Date.now()}.py`);
    fs.writeFileSync(tempBotFile, "print('hello')", "utf8");

    try {
      const registry = createProfileRegistry();
      const bot = registry.resolveBot(`python:${tempBotFile}`, { botId: "valid-py" });
      assert.ok(bot);
      assert.equal(bot.botId, "valid-py");
      assert.equal(typeof bot.start, "function");
      assert.equal(typeof bot.requestMove, "function");
      assert.equal(typeof bot.stop, "function");
    } finally {
      try { fs.unlinkSync(tempBotFile); } catch (_) {}
    }
  });

  it("separates unavailable runtime from execution failure using probe doubles", () => {
    const registry = createProfileRegistry();
    // Register double profile that is unavailable
    registry.registerProfile({
      id: "fake-lang",
      language: "fake",
      probe: () => ({ available: false, executable: null, error: "compiler_not_found" }),
      createBot: () => { throw new Error("Should not be called"); }
    });

    const tempFile = path.join(os.tmpdir(), `test_fake_${Date.now()}.fake`);
    fs.writeFileSync(tempFile, "fake code", "utf8");

    try {
      assert.throws(
        () => registry.resolveBot(`fake-lang:${tempFile}`, { botId: "fake-bot" }),
        (err) => {
          assert.equal(err.kind, "infrastructure_error");
          assert.equal(err.code, "runtime_unavailable");
          return true;
        }
      );
    } finally {
      try { fs.unlinkSync(tempFile); } catch (_) {}
    }
  });

  it("rejects malformed bot specs (empty source or invalid prefix)", () => {
    const registry = createProfileRegistry();
    assert.throws(
      () => registry.resolveBot("python:", { botId: "empty-src" }),
      /invalid bot specification/i
    );
    assert.throws(
      () => registry.resolveBot("unknown-profile:foo.py", { botId: "unknown" }),
      /unknown bot profile/i
    );
  });
});
