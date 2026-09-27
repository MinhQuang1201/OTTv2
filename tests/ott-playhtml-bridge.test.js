const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

function protocolSource() {
  return fs.readFileSync(path.join(root, "packages", "protocol", "src", "index.ts"), "utf8");
}

let loadedProtocol;
async function protocolModule() {
  if (!loadedProtocol) {
    const { transformSync } = require("esbuild");
    const { code } = transformSync(protocolSource(), { loader: "ts", format: "esm" });
    loadedProtocol = import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  }
  return loadedProtocol;
}

function envelope(type, extra = {}) {
  return JSON.stringify({ __ott: true, roomId: "room-1", type, ...extra });
}

test("protocol accepts only the strict attach, spectate, move, and leave command shapes", () => {
  const source = protocolSource();
  assert.match(source, /"ott:attach"/);
  assert.match(source, /"ott:spectate"/);
  assert.match(source, /"ott:move"/);
  assert.match(source, /"ott:leave"/);
  assert.match(source, /Number\.isInteger\(value\.x\)/);
  assert.match(source, /Number\.isInteger\(value\.y\)/);
  assert.match(source, /hasExactKeys/);
});

test("protocol rejects malformed, non-OTT, unknown, oversized, and invalid response messages", () => {
  const source = protocolSource();
  assert.match(source, /MAX_OTT_PAYLOAD_BYTES = 8 \* 1024/);
  assert.match(source, /JSON\.parse\(value\)/);
  assert.match(source, /object\.__ott !== true/);
  assert.match(source, /unknown_command/);
  assert.match(source, /parseOttResponse/);
  assert.match(source, /revision: number/);
});

test("compiled protocol parses the exact spectator command and rejects near misses", async () => {
  const { parseOttMessage } = await protocolModule();
  const valid = envelope("ott:spectate", { ticket: "ticket-1" });
  assert.deepEqual(parseOttMessage(valid), {
    ok: true,
    value: { __ott: true, roomId: "room-1", type: "ott:spectate", ticket: "ticket-1" },
  });

  for (const value of [
    envelope("ott:spectate"),
    envelope("ott:spectate", { ticket: "" }),
    JSON.stringify({ __ott: true, roomId: "room-1", type: "ott:spectate", ticket: "ticket-1", extra: true }),
    JSON.stringify({ __ott: true, roomId: "", type: "ott:spectate", ticket: "ticket-1" }),
    JSON.stringify({ __ott: true, roomId: 1, type: "ott:spectate", ticket: "ticket-1" }),
    envelope("ott:unknown", { ticket: "ticket-1" }),
    "{not-json",
    JSON.stringify({ __ott: true, roomId: "room-1", type: "ott:spectate", ticket: "x".repeat(8 * 1024) }),
  ]) {
    assert.equal(parseOttMessage(value).ok, false, value.slice(0, 80));
  }
});

test("compiled protocol validates response room and revision symmetrically", async () => {
  const { parseOttResponse } = await protocolModule();
  assert.deepEqual(parseOttResponse(JSON.stringify({
    __ott: true,
    roomId: "room-1",
    revision: 0,
    type: "ott:state",
    state: { opaque: true },
  })), {
    ok: true,
    value: { __ott: true, roomId: "room-1", revision: 0, type: "ott:state", state: { opaque: true } },
  });
  for (const response of [
    { __ott: true, roomId: "", revision: 0, type: "ott:ack", ok: true },
    { __ott: true, roomId: "room-1", revision: -1, type: "ott:ack", ok: true },
  ]) {
    assert.equal(parseOttResponse(JSON.stringify(response)).ok, false);
  }
});

test("custom-message bridge is implemented at YServer boundary without super dispatch", () => {
  const source = fs.readFileSync(path.join(root, "apps", "worker", "src", "game", "ott-game-server.ts"), "utf8");
  assert.match(source, /override\s+onCustomMessage\s*\(/);
  assert.match(source, /sendCustomMessage\s*\(/);
  assert.match(source, /onCustomMessage[\s\S]*?parseOttMessage/);
  assert.doesNotMatch(source, /super\.onCustomMessage/);
  assert.match(source, /lastOttPacketMs/);
  assert.match(source, /MIN_OTT_PACKET_INTERVAL_MS/);
  assert.match(source, /onClose[\s\S]*?delete/);
});

test("custom-message policy keeps client Yjs mutations read-only and non-OTT messages isolated", () => {
  const source = fs.readFileSync(path.join(root, "apps", "worker", "src", "game", "ott-game-server.ts"), "utf8");
  assert.match(source, /isReadOnly\([^)]*\):\s*boolean\s*\{[\s\S]*?return true/);
  assert.match(source, /non-OTT|not an OTT|Non-OTT/i);
  assert.doesNotMatch(source, /new\s+WebSocket|PartySocket/);
});
