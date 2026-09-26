const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const port = 8791;
const base = `http://127.0.0.1:${port}`;
const probeSecret = "ott-test-probe-local-only";
const WRANGLER_VERSION = "4.141.0";

function startHarness(persistTo) {
  const command = [
    "npx", "--yes", `wrangler@${WRANGLER_VERSION}`, "dev", "--config", "workers/wrangler.test.jsonc", "--local",
    "--persist-to", persistTo, "--ip", "127.0.0.1", "--port", String(port), "--show-interactive-dev-session=false",
  ];
  const child = process.platform === "win32"
    ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command.join(" ")], { cwd: root, stdio: "ignore" })
    : spawn(command[0], command.slice(1), { cwd: root, stdio: "ignore" });
  return child;
}

async function stopHarness(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" }).once("exit", resolve));
  } else {
    child.kill("SIGTERM");
  }
}

async function waitForHarness() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/__test/ready`, { headers: { "x-ott-test-probe-secret": probeSecret } });
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("test Worker did not start");
}

async function testRequest(pathname, options = {}) {
  const headers = { "x-ott-test-probe-secret": probeSecret, ...(options.headers ?? {}) };
  return fetch(`${base}${pathname}`, { ...options, headers });
}

async function issueInitialization(input) {
  const response = await testRequest("/__test/issue-initialization", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function initialize(input) {
  return testRequest("/__test/invoke-initialization", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

async function consumeAttach(input) {
  return testRequest("/__test/consume-attach", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

test("test-only Worker initializes Main through stub.fetch and exposes safe receipt state", async () => {
  const persistTo = fs.mkdtempSync(path.join(os.tmpdir(), "ott-worker-test-"));
  const child = startHarness(persistTo);
  try {
    await waitForHarness();
    const headers = { "content-type": "application/json", "x-ott-test-probe-secret": probeSecret };
    const initialized = await fetch(`${base}/__test/initialize`, { method: "POST", headers, body: JSON.stringify({ roomId: "ott-00000000-0000-4000-8000-000000000001" }) });
    assert.equal(initialized.status, 200);
    const { roomId, nonce } = await initialized.json();
    assert.equal(roomId, "ott-00000000-0000-4000-8000-000000000001");
    assert.equal(typeof nonce, "string");

    const inspected = await fetch(`${base}/__test/inspect?roomId=${encodeURIComponent(roomId)}&nonce=${encodeURIComponent(nonce)}`, { headers });
    assert.equal(inspected.status, 200);
    assert.deepEqual(await inspected.json(), { room: true, receipt: true, nonce: true });

    const denied = await fetch(`${base}/__test/inspect?roomId=${encodeURIComponent(roomId)}&nonce=${encodeURIComponent(nonce)}`);
    assert.equal(denied.status, 404);
  } finally {
    await stopHarness(child);
    fs.rmSync(persistTo, { recursive: true, force: true });
  }
});

test("Game accepts canonical initialization once and rejects replay without changing its receipt", async () => {
  const persistTo = fs.mkdtempSync(path.join(os.tmpdir(), "ott-worker-test-"));
  const child = startHarness(persistTo);
  const roomId = "ott-00000000-0000-4000-8000-000000000002";
  const nonce = "canonical-initialization-nonce-000001";
  try {
    await waitForHarness();
    const payload = {
      allocationId: "00000000-0000-4000-8000-000000000002",
      roomId,
      creatorName: "Alice",
      creatorAttachDeadlineMs: 2_000_000_000_000,
      nonce,
    };
    const issued = await issueInitialization(payload);
    const decoded = JSON.parse(Buffer.from(issued.capability.split(".")[0], "base64url").toString("utf8"));
    assert.deepEqual(decoded, [
      "ott-cap-v1", payload.allocationId, roomId, "game-init", "A",
      decoded[5], decoded[6], nonce,
    ]);
    assert.ok(Number.isInteger(decoded[5]) && Number.isInteger(decoded[6]) && decoded[6] > decoded[5]);

    const first = await initialize({ ...payload, capability: issued.capability });
    assert.equal(first.status, 200);
    const beforeReplay = await testRequest(`/__test/inspect?roomId=${roomId}&nonce=${nonce}`);
    assert.deepEqual(await beforeReplay.json(), { room: true, receipt: true, nonce: true });

    const replay = await initialize({ ...payload, capability: issued.capability });
    assert.equal(replay.status, 403);
    const afterReplay = await testRequest(`/__test/inspect?roomId=${roomId}&nonce=${nonce}`);
    assert.deepEqual(await afterReplay.json(), { room: true, receipt: true, nonce: true });
  } finally {
    await stopHarness(child);
    fs.rmSync(persistTo, { recursive: true, force: true });
  }
});

test("Game accepts a fresh exact initialization retry but rejects conflicting immutable input without consuming its nonce", async () => {
  const persistTo = fs.mkdtempSync(path.join(os.tmpdir(), "ott-worker-test-"));
  const child = startHarness(persistTo);
  const roomId = "ott-00000000-0000-4000-8000-000000000003";
  const basePayload = {
    allocationId: "00000000-0000-4000-8000-000000000003",
    roomId,
    creatorName: "Alice",
    creatorAttachDeadlineMs: 2_000_000_000_000,
  };
  try {
    await waitForHarness();
    const first = await issueInitialization({ ...basePayload, nonce: "initialization-retry-first-000001" });
    assert.equal((await initialize({ ...basePayload, capability: first.capability })).status, 200);

    const retryNonce = "initialization-retry-fresh-000001";
    const retry = await issueInitialization({ ...basePayload, nonce: retryNonce });
    assert.equal((await initialize({ ...basePayload, capability: retry.capability })).status, 200);
    assert.deepEqual(await (await testRequest(`/__test/inspect?roomId=${roomId}&nonce=${retryNonce}`)).json(), {
      room: true, receipt: true, nonce: true,
    });

    const conflictNonce = "initialization-conflict-fresh-01";
    const conflict = await issueInitialization({ ...basePayload, nonce: conflictNonce });
    const rejected = await initialize({ ...basePayload, creatorName: "Mallory", capability: conflict.capability });
    assert.equal(rejected.status, 409);
    assert.deepEqual(await (await testRequest(`/__test/inspect?roomId=${roomId}&nonce=${conflictNonce}`)).json(), {
      room: true, receipt: true, nonce: false,
    });
  } finally {
    await stopHarness(child);
    fs.rmSync(persistTo, { recursive: true, force: true });
  }
});

test("Game rejects wrong-room, expired, and malformed initialization capabilities without persistent mutation", async () => {
  const persistTo = fs.mkdtempSync(path.join(os.tmpdir(), "ott-worker-test-"));
  const child = startHarness(persistTo);
  const roomId = "ott-00000000-0000-4000-8000-000000000004";
  const allocationId = "00000000-0000-4000-8000-000000000004";
  const payload = { allocationId, roomId, creatorName: "Alice", creatorAttachDeadlineMs: 2_000_000_000_000 };
  try {
    await waitForHarness();
    const wrongRoomNonce = "initialization-wrong-room-000001";
    const wrongRoom = await issueInitialization({ ...payload, roomId: "ott-00000000-0000-4000-8000-000000000005", nonce: wrongRoomNonce });
    assert.equal((await initialize({ ...payload, capability: wrongRoom.capability })).status, 403);
    assert.deepEqual(await (await testRequest(`/__test/inspect?roomId=${roomId}&nonce=${wrongRoomNonce}`)).json(), {
      room: false, receipt: false, nonce: false,
    });

    const expiredNonce = "initialization-expired-000000001";
    const expired = await issueInitialization({ ...payload, nonce: expiredNonce, expiresAt: Date.now() - 1 });
    assert.equal((await initialize({ ...payload, capability: expired.capability })).status, 403);
    assert.deepEqual(await (await testRequest(`/__test/inspect?roomId=${roomId}&nonce=${expiredNonce}`)).json(), {
      room: false, receipt: false, nonce: false,
    });

    assert.equal((await initialize({ ...payload, capability: "not-a-capability" })).status, 403);
    assert.deepEqual(await (await testRequest(`/__test/inspect?roomId=${roomId}&nonce=initialization-malformed-000001`)).json(), {
      room: false, receipt: false, nonce: false,
    });
  } finally {
    await stopHarness(child);
    fs.rmSync(persistTo, { recursive: true, force: true });
  }
});

test("parallel fresh initialization capabilities produce one durable room and two consumed nonces", async () => {
  const persistTo = fs.mkdtempSync(path.join(os.tmpdir(), "ott-worker-test-"));
  const child = startHarness(persistTo);
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
    await waitForHarness();
    const [first, second] = await Promise.all([
      issueInitialization({ ...payload, nonce: firstNonce }),
      issueInitialization({ ...payload, nonce: secondNonce }),
    ]);
    const [firstResult, secondResult] = await Promise.all([
      initialize({ ...payload, capability: first.capability }),
      initialize({ ...payload, capability: second.capability }),
    ]);
    assert.deepEqual([firstResult.status, secondResult.status].sort(), [200, 200]);
    assert.deepEqual(await (await testRequest(`/__test/inspect?roomId=${roomId}&nonce=${firstNonce}`)).json(), {
      room: true, receipt: true, nonce: true,
    });
    assert.deepEqual(await (await testRequest(`/__test/inspect?roomId=${roomId}&nonce=${secondNonce}`)).json(), {
      room: true, receipt: true, nonce: true,
    });
  } finally {
    await stopHarness(child);
    fs.rmSync(persistTo, { recursive: true, force: true });
  }
});

test("parallel attach ticket replay allows only one guarded mutation", async () => {
  const persistTo = fs.mkdtempSync(path.join(os.tmpdir(), "ott-worker-test-"));
  const child = startHarness(persistTo);
  const roomId = "ott-00000000-0000-4000-8000-000000000007";
  const allocationId = "00000000-0000-4000-8000-000000000007";
  const initPayload = { allocationId, roomId, creatorName: "Alice", creatorAttachDeadlineMs: 2_000_000_000_000 };
  const nonce = "attach-ticket-nonce-000000000001";
  try {
    await waitForHarness();
    const initialized = await issueInitialization({ ...initPayload, nonce: "attach-initialization-nonce-001" });
    assert.equal((await initialize({ ...initPayload, capability: initialized.capability })).status, 200);

    const ticket = await testRequest("/__test/issue-attach", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allocationId, roomId, nonce }),
    });
    assert.equal(ticket.status, 200);
    const { capability } = await ticket.json();
    const [first, replay] = await Promise.all([
      consumeAttach({ roomId, capability }),
      consumeAttach({ roomId, capability }),
    ]);
    assert.deepEqual([first.status, replay.status].sort(), [200, 403]);
    assert.deepEqual(await (await testRequest(`/__test/inspect?roomId=${roomId}&nonce=${nonce}`)).json(), {
      room: true, receipt: true, nonce: false, attachNonce: true,
    });
  } finally {
    await stopHarness(child);
    fs.rmSync(persistTo, { recursive: true, force: true });
  }
});
