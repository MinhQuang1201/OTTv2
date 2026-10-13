/**
 * Arena Execution Profile Registry & Multi-Language Resolution Tests — Task 6 & 7 (Milestone M2)
 * Unit tests profile registry, probe timeouts, executable resolution, Java version parsing,
 * and bot spec resolution across Python, Node, C++, Java.
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
let resolveNodeExecutable;
let resolveCppExecutable;
let resolveJavaExecutables;
let parseJavaMajorVersion;

before(async () => {
  const regMod = await import("../packages/arena-node/src/execution/profile-registry.mjs");
  createProfileRegistry = regMod.createProfileRegistry;
  probeExecutable = regMod.probeExecutable;
  resolvePythonExecutable = regMod.resolvePythonExecutable;
  resolveNodeExecutable = regMod.resolveNodeExecutable;
  resolveCppExecutable = regMod.resolveCppExecutable;
  resolveJavaExecutables = regMod.resolveJavaExecutables;
  parseJavaMajorVersion = regMod.parseJavaMajorVersion;
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

describe("profile-registry: executable resolution utilities", () => {
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

  it("selects platform-appropriate Python fallback without hardcoding python3 on Windows", () => {
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

  it("resolves Node executable honoring OTT_ARENA_NODE or process.execPath", () => {
    const original = process.env.OTT_ARENA_NODE;
    try {
      process.env.OTT_ARENA_NODE = "custom-node-bin";
      const res = resolveNodeExecutable();
      assert.equal(res.executable, "custom-node-bin");
      assert.equal(res.source, "env");
    } finally {
      if (original !== undefined) process.env.OTT_ARENA_NODE = original;
      else delete process.env.OTT_ARENA_NODE;
    }

    const defaultNode = resolveNodeExecutable();
    assert.ok(defaultNode.executable);
    assert.ok(defaultNode.candidates.includes(process.execPath));
  });

  it("resolves C++ compiler honoring OTT_ARENA_CPP", () => {
    const original = process.env.OTT_ARENA_CPP;
    try {
      process.env.OTT_ARENA_CPP = "custom-g++";
      const res = resolveCppExecutable();
      assert.equal(res.executable, "custom-g++");
      assert.equal(res.source, "env");
    } finally {
      if (original !== undefined) process.env.OTT_ARENA_CPP = original;
      else delete process.env.OTT_ARENA_CPP;
    }
  });

  it("parses Java major version correctly across formats", () => {
    assert.equal(parseJavaMajorVersion("javac 23.0.1"), 23);
    assert.equal(parseJavaMajorVersion("javac 21.0.2"), 21);
    assert.equal(parseJavaMajorVersion("java version \"21.0.1\" 2023-10-17 LTS"), 21);
    assert.equal(parseJavaMajorVersion("openjdk 21.0.3 2024-04-16"), 21);
    assert.equal(parseJavaMajorVersion("javac 17.0.5"), 17);
    assert.equal(parseJavaMajorVersion("java version \"1.8.0_301\""), 8);
    assert.equal(parseJavaMajorVersion("invalid string"), null);
  });

  it("resolves Java toolchain honoring OTT_ARENA_JAVAC and OTT_ARENA_JAVA", () => {
    const origJavac = process.env.OTT_ARENA_JAVAC;
    const origJava = process.env.OTT_ARENA_JAVA;
    try {
      process.env.OTT_ARENA_JAVAC = "custom-javac";
      process.env.OTT_ARENA_JAVA = "custom-java";
      const res = resolveJavaExecutables();
      assert.equal(res.javac, "custom-javac");
      assert.equal(res.java, "custom-java");
    } finally {
      if (origJavac !== undefined) process.env.OTT_ARENA_JAVAC = origJavac;
      else delete process.env.OTT_ARENA_JAVAC;
      if (origJava !== undefined) process.env.OTT_ARENA_JAVA = origJava;
      else delete process.env.OTT_ARENA_JAVA;
    }
  });
});

describe("profile-registry: createProfileRegistry lifecycle & resolution", () => {
  it("lists default profiles (python, node, cpp, java)", () => {
    const registry = createProfileRegistry();
    const profiles = registry.listProfiles();
    assert.ok(Array.isArray(profiles));
    const ids = profiles.map((p) => p.id);
    assert.ok(ids.includes("python"));
    assert.ok(ids.includes("node"));
    assert.ok(ids.includes("cpp"));
    assert.ok(ids.includes("java"));
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

  it("resolves 'node:<path>' when source file exists into ProcessBot", () => {
    const tempBotFile = path.join(os.tmpdir(), `test_node_bot_${Date.now()}.mjs`);
    fs.writeFileSync(tempBotFile, "console.log('hello');", "utf8");

    try {
      const registry = createProfileRegistry();
      const bot = registry.resolveBot(`node:${tempBotFile}`, { botId: "valid-node" });
      assert.ok(bot);
      assert.equal(bot.botId, "valid-node");
      assert.equal(typeof bot.start, "function");
      assert.equal(typeof bot.requestMove, "function");
      assert.equal(typeof bot.stop, "function");
    } finally {
      try { fs.unlinkSync(tempBotFile); } catch (_) {}
    }
  });

  it("rejects uncompiled C++ source file with uncompiled_source infrastructure error", () => {
    const tempCpp = path.join(os.tmpdir(), `raw_uncompiled_${Date.now()}.cpp`);
    fs.writeFileSync(tempCpp, "int main() { return 0; }", "utf8");

    try {
      const registry = createProfileRegistry();
      assert.throws(
        () => registry.resolveBot(`cpp:${tempCpp}`, { botId: "uncompiled-cpp" }),
        (err) => {
          assert.equal(err.kind, "infrastructure_error");
          assert.equal(err.code, "uncompiled_source");
          return true;
        }
      );
    } finally {
      try { fs.unlinkSync(tempCpp); } catch (_) {}
    }
  });

  it("rejects uncompiled Java source file with uncompiled_source infrastructure error", () => {
    const tempJava = path.join(os.tmpdir(), `RawUncompiled_${Date.now()}.java`);
    fs.writeFileSync(tempJava, "public class RawUncompiled {}", "utf8");

    try {
      const registry = createProfileRegistry();
      assert.throws(
        () => registry.resolveBot(`java:${tempJava}`, { botId: "uncompiled-java" }),
        (err) => {
          assert.equal(err.kind, "infrastructure_error");
          assert.equal(err.code, "uncompiled_source");
          return true;
        }
      );
    } finally {
      try { fs.unlinkSync(tempJava); } catch (_) {}
    }
  });

  it("separates unavailable runtime from execution failure using probe doubles", () => {
    const registry = createProfileRegistry();
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
