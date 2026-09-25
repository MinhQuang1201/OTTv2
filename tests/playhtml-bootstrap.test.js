const test = require("node:test");
const assert = require("node:assert/strict");

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
