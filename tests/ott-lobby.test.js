const test = require("node:test");
const assert = require("node:assert/strict");

const { OttLobby, routeToGame } = require("../partykit/ott-lobby");
const { publicPath } = require("../server");

function storage() {
  const values = new Map();
  return {
    values,
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    async list(options = {}) {
      return new Map([...values].filter(([key]) => !options.prefix || key.startsWith(options.prefix)));
    }
  };
}

function connection(id) {
  const inbox = [];
  return { id, inbox, send(value) { inbox.push(JSON.parse(value)); } };
}

function partyContext(game = {}) {
  const calls = [];
  return {
    calls,
    context: {
      parties: {
        game: {
          get(id) {
            calls.push(["get", id]);
            return game;
          }
        }
      }
    }
  };
}

function response(body) {
  return { ok: true, status: 200, async json() { return body; } };
}

function createGameStub() {
  const listeners = [];
  return {
    async socket() {
      return {
        addEventListener(type, listener) {
          if (type === "message") listeners.push(listener);
        },
        send(value) {
          const command = JSON.parse(value);
          if (command.type === "ott:create") {
            for (const listener of listeners) listener({ data: JSON.stringify({ type: "ott:joined", roomId: command.roomId, you: "A", name: command.name, resumeToken: "opaque" }) });
          }
        },
        close() {}
      };
    }
  };
}

test("create allocates a durable waiting room and exposes joined data only to creator", async () => {
  const fixture = partyContext(createGameStub());
  const lobby = new OttLobby({ id: "lobby", storage: storage(), context: fixture.context, now: () => 0 });
  const client = connection("creator");

  await lobby.onConnect(client);
  await lobby.onMessage(JSON.stringify({ type: "ott:create", name: "<b>Alice</b>" }), client);

  const joined = client.inbox.find((message) => message.type === "ott:joined");
  assert.match(joined.roomId, /^[A-Z2-9]{4}$/);
  assert.equal(joined.you, "A");
  assert.equal(joined.name, "Alice");
  assert.equal(JSON.stringify(client.inbox).includes("resumeToken"), true);
  assert.deepEqual(await lobby.registry.list(), [{ id: joined.roomId, players: 1, names: { A: "Alice" } }]);
});

test("list returns only public waiting projections", async () => {
  const lobby = new OttLobby({ id: "lobby", storage: storage(), context: partyContext().context });
  const client = connection("viewer");
  await lobby.onConnect(client);
  await lobby.registry.create({ id: "ABCD", names: { A: "Alice" }, players: 1 });
  await lobby.registry.create({ id: "EFGH", names: { A: "Bob" }, players: 1 });
  await lobby.registry.update("EFGH", { status: "playing", token: "secret", state: {} });

  await lobby.onMessage(JSON.stringify({ type: "ott:list" }), client);

  assert.deepEqual(client.inbox.at(-1), {
    type: "ott:rooms",
    rooms: [{ id: "ABCD", players: 1, names: { A: "Alice" } }]
  });
  assert.equal(JSON.stringify(client.inbox.at(-1)).includes("secret"), false);
});

test("create and resume route through the same named game party", async () => {
  const sent = [];
  const socket = {
    addEventListener() {},
    send(value) { sent.push(JSON.parse(value)); },
    close() {}
  };
  const fixture = partyContext({ socket: async () => socket });
  const lobby = new OttLobby({ id: "lobby", storage: storage(), context: fixture.context, now: () => 0 });
  const client = connection("player");
  await lobby.onConnect(client);
  await lobby.registry.create({ id: "ABCD", names: { A: "Alice" }, players: 1 });

  await lobby.onMessage(JSON.stringify({ type: "ott:resume", roomId: "ABCD", resumeToken: "secret" }), client);

  assert.deepEqual(sent, [{ type: "ott:resume", roomId: "ABCD", resumeToken: "secret" }]);
  assert.deepEqual(fixture.calls, [["get", "ABCD"]]);
});

test("resume reaches an active game after its waiting entry is removed, but join remains waiting-only", async () => {
  const sent = [];
  const socket = {
    addEventListener() {},
    send(value) { sent.push(JSON.parse(value)); },
    close() {}
  };
  const fixture = partyContext({ socket: async () => socket });
  const lobby = new OttLobby({ id: "lobby", storage: storage(), context: fixture.context, now: () => 0 });
  const resumer = connection("resumer");
  const joiner = connection("joiner");
  await lobby.onConnect(resumer);
  await lobby.onConnect(joiner);
  await lobby.registry.create({ id: "ABCD", names: { A: "Alice" }, players: 1 });
  await lobby.registry.remove("ABCD");

  await lobby.onMessage(JSON.stringify({ type: "ott:resume", roomId: "ABCD", resumeToken: "opaque" }), resumer);
  await lobby.onMessage(JSON.stringify({ type: "ott:join", roomId: "ABCD", name: "Bob" }), joiner);

  assert.deepEqual(sent, [{ type: "ott:resume", roomId: "ABCD", resumeToken: "opaque" }]);
  assert.deepEqual(joiner.inbox.at(-1), { type: "ott:error", message: "Không tìm thấy phòng" });
  assert.deepEqual(await lobby.listWaitingRooms(), []);
  assert.equal(JSON.stringify(joiner.inbox).includes("opaque"), false);
});

test("join rejects unknown or non-waiting rooms without addressing a replacement", async () => {
  const fixture = partyContext();
  const lobby = new OttLobby({ id: "lobby", storage: storage(), context: fixture.context });
  const client = connection("joiner");
  await lobby.onConnect(client);

  await lobby.onMessage(JSON.stringify({ type: "ott:join", roomId: "WXYZ", name: "Bob" }), client);

  assert.deepEqual(client.inbox.at(-1), { type: "ott:error", message: "Không tìm thấy phòng" });
  assert.deepEqual(fixture.calls, []);
});

test("game routing uses the verified named-party stub and socket API", async () => {
  const socket = { sent: [], send(value) { this.sent.push(value); } };
  const game = { socket: async (path) => { assert.equal(path, "/"); return socket; } };
  const fixture = partyContext(game);

  const result = await routeToGame(fixture.context, "ABCD", { type: "ott:join", name: "Bob" });

  assert.strictEqual(result, socket);
  assert.deepEqual(fixture.calls, [["get", "ABCD"]]);
});

test("malformed and rate-limited lobby packets do not create or route a room", async () => {
  const fixture = partyContext();
  let now = 0;
  const lobby = new OttLobby({ id: "lobby", storage: storage(), context: fixture.context, now: () => now });
  const client = connection("client");
  await lobby.onConnect(client);
  const before = await lobby.registry.list();

  await lobby.onMessage("{", client);
  assert.deepEqual(await lobby.registry.list(), before);
  now += 40;
  await lobby.onMessage(JSON.stringify({ type: "ott:create", name: "Alice" }), client);
  const afterCreate = await lobby.registry.list();
  assert.equal(afterCreate.length, 1);
  await lobby.onMessage(JSON.stringify({ type: "ott:create", name: "Bob" }), client);
  assert.deepEqual(await lobby.registry.list(), afterCreate);
});

test("static hosting denies private, source, test, and traversal paths", () => {
  for (const path of [
    "/partykit/ott-room.js",
    "/PartyKit/ott-room.js",
    "/%50%41%52%54%59%4b%49%54/ott-room.js",
    "/partykit.json",
    "/server.js",
    "/room.js",
    "/package.json",
    "/.env",
    "/tests/partykit-room.test.js",
    "/node_modules/playhtml/package.json",
    "/../server.js",
    "/%2e%2e/server.js",
    "/%E0%A4%A"
  ]) {
    assert.equal(publicPath(path), null, path);
  }
  assert.match(publicPath("/index.html"), /index\.html$/);
});

test("removes waiting records whose game party is already terminal", async () => {
  const game = {
    async fetch(path) {
      assert.equal(path, "/");
      return response({ status: "done" });
    }
  };
  const fixture = partyContext(game);
  const lobby = new OttLobby({ id: "lobby", storage: storage(), context: fixture.context });
  await lobby.registry.create({ id: "ABCD", names: { A: "Alice" }, players: 1 });

  assert.deepEqual(await lobby.listWaitingRooms(), []);
  assert.equal(await lobby.registry.get("ABCD"), undefined);
});
