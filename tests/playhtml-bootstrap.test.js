const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("blocked bootstrap never registers a factory or opens a fallback connection", () => {
  const bootstrapPath = require.resolve("../packages/game-client/src/playhtml-bootstrap");
  const originalWebSocket = globalThis.WebSocket;
  const originalFactory = globalThis.OTT_PLAYHTML_CONNECTION_FACTORY;
  let connections = 0;

  try {
    globalThis.WebSocket = function WebSocket() {
      connections += 1;
    };
    delete globalThis.OTT_PLAYHTML_CONNECTION_FACTORY;
    delete require.cache[bootstrapPath];

    const { createUnavailableBootstrap } = require("../packages/game-client/src/playhtml-bootstrap");
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

test("the adapter diagnostic page does not add a transport", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "apps", "web", "static", "playhtml-game.html"), "utf8");
  assert.match(html, /PlayHTML game adapter/);
  assert.doesNotMatch(html, /<script|WebSocket|PartySocket|polling/i);
});

test("verified bootstrap initializes PlayHTML once and registers a channel factory after ready", async () => {
  const bootstrapPath = require.resolve("../packages/game-client/src/playhtml-bootstrap");
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
    const { createBootstrap } = require("../packages/game-client/src/playhtml-bootstrap");
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
  const bootstrap = require("../packages/game-client/src/playhtml-bootstrap").createBootstrap({ runtime, globalObject: {} });
  await bootstrap({ host: "https://worker.example", room: "ott-123e4567-e89b-12d3-a456-426614174000" });
  await assert.rejects(
    bootstrap({ host: "https://worker.example", room: "ott-123e4567-e89b-12d3-a456-426614174001" }),
    /reload before joining another room/i
  );
});

test("bootstrap disposed during pending init aborts and does not install global factory", async () => {
  let resolveReady;
  let closed = false;
  const runtime = {
    configure() {},
    init() {
      return {
        ready: new Promise((resolve) => { resolveReady = resolve; }),
        createCustomMessageChannel() { return { send() {}, subscribe() { return () => {}; }, close() {} }; },
        close() { closed = true; }
      };
    },
    reset() {}
  };
  const target = {};
  const { createBootstrap } = require("../packages/game-client/src/playhtml-bootstrap");
  const bootstrap = createBootstrap({ runtime, globalObject: target });
  const pending = bootstrap({ host: "https://worker.example", room: "ott-room-a" });

  await bootstrap.dispose();
  assert.equal(closed, true);
  assert.equal(target.OTT_PLAYHTML_CONNECTION_FACTORY, undefined);

  resolveReady();
  await assert.rejects(pending, /aborted/i);
  assert.equal(target.OTT_PLAYHTML_CONNECTION_FACTORY, undefined);
});

test("rejected initialization cleans up state and allows subsequent bootstrap", async () => {
  let shouldFail = true;
  const runtime = {
    configure() {},
    init() {
      if (shouldFail) {
        throw new Error("runtime init failed");
      }
      return {
        ready: Promise.resolve(),
        createCustomMessageChannel() { return { send() {}, subscribe() { return () => {}; }, close() {} }; }
      };
    }
  };
  const target = {};
  const { createBootstrap } = require("../packages/game-client/src/playhtml-bootstrap");
  const bootstrap = createBootstrap({ runtime, globalObject: target });

  await assert.rejects(bootstrap({ host: "https://worker.example", room: "ott-room-a" }), /runtime init failed/);

  shouldFail = false;
  const factory = await bootstrap({ host: "https://worker.example", room: "ott-room-b" });
  assert.equal(typeof factory, "function");
  assert.equal(target.OTT_PLAYHTML_CONNECTION_FACTORY, factory);
});

test("concurrent disposal calls reset only once and both resolve cleanly", async () => {
  let resets = 0;
  const runtime = {
    configure() {},
    init() {
      return {
        ready: Promise.resolve(),
        createCustomMessageChannel() { return { send() {}, subscribe() { return () => {}; }, close() {} }; }
      };
    },
    async reset() {
      resets += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const target = {};
  const { createBootstrap } = require("../packages/game-client/src/playhtml-bootstrap");
  const bootstrap = createBootstrap({ runtime, globalObject: target });
  await bootstrap({ host: "https://worker.example", room: "ott-room-a" });

  await Promise.all([bootstrap.dispose(), bootstrap.dispose(), bootstrap.dispose()]);
  assert.equal(resets, 1);
  assert.equal(target.OTT_PLAYHTML_CONNECTION_FACTORY, undefined);
});

test("rejected playhtml.ready cleans up playhtml instance and resets runtime", async () => {
  let closed = false;
  let resetCalled = false;
  const runtime = {
    configure() {},
    init() {
      return {
        ready: Promise.reject(new Error("websocket failed to connect")),
        createCustomMessageChannel() { return { send() {}, subscribe() { return () => {}; }, close() {} }; },
        close() { closed = true; }
      };
    },
    reset() { resetCalled = true; }
  };
  const target = {};
  const { createBootstrap } = require("../packages/game-client/src/playhtml-bootstrap");
  const bootstrap = createBootstrap({ runtime, globalObject: target });

  await assert.rejects(bootstrap({ host: "https://worker.example", room: "ott-room-a" }), /websocket failed to connect/);
  assert.equal(closed, true);
  assert.equal(resetCalled, true);
  assert.equal(target.OTT_PLAYHTML_CONNECTION_FACTORY, undefined);
});

