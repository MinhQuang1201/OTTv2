const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { OttRoom } = require("../partykit/ott-room");
const { PartyKitOttRoom } = require("../partykit/ott-room");
const { serializeRoom, hydrateRoom } = require("../partykit/room-storage");
const config = require("../config");

function connection(id) {
  const inbox = [];
  return {
    id,
    readyState: 1,
    inbox,
    send(message) {
      inbox.push(JSON.parse(message));
    }
  };
}

function storage() {
  const values = new Map();
  const alarms = [];
  const writes = [];
  return {
    values,
    alarms,
    writes,
    async get(key) { return values.get(key); },
    async put(key, value) { writes.push({ key, value }); values.set(key, value); },
    async setAlarm(deadline) { alarms.push({ type: "set", deadline }); },
    async deleteAlarm() { alarms.push({ type: "delete" }); }
  };
}

/* context */
function context(id = "TEST", store = storage(), start = 0) {
  let now = start;
  let nextTimer = 1;
  const timers = new Map();
  return {
    store,
    ctx: {
      id,
      storage: store,
      now: () => now,
      schedule(fn, delay) {
        const timer = nextTimer++;
        timers.set(timer, { fn, at: now + delay, delay });
        return timer;
      },
      cancel(timer) { timers.delete(timer); }
    },
    advance(ms) {
      now += ms;
      for (const [timer, job] of [...timers]) {
        if (job.at <= now) {
          timers.delete(timer);
          job.fn();
        }
      }
    }
  };
}

function partyKitRoom(fixture) {
  return new PartyKitOttRoom({
    id: "TEST",
    storage: fixture.store,
    context: { now: fixture.ctx.now }
  });
}

async function started(testContext) {
  const room = new OttRoom(testContext.ctx);
  await room.onStart();
  return room;
}

describe("PartyKit authoritative room", () => {
  it("rejects direct create and list commands", async () => {
    const fixture = context();
    const room = await started(fixture);
    const player = connection("player");
    await room.onConnect(player);

    await room.onMessage(player, JSON.stringify({ type: "ott:create", name: "A" }));
    fixture.advance(40);
    await room.onMessage(player, JSON.stringify({ type: "ott:list" }));

    assert.deepEqual(player.inbox.slice(-2), [
      { type: "ott:error", message: "Lệnh không hỗ trợ" },
      { type: "ott:error", message: "Lệnh không hỗ trợ" }
    ]);
    assert.equal(room.room.players.A, null);
  });

  it("refuses a corrupt stored room with a stable unavailable error", async () => {
    const fixture = context();
    await fixture.store.put("room", { schemaVersion: 1 });
    const room = new OttRoom(fixture.ctx);
    const player = connection("player");

    await room.onStart();
    await room.onConnect(player);
    await room.onMessage(player, JSON.stringify({ type: "ott:ping" }));

    assert.deepEqual(player.inbox.at(-1), { type: "ott:error", message: "Phòng không khả dụng" });
  });

  it("assigns seats and sends recipient-specific ott snapshots", async () => {
    const fixture = context();
    const room = await started(fixture);
    const a = connection("a");
    const b = connection("b");

    await room.onConnect(a);
    await room.onMessage(a, JSON.stringify({ type: "ott:create", name: "An" }));
    await room.onConnect(b);
    await room.onMessage(b, JSON.stringify({ type: "ott:join", roomId: "TEST", name: "Bình" }));

    assert.equal(a.inbox.find((msg) => msg.type === "ott:joined").you, "A");
    assert.equal(b.inbox.find((msg) => msg.type === "ott:joined").you, "B");
    const aState = a.inbox.filter((msg) => msg.type === "ott:state").at(-1);
    const bState = b.inbox.filter((msg) => msg.type === "ott:state").at(-1);
    assert.equal(aState.you, "A");
    assert.equal(bState.you, "B");
    assert.equal(aState.players.A.name, "An");
    assert.equal(aState.players.B.name, "Bình");
    assert.equal(aState.players.A.resumeToken, undefined);
  });

  it("rejects a third player and invalid moves without changing Room state", async () => {
    const fixture = context();
    const room = await started(fixture);
    const a = connection("a");
    const b = connection("b");
    const c = connection("c");
    await room.onConnect(a);
    await room.onMessage(a, JSON.stringify({ type: "ott:create", name: "A" }));
    await room.onConnect(b);
    await room.onMessage(b, JSON.stringify({ type: "ott:join", roomId: "TEST", name: "B" }));
    await room.onConnect(c);
    await room.onMessage(c, JSON.stringify({ type: "ott:join", roomId: "TEST", name: "C" }));
    assert.equal(c.inbox.at(-1).type, "ott:error");

    const before = JSON.stringify(room.room.state);
    await room.onMessage(b, JSON.stringify({ type: "ott:move", from: { x: 2, y: 2 }, to: { x: 3, y: 2 } }));
    assert.equal(b.inbox.at(-1).type, "ott:error");
    assert.equal(JSON.stringify(room.room.state), before);
  });

  it("rejects malformed, oversized, rate-limited, and unseated commands without mutation", async () => {
    const fixture = context();
    const room = await started(fixture);
    const a = connection("a");
    await room.onConnect(a);
    await room.onMessage(a, JSON.stringify({ type: "ott:create", name: "A" }));
    fixture.advance(40);

    const before = JSON.stringify(room.room);
    await room.onMessage(a, "{");
    assert.equal(JSON.stringify(room.room), before);
    fixture.advance(40);
    await room.onMessage(a, JSON.stringify({ type: "ott:create", name: "x".repeat(config.MAX_MESSAGE) }));
    assert.equal(JSON.stringify(room.room), before);

    const unseated = connection("unseated");
    await room.onConnect(unseated);
    fixture.advance(40);
    await room.onMessage(unseated, JSON.stringify({ type: "ott:move", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }));
    assert.equal(JSON.stringify(room.room), before);

    await room.onMessage(a, JSON.stringify({ type: "ott:ping" }));
    assert.equal(JSON.stringify(room.room), before);
  });

  it("keeps resume tokens private and rejects token reuse", async () => {
    const fixture = context();
    const room = await started(fixture);
    const a = connection("a");
    const b = connection("b");
    await room.onConnect(a);
    await room.onMessage(a, JSON.stringify({ type: "ott:create", name: "A" }));
    await room.onConnect(b);
    fixture.advance(40);
    await room.onMessage(b, JSON.stringify({ type: "ott:join", roomId: "TEST", name: "B" }));
    const token = a.inbox.find((message) => message.type === "ott:joined").resumeToken;
    assert.equal(JSON.stringify(b.inbox).includes(token), false);
    assert.equal(JSON.stringify(a.inbox.filter((message) => message.type === "ott:state")).includes(token), false);

    await room.onClose(a);
    const resumed = connection("a2");
    await room.onConnect(resumed);
    fixture.advance(40);
    await room.onMessage(resumed, JSON.stringify({ type: "ott:resume", roomId: "TEST", resumeToken: token }));
    assert.equal(resumed.inbox.at(-1).type, "ott:state");

    const reused = connection("a3");
    await room.onConnect(reused);
    fixture.advance(40);
    await room.onMessage(reused, JSON.stringify({ type: "ott:resume", roomId: "TEST", resumeToken: token }));
    assert.equal(reused.inbox.at(-1).type, "ott:error");
    assert.equal(JSON.stringify(room.room.players.A.connection.id), JSON.stringify("a2"));
  });

  it("broadcasts a legal move and emits gameover exactly once", async () => {
    const fixture = context();
    const room = await started(fixture);
    const a = connection("a");
    const b = connection("b");
    await room.onConnect(a);
    await room.onMessage(a, JSON.stringify({ type: "ott:create", name: "A" }));
    await room.onConnect(b);
    await room.onMessage(b, JSON.stringify({ type: "ott:join", roomId: "TEST", name: "B" }));

    room.room.state.pieces = [
      { id: "A-dam-0", player: "A", type: "dam", x: 0, y: 7 },
      { id: "B-keo-0", player: "B", type: "keo", x: 5, y: 5 }
    ];
    fixture.advance(40);
    await room.onMessage(a, JSON.stringify({ type: "ott:move", from: { x: 0, y: 7 }, to: { x: 0, y: 8 } }));
    fixture.advance(40);
    await room.onMessage(a, JSON.stringify({ type: "ott:move", from: { x: 0, y: 7 }, to: { x: 0, y: 8 } }));

    assert.equal(a.inbox.filter((msg) => msg.type === "ott:gameover").length, 1);
    assert.equal(b.inbox.filter((msg) => msg.type === "ott:gameover").length, 1);
    assert.equal(a.inbox.filter((msg) => msg.type === "ott:state").at(-1).you, "A");
  });

  it("keeps a disconnected seat resumable and persists absolute deadlines", async () => {
    const fixture = context();
    const room = await started(fixture);
    const a = connection("a");
    const b = connection("b");
    await room.onConnect(a);
    await room.onMessage(a, JSON.stringify({ type: "ott:create", name: "A" }));
    await room.onConnect(b);
    await room.onMessage(b, JSON.stringify({ type: "ott:join", roomId: "TEST", name: "B" }));
    const token = room.room.players.B.resumeToken;
    await room.onClose(b);

    const saved = fixture.store.values.get("room");
    assert.equal(saved.schemaVersion, 1);
    assert.equal(saved.players.B.resumeToken, token);
    assert.equal(saved.players.B.connected, false);
    assert.equal(saved.players.B.reconnectDeadlineMs, config.TIME_CONTROL.reconnectGraceMs);
    assert.equal(saved.players.B.ws, undefined);

    const restored = hydrateRoom(saved, "TEST", { now: () => 1, schedule: () => 1, cancel() {} });
    assert.equal(restored.players.B.connected, false);
    assert.equal(restored.players.B.reconnectDeadlineMs, config.TIME_CONTROL.reconnectGraceMs);
    assert.throws(() => hydrateRoom({ schemaVersion: 2 }, "TEST"), /schemaVersion/);
  });

  it("settles elapsed active clock time when hydrating", async () => {
    const fixture = context("TEST", storage(), 0);
    const room = await started(fixture);
    const a = connection("a");
    const b = connection("b");
    await room.onConnect(a);
    await room.onMessage(a, JSON.stringify({ type: "ott:create", name: "A" }));
    await room.onConnect(b);
    await room.onMessage(b, JSON.stringify({ type: "ott:join", roomId: "TEST", name: "B" }));
    const saved = serializeRoom(room.room);
    const restored = hydrateRoom(saved, "TEST", { now: () => 1500, schedule: () => 1, cancel() {} });
    const elapsed = restored.settleClock(1500);
    assert.equal(elapsed.ok, true);
    assert.equal(restored.state.clock.remainingMs.A, config.TIME_CONTROL.initialMs - 1500);
  });

  it("persists a changed hydrated clock exactly once on start", async () => {
    const fixture = context("TEST", storage(), 0);
    const original = await started(fixture);
    const a = connection("a");
    const b = connection("b");
    await original.onConnect(a);
    await original.onMessage(a, JSON.stringify({ type: "ott:create", name: "A" }));
    await original.onConnect(b);
    await original.onMessage(b, JSON.stringify({ type: "ott:join", roomId: "TEST", name: "B" }));
    const writesBefore = fixture.store.writes.length;
    const restored = context("TEST", fixture.store, 1500);
    const room = new OttRoom(restored.ctx);

    await room.onStart();

    assert.equal(fixture.store.writes.length, writesBefore + 1);
    assert.equal(fixture.store.values.get("room").state.clock.remainingMs.A, config.TIME_CONTROL.initialMs - 1500);
    assert.equal(fixture.store.values.get("room").revision, 3);
  });

  it("persists revision and next event id and rehydrates without live connections or timers", () => {
    const fixture = context();
    const room = new (require("../room").Room)("TEST", fixture.ctx);
    room.revision = 7;
    room.nextEventId = 12;
    room.players.A = {
      name: "A", seat: "A", connected: true, connection: connection("a"),
      resumeToken: "token-a", reconnectDeadlineMs: null
    };
    const restored = hydrateRoom(serializeRoom(room), "TEST", fixture.ctx);

    assert.equal(serializeRoom(room).revision, 7);
    assert.equal(serializeRoom(room).nextEventId, 12);
    assert.equal(restored.revision, 7);
    assert.equal(restored.nextEventId, 12);
    assert.equal(restored.players.A.connected, false);
    assert.equal(restored.players.A.connection, null);
    assert.equal(restored.clockTimer, null);
    assert.equal(restored.reconnectTimers.size, 0);
  });

  it("rejects malformed persisted room schemas closed", () => {
    const room = new (require("../room").Room)("TEST");
    const saved = serializeRoom(room);
    const invalid = [
      ["status", { status: "unknown" }],
      ["state shape", { state: { ...saved.state, pieces: [{ ...saved.state.pieces[0], id: saved.state.pieces[1].id }, saved.state.pieces[1]] } }],
      ["occupancy", { state: { ...saved.state, pieces: [{ ...saved.state.pieces[0], x: saved.state.pieces[1].x, y: saved.state.pieces[1].y }, saved.state.pieces[1]] } }],
      ["turn", { state: { ...saved.state, turn: "C" } }],
      ["winner reason", { state: { ...saved.state, winner: "A", reason: null } }],
      ["clock", { state: { ...saved.state, clock: { remainingMs: { A: -1, B: 1 }, runningSeat: "A" } } }],
      ["player", { players: { A: { ...saved.players.A, seat: "B" }, B: null } }],
      ["event id", { lastEvents: [{ type: "move", id: 0 }] }],
      ["revision", { revision: -1 }],
      ["next event id", { nextEventId: 0 }]
    ];

    for (const [label, patch] of invalid) {
      assert.throws(() => hydrateRoom({ ...saved, ...patch }, "TEST"), /Invalid persisted room/, label);
    }
  });

  it("rejects a terminal room with a running clock", () => {
    const room = new (require("../room").Room)("TEST");
    const saved = serializeRoom(room);
    saved.status = "done";
    saved.state.winner = "A";
    saved.state.reason = "goal";
    assert.throws(() => hydrateRoom(saved, "TEST"), /Invalid persisted room/);
  });

  it("schedules one absolute alarm for the active clock deadline", async () => {
    const fixture = context();
    const room = partyKitRoom(fixture);
    await room.onStart();
    const a = connection("a");
    const b = connection("b");
    await room.onConnect(a);
    await room.onMessage(JSON.stringify({ type: "ott:create", name: "A" }), a);
    await room.onConnect(b);
    await room.onMessage(JSON.stringify({ type: "ott:join", roomId: "TEST", name: "B" }), b);

    assert.equal(fixture.store.alarms.at(-1).type, "set");
    assert.equal(fixture.store.alarms.at(-1).deadline, config.TIME_CONTROL.initialMs);
    assert.equal(fixture.store.alarms.filter((alarm) => alarm.type === "set").length, 1);
  });

  it("schedules the earlier clock or reconnect deadline and clears it on resume", async () => {
    const fixture = context();
    const room = partyKitRoom(fixture);
    await room.onStart();
    const a = connection("a");
    const b = connection("b");
    await room.onConnect(a);
    await room.onMessage(JSON.stringify({ type: "ott:create", name: "A" }), a);
    await room.onConnect(b);
    await room.onMessage(JSON.stringify({ type: "ott:join", roomId: "TEST", name: "B" }), b);
    const token = room.impl.room.players.B.resumeToken;
    await room.onClose(b);

    assert.equal(fixture.store.alarms.at(-1).deadline, config.TIME_CONTROL.reconnectGraceMs);
    const reconnect = connection("b2");
    await room.onConnect(reconnect);
    await room.onMessage(JSON.stringify({ type: "ott:resume", roomId: "TEST", resumeToken: token }), reconnect);
    assert.equal(fixture.store.alarms.at(-1).deadline, config.TIME_CONTROL.initialMs);
  });

  it("hydrates on alarm, settles once, persists once, and clears a terminal alarm", async () => {
    const fixture = context();
    const original = await started(fixture);
    const a = connection("a");
    const b = connection("b");
    await original.onConnect(a);
    await original.onMessage(a, JSON.stringify({ type: "ott:create", name: "A" }));
    await original.onConnect(b);
    await original.onMessage(b, JSON.stringify({ type: "ott:join", roomId: "TEST", name: "B" }));
    const saved = fixture.store.values.get("room");
    const writesBefore = fixture.store.values.size;
    const party = partyKitRoom(fixture);
    party.impl.alarmDeadline = config.TIME_CONTROL.initialMs;
    await party.onAlarm();

    assert.equal(party.impl.room.status, "playing");
    assert.equal(fixture.store.values.size, writesBefore);

    fixture.advance(config.TIME_CONTROL.initialMs);
    await party.onAlarm();
    assert.equal(party.impl.room.status, "done");
    assert.equal(fixture.store.alarms.at(-1).type, "delete");
    assert.ok(fixture.store.values.get("room"));
    assert.equal(saved.status, "playing");
  });

  it("clears a terminal alarm after hydration without connected players", async () => {
    const fixture = context();
    const original = await started(fixture);
    const a = connection("a");
    await original.onConnect(a);
    await original.onMessage(a, JSON.stringify({ type: "ott:create", name: "A" }));
    original.room.state.winner = "A";
    original.room.state.reason = "goal";
    original.room.status = "done";
    original.room.state.clock.runningSeat = null;
    await fixture.store.put("room", serializeRoom(original.room));
    const party = partyKitRoom(fixture);
    party.impl.alarmDeadline = config.TIME_CONTROL.initialMs;
    await party.onAlarm();

    assert.equal(party.impl.room.status, "done");
    assert.equal(party.impl.connections.size, 0);
    assert.equal(fixture.store.alarms.at(-1).type, "delete");
  });
});
