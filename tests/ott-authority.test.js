const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const auth = read("apps/worker/src/auth/internal-auth.ts");
const lobby = read("apps/worker/src/lobby/ott-lobby-server.ts");
const game = read("apps/worker/src/game/ott-game-server.ts");
const roomStorage = read("apps/worker/src/persistence/room-storage.ts");
const worker = read("apps/worker/src/entry/ott-worker.ts");
const wrangler = read("apps/worker/wrangler.jsonc");

let loadedAuth;
let loadedRoomStorage;
let loadedGame;
async function authModule() {
  if (!loadedAuth) {
    const { transformSync } = require("esbuild");
    const { code } = transformSync(read("apps/worker/src/auth/internal-auth.ts"), { loader: "ts", format: "esm" });
    loadedAuth = import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  }
  return loadedAuth;
}
async function roomStorageModule() {
  if (!loadedRoomStorage) {
    const { buildSync } = require("esbuild");
    const Module = require("node:module");
    const { outputFiles } = buildSync({
      entryPoints: [path.join(root, "apps", "worker", "src", "persistence", "room-storage.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false,
    });
    const filename = path.join(root, "apps", "worker", "src", "persistence", "room-storage-test-bundle.cjs");
    const bundledModule = new Module(filename, module);
    bundledModule.filename = filename;
    bundledModule.paths = Module._nodeModulePaths(root);
    bundledModule._compile(outputFiles[0].text, filename);
    loadedRoomStorage = Promise.resolve(bundledModule.exports);
  }
  return loadedRoomStorage;
}

async function gameModule() {
  if (!loadedGame) {
    const { build } = require("esbuild");
    const Module = require("node:module");
    const { outputFiles } = await build({
      entryPoints: [path.join(root, "apps", "worker", "src", "game", "ott-game-server.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      plugins: [{
        name: "task6-yserver-test-double",
        setup(build) {
          build.onResolve({ filter: /^y-partyserver$/ }, () => ({ path: "task6-yserver-test-double", namespace: "task6" }));
          build.onLoad({ filter: /.*/, namespace: "task6" }, () => ({ contents: `
            export class YServer {
              constructor(ctx, env) { this.ctx = ctx; this.env = env; }
              onConnect() {}
              onMessage() {}
              onClose() {}
              sendCustomMessage(connection, message) { connection.send?.(message); }
              fetch() { return Promise.resolve(new Response("Not found", { status: 404 })); }
            }
          `, loader: "js" }));
        },
      }],
      write: false,
    });
    const filename = path.join(root, "apps", "worker", "src", "game", "ott-game-server-task6-test.cjs");
    const bundledModule = new Module(filename, module);
    bundledModule.filename = filename;
    bundledModule.paths = Module._nodeModulePaths(root);
    bundledModule._compile(outputFiles[0].text, filename);
    loadedGame = bundledModule.exports;
  }
  return loadedGame;
}

function gameFixture(prototype, roomId = "ott-room-task6") {
  const values = new Map([
    ["allocationId", "allocation-task6"],
    ["roomId", roomId],
  ]);
  const messages = [];
  const storage = {
    async get(key) { return values.get(key); },
    async put(key, value) {
      if (this.failPutKey === key) throw new Error("storage put failed");
      values.set(key, value);
    },
    async delete(key) {
      if (this.failDelete) throw new Error("storage delete failed");
      values.delete(key);
    },
    async transaction(callback) {
      if (this.failTransaction) throw new Error("transaction failed");
      const pending = new Map(values);
      const result = await callback({
        get: async (key) => pending.get(key),
        put: async (key, value) => pending.set(key, value),
        delete: async (key) => pending.delete(key),
      });
      values.clear();
      for (const [key, value] of pending) values.set(key, value);
      return result;
    },
    failDelete: false,
    failPutKey: undefined,
    failTransaction: false,
  };
  const server = Object.create(prototype);
  server.ctx = { storage };
  server.ottEnv = { OTT_INTERNAL_SECRET: "test-secret" };
  server.lastOttPacketMs = new Map();
  server.identities = new Map();
  server.pendingIdentities = new Map();
  server.roleReservations = new Map();
  server.connectionGenerations = new Map();
  server.closedConnections = new WeakSet();
  server.roomOperationTail = Promise.resolve();
  server.identityNonces = new Map();
  server.attachCapabilities = new Map();
  server.sendCustomMessage = (_connection, message) => messages.push(JSON.parse(message));
  return { values, storage, server, messages };
}

function connection(id) {
  let attachment = null;
  return {
    id,
    serializeAttachment(value) { attachment = value; },
    deserializeAttachment() { return attachment; },
    close() {},
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((finish) => { resolve = finish; });
  return { promise, resolve };
}

function roomPayload(roomId, revision) {
  return {
    roomId,
    status: "playing",
    serverNow: 100,
    revision,
    players: { A: null, B: null },
    state: { turn: "A" },
    events: [],
  };
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

test("capability types preserve player and spectator payload narrowing", () => {
  assert.match(auth, /export type CapabilityPayload = PlayerCapability/);
  assert.match(auth, /TransactionalPlayerCapabilityVerification/);
  assert.match(auth, /TransactionalSpectatorCapabilityVerification/);
  assert.match(auth, /Promise<TransactionalPlayerCapabilityVerification<T>>/);
  assert.match(auth, /Promise<TransactionalSpectatorCapabilityVerification<T>>/);
});

test("capability overloads expose the union-typed compatibility path", () => {
  assert.match(auth, /expected: CapabilityExpectations,[\s\S]*?now\?: number,[\s\S]*?\): Promise<CapabilityPayloadVariant \| null>;/);
  assert.match(auth, /expected: CapabilityExpectations,[\s\S]*?\): Promise<CapabilityVerification>;/);
  assert.match(auth, /expected: CapabilityExpectations,[\s\S]*?mutate: \(payload: CapabilityPayloadVariant,[\s\S]*?\): Promise<TransactionalCapabilityVerification<T>>;/);
});

test("spectator v2 capabilities are seatless, variant-bound, and replay-safe", async () => {
  const { issueCapability, verifyCapability, verifyCapabilityTransaction } = await authModule();
  const allocationId = "allocation-spectator-1";
  const roomId = "ott-room-spectator-1";
  const spectatorClaims = {
    allocationId,
    roomId,
    purpose: "spectate",
    role: "spectator",
    now: 60_000,
    ttlMs: 60_000,
    nonce: "spectate-roundtrip-nonce-0001",
  };
  const spectatorToken = await issueCapability("test-secret", spectatorClaims);
  const decoded = JSON.parse(Buffer.from(spectatorToken.split(".")[0], "base64url").toString("utf8"));
  assert.deepEqual(decoded, ["ott-cap-v2", allocationId, roomId, "spectate", "spectator", 60_000, 120_000, spectatorClaims.nonce]);

  const spectatorExpected = { allocationId, roomId, purpose: "spectate", role: "spectator" };
  assert.equal((await verifyCapability("test-secret", spectatorToken, spectatorExpected, 60_001)).v, "ott-cap-v2");
  assert.equal(await verifyCapability("test-secret", spectatorToken, { allocationId, roomId, purpose: "attach" }, 60_001), null);
  assert.equal(await verifyCapability("test-secret", spectatorToken, { allocationId, roomId: "other-room", purpose: "spectate", role: "spectator" }, 60_001), null);

  const playerToken = await issueCapability("test-secret", {
    allocationId,
    roomId,
    purpose: "attach",
    seat: "A",
    now: 60_000,
    nonce: "player-variant-nonce-000001",
  });
  assert.equal(await verifyCapability("test-secret", playerToken, spectatorExpected, 60_001), null);
  assert.equal(await verifyCapability("test-secret", spectatorToken, spectatorExpected, 120_000), null, "expired spectator token");
  assert.equal(await verifyCapability("wrong-secret", spectatorToken, spectatorExpected, 60_001), null, "invalid signature");

  class MemoryDO {
    values = new Map();
    tail = Promise.resolve();
    transaction(callback) {
      const run = async () => {
        const pending = new Map(this.values);
        const result = await callback({
          get: async (key) => pending.get(key),
          put: async (key, value) => pending.set(key, value),
        });
        this.values = pending;
        return result;
      };
      const next = this.tail.then(run, run);
      this.tail = next.then(() => undefined, () => undefined);
      return next;
    }
  }
  const store = new MemoryDO();
  const mutate = async (_payload, tx) => {
    const count = await tx.get("spectator-mutations") ?? 0;
    await tx.put("spectator-mutations", count + 1);
    return { accepted: true, value: count + 1 };
  };
  const [first, second] = await Promise.all([
    verifyCapabilityTransaction("test-secret", spectatorToken, spectatorExpected, store.transaction.bind(store), mutate, { now: 60_001, noncePrefix: "spectate-nonce" }),
    verifyCapabilityTransaction("test-secret", spectatorToken, spectatorExpected, store.transaction.bind(store), mutate, { now: 60_001, noncePrefix: "spectate-nonce" }),
  ]);
  assert.deepEqual([first.ok, second.ok].sort(), [false, true]);
  assert.equal(store.values.get("spectator-mutations"), 1);
  assert.equal(store.values.get("spectate-nonce:" + spectatorClaims.nonce), 120_000);
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
  assert.match(game, /this\.identities\.get\(connection\)/);
});

test("Game uses one immutable role identity and checks it before capability verification", () => {
  assert.match(game, /identit(?:y|ies)/);
  assert.match(game, /pending.*role|role.*pending/);
  assert.match(game, /spectate-nonce/);
  assert.match(game, /existingIdentity[\s\S]*?verifyCapabilityTransaction/);
  assert.match(game, /role: "spectator"/);
  assert.match(game, /role: "player"/);
  assert.doesNotMatch(game, /this\.attached\.has\(connection\)/);
});

test("Game terminal handling sends committed state before Lobby terminalization", () => {
  assert.match(game, /terminalReason/);
  assert.match(game, /broadcastState[\s\S]*?terminalizeAllocation/);
  assert.match(game, /markTerminalized/);
  assert.doesNotMatch(game, /DurableRoomAdapter\.(load|create)\([^;]*terminalizeAllocation/);
});

test("Room storage never performs Lobby terminalization", () => {
  assert.doesNotMatch(roomStorage, /terminalizeAllocation/);
  assert.match(roomStorage, /CommittedRoomOutcome/);
});

test("spectator role is immutable, read-only, nonce-safe, and counted from authenticated live identity", async () => {
  const { OttGameServer } = await gameModule();
  const { issueCapability } = await authModule();
  const fixture = gameFixture(OttGameServer.prototype);
  const adapter = {
    roomId: "ott-room-task6",
    room: { revision: 4, status: "playing", state: {} },
    lastPayload: {
      roomId: "ott-room-task6", status: "playing", serverNow: 100, revision: 4,
      players: { A: { name: "Alice", connected: true }, B: { name: "Bob", connected: true } },
      state: { turn: "A" }, events: [],
    },
    moveCalls: 0,
    leaveCalls: 0,
    closeCalls: 0,
    async move() { this.moveCalls += 1; throw new Error("spectator move reached adapter"); },
    async leave() { this.leaveCalls += 1; throw new Error("spectator leave reached adapter"); },
    async close() { this.closeCalls += 1; throw new Error("spectator close reached adapter"); },
    async scheduleAlarm() {},
    async markTerminalized() {},
  };
  fixture.server.roomLoad = Promise.resolve(adapter);
  const first = connection("spectator-1");
  const firstNonce = "spectator-role-first-nonce-001";
  const firstToken = await issueCapability("test-secret", {
    allocationId: "allocation-task6", roomId: "ott-room-task6", purpose: "spectate", role: "spectator", nonce: firstNonce,
  });

  await fixture.server.dispatchOttMessage(first, JSON.stringify({ __ott: true, roomId: "ott-room-task6", type: "ott:spectate", ticket: firstToken }));
  assert.deepEqual(fixture.server.identities.get(first), { role: "spectator" });
  assert.equal(fixture.values.get(`spectate-nonce:${firstNonce}`) > 0, true);
  assert.deepEqual(fixture.messages.at(-1).state.viewer, { role: "spectator" });
  assert.equal(fixture.messages.at(-1).state.spectatorCount, 1);

  const secondNonce = "spectator-role-second-nonce-01";
  const secondToken = await issueCapability("test-secret", {
    allocationId: "allocation-task6", roomId: "ott-room-task6", purpose: "spectate", role: "spectator", nonce: secondNonce,
  });
  fixture.server.lastOttPacketMs.delete(first);
  await fixture.server.dispatchOttMessage(first, JSON.stringify({ __ott: true, roomId: "ott-room-task6", type: "ott:spectate", ticket: secondToken }));
  assert.equal(fixture.values.has(`spectate-nonce:${secondNonce}`), false, "duplicate spectate must not consume another nonce");
  assert.equal(fixture.messages.at(-1).error, "connection_role_already_fixed");

  for (const command of [
    { __ott: true, roomId: "ott-room-task6", type: "ott:move", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } },
    { __ott: true, roomId: "ott-room-task6", type: "ott:leave" },
  ]) {
    fixture.server.lastOttPacketMs.delete(first);
    await fixture.server.dispatchOttMessage(first, JSON.stringify(command));
    assert.equal(fixture.messages.at(-1).error, "spectator_read_only");
  }
  assert.equal(adapter.moveCalls, 0);
  assert.equal(adapter.leaveCalls, 0);
  assert.equal(adapter.room.revision, 4);

  const second = connection("spectator-2");
  const secondAttachToken = await issueCapability("test-secret", {
    allocationId: "allocation-task6", roomId: "ott-room-task6", purpose: "spectate", role: "spectator", nonce: "spectator-role-third-nonce-1",
  });
  await fixture.server.dispatchOttMessage(second, JSON.stringify({ __ott: true, roomId: "ott-room-task6", type: "ott:spectate", ticket: secondAttachToken }));
  assert.equal(fixture.messages.at(-1).state.spectatorCount, 2);

  fixture.server.sendCustomMessage = () => { throw new Error("send failed"); };
  await fixture.server.broadcastState(adapter);
  assert.deepEqual(fixture.server.identities.get(first), { role: "spectator" }, "send failure must not revoke presence");
  fixture.server.sendCustomMessage = (_connection, message) => fixture.messages.push(JSON.parse(message));

  await fixture.server.handleClose(first, { role: "spectator" });
  assert.equal(adapter.closeCalls, 0);
  assert.equal(fixture.server.identities.has(first), false);
  assert.equal(fixture.messages.at(-1).state.spectatorCount, 1);
});

test("role reservation rejects a mixed spectator command before delayed player validation completes", async () => {
  const { OttGameServer } = await gameModule();
  const { issueCapability } = await authModule();
  const fixture = gameFixture(OttGameServer.prototype);
  const validationStarted = deferred();
  const releaseValidation = deferred();
  fixture.server.authority = {
    async validateAttach() {
      validationStarted.resolve();
      await releaseValidation.promise;
      fixture.server.attachCapabilities.set(player, {
        seat: "A", nonce: "role-reservation-player-01", expiresAt: Date.now() + 60_000, token: playerToken,
      });
      return { seat: "A" };
    },
  };
  fixture.server.roomLoad = Promise.resolve({
    roomId: "ott-room-task6", room: { revision: 4, status: "playing", state: {} },
    lastPayload: { roomId: "ott-room-task6", status: "playing", serverNow: 100, revision: 4, players: { A: null, B: null }, state: {}, events: [] },
    async attach() { return { ok: true, seat: "A" }; },
    async scheduleAlarm() {},
    forget() {},
    async reloadPersisted() {},
  });
  const player = connection("role-reservation-player");
  const playerToken = await issueCapability("test-secret", {
    allocationId: "allocation-task6", roomId: "ott-room-task6", purpose: "attach", seat: "A", nonce: "role-reservation-player-01",
  });
  const spectatorToken = await issueCapability("test-secret", {
    allocationId: "allocation-task6", roomId: "ott-room-task6", purpose: "spectate", role: "spectator", nonce: "role-reservation-spectator-01",
  });

  const playerAttach = fixture.server.dispatchOttMessage(player, JSON.stringify({
    __ott: true, roomId: "ott-room-task6", type: "ott:attach", ticket: playerToken,
  }));
  await validationStarted.promise;
  fixture.server.lastOttPacketMs.delete(player);
  await fixture.server.dispatchOttMessage(player, JSON.stringify({
    __ott: true, roomId: "ott-room-task6", type: "ott:spectate", ticket: spectatorToken,
  }));

  assert.equal(fixture.values.has("spectate-nonce:role-reservation-spectator-01"), false);
  assert.equal(fixture.messages.at(-1).error, "connection_role_already_fixed");

  releaseValidation.resolve();
  await playerAttach;
  assert.deepEqual(fixture.server.identities.get(player), { role: "player", seat: "A" });
});

test("close invalidates a delayed spectator promotion before transaction completion", async () => {
  const { OttGameServer } = await gameModule();
  const { issueCapability } = await authModule();
  const fixture = gameFixture(OttGameServer.prototype);
  const transactionStarted = deferred();
  const releaseTransaction = deferred();
  const closeFinished = deferred();
  const originalTransaction = fixture.storage.transaction.bind(fixture.storage);
  fixture.storage.transaction = async (callback) => {
    transactionStarted.resolve();
    await releaseTransaction.promise;
    return originalTransaction(callback);
  };
  fixture.server.roomLoad = Promise.resolve({
    roomId: "ott-room-task6", room: { revision: 4, status: "playing", state: {} },
    lastPayload: { roomId: "ott-room-task6", status: "playing", serverNow: 100, revision: 4, players: { A: null, B: null }, state: {}, events: [] },
  });
  fixture.server.broadcastState = async () => { closeFinished.resolve(); };
  const spectator = connection("close-during-spectator-attach");
  const nonce = "close-during-spectator-attach-01";
  const token = await issueCapability("test-secret", {
    allocationId: "allocation-task6", roomId: "ott-room-task6", purpose: "spectate", role: "spectator", nonce,
  });

  const attach = fixture.server.dispatchOttMessage(spectator, JSON.stringify({
    __ott: true, roomId: "ott-room-task6", type: "ott:spectate", ticket: token,
  }));
  await transactionStarted.promise;
  fixture.server.onClose(spectator, 1000, "closed", true);
  assert.equal(fixture.server.identities.has(spectator), false);
  assert.equal(fixture.server.roleReservations.has(spectator), false);

  releaseTransaction.resolve();
  await attach;
  await closeFinished.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.server.identities.has(spectator), false);
  assert.equal(fixture.server.pendingIdentities.has(spectator), false);
  assert.equal(fixture.values.has("live-attachment:close-during-spectator-attach"), false);
  assert.equal(fixture.values.has(`spectate-nonce:${nonce}`), true);
  assert.equal(fixture.server.connectionGenerations.has(spectator), false);
});

test("player attachment serialization failure compensates the committed Room seat", async () => {
  const { OttGameServer } = await gameModule();
  const { issueCapability } = await authModule();
  const fixture = gameFixture(OttGameServer.prototype);
  const adapter = {
    roomId: "ott-room-task6",
    room: { revision: 1, status: "playing", state: {} },
    lastPayload: roomPayload("ott-room-task6", 1),
    attached: null,
    rollbackCalls: 0,
    async attach(connection) {
      this.attached = connection;
      return { ok: true, seat: "A" };
    },
    async scheduleAlarm() {},
    async rollbackAttach(connection) {
      assert.equal(this.attached, connection);
      this.rollbackCalls += 1;
      this.attached = null;
      this.lastPayload = roomPayload("ott-room-task6", 2);
      return { result: { ok: true }, payload: this.lastPayload, terminalReason: null };
    },
    commitAttach() {},
  };
  fixture.server.roomLoad = Promise.resolve(adapter);
  let closed = false;
  const player = { id: "player-serialization-failure", serializeAttachment() { throw new Error("attachment serialization failed"); }, close() { closed = true; } };
  const token = await issueCapability("test-secret", {
    allocationId: "allocation-task6", roomId: "ott-room-task6", purpose: "attach", seat: "A", nonce: "player-serialization-failure-01",
  });

  await fixture.server.dispatchOttMessage(player, JSON.stringify({
    __ott: true, roomId: "ott-room-task6", type: "ott:attach", ticket: token,
  }));

  assert.equal(adapter.rollbackCalls, 1);
  assert.equal(adapter.attached, null);
  assert.equal(fixture.server.identities.has(player), false);
  assert.equal(fixture.server.pendingIdentities.has(player), false);
  assert.equal(closed, true);
});

test("real adapter attach rollback restores persistence and permits a later A attach", async () => {
  const { OttGameServer } = await gameModule();
  const { DurableRoomAdapter, ROOM_KEY } = await roomStorageModule();
  const { issueCapability } = await authModule();
  const fixture = gameFixture(OttGameServer.prototype);
  fixture.values.set("creatorName", "Alice");
  const adapter = await DurableRoomAdapter.create("ott-room-task6", fixture.storage, () => 100);
  fixture.server.roomLoad = Promise.resolve(adapter);
  let closeCalls = 0;
  const failedPlayer = {
    id: "real-adapter-failed-player",
    serializeAttachment() { throw new Error("attachment serialization failed"); },
    close() { closeCalls += 1; },
  };
  const failedToken = await issueCapability("test-secret", {
    allocationId: "allocation-task6", roomId: "ott-room-task6", purpose: "attach", seat: "A", nonce: "real-adapter-failed-attach-01",
  });

  await fixture.server.dispatchOttMessage(failedPlayer, JSON.stringify({
    __ott: true, roomId: "ott-room-task6", type: "ott:attach", ticket: failedToken,
  }));

  assert.equal(closeCalls, 1);
  assert.equal(adapter.room.players.A, null);
  assert.equal((await fixture.storage.get(ROOM_KEY)).players.A, null);
  assert.deepEqual(adapter.connectionsSnapshot(), []);

  const validPlayer = connection("real-adapter-valid-player");
  const validToken = await issueCapability("test-secret", {
    allocationId: "allocation-task6", roomId: "ott-room-task6", purpose: "attach", seat: "A", nonce: "real-adapter-valid-attach-01",
  });
  await fixture.server.dispatchOttMessage(validPlayer, JSON.stringify({
    __ott: true, roomId: "ott-room-task6", type: "ott:attach", ticket: validToken,
  }));

  assert.equal(adapter.room.players.A.connection, validPlayer);
  assert.deepEqual(adapter.connectionsSnapshot(), [validPlayer]);
  assert.deepEqual(fixture.server.identities.get(validPlayer), { role: "player", seat: "A" });
});

test("room operations serialize move, leave, and alarm payload revisions", async () => {
  const { OttGameServer } = await gameModule();
  const fixture = gameFixture(OttGameServer.prototype);
  const moveStarted = deferred();
  const releaseMove = deferred();
  const calls = [];
  const adapter = {
    roomId: "ott-room-task6",
    room: { revision: 1, status: "playing", state: {} },
    lastPayload: roomPayload("ott-room-task6", 1),
    async move() {
      calls.push("move-start");
      moveStarted.resolve();
      await releaseMove.promise;
      calls.push("move-end");
      return { result: { ok: true }, payload: roomPayload("ott-room-task6", 10), terminalReason: null };
    },
    async leave() {
      calls.push("leave");
      return { result: { ok: true }, payload: roomPayload("ott-room-task6", 11), terminalReason: null };
    },
    async onAlarm() {
      calls.push("alarm");
      return { result: { ok: true }, payload: roomPayload("ott-room-task6", 12), terminalReason: null };
    },
  };
  fixture.server.roomLoad = Promise.resolve(adapter);
  const player = connection("ordered-player");
  fixture.server.identities.set(player, { role: "player", seat: "A" });
  fixture.server.onCustomMessage(player, JSON.stringify({
    __ott: true, roomId: "ott-room-task6", type: "ott:move", from: { x: 0, y: 0 }, to: { x: 1, y: 1 },
  }));
  await moveStarted.promise;
  fixture.server.lastOttPacketMs.delete(player);
  fixture.server.onCustomMessage(player, JSON.stringify({
    __ott: true, roomId: "ott-room-task6", type: "ott:leave",
  }));
  const alarm = fixture.server.onAlarm();
  await Promise.resolve();
  assert.deepEqual(calls, ["move-start"]);

  releaseMove.resolve();
  await Promise.all([fixture.server.roomOperationTail, alarm]);
  assert.deepEqual(calls, ["move-start", "move-end", "leave", "alarm"]);
  const states = fixture.messages.filter((message) => message.type === "ott:state");
  assert.deepEqual(states.map((message) => [message.revision, message.state.revision]), [[10, 10], [11, 11], [12, 12]]);
});

test("spectator attach fans out the updated count to existing players and spectators", async () => {
  const { OttGameServer } = await gameModule();
  const { issueCapability } = await authModule();
  const fixture = gameFixture(OttGameServer.prototype);
  const existingSpectator = connection("existing-spectator");
  const existingPlayer = connection("existing-player");
  fixture.server.identities.set(existingSpectator, { role: "spectator" });
  fixture.server.identityNonces.set(existingSpectator, "existing-spectator-nonce");
  fixture.values.set("spectate-nonce:existing-spectator-nonce", Date.now() + 60_000);
  fixture.server.identities.set(existingPlayer, { role: "player", seat: "A" });
  fixture.server.roomLoad = Promise.resolve({
    roomId: "ott-room-task6", room: { revision: 3, status: "playing", state: {} },
    lastPayload: roomPayload("ott-room-task6", 3),
  });
  fixture.server.sendCustomMessage = (connection, message) => fixture.messages.push({ connection: connection.id, ...JSON.parse(message) });
  const newSpectator = connection("new-spectator");
  const token = await issueCapability("test-secret", {
    allocationId: "allocation-task6", roomId: "ott-room-task6", purpose: "spectate", role: "spectator", nonce: "new-spectator-nonce",
  });

  await fixture.server.dispatchOttMessage(newSpectator, JSON.stringify({
    __ott: true, roomId: "ott-room-task6", type: "ott:spectate", ticket: token,
  }));

  const states = fixture.messages.filter((message) => message.type === "ott:state");
  assert.deepEqual(states.map((message) => message.connection).sort(), ["existing-player", "existing-spectator", "new-spectator"]);
  assert.deepEqual(states.map((message) => message.state.spectatorCount), [2, 2, 2]);
});

test("terminal projection failure schedules cleanup retry without marking Lobby complete", async () => {
  const { OttGameServer } = await gameModule();
  const fixture = gameFixture(OttGameServer.prototype);
  const calls = [];
  fixture.server.broadcastState = async () => { throw new Error("projection failed"); };
  fixture.server.terminalizeAllocation = async () => calls.push("lobby");
  const adapter = {
    roomId: "ott-room-task6",
    room: { revision: 4 },
    async markTerminalized() { calls.push("marker"); },
    async scheduleTerminalRetry(reason) { calls.push(["retry", reason]); },
  };

  await fixture.server.publishCommitted(adapter, {
    result: { ok: true },
    payload: roomPayload("ott-room-task6", 4),
    terminalReason: "goal",
  });

  assert.deepEqual(calls, [["retry", "goal"]]);
});

test("bundled terminal send failure retries before Lobby cleanup and marker", async () => {
  const { OttGameServer } = await gameModule();
  const fixture = gameFixture(OttGameServer.prototype);
  const spectator = connection("terminal-send-retry-spectator");
  fixture.server.identities.set(spectator, { role: "spectator" });
  fixture.server.identityNonces.set(spectator, "terminal-send-retry-nonce");
  fixture.values.set("spectate-nonce:terminal-send-retry-nonce", Date.now() + 60_000);
  const calls = [];
  const adapter = {
    roomId: "ott-room-task6",
    room: { revision: 4 },
    async scheduleTerminalRetry(reason) { calls.push(["retry", reason]); },
    async markTerminalized() { calls.push("marker"); },
  };
  const outcome = { result: { ok: true }, payload: roomPayload("ott-room-task6", 4), terminalReason: "goal" };
  fixture.server.terminalizeAllocation = async () => calls.push("lobby");
  fixture.server.sendCustomMessage = () => { throw new Error("recipient send failed"); };

  await fixture.server.publishCommitted(adapter, outcome);
  assert.deepEqual(calls, [["retry", "goal"]]);

  fixture.server.sendCustomMessage = (_connection, message) => {
    calls.push(JSON.parse(message).type);
  };
  await fixture.server.publishCommitted(adapter, outcome);
  assert.deepEqual(calls, [["retry", "goal"], "ott:state", "lobby", "marker"]);
});

test("spectator promotion requires attachment serialization and cannot reuse a failed role", async () => {
  const { OttGameServer } = await gameModule();
  const { issueCapability } = await authModule();
  const fixture = gameFixture(OttGameServer.prototype);
  fixture.server.roomLoad = Promise.resolve({
    roomId: "ott-room-task6",
    room: { revision: 4, status: "playing", state: {} },
    lastPayload: {
      roomId: "ott-room-task6", status: "playing", serverNow: 100, revision: 4,
      players: { A: null, B: null }, state: { turn: "A" }, events: [],
    },
  });
  const nonce = "spectator-missing-serializer-01";
  const token = await issueCapability("test-secret", {
    allocationId: "allocation-task6", roomId: "ott-room-task6", purpose: "spectate", role: "spectator", nonce,
  });
  let closed = false;
  const missingSerializer = { id: "missing-serializer", close() { closed = true; } };

  await fixture.server.dispatchOttMessage(missingSerializer, JSON.stringify({
    __ott: true, roomId: "ott-room-task6", type: "ott:spectate", ticket: token,
  }));

  assert.equal(fixture.server.identities.has(missingSerializer), false);
  assert.equal(fixture.values.has("live-attachment:missing-serializer"), false);
  assert.equal(fixture.values.has(`spectate-nonce:${nonce}`), true);
  assert.equal(closed, true);
});

test("spectator transaction and compensation failures leave no reusable authenticated role", async () => {
  const { OttGameServer } = await gameModule();
  const { issueCapability } = await authModule();
  const fixture = gameFixture(OttGameServer.prototype);
  fixture.server.roomLoad = Promise.resolve({
    roomId: "ott-room-task6", room: { revision: 4, status: "playing", state: {} },
    lastPayload: { roomId: "ott-room-task6", status: "playing", serverNow: 100, revision: 4, players: { A: null, B: null }, state: {}, events: [] },
  });
  const failedTransaction = connection("spectator-transaction-failure");
  fixture.storage.failTransaction = true;
  const transactionToken = await issueCapability("test-secret", {
    allocationId: "allocation-task6", roomId: "ott-room-task6", purpose: "spectate", role: "spectator", nonce: "spectator-transaction-failure-01",
  });
  await fixture.server.dispatchOttMessage(failedTransaction, JSON.stringify({ __ott: true, roomId: "ott-room-task6", type: "ott:spectate", ticket: transactionToken }));
  assert.equal(fixture.server.identities.has(failedTransaction), false);

  fixture.storage.failTransaction = false;
  fixture.storage.failPutKey = "live-attachment:spectator-compensation-failure";
  fixture.storage.failDelete = true;
  let closed = false;
  const failedCompensation = { ...connection("spectator-compensation-failure"), close() { closed = true; } };
  const compensationToken = await issueCapability("test-secret", {
    allocationId: "allocation-task6", roomId: "ott-room-task6", purpose: "spectate", role: "spectator", nonce: "spectator-compensation-failure-01",
  });
  await fixture.server.dispatchOttMessage(failedCompensation, JSON.stringify({ __ott: true, roomId: "ott-room-task6", type: "ott:spectate", ticket: compensationToken }));
  assert.equal(fixture.server.identities.has(failedCompensation), false);
  assert.equal(closed, true);
});

test("spectator initial send failure retains the authenticated identity", async () => {
  const { OttGameServer } = await gameModule();
  const { issueCapability } = await authModule();
  const fixture = gameFixture(OttGameServer.prototype);
  fixture.server.roomLoad = Promise.resolve({
    roomId: "ott-room-task6", room: { revision: 4, status: "playing", state: {} },
    lastPayload: { roomId: "ott-room-task6", status: "playing", serverNow: 100, revision: 4, players: { A: null, B: null }, state: {}, events: [] },
  });
  const spectator = connection("spectator-initial-send-failure");
  let closed = false;
  spectator.close = () => { closed = true; };
  fixture.server.sendCustomMessage = () => { throw new Error("send failed"); };
  const token = await issueCapability("test-secret", {
    allocationId: "allocation-task6", roomId: "ott-room-task6", purpose: "spectate", role: "spectator", nonce: "spectator-initial-send-failure-01",
  });

  await fixture.server.dispatchOttMessage(spectator, JSON.stringify({ __ott: true, roomId: "ott-room-task6", type: "ott:spectate", ticket: token }));

  assert.deepEqual(fixture.server.identities.get(spectator), { role: "spectator" });
  assert.equal(closed, false);
});

test("committed terminal projection is sent before Lobby cleanup and marker persistence", async () => {
  const { OttGameServer } = await gameModule();
  const fixture = gameFixture(OttGameServer.prototype);
  const spectator = connection("terminal-spectator");
  const order = [];
  fixture.server.identities.set(spectator, { role: "spectator" });
  fixture.server.identityNonces.set(spectator, "terminal-spectator-nonce-01");
  fixture.values.set("spectate-nonce:terminal-spectator-nonce-01", Date.now() + 10_000);
  fixture.server.sendCustomMessage = (_connection, message) => {
    const parsed = JSON.parse(message);
    order.push(parsed.type);
    if (parsed.type === "ott:state") fixture.values.set("terminalProjection", parsed);
  };
  fixture.server.terminalizeAllocation = async () => order.push("lobby-terminalize");
  const adapter = {
    roomId: "ott-room-task6",
    room: { revision: 9 },
    lastPayload: {
      roomId: "ott-room-task6", status: "finished", serverNow: 100, revision: 9,
      players: { A: null, B: null }, state: { winner: "A" }, events: [],
    },
    async markTerminalized() { order.push("terminal-marker"); },
    async scheduleAlarm() { order.push("retry-alarm"); },
  };

  await fixture.server.publishCommitted(adapter, {
    result: { ok: true },
    payload: { ...adapter.lastPayload, revision: 77, state: { winner: "B" } },
    terminalReason: "goal",
  });
  assert.deepEqual(order, ["ott:state", "lobby-terminalize", "terminal-marker"]);
  assert.equal(fixture.values.get("terminalProjection").state.revision, 77);

  const retryOrder = [];
  fixture.server.sendCustomMessage = () => retryOrder.push("ott:state");
  fixture.server.terminalizeAllocation = async () => { retryOrder.push("lobby-terminalize"); throw new Error("Lobby unavailable"); };
  const retryAdapter = {
    ...adapter,
    async markTerminalized() { retryOrder.push("terminal-marker"); },
    async scheduleTerminalRetry(reason) {
      retryOrder.push("retry-alarm");
      fixture.values.set("terminalRetryReason", reason);
    },
  };
  await fixture.server.publishCommitted(retryAdapter, {
    result: { ok: true },
    payload: retryAdapter.lastPayload,
    terminalReason: "goal",
  });
  assert.deepEqual(retryOrder, ["ott:state", "lobby-terminalize", "retry-alarm"]);
  assert.equal(fixture.values.get("terminalRetryReason"), "goal");
});

test("Worker uses separate Lobby and Game DO bindings without a process registry", () => {
  assert.match(worker, /OTT_LOBBY/);
  assert.match(worker, /OTT_LOBBY/);
  assert.match(wrangler, /"class_name"\s*:\s*"OttLobbyServer"/);
  assert.match(wrangler, /"class_name"\s*:\s*"OttGameServer"/);
  assert.match(read("apps/worker/worker-configuration.d.ts"), /OTT_INTERNAL_SECRET/);
  assert.doesNotMatch(worker, /new Map|process\./);
  assert.doesNotMatch(lobby, /new Map|process\./);
});
