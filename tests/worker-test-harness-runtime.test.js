const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const {
  availablePort,
  readConfiguredPort,
  readWorkerHost,
  workerOrigin,
  wranglerLauncher,
} = require("../config/local-runtime");

const root = path.resolve(__dirname, "..");
const probeSecret = "ott-test-probe-local-only";
const LOG_LIMIT = 32_000;

function appendLog(current, chunk) {
  const combined = current + chunk.toString();
  return combined.length > LOG_LIMIT ? combined.slice(-LOG_LIMIT) : combined;
}

function spawnLocalCommand(command, args, options) {
  if (process.platform !== "win32") return spawn(command, args, options);
  const quote = (value) => {
    const text = String(value);
    return /[\s"&|<>^]/.test(text) ? `"${text.replaceAll('"', '\\"')}"` : text;
  };
  const commandLine = [command, ...args].map((value, index) => index === 0 ? String(value) : quote(value)).join(" ");
  return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", commandLine], options);
}

function spawnHarness({ host, port, persistTo }) {
  const launcher = wranglerLauncher();
  const args = [
    ...launcher.argsPrefix, "dev", "--config", "apps/worker/wrangler.test.jsonc", "--local",
    "--persist-to", persistTo, "--ip", host, "--port", String(port), "--inspector-port", "0",
    "--show-interactive-dev-session=false",
  ];
  const child = spawnLocalCommand(launcher.command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => { output.stdout = appendLog(output.stdout, chunk); });
  child.stderr.on("data", (chunk) => { output.stderr = appendLog(output.stderr, chunk); });
  const exited = new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  return { child, host, port, base: workerOrigin(host, port), output, exited, persistTo };
}

async function stopHarness(harness) {
  if (!harness) return;
  const { child } = harness;
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === "win32") {
      await new Promise((resolve) => spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" }).once("exit", resolve));
    } else {
      child.kill("SIGTERM");
    }
  }
  await harness.exited.catch(() => {});
  if (child.exitCode === null && child.signalCode === null) throw new Error(`Worker harness process ${child.pid} did not stop`);
}

function isBindFailure(error) {
  return /EADDRINUSE|EACCES|WSAEACCES|10013|bind/i.test(error.message);
}

async function startHarness(persistRoot) {
  const host = readWorkerHost();
  const fixedPort = readConfiguredPort(process.env.OTT_WORKER_PORT);
  let lastError;
  for (let attempt = 0; attempt < (fixedPort ? 1 : 3); attempt += 1) {
    const port = fixedPort ?? await availablePort(host);
    const persistTo = path.join(persistRoot, `attempt-${attempt + 1}`);
    fs.mkdirSync(persistTo, { recursive: true });
    const harness = spawnHarness({ host, port, persistTo });
    try {
      await waitForHarness(harness);
      return harness;
    } catch (error) {
      lastError = error;
      await stopHarness(harness);
      fs.rmSync(persistTo, { recursive: true, force: true });
      if (fixedPort || !isBindFailure(error)) throw error;
    }
  }
  throw lastError;
}

async function waitForHarness(harness) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (harness.child.exitCode !== null || harness.child.signalCode !== null) {
      const exit = await harness.exited.catch((error) => ({ error: error.message }));
      throw new Error(`test Worker did not start. Exit: ${JSON.stringify(exit)}\nstdout:\n${harness.output.stdout}\nstderr:\n${harness.output.stderr}`);
    }
    try {
      const response = await fetch(`${harness.base}/__test/ready`, { headers: { "x-ott-test-probe-secret": probeSecret } });
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`test Worker did not start\nstdout:\n${harness.output.stdout}\nstderr:\n${harness.output.stderr}`);
}

async function testRequest(harness, pathname, options = {}) {
  const headers = { "x-ott-test-probe-secret": probeSecret, ...(options.headers ?? {}) };
  return fetch(`${harness.base}${pathname}`, { ...options, headers });
}

async function issueInitialization(harness, input) {
  const response = await testRequest(harness, "/__test/issue-initialization", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function initialize(harness, input) {
  return testRequest(harness, "/__test/invoke-initialization", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

async function consumeAttach(harness, input) {
  return testRequest(harness, "/__test/consume-attach", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

test("test-only Worker initializes Main through stub.fetch and exposes safe receipt state", async () => {
  const persistTo = fs.mkdtempSync(path.join(os.tmpdir(), "ott-worker-test-"));
  const child = await startHarness(persistTo);
  try {
    await waitForHarness(child);
    const headers = { "content-type": "application/json", "x-ott-test-probe-secret": probeSecret };
    const initialized = await fetch(`${child.base}/__test/initialize`, { method: "POST", headers, body: JSON.stringify({ roomId: "ott-00000000-0000-4000-8000-000000000001" }) });
    assert.equal(initialized.status, 200);
    const { roomId, nonce } = await initialized.json();
    assert.equal(roomId, "ott-00000000-0000-4000-8000-000000000001");
    assert.equal(typeof nonce, "string");

    const inspected = await fetch(`${child.base}/__test/inspect?roomId=${encodeURIComponent(roomId)}&nonce=${encodeURIComponent(nonce)}`, { headers });
    assert.equal(inspected.status, 200);
    assert.deepEqual(await inspected.json(), { room: true, receipt: true, nonce: true, attachNonce: false });

    const denied = await fetch(`${child.base}/__test/inspect?roomId=${encodeURIComponent(roomId)}&nonce=${encodeURIComponent(nonce)}`);
    assert.equal(denied.status, 404);
  } finally {
    await stopHarness(child);
    fs.rmSync(persistTo, { recursive: true, force: true });
  }
});

test("Game accepts canonical initialization once and rejects replay without changing its receipt", async () => {
  const persistTo = fs.mkdtempSync(path.join(os.tmpdir(), "ott-worker-test-"));
  const child = await startHarness(persistTo);
  const roomId = "ott-00000000-0000-4000-8000-000000000002";
  const nonce = "canonical-initialization-nonce-000001";
  try {
    await waitForHarness(child);
    const payload = {
      allocationId: "00000000-0000-4000-8000-000000000002",
      roomId,
      creatorName: "Alice",
      creatorAttachDeadlineMs: 2_000_000_000_000,
      nonce,
    };
    const issued = await issueInitialization(child, payload);
    const decoded = JSON.parse(Buffer.from(issued.capability.split(".")[0], "base64url").toString("utf8"));
    assert.deepEqual(decoded, [
      "ott-cap-v1", payload.allocationId, roomId, "game-init", "A",
      decoded[5], decoded[6], nonce,
    ]);
    assert.ok(Number.isInteger(decoded[5]) && Number.isInteger(decoded[6]) && decoded[6] > decoded[5]);

    const first = await initialize(child, { ...payload, capability: issued.capability });
    assert.equal(first.status, 200);
    const beforeReplay = await testRequest(child, `/__test/inspect?roomId=${roomId}&nonce=${nonce}`);
    assert.deepEqual(await beforeReplay.json(), { room: true, receipt: true, nonce: true, attachNonce: false });

    const replay = await initialize(child, { ...payload, capability: issued.capability });
    assert.equal(replay.status, 403);
    const afterReplay = await testRequest(child, `/__test/inspect?roomId=${roomId}&nonce=${nonce}`);
    assert.deepEqual(await afterReplay.json(), { room: true, receipt: true, nonce: true, attachNonce: false });
  } finally {
    await stopHarness(child);
    fs.rmSync(persistTo, { recursive: true, force: true });
  }
});

test("Game accepts a fresh exact initialization retry but rejects conflicting immutable input without consuming its nonce", async () => {
  const persistTo = fs.mkdtempSync(path.join(os.tmpdir(), "ott-worker-test-"));
  const child = await startHarness(persistTo);
  const roomId = "ott-00000000-0000-4000-8000-000000000003";
  const basePayload = {
    allocationId: "00000000-0000-4000-8000-000000000003",
    roomId,
    creatorName: "Alice",
    creatorAttachDeadlineMs: 2_000_000_000_000,
  };
  try {
    await waitForHarness(child);
    const first = await issueInitialization(child, { ...basePayload, nonce: "initialization-retry-first-000001" });
    assert.equal((await initialize(child, { ...basePayload, capability: first.capability })).status, 200);

    const retryNonce = "initialization-retry-fresh-000001";
    const retry = await issueInitialization(child, { ...basePayload, nonce: retryNonce });
    assert.equal((await initialize(child, { ...basePayload, capability: retry.capability })).status, 200);
    assert.deepEqual(await (await testRequest(child, `/__test/inspect?roomId=${roomId}&nonce=${retryNonce}`)).json(), {
      room: true, receipt: true, nonce: true, attachNonce: false,
    });

    const conflictNonce = "initialization-conflict-fresh-01";
    const conflict = await issueInitialization(child, { ...basePayload, nonce: conflictNonce });
    const rejected = await initialize(child, { ...basePayload, creatorName: "Mallory", capability: conflict.capability });
    assert.equal(rejected.status, 409);
    assert.deepEqual(await (await testRequest(child, `/__test/inspect?roomId=${roomId}&nonce=${conflictNonce}`)).json(), {
      room: true, receipt: true, nonce: false, attachNonce: false,
    });
  } finally {
    await stopHarness(child);
    fs.rmSync(persistTo, { recursive: true, force: true });
  }
});

test("Game rejects wrong-room, expired, and malformed initialization capabilities without persistent mutation", async () => {
  const persistTo = fs.mkdtempSync(path.join(os.tmpdir(), "ott-worker-test-"));
  const child = await startHarness(persistTo);
  const roomId = "ott-00000000-0000-4000-8000-000000000004";
  const allocationId = "00000000-0000-4000-8000-000000000004";
  const payload = { allocationId, roomId, creatorName: "Alice", creatorAttachDeadlineMs: 2_000_000_000_000 };
  try {
    await waitForHarness(child);
    const wrongRoomNonce = "initialization-wrong-room-000001";
    const wrongRoom = await issueInitialization(child, { ...payload, roomId: "ott-00000000-0000-4000-8000-000000000005", nonce: wrongRoomNonce });
    assert.equal((await initialize(child, { ...payload, capability: wrongRoom.capability })).status, 403);
    assert.deepEqual(await (await testRequest(child, `/__test/inspect?roomId=${roomId}&nonce=${wrongRoomNonce}`)).json(), {
      room: false, receipt: false, nonce: false, attachNonce: false,
    });

    const expiredNonce = "initialization-expired-000000001";
    const expired = await issueInitialization(child, { ...payload, nonce: expiredNonce, expiresAt: Date.now() - 1 });
    assert.equal((await initialize(child, { ...payload, capability: expired.capability })).status, 403);
    assert.deepEqual(await (await testRequest(child, `/__test/inspect?roomId=${roomId}&nonce=${expiredNonce}`)).json(), {
      room: false, receipt: false, nonce: false, attachNonce: false,
    });

    assert.equal((await initialize(child, { ...payload, capability: "not-a-capability" })).status, 403);
    assert.deepEqual(await (await testRequest(child, `/__test/inspect?roomId=${roomId}&nonce=initialization-malformed-000001`)).json(), {
      room: false, receipt: false, nonce: false, attachNonce: false,
    });
  } finally {
    await stopHarness(child);
    fs.rmSync(persistTo, { recursive: true, force: true });
  }
});

test("parallel fresh initialization capabilities produce one durable room and two consumed nonces", async () => {
  const persistTo = fs.mkdtempSync(path.join(os.tmpdir(), "ott-worker-test-"));
  const child = await startHarness(persistTo);
  const roomId = "ott-00000000-0000-4000-8000-000000000006";
  const payload = {
    allocationId: "00000000-0000-4000-8000-000000000006",
    roomId,
    creatorName: "Alice",
    creatorAttachDeadlineMs: 2_000_000_000_000,
  };
  const firstNonce = "initialization-parallel-first-0001";
  const secondNonce = "initialization-parallel-second-001";
  try {
    await waitForHarness(child);
    const [first, second] = await Promise.all([
      issueInitialization(child, { ...payload, nonce: firstNonce }),
      issueInitialization(child, { ...payload, nonce: secondNonce }),
    ]);
    const [firstResult, secondResult] = await Promise.all([
      initialize(child, { ...payload, capability: first.capability }),
      initialize(child, { ...payload, capability: second.capability }),
    ]);
    assert.deepEqual([firstResult.status, secondResult.status].sort(), [200, 200]);
    assert.deepEqual(await (await testRequest(child, `/__test/inspect?roomId=${roomId}&nonce=${firstNonce}`)).json(), {
      room: true, receipt: true, nonce: true, attachNonce: false,
    });
    assert.deepEqual(await (await testRequest(child, `/__test/inspect?roomId=${roomId}&nonce=${secondNonce}`)).json(), {
      room: true, receipt: true, nonce: true, attachNonce: false,
    });
  } finally {
    await stopHarness(child);
    fs.rmSync(persistTo, { recursive: true, force: true });
  }
});

test("parallel attach ticket replay allows only one guarded mutation", async () => {
  const persistTo = fs.mkdtempSync(path.join(os.tmpdir(), "ott-worker-test-"));
  const child = await startHarness(persistTo);
  const roomId = "ott-00000000-0000-4000-8000-000000000007";
  const allocationId = "00000000-0000-4000-8000-000000000007";
  const initPayload = { allocationId, roomId, creatorName: "Alice", creatorAttachDeadlineMs: 2_000_000_000_000 };
  const nonce = "attach-ticket-nonce-000000000001";
  try {
    await waitForHarness(child);
    const initialized = await issueInitialization(child, { ...initPayload, nonce: "attach-initialization-nonce-001" });
    assert.equal((await initialize(child, { ...initPayload, capability: initialized.capability })).status, 200);

    const ticket = await testRequest(child, "/__test/issue-attach", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allocationId, roomId, nonce }),
    });
    assert.equal(ticket.status, 200);
    const { capability } = await ticket.json();
    const [first, replay] = await Promise.all([
      consumeAttach(child, { roomId, capability }),
      consumeAttach(child, { roomId, capability }),
    ]);
    assert.deepEqual([first.status, replay.status].sort(), [200, 403]);
    assert.deepEqual(await (await testRequest(child, `/__test/inspect?roomId=${roomId}&nonce=${nonce}`)).json(), {
      room: true, receipt: true, nonce: false, attachNonce: true,
    });
  } finally {
    await stopHarness(child);
    fs.rmSync(persistTo, { recursive: true, force: true });
  }
});
