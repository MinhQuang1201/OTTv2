const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
let loadedAuth;
let loadedRoomStorage;

async function authModule() {
  if (!loadedAuth) {
    const { transformSync } = require("esbuild");
    const { code } = transformSync(read("workers/internal-auth.ts"), { loader: "ts", format: "esm" });
    loadedAuth = import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  }
  return loadedAuth;
}

async function roomStorageModule() {
  if (!loadedRoomStorage) {
    const { buildSync } = require("esbuild");
    const Module = require("node:module");
    const { outputFiles } = buildSync({
      entryPoints: [path.join(root, "workers", "room-storage.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false,
    });
    const filename = path.join(root, "workers", "room-storage-task4-test.cjs");
    const bundledModule = new Module(filename, module);
    bundledModule.filename = filename;
    bundledModule.paths = Module._nodeModulePaths(root);
    bundledModule._compile(outputFiles[0].text, filename);
    loadedRoomStorage = bundledModule.exports;
  }
  return loadedRoomStorage;
}

test("seat update stores one trusted B name and accepts only an identical retry", async () => {
  const { applySeatUpdateReceipt } = await authModule();
  const values = new Map([["allocationId", "alloc-game-1"], ["roomId", "ott-room-game-1"]]);
  const storage = {
    get: async (key) => values.get(key),
    put: async (key, value) => values.set(key, value),
  };
  const input = { allocationId: "alloc-game-1", roomId: "ott-room-game-1", seat: "B", name: "Trusted Bob" };

  assert.equal(await applySeatUpdateReceipt(storage, input), "created");
  assert.equal(await applySeatUpdateReceipt(storage, input), "retry");
  assert.equal(await applySeatUpdateReceipt(storage, { ...input, name: "Forged Bob" }), "conflict");
  assert.equal(values.get("seat-name:B"), "Trusted Bob");
});

test("Lobby retries a transient Game seat-update failure with the same immutable B name", async () => {
  const { applySeatUpdateReceipt, retrySeatUpdateRequest } = await authModule();
  const values = new Map([["allocationId", "alloc-retry"], ["roomId", "ott-room-retry"]]);
  const storage = {
    get: async (key) => values.get(key),
    put: async (key, value) => values.set(key, value),
  };
  let attempts = 0;
  const response = await retrySeatUpdateRequest(async () => {
    attempts += 1;
    const receipt = await applySeatUpdateReceipt(storage, {
      allocationId: "alloc-retry", roomId: "ott-room-retry", seat: "B", name: "Trusted Bob",
    });
    return { status: attempts === 1 ? 503 : 200, receipt };
  }, (result) => result.status >= 500);

  assert.equal(attempts, 2);
  assert.equal(response.status, 200);
  assert.equal(response.receipt, "retry");
  assert.equal(values.get("seat-name:B"), "Trusted Bob");
});

test("lifecycle revision receiver rejects stale and future updates and cleans both seats on terminal", async () => {
  const { applyLifecycleUpdate } = await authModule();
  const allocationId = "alloc-game-2";
  const values = new Map([
    [`allocation:${allocationId}`, { id: allocationId, roomId: "ott-room-game-2", status: "playing", seats: 2 }],
    [`lifecycle:${allocationId}`, { revision: 1, status: "playing" }],
    [`owner-credential:${allocationId}:A`, { salt: "salt-a", hash: "hash-a" }],
    [`owner-ticket:${allocationId}:A`, { nonce: "nonce-a", expiresAt: 10 }],
    [`owner-credential:${allocationId}:B`, { salt: "salt-b", hash: "hash-b" }],
    [`owner-ticket:${allocationId}:B`, { nonce: "nonce-b", expiresAt: 10 }],
  ]);
  const storage = {
    get: async (key) => values.get(key),
    put: async (key, value) => values.set(key, value),
    delete: async (key) => values.delete(key),
  };

  assert.equal(await applyLifecycleUpdate(storage, { allocationId, roomId: "ott-room-game-2", revision: 1, status: "playing" }), "stale");
  assert.equal(await applyLifecycleUpdate(storage, { allocationId, roomId: "ott-room-game-2", revision: 3, status: "terminal" }), "future");
  assert.equal(await applyLifecycleUpdate(storage, { allocationId, roomId: "wrong-room", revision: 2, status: "terminal" }), "conflict");
  assert.equal(await applyLifecycleUpdate(storage, { allocationId, roomId: "ott-room-game-2", revision: 2, status: "terminal" }), "applied");
  assert.equal(values.get(`allocation:${allocationId}`).status, "terminal");
  assert.equal(values.has(`owner-credential:${allocationId}:A`), false);
  assert.equal(values.has(`owner-ticket:${allocationId}:A`), false);
  assert.equal(values.has(`owner-credential:${allocationId}:B`), false);
  assert.equal(values.has(`owner-ticket:${allocationId}:B`), false);
});

test("recipient projection selects its own seat and whitelists public room fields", async () => {
  const { projectRoomPayload } = await roomStorageModule();
  const payload = {
    roomId: "ott-room-game-3",
    status: "playing",
    serverNow: 123,
    revision: 7,
    players: {
      A: { name: "Alice", connected: true, resumeToken: "private-A" },
      B: { name: "Bob", connected: true, resumeToken: "private-B" },
    },
    state: { turn: "A" },
    events: [],
    capability: "internal-capability",
    resumeCredential: "owner-secret",
  };

  const forA = projectRoomPayload(payload, "A");
  const forB = projectRoomPayload(payload, "B");
  assert.equal(forA.you, "A");
  assert.equal(forB.you, "B");
  assert.deepEqual(forA.players.A, { name: "Alice", connected: true });
  assert.deepEqual(forA.players.B, { name: "Bob", connected: true });
  assert.equal(JSON.stringify([forA, forB]).includes("private-A"), false);
  assert.equal(JSON.stringify([forA, forB]).includes("private-B"), false);
  assert.equal(JSON.stringify([forA, forB]).includes("owner-secret"), false);
  assert.equal(JSON.stringify([forA, forB]).includes("internal-capability"), false);
});

test("DurableRoomAdapter attaches using Lobby-persisted names rather than a browser-supplied value", async () => {
  const { DurableRoomAdapter } = await roomStorageModule();
  const values = new Map([["creatorName", "Trusted Alice"], ["seat-name:B", "Trusted Bob"]]);
  const storage = {
    get: async (key) => values.get(key),
    put: async (key, value) => { values.set(key, value); },
  };
  const adapter = await DurableRoomAdapter.create("ott-room-names", storage, () => 100);
  const connectionA = { id: "connection-A", open: true, send() {} };
  const connectionB = { id: "connection-B", open: true, send() {} };

  assert.equal((await adapter.attach(connectionA, "A", undefined)).ok, true);
  assert.equal((await adapter.attach(connectionB, "B", undefined)).ok, true);
  assert.equal(adapter.room.players.A.name, "Trusted Alice");
  assert.equal(adapter.room.players.B.name, "Trusted Bob");
});

test("DurableRoomAdapter refuses to attach when the trusted seat name is missing", async () => {
  const { DurableRoomAdapter } = await roomStorageModule();
  const values = new Map();
  const storage = {
    get: async (key) => values.get(key),
    put: async (key, value) => { values.set(key, value); },
  };
  const adapter = await DurableRoomAdapter.create("ott-room-missing-name", storage, () => 100);
  const result = await adapter.attach({ id: "connection-A", open: true, send() {} }, "A", undefined);

  assert.equal(result.ok, false);
  assert.equal(adapter.room.players.A, null);
});

test("failed final join commit cleans the B reservation and restores waiting visibility", async () => {
  const { withJoinReservationRollback } = await authModule();
  const values = new Map([
    ["allocation", { status: "joining", seats: 1 }],
    ["owner-credential:B", { hash: "hash-b" }],
    ["owner-ticket:B", { nonce: "nonce-b" }],
  ]);
  const rollback = async () => {
    values.set("allocation", { status: "waiting", seats: 1 });
    values.delete("owner-credential:B");
    values.delete("owner-ticket:B");
  };

  const result = await withJoinReservationRollback(async () => {
    throw new Error("Lobby final commit failed");
  }, rollback);

  assert.equal(result.ok, false);
  assert.deepEqual(values.get("allocation"), { status: "waiting", seats: 1 });
  assert.equal(values.has("owner-credential:B"), false);
  assert.equal(values.has("owner-ticket:B"), false);
});
