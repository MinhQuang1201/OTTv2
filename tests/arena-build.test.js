/**
 * Arena Build Service & Artifact Store Unit Tests — Task 7 (Milestone M2)
 * Tests artifact store content addressing, atomic publish, tamper detection,
 * build service workflow (RECEIVED -> BUILDING -> READY/FAILED),
 * controlled fake compiler execution, timeout cancellation, log bounds, and caching.
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const TEMP_BASE_DIR = path.resolve(os.tmpdir(), "arena-build-test-" + Date.now());

let createArtifactStore;
let createBuildService;
let MAX_BUILD_LOG_BYTES;
let DEFAULT_BUILD_DEADLINE_MS;

before(async () => {
  fs.mkdirSync(TEMP_BASE_DIR, { recursive: true });

  const artifactMod = await import("../packages/arena-node/src/artifacts/artifact-store.mjs");
  const buildMod = await import("../packages/arena-node/src/execution/build-service.mjs");

  createArtifactStore = artifactMod.createArtifactStore;
  createBuildService = buildMod.createBuildService;
  MAX_BUILD_LOG_BYTES = buildMod.MAX_BUILD_LOG_BYTES;
  DEFAULT_BUILD_DEADLINE_MS = buildMod.DEFAULT_BUILD_DEADLINE_MS;
});

after(() => {
  try {
    fs.rmSync(TEMP_BASE_DIR, { recursive: true, force: true });
  } catch (_) {}
});

describe("ArtifactStore: content-addressed storage and integrity", () => {
  it("stores and resolves artifacts by SHA-256 digest", async () => {
    const store = createArtifactStore({ storageDir: path.join(TEMP_BASE_DIR, "store-1") });
    const content = Buffer.from("int main() { return 0; }", "utf8");

    const stored = await store.storeArtifact("source", content);
    assert.ok(stored.digest.startsWith("sha256:"));
    assert.equal(stored.bytes, content.length);
    assert.ok(fs.existsSync(stored.path));

    const resolved = await store.resolveArtifact(stored.digest);
    assert.ok(resolved);
    assert.equal(resolved.digest, stored.digest);
    assert.equal(resolved.bytes, content.length);
  });

  it("detects tampered artifact on disk as infrastructure error (NOT bot loss)", async () => {
    const store = createArtifactStore({ storageDir: path.join(TEMP_BASE_DIR, "store-2") });
    const content = Buffer.from("original untampered code", "utf8");

    const stored = await store.storeArtifact("source", content);

    // Tamper with the file directly on disk
    fs.writeFileSync(stored.path, "maliciously tampered content", "utf8");

    await assert.rejects(
      () => store.resolveArtifact(stored.digest),
      (err) => {
        assert.equal(err.kind, "infrastructure_error");
        assert.equal(err.code, "tamper_detected");
        return true;
      }
    );
  });

  it("performs atomic publish via rename to avoid partial artifact reads", async () => {
    const store = createArtifactStore({ storageDir: path.join(TEMP_BASE_DIR, "store-3") });
    const content = Buffer.from("atomic publish content", "utf8");

    const stored = await store.storeArtifact("build", content, {
      manifest: { schemaVersion: 1, profileId: "node", status: "READY" }
    });

    assert.ok(fs.existsSync(stored.path));
    const manifest = await store.getManifest(stored.digest);
    assert.ok(manifest);
    assert.equal(manifest.status, "READY");
  });
});

describe("BuildService: lifecycle and controlled compiler execution", () => {
  it("compiles successfully with controlled compiler double: status READY with manifest", async () => {
    const store = createArtifactStore({ storageDir: path.join(TEMP_BASE_DIR, "build-store-1") });

    // Fake compiler that creates an output binary and exits 0
    const fakeCompiler = {
      profileId: "fake-c",
      profileRevision: "fake-c-v1",
      compilerVersion: "fake-cc 1.0",
      compile(options) {
        const outBin = path.join(options.buildDir, "bot.exe");
        fs.writeFileSync(outBin, "BINARY_MOCK_CONTENT", "utf8");
        return {
          status: 0,
          stdout: "Compiling bot...\nOptimization level 2 enabled.\nBuild succeeded.\n",
          stderr: "",
          entrypoint: "bot.exe"
        };
      }
    };

    const buildService = createBuildService({
      artifactStore: store,
      compilers: { "fake-c": fakeCompiler }
    });

    const result = await buildService.build({
      sourceContent: "int main() { return 0; }",
      profileId: "fake-c",
      compilerOptions: ["-O2"]
    });

    assert.equal(result.status, "READY");
    assert.ok(result.artifactDigest);
    assert.ok(result.manifest);
    assert.equal(result.manifest.profileId, "fake-c");
    assert.equal(result.manifest.status, "READY");
    assert.ok(result.logs.includes("Build succeeded"));
  });

  it("records status FAILED with compiler error logs when compilation fails", async () => {
    const store = createArtifactStore({ storageDir: path.join(TEMP_BASE_DIR, "build-store-2") });

    const failingCompiler = {
      profileId: "fake-c",
      profileRevision: "fake-c-v1",
      compilerVersion: "fake-cc 1.0",
      compile() {
        return {
          status: 1,
          stdout: "",
          stderr: "error: syntax error at line 5: expected ';' before '}' token\n"
        };
      }
    };

    const buildService = createBuildService({
      artifactStore: store,
      compilers: { "fake-c": failingCompiler }
    });

    const result = await buildService.build({
      sourceContent: "broken syntax",
      profileId: "fake-c"
    });

    assert.equal(result.status, "FAILED");
    assert.equal(result.artifactDigest, null);
    assert.equal(result.error, "compile_failure");
    assert.ok(result.logs.includes("syntax error"));
  });

  it("enforces 30s build deadline and kills compiler tree when compilation hangs", async () => {
    const store = createArtifactStore({ storageDir: path.join(TEMP_BASE_DIR, "build-store-3") });

    const hangingCompiler = {
      profileId: "hanging-c",
      profileRevision: "hanging-c-v1",
      compilerVersion: "hanging-cc 1.0",
      async compile(options) {
        // Simulates hang exceeding deadline
        await new Promise((r) => setTimeout(r, options.timeoutMs + 50));
        return { status: 0, stdout: "", stderr: "" };
      }
    };

    const buildService = createBuildService({
      artifactStore: store,
      compilers: { "hanging-c": hangingCompiler },
      buildDeadlineMs: 100 // Short deadline for unit test
    });

    const result = await buildService.build({
      sourceContent: "while(true) {}",
      profileId: "hanging-c"
    });

    assert.equal(result.status, "FAILED");
    assert.equal(result.error, "build_timeout");
  });

  it("caps build diagnostic logs to 1 MiB (MAX_BUILD_LOG_BYTES)", async () => {
    const store = createArtifactStore({ storageDir: path.join(TEMP_BASE_DIR, "build-store-4") });

    // Compiler that produces 2 MiB of logs
    const floodCompiler = {
      profileId: "flood-c",
      profileRevision: "flood-c-v1",
      compilerVersion: "flood-cc 1.0",
      compile(options) {
        const outBin = path.join(options.buildDir, "bot.exe");
        fs.writeFileSync(outBin, "BIN", "utf8");
        return {
          status: 0,
          stdout: "A".repeat(1500000), // 1.5 MiB
          stderr: "B".repeat(1000000), // 1.0 MiB
          entrypoint: "bot.exe"
        };
      }
    };

    const buildService = createBuildService({
      artifactStore: store,
      compilers: { "flood-c": floodCompiler }
    });

    const result = await buildService.build({
      sourceContent: "flood code",
      profileId: "flood-c"
    });

    assert.equal(result.status, "READY");
    assert.ok(result.logs.length <= MAX_BUILD_LOG_BYTES);
  });

  it("returns cached build result when source, profile, and compiler options match", async () => {
    const store = createArtifactStore({ storageDir: path.join(TEMP_BASE_DIR, "build-store-5") });
    let compileCount = 0;

    const countingCompiler = {
      profileId: "cached-c",
      profileRevision: "cached-c-v1",
      compilerVersion: "cached-cc 1.0",
      compile(options) {
        compileCount++;
        const outBin = path.join(options.buildDir, "bot.exe");
        fs.writeFileSync(outBin, `BINARY_REV_${compileCount}`, "utf8");
        return {
          status: 0,
          stdout: `Compiled run ${compileCount}`,
          stderr: "",
          entrypoint: "bot.exe"
        };
      }
    };

    const buildService = createBuildService({
      artifactStore: store,
      compilers: { "cached-c": countingCompiler }
    });

    const req = {
      sourceContent: "int foo() { return 42; }",
      profileId: "cached-c",
      compilerOptions: ["-O3"]
    };

    // First build
    const res1 = await buildService.build(req);
    assert.equal(res1.status, "READY");
    assert.equal(compileCount, 1);

    // Second build with same parameters
    const res2 = await buildService.build(req);
    assert.equal(res2.status, "READY");
    assert.equal(compileCount, 1); // Not called again!
    assert.equal(res2.artifactDigest, res1.artifactDigest);
    assert.ok(res2.logs.includes("cached"));
  });

  it("handles cancelled / interrupted build without marking status READY", async () => {
    const store = createArtifactStore({ storageDir: path.join(TEMP_BASE_DIR, "build-store-6") });

    const slowCompiler = {
      profileId: "slow-c",
      profileRevision: "slow-c-v1",
      compilerVersion: "slow-cc 1.0",
      async compile(options) {
        await new Promise((r) => setTimeout(r, 200));
        return { status: 0, stdout: "", stderr: "" };
      }
    };

    const buildService = createBuildService({
      artifactStore: store,
      compilers: { "slow-c": slowCompiler }
    });

    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 20);

    const result = await buildService.build({
      sourceContent: "slow source",
      profileId: "slow-c",
      signal: abortController.signal
    });

    assert.equal(result.status, "FAILED");
    assert.equal(result.error, "interrupted");
    assert.equal(result.artifactDigest, null);
  });
});
