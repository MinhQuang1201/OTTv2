const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { buildWranglerArgs, main, spawnLocalCommand } = require("../scripts/worker-dev");

test("worker dev builds local Wrangler arguments", () => {
  const args = buildWranglerArgs(8900, ["--env", "test"]);
  assert.deepEqual(args.slice(0, 2), ["--no-install", "wrangler"]);
  assert.ok(args.includes("--config") && args.includes("apps/worker/wrangler.jsonc"));
  assert.ok(args.includes("--local"));
  assert.ok(args.includes("--ip") && args.includes("127.0.0.1"));
  assert.ok(args.includes("--port") && args.includes("8900"));
  assert.ok(args.includes("--inspector-port") && args.includes("0"));
  assert.deepEqual(args.slice(-2), ["--env", "test"]);
});

function fakeChild() {
  const child = new EventEmitter();
  child.kill = () => true;
  return child;
}

test("worker dev returns Wrangler exit code", async () => {
  const child = fakeChild();
  const result = main({ spawnProcess: () => {
    setImmediate(() => child.emit("exit", 7, null));
    return child;
  } });
  assert.equal(await result, 7);
});

test("worker dev reports child startup errors", async () => {
  const child = fakeChild();
  const result = main({ spawnProcess: () => {
    setImmediate(() => child.emit("error", new Error("spawn failed")));
    return child;
  } });
  await assert.rejects(result, /spawn failed/);
});

test("spawnLocalCommand quotes executable with spaces and applies outer quotes on Windows", () => {
  let capturedCmd, capturedArgs, capturedOpts;
  const mockSpawn = (cmd, args, opts) => {
    capturedCmd = cmd;
    capturedArgs = args;
    capturedOpts = opts;
    return fakeChild();
  };

  const command = "C:\\Program Files\\nodejs\\npx.cmd";
  const args = ["wrangler", "dev", "--port", "8900"];

  spawnLocalCommand(command, args, {}, mockSpawn);

  if (process.platform === "win32") {
    assert.equal(capturedCmd, process.env.ComSpec || "cmd.exe");
    assert.equal(capturedOpts?.windowsVerbatimArguments, true);
    assert.ok(
      capturedArgs[3].startsWith('""C:\\Program Files\\nodejs\\npx.cmd"') && capturedArgs[3].endsWith('"'),
      `Command line must have outer quotes for cmd.exe /s /c: ${capturedArgs[3]}`
    );
  } else {
    assert.equal(capturedCmd, command);
    assert.deepEqual(capturedArgs, args);
  }
});

test("spawnLocalCommand executes spaced executable fixture under cmd.exe without Wrangler", async () => {
  const fs = require("node:fs/promises");
  const os = require("node:os");
  const path = require("node:path");
  const { spawn } = require("node:child_process");

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ott test space-"));
  const isWin = process.platform === "win32";
  const scriptName = isWin ? "spaced tool.cmd" : "spaced tool.sh";
  const scriptPath = path.join(tempDir, scriptName);

  if (isWin) {
    await fs.writeFile(scriptPath, "@echo off\r\necho FIXTURE_OK\r\nexit 42\r\n");
  } else {
    await fs.writeFile(scriptPath, "#!/bin/sh\necho FIXTURE_OK\nexit 42\n", { mode: 0o755 });
  }

  try {
    const child = spawnLocalCommand(scriptPath, ["arg1", "spaced arg"], { stdio: "pipe" }, spawn);
    let stdout = "";
    child.stdout?.on("data", (d) => { stdout += d; });

    const exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code));
    });

    assert.equal(exitCode, 42, "Real execution with spaced executable path must exit with 42");
    assert.match(stdout, /FIXTURE_OK/, "Must capture standard output from fixture");
  } finally {
    await fs.unlink(scriptPath).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
