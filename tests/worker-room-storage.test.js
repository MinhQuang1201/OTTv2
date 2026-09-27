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
