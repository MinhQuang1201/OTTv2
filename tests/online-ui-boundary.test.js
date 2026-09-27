const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function source(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

test("keeps the reviewed PlayHTML seam in the online session", () => {
  const online = ["apps/web/src/sessions/online/runtimeBridge.ts", "packages/game-client/src/playhtml-bootstrap.js", "packages/game-client/src/playhtml-game-client.js"].map(source).join("\n");
  assert.match(online, /OTT_PLAYHTML_CONNECTION_FACTORY/);
  assert.match(online, /createRuntimeBridge/);
});

test("keeps online mode unavailable until a connection factory is registered", () => {
  const online = source("apps/web/src/sessions/online/runtimeBridge.ts");
  assert.match(online, /if \(!ready\) throw new Error\("PlayHTML connection is not ready"\)/);
  assert.match(online, /typeof factory !== "function"/);
});

test("does not introduce a browser WebSocket fallback", () => {
  for (const name of ["apps/web/src/sessions/online/runtimeBridge.ts", "apps/web/src/sessions/online/OnlineSession.ts", "apps/web/static/playhtml-game.html"]) {
    assert.doesNotMatch(source(name), /new\s+(?:WebSocket|PartySocket)\s*\(/);
  }
});
