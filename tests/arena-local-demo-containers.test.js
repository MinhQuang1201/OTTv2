"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

describe("Arena local demo container execution", () => {
  it("loads an explicit opt-in local container mode without changing trusted defaults", async () => {
    const { loadConfig } = await import("../apps/arena-api/src/config.mjs");

    const trusted = loadConfig({});
    assert.equal(trusted.localDemoContainers, false);
    assert.equal(trusted.trustedMode, true);

    const demo = loadConfig({ localDemoContainers: true });
    assert.equal(demo.localDemoContainers, true);
    assert.equal(demo.bind, "127.0.0.1");
    assert.equal(demo.trustedMode, false);
    assert.throws(
      () => loadConfig({ localDemoContainers: true, trustedMode: true }),
      /cannot be combined with trustedMode/
    );
  });

  it("builds a container bot factory only for supported profiles", async () => {
    const { createProfileBotFactory } = await import("../packages/arena-node/src/worker/job-worker.mjs");
    const { PINNED_RUNNER_IMAGE } = await import("../packages/arena-node/src/execution/container-executor.mjs");

    const artifactStore = { resolveArtifact: async () => Buffer.from("print(1)\n") };
    const profileRegistry = { getProfile: (id) => ({ id, language: id === "node" ? "javascript" : id }) };
    const factory = createProfileBotFactory({
      artifactStore,
      profileRegistry,
      containerExecutor: {
        image: PINNED_RUNNER_IMAGE,
        probe: () => ({ available: true, imageId: "pinned" })
      }
    });

    const bot = await factory("A", {
      bot_id: "demo-bot",
      profile_id: "python",
      artifact_digest: "sha256:demo"
    });
    assert.equal(bot.botId, "demo-bot");

    await assert.rejects(
      () => factory("A", { profile_id: "cpp", artifact_digest: "sha256:demo" }),
      (err) => err.code === "unsupported_isolated_profile"
    );
  });

  it("rejects the container bot factory when the local runtime is unavailable", async () => {
    const { createProfileBotFactory } = await import("../packages/arena-node/src/worker/job-worker.mjs");

    const factory = createProfileBotFactory({
      artifactStore: { resolveArtifact: async () => Buffer.from("print(1)\n") },
      profileRegistry: { getProfile: () => ({ id: "python", language: "python" }) },
      containerExecutor: {
        probe: () => ({ available: false, reason: "docker_daemon_unavailable" })
      }
    });

    await assert.rejects(
      () => factory("A", { profile_id: "python", artifact_digest: "sha256:demo" }),
      (err) => err.code === "runtime_unavailable"
    );
  });

  it("fails closed in the container build service when Docker is unavailable", async () => {
    const { createContainerBuildService } = await import("../packages/arena-node/src/execution/container-executor.mjs");
    const service = createContainerBuildService({
      artifactStore: { storeArtifact: async () => {} },
      probe: () => ({ available: false, reason: "image_digest_drift" })
    });

    const result = await service.build({ sourceContent: "print(1)\n", profileId: "python" });
    assert.equal(result.status, "FAILED");
    assert.equal(result.error, "runtime_unavailable");
  });

  it("does not accept contradictory local-demo and trusted HTTP server configuration", async () => {
    const { openDatabase, closeDatabase } = await import("../packages/arena-node/src/persistence/sqlite-database.mjs");
    const { createArenaServer } = await import("../apps/arena-api/src/http-server.mjs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-local-demo-config-test-"));
    const { db } = openDatabase(path.join(dir, "arena.db"));
    try {
      assert.throws(
        () => createArenaServer({ db, localDemoContainers: true, trustedMode: true }),
        /cannot be combined with trustedMode/
      );
    } finally {
      closeDatabase(db);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("probes Docker before returning a cached READY container build", async () => {
    const { createContainerBuildService, PINNED_RUNNER_IMAGE_ID } = await import("../packages/arena-node/src/execution/container-executor.mjs");
    const { EventEmitter } = require("node:events");
    const { PassThrough } = require("node:stream");
    let available = true;
    const artifactStore = {
      artifacts: new Map(),
      async storeArtifact(kind, content) {
        const digest = `sha256:${require("node:crypto").createHash("sha256").update(content).digest("hex")}`;
        const record = { digest, kind, path: path.join(os.tmpdir(), `arena-cache-${Date.now()}`), bytes: content.length };
        this.artifacts.set(digest, record);
        return record;
      },
      async resolveArtifact(digest) { return this.artifacts.get(digest) || null; }
    };
    const runner = {
      spawnSync(_cmd, args) {
        if (args.includes("version")) {
          return { status: 0, stdout: JSON.stringify({ Server: { Os: "linux", Version: "28.0", Arch: "amd64" } }) };
        }
        if (args.includes("inspect")) return { status: 0, stdout: PINNED_RUNNER_IMAGE_ID };
        return { status: 0, stdout: "" };
      },
      spawn() {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        process.nextTick(() => {
          child.stdout.end("\n");
          child.stderr.end();
          child.emit("close", 0, null);
        });
        return child;
      }
    };
    const service = createContainerBuildService({
      artifactStore,
      commandRunner: runner,
      probe: () => available ? { available: true, imageId: PINNED_RUNNER_IMAGE_ID } : { available: false, reason: "image_digest_drift" }
    });
    const first = await service.build({ sourceContent: "print(1)\n", profileId: "python" });
    assert.equal(first.status, "READY");
    available = false;
    const second = await service.build({ sourceContent: "print(1)\n", profileId: "python" });
    assert.equal(second.status, "FAILED");
    assert.equal(second.error, "runtime_unavailable");
  });

  it("reports local Docker acceptance separately and permits an authenticated author to submit source", async () => {
    const { openDatabase, closeDatabase } = await import("../packages/arena-node/src/persistence/sqlite-database.mjs");
    const { createArenaServer } = await import("../apps/arena-api/src/http-server.mjs");
    const { hashPassword, createSession } = await import("../apps/arena-api/src/auth/accounts.mjs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-local-demo-test-"));
    const { db } = openDatabase(path.join(dir, "arena.db"));
    const passwordHash = hashPassword("DemoPass123!");
    db.prepare("INSERT INTO users (id, normalized_username, password_hash, role, status) VALUES (?, ?, ?, ?, ?)").run(
      "demo-author", "demo-author", passwordHash, "author", "active"
    );
    const token = createSession(db, "demo-author").token;
    const server = createArenaServer({
      db,
      trustedMode: false,
      localDemoContainers: true,
      executionCapabilities: {
        available: true,
        verified: false,
        imageId: "sha256:pinned",
        supportedProfiles: ["python", "node"],
        unsupportedProfiles: ["cpp", "java"]
      },
      profileRegistry: { listProfiles: () => [{ id: "python" }, { id: "node" }] }
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const request = (pathname) => new Promise((resolve, reject) => {
        const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: pathname, headers: { Authorization: `Bearer ${token}` } }, (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
        });
        req.on("error", reject);
        req.end();
      });
      const capabilities = await request("/api/arena/v1/capabilities");
      assert.equal(capabilities.trusted, false);
      assert.equal(capabilities.untrusted, true);
      assert.equal(capabilities.canSubmitSource, true);
      assert.equal(capabilities.localDocker.verified, false);
      const me = await request("/api/arena/v1/me");
      assert.equal(me.user.role, "author");
      assert.equal(me.canSubmitSource, true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      closeDatabase(db);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshes local runtime availability after startup without probing unrelated requests", async () => {
    const { openDatabase, closeDatabase } = await import("../packages/arena-node/src/persistence/sqlite-database.mjs");
    const { createArenaServer } = await import("../apps/arena-api/src/http-server.mjs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-local-demo-transition-test-"));
    const { db } = openDatabase(path.join(dir, "arena.db"));
    const passwordHash = (await import("../apps/arena-api/src/auth/accounts.mjs")).hashPassword("DemoPass123!");
    db.prepare("INSERT INTO users (id, normalized_username, password_hash, role, status) VALUES (?, ?, ?, ?, ?)").run(
      "transition-author", "transition-author", passwordHash, "author", "active"
    );
    const token = (await import("../apps/arena-api/src/auth/accounts.mjs")).createSession(db, "transition-author").token;
    let available = true;
    let probeCalls = 0;
    const server = createArenaServer({
      db,
      trustedMode: false,
      localDemoContainers: true,
      executionCapabilities: { available: true, imageId: "sha256:startup" },
      getExecutionCapabilities: () => {
        probeCalls += 1;
        return available
          ? { available: true, imageId: "sha256:current" }
          : { available: false, reason: "docker_daemon_unavailable" };
      },
      profileRegistry: { listProfiles: () => [{ id: "python" }, { id: "node" }] }
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const request = (pathname) => new Promise((resolve, reject) => {
        const req = http.request({
          hostname: "127.0.0.1",
          port: server.address().port,
          path: pathname,
          headers: { Authorization: `Bearer ${token}` }
        }, (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve({ statusCode: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
        });
        req.on("error", reject);
        req.end();
      });

      const initial = await request("/api/arena/v1/capabilities");
      assert.equal(initial.body.untrusted, true);
      assert.equal(initial.body.localDocker.imageId, "sha256:current");
      assert.equal(probeCalls, 1);

      available = false;
      const me = await request("/api/arena/v1/me");
      assert.equal(me.body.canSubmitSource, false);
      assert.equal(probeCalls, 2);

      const unrelated = await request("/api/arena/v1/leaderboard?ladderId=demo");
      assert.equal(unrelated.statusCode, 200);
      assert.equal(probeCalls, 2);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      closeDatabase(db);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
