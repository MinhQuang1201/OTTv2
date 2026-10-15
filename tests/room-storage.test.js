const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { Room } = require("../packages/game-core/src/room");
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

  it("preserves clock-only structural revision floor across serialize and hydrate roundtrip", () => {
    let now = 1000;
    const room = new Room("TEST", { now: () => now });
    const a = { id: "c1", open: true, send: () => {} };
    const b = { id: "c2", open: true, send: () => {} };
    room.addPlayer(a, "An");
    room.addPlayer(b, "Bình");
    assert.equal(room.revision, 2);
    assert.equal(room.structuralRevision, 2);

    // Clock tick read advances transport revision while preserving structural floor
    now += 1500;
    const payload = room.payload();
    assert.equal(payload.revision, 3);
    assert.equal(room.revision, 3);
    assert.equal(room.structuralRevision, 2);

    // Serialize and verify schema properties
    const saved = serializeRoom(room);
    assert.equal(saved.revision, 3);
    assert.equal(saved.structuralRevision, 2);

    // Hydrate and verify restored room preserves both revisions
    const restored = hydrateRoom(saved, "TEST", { now: () => now });
    assert.equal(restored.revision, 3);
    assert.equal(restored.structuralRevision, 2);

    // Reattach connection to restored player A and verify move with floor expectedRevision is accepted
    restored.players.A.connected = true;
    restored.players.A.connection = a;
    const moveResult = restored.handleMove(a, { x: 4, y: 7 }, { x: 3, y: 6 }, 2);
    assert.equal(moveResult.ok, true);
    assert.equal(restored.revision, 4);
    assert.equal(restored.structuralRevision, 4);
  });

  it("defaults legacy persisted snapshot without structuralRevision fail-closed to current revision", () => {
    const saved = savedRoom();
    saved.revision = 6;
    delete saved.structuralRevision; // Legacy payload without structuralRevision field

    const restored = hydrateRoom(saved, "TEST");
    assert.equal(restored.revision, 6);
    assert.equal(restored.structuralRevision, 6, "fail-closed fallback defaults to current revision");
  });

  it("rejects malformed, negative, non-integer, and future structuralRevision in persisted snapshots", () => {
    const saved = savedRoom();
    saved.revision = 5;

    const invalid = [
      ["future floor", (room) => { room.structuralRevision = 6; }],
      ["negative floor", (room) => { room.structuralRevision = -1; }],
      ["fractional floor", (room) => { room.structuralRevision = 2.5; }],
      ["string floor", (room) => { room.structuralRevision = "2"; }],
      ["boolean floor", (room) => { room.structuralRevision = true; }]
    ];

    for (const [label, corrupt] of invalid) {
      const corrupted = structuredClone(saved);
      corrupt(corrupted);
      assert.throws(() => hydrateRoom(corrupted, "TEST"), /Invalid persisted room/, label);
    }
  });
});
