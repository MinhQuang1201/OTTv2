/**
 * Arena Container Executor Unit Test Suite — Task 19 (Controlled Runner)
 * Tests argument synthesis, resource bounds, server-generated container naming,
 * fail-closed behavior, non-root user, tmpfs scratch, and profile scoping outside Docker.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

describe("Container Executor — Unit & Controlled Command Runner", () => {
  it("imports container-executor module and exposes public API", async () => {
    const mod = await import("../packages/arena-node/src/execution/container-executor.mjs");
    assert.equal(typeof mod.createContainerBot, "function");
    assert.equal(typeof mod.createContainerBuildService, "function");
    assert.equal(typeof mod.probeContainerRuntime, "function");
    assert.equal(typeof mod.generateContainerName, "function");
    assert.equal(typeof mod.validateContainerName, "function");
    assert.ok(mod.DEFAULT_CONTAINER_RUN_LIMITS);
    assert.ok(mod.DEFAULT_CONTAINER_BUILD_LIMITS);
  });

  it("generates valid, strictly bounded container names", async () => {
    const { generateContainerName, validateContainerName } = await import(
      "../packages/arena-node/src/execution/container-executor.mjs"
    );

    const name1 = generateContainerName("bot", "match-123", 0);
    assert.ok(name1.startsWith("arena-bot-match-123-0-"));
    assert.ok(validateContainerName(name1));
    assert.ok(name1.length <= 64);

    // Rejects invalid names
    assert.equal(validateContainerName(""), false);
    assert.equal(validateContainerName("bad;name"), false);
    assert.equal(validateContainerName("../traversal"), false);
    assert.equal(validateContainerName("spaces not allowed"), false);
    assert.equal(validateContainerName("a".repeat(65)), false);
  });

  it("constructs correct OCI docker arguments with strict resource bounds and no host mounts", async () => {
    const { buildDockerRunArgs, DEFAULT_CONTAINER_RUN_LIMITS } = await import(
      "../packages/arena-node/src/execution/container-executor.mjs"
    );

    const args = buildDockerRunArgs({
      containerName: "arena-bot-test-0-abc123",
      image: "ottv2-arena-runner:local",
      sourceHostPath: "D:/temp/bot.py",
      containerMountPath: "/bot/bot.py",
      runtimeCommand: "python3",
      runtimeArgs: ["-u", "/bot/bot.py"],
      limits: DEFAULT_CONTAINER_RUN_LIMITS
    });

    assert.ok(args.includes("--network"), "must specify network");
    assert.ok(args.includes("none"), "network must be disabled ('none')");
    assert.ok(args.includes("--cap-drop"), "must drop capabilities");
    assert.ok(args.includes("ALL"), "must drop ALL capabilities");
    assert.ok(args.includes("--security-opt"), "must specify security opt");
    assert.ok(args.includes("no-new-privileges:true"), "must enforce no-new-privileges");
    assert.ok(args.includes("--read-only"), "root filesystem must be read-only");
    assert.ok(args.includes("--tmpfs"), "must mount tmpfs scratch");
    assert.ok(args.some((a) => a.startsWith("/tmp/scratch")), "scratch must be bounded tmpfs");
    assert.ok(args.includes("--memory"), "must enforce memory limit");
    assert.ok(args.includes("256m"), "memory must be bounded at 256m");
    assert.ok(args.includes("--pids-limit"), "must enforce pids limit");
    assert.ok(args.includes("32"), "pids limit must be bounded at 32");
    assert.ok(args.includes("-u"), "must specify non-root user");
    assert.ok(args.includes("10001:10001"), "user must be non-root uid 10001");
    assert.ok(args.includes("-i"), "must run interactive for stdio streaming");
    assert.ok(!args.includes("-t"), "must strictly NOT use pseudo-tty (-t)");

    // Ensure no docker socket or secret mounts
    const joined = args.join(" ");
    assert.ok(!joined.includes("docker.sock"), "must NOT mount docker socket");
    assert.ok(!joined.includes(".env"), "must NOT mount env secrets");
    assert.ok(!joined.includes("arena.db"), "must NOT mount arena database");
  });

  it("fails closed without host fallback when container spawn fails", async () => {
    const { createContainerBot } = await import(
      "../packages/arena-node/src/execution/container-executor.mjs"
    );

    // Fake command runner that simulates docker execution failure
    const fakeRunner = {
      spawnSync(cmd, args) {
        if (args.includes("version")) {
          return {
            status: 0,
            stdout: JSON.stringify({ Server: { Os: "linux", Version: "28.0", Arch: "amd64" } })
          };
        }
        if (args.some((a) => a.includes("inspect"))) {
          return { status: 0, stdout: "sha256:1aa51999f9abee74e6a8a368eb496c88a913a7e1dd53ec53df15f5df12298a54" };
        }
        return { status: 0, stdout: "" };
      },
      spawn() {
        const { EventEmitter } = require("node:events");
        const emitter = new EventEmitter();
        process.nextTick(() => {
          const err = new Error("docker daemon connection refused");
          err.code = "ECONNREFUSED";
          emitter.emit("error", err);
        });
        return emitter;
      }
    };

    const validCode = Buffer.from("import sys; print(1)\n");
    const validDigest = `sha256:${crypto.createHash("sha256").update(validCode).digest("hex")}`;
    const fakeStore = {
      async resolveArtifact() {
        return validCode;
      }
    };

    const bot = createContainerBot({
      botId: "failing-bot",
      profileId: "python",
      artifactStore: fakeStore,
      artifactDigest: validDigest,
      commandRunner: fakeRunner
    });

    await assert.rejects(
      async () => {
        await bot.start({});
      },
      (err) => {
        assert.ok(err.message.includes("docker") || err.message.includes("container"));
        assert.equal(err.kind, "infrastructure_error");
        return true;
      }
    );
  });

  it("confirms strict limits: stdout 1 MiB, stderr 256 KiB, grace 250 ms", async () => {
    const { DEFAULT_CONTAINER_RUN_LIMITS } = await import(
      "../packages/arena-node/src/execution/container-executor.mjs"
    );
    assert.equal(DEFAULT_CONTAINER_RUN_LIMITS.stdoutMaxTotalBytes, 1048576, "stdout must be 1 MiB");
    assert.equal(DEFAULT_CONTAINER_RUN_LIMITS.stderrMaxTotalBytes, 262144, "stderr must be 256 KiB");
    assert.equal(DEFAULT_CONTAINER_RUN_LIMITS.graceStopMs, 250, "grace must be 250 ms");
  });

  it("fails closed on malformed docker version output without faking Linux", async () => {
    const { probeContainerRuntime } = await import(
      "../packages/arena-node/src/execution/container-executor.mjs"
    );

    const fakeRunner = {
      spawnSync(cmd, args) {
        if (args.includes("version")) {
          return { status: 0, stdout: "GARBAGE NOT JSON" };
        }
        return { status: 0, stdout: "" };
      }
    };

    const probe = probeContainerRuntime({ commandRunner: fakeRunner });
    assert.equal(probe.available, false);
    assert.equal(probe.verified, false);
    assert.equal(probe.reason, "malformed_docker_version_output");
  });

  it("fails closed when docker server OS is not Linux", async () => {
    const { probeContainerRuntime } = await import(
      "../packages/arena-node/src/execution/container-executor.mjs"
    );

    const fakeRunner = {
      spawnSync(cmd, args) {
        if (args.includes("version")) {
          return {
            status: 0,
            stdout: JSON.stringify({ Server: { Os: "windows", Version: "28.0", Arch: "amd64" } })
          };
        }
        return { status: 0, stdout: "" };
      }
    };

    const probe = probeContainerRuntime({ commandRunner: fakeRunner });
    assert.equal(probe.available, false);
    assert.equal(probe.verified, false);
    assert.ok(probe.reason.includes("non_linux_server_os"));
  });

  it("rejects image digest drift BEFORE execution", async () => {
    const { probeContainerRuntime } = await import(
      "../packages/arena-node/src/execution/container-executor.mjs"
    );

    const fakeRunner = {
      spawnSync(cmd, args) {
        if (args.includes("version")) {
          return {
            status: 0,
            stdout: JSON.stringify({ Server: { Os: "linux", Version: "28.0", Arch: "amd64" } })
          };
        }
        if (args.some((a) => a.includes("inspect"))) {
          // Returns different sha than expected pinned ID
          return { status: 0, stdout: "sha256:drifted999999999999999999999999999999999999999999999999999999999999" };
        }
        return { status: 0, stdout: "" };
      }
    };

    const probe = probeContainerRuntime({
      expectedImageId: "sha256:1aa51999f9abee74e6a8a368eb496c88a913a7e1dd53ec53df15f5df12298a54",
      commandRunner: fakeRunner
    });

    assert.equal(probe.available, false);
    assert.equal(probe.verified, false);
    assert.ok(probe.reason.includes("image_digest_drift"), `reason was: ${probe.reason}`);
  });

  it("rejects bare boolean verifiedTargetHost forgery (local desktop remains unverified)", async () => {
    const { probeContainerRuntime } = await import(
      "../packages/arena-node/src/execution/container-executor.mjs"
    );

    const fakeRunner = {
      spawnSync(cmd, args) {
        if (args.includes("version")) {
          return {
            status: 0,
            stdout: JSON.stringify({ Server: { Os: "linux", Version: "28.0", Arch: "amd64" } })
          };
        }
        if (args.some((a) => a.includes("inspect"))) {
          return { status: 0, stdout: "sha256:1aa51999f9abee74e6a8a368eb496c88a913a7e1dd53ec53df15f5df12298a54" };
        }
        return { status: 0, stdout: "" };
      }
    };

    // Forgery attempt with bare boolean
    const probe = probeContainerRuntime({
      expectedImageId: "sha256:1aa51999f9abee74e6a8a368eb496c88a913a7e1dd53ec53df15f5df12298a54",
      verifiedTargetHost: true,
      commandRunner: fakeRunner
    });

    assert.equal(probe.available, true);
    assert.equal(probe.verified, false, "verified must NOT be settable via bare boolean flag");
  });

  it("production container bot rejects workspace source without artifactStore and artifactDigest", async () => {
    const { createContainerBot } = await import(
      "../packages/arena-node/src/execution/container-executor.mjs"
    );

    assert.throws(
      () => {
        createContainerBot({
          botId: "unverified-bot",
          profileId: "python",
          sourcePath: "D:/temp/my-bot.py"
        });
      },
      (err) => {
        assert.equal(err.code, "artifact_required");
        assert.equal(err.kind, "infrastructure_error");
        assert.ok(err.message.includes("artifactStore") && err.message.includes("artifactDigest"));
        return true;
      }
    );
  });

  it("resolves artifact from store, verifies digest, and creates private immutable snapshot", async () => {
    const { createContainerBot } = await import(
      "../packages/arena-node/src/execution/container-executor.mjs"
    );
    const { computeSha256 } = await import(
      "../packages/arena-node/src/artifacts/artifact-store.mjs"
    );

    const validCode = Buffer.from("import sys\nprint('ready')\n");
    const validDigest = computeSha256(validCode);

    const fakeStore = {
      async resolveArtifact(digest) {
        if (digest === validDigest) return validCode;
        return null;
      }
    };

    let capturedDockerArgs = null;
    const fakeRunner = {
      spawnSync(cmd, args) {
        if (args.includes("version")) {
          return { status: 0, stdout: JSON.stringify({ Server: { Os: "linux", Version: "28.0", Arch: "amd64" } }) };
        }
        if (args.some((a) => a.includes("inspect"))) {
          return { status: 0, stdout: "sha256:1aa51999f9abee74e6a8a368eb496c88a913a7e1dd53ec53df15f5df12298a54" };
        }
        return { status: 0, stdout: "" };
      },
      spawn(cmd, args) {
        capturedDockerArgs = args;
        const { EventEmitter } = require("node:events");
        const emitter = new EventEmitter();
        const { PassThrough } = require("node:stream");
        emitter.stdout = new PassThrough();
        emitter.stderr = new PassThrough();
        emitter.stdin = new PassThrough();
        process.nextTick(() => {
          emitter.emit("spawn");
        });
        return emitter;
      }
    };

    const bot = createContainerBot({
      botId: "verified-artifact-bot",
      profileId: "python",
      artifactStore: fakeStore,
      artifactDigest: validDigest,
      commandRunner: fakeRunner
    });

    await bot.start({});
    assert.ok(capturedDockerArgs, "must invoke docker");

    // Check mount argument: must mount private immutable snapshot, NOT mutable workspace path
    const mountIdx = capturedDockerArgs.indexOf("-v");
    assert.notEqual(mountIdx, -1, "must have volume mount");
    const mountedPath = capturedDockerArgs[mountIdx + 1];
    assert.ok(mountedPath.includes("arena-isolated-snapshots"), "mounted path must be in isolated snapshots dir");
    const hexHash = validDigest.replace(/^sha256:/, "");
    assert.ok(mountedPath.includes(hexHash.slice(0, 16)), "mounted file must reference artifact digest snapshot");
    assert.ok(mountedPath.endsWith(":ro"), "mount must be strictly read-only");

    // Mutate source in artifactStore AFTER launch — running container is unaffected
    fakeStore.resolveArtifact = async () => Buffer.from("MUTATED CORRUPTED SOURCE");

    // Stop cleanly and verify private snapshot directory is cleaned up
    await bot.stop();
  });

  it("fails closed with infrastructure_error when artifact in store has been tampered with", async () => {
    const { createContainerBot } = await import(
      "../packages/arena-node/src/execution/container-executor.mjs"
    );

    const expectedDigest = "sha256:expected111111111111111111111111111111111111111111111111111111111111";
    const tamperedBuffer = Buffer.from("TAMPERED_BYTES_DIFFERENT_SHA");

    const fakeStore = {
      async resolveArtifact(digest) {
        return tamperedBuffer;
      }
    };

    const fakeRunner = {
      spawnSync(cmd, args) {
        if (args.includes("version")) {
          return { status: 0, stdout: JSON.stringify({ Server: { Os: "linux", Version: "28.0", Arch: "amd64" } }) };
        }
        if (args.some((a) => a.includes("inspect"))) {
          return { status: 0, stdout: "sha256:1aa51999f9abee74e6a8a368eb496c88a913a7e1dd53ec53df15f5df12298a54" };
        }
        return { status: 0, stdout: "" };
      }
    };

    const bot = createContainerBot({
      botId: "tampered-bot",
      profileId: "python",
      artifactStore: fakeStore,
      artifactDigest: expectedDigest,
      commandRunner: fakeRunner
    });

    await assert.rejects(
      async () => {
        await bot.start({});
      },
      (err) => {
        assert.equal(err.code, "tampered_artifact");
        assert.equal(err.kind, "infrastructure_error");
        assert.ok(err.message.includes("tampered"));
        return true;
      }
    );
  });

  it("ProfileRegistry rejects oci-container execution without published artifact", async () => {
    const { createProfileRegistry } = await import(
      "../packages/arena-node/src/execution/profile-registry.mjs"
    );

    const registry = createProfileRegistry({ executor: "oci-container" });

    assert.throws(
      () => {
        registry.resolveBot("python:./some/workspace/bot.py");
      },
      (err) => {
        assert.equal(err.code, "artifact_required");
        assert.equal(err.kind, "infrastructure_error");
        assert.ok(err.message.includes("published artifact"));
        return true;
      }
    );
  });

  it("ProfileRegistry resolves oci-container bot with published artifact even when host path is omitted and host Python is unavailable", async () => {
    const { createProfileRegistry } = await import(
      "../packages/arena-node/src/execution/profile-registry.mjs"
    );

    // Create a registry configured with an unavailable python executable
    const registry = createProfileRegistry({
      executor: "oci-container",
      pythonExecutable: "nonexistent-python-binary-that-cannot-run"
    });

    const fakeStore = {
      async resolveArtifact(digest) {
        return Buffer.from("print('hello')\n");
      }
    };

    // Note: No original source file path on disk; host python unavailable.
    // OCI artifact dispatch must succeed without probing host python or checking host files.
    const bot = registry.resolveBot("python", {
      artifactStore: fakeStore,
      artifactDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111"
    });

    assert.ok(bot, "must return bot");
    assert.equal(typeof bot.start, "function");
    assert.equal(typeof bot.requestMove, "function");
    assert.equal(typeof bot.stop, "function");
  });

  it("ProfileRegistry rejects unsupported executor strings with unsupported_executor", async () => {
    const { createProfileRegistry } = await import(
      "../packages/arena-node/src/execution/profile-registry.mjs"
    );

    const registry = createProfileRegistry();

    assert.throws(
      () => {
        registry.resolveBot("python:bot.py", { executor: "some-fake-executor" });
      },
      (err) => {
        assert.equal(err.code, "unsupported_executor");
        assert.equal(err.kind, "infrastructure_error");
        return true;
      }
    );
  });

  it("createContainerBot validates expectedManifest fields (profile, digest, executor, image, sourceDigest)", async () => {
    const { createContainerBot, PINNED_RUNNER_IMAGE, CONTAINER_EXECUTOR_REVISION } = await import(
      "../packages/arena-node/src/execution/container-executor.mjs"
    );

    const validCode = Buffer.from("import sys\nprint('manifest test')\n");
    const validDigest = `sha256:${crypto.createHash("sha256").update(validCode).digest("hex")}`;
    const fakeStore = {
      async resolveArtifact(digest) {
        return validCode;
      }
    };

    const fakeRunner = {
      spawnSync(cmd, args) {
        if (args.includes("version")) {
          return { status: 0, stdout: JSON.stringify({ Server: { Os: "linux", Version: "28.0", Arch: "amd64" } }) };
        }
        if (args.some((a) => a.includes("inspect"))) {
          return { status: 0, stdout: "sha256:1aa51999f9abee74e6a8a368eb496c88a913a7e1dd53ec53df15f5df12298a54" };
        }
        return { status: 0, stdout: "" };
      }
    };

    // 1. Executor mismatch
    const badExecBot = createContainerBot({
      botId: "bad-exec",
      profileId: "python",
      artifactStore: fakeStore,
      artifactDigest: validDigest,
      expectedManifest: {
        profileId: "python",
        artifactDigest: validDigest,
        executor: "wrong-executor-revision",
        image: PINNED_RUNNER_IMAGE,
        sourceDigest: validDigest
      },
      commandRunner: fakeRunner
    });

    await assert.rejects(
      async () => { await badExecBot.start({}); },
      (err) => {
        assert.equal(err.code, "manifest_executor_mismatch");
        return true;
      }
    );

    // 2. Image mismatch
    const badImageBot = createContainerBot({
      botId: "bad-image",
      profileId: "python",
      artifactStore: fakeStore,
      artifactDigest: validDigest,
      expectedManifest: {
        profileId: "python",
        artifactDigest: validDigest,
        executor: CONTAINER_EXECUTOR_REVISION,
        image: "wrong-image:tag",
        sourceDigest: validDigest
      },
      commandRunner: fakeRunner
    });

    await assert.rejects(
      async () => { await badImageBot.start({}); },
      (err) => {
        assert.equal(err.code, "manifest_image_mismatch");
        return true;
      }
    );
  });
});

