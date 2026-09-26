const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { Room } = require("../room");
const { serializeRoom, hydrateRoom } = require("../partykit/room-storage");

function savedRoom() {
  return serializeRoom(new Room("TEST", { now: () => 1000 }));
}

describe("persisted room storage", () => {
  it("rejects fractional persisted clocks, timestamps, and reconnect deadlines", () => {
    const saved = savedRoom();
    saved.players.A = {
      name: "A",
      seat: "A",
      connected: false,
      resumeToken: "token-a",
      reconnectDeadlineMs: null
    };
    const invalid = [
      ["remaining clock", (room) => { room.state.clock.remainingMs.A = 1.5; }],
      ["created timestamp", (room) => { room.createdAt = 1000.5; }],
      ["clock anchor", (room) => { room.clockAnchorMs = 1000.5; }],
      ["reconnect deadline", (room) => { room.players.A.reconnectDeadlineMs = 1000.5; }]
    ];

    for (const [label, corrupt] of invalid) {
      const corrupted = structuredClone(saved);
      corrupt(corrupted);
      assert.throws(() => hydrateRoom(corrupted, "TEST"), /Invalid persisted room/, label);
    }
  });

  it("rejects persisted events whose IDs are not strictly ascending", () => {
    const saved = savedRoom();
    saved.nextEventId = 3;
    saved.lastEvents = [{ id: 2, type: "move" }, { id: 1, type: "move" }];

    assert.throws(() => hydrateRoom(saved, "TEST"), /Invalid persisted room/);
  });
});
