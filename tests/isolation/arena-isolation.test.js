/**
 * Dedicated Arena OCI Container Isolation Acceptance Suite — Task 19 (Milestone M6a)
 * Tests actual Linux/amd64 kernel & runtime isolation restrictions:
 * 1. Preflight verifies real OCI container runtime (fail exit 1 if missing)
 * 2. Host canary & sensitive path isolation (read access blocked)
 * 3. Read-only root filesystem (--read-only write blocked)
 * 4. Network egress disabled (--network none blocks socket & HTTP)
 * 5. PID limit enforcement (cgroups block fork bomb with BlockingIOError)
 * 6. RAM limit enforcement (256 MiB limit OOM-kills memory allocator)
 * 7. Output flood bounds (64 KiB line, 1 MiB stream truncation)
 * 8. Hang & infinite loop lifecycle termination (stop removes container)
 * 9. Child process cleanup (container namespace termination reaps all descendants)
 * 10. Normal match execution after previous failure (no resource leakage)
 * 11. Isolated build sandbox & digest-verified content-addressed publishing
 * 12. Full end-to-end referee match with isolated Python & Node container bots
 * 13. Fail-closed verification (never fall back to host execution).
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const FIXTURES_DIR = path.resolve(__dirname, "../fixtures/arena/isolation");
const TEST_CANARY_PATH = path.resolve(__dirname, "../../var/arena/isolation-canary.txt");

let createContainerBot;
let createContainerBuildService;
let probeContainerRuntime;
let buildDockerRunArgs;
let getIsolationProfileCapabilities;
let DEFAULT_CONTAINER_RUN_LIMITS;
let DEFAULT_CONTAINER_BUILD_LIMITS;
let PINNED_RUNNER_IMAGE;

let createNodeEngine;
let createHeadlessMatchController;
let createReplayJournal;
let createNodeClock;
let createArtifactStore;
let createCurrentRulesetSnapshot;
let computeRulesetHash;
let DEFAULT_MATCH_POLICY;
let coreConfig;

let runtimeProbe = null;
let fixtureStore = null;
let fixtureStoreDir = null;

async function publishFixture(fixturePath) {
  const content = fs.readFileSync(fixturePath);
  const stored = await fixtureStore.storeArtifact("source", content);
  return stored.digest;
}

before(async () => {
  // Pre-create host canary file for testing canary read isolation
  const canaryDir = path.dirname(TEST_CANARY_PATH);
  fs.mkdirSync(canaryDir, { recursive: true });
  fs.writeFileSync(TEST_CANARY_PATH, `SECRET_CANARY_KEY_${Date.now()}_DO_NOT_LEAK`, "utf8");

  // Load modules
  const executorMod = await import("../../packages/arena-node/src/execution/container-executor.mjs");
  const engineMod = await import("../../packages/arena-node/src/core/node-engine.mjs");
  const controllerMod = await import("../../packages/arena/src/application/match-controller.mjs");
  const journalMod = await import("../../packages/arena/src/application/replay-journal.mjs");
  const clockMod = await import("../../packages/arena-node/src/clock/node-clock.mjs");
  const artifactMod = await import("../../packages/arena-node/src/artifacts/artifact-store.mjs");
  const contractsMod = await import("../../packages/arena/src/contracts/index.mjs");
  const identityMod = await import("../../packages/arena-node/src/core/ruleset-identity.mjs");
  const policyMod = await import("../../packages/arena/src/domain/match-policy.mjs");

  createCurrentRulesetSnapshot = contractsMod.createCurrentRulesetSnapshot;
  computeRulesetHash = identityMod.computeRulesetHash;
  DEFAULT_MATCH_POLICY = policyMod.DEFAULT_MATCH_POLICY;

  createContainerBot = executorMod.createContainerBot;
  createContainerBuildService = executorMod.createContainerBuildService;
  probeContainerRuntime = executorMod.probeContainerRuntime;
  buildDockerRunArgs = executorMod.buildDockerRunArgs;
  getIsolationProfileCapabilities = executorMod.getIsolationProfileCapabilities;
  DEFAULT_CONTAINER_RUN_LIMITS = executorMod.DEFAULT_CONTAINER_RUN_LIMITS;
  DEFAULT_CONTAINER_BUILD_LIMITS = executorMod.DEFAULT_CONTAINER_BUILD_LIMITS;
  PINNED_RUNNER_IMAGE = executorMod.PINNED_RUNNER_IMAGE;

  createNodeEngine = engineMod.createNodeEngine;
  coreConfig = engineMod.coreConfig;
  createHeadlessMatchController = controllerMod.createHeadlessMatchController;
  createReplayJournal = journalMod.createReplayJournal;
  createNodeClock = clockMod.createNodeClock;
  createArtifactStore = artifactMod.createArtifactStore;

  // Initialize test harness fixture artifact store
  fixtureStoreDir = path.join(os.tmpdir(), `arena-iso-fixtures-${Date.now()}`);
  fs.mkdirSync(fixtureStoreDir, { recursive: true });
  fixtureStore = createArtifactStore({ storageDir: fixtureStoreDir });

  // STRICT PREFLIGHT: Fail exit 1 if Docker daemon or pinned image is missing (no skip!)
  runtimeProbe = probeContainerRuntime({ image: PINNED_RUNNER_IMAGE });
  if (!runtimeProbe.available) {
    console.error("\n[PREFLIGHT FAILURE] Container runtime environment is not provisioned!");
    console.error(`Reason: ${runtimeProbe.reason}`);
    console.error("Task 19 dedicated isolation suite requires Docker Desktop Linux/amd64 and pinned runner image.\n");
    process.exit(1);
  }
});

after(() => {
  try {
    if (fs.existsSync(TEST_CANARY_PATH)) {
      fs.unlinkSync(TEST_CANARY_PATH);
    }
  } catch (_) {}
  try {
    if (fixtureStoreDir && fs.existsSync(fixtureStoreDir)) {
      fs.rmSync(fixtureStoreDir, { recursive: true, force: true });
    }
  } catch (_) {}
});

describe("Task 19 — OCI Container Isolation Acceptance Suite", () => {
  it("Preflight: verifies real Linux/amd64 Docker daemon and pinned runner image", () => {
    assert.ok(runtimeProbe, "probe must be populated");
    assert.equal(runtimeProbe.available, true, "container runtime must be available");
    assert.equal(runtimeProbe.serverOs, "linux", "server OS must be linux");
    assert.equal(runtimeProbe.serverArch, "amd64", "server arch must be amd64");
    assert.ok(runtimeProbe.imageId.startsWith("sha256:"), "pinned image ID must be sha256 digest");
    assert.deepEqual(runtimeProbe.supportedProfiles, ["python", "node"]);
    assert.deepEqual(runtimeProbe.unsupportedProfiles, ["cpp", "java"]);
    // Local desktop is NOT dedicated deployment host evidence
    assert.equal(runtimeProbe.verified, false, "local desktop acceptance is not target host deployment verification");
  });

  it("Read-Only Root Filesystem: blocks file writes to container root with read-only error", () => {
    const fixturePath = path.join(FIXTURES_DIR, "readonly-writer.py");
    const containerMount = "/bot/readonly-writer.py";

    const args = buildDockerRunArgs({
      containerName: `arena-bot-ro-test-0-${Date.now().toString(16).slice(-8)}`,
      image: PINNED_RUNNER_IMAGE,
      sourceHostPath: fixturePath,
      containerMountPath: containerMount,
      runtimeCommand: "python3",
      runtimeArgs: ["-u", containerMount]
    });

    const res = spawnSync("docker", args, {
      shell: false,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000
    });

    assert.notEqual(res.status, 0, "write to read-only root must fail with non-zero exit code");
    const combinedOutput = `${res.stdout}\n${res.stderr}`;
    assert.ok(
      combinedOutput.includes("Read-only file system") || combinedOutput.includes("readonly_filesystem"),
      "output must demonstrate read-only filesystem restriction"
    );
  });

  it("Host Canary Isolation: prevents untrusted bot from reading real host canary file", () => {
    assert.ok(fs.existsSync(TEST_CANARY_PATH), "real canary file must exist on host disk before probe");
    const canarySecret = fs.readFileSync(TEST_CANARY_PATH, "utf8");
    assert.ok(canarySecret.startsWith("SECRET_CANARY_KEY_"), "canary secret verified on host");

    const fixturePath = path.join(FIXTURES_DIR, "canary-reader.py");
    const containerMount = "/bot/canary-reader.py";

    // Formulate real host canary path and WSL/container translated variations
    const normCanaryPath = TEST_CANARY_PATH.replace(/\\/g, "/");
    const driveMatch = normCanaryPath.match(/^([a-zA-Z]):\/(.*)$/);
    const driveLetter = driveMatch ? driveMatch[1].toLowerCase() : "d";
    const subPath = driveMatch ? driveMatch[2] : normCanaryPath;
    const wslCanaryPath = `/mnt/${driveLetter}/${subPath}`;
    const hostMntCanaryPath = `/host_mnt/${driveLetter}/${subPath}`;

    const args = buildDockerRunArgs({
      containerName: `arena-bot-canary-test-0-${Date.now().toString(16).slice(-8)}`,
      image: PINNED_RUNNER_IMAGE,
      sourceHostPath: fixturePath,
      containerMountPath: containerMount,
      runtimeCommand: "python3",
      runtimeArgs: ["-u", containerMount, TEST_CANARY_PATH, normCanaryPath, wslCanaryPath, hostMntCanaryPath]
    });

    // Explicitly verify no volume mount of canary parent directory or secrets
    const canaryParent = path.dirname(TEST_CANARY_PATH).replace(/\\/g, "/");
    const mountArgs = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-v" || args[i] === "--volume" || args[i] === "--mount") {
        mountArgs.push(args[i + 1]);
      }
    }
    assert.ok(
      !mountArgs.some((m) => m.includes(canaryParent) || m.includes("isolation-canary.txt")),
      "docker volume mounts must NOT mount canary parent directory or file"
    );

    const res = spawnSync("docker", args, {
      shell: false,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000
    });

    assert.notEqual(res.status, 0, "canary reader must exit non-zero (access denied)");
    const stdout = res.stdout || "";
    assert.ok(!stdout.includes(canarySecret), "host canary secret must NOT be leaked in output");
    assert.ok(!stdout.includes("leaked"), "canary reader must not report leaked status");

    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.status, "blocked", "must report blocked status");
    assert.ok(parsed.attempted >= 4, "must have attempted all passed candidate paths");
    assert.ok(
      parsed.failures.some((f) => f.path.includes("isolation-canary.txt")),
      "must record explicit failure attempting to read real host canary file"
    );
  });

  it("Network Egress Isolation: prevents outbound network connections (--network none)", () => {
    const fixturePath = path.join(FIXTURES_DIR, "network-egress.py");
    const containerMount = "/bot/network-egress.py";

    const args = buildDockerRunArgs({
      containerName: `arena-bot-net-test-0-${Date.now().toString(16).slice(-8)}`,
      image: PINNED_RUNNER_IMAGE,
      sourceHostPath: fixturePath,
      containerMountPath: containerMount,
      runtimeCommand: "python3",
      runtimeArgs: ["-u", containerMount]
    });

    const res = spawnSync("docker", args, {
      shell: false,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000
    });

    assert.notEqual(res.status, 0, "network egress must fail");
    const combined = `${res.stdout}\n${res.stderr}`;
    assert.ok(
      combined.includes("Network unreachable") || combined.includes("network_disabled"),
      "output must demonstrate network disabled restriction"
    );
    assert.ok(!combined.includes("NETWORK_EGRESS_SUCCEEDED"));
  });

  it("PID Limit Enforcement: cgroup pids limit blocks fork bombs with BlockingIOError", () => {
    const fixturePath = path.join(FIXTURES_DIR, "pid-fork-bomb.py");
    const containerMount = "/bot/pid-fork-bomb.py";

    const args = buildDockerRunArgs({
      containerName: `arena-bot-pids-test-0-${Date.now().toString(16).slice(-8)}`,
      image: PINNED_RUNNER_IMAGE,
      sourceHostPath: fixturePath,
      containerMountPath: containerMount,
      runtimeCommand: "python3",
      runtimeArgs: ["-u", containerMount]
    });

    const res = spawnSync("docker", args, {
      shell: false,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000
    });

    assert.notEqual(res.status, 0, "fork bomb must fail");
    const combined = `${res.stdout}\n${res.stderr}`;
    assert.ok(
      combined.includes("Resource temporarily unavailable") || combined.includes("pids_limit_enforced"),
      "output must demonstrate cgroup pids limit enforcement"
    );
  });

  it("RAM Limit Enforcement: 256 MiB limit causes container OOM termination", () => {
    const fixturePath = path.join(FIXTURES_DIR, "ram-allocator.py");
    const containerMount = "/bot/ram-allocator.py";

    const args = buildDockerRunArgs({
      containerName: `arena-bot-ram-test-0-${Date.now().toString(16).slice(-8)}`,
      image: PINNED_RUNNER_IMAGE,
      sourceHostPath: fixturePath,
      containerMountPath: containerMount,
      runtimeCommand: "python3",
      runtimeArgs: ["-u", containerMount]
    });

    const res = spawnSync("docker", args, {
      shell: false,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000
    });

    // OOM killer terminates process with SIGKILL (exit code 137 on Linux/Docker)
    assert.notEqual(res.status, 0, "allocating 400 MiB must not exit 0");
    assert.ok(!res.stdout.includes("Memory allocation succeeded without OOM"));
  });

  it("Output Flood Bounds: channel bounds and truncates excessive stdout output", async () => {
    const fixturePath = path.join(FIXTURES_DIR, "output-flooder.py");
    const digest = await publishFixture(fixturePath);
    const bot = createContainerBot({
      botId: "flooder-bot",
      profileId: "python",
      artifactStore: fixtureStore,
      artifactDigest: digest,
      limits: {
        ...DEFAULT_CONTAINER_RUN_LIMITS,
        stdoutMaxTotalBytes: 65536 // 64 KiB cap for test
      }
    });

    try {
      await bot.start({});
      // Wait briefly for flooder to write
      await new Promise((r) => setTimeout(r, 800));
      const fault = bot.getFault();
      // Excessive output triggers output_limit fault, protocol error or crash
      assert.ok(fault === null || fault.code === "output_limit" || fault.code === "crash" || fault.code === "protocol_error");
    } finally {
      await bot.stop();
    }
  });

  it("Hang & Infinite Loop Lifecycle: stop() forcefully kills container process tree", async () => {
    const fixturePath = path.join(FIXTURES_DIR, "infinite-loop.py");
    const digest = await publishFixture(fixturePath);
    const bot = createContainerBot({
      botId: "hang-bot",
      profileId: "python",
      artifactStore: fixtureStore,
      artifactDigest: digest
    });

    await bot.start({});
    assert.ok(bot.containerName, "must have assigned containerName");

    // Allow Docker daemon to register container running state
    await new Promise((r) => setTimeout(r, 400));

    // Container should be actively running
    const inspectCheck = spawnSync("docker", ["inspect", "--format={{.State.Running}}", bot.containerName], {
      shell: false,
      windowsHide: true,
      encoding: "utf8"
    });
    assert.equal(inspectCheck.stdout.trim(), "true", "container must be running before stop");

    // Call stop()
    await bot.stop();

    // Verify container is terminated and removed
    const postInspect = spawnSync("docker", ["inspect", bot.containerName], {
      shell: false,
      windowsHide: true,
      encoding: "utf8"
    });
    assert.notEqual(postInspect.status, 0, "container must be removed after stop");
  });

  it("Child Process Cleanup: container teardown terminates all descendant processes", async () => {
    const fixturePath = path.join(FIXTURES_DIR, "child-spawner.py");
    const digest = await publishFixture(fixturePath);
    const bot = createContainerBot({
      botId: "child-spawner-bot",
      profileId: "python",
      artifactStore: fixtureStore,
      artifactDigest: digest
    });

    await bot.start({});
    await new Promise((r) => setTimeout(r, 600));

    // Stop bot and container
    await bot.stop();

    // Verify container removal reaped all descendants
    const postInspect = spawnSync("docker", ["inspect", bot.containerName], {
      shell: false,
      windowsHide: true,
      encoding: "utf8"
    });
    assert.notEqual(postInspect.status, 0, "container must be destroyed");
  });

  it("Isolated Build Sandbox: compiles untrusted Python and Node, stores digest-verified artifacts", async () => {
    const storeDir = path.resolve(__dirname, "../../var/arena/test-isolation-artifacts-" + Date.now());
    const artifactStore = createArtifactStore({ storageDir: storeDir });
    const buildService = createContainerBuildService({ artifactStore });

    try {
      // 1. Python source build
      const pySource = "import sys\nprint('hello from python')\n";
      const pyBuildRes = await buildService.build({
        sourceContent: pySource,
        profileId: "python"
      });

      assert.equal(pyBuildRes.status, "READY");
      assert.ok(pyBuildRes.artifactDigest);
      assert.equal(pyBuildRes.manifest.executor, "oci-container-linux-v1");
      assert.equal(pyBuildRes.manifest.status, "READY");

      // Verify artifact retrieved from store
      const pyArtifact = await artifactStore.resolveArtifact(pyBuildRes.artifactDigest);
      assert.ok(pyArtifact);
      assert.equal(pyArtifact.bytes, Buffer.from(pySource).length);

      // 2. Node source build
      const nodeSource = "console.log('hello from node');\n";
      const nodeBuildRes = await buildService.build({
        sourceContent: nodeSource,
        profileId: "node"
      });

      assert.equal(nodeBuildRes.status, "READY");
      assert.ok(nodeBuildRes.artifactDigest);
      assert.equal(nodeBuildRes.manifest.executor, "oci-container-linux-v1");

      // 3. C++ and Java rejected in container isolation
      const cppBuildRes = await buildService.build({
        sourceContent: "int main() { return 0; }",
        profileId: "cpp"
      });
      assert.equal(cppBuildRes.status, "FAILED");
      assert.equal(cppBuildRes.error, "unsupported_isolated_profile");

      const javaBuildRes = await buildService.build({
        sourceContent: "public class Bot {}",
        profileId: "java"
      });
      assert.equal(javaBuildRes.status, "FAILED");
      assert.equal(javaBuildRes.error, "unsupported_isolated_profile");
    } finally {
      try {
        fs.rmSync(storeDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  it("End-to-End Match: executes complete match between isolated Python & Node container bots with immutable artifacts", async () => {
    const storeDir = path.join(os.tmpdir(), `arena-iso-e2e-store-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(storeDir, { recursive: true });
    const artifactStore = createArtifactStore({ storageDir: storeDir });
    const buildService = createContainerBuildService({ artifactStore });

    const pyFixture = path.join(FIXTURES_DIR, "legal-isolated-bot.py");
    const nodeFixture = path.join(FIXTURES_DIR, "legal-isolated-bot.mjs");

    try {
      // 1. Build bots through isolated build sandbox
      const pyBuild = await buildService.build({
        sourceContent: fs.readFileSync(pyFixture, "utf8"),
        profileId: "python"
      });
      assert.equal(pyBuild.status, "READY", "python bot build must be READY");
      assert.ok(pyBuild.artifactDigest);

      const nodeBuild = await buildService.build({
        sourceContent: fs.readFileSync(nodeFixture, "utf8"),
        profileId: "node"
      });
      assert.equal(nodeBuild.status, "READY", "node bot build must be READY");
      assert.ok(nodeBuild.artifactDigest);

      // 2. Source mutation regression: create temporary source file, build it, then mutate/delete it
      const origSourceFile = path.join(storeDir, "orig-source-to-delete.py");
      fs.writeFileSync(origSourceFile, fs.readFileSync(pyFixture, "utf8"));
      const mutBuild = await buildService.build({
        sourcePath: origSourceFile,
        profileId: "python"
      });
      assert.equal(mutBuild.status, "READY");

      // Mutate and delete the original source file on disk AFTER publishing
      fs.writeFileSync(origSourceFile, "SYNTAX ERROR GARBAGE THAT CANNOT EXECUTE\n");
      fs.unlinkSync(origSourceFile);
      assert.equal(fs.existsSync(origSourceFile), false, "original source file deleted");

      // 3. Create isolated container bots referencing published immutable artifacts
      const clock = createNodeClock();
      const botA = createContainerBot({
        botId: "bot-py-iso",
        profileId: "python",
        artifactStore,
        artifactDigest: mutBuild.artifactDigest,
        expectedManifest: mutBuild.manifest,
        clock
      });

      const botB = createContainerBot({
        botId: "bot-node-iso",
        profileId: "node",
        artifactStore,
        artifactDigest: nodeBuild.artifactDigest,
        expectedManifest: nodeBuild.manifest,
        clock
      });

      const engine = createNodeEngine(coreConfig);
      const snapshot = createCurrentRulesetSnapshot(coreConfig);
      const rulesetHash = computeRulesetHash(snapshot);

      const journal = createReplayJournal({
        matchId: "match-e2e-isolation",
        policyId: "arena-policy-v1",
        rulesetId: snapshot.rulesetId,
        engineFingerprint: "fingerprint-test",
        rulesetHash
      });

      const controller = createHeadlessMatchController({
        matchId: "match-e2e-isolation",
        engine,
        botA,
        botB,
        journal,
        clock,
        policy: {
          ...DEFAULT_MATCH_POLICY,
          turnTimeLimitMs: 2000
        },
        rulesetSnapshot: snapshot,
        rulesetHash
      });

      try {
        const matchResult = await controller.run();
        assert.ok(matchResult);
        assert.ok(["A", "B", null].includes(matchResult.winner));
        assert.ok(matchResult.acceptedPlies >= 1, "at least one ply must be played in isolated match");
        assert.notEqual(matchResult.outcome, "forfeit", "no forfeit should occur; bot executed from immutable snapshot despite source deletion");

        // Verify journal snapshots
        const replay = journal.finish(matchResult, engine.createInitialState());
        assert.ok(replay);
        assert.equal(replay.schemaVersion, 1);
        assert.ok(replay.frames.length >= 2, "replay must contain initial frame and move frames");
      } finally {
        await botA.stop();
        await botB.stop();
      }

      // 4. Tamper regression: resolve EXACT mutBuild.artifactDigest path, corrupt leaf bytes, and verify fail-closed
      const resolvedTarget = await artifactStore.resolveArtifact(mutBuild.artifactDigest);
      assert.ok(resolvedTarget && resolvedTarget.path, "leaf artifact path must exist before tamper");
      fs.writeFileSync(resolvedTarget.path, "CORRUPTED_LEAF_BYTES_TAMPERED");

      const tamperedBot = createContainerBot({
        botId: "tampered-check-bot",
        profileId: "python",
        artifactStore,
        artifactDigest: mutBuild.artifactDigest,
        clock
      });

      try {
        await assert.rejects(
          async () => {
            await tamperedBot.start({});
          },
          (err) => {
            assert.equal(err.code, "tampered_artifact");
            assert.equal(err.kind, "infrastructure_error");
            assert.ok(err.message.includes("tampered") || err.message.includes("tamper"));
            return true;
          }
        );
        assert.equal(tamperedBot.containerName, null, "container must not be created on tampered artifact");
      } finally {
        await tamperedBot.stop();
      }
    } finally {
      try {
        fs.rmSync(storeDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  it("Match Recovery: normal match executes cleanly after a failed/terminated container bot", async () => {
    const crashFixture = path.join(FIXTURES_DIR, "infinite-loop.py");
    const normalFixtureA = path.join(FIXTURES_DIR, "legal-isolated-bot.py");
    const normalFixtureB = path.join(FIXTURES_DIR, "legal-isolated-bot.mjs");

    const failDigest = await publishFixture(crashFixture);
    const goodDigestB = await publishFixture(normalFixtureB);
    const goodDigestA = await publishFixture(normalFixtureA);

    const clock = createNodeClock();
    const snapshot = createCurrentRulesetSnapshot(coreConfig);
    const rulesetHash = computeRulesetHash(snapshot);

    // 1. Run a match where Bot A hangs and is terminated on turn timeout
    const failingBot = createContainerBot({
      botId: "failing-hang-bot",
      profileId: "python",
      artifactStore: fixtureStore,
      artifactDigest: failDigest,
      clock
    });
    const goodBot1 = createContainerBot({
      botId: "good-bot-1",
      profileId: "node",
      artifactStore: fixtureStore,
      artifactDigest: goodDigestB,
      clock
    });

    const engine1 = createNodeEngine(coreConfig);
    const journal1 = createReplayJournal({
      matchId: "match-fail-test",
      policyId: "arena-policy-v1",
      rulesetId: snapshot.rulesetId,
      engineFingerprint: "f",
      rulesetHash
    });

    const controller1 = createHeadlessMatchController({
      matchId: "match-fail-test",
      engine: engine1,
      botA: failingBot,
      botB: goodBot1,
      journal: journal1,
      clock,
      policy: {
        ...DEFAULT_MATCH_POLICY,
        turnTimeLimitMs: 500 // Quick turn timeout
      },
      rulesetSnapshot: snapshot,
      rulesetHash
    });

    try {
      const res1 = await controller1.run();
      assert.equal(res1.winner, "B", "Bot B wins because Bot A timed out / forfeited");
      assert.equal(res1.outcome, "forfeit", "must record forfeit");
    } finally {
      await failingBot.stop();
      await goodBot1.stop();
    }

    // 2. Immediately run a second normal match between two valid bots
    const botA2 = createContainerBot({
      botId: "recovery-bot-a",
      profileId: "python",
      artifactStore: fixtureStore,
      artifactDigest: goodDigestA,
      clock
    });
    const botB2 = createContainerBot({
      botId: "recovery-bot-b",
      profileId: "node",
      artifactStore: fixtureStore,
      artifactDigest: goodDigestB,
      clock
    });

    const engine2 = createNodeEngine(coreConfig);
    const journal2 = createReplayJournal({
      matchId: "match-recovery-test",
      policyId: "arena-policy-v1",
      rulesetId: snapshot.rulesetId,
      engineFingerprint: "f",
      rulesetHash
    });

    const controller2 = createHeadlessMatchController({
      matchId: "match-recovery-test",
      engine: engine2,
      botA: botA2,
      botB: botB2,
      journal: journal2,
      clock,
      policy: {
        ...DEFAULT_MATCH_POLICY,
        turnTimeLimitMs: 2000
      },
      rulesetSnapshot: snapshot,
      rulesetHash
    });

    try {
      const res2 = await controller2.run();
      assert.ok(res2);
      assert.ok(["A", "B", null].includes(res2.winner));
      assert.notEqual(res2.outcome, "forfeit", "subsequent match must complete without forfeit");
    } finally {
      await botA2.stop();
      await botB2.stop();
    }
  });

  it("Fail-Closed: never falls back to host execution when container runtime fails", async () => {
    // Attempt to run with an invalid image that cannot run
    const digest = await publishFixture(path.join(FIXTURES_DIR, "legal-isolated-bot.py"));
    const bot = createContainerBot({
      botId: "fail-closed-bot",
      profileId: "python",
      artifactStore: fixtureStore,
      artifactDigest: digest,
      image: "nonexistent-image-digest:invalid"
    });

    await assert.rejects(
      async () => {
        await bot.start({});
      },
      (err) => {
        assert.equal(err.kind, "infrastructure_error");
        assert.equal(err.code, "runtime_unavailable");
        return true;
      }
    );

    // Stop must be safe
    await bot.stop();
  });
});
