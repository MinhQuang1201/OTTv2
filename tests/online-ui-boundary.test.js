const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function source(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

test("loads the PlayHTML bootstrap before the game adapter", () => {
  for (const page of ["index.html", "playhtml-game.html"]) {
    const html = source(page);
    const bootstrapAt = html.indexOf('src="playhtml-bootstrap.js"');
    const adapterAt = html.indexOf('src="playhtml-game-client.js"');

    assert.ok(bootstrapAt >= 0, page + " loads the bootstrap");
    assert.ok(adapterAt >= 0, page + " loads the game adapter");
    assert.ok(bootstrapAt < adapterAt, page + " loads bootstrap before adapter");
  }
});

test("keeps online mode unavailable until a connection factory is registered", () => {
  const game = source("game.js");

  assert.match(game, /function hasOnlineConnection\(\)/);
  assert.match(game, /async function startOnline\(intent\) \{[\s\S]*if \(!hasOnlineConnection\(\) \|\| typeof window\.OTT_PLAYHTML_CONTROL_ENDPOINT !== "string"\) \{/);
  assert.match(game, /if \(hasOnlineConnection\(\) && typeof window\.OTT_PLAYHTML_CONTROL_ENDPOINT === "string"\) \{/);
});

test("does not introduce a browser WebSocket fallback", () => {
  for (const name of ["index.html", "game.js", "playhtml-game.html"]) {
    assert.doesNotMatch(source(name), /new\s+(?:WebSocket|PartySocket)\s*\(/);
  }
});
