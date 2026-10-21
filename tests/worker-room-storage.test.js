const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
let loadedRoomStorage;

async function roomStorageModule() {
  if (!loadedRoomStorage) {
    const { buildSync } = require("esbuild");
    const Module = require("node:module");
    const { outputFiles } = buildSync({
      entryPoints: [path.join(root, "apps", "worker", "src", "persistence", "room-storage.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false,
    });
    const filename = path.join(root, "apps", "worker", "src", "persistence", "room-storage-deadline-test.cjs");
    const bundledModule = new Module(filename, module);
    bundledModule.filename = filename;
    bundledModule.paths = Module._nodeModulePaths(root);
    bundledModule._compile(outputFiles[0].text, filename);
    loadedRoomStorage = bundledModule.exports;
  }
  return loadedRoomStorage;
}

function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const alarms = [];
  return {
    values,
    alarms,
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, value); },
    async list(options = {}) {
      return new Map([...values].filter(([key]) => !options.prefix || key.startsWith(options.prefix)));
    },
    async setAlarm(deadline) { alarms.push(deadline); values.set("alarm", deadline); },
    async deleteAlarm() { values.set("alarm", null); },
  };
}

test("creator-never-attaches deadline returns an explicit terminal outcome", async () => {
  const { DurableRoomAdapter } = await roomStorageModule();
  let now = 100;
  const storage = fakeStorage({ creatorAttachDeadlineMs: 500 });
  const adapter = await DurableRoomAdapter.create("ott-deadline-create", storage, () => now);

  assert.equal(storage.values.get("alarm"), 500);
  now = 500;
  const first = await adapter.onAlarm();
  const repeated = await adapter.onAlarm();

  assert.equal(first.terminalReason, "creator_attach_timeout");
  assert.equal(repeated, null);
  assert.equal(storage.values.get("creatorAttachDeadlineConsumed"), true);
  assert.equal(storage.values.get("terminalRetryReason"), "creator_attach_timeout");
  assert.ok(first.payload);
});

test("waiting disconnect deadline uses the reconnect deadline and expires once", async () => {
  const { DurableRoomAdapter } = await roomStorageModule();
  let now = 100;
  const storage = fakeStorage({ creatorAttachDeadlineMs: 900 });
  const adapter = await DurableRoomAdapter.create("ott-deadline-disconnect", storage, () => now, {
    reconnectGraceMs: 100,
  });
  const connection = { id: "creator", open: true, send() {} };
  assert.equal((await adapter.attach(connection, "A", "Alice")).ok, true);
  now = 200;
  await adapter.close(connection);
  assert.equal(storage.values.get("alarm"), 300);

  now = 300;
  const expired = await adapter.onAlarm();
  const stale = await adapter.onAlarm();
  assert.equal(expired.waiting.expired, true);
  assert.equal(adapter.room.status, "done");
  assert.equal(stale, null);
  assert.equal(storage.values.get("terminalRetryReason"), "disconnect_timeout");
});

test("earliest clock, reconnect, and creator deadline wins", async () => {
  const { DurableRoomAdapter } = await roomStorageModule();
  let now = 100;
  const storage = fakeStorage({
    creatorName: "Alice",
    "seat-name:B": "Bob",
    creatorAttachDeadlineMs: 900,
  });
  const adapter = await DurableRoomAdapter.create("ott-deadline-earliest", storage, () => now);
  const a = { id: "a", open: true, send() {} };
  const b = { id: "b", open: true, send() {} };
  await adapter.attach(a, "A");
  now = 200;
  await adapter.attach(b, "B");

  adapter.room.players.B.connected = false;
  adapter.room.players.B.reconnectDeadlineMs = 250;
  adapter.room.state.clock.runningSeat = "A";
  adapter.room.state.clock.remainingMs.A = 400;
  adapter.room.clockAnchorMs = 200;
  await adapter.scheduleAlarm();

  assert.equal(storage.values.get("alarm"), 250);
});

test("attach rollback restores the exact persisted snapshot without settling elapsed clock time", async () => {
  const { DurableRoomAdapter, ROOM_KEY } = await roomStorageModule();
  let now = 100;
  const storage = fakeStorage({ creatorName: "Alice", "seat-name:B": "Bob" });
  const adapter = await DurableRoomAdapter.create("ott-rollback-clock", storage, () => now);
  const playerA = { id: "rollback-clock-A", open: true, send() {} };
  const playerB = { id: "rollback-clock-B", open: true, send() {} };
  assert.equal((await adapter.attach(playerA, "A")).ok, true);
  adapter.commitAttach(playerA);
  assert.equal((await adapter.attach(playerB, "B")).ok, true);
  adapter.commitAttach(playerB);

  now = 200;
  await adapter.close(playerB);
  const beforeAttach = structuredClone(storage.values.get(ROOM_KEY));
  const beforePayload = structuredClone(adapter.lastPayload);

  now = 1_200;
  const retryB = { id: "rollback-clock-B-retry", open: true, send() {} };
  assert.equal((await adapter.attach(retryB, "B")).ok, true);
  await adapter.rollbackAttach(retryB);

  assert.deepEqual(storage.values.get(ROOM_KEY), beforeAttach);
  assert.deepEqual(adapter.lastPayload, beforePayload);
  assert.equal(adapter.room.revision, beforeAttach.revision);
  assert.equal(adapter.room.clockAnchorMs, beforeAttach.clockAnchorMs);
  assert.equal(adapter.room.nextEventId, beforeAttach.nextEventId);
  assert.equal(adapter.room.players.A.connection, playerA);
  assert.equal(adapter.room.players.B.connected, false);
  assert.deepEqual(adapter.connectionsSnapshot(), [playerA]);
});

test("stale alarm does not expire or duplicate lifecycle terminalization", async () => {
  const { DurableRoomAdapter } = await roomStorageModule();
  let now = 100;
  const storage = fakeStorage({ creatorAttachDeadlineMs: 500 });
  const adapter = await DurableRoomAdapter.create("ott-deadline-stale", storage, () => now);

  now = 499;
  const stale = await adapter.onAlarm();
  assert.equal(stale.terminalReason, undefined);
  assert.equal(storage.values.get("creatorAttachDeadlineConsumed"), undefined);
  assert.equal(storage.values.get("alarm"), 500);

  now = 500;
  assert.equal((await adapter.onAlarm()).terminalReason, "creator_attach_timeout");
  assert.equal(await adapter.onAlarm(), null);
});

test("terminal Room alarm schedules cleanup retry", async () => {
  const { DurableRoomAdapter } = await roomStorageModule();
  let now = 100;
  const storage = fakeStorage({ creatorName: "Alice" });
  const adapter = await DurableRoomAdapter.create("ott-deadline-terminal", storage, () => now);
  const connection = { id: "creator", open: true, send() {} };
  await adapter.attach(connection, "A");
  await adapter.leave(connection);
  assert.equal(adapter.room.status, "done");

  assert.equal(storage.values.get("alarm"), 1_100);
  await adapter.onAlarm();
  assert.equal(storage.values.get("terminalRetryReason"), "leave");
});

test("terminal leave remains a durable outcome when alarm scheduling fails", async () => {
  const { DurableRoomAdapter, ROOM_KEY } = await roomStorageModule();
  let now = 100;
  const storage = fakeStorage({ creatorName: "Alice" });
  const adapter = await DurableRoomAdapter.create("ott-deadline-alarm-failure", storage, () => now);
  const connection = { id: "creator", open: true, send() {} };
  await adapter.attach(connection, "A");

  storage.setAlarm = async () => { throw new Error("alarm storage unavailable"); };
  const left = await adapter.leave(connection);

  assert.equal(left.result.ok, true);
  assert.equal(adapter.room.status, "done");
  assert.equal(storage.values.get(ROOM_KEY).status, "done");
  assert.equal(storage.values.get("allocationTerminalReason"), undefined);
  assert.equal(left.terminalReason, "leave");
});

test("terminal leave schedules an alarm retry without calling Lobby", async () => {
  const { DurableRoomAdapter } = await roomStorageModule();
  let now = 100;
  const storage = fakeStorage({ creatorName: "Alice" });
  const adapter = await DurableRoomAdapter.create("ott-deadline-lobby-retry", storage, () => now);
  const connection = { id: "creator", open: true, send() {} };
  await adapter.attach(connection, "A");

  const left = await adapter.leave(connection);
  assert.equal(left.result.ok, true);
  assert.equal(storage.values.get("allocationTerminalReason"), undefined);
  assert.equal(storage.values.get("alarm"), 1_100);
  assert.equal(adapter.unavailable, false);

  now = 1_100;
  assert.equal((await adapter.onAlarm()).terminalReason, "leave");
  assert.equal(storage.values.get("terminalRetryReason"), "leave");
});

test("clock timeout returns one durable terminal outcome", async () => {
  const { DurableRoomAdapter } = await roomStorageModule();
  let now = 100;
  const storage = fakeStorage({ creatorName: "Alice", "seat-name:B": "Bob" });
  const adapter = await DurableRoomAdapter.create("ott-deadline-timeout", storage, () => now);
  await adapter.attach({ id: "a", open: true, send() {} }, "A");
  await adapter.attach({ id: "b", open: true, send() {} }, "B");
  adapter.room.state.clock.remainingMs.A = 10;
  adapter.room.clockAnchorMs = now;
  await adapter.scheduleAlarm();

  now = 110;
  const expired = await adapter.onAlarm();
  assert.equal(expired.terminalReason, "timeout");
  assert.equal(adapter.room.status, "done");
  assert.equal(storage.values.get("terminalRetryReason"), "timeout");
  assert.equal(await adapter.onAlarm(), null);
});

test("hydrated terminal alarm materializes its payload", async () => {
  const { DurableRoomAdapter } = await roomStorageModule();
  let now = 100;
  const storage = fakeStorage({ creatorName: "Alice" });
  const adapter = await DurableRoomAdapter.create("ott-deadline-hydrated-terminal", storage, () => now);
  await adapter.attach({ id: "creator", open: true, send() {} }, "A");
  await adapter.leave({ id: "creator", open: true, send() {} });

  const hydrated = await DurableRoomAdapter.load("ott-deadline-hydrated-terminal", storage, () => now);
  assert.ok(hydrated);
  const outcome = await hydrated.onAlarm();
  assert.equal(outcome.terminalReason, "leave");
  assert.deepEqual(outcome.payload, hydrated.room.payload());
});

test("hydration reconciles alarm from the original absolute creator deadline", async () => {
  const { DurableRoomAdapter } = await roomStorageModule();
  let now = 100;
  const storage = fakeStorage({ creatorAttachDeadlineMs: 700 });
  await DurableRoomAdapter.create("ott-deadline-hydration", storage, () => now);

  now = 600;
  const hydrated = await DurableRoomAdapter.load("ott-deadline-hydration", storage, () => now);
  assert.equal(storage.values.get("alarm"), 700);
  assert.equal(storage.values.get("creatorAttachDeadlineMs"), 700);
  assert.ok(hydrated);
});

test("hydration refreshes lastPayload after reconciling live seats", async () => {
  const { DurableRoomAdapter } = await roomStorageModule();
  let now = 100;
  const storage = fakeStorage({ creatorName: "Alice", "seat-name:B": "Bob" });
  const adapter = await DurableRoomAdapter.create("ott-hydration-payload", storage, () => now, { reconnectGraceMs: 1000 });
  const playerA = { id: "hydration-a", open: true, send() {} };
  const playerB = { id: "hydration-b", open: true, send() {} };
  await adapter.attach(playerA, "A");
  adapter.commitAttach(playerA);
  await adapter.attach(playerB, "B");
  adapter.commitAttach(playerB);
  const persistedPayload = structuredClone(adapter.lastPayload);

  now = 200;
  const hydrated = await DurableRoomAdapter.load("ott-hydration-payload", storage, () => now, { reconnectGraceMs: 1000 });

  assert.ok(hydrated);
  assert.ok(hydrated.lastPayload.revision > persistedPayload.revision);
  assert.equal(hydrated.lastPayload.players.A.connected, false);
  assert.equal(hydrated.lastPayload.players.B.connected, false);
  assert.equal(hydrated.lastPayload.state.clock.runningSeat, null);
});

test("nonce expiry participates in the shared earliest alarm", async () => {
  const { DurableRoomAdapter } = await roomStorageModule();
  const storage = fakeStorage({ "spectate-nonce:expired-soon": 450 });
  const adapter = await DurableRoomAdapter.create("ott-nonce-alarm", storage, () => 100);

  await adapter.scheduleAlarm();

  assert.equal(storage.values.get("alarm"), 450);
});

test("markTerminalized keeps the room for the retention window and arms the wipe alarm", async () => {
  const { DurableRoomAdapter, TERMINAL_GC_KEY } = await roomStorageModule();
  let now = 100;
  const storage = fakeStorage({ creatorName: "Alice" });
  const adapter = await DurableRoomAdapter.create("ott-terminal-retention", storage, () => now, { retentionMs: 5_000 });
  await adapter.attach({ id: "creator", open: true, send() {} }, "A");
  await adapter.leave({ id: "creator", open: true, send() {} });

  await adapter.markTerminalized("leave");

  assert.equal(storage.values.get(TERMINAL_GC_KEY), 5_100);
  assert.equal(storage.values.get("alarm"), 5_100);
  await adapter.scheduleAlarm();
  assert.equal(storage.values.get("alarm"), 5_100, "later alarm scheduling must not drop the wipe deadline");
});

async function playingAdapter(roomId, now) {
  const { DurableRoomAdapter } = await roomStorageModule();
  const storage = fakeStorage({ creatorName: "Alice", "seat-name:B": "Bob" });
  const adapter = await DurableRoomAdapter.create(roomId, storage, now, { reconnectGraceMs: 60_000 });
  const playerA = { id: `${roomId}-a`, open: true, send() {} };
  const playerB = { id: `${roomId}-b`, open: true, send() {} };
  await adapter.attach(playerA, "A");
  adapter.commitAttach(playerA);
  await adapter.attach(playerB, "B");
  adapter.commitAttach(playerB);
  return { DurableRoomAdapter, storage, adapter, playerA, playerB };
}

test("reattaching only the off-turn seat keeps the disconnected on-turn seat's clock stopped", async () => {
  let now = 1_000;
  const { storage, adapter, playerA, playerB } = await playingAdapter("ott-resume-off-turn", () => now);
  assert.equal((await adapter.move(playerA, { x: 4, y: 7 }, { x: 3, y: 6 })).result.ok, true);
  await adapter.close(playerB);
  await adapter.close(playerA);

  now = 2_000;
  const returningA = { id: "ott-resume-off-turn-a2", open: true, send() {} };
  assert.equal((await adapter.attach(returningA, "A")).ok, true);
  adapter.commitAttach(returningA);

  assert.equal(adapter.room.state.turn, "B");
  assert.equal(adapter.room.state.clock.runningSeat, null);
  // The next alarm is B's reconnect deadline, not a clock deadline for the absent seat.
  assert.equal(storage.values.get("alarm"), adapter.room.players.B.reconnectDeadlineMs);
  const remainingB = adapter.room.state.clock.remainingMs.B;
  now = 30_000;
  await adapter.onAlarm();
  assert.equal(adapter.room.state.clock.remainingMs.B, remainingB);

  const returningB = { id: "ott-resume-off-turn-b2", open: true, send() {} };
  assert.equal((await adapter.attach(returningB, "B")).ok, true);
  adapter.commitAttach(returningB);
  assert.equal(adapter.room.state.clock.runningSeat, "B");
});

test("restoreLiveConnection does not start the clock of a seat that is still disconnected", async () => {
  let now = 1_000;
  const { DurableRoomAdapter, storage, adapter, playerA, playerB } = await playingAdapter("ott-restore-live", () => now);
  assert.equal((await adapter.move(playerA, { x: 4, y: 7 }, { x: 3, y: 6 })).result.ok, true);

  now = 2_000;
  const hydrated = await DurableRoomAdapter.load("ott-restore-live", storage, () => now, { reconnectGraceMs: 60_000 });
  assert.equal(hydrated.room.state.clock.runningSeat, null);

  assert.equal(hydrated.restoreLiveConnection(playerA, "A"), true);
  assert.equal(hydrated.room.state.turn, "B");
  assert.equal(hydrated.room.state.clock.runningSeat, null);

  assert.equal(hydrated.restoreLiveConnection(playerB, "B"), true);
  assert.equal(hydrated.room.state.clock.runningSeat, "B");
});

test("B attaching while the creator is inside its grace window does not run the creator's clock", async () => {
  let now = 1_000;
  const { DurableRoomAdapter } = await roomStorageModule();
  const storage = fakeStorage({ creatorName: "Alice", "seat-name:B": "Bob" });
  const adapter = await DurableRoomAdapter.create("ott-join-during-grace", storage, () => now, { reconnectGraceMs: 60_000 });
  const playerA = { id: "ott-join-during-grace-a", open: true, send() {} };
  await adapter.attach(playerA, "A");
  adapter.commitAttach(playerA);
  await adapter.close(playerA);

  now = 5_000;
  const playerB = { id: "ott-join-during-grace-b", open: true, send() {} };
  assert.equal((await adapter.attach(playerB, "B")).ok, true);
  adapter.commitAttach(playerB);

  assert.equal(adapter.room.status, "playing");
  assert.equal(adapter.room.state.clock.runningSeat, null);
  assert.equal(storage.values.get("alarm"), adapter.room.players.A.reconnectDeadlineMs);

  now = 20_000;
  await adapter.onAlarm();
  assert.equal(adapter.room.state.clock.remainingMs.A, adapter.room.initialClockMs);
});
