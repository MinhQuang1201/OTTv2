const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const PlayhtmlGameClient = require("../playhtml-game-client");

const source = fs.readFileSync(path.join(__dirname, "..", "game.js"), "utf8");
const start = source.indexOf("  async function startOnline(intent) {");
const end = source.indexOf("\n  function leaveTable(", start);
const startOnlineSource = start >= 0 && end > start ? source.slice(start, end).trim() : null;

test("listed lowercase allocation ID reaches control join unchanged through the UI route", async () => {
  assert.ok(startOnlineSource, "game.js startOnline route is available to exercise");
  const allocationId = "abcdef12-3456-4abc-8def-1234567890ab";
  const joinArguments = [];
  const requests = [];
  const connection = {
    on() {},
    connect() {},
    send() {},
    close() {},
  };
  const client = new PlayhtmlGameClient({
    connectionFactory: () => connection,
    controlRequest: async (action, body) => {
      requests.push([action, body]);
      return { allocationId: "alloc-1", room: allocationId, seat: "B", ticket: "ticket", resumeCredential: "owner" };
    },
    storage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  });
  const uiClient = {
    join(roomId, name) {
      joinArguments.push(roomId);
      return client.join(roomId, name);
    },
  };
  const startOnline = vm.runInNewContext(`(${startOnlineSource})`, {
    window: { OTT_PLAYHTML_CONNECTION_FACTORY() {}, OTT_PLAYHTML_CONTROL_ENDPOINT: "https://worker.example" },
    hasOnlineConnection: () => true,
    els: { room: { value: allocationId } },
    toast() {},
    bindOnlineClient: () => uiClient,
    app: {},
    stopClock() {},
    playerName: () => "Alice",
    setNet() {},
  });

  await client.connect();
  startOnline("join");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(joinArguments, [allocationId], "the UI must pass the listed ID without case conversion");
  assert.deepEqual(requests, [["join", { allocationId, name: "Alice" }]]);
});
