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

let loadedLobbyServer;
function loadOttLobbyServer() {
  if (!loadedLobbyServer) {
    const { buildSync } = require("esbuild");
    const path = require("node:path");
    const Module = require("node:module");
    const root = path.resolve(__dirname, "..");
    const res = buildSync({
      entryPoints: [path.join(root, "apps", "worker", "src", "lobby", "ott-lobby-server.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false,
      external: ["cloudflare:workers"],
    });
    const m = new Module("ott-lobby-server-test", module);
    m.require = function(id) {
      if (id === "cloudflare:workers") {
        return { DurableObject: class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } };
      }
      return Module.prototype.require.apply(this, arguments);
    };
    m._compile(res.outputFiles[0].text, "ott-lobby-server-test.js");
    loadedLobbyServer = m.exports;
  }
  return loadedLobbyServer;
}

test("OttLobbyServer rate limits per action and client IP/identity, not globally", async () => {
  const { OttLobbyServer } = loadOttLobbyServer();
  const storageMap = new Map();
  const ctx = {
    storage: {
      async get(k) { return storageMap.get(k); },
      async put(k, v) { storageMap.set(k, v); },
      async list(opts) {
        const out = new Map();
        for (const [k, v] of storageMap) {
          if (!opts?.prefix || k.startsWith(opts.prefix)) out.set(k, v);
        }
        return out;
      },
      async transaction(cb) { return cb(ctx.storage); },
    },
  };
  const env = { OTT_SPECTATOR_ENABLED: "true" };
  const server = new OttLobbyServer(ctx, env);

  // Client 1 sends /list
  const req1 = new Request("https://ott.internal/list", {
    method: "POST",
    headers: { "cf-connecting-ip": "203.0.113.1" },
    body: "{}",
  });
  const res1 = await server.fetch(req1);
  assert.equal(res1.status, 200);

  // Client 2 sends /list concurrently within 40ms - must NOT be blocked by Client 1
  const req2 = new Request("https://ott.internal/list", {
    method: "POST",
    headers: { "cf-connecting-ip": "198.51.100.2" },
    body: "{}",
  });
  const res2 = await server.fetch(req2);
  assert.equal(res2.status, 200, "Client 2 must not be rate-limited by Client 1 request");

  // Client 1 sends /list again immediately - MUST be rate limited
  const req1Again = new Request("https://ott.internal/list", {
    method: "POST",
    headers: { "cf-connecting-ip": "203.0.113.1" },
    body: "{}",
  });
  const res1Again = await server.fetch(req1Again);
  assert.equal(res1Again.status, 429);
  assert.deepEqual(await res1Again.json(), { error: "rate_limited" });

  // Fallback edge headers (x-forwarded-for, x-real-ip, anonymous)
  const reqForwarded = new Request("https://ott.internal/list", {
    method: "POST",
    headers: { "x-forwarded-for": "192.0.2.1, 10.0.0.1" },
    body: "{}",
  });
  const resForwarded = await server.fetch(reqForwarded);
  assert.equal(resForwarded.status, 200);

  const reqRealIp = new Request("https://ott.internal/list", {
    method: "POST",
    headers: { "x-real-ip": "198.51.100.55" },
    body: "{}",
  });
  const resRealIp = await server.fetch(reqRealIp);
  assert.equal(resRealIp.status, 200);

  const reqAnon = new Request("https://ott.internal/list", {
    method: "POST",
    headers: {},
    body: "{}",
  });
  const resAnon = await server.fetch(reqAnon);
  assert.equal(resAnon.status, 200);

  // Client 1 rate-limited on /list can still perform different action /spectate without 429
  const reqSpectate = new Request("https://ott.internal/spectate", {
    method: "POST",
    headers: { "cf-connecting-ip": "203.0.113.1" },
    body: JSON.stringify({ id: "nonexistent-room" }),
  });
  const resSpectate = await server.fetch(reqSpectate);
  assert.notEqual(resSpectate.status, 429, "Different action must not be blocked by rate limit on /list");

  // Verify rate limit keys are partitioned per action and client identity
  assert.equal(storageMap.has("rate:last:list:203.0.113.1"), true);
  assert.equal(storageMap.has("rate:last:list:198.51.100.2"), true);
  assert.equal(storageMap.has("rate:last:list:192.0.2.1"), true);
  assert.equal(storageMap.has("rate:last:list:198.51.100.55"), true);
  assert.equal(storageMap.has("rate:last:list:anonymous"), true);
  assert.equal(storageMap.has("rate:last:spectate:203.0.113.1"), true);
  assert.equal(storageMap.has("rate:last:list"), false, "Must not use global rate:last:list key");
});

test("OttLobbyServer alarm removes expired rate-limit keys", async () => {
  const { OttLobbyServer } = loadOttLobbyServer();
  const storageMap = new Map([
    ["rate:last:list:expired", Date.now() - 61_000],
    ["rate:last:join:fresh", Date.now()],
  ]);
  const alarms = [];
  const ctx = {
    storage: {
      async get(k) { return storageMap.get(k); },
      async put(k, v) { storageMap.set(k, v); },
      async delete(k) { storageMap.delete(k); },
      async list(opts) { return new Map([...storageMap].filter(([k]) => !opts?.prefix || k.startsWith(opts.prefix))); },
      async setAlarm(deadline) { alarms.push(deadline); },
      async deleteAlarm() {},
      async transaction(cb) { return cb(ctx.storage); },
    },
  };
  const server = new OttLobbyServer(ctx, { OTT_SPECTATOR_ENABLED: "true" });

  await server.alarm();

  assert.equal(storageMap.has("rate:last:list:expired"), false);
  assert.equal(storageMap.has("rate:last:join:fresh"), true);
  assert.equal(alarms.length, 1);
});

