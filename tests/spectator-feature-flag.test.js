const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const { build } = require("esbuild");

const root = path.resolve(__dirname, "..");

let loadedAuth = null;
async function authModule() {
  if (!loadedAuth) {
    const { transformSync } = require("esbuild");
    const fs = require("node:fs");
    const code = fs.readFileSync(path.join(root, "apps", "worker", "src", "auth", "internal-auth.ts"), "utf8");
    const { code: transformed } = transformSync(code, { loader: "ts", format: "esm" });
    loadedAuth = import(`data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}`);
  }
  return loadedAuth;
}

let cachedWorker = null;
async function loadWorker() {
  if (!cachedWorker) {
    const { outputFiles } = await build({
      entryPoints: [path.join(root, "apps", "worker", "src", "entry", "ott-worker.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      plugins: [
        {
          name: "partyserver-double",
          setup(b) {
            b.onResolve({ filter: /^partyserver$/ }, () => ({ path: "partyserver-double", namespace: "test" }));
            b.onLoad({ filter: /.*/, namespace: "test" }, () => ({
              contents: `
                export async function routePartykitRequest(req, env) {
                  global.__lastRoutedRequest = { url: req.url, env };
                  return new Response("routed-by-partyserver", { status: 200 });
                }
              `,
              loader: "js",
            }));
          },
        },
        {
          name: "cloudflare-workers-double",
          setup(b) {
            b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "cloudflare-workers-double", namespace: "cf-test" }));
            b.onLoad({ filter: /.*/, namespace: "cf-test" }, () => ({
              contents: `export class DurableObject {}`,
              loader: "js",
            }));
          },
        },
        {
          name: "y-partyserver-double",
          setup(b) {
            b.onResolve({ filter: /^y-partyserver$/ }, () => ({ path: "y-partyserver-double", namespace: "y-test" }));
            b.onLoad({ filter: /.*/, namespace: "y-test" }, () => ({
              contents: `export class YServer {}`,
              loader: "js",
            }));
          },
        },
      ],
      write: false,
    });
    const filename = path.join(root, "apps", "worker", "src", "entry", "ott-worker-test.cjs");
    const m = new Module(filename, module);
    m.filename = filename;
    m.paths = Module._nodeModulePaths(root);
    m._compile(outputFiles[0].text, filename);
    cachedWorker = m.exports.default;
  }
  return cachedWorker;
}

let cachedStreamServerClass = null;
async function loadStreamServer() {
  if (!cachedStreamServerClass) {
    const { outputFiles } = await build({
      entryPoints: [path.join(root, "apps", "worker", "src", "lobby", "ott-lobby-stream-server.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      plugins: [
        {
          name: "y-partyserver-double",
          setup(b) {
            b.onResolve({ filter: /^y-partyserver$/ }, () => ({ path: "y-partyserver-double", namespace: "test" }));
            b.onLoad({ filter: /.*/, namespace: "test" }, () => ({
              contents: `
                export class YServer {
                  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
                  onConnect() {}
                  onMessage() {}
                  onClose() {}
                  sendCustomMessage(connection, message) { connection.send?.(message); }
                  fetch(req) { return Promise.resolve(new Response("Not found", { status: 404 })); }
                  getConnections() { return []; }
                }
              `,
              loader: "js",
            }));
          },
        },
        {
          name: "cloudflare-workers-double",
          setup(b) {
            b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "cloudflare-workers-double", namespace: "cf-test" }));
            b.onLoad({ filter: /.*/, namespace: "cf-test" }, () => ({
              contents: `export class DurableObject {}`,
              loader: "js",
            }));
          },
        },
      ],
      write: false,
    });
    const filename = path.join(root, "apps", "worker", "src", "lobby", "ott-lobby-stream-server-test.cjs");
    const m = new Module(filename, module);
    m.filename = filename;
    m.paths = Module._nodeModulePaths(root);
    m._compile(outputFiles[0].text, filename);
    cachedStreamServerClass = m.exports.OttLobbyStreamServer;
  }
  return cachedStreamServerClass;
}

let cachedGameServerClass = null;
async function loadGameServer() {
  if (!cachedGameServerClass) {
    const { outputFiles } = await build({
      entryPoints: [path.join(root, "apps", "worker", "src", "game", "ott-game-server.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      plugins: [{
        name: "task6-yserver-test-double",
        setup(b) {
          b.onResolve({ filter: /^y-partyserver$/ }, () => ({ path: "task6-yserver-test-double", namespace: "task6" }));
          b.onLoad({ filter: /.*/, namespace: "task6" }, () => ({
            contents: `
              export class YServer {
                constructor(ctx, env) { this.ctx = ctx; this.env = env; }
                onConnect() {}
                onMessage() {}
                onClose() {}
                sendCustomMessage(connection, message) { connection.send?.(message); }
                fetch() { return Promise.resolve(new Response("Not found", { status: 404 })); }
              }
            `,
            loader: "js",
          }));
        },
      }],
      write: false,
    });
    const filename = path.join(root, "apps", "worker", "src", "game", "ott-game-server-test.cjs");
    const m = new Module(filename, module);
    m.filename = filename;
    m.paths = Module._nodeModulePaths(root);
    m._compile(outputFiles[0].text, filename);
    cachedGameServerClass = m.exports.OttGameServer;
  }
  return cachedGameServerClass;
}

function mockGameServerFixture(prototype, env = {}, roomId = "ott-room-flag-test") {
  const values = new Map([
    ["allocationId", "allocation-flag-test"],
    ["roomId", roomId],
  ]);
  const messages = [];
  const storage = {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    async transaction(callback) {
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
  };
  const server = Object.create(prototype);
  server.ctx = { storage };
  server.ottEnv = { OTT_INTERNAL_SECRET: "test-secret", ...env };
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

function mockConnection(id) {
  let attachment = null;
  const closed = [];
  const sent = [];
  return {
    id,
    serializeAttachment(value) { attachment = value; },
    deserializeAttachment() { return attachment; },
    close(code, reason) { closed.push({ code, reason }); },
    closed,
    send(value) { sent.push(JSON.parse(value)); },
    sent,
  };
}

// -------------------------------------------------------------
// 1. Worker routing tests
// -------------------------------------------------------------

test("ott-worker: /parties/lobby/ott-lobby-public fails closed when OTT_SPECTATOR_ENABLED is not exactly 'true'", async () => {
  const worker = await loadWorker();

  // Test 1: Flag undefined (default)
  global.__lastRoutedRequest = null;
  const resDefault = await worker.fetch(
    new Request("http://localhost/parties/lobby/ott-lobby-public"),
    {}
  );
  assert.equal(resDefault.status, 404, "Default/undefined flag must return 404");
  assert.equal(global.__lastRoutedRequest, null, "Must not route through partyserver when disabled");

  // Test 2: Flag is "false"
  global.__lastRoutedRequest = null;
  const resFalse = await worker.fetch(
    new Request("http://localhost/parties/lobby/ott-lobby-public"),
    { OTT_SPECTATOR_ENABLED: "false" }
  );
  assert.equal(resFalse.status, 404, "Flag 'false' must return 404");
  assert.equal(global.__lastRoutedRequest, null);

  // Test 3: Flag is "1" or arbitrary truthy string
  global.__lastRoutedRequest = null;
  const resTruthy = await worker.fetch(
    new Request("http://localhost/parties/lobby/ott-lobby-public"),
    { OTT_SPECTATOR_ENABLED: "1" }
  );
  assert.equal(resTruthy.status, 404, "Non-'true' string must return 404");
  assert.equal(global.__lastRoutedRequest, null);

  // Test 4: Flag is exactly "true"
  global.__lastRoutedRequest = null;
  const resTrue = await worker.fetch(
    new Request("http://localhost/parties/lobby/ott-lobby-public"),
    { OTT_SPECTATOR_ENABLED: "true" }
  );
  assert.equal(resTrue.status, 200, "Flag 'true' routes request");
  assert.notEqual(global.__lastRoutedRequest, null, "Must route through partyserver when enabled");

  // Test 5: Game room route /parties/main/ott-... still works regardless of flag
  global.__lastRoutedRequest = null;
  const gameRoom = "ott-123e4567-e89b-12d3-a456-426614174000";
  const resGame = await worker.fetch(
    new Request(`http://localhost/parties/main/${gameRoom}`),
    {}
  );
  assert.equal(resGame.status, 200, "Game room route must work with default flag");
  assert.notEqual(global.__lastRoutedRequest, null);
});

// -------------------------------------------------------------
// 2. OttLobbyStreamServer tests
// -------------------------------------------------------------

test("OttLobbyStreamServer: rejects connection and subscription when OTT_SPECTATOR_ENABLED is not 'true'", async () => {
  const StreamServerClass = await loadStreamServer();

  // Test 2.1: onConnect rejects/closes connection when flag is undefined or false
  const disabledEnv = { OTT_INTERNAL_SECRET: "test-secret" };
  const mockState = { storage: {} };
  const streamServer = new StreamServerClass(mockState, disabledEnv);

  const conn1 = mockConnection("client-1");
  streamServer.onConnect(conn1, {});
  assert.equal(conn1.closed.length, 1, "Connection must be closed on connect when disabled");
  assert.equal(conn1.closed[0].reason, "spectator_disabled");

  // Test 2.2: dispatchCustomMessage fails closed when flag is disabled
  const conn2 = mockConnection("client-2");
  await streamServer.dispatchCustomMessage(conn2, JSON.stringify({
    __ott: true,
    type: "ott:lobby-subscribe",
  }));
  assert.equal(conn2.sent.length, 1, "Must reply with error");
  assert.equal(conn2.sent[0].type, "ott:error");
  assert.equal(conn2.sent[0].error, "spectator_disabled");

  // Test 2.3: fetch fails closed when flag is disabled
  const fetchRes = await streamServer.fetch(new Request("http://localhost/internal/active-update", {
    method: "POST",
    headers: { "x-ott-internal-secret": "test-secret" },
    body: JSON.stringify({ catalogRevision: 1, matches: [] }),
  }));
  assert.ok(fetchRes.status === 403 || fetchRes.status === 404, "fetch must return 403 or 404 when disabled");

  // Test 2.4: Enabled stream server accepts connection
  const enabledEnv = { OTT_INTERNAL_SECRET: "test-secret", OTT_SPECTATOR_ENABLED: "true" };
  const enabledServer = new StreamServerClass(mockState, enabledEnv);
  const conn3 = mockConnection("client-3");
  enabledServer.onConnect(conn3, {});
  assert.equal(conn3.closed.length, 0, "Connection must not be closed when enabled");
});

// -------------------------------------------------------------
// 3. OttGameServer tests
// -------------------------------------------------------------

test("OttGameServer: rejects spectator attach and suppresses summary publication when OTT_SPECTATOR_ENABLED is not 'true'", async () => {
  const GameServerClass = await loadGameServer();
  const { issueCapability } = await authModule();

  // Test 3.1: Disabled flag rejects ott:spectate
  const fixtureDisabled = mockGameServerFixture(GameServerClass.prototype, {
    // OTT_SPECTATOR_ENABLED is not set
  });

  const adapter = {
    roomId: "ott-room-flag-test",
    room: {
      revision: 1,
      status: "playing",
      state: {},
      players: { A: { name: "Alice", connected: true }, B: { name: "Bob", connected: true } },
    },
    lastPayload: {
      roomId: "ott-room-flag-test",
      status: "playing",
      serverNow: 100,
      revision: 1,
      players: { A: { name: "Alice", connected: true }, B: { name: "Bob", connected: true } },
      state: { turn: "A" },
      events: [],
    },
  };
  fixtureDisabled.server.roomLoad = Promise.resolve(adapter);

  const spectatorConn = mockConnection("spectator-client");
  const ticketNonce = "test-flag-spectator-nonce-001";
  const spectatorToken = await issueCapability("test-secret", {
    allocationId: "allocation-flag-test",
    roomId: "ott-room-flag-test",
    purpose: "spectate",
    role: "spectator",
    nonce: ticketNonce,
  });

  await fixtureDisabled.server.dispatchOttMessage(spectatorConn, JSON.stringify({
    __ott: true,
    roomId: "ott-room-flag-test",
    type: "ott:spectate",
    ticket: spectatorToken,
  }));

  // Must not install spectator identity
  assert.equal(fixtureDisabled.server.identities.has(spectatorConn), false, "Spectator identity must not be installed");
  // Must not store consumed nonce
  assert.equal(fixtureDisabled.values.has(`spectate-nonce:${ticketNonce}`), false, "Nonce must not be consumed");
  // Must return spectate_rejected
  const lastMsg = fixtureDisabled.messages.at(-1);
  assert.ok(lastMsg, "Error message must be sent");
  assert.equal(lastMsg.type, "ott:error");
  assert.equal(lastMsg.error, "spectate_rejected");

  // Test 3.2: publishPublicSummary must NOT publish summaries to lobby or update sequence when flag is disabled
  let lobbyUpdateCalled = false;
  fixtureDisabled.server.ottEnv.OTT_LOBBY = {
    get() {
      return {
        async fetch() {
          lobbyUpdateCalled = true;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      };
    },
  };

  await fixtureDisabled.server.publishPublicSummary(adapter);
  assert.equal(lobbyUpdateCalled, false, "Must not call Lobby /internal/active-update when flag disabled");
  assert.equal(fixtureDisabled.values.has("public-summary-sequence"), false, "Must not advance public-summary-sequence when flag disabled");

  // Test 3.3: Player attach still works even when OTT_SPECTATOR_ENABLED is disabled
  const playerConn = mockConnection("player-client");
  const playerNonce = "test-flag-player-nonce-001";
  const playerToken = await issueCapability("test-secret", {
    allocationId: "allocation-flag-test",
    roomId: "ott-room-flag-test",
    purpose: "attach",
    seat: "A",
    nonce: playerNonce,
  });

  adapter.attach = async () => ({
    ok: true,
    roomId: "ott-room-flag-test",
    revision: 2,
    payload: { ...adapter.lastPayload, revision: 2 },
    events: [],
  });
  adapter.scheduleAlarm = async () => {};
  adapter.commitAttach = () => {};

  await fixtureDisabled.server.dispatchOttMessage(playerConn, JSON.stringify({
    __ott: true,
    roomId: "ott-room-flag-test",
    type: "ott:attach",
    ticket: playerToken,
  }));
  assert.equal(fixtureDisabled.server.identities.get(playerConn)?.role, "player", "Player attach must still succeed when spectator flag is disabled");

  // Test 3.4: When OTT_SPECTATOR_ENABLED is "true", spectator attach succeeds and summary publishes
  const fixtureEnabled = mockGameServerFixture(GameServerClass.prototype, {
    OTT_SPECTATOR_ENABLED: "true",
  });
  fixtureEnabled.server.roomLoad = Promise.resolve(adapter);

  const spectatorConnEnabled = mockConnection("spectator-client-enabled");
  const ticketNonceEnabled = "test-flag-spectator-nonce-002";
  const spectatorTokenEnabled = await issueCapability("test-secret", {
    allocationId: "allocation-flag-test",
    roomId: "ott-room-flag-test",
    purpose: "spectate",
    role: "spectator",
    nonce: ticketNonceEnabled,
  });

  await fixtureEnabled.server.dispatchOttMessage(spectatorConnEnabled, JSON.stringify({
    __ott: true,
    roomId: "ott-room-flag-test",
    type: "ott:spectate",
    ticket: spectatorTokenEnabled,
  }));

  assert.equal(fixtureEnabled.server.identities.get(spectatorConnEnabled)?.role, "spectator", "Spectator identity must be installed when enabled");
  assert.equal(fixtureEnabled.values.has(`spectate-nonce:${ticketNonceEnabled}`), true, "Nonce must be consumed when enabled");

  let lobbyUpdateCalledEnabled = false;
  fixtureEnabled.server.ottEnv.OTT_LOBBY = {
    idFromName() { return "lobby"; },
    get() {
      return {
        async fetch() {
          lobbyUpdateCalledEnabled = true;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      };
    },
  };

  await fixtureEnabled.server.publishPublicSummary(adapter);
  assert.equal(lobbyUpdateCalledEnabled, true, "Must call Lobby /internal/active-update when flag enabled");
  assert.equal(fixtureEnabled.values.get("public-summary-sequence"), 1, "Must advance public-summary-sequence when flag enabled");
});
