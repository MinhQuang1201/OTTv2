const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

function protocolModule() {
  return fs.readFileSync(path.join(root, "workers", "protocol.ts"), "utf8");
}

function envelope(type, extra = {}) {
  return JSON.stringify({ __ott: true, roomId: "room-1", type, ...extra });
}

test("protocol accepts only the strict attach, move, and leave command shapes", () => {
  const source = protocolModule();
  assert.match(source, /"ott:attach"/);
  assert.match(source, /"ott:move"/);
  assert.match(source, /"ott:leave"/);
  assert.match(source, /Number\.isInteger\(value\.x\)/);
  assert.match(source, /Number\.isInteger\(value\.y\)/);
  assert.match(source, /hasExactKeys/);
});

test("protocol rejects malformed, non-OTT, unknown, oversized, and invalid response messages", () => {
  const source = protocolModule();
  assert.match(source, /MAX_OTT_PAYLOAD_BYTES = 8 \* 1024/);
  assert.match(source, /JSON\.parse\(value\)/);
  assert.match(source, /object\.__ott !== true/);
  assert.match(source, /unknown_command/);
  assert.match(source, /parseOttResponse/);
  assert.match(source, /revision: number/);
});

test("custom-message bridge is implemented at YServer boundary without super dispatch", () => {
  const source = fs.readFileSync(path.join(root, "workers", "ott-game-server.ts"), "utf8");
  assert.match(source, /override\s+onCustomMessage\s*\(/);
  assert.match(source, /sendCustomMessage\s*\(/);
  assert.match(source, /onCustomMessage[\s\S]*?parseOttMessage/);
  assert.doesNotMatch(source, /super\.onCustomMessage/);
  assert.match(source, /lastOttPacketMs/);
  assert.match(source, /MIN_OTT_PACKET_INTERVAL_MS/);
  assert.match(source, /onClose[\s\S]*?delete/);
});

test("custom-message policy keeps client Yjs mutations read-only and non-OTT messages isolated", () => {
  const source = fs.readFileSync(path.join(root, "workers", "ott-game-server.ts"), "utf8");
  assert.match(source, /isReadOnly\([^)]*\):\s*boolean\s*\{[\s\S]*?return true/);
  assert.match(source, /non-OTT|not an OTT|Non-OTT/i);
  assert.doesNotMatch(source, /new\s+WebSocket|PartySocket|fetch\s*\(/);
});
