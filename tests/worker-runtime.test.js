const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const WebSocket = require("ws");
const test = require("node:test");
const rules = require("../rules");

const root = path.resolve(__dirname, "..");
const port = Number(process.env.OTT_WORKER_PORT || 8787);
const base = `http://127.0.0.1:${port}`;

const WRANGLER_VERSION = "4.141.0";
const STARTUP_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;
const LOG_LIMIT = 32_000;

function runtimeLog(message) {
  process.stderr.write(`[worker-runtime ${new Date().toISOString()}] ${message}\n`);
}

function appendLog(current, chunk) {
  const combined = current + chunk.toString();
  return combined.length > LOG_LIMIT ? combined.slice(-LOG_LIMIT) : combined;
}

function withTimeout(operation, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function assertPortIsFree() {
  return new Promise((resolve, reject) => {
    const probe = net.createConnection({ host: "127.0.0.1", port });
    probe.once("connect", () => {
      probe.destroy();
      reject(new Error(`Worker runtime port ${port} is already in use; stop the existing process before running this harness`));
    });
    probe.once("error", (error) => {
      if (error.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
  });
}

function startWorker() {
  const envFile = path.join(root, ".dev.vars");
  fs.mkdirSync(path.join(root, ".wrangler"), { recursive: true });
  const persistTo = fs.mkdtempSync(path.join(root, ".wrangler", "worker-runtime-"));
  const command = [
    "npx", "--yes", `wrangler@${WRANGLER_VERSION}`, "dev", "--config", "workers/wrangler.jsonc", "--env", "test", "--local",
    "--env-file", envFile, "--persist-to", persistTo, "--ip", "127.0.0.1", "--port", String(port), "--show-interactive-dev-session=false",
  ];
  runtimeLog(`spawn: ${command.join(" ")}`);
  const child = process.platform === "win32"
    ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command.join(" ")], { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
    : spawn(command[0], command.slice(1), { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => { output.stdout = appendLog(output.stdout, chunk); });
  child.stderr.on("data", (chunk) => { output.stderr = appendLog(output.stderr, chunk); });
  const exited = new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  return { child, exited, output, persistTo };
}

async function stopWorker(worker) {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  runtimeLog(`cleanup: stopping Wrangler process ${worker.child.pid}`);
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(worker.child.pid), "/t", "/f"], { stdio: "ignore" });
    await new Promise((resolve) => killer.once("exit", resolve));
  } else {
    worker.child.kill("SIGTERM");
  }
  await withTimeout(worker.exited, REQUEST_TIMEOUT_MS, "Wrangler cleanup").catch(() => {
    worker.child.kill("SIGKILL");
  });
  fs.rmSync(worker.persistTo, { recursive: true, force: true });
}

async function control(action, body = {}) {
  const response = await withTimeout(fetch(`${base}/control/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), REQUEST_TIMEOUT_MS, `control/${action}`);
  const text = await response.text();
  let responseBody;
  try {
    responseBody = JSON.parse(text);
  } catch {
    throw new Error(`control/${action} returned HTTP ${response.status} ${response.statusText} with ${response.headers.get("content-type") ?? "unknown content type"}: ${text.slice(0, 2_000)}`);
  }
  runtimeLog(`control/${action}: HTTP ${response.status}${typeof responseBody?.error === "string" ? ` error=${responseBody.error}` : ""}`);
  return { response, body: responseBody };
}

async function connectRoom(roomId) {
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/parties/main/${roomId}`);
  await withTimeout(new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  }), REQUEST_TIMEOUT_MS, "room WebSocket upgrade");
  return socket;
}

function nextOttMessage(socket, predicate, label = "OTT message") {
  return withTimeout(new Promise((resolve, reject) => {
    const onMessage = (data) => {
      const value = data.toString();
      if (!value.startsWith("__YPS:")) return;
      try {
        const parsed = JSON.parse(value.slice("__YPS:".length));
        if (parsed.__ott && predicate(parsed)) {
          socket.off("message", onMessage);
          resolve(parsed);
        }
      } catch {}
    };
    socket.on("message", onMessage);
    socket.once("error", reject);
  }), REQUEST_TIMEOUT_MS, label);
}

function sendOtt(socket, command) {
  const messages = [];
  const received = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for OTT response")), REQUEST_TIMEOUT_MS);
    socket.on("message", (data) => {
      const value = data.toString();
      if (!value.startsWith("__YPS:")) return;
      try {
        const parsed = JSON.parse(value.slice("__YPS:".length));
        if (parsed.__ott) {
          messages.push(parsed);
          if (parsed.type === "ott:error" || parsed.type === "ott:state") {
            clearTimeout(timer);
            resolve(parsed);
          }
        }
      } catch {}
    });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  socket.send(`__YPS:${JSON.stringify(command)}`);
  return received.then((first) => ({ first, messages }));
}

async function waitForHttp(worker) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      // Use a route that cannot mutate the Lobby rate-limit state before scenarios begin.
      const response = await withTimeout(fetch(`${base}/__worker_runtime_ready__`), REQUEST_TIMEOUT_MS, "readiness request");
      if (response.status === 404) {
        runtimeLog(`ready: HTTP ${response.status} after ${attempt} attempts`);
        return;
      }
      runtimeLog(`readiness: attempt ${attempt} returned HTTP ${response.status}`);
    } catch (error) {
      runtimeLog(`readiness: attempt ${attempt} failed: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const exited = await Promise.race([
    worker.exited,
    new Promise((resolve) => setTimeout(() => resolve(null), 0)),
  ]);
  throw new Error(`Worker HTTP endpoint did not become reachable. Exit: ${JSON.stringify(exited)}\nstdout:\n${worker.output.stdout}\nstderr:\n${worker.output.stderr}`);
}

test("real Wrangler local runtime confirms control create initializes a room", async (t) => {
  const vars = path.join(root, ".dev.vars");
  if (!fs.existsSync(vars)) {
    t.skip("NOT RUN: .dev.vars is absent; create it locally with OTT_INTERNAL_SECRET for the approved smoke");
    return;
  }

  await assertPortIsFree();
  const worker = startWorker();
  try {
    await waitForHttp(worker);

    runtimeLog("scenario: control/create");
    const created = await control("create", { name: "<b>Alice</b>" });
    assert.equal(created.response.status, 200);
    assert.equal(created.body.seat, "A");
    assert.match(created.body.room, /^ott-/);
    assert.equal(typeof created.body.ticket, "string");
    assert.equal(JSON.stringify(created.body).includes("OTT_INTERNAL_SECRET"), false);

    const uppercaseRoom = await fetch(`${base}/parties/main/${created.body.room.toUpperCase()}`);
    assert.equal(uppercaseRoom.status, 404, "uppercase room paths must be rejected before PartyServer dispatch");
    const trailingSlash = await fetch(`${base}/parties/main/${created.body.room}/`);
    assert.equal(trailingSlash.status, 404, "noncanonical trailing-slash room paths must be rejected");

    runtimeLog("scenario: complete");
  } finally {
    await stopWorker(worker);
    runtimeLog(`Wrangler stdout:\n${worker.output.stdout || "(empty)"}`);
    runtimeLog(`Wrangler stderr:\n${worker.output.stderr || "(empty)"}`);
  }
});

test("parallel control creates expose only fully initialized waiting allocations", async (t) => {
  const vars = path.join(root, ".dev.vars");
  if (!fs.existsSync(vars)) {
    t.skip("NOT RUN: .dev.vars is absent; create it locally with OTT_INTERNAL_SECRET for the approved smoke");
    return;
  }

  await assertPortIsFree();
  const worker = startWorker();
  try {
    await waitForHttp(worker);

    const first = await control("create", { name: "Alice" });
    assert.equal(first.response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 45));

    const [second, third] = await Promise.all([
      control("create", { name: "Bob" }),
      control("create", { name: "Carol" }),
    ]);
    assert.equal(second.response.status, 200);
    assert.notEqual(second.body.allocationId, first.body.allocationId);
    assert.notEqual(second.body.room, first.body.room);

    await new Promise((resolve) => setTimeout(resolve, 45));
    const listed = await control("list");
    const visible = listed.body.rooms;
    assert.equal(listed.response.status, 200);
    assert.ok(Array.isArray(visible));
    assert.equal(visible.length, 2);
    assert.equal(third.response.status, 429);
    for (const allocation of visible) {
      assert.equal(typeof allocation.id, "string");
      assert.match(allocation.roomId, /^ott-[0-9a-f-]{36}$/);
      assert.equal(JSON.stringify(allocation).includes("initializing"), false);
      assert.equal(JSON.stringify(allocation).includes("resumeCredential"), false);
      assert.equal(JSON.stringify(allocation).includes("ticket"), false);
      assert.equal(JSON.stringify(allocation).includes("hash"), false);
    }
  } finally {
    await stopWorker(worker);
  }
});

test("control resume rotates owner credentials and never accepts a caller-selected seat", async (t) => {
  const vars = path.join(root, ".dev.vars");
  if (!fs.existsSync(vars)) {
    t.skip("NOT RUN: .dev.vars is absent; create it locally with OTT_INTERNAL_SECRET for the approved smoke");
    return;
  }
  await assertPortIsFree();
  const worker = startWorker();
  const pauseForRateLimit = () => new Promise((resolve) => setTimeout(resolve, 45));
  try {
    await waitForHttp(worker);
    const created = await control("create", { name: "Owner A" });
    assert.equal(created.response.status, 200);
    assert.equal(typeof created.body.resumeCredential, "string");
    assert.equal(JSON.stringify(created.body).includes("salt"), false);

    await pauseForRateLimit();
    const seatOnly = await control("resume", { allocationId: created.body.allocationId, seat: "A" });
    assert.equal(seatOnly.response.status, 401);
    await pauseForRateLimit();
    const wrongCredential = await control("resume", { allocationId: created.body.allocationId, resumeCredential: "wrong-owner-secret" });
    assert.equal(wrongCredential.response.status, 401);

    await pauseForRateLimit();
    const resumedA = await control("resume", { allocationId: created.body.allocationId, resumeCredential: created.body.resumeCredential });
    assert.equal(resumedA.response.status, 200);
    assert.equal(resumedA.body.seat, "A");
    assert.notEqual(resumedA.body.resumeCredential, created.body.resumeCredential);
    assert.notEqual(resumedA.body.ticket, created.body.ticket);

    await pauseForRateLimit();
    const oldCredential = await control("resume", { allocationId: created.body.allocationId, resumeCredential: created.body.resumeCredential });
    assert.equal(oldCredential.response.status, 401);
    await pauseForRateLimit();
    const joined = await control("join", { allocationId: created.body.allocationId, name: "Owner B" });
    assert.equal(joined.response.status, 200);
    assert.equal(typeof joined.body.resumeCredential, "string");
    await pauseForRateLimit();
    const resumedB = await control("resume", { allocationId: created.body.allocationId, seat: "A", resumeCredential: joined.body.resumeCredential });
    assert.equal(resumedB.response.status, 200);
    assert.equal(resumedB.body.seat, "B");
  } finally {
    await stopWorker(worker);
  }
});

test("parallel reuse of one attach ticket mutates one seat and rejects its replay", async (t) => {
  const vars = path.join(root, ".dev.vars");
  if (!fs.existsSync(vars)) {
    t.skip("NOT RUN: .dev.vars is absent; create it locally with OTT_INTERNAL_SECRET for the approved smoke");
    return;
  }

  await assertPortIsFree();
  const worker = startWorker();
  let joinOwnerSocket;
  try {
    await waitForHttp(worker);
    const assertReplayRejected = async (roomId, ticket) => {
      const sockets = [await connectRoom(roomId), await connectRoom(roomId)];
      try {
        const command = { __ott: true, roomId, type: "ott:attach", ticket };
        const replayRejected = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Replayed attach ticket was not rejected")), REQUEST_TIMEOUT_MS);
          for (const socket of sockets) socket.on("message", (data) => {
            const value = data.toString();
            if (!value.startsWith("__YPS:")) return;
            try {
              const parsed = JSON.parse(value.slice("__YPS:".length));
              if (parsed.__ott && parsed.type === "ott:error" && parsed.error === "attach_replayed") {
                clearTimeout(timer);
                resolve(parsed);
              }
            } catch {}
          });
        });
        const results = await Promise.all(sockets.map((socket) => sendOtt(socket, command)));
        await replayRejected;
        const responses = results.flatMap((item) => item.messages);
        assert.ok(responses.some((message) => message.type === "ott:state"));
        assert.equal(responses.filter((message) => message.type === "ott:error" && message.error === "attach_replayed").length, 1);
        assert.equal(responses.filter((message) => message.type === "ott:state").length, 1, "the successful attach receives one direct authoritative response");
        const winningIndex = results.findIndex((item) => item.first.type === "ott:state");
        assert.notEqual(winningIndex, -1);
        await new Promise((resolve) => setTimeout(resolve, 45));
        const followUp = await sendOtt(sockets[winningIndex], { __ott: true, roomId, type: "ott:leave" });
        assert.equal(followUp.first.type, "ott:state", "the replay rejection must not disconnect the winning attach");
      } finally {
        for (const socket of sockets) socket.terminate();
      }
    };

    const created = await control("create", { name: "Alice" });
    assert.equal(created.response.status, 200);
    await assertReplayRejected(created.body.room, created.body.ticket);

    await new Promise((resolve) => setTimeout(resolve, 45));
    const joinRoom = await control("create", { name: "Owner" });
    assert.equal(joinRoom.response.status, 200);
    joinOwnerSocket = await connectRoom(joinRoom.body.room);
    const ownerAttach = await sendOtt(joinOwnerSocket, {
      __ott: true, roomId: joinRoom.body.room, type: "ott:attach", ticket: joinRoom.body.ticket,
    });
    assert.equal(ownerAttach.first.type, "ott:state", "seat A attaches before the B capability is issued/used");
    await new Promise((resolve) => setTimeout(resolve, 45));
    const joined = await control("join", { allocationId: joinRoom.body.allocationId, name: "Bob" });
    assert.equal(joined.response.status, 200);
    await assertReplayRejected(joined.body.room, joined.body.ticket);

    await new Promise((resolve) => setTimeout(resolve, 45));
    const resumeRoom = await control("create", { name: "Resume owner" });
    assert.equal(resumeRoom.response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 45));
    const resumed = await control("resume", { allocationId: resumeRoom.body.allocationId, resumeCredential: resumeRoom.body.resumeCredential });
    assert.equal(resumed.response.status, 200);
    await assertReplayRejected(resumed.body.room, resumed.body.ticket);
  } finally {
    if (joinOwnerSocket) joinOwnerSocket.terminate();
    await stopWorker(worker);
    runtimeLog(`Wrangler stdout:\n${worker.output.stdout || "(empty)"}`);
    runtimeLog(`Wrangler stderr:\n${worker.output.stderr || "(empty)"}`);
  }
});

test("Lobby join reserves trusted B name and both capability holders receive playable private projections", async (t) => {
  const vars = path.join(root, ".dev.vars");
  if (!fs.existsSync(vars)) {
    t.skip("NOT RUN: .dev.vars is absent; create it locally with OTT_INTERNAL_SECRET for the approved smoke");
    return;
  }
  await assertPortIsFree();
  const worker = startWorker();
  let socketA;
  let socketB;
  try {
    await waitForHttp(worker);
    const created = await control("create", { name: "Trusted Alice" });
    assert.equal(created.response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 45));
    const joined = await control("join", { allocationId: created.body.allocationId, name: "<b>Trusted Bob</b>" });
    assert.equal(joined.response.status, 200);
    assert.equal(joined.body.seat, "B");

    socketA = await connectRoom(created.body.room);
    socketB = await connectRoom(created.body.room);
    const attachedA = await sendOtt(socketA, { __ott: true, roomId: created.body.room, type: "ott:attach", ticket: created.body.ticket });
    assert.equal(attachedA.first.type, "ott:state");
    assert.equal(attachedA.first.state.you, "A");
    assert.equal(attachedA.first.state.players.A.name, "Trusted Alice");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const senderResponsesA = attachedA.messages.filter((message) => message.type === "ott:state" && message.revision === attachedA.first.revision);
    assert.equal(senderResponsesA.length, 1, "the attach sender receives exactly one authoritative response at its revision");

    const stateForA = nextOttMessage(socketA, (message) => message.type === "ott:state" && message.revision > attachedA.first.revision && message.state?.you === "A", "A seat projection");
    const attachedB = await sendOtt(socketB, { __ott: true, roomId: created.body.room, type: "ott:attach", ticket: joined.body.ticket });
    assert.equal(attachedB.first.type, "ott:state");
    assert.equal(attachedB.first.state.you, "B");
    assert.equal(attachedB.first.state.players.B.name, "Trusted Bob");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const senderResponsesB = attachedB.messages.filter((message) => message.type === "ott:state" && message.revision === attachedB.first.revision);
    assert.equal(senderResponsesB.length, 1, "B receives its attach response once, separate from the A broadcast");
    const broadcastA = await stateForA;
    assert.equal(broadcastA.state.players.A.name, "Trusted Alice");
    assert.equal(broadcastA.state.players.B.name, "Trusted Bob");
    for (const state of [attachedA.first.state, attachedB.first.state, broadcastA.state]) {
      assert.equal(JSON.stringify(state).includes("resumeToken"), false);
      assert.equal(JSON.stringify(state).includes("ticket"), false);
      assert.equal(JSON.stringify(state).includes("resumeCredential"), false);
      assert.equal(JSON.stringify(state).includes("capability"), false);
    }

    const move = rules.allMoves(attachedB.first.state.state, "A")[0];
    assert.ok(move, "the projected authoritative game state contains a legal move");
    const nextBProjection = nextOttMessage(socketB, (message) => message.type === "ott:state" && message.revision > attachedB.first.revision && message.state?.you === "B", "B move projection");
    const moved = await sendOtt(socketA, { __ott: true, roomId: created.body.room, type: "ott:move", from: move.from, to: move.to });
    assert.equal(moved.first.type, "ott:state");
    const movedB = await nextBProjection;
    assert.equal(movedB.state.you, "B");
    assert.equal(movedB.state.state.turn, "B");
  } finally {
    socketA?.terminate();
    socketB?.terminate();
    await stopWorker(worker);
  }
});

test("test Worker expires unattached allocations using server-owned deadlines and clears owner credentials", async (t) => {
  const vars = path.join(root, ".dev.vars");
  if (!fs.existsSync(vars)) {
    t.skip("NOT RUN: .dev.vars is absent; create it locally with OTT_INTERNAL_SECRET for the approved smoke");
    return;
  }
  await assertPortIsFree();
  const worker = startWorker();
  try {
    await waitForHttp(worker);
    const created = await control("create", {
      name: "Never attached",
      creatorAttachDeadlineMs: Date.now() + 60_000,
      reconnectGraceMs: 60_000,
    });
    assert.equal(created.response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 5_500));

    const listed = await control("list");
    assert.deepEqual(listed.body.rooms, []);
    await new Promise((resolve) => setTimeout(resolve, 45));
    const resumed = await control("resume", {
      allocationId: created.body.allocationId,
      resumeCredential: created.body.resumeCredential,
    });
    assert.equal(resumed.response.status, 401);
  } finally {
    await stopWorker(worker);
  }
});

test("manual Task 10 two-profile acceptance remains separate from browser automation", (t) => {
  assert.equal(typeof process.env.OTT_BROWSER_RUNTIME, "undefined");
  t.skip("NOT RUN: manual acceptance is pending; automated two-context browser coverage is in npm run test:browser-worker-runtime");
});
