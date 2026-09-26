const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const auth = read("workers/internal-auth.ts");
const lobby = read("workers/ott-lobby-server.ts");
const game = read("workers/ott-game-server.ts");
const worker = read("workers/ott-worker.ts");
const wrangler = read("workers/wrangler.jsonc");

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
    const filename = path.join(root, "workers", "room-storage-test-bundle.cjs");
    const bundledModule = new Module(filename, module);
    bundledModule.filename = filename;
    bundledModule.paths = Module._nodeModulePaths(root);
    bundledModule._compile(outputFiles[0].text, filename);
    loadedRoomStorage = Promise.resolve(bundledModule.exports);
  }
  return loadedRoomStorage;
}

test("capability format is canonical, expiring, room-bound, and nonce-backed", () => {
  assert.match(auth, /JSON\.stringify\(\[/);
  assert.match(auth, /purpose/);
  assert.match(auth, /expiresAt/);
  assert.match(auth, /nonce/);
  assert.match(auth, /subtle\.sign\("HMAC"/);
  assert.match(auth, /subtle\.verify\("HMAC"/);
  assert.match(auth, /storage\.put\(nonceKey, verification\.payload\.expiresAt\)/);
  assert.match(auth, /payload\.roomId !== expected\.roomId/);
  assert.match(auth, /payload\.expiresAt <= now/);
});

test("capability mutation is guarded by the same durable nonce transaction", () => {
  assert.match(auth, /verifyCapabilityTransaction/);
  assert.match(auth, /transaction\(async/);
  assert.match(auth, /nonce:[^`]*payload\.nonce|`nonce:\$\{payload\.nonce\}`/);
  assert.match(game, /verifyCapabilityTransaction/);
  assert.doesNotMatch(game, /attach-nonce:\$\{capability\.nonce\}/);
});

test("canonical capability round-trips and parallel verification commits one mutation", async () => {
  const { issueCapability, verifyCapabilityTransaction } = await authModule();
  class MemoryDO {
    values = new Map();
    tail = Promise.resolve();
    transaction(callback) {
      const run = async () => {
        const pending = new Map(this.values);
        const tx = {
          get: async (key) => pending.get(key),
          put: async (key, value) => { pending.set(key, value); },
        };
        const result = await callback(tx);
        this.values = pending;
        return result;
      };
      const next = this.tail.then(run, run);
      this.tail = next.then(() => undefined, () => undefined);
      return next;
    }
  }
  const claims = {
    allocationId: "00000000-0000-4000-8000-000000000011",
    roomId: "ott-00000000-0000-4000-8000-000000000011",
    purpose: "attach",
    seat: "B",
    now: 10_000,
    ttlMs: 60_000,
    nonce: "canonical-roundtrip-nonce-000001",
  };
  const token = await issueCapability("test-secret", claims);
  const decoded = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
  assert.deepEqual(decoded, ["ott-cap-v1", claims.allocationId, claims.roomId, claims.purpose, claims.seat, claims.now, claims.now + claims.ttlMs, claims.nonce]);
  const store = new MemoryDO();
  const mutate = async (_payload, tx) => {
    const count = await tx.get("mutations") ?? 0;
    await tx.put("mutations", count + 1);
    return { accepted: true, value: count + 1 };
  };
  const options = { allocationId: claims.allocationId, roomId: claims.roomId, purpose: "attach" };
  const [first, second] = await Promise.all([
    verifyCapabilityTransaction("test-secret", token, options, store.transaction.bind(store), mutate, { now: 10_001, noncePrefix: "attach-nonce" }),
    verifyCapabilityTransaction("test-secret", token, options, store.transaction.bind(store), mutate, { now: 10_001, noncePrefix: "attach-nonce" }),
  ]);
  assert.deepEqual([first.ok, second.ok].sort(), [false, true]);
  assert.equal(store.values.get("mutations"), 1);
  assert.equal(store.values.get("attach-nonce:" + claims.nonce), claims.now + claims.ttlMs);
});

test("rejected capability mutation rolls back both the mutation and nonce", async () => {
  const { issueCapability, verifyCapabilityTransaction } = await authModule();
  const values = new Map();
  const transaction = async (callback) => {
    const pending = new Map(values);
    const tx = { get: async (key) => pending.get(key), put: async (key, value) => pending.set(key, value) };
    const result = await callback(tx);
    for (const [key, value] of pending) values.set(key, value);
    return result;
  };
  const claims = { allocationId: "allocation-12", roomId: "ott-room-12", purpose: "game-init", seat: "A", now: 20_000, nonce: "rejected-mutation-nonce-000001" };
  const token = await issueCapability("test-secret", claims);
  const result = await verifyCapabilityTransaction("test-secret", token, claims, transaction, async (_payload, tx) => {
    await tx.put("mutation", true);
    return { accepted: false, value: "conflict" };
  }, { now: 20_001 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "mutation-rejected");
  assert.equal(values.has("mutation"), false);
  assert.equal(values.has("nonce:" + claims.nonce), false);
});

test("exact initialization receipt retries once and rejects changed immutable identity", async () => {
  const { issueCapability, verifyCapabilityTransaction, applyInitializationReceipt } = await authModule();
  const values = new Map();
  let queue = Promise.resolve();
  const transaction = (callback) => {
    const run = async () => {
      const pending = new Map(values);
      const result = await callback({ get: async (key) => pending.get(key), put: async (key, value) => pending.set(key, value) });
      values.clear();
      for (const [key, value] of pending) values.set(key, value);
      return result;
    };
    const next = queue.then(run, run);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };
  const base = { allocationId: "alloc-21", roomId: "ott-room-21", payloadHash: "immutable-payload-hash" };
  let creates = 0;
  const firstToken = await issueCapability("test-secret", { ...base, purpose: "game-init", seat: "A", nonce: "init-exact-first-nonce-000001" });
  const retryToken = await issueCapability("test-secret", { ...base, purpose: "game-init", seat: "A", nonce: "init-exact-retry-nonce-000001" });
  const expected = { allocationId: base.allocationId, roomId: base.roomId, purpose: "game-init", seat: "A" };
  const initialize = (token, input = base) => verifyCapabilityTransaction("test-secret", token, expected, transaction, async (_payload, storage) => {
    const result = await applyInitializationReceipt(storage, input, async () => {
      creates++;
      await storage.put("room", { creator: "A" });
    });
    return { accepted: result !== "conflict", value: result };
  }, { now: Date.now() });
  const [first, retry] = await Promise.all([initialize(firstToken), initialize(retryToken)]);
  assert.equal(first.ok, true);
  assert.equal(retry.ok, true);
  assert.deepEqual([first.value, retry.value].sort(), ["created", "retry"]);
  assert.equal(creates, 1);
  assert.ok(values.has("nonce:init-exact-first-nonce-000001"));
  assert.ok(values.has("nonce:init-exact-retry-nonce-000001"));

  for (const [index, change] of [
    { payloadHash: "changed-payload-hash" },
    { allocationId: "alloc-22" },
    { roomId: "ott-room-22" },
  ].entries()) {
    const token = await issueCapability("test-secret", { ...base, purpose: "game-init", seat: "A", nonce: `init-conflict-nonce-0000${index}` });
    const result = await initialize(token, { ...base, ...change });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "mutation-rejected");
    assert.equal(values.has("nonce:init-conflict-nonce-0000" + index), false);
  }
  assert.equal(creates, 1);
});

test("recoverable Lobby initialization retries with a fresh capability and reuses the exact Game receipt", async () => {
  const { issueCapability, verifyCapabilityTransaction, applyInitializationReceipt, initializationPayloadHash, retryRecoverableInitialization } = await authModule();
  const values = new Map();
  const transaction = async (callback) => {
    const pending = new Map(values);
    const storage = {
      get: async (key) => pending.get(key),
      put: async (key, value) => { pending.set(key, value); },
    };
    const result = await callback(storage);
    values.clear();
    for (const [key, value] of pending) values.set(key, value);
    return result;
  };
  const immutable = {
    allocationId: "alloc-29",
    roomId: "ott-00000000-0000-4000-8000-000000000029",
    creatorName: "Alice",
    creatorAttachDeadlineMs: 160_000,
  };
  const payloadHash = await initializationPayloadHash(immutable);
  const lobbyAllocation = { ...immutable, status: "initializing" };
  const visible = () => lobbyAllocation.status === "waiting" ? [lobbyAllocation.roomId] : [];
  const tokens = [];
  const result = await retryRecoverableInitialization(async () => {
    const claims = { allocationId: immutable.allocationId, roomId: immutable.roomId, purpose: "game-init", seat: "A", nonce: `lobby-retry-${tokens.length}-nonce-001` };
    const token = await issueCapability("test-secret", claims);
    tokens.push(token);
    const verified = await verifyCapabilityTransaction("test-secret", token, claims, transaction, async (_payload, storage) => {
      const receipt = await applyInitializationReceipt(storage, {
        allocationId: immutable.allocationId,
        roomId: immutable.roomId,
        payloadHash,
      }, async (tx) => tx.put("room", { ...immutable }));
      return { accepted: receipt !== "conflict", value: receipt };
    });
    assert.equal(verified.ok, true);
    if (tokens.length === 1) {
      assert.deepEqual(visible(), [], "initializing allocations stay hidden through the recoverable failure");
      return { status: 503, receipt: verified.value };
    }
    return { status: 200, receipt: verified.value };
  }, (response) => response.status >= 500, () => false);

  assert.equal(result.status, 200);
  assert.equal(result.receipt, "retry");
  assert.equal(tokens.length, 2);
  assert.notEqual(tokens[0], tokens[1]);
  assert.deepEqual(values.get("room"), immutable);
  assert.equal(values.get("initialization-receipt").payloadHash, payloadHash);
  assert.equal(lobbyAllocation.status, "initializing");
  lobbyAllocation.status = "waiting";
  assert.deepEqual(visible(), [immutable.roomId]);
});

test("owner resume credential rotates atomically and permits exactly one concurrent resume", async () => {
  const { createOwnerCredential, verifyOwnerCredential, rotateOwnerCredential, verifyCapability } = await authModule();
  const values = new Map();
  let queue = Promise.resolve();
  const transaction = (callback) => {
    const run = async () => {
      const pending = new Map(values);
      const storage = {
        get: async (key) => pending.get(key),
        put: async (key, value) => { pending.set(key, value); },
      };
      const result = await callback(storage);
      values.clear();
      for (const [key, value] of pending) values.set(key, value);
      return result;
    };
    const next = queue.then(run, run);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };
  const allocationId = "alloc-owner-30";
  const roomId = "ott-00000000-0000-4000-8000-000000000030";
  const original = await createOwnerCredential();
  const credentialKey = `owner-credential:${allocationId}:A`;
  values.set(credentialKey, { salt: original.salt, hash: original.hash });
  assert.equal(await verifyOwnerCredential(original.credential, values.get(credentialKey)), true);
  assert.equal(await verifyOwnerCredential("wrong-owner-credential", values.get(credentialKey)), false);

  const rotate = () => transaction((storage) => rotateOwnerCredential(storage, "test-secret", {
    allocationId, roomId, seat: "A", resumeCredential: original.credential, now: Date.now(),
  }));
  const [first, second] = await Promise.all([rotate(), rotate()]);
  const rotated = [first, second].filter(Boolean);
  assert.equal(rotated.length, 1);
  assert.notEqual(rotated[0].resumeCredential, original.credential);
  assert.equal(await verifyOwnerCredential(original.credential, values.get(credentialKey)), false);
  assert.equal(await verifyOwnerCredential(rotated[0].resumeCredential, values.get(credentialKey)), true);
  assert.equal(values.get(`owner-ticket:${allocationId}:A`).nonce.length >= 16, true);
  const ticketClaims = await verifyCapability("test-secret", rotated[0].ticket, { allocationId, roomId, purpose: "attach", seat: "A" });
  assert.ok(ticketClaims);
  assert.equal(ticketClaims.nonce, values.get(`owner-ticket:${allocationId}:A`).nonce);
  assert.equal(await rotate(), null, "the original credential cannot be reused");
});

test("allocation owner-secret cleanup removes hashes and one-use ticket records for both seats", async () => {
  const { deleteOwnerCredentials } = await authModule();
  const values = new Map([
    ["owner-credential:alloc-cleanup:A", { salt: "salt-a", hash: "hash-a" }],
    ["owner-ticket:alloc-cleanup:A", { nonce: "nonce-a", expiresAt: 10 }],
    ["owner-credential:alloc-cleanup:B", { salt: "salt-b", hash: "hash-b" }],
    ["owner-ticket:alloc-cleanup:B", { nonce: "nonce-b", expiresAt: 10 }],
    ["owner-credential:other:A", { salt: "other", hash: "other" }],
  ]);
  await deleteOwnerCredentials({
    get: async (key) => values.get(key),
    put: async (key, value) => values.set(key, value),
    delete: async (key) => values.delete(key),
  }, "alloc-cleanup");
  assert.equal(values.has("owner-credential:alloc-cleanup:A"), false);
  assert.equal(values.has("owner-ticket:alloc-cleanup:A"), false);
  assert.equal(values.has("owner-credential:alloc-cleanup:B"), false);
  assert.equal(values.has("owner-ticket:alloc-cleanup:B"), false);
  assert.equal(values.has("owner-credential:other:A"), true);
});

test("initialization failures before and after durable room writes roll back receipt and nonce", async () => {
  const { issueCapability, verifyCapabilityTransaction, applyInitializationReceipt } = await authModule();
  for (const failAfterRoomWrite of [false, true]) {
    const values = new Map();
    const transaction = async (callback) => {
      const pending = new Map(values);
      const tx = {
        get: async (key) => pending.get(key),
        put: async (key, value) => {
          if (failAfterRoomWrite && key === "initialization-receipt") throw new Error("simulated durable receipt write failure");
          pending.set(key, value);
        },
      };
      const result = await callback(tx);
      values.clear();
      for (const [key, value] of pending) values.set(key, value);
      return result;
    };
    const claims = { allocationId: "alloc-23", roomId: "ott-room-23", purpose: "game-init", seat: "A", nonce: `init-failure-${failAfterRoomWrite}-nonce-001` };
      const token = await issueCapability("test-secret", claims);
      const result = await verifyCapabilityTransaction("test-secret", token, claims, transaction, async (_payload, storage) => {
        const receipt = await applyInitializationReceipt(storage, { ...claims, payloadHash: "payload-hash" }, async () => {
          if (failAfterRoomWrite) {
            await storage.put("room", { creator: "A" });
            return;
          }
          throw new Error("simulated failure before room persistence");
        });
        return { accepted: receipt !== "conflict", value: receipt };
      });
    assert.equal(result.ok, false);
    assert.equal(values.has("room"), false);
    assert.equal(values.has("initialization-receipt"), false);
    assert.equal(values.has("nonce:" + claims.nonce), false);
  }
});

test("failed transactional attach persistence leaves seat and ticket nonce unchanged", async () => {
  const { issueCapability, verifyCapabilityTransaction } = await authModule();
  const values = new Map();
  const transaction = async (callback) => {
    const pending = new Map(values);
    const result = await callback({
      get: async (key) => pending.get(key),
      put: async (key, value) => {
        if (key === "room") throw new Error("simulated room write failure");
        pending.set(key, value);
      },
    });
    values.clear();
    for (const [key, value] of pending) values.set(key, value);
    return result;
  };
  const claims = { allocationId: "alloc-24", roomId: "ott-room-24", purpose: "attach", seat: "A", nonce: "attach-storage-failure-nonce-001" };
  const token = await issueCapability("test-secret", claims);
  const result = await verifyCapabilityTransaction("test-secret", token, claims, transaction, async (_payload, storage) => {
    await storage.put("room", { seatA: "connected" });
    return { accepted: true, value: true };
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "transaction-failed");
  assert.equal(values.has("room"), false);
  assert.equal(values.has("nonce:" + claims.nonce), false);
});

test("attach write failure reloads adapter state before returning and leaves nonce unused", async () => {
  const { issueCapability, attachWithCapabilityRecovery } = await authModule();
  const { DurableRoomAdapter, ROOM_KEY } = await roomStorageModule();
  class MemoryStorage {
    values = new Map();
    failTransactionalKey;
    async get(key) { return this.values.get(key); }
    async put(key, value) { this.values.set(key, value); }
    async transaction(callback) {
      const pending = new Map(this.values);
      const tx = {
        get: async (key) => pending.get(key),
        put: async (key, value) => {
          if (key === this.failTransactionalKey) throw new Error("simulated durable Room write failure");
          pending.set(key, value);
        },
      };
      const result = await callback(tx);
      this.values = pending;
      return result;
    }
  }
  const storage = new MemoryStorage();
  const roomId = "ott-00000000-0000-4000-8000-000000000026";
  const adapter = await DurableRoomAdapter.create(roomId, storage, () => 100_000);
  storage.values.set("creatorName", "Trusted Alice");
  assert.equal(adapter.room.players.A, null);
  storage.failTransactionalKey = ROOM_KEY;
  const claims = { allocationId: "alloc-26", roomId, purpose: "attach", seat: "A", nonce: "attach-adapter-recovery-nonce-001" };
  const token = await issueCapability("test-secret", claims);
  const result = await attachWithCapabilityRecovery("test-secret", token, claims, storage.transaction.bind(storage), adapter, { id: "connection-A" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "transaction-failed");
  const reloaded = await DurableRoomAdapter.load(roomId, storage, () => 100_000);
  assert.ok(reloaded);
  assert.equal(reloaded.room.players.A, null, "the committed Room snapshot must not contain the failed seat mutation");
  assert.equal(adapter.room.players.A, null, "the live adapter must be rehydrated from committed storage");
  assert.equal(adapter.unavailable, false);
  assert.equal(adapter.connectionsSnapshot().length, 0);
  assert.equal(storage.values.has("attach-nonce:" + claims.nonce), false);
});

test("signed attach seat drives Room resume and the Room token remains private", async () => {
  const { issueCapability, attachWithCapabilityRecovery } = await authModule();
  const { DurableRoomAdapter } = await roomStorageModule();
  class MemoryStorage {
    values = new Map();
    async get(key) { return this.values.get(key); }
    async put(key, value) { this.values.set(key, value); }
    async transaction(callback) {
      const pending = new Map(this.values);
      const tx = {
        get: async (key) => pending.get(key),
        put: async (key, value) => pending.set(key, value),
        setAlarm: async () => {},
        deleteAlarm: async () => {},
      };
      const result = await callback(tx);
      this.values = pending;
      return result;
    }
  }
  const storage = new MemoryStorage();
  const roomId = "ott-00000000-0000-4000-8000-000000000031";
  const allocationId = "alloc-31";
  const adapter = await DurableRoomAdapter.create(roomId, storage, () => 100_000);
  storage.values.set("creatorName", "Trusted Alice");
  storage.values.set("seat-name:B", "Trusted Bob");
  const claimsB = { allocationId, roomId, purpose: "attach", seat: "B" };
  const tokenB = await issueCapability("test-secret", { ...claimsB, nonce: "attach-owner-seat-B-ticket-000" });
  const earlyB = await attachWithCapabilityRecovery("test-secret", tokenB, claimsB, storage.transaction.bind(storage), adapter, { id: "owner-B-too-early" });
  assert.equal(earlyB.ok, false);
  assert.equal(earlyB.reason, "mutation-rejected");
  assert.equal(adapter.room.players.A, null);
  assert.equal(adapter.room.players.B, null);
  assert.equal(storage.values.has("attach-nonce:attach-owner-seat-B-ticket-000"), false);

  const connectionA = { id: "owner-A" };
  const claimsA = { allocationId, roomId, purpose: "attach", seat: "A" };
  const tokenA = await issueCapability("test-secret", { ...claimsA, nonce: "attach-owner-seat-A-ticket-001" });
  const first = await attachWithCapabilityRecovery("test-secret", tokenA, claimsA, storage.transaction.bind(storage), adapter, connectionA);
  assert.equal(first.ok, true);
  const privateRoomTokenA = adapter.room.players.A.resumeToken;
  assert.equal(typeof privateRoomTokenA, "string");
  assert.notEqual(privateRoomTokenA, tokenA, "the private Room token is distinct from the attach capability");

  await adapter.close(connectionA);
  const connectionA2 = { id: "owner-A-reconnect" };
  const resumeTokenA = await issueCapability("test-secret", { ...claimsA, nonce: "attach-owner-seat-A-ticket-002" });
  const resumed = await attachWithCapabilityRecovery("test-secret", resumeTokenA, claimsA, storage.transaction.bind(storage), adapter, connectionA2);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.payload.seat, "A", "the signed claim selects the resumed Room seat");
  assert.equal(adapter.room.players.A.connection, connectionA2);
  assert.equal(adapter.room.players.A.resumeToken, privateRoomTokenA, "the ticket is not used as Room's private token");
  assert.equal(JSON.stringify(resumed).includes(privateRoomTokenA), false);

  const connectionB = { id: "owner-B" };
  const tokenBAfterA = await issueCapability("test-secret", { ...claimsB, nonce: "attach-owner-seat-B-ticket-001" });
  const attachedB = await attachWithCapabilityRecovery("test-secret", tokenBAfterA, claimsB, storage.transaction.bind(storage), adapter, connectionB);
  assert.equal(attachedB.ok, true);
  assert.equal(attachedB.payload.seat, "B", "seat comes from the signed attach ticket, not an independent client field");
  assert.equal(adapter.room.players.B.connection, connectionB);
});

test("attach alarm failure rolls Room and nonce back in the same transaction", async () => {
  const { issueCapability, attachWithCapabilityRecovery } = await authModule();
  const { DurableRoomAdapter, ROOM_KEY } = await roomStorageModule();
  class MemoryStorage {
    values = new Map();
    alarmDeletes = 0;
    async get(key) { return this.values.get(key); }
    async put(key, value) { this.values.set(key, value); }
    async transaction(callback) {
      const pending = new Map(this.values);
      const tx = {
        get: async (key) => pending.get(key),
        put: async (key, value) => { pending.set(key, value); },
        setAlarm: async () => {},
        deleteAlarm: async () => {
          this.alarmDeletes += 1;
          throw new Error("simulated transactional alarm failure");
        },
      };
      const result = await callback(tx);
      this.values = pending;
      return result;
    }
  }
  const storage = new MemoryStorage();
  const roomId = "ott-00000000-0000-4000-8000-000000000027";
  const adapter = await DurableRoomAdapter.create(roomId, storage, () => 100_000);
  storage.values.set("creatorName", "Trusted Alice");
  const claims = { allocationId: "alloc-27", roomId, purpose: "attach", seat: "A", nonce: "attach-alarm-failure-nonce-001" };
  const token = await issueCapability("test-secret", claims);
  const result = await attachWithCapabilityRecovery("test-secret", token, claims, storage.transaction.bind(storage), adapter, { id: "connection-A" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "transaction-failed");
  assert.equal(storage.alarmDeletes, 1);
  const reloaded = await DurableRoomAdapter.load(roomId, storage, () => 100_000);
  assert.ok(reloaded);
  assert.equal(reloaded.room.players.A, null);
  assert.equal(adapter.room.players.A, null);
  assert.equal(adapter.unavailable, false);
  assert.equal(adapter.connectionsSnapshot().length, 0);
  assert.equal(storage.values.has("attach-nonce:" + claims.nonce), false);
  assert.equal(storage.values.get(ROOM_KEY).players.A, null);
});

test("failed B attach recovery preserves the previously live A connection", async () => {
  const { issueCapability, attachWithCapabilityRecovery } = await authModule();
  const { DurableRoomAdapter, ROOM_KEY } = await roomStorageModule();
  class MemoryStorage {
    values = new Map();
    failRoomWrite = false;
    async get(key) { return this.values.get(key); }
    async put(key, value) { this.values.set(key, value); }
    async transaction(callback) {
      const pending = new Map(this.values);
      const tx = {
        get: async (key) => pending.get(key),
        put: async (key, value) => {
          if (key === ROOM_KEY && this.failRoomWrite) throw new Error("simulated B attach Room write failure");
          pending.set(key, value);
        },
        setAlarm: async () => {},
        deleteAlarm: async () => {},
      };
      const result = await callback(tx);
      this.values = pending;
      return result;
    }
  }
  const storage = new MemoryStorage();
  const roomId = "ott-00000000-0000-4000-8000-000000000028";
  const adapter = await DurableRoomAdapter.create(roomId, storage, () => 100_000);
  storage.values.set("creatorName", "Trusted Alice");
  storage.values.set("seat-name:B", "Trusted Bob");
  const createClaims = { allocationId: "alloc-28", roomId, purpose: "attach", seat: "A", nonce: "attach-live-A-ticket-nonce-001" };
  const createToken = await issueCapability("test-secret", createClaims);
  const connectionA = { id: "connection-A" };
  assert.equal((await attachWithCapabilityRecovery("test-secret", createToken, createClaims, storage.transaction.bind(storage), adapter, connectionA)).ok, true);
  assert.equal(adapter.connectionsSnapshot().length, 1);

  const joinClaims = { allocationId: "alloc-28", roomId, purpose: "attach", seat: "B", nonce: "attach-failing-B-ticket-nonce-001" };
  const joinToken = await issueCapability("test-secret", joinClaims);
  storage.failRoomWrite = true;
  const result = await attachWithCapabilityRecovery("test-secret", joinToken, joinClaims, storage.transaction.bind(storage), adapter, { id: "connection-B" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "transaction-failed");
  assert.equal(adapter.room.players.A.connected, true);
  assert.equal(adapter.room.players.A.connection, connectionA);
  assert.equal(adapter.room.players.B, null);
  assert.equal(adapter.unavailable, false);
  assert.deepEqual(adapter.connectionsSnapshot(), [connectionA]);
  assert.equal(storage.values.get(ROOM_KEY).players.B, null);
  assert.equal(storage.values.has("attach-nonce:" + joinClaims.nonce), false);
});

test("Lobby initialization failures before or after Game persistence remove the hidden allocation", async () => {
  const { withInitializationRollback } = await authModule();
  for (const gamePersisted of [false, true]) {
    const lobby = new Map([["allocation", { status: "initializing" }]]);
    const game = new Map();
    const result = await withInitializationRollback(async () => {
      if (gamePersisted) game.set("receipt", { allocationId: "alloc-25" });
      throw new Error("simulated DO request failure");
    }, async () => { lobby.delete("allocation"); });
    assert.equal(result.ok, false);
    assert.equal(lobby.has("allocation"), false);
    assert.equal(game.has("receipt"), gamePersisted);
  }
});

test("wrong capability bindings and expiry never invoke the guarded mutation", async () => {
  const { issueCapability, verifyCapabilityTransaction, CAPABILITY_TTL_MS } = await authModule();
  const claims = { allocationId: "allocation-13", roomId: "ott-room-13", purpose: "attach", seat: "A", now: 30_000, ttlMs: 1000, nonce: "wrong-binding-nonce-00000001" };
  const token = await issueCapability("test-secret", claims);
  let mutationCount = 0;
  const transaction = async (callback) => callback({ get: async () => undefined, put: async () => undefined });
  const mutate = async () => { mutationCount++; return { accepted: true, value: true }; };
  const cases = [
    [{ allocationId: "other-allocation", roomId: claims.roomId, purpose: "attach" }, 30_001],
    [{ allocationId: claims.allocationId, roomId: "other-room", purpose: "attach" }, 30_001],
    [{ allocationId: claims.allocationId, roomId: claims.roomId, purpose: "game-init" }, 30_001],
    [{ allocationId: claims.allocationId, roomId: claims.roomId, purpose: "attach" }, 31_001],
  ];
  for (const [expected, now] of cases) {
    const result = await verifyCapabilityTransaction("test-secret", token, expected, transaction, mutate, { now });
    assert.equal(result.ok, false);
  }
  assert.equal(mutationCount, 0);

  const init = { allocationId: "allocation-14", roomId: "ott-room-14", purpose: "game-init", seat: "B", now: 40_000, ttlMs: 1000, nonce: "game-init-wrong-seat-nonce-001" };
  const wrongSeat = await issueCapability("test-secret", init);
  const wrongSeatResult = await verifyCapabilityTransaction("test-secret", wrongSeat, {
    allocationId: init.allocationId, roomId: init.roomId, purpose: "game-init", seat: "A",
  }, transaction, mutate, { now: 40_001 });
  assert.equal(wrongSeatResult.ok, false);

  const longLived = await issueCapability("test-secret", {
    allocationId: "allocation-15", roomId: "ott-room-15", purpose: "attach", seat: "A",
    now: 50_000, ttlMs: CAPABILITY_TTL_MS + 1, nonce: "overlong-lifetime-nonce-000001",
  });
  const lifetimeResult = await verifyCapabilityTransaction("test-secret", longLived, {
    allocationId: "allocation-15", roomId: "ott-room-15", purpose: "attach",
  }, transaction, mutate, { now: 50_001 });
  assert.equal(lifetimeResult.ok, false);
  assert.equal(lifetimeResult.reason, "lifetime");
  assert.equal(mutationCount, 0);
});

test("initialization retry receipt binds canonical identity and immutable payload", () => {
  assert.match(auth, /initializationPayloadHash/);
  assert.match(auth, /applyInitializationReceipt/);
  assert.match(auth, /previous\.allocationId === input\.allocationId/);
  assert.match(auth, /previous\.payloadHash === input\.payloadHash/);
  assert.match(game, /applyInitializationReceipt/);
  assert.match(game, /seat: "A"/);
  assert.match(game, /body\.roomId !== `ott-\$\{body\.allocationId\}`/);
  assert.match(lobby, /status: "initializing"/);
  assert.match(lobby, /creatorAttachDeadlineMs/);
  assert.match(lobby, /status === "waiting"/);
});

test("Lobby exposes only control routes and a public list projection", () => {
  assert.match(lobby, /create.*list.*join.*resume/);
  assert.match(lobby, /publicAllocation/);
  assert.match(lobby, /rooms: list\.filter/);
  assert.doesNotMatch(lobby, /ticket.*publicAllocation|capability.*publicAllocation|state.*publicAllocation/);
  assert.match(lobby, /OTT_INTERNAL_SECRET/);
  assert.match(lobby, /this\.env\.Main\.get\(this\.env\.Main\.idFromName\(allocation\.roomId\)\)/);
  assert.doesNotMatch(lobby, /OTT_GAME/);
  assert.match(lobby, /rate:last/);
});

test("Game rejects browser control bypass and validates attach through authority", () => {
  assert.match(game, /"\/ott\/create"/);
  assert.match(game, /"\/ott\/list"/);
  assert.match(game, /status: 404/);
  assert.match(game, /validateAttach/);
  assert.match(game, /verifyCapability/);
  assert.match(game, /attach-nonce/);
  assert.match(game, /OTT_INTERNAL_SECRET/);
  assert.match(game, /purpose: "attach"/);
  assert.match(game, /this\.attached\.has\(connection\)/);
});

test("Worker uses separate Lobby and Game DO bindings without a process registry", () => {
  assert.match(worker, /OTT_LOBBY/);
  assert.match(worker, /OTT_LOBBY/);
  assert.match(wrangler, /"class_name"\s*:\s*"OttLobbyServer"/);
  assert.match(wrangler, /"class_name"\s*:\s*"OttGameServer"/);
  assert.match(read("workers/worker-configuration.d.ts"), /OTT_INTERNAL_SECRET/);
  assert.doesNotMatch(worker, /new Map|process\./);
  assert.doesNotMatch(lobby, /new Map|process\./);
});
