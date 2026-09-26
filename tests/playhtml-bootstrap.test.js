const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("blocked bootstrap never registers a factory or opens a fallback connection", () => {
  const bootstrapPath = require.resolve("../playhtml-bootstrap");
  const originalWebSocket = globalThis.WebSocket;
  const originalFactory = globalThis.OTT_PLAYHTML_CONNECTION_FACTORY;
  let connections = 0;

  try {
    globalThis.WebSocket = function WebSocket() {
      connections += 1;
    };
    delete globalThis.OTT_PLAYHTML_CONNECTION_FACTORY;
    delete require.cache[bootstrapPath];

    const { createUnavailableBootstrap } = require("../playhtml-bootstrap");
    const bootstrap = createUnavailableBootstrap();

    assert.throws(() => bootstrap({ host: "https://playhtml.example" }), /unavailable/);
    assert.equal(globalThis.OTT_PLAYHTML_CONNECTION_FACTORY, undefined);
    assert.equal(connections, 0);
  } finally {
    if (originalWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = originalWebSocket;
    if (originalFactory === undefined) delete globalThis.OTT_PLAYHTML_CONNECTION_FACTORY;
    else globalThis.OTT_PLAYHTML_CONNECTION_FACTORY = originalFactory;
    delete require.cache[bootstrapPath];
  }
});

test("browser pages load the reviewed runtime before the PlayHTML bootstrap", () => {
  for (const pageName of ["index.html", "playhtml-game.html"]) {
    const html = fs.readFileSync(path.join(__dirname, "..", pageName), "utf8");
    const runtimeAt = html.indexOf('src="vendor/playhtml-minimal/browser/runtime.js"');
    const bootstrapAt = html.indexOf('src="playhtml-bootstrap.js"');
    const clientAt = html.indexOf('src="playhtml-game-client.js"');

    assert.ok(runtimeAt >= 0, `${pageName} must load the browser runtime`);
    assert.ok(bootstrapAt > runtimeAt, `${pageName} must load runtime before bootstrap`);
    assert.ok(clientAt > bootstrapAt, `${pageName} must load bootstrap before the client`);
  }
});

test("verified bootstrap initializes PlayHTML once and registers a channel factory after ready", async () => {
  const bootstrapPath = require.resolve("../playhtml-bootstrap");
  const originalFactory = globalThis.OTT_PLAYHTML_CONNECTION_FACTORY;
  const calls = [];
  let resolveReady;
  const received = [];
  const runtime = {
    configure(options) { calls.push(["configure", options]); },
    init() { calls.push(["init"]); return { ready: new Promise((resolve) => { resolveReady = resolve; }), createCustomMessageChannel() { return { send() {}, subscribe(listener) { received.push(listener); return () => {}; }, close() {} }; } }; }
  };

  try {
    delete globalThis.OTT_PLAYHTML_CONNECTION_FACTORY;
    delete require.cache[bootstrapPath];
    const { createBootstrap } = require("../playhtml-bootstrap");
    const bootstrap = createBootstrap({ runtime, globalObject: globalThis });
    const pending = bootstrap({ host: "https://worker.example", room: "ott-room" });
    await Promise.resolve();
    assert.deepEqual(calls, [["configure", { host: "https://worker.example", room: "ott-room" }], ["init"]]);
    assert.equal(globalThis.OTT_PLAYHTML_CONNECTION_FACTORY, undefined);
    resolveReady();
    const factory = await pending;
    assert.equal(typeof factory, "function");
    assert.equal(globalThis.OTT_PLAYHTML_CONNECTION_FACTORY, factory);
    await bootstrap({ host: "https://worker.example", room: "ott-room" });
    assert.deepEqual(calls, [["configure", { host: "https://worker.example", room: "ott-room" }], ["init"]]);
    const connection = factory();
    await connection.connect();
    assert.equal(received.length, 1);
    connection.close();
  } finally {
    if (originalFactory === undefined) delete globalThis.OTT_PLAYHTML_CONNECTION_FACTORY;
    else globalThis.OTT_PLAYHTML_CONNECTION_FACTORY = originalFactory;
    delete require.cache[bootstrapPath];
  }
});

test("bootstrap rejects reuse of an initialized provider for a different room", async () => {
  const runtime = {
    configure() {},
    init() { return { ready: Promise.resolve(), createCustomMessageChannel() { return { send() {}, subscribe() { return () => {}; }, close() {} }; } }; },
  };
  const bootstrap = require("../playhtml-bootstrap").createBootstrap({ runtime, globalObject: {} });
  await bootstrap({ host: "https://worker.example", room: "ott-123e4567-e89b-12d3-a456-426614174000" });
  await assert.rejects(
    bootstrap({ host: "https://worker.example", room: "ott-123e4567-e89b-12d3-a456-426614174001" }),
    /reload before joining another room/i
  );
});
