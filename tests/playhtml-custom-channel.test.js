const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const browserEntryPath = path.join(root, "vendor", "playhtml-minimal", "browser", "index.js");
const browserEntry = () => require(browserEntryPath);

function providerFixture() {
  const listeners = new Set();
  const sent = [];
  return {
    sent,
    provider: {
      sendMessage(message) { sent.push(message); },
      on(type, listener) {
        assert.equal(type, "custom-message");
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    },
    receive(message) {
      for (const listener of [...listeners]) listener(message);
    }
  };
}

test("custom channel rejects sends before PlayHTML is ready", async () => {
  const fixture = providerFixture();
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const playhtml = browserEntry().createMinimalPlayhtml({ ready, provider: fixture.provider });
  const channel = playhtml.createCustomMessageChannel();

  await assert.rejects(channel.send("ott:move"), /ready/i);
  resolveReady();
  await ready;
  await channel.send("ott:move");
  assert.deepEqual(fixture.sent, ["ott:move"]);
});

test("custom channel delivers strings and unsubscribe stops delivery", async () => {
  const fixture = providerFixture();
  const playhtml = browserEntry().createMinimalPlayhtml({
    ready: Promise.resolve(),
    provider: fixture.provider
  });
  const channel = playhtml.createCustomMessageChannel();
  const received = [];
  const unsubscribe = channel.subscribe((message) => received.push(message));

  await playhtml.ready;
  fixture.receive("ott:state");
  unsubscribe();
  fixture.receive("ott:ignored");

  assert.deepEqual(received, ["ott:state"]);
  await assert.rejects(channel.send({ type: "ott:move" }), /string/i);
});

test("minimal browser fork has no presence, cursor, awareness, or second transport path", () => {
  const source = fs.readFileSync(browserEntryPath, "utf8");
  assert.doesNotMatch(source, /PartySocket|WebSocket|presence|cursor|awareness|syncedStore|pageData|elementData/i);
});
