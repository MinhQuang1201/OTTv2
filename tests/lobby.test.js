const test = require("node:test");
const assert = require("node:assert/strict");

const { WaitingRoomRegistry, sanitizeName } = require("../partykit/lobby");

function durableStorage() {
  const values = new Map();
  return {
    async get(key) {
      return values.get(key);
    },
    async put(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
    async list(options = {}) {
      return new Map([...values].filter(([key]) => !options.prefix || key.startsWith(options.prefix)));
    }
  };
}

test("sanitizes lobby names before they are stored or listed", () => {
  assert.equal(sanitizeName(" <b>Alice</b>   & friends "), "Alice & friends");
  assert.equal(sanitizeName(""), "Khách");
});

test("creates a unique four-character room and lists only its public waiting data", async () => {
  const registry = new WaitingRoomRegistry(durableStorage(), {
    random: () => 0
  });

  const created = await registry.create({ names: { A: " <b>Alice</b> ", B: "Bob" }, players: 1 });
  assert.match(created.id, /^[A-Z2-9]{4}$/);
  assert.deepEqual(await registry.list(), [
    { id: created.id, players: 1, names: { A: "Alice", B: "Bob" } }
  ]);
  assert.equal(JSON.stringify(await registry.list()).includes("token"), false);
  assert.equal(JSON.stringify(await registry.list()).includes("state"), false);
  assert.equal(JSON.stringify(await registry.list()).includes("connection"), false);
});

test("does not reuse a durable room id collision", async () => {
  const storage = durableStorage();
  let calls = 0;
  const registry = new WaitingRoomRegistry(storage, { random: () => (calls++ < 4 ? 0 : 0.1) });
  const first = await registry.create({ names: { A: "Alice" }, players: 1 });
  const second = await registry.create({ names: { A: "Bob" }, players: 1 });
  assert.notEqual(first.id, second.id);
});

test("filters non-waiting records and removes rooms on lifecycle changes", async () => {
  const registry = new WaitingRoomRegistry(durableStorage(), { random: () => Math.random() });
  const created = await registry.create({ names: { A: "Alice" }, players: 1 });
  await registry.update(created.id, { status: "playing", players: 2, names: { A: "Alice", B: "Bob" } });
  assert.deepEqual(await registry.list(), []);

  await registry.update(created.id, { status: "waiting", players: 1, names: { A: "Alice" } });
  assert.equal((await registry.list()).length, 1);
  await registry.remove(created.id);
  assert.deepEqual(await registry.list(), []);
});

test("publishes lifecycle membership changes through the room hook", async () => {
  const calls = [];
  const registry = {
    create: async (room) => calls.push(["create", room]),
    update: async (id, room) => calls.push(["update", id, room]),
    remove: async (id) => calls.push(["remove", id])
  };
  const { createLobbyLifecycle } = require("../partykit/ott-room");
  const lifecycle = createLobbyLifecycle(registry);

  await lifecycle.created({ names: { A: "Alice" }, players: 1 });
  await lifecycle.started("ABCD");
  await lifecycle.left("EFGH", { players: 1 });
  await lifecycle.graceExpired("IJKL");
  await lifecycle.cleanedUp("MNOP");

  assert.deepEqual(calls.map(([type, id]) => [type, id]), [
    ["create", { names: { A: "Alice" }, players: 1 }],
    ["remove", "ABCD"],
    ["update", "EFGH"],
    ["remove", "IJKL"],
    ["remove", "MNOP"]
  ]);
});
