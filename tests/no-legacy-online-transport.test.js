const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("production online configuration uses the Cloudflare Worker route only", () => {
  const packageJson = JSON.parse(read("package.json"));
  const scripts = Object.values(packageJson.scripts || {}).join(" ");
  const readme = read("README.md");

  assert.equal(fs.existsSync(path.join(root, "partykit.json")), false);
  assert.doesNotMatch(scripts, /partykit/i);
  assert.match(readme, /apps[\\/]worker[\\/]wrangler\.jsonc/);
  assert.match(readme, /npx --no-install wrangler (dev|deploy)/);
  assert.match(readme, /online.*BLOCKED/i);
  assert.match(readme, /PartyKit legacy.*không còn là route deploy hoặc authority online/i);
});

test("online browser code has no fallback or second transport", () => {
  const source = [
    "packages/game-client/src/playhtml-bootstrap.js",
    "packages/game-client/src/playhtml-game-client.js",
    "apps/web/src/sessions/online/runtimeBridge.ts",
    "apps/web/src/sessions/online/OnlineSession.ts",
    "apps/web/static/playhtml-game.html"
  ].map(read).join("\n");

  assert.doesNotMatch(source, /new\s+WebSocket\s*\(|PartySocket|polling/i);
  assert.doesNotMatch(source, /fakeFactory|fake factory|fallback\s+transport/i);
  assert.equal((source.match(/runtime\.init\s*\(/g) || []).length, 1);
  assert.match(source, /OTT_PLAYHTML_CONNECTION_FACTORY/);
});
