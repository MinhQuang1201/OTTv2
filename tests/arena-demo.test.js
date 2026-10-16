"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const {
  ROOT,
  ENTRYPOINT,
  PINNED_RUNNER_IMAGE,
  PINNED_RUNNER_IMAGE_ID,
  parseOptions,
  buildLaunchSpec,
  defaultDockerPreflight,
  ensurePersistentDirectories,
  run
} = require("../scripts/arena-demo.js");

describe("Arena demo launcher", () => {
  it("builds loopback embedded-worker defaults without secrets or extra processes", () => {
    const { options } = parseOptions(["--skip-docker-preflight"]);
    const spec = buildLaunchSpec(options, { DEMO_TEST: "1" });
    assert.equal(spec.command, process.execPath);
    assert.deepEqual(spec.args, [ENTRYPOINT]);
    assert.equal(spec.options.shell, false);
    assert.equal(spec.options.cwd, ROOT);
    assert.equal(spec.options.env.ARENA_API_HOST, "127.0.0.1");
    assert.equal(spec.options.env.ARENA_LOCAL_DEMO_CONTAINERS, "true");
    assert.equal(spec.options.env.ARENA_TRUSTED_MODE, "false");
    assert.equal(spec.options.env.ARENA_EXTERNAL_WORKER, "false");
    assert.equal(spec.options.env.ARENA_PUBLIC_REGISTRATION, "false");
    assert.match(spec.options.env.ARENA_DB_PATH, /arena-demo[\\/]arena\.db$/);
    assert.equal(spec.options.env.DEMO_TEST, "1");
  });

  it("accepts explicit registration and persistent paths but rejects non-loopback hosts", () => {
    const parsed = parseOptions([
      "--public-registration", "--db", "data/demo.db", "--storage", "data/artifacts",
      "--port", "3011", "--origins", "http://127.0.0.1:4173"
    ]);
    assert.equal(parsed.options.registration, true);
    assert.equal(parsed.options.port, "3011");
    assert.equal(parsed.options.allowedOrigins, "http://127.0.0.1:4173");
    assert.equal(path.basename(parsed.options.dbPath), "demo.db");
    assert.match(parseOptions(["--host", "0.0.0.0"]).error, /loopback/);
  });

  it("rejects invalid port numbers", () => {
    assert.match(parseOptions(["--port", "not-a-number"]).error, /Port must be an integer/);
    assert.match(parseOptions(["--port", "-1"]).error, /Port must be an integer/);
    assert.match(parseOptions(["--port", "70000"]).error, /Port must be an integer/);
  });

  it("rejects wildcard CORS origins", () => {
    assert.match(
      parseOptions(["--origins", "*"]).error,
      /Wildcard CORS origins are forbidden/
    );
    assert.match(
      parseOptions(["--origins", "http://127.0.0.1:3000,*"]).error,
      /Wildcard CORS origins are forbidden/
    );
  });

  it("rejects contradictory ARENA_EXTERNAL_WORKER and ARENA_TRUSTED_MODE environment variables", () => {
    const extErr = parseOptions([], { ARENA_EXTERNAL_WORKER: "true" }).error;
    assert.match(extErr, /ARENA_EXTERNAL_WORKER=true is not supported in demo mode/);

    const trustErr = parseOptions([], { ARENA_TRUSTED_MODE: "true" }).error;
    assert.match(trustErr, /ARENA_TRUSTED_MODE=true contradicts demo container mode/);
  });

  it("does not pull/build Docker and reports preflight blocks before spawning", async () => {
    let spawned = false;
    const code = await run(["--public-registration"], {
      stdout: () => {},
      stderr: (message) => assert.match(message, /BLOCKED/),
      preflight: () => ({ ok: false, message: "Docker daemon is unavailable" }),
      spawn: () => { spawned = true; throw new Error("must not spawn"); }
    });
    assert.equal(code, 1);
    assert.equal(spawned, false);
  });

  it("reports blocked if image is missing or ID mismatches", async () => {
    let spawned = false;
    const codeMissing = await run([], {
      stdout: () => {},
      stderr: (message) => assert.match(message, /pinned Arena runner image.*missing/),
      preflight: () => ({ ok: false, message: `The pinned Arena runner image (${PINNED_RUNNER_IMAGE}) is missing; prepare it explicitly.` }),
      spawn: () => { spawned = true; }
    });
    assert.equal(codeMissing, 1);
    assert.equal(spawned, false);

    const codeMismatch = await run([], {
      stdout: () => {},
      stderr: (message) => assert.match(message, /mismatch/),
      preflight: () => ({ ok: false, message: `Pinned Arena runner image ID mismatch (expected ${PINNED_RUNNER_IMAGE_ID}, got sha256:drift).` }),
      spawn: () => { spawned = true; }
    });
    assert.equal(codeMismatch, 1);
    assert.equal(spawned, false);
  });

  it("detects and reports port conflict without killing existing processes", async () => {
    let spawned = false;
    const code = await run(["--port", "3001"], {
      stdout: () => {},
      stderr: (message) => assert.match(message, /Port 3001 is already in use/),
      preflight: () => ({ ok: true }),
      checkPortFree: () => Promise.resolve({
        free: false,
        message: "Port 3001 is already in use on 127.0.0.1. The demo launcher will not terminate existing services."
      }),
      spawn: () => { spawned = true; }
    });
    assert.equal(code, 1);
    assert.equal(spawned, false);
  });

  it("forwards child exit code and uses shell:false", async () => {
    const child = new EventEmitter();
    child.kill = () => {};
    let spawnArgs;
    const codePromise = run(["--skip-docker-preflight", "--port", "3012"], {
      stdout: () => {},
      stderr: () => {},
      spawn: (...args) => { spawnArgs = args; return child; },
      env: { TEST_ENV: "yes" }
    });
    child.emit("exit", 7, null);
    assert.equal(await codePromise, 7);
    assert.equal(spawnArgs[2].shell, false);
    assert.equal(spawnArgs[0], process.execPath);
  });

  it("forwards SIGINT to child process and cleans up", async () => {
    const child = new EventEmitter();
    let killedWith = null;
    child.kill = (sig) => { killedWith = sig; };
    const codePromise = run(["--skip-docker-preflight", "--port", "3013"], {
      stdout: () => {},
      stderr: () => {},
      spawn: () => child
    });
    process.emit("SIGINT");
    assert.equal(killedWith, "SIGINT");
    child.emit("exit", 0, "SIGINT");
    assert.equal(await codePromise, 0);
  });

  it("escalates to forceful termination when child ignores signal within timeout", async () => {
    const child = new EventEmitter();
    let killedWith = [];
    child.kill = (sig) => { killedWith.push(sig); };
    let stderrLogs = [];
    const codePromise = run(["--skip-docker-preflight", "--port", "3014"], {
      stdout: () => {},
      stderr: (msg) => { stderrLogs.push(msg); },
      spawn: () => child,
      shutdownTimeoutMs: 50
    });
    process.emit("SIGTERM");
    assert.deepEqual(killedWith, ["SIGTERM"]);
    const code = await codePromise;
    assert.equal(code, 1);
    assert.ok(stderrLogs.some((l) => l.includes("escalating to forceful termination")));
  });

  it("creates recursive parent DB directory and storage directory before spawning child", async () => {
    const child = new EventEmitter();
    child.kill = () => {};
    const createdDirs = [];
    let spawned = false;
    const codePromise = run(["--skip-docker-preflight", "--port", "3015", "--db", "var/fresh-test/arena.db", "--storage", "var/fresh-test/artifacts"], {
      stdout: () => {},
      stderr: () => {},
      mkdirSync: (dir, opts) => {
        assert.equal(spawned, false, "directories must be created before spawning child");
        createdDirs.push({ dir: path.normalize(dir), opts });
      },
      spawn: () => {
        spawned = true;
        return child;
      }
    });
    child.emit("exit", 0, null);
    assert.equal(await codePromise, 0);
    assert.equal(spawned, true);
    assert.equal(createdDirs.length, 2);
    assert.equal(createdDirs[0].dir, path.normalize(path.resolve("var/fresh-test")));
    assert.deepEqual(createdDirs[0].opts, { recursive: true });
    assert.equal(createdDirs[1].dir, path.normalize(path.resolve("var/fresh-test/artifacts")));
    assert.deepEqual(createdDirs[1].opts, { recursive: true });
  });

  it("aborts and reports BLOCKED before spawning if creating persistence directories throws", async () => {
    let spawned = false;
    let blockedMsg = null;
    const code = await run(["--skip-docker-preflight", "--port", "3016"], {
      stdout: () => {},
      stderr: (msg) => { blockedMsg = msg; },
      mkdirSync: () => {
        throw new Error("EACCES: permission denied");
      },
      spawn: () => {
        spawned = true;
        throw new Error("must not spawn");
      }
    });
    assert.equal(code, 1);
    assert.equal(spawned, false);
    assert.match(blockedMsg, /BLOCKED: Failed to create persistence directories: EACCES: permission denied/);
  });

  it("handles :memory: dbPath and creates storage directory only", () => {
    const createdDirs = [];
    ensurePersistentDirectories(
      { dbPath: ":memory:", storageDir: "var/mem-storage" },
      { mkdirSync: (dir, opts) => createdDirs.push({ dir: path.normalize(dir), opts }) }
    );
    assert.equal(createdDirs.length, 1);
    assert.equal(createdDirs[0].dir, path.normalize(path.resolve("var/mem-storage")));
  });

  it("real filesystem ensurePersistentDirectories creates nested non-existent directory without deleting existing files", () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "arena-launcher-fs-test-"));
    try {
      const dbTarget = path.join(tmpBase, "deep", "nested", "db", "arena.db");
      const storageTarget = path.join(tmpBase, "deep", "nested", "storage");
      const parentDir = path.dirname(dbTarget);

      assert.equal(fs.existsSync(parentDir), false);
      assert.equal(fs.existsSync(storageTarget), false);

      ensurePersistentDirectories({ dbPath: dbTarget, storageDir: storageTarget });

      assert.equal(fs.existsSync(parentDir), true);
      assert.equal(fs.existsSync(storageTarget), true);

      const canaryFile = path.join(storageTarget, "canary.txt");
      fs.writeFileSync(canaryFile, "data-intact");
      ensurePersistentDirectories({ dbPath: dbTarget, storageDir: storageTarget });
      assert.equal(fs.readFileSync(canaryFile, "utf8"), "data-intact");
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  describe("defaultDockerPreflight unit coverage", () => {
    it("rejects when docker daemon is unavailable", () => {
      const result = defaultDockerPreflight(() => ({ status: 1, stdout: "" }));
      assert.equal(result.ok, false);
      assert.match(result.message, /Docker daemon is unavailable/);
    });

    it("rejects when docker daemon outputs malformed JSON", () => {
      const result = defaultDockerPreflight(() => ({ status: 0, stdout: "not-json" }));
      assert.equal(result.ok, false);
      assert.match(result.message, /Malformed Docker version output/);
    });

    it("rejects when docker daemon server OS is not Linux", () => {
      const result = defaultDockerPreflight((cmd, args) => {
        if (args[0] === "version") {
          return { status: 0, stdout: JSON.stringify({ Server: { Os: "windows" } }) };
        }
        return { status: 0, stdout: "" };
      });
      assert.equal(result.ok, false);
      assert.match(result.message, /must be running Linux containers \(current: windows\)/);
    });

    it("rejects when pinned runner image is missing", () => {
      const result = defaultDockerPreflight((cmd, args) => {
        if (args[0] === "version") {
          return { status: 0, stdout: JSON.stringify({ Server: { Os: "linux" } }) };
        }
        return { status: 1, stdout: "" };
      });
      assert.equal(result.ok, false);
      assert.match(result.message, /pinned Arena runner image.*missing/);
    });

    it("rejects when pinned runner image ID has drifted", () => {
      const result = defaultDockerPreflight((cmd, args) => {
        if (args[0] === "version") {
          return { status: 0, stdout: JSON.stringify({ Server: { Os: "linux" } }) };
        }
        return { status: 0, stdout: "sha256:drifted_digest_here\n" };
      });
      assert.equal(result.ok, false);
      assert.match(result.message, /Pinned Arena runner image ID mismatch/);
    });

    it("accepts when docker daemon is Linux and image ID matches pinned digest", () => {
      const result = defaultDockerPreflight((cmd, args) => {
        if (args[0] === "version") {
          return { status: 0, stdout: JSON.stringify({ Server: { Os: "linux" } }) };
        }
        return { status: 0, stdout: `${PINNED_RUNNER_IMAGE_ID}\n` };
      });
      assert.equal(result.ok, true);
    });
  });
});
