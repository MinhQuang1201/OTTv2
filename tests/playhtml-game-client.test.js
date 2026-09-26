const test = require("node:test");
const assert = require("node:assert/strict");
const PlayhtmlGameClient = require("../playhtml-game-client");

function fakeConnection() {
  const handlers = {};
  return {
    sent: [],
    on(event, fn) { handlers[event] = fn; },
    connect() { handlers.open(); },
    send(message) { this.sent.push(message); },
    close() { handlers.close(); },
    receive(message) { handlers.message(message); }
  };
}

function ott(message) {
  return { __ott: true, ...message };
}

test("uses HTTPS allocation before PlayHTML attach and does not send lobby commands on the channel", async () => {
  const connection = fakeConnection();
  const requests = [];
  const client = new PlayhtmlGameClient({
    connectionFactory: () => connection,
    controlRequest: async (action, body) => {
      requests.push([action, body]);
      return { allocationId: "alloc-1", room: "ott-room", seat: "A", ticket: "opaque-ticket", resumeCredential: "owner-secret" };
    }
  });
  await client.connect();
  await client.create("An");

  assert.deepEqual(requests, [["create", { name: "An" }]]);
  assert.deepEqual(connection.sent, [{ __ott: true, type: "ott:attach", roomId: "OTT-ROOM", ticket: "opaque-ticket" }]);
});

test("uses the runtime bootstrap registered after the UI client is constructed", async () => {
  const previous = globalThis.OTT_PLAYHTML_BOOTSTRAP;
  const calls = [];
  const connection = fakeConnection();
  const client = new PlayhtmlGameClient({
    connectionFactory: () => connection,
    controlRequest: async () => {},
    playhtmlHost: "https://worker.example",
    storage: null,
  });
  globalThis.OTT_PLAYHTML_BOOTSTRAP = async (configuration) => { calls.push(configuration); };
  try {
    await client.attachAllocation({
      room: "ott-123e4567-e89b-12d3-a456-426614174000",
      allocationId: "123e4567-e89b-12d3-a456-426614174000",
      seat: "A",
      ticket: "ticket",
      resumeCredential: "owner",
    });
    assert.deepEqual(calls, [{ host: "https://worker.example", room: "ott-123e4567-e89b-12d3-a456-426614174000" }]);
  } finally {
    if (previous === undefined) delete globalThis.OTT_PLAYHTML_BOOTSTRAP;
    else globalThis.OTT_PLAYHTML_BOOTSTRAP = previous;
  }
});

test("first provider connection during allocation does not race attach with auto-resume", async () => {
  const connection = fakeConnection();
  const controls = [];
  const client = new PlayhtmlGameClient({
    connectionFactory: () => connection,
    controlRequest: async (action, body) => { controls.push([action, body]); return {}; },
    storage: null,
  });
  await client.attachAllocation({
    room: "ott-123e4567-e89b-12d3-a456-426614174000",
    allocationId: "123e4567-e89b-12d3-a456-426614174000",
    seat: "A",
    ticket: "initial-ticket",
    resumeCredential: "owner",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(controls, []);
  assert.deepEqual(connection.sent, [{
    __ott: true,
    type: "ott:attach",
    roomId: "ott-123e4567-e89b-12d3-a456-426614174000",
    ticket: "initial-ticket",
  }]);
});

test("unwraps recipient projection into the UI authoritative state message", async () => {
  const connection = fakeConnection();
  const client = new PlayhtmlGameClient({ connectionFactory: () => connection, storage: null });
  const received = [];
  client.on("state", (message) => received.push(message));
  await client.connect();
  const roomId = "ott-123e4567-e89b-12d3-a456-426614174000";
  const rulesState = { turn: "A", pieces: [{ id: "a1", player: "A", type: "la", x: 0, y: 2 }], clock: { runningSeat: "A", remainingMs: { A: 600_000, B: 600_000 } } };
  connection.receive(ott({
    type: "ott:state",
    roomId,
    revision: 2,
    state: {
      roomId,
      status: "playing",
      revision: 2,
      players: { A: { name: "Alice", connected: true }, B: { name: "Bob", connected: true } },
      state: rulesState,
      events: [],
      you: "A",
    },
  }));

  assert.equal(received[0].you, "A");
  assert.equal(received[0].status, "playing");
  assert.deepEqual(received[0].state, rulesState);
  assert.deepEqual(received[0].players.B, { name: "Bob", connected: true });
});

test("preserves the exact lowercase canonical Worker room ID on attach", async () => {
  const connection = fakeConnection();
  const room = "ott-abcdef12-3456-4abc-8def-1234567890ab";
  const client = new PlayhtmlGameClient({
    connectionFactory: () => connection,
    controlRequest: async () => ({ allocationId: "alloc-canonical", room, seat: "A", ticket: "canonical-ticket", resumeCredential: "canonical-owner" }),
    storage: { getItem() { return null; }, setItem() {}, removeItem() {} }
  });
  await client.connect();
  await client.create("An");

  assert.deepEqual(connection.sent, [{ __ott: true, type: "ott:attach", roomId: room, ticket: "canonical-ticket" }]);
  assert.equal(client.roomId, room);
});

test("stores only the owner credential, never the attach ticket, and resets on leave", async () => {
  const connection = fakeConnection();
  const storage = new Map();
  const client = new PlayhtmlGameClient({
    connectionFactory: () => connection,
    controlRequest: async () => ({ allocationId: "alloc-1", room: "ott-room", seat: "A", ticket: "opaque-ticket", resumeCredential: "owner-secret" }),
    storage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) }
  });
  await client.connect();
  await client.create("An");

  assert.equal(connection.sent[0].type, "ott:attach");
  assert.equal(storage.get("OTT-ROOM:resumeCredential"), "owner-secret");
  assert.equal([...storage.values()].includes("opaque-ticket"), false);
  client.leave();
  assert.equal(client.roomId, null);
  assert.equal(client.resumeContext, null);
  assert.equal(client.intentionalClose, true);
  assert.equal(client.stateRevision, null);
});

test("sends game commands in the exact bridge envelope", async () => {
  const connection = fakeConnection();
  const storage = new Map();
  const client = new PlayhtmlGameClient({
    connectionFactory: () => connection,
    storage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) }
  });
  const states = [];
  client.on("state", (message) => states.push(message));
  await client.connect();
  client.create("An");
  client.join("K7P2", "An");
  assert.equal(client.resume("K7P2", "secret"), false);
  client.list();
  client.move({ x: 1, y: 1 }, { x: 2, y: 2 });
  client.leave();
  connection.receive(ott({ type: "ott:joined", roomId: "K7P2", you: "A", resumeToken: "secret" }));
  connection.receive(ott({ type: "ott:state", roomId: "K7P2", revision: 0, you: "A", state: { turn: "A" } }));
  assert.deepEqual(connection.sent, [
    { __ott: true, type: "ott:create", name: "An" },
    { __ott: true, type: "ott:join", roomId: "K7P2", name: "An" },
    { __ott: true, type: "ott:list" },
    { __ott: true, type: "ott:move", roomId: "K7P2", from: { x: 1, y: 1 }, to: { x: 2, y: 2 } },
    { __ott: true, type: "ott:leave", roomId: "K7P2" }
  ]);
  assert.equal(states[0].state.turn, "A");
  assert.equal(storage.has("K7P2"), false);
});

test("rejects malformed moves locally", async () => {
  const connection = fakeConnection();
  const client = new PlayhtmlGameClient({ connectionFactory: () => connection });
  const errors = [];
  client.on("error", (error) => errors.push(error));
  await client.connect();
  assert.equal(client.move({ x: 1.2, y: 2 }, { x: 1, y: 1 }), false);
  assert.equal(connection.sent.length, 0);
  assert.equal(errors[0].message, "Tọa độ không hợp lệ");
});

test("keeps only newer authoritative state revisions", async () => {
  const connection = fakeConnection();
  const client = new PlayhtmlGameClient({ connectionFactory: () => connection });
  const states = [];
  client.on("state", (message) => states.push(message));
  await client.connect();

  connection.receive(ott({ type: "ott:state", roomId: "ab12", revision: 2, state: { turn: "B" } }));
  connection.receive(ott({ type: "ott:state", roomId: "AB12", revision: 1, state: { turn: "A" } }));
  connection.receive(ott({ type: "ott:state", roomId: "AB12", revision: 2, state: { turn: "A" } }));

  assert.equal(states.length, 1);
  assert.equal(client.state.turn, "B");
  assert.equal(client.roomId, "AB12");
});

test("ignores state messages without a valid nonnegative integer revision", async () => {
  const connection = fakeConnection();
  const client = new PlayhtmlGameClient({ connectionFactory: () => connection });
  const states = [];
  client.on("state", (message) => states.push(message));
  await client.connect();

  for (const revision of [undefined, null, "1", 1.5, -1]) {
    connection.receive(ott({ type: "ott:state", roomId: "AB12", revision, state: { revision } }));
  }
  connection.receive(ott({ type: "ott:state", roomId: "AB12", revision: 0, state: { turn: "A" } }));

  assert.equal(states.length, 1);
  assert.equal(states[0].revision, 0);
  assert.deepEqual(client.state, { turn: "A" });
});

test("deduplicates state events with a bounded event-id cache", async () => {
  const connection = fakeConnection();
  const client = new PlayhtmlGameClient({
    connectionFactory: () => connection,
    eventDedupeLimit: 2
  });
  const states = [];
  client.on("state", (message) => states.push(message));
  await client.connect();

  connection.receive(ott({ type: "ott:state", roomId: "AB12", revision: 1, events: [{ id: 1 }, { id: 2 }], state: {} }));
  connection.receive(ott({ type: "ott:state", roomId: "AB12", revision: 2, events: [{ id: 2 }, { id: 3 }], state: {} }));
  connection.receive(ott({ type: "ott:state", roomId: "AB12", revision: 3, events: [{ id: 1 }], state: {} }));

  assert.deepEqual(states.map((message) => message.events), [[{ id: 1 }, { id: 2 }], [{ id: 3 }], [{ id: 1 }]]);
});

test("normalizes room ids without trusting resume tokens in server messages", async () => {
  const connection = fakeConnection();
  const storage = new Map();
  const client = new PlayhtmlGameClient({
    connectionFactory: () => connection,
    storage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) }
  });
  await client.connect();
  connection.receive(ott({ type: "ott:joined", roomId: " ab12 ", resumeToken: "secret" }));
  connection.receive(ott({ type: "ott:state", roomId: " ab12 ", revision: 1, state: {} }));
  connection.close();

  assert.equal(client.roomId, "AB12");
  assert.equal(client.resumeContext, null);
  assert.equal(storage.has("AB12"), false);
});

test("does not put owner credentials on the custom channel during auto-resume", async () => {
  const connection = fakeConnection();
  const storage = new Map([["__last_room__", "AB12"], ["AB12:resumeCredential", "owner-secret"], ["AB12:allocation", JSON.stringify({ allocationId: "alloc-1", seat: "A" })]]);
  const requests = [];
  const client = new PlayhtmlGameClient({
    connectionFactory: () => connection,
    controlRequest: async (action, body) => { requests.push([action, body]); throw Object.assign(new Error("temporary"), { status: 503 }); },
    storage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) }
  });

  await client.connect();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(requests, [["resume", { allocationId: "alloc-1", resumeCredential: "owner-secret" }]]);
  assert.deepEqual(connection.sent, []);
});

test("auto-resume sends the owner credential only to control and stores the rotated credential, not its ticket", async () => {
  const connection = fakeConnection();
  const storage = new Map([
    ["__last_room__", "AB12"],
    ["AB12:resumeCredential", "old-owner-credential"],
    ["AB12:allocation", JSON.stringify({ allocationId: "alloc-1", seat: "B" })]
  ]);
  const requests = [];
  const client = new PlayhtmlGameClient({
    connectionFactory: () => connection,
    controlRequest: async (action, body) => {
      requests.push([action, body]);
      return { allocationId: "alloc-1", room: "ott-room", seat: "B", ticket: "one-use-attach-ticket", resumeCredential: "rotated-owner-credential" };
    },
    storage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) }
  });

  await client.connect();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(requests, [["resume", { allocationId: "alloc-1", resumeCredential: "old-owner-credential" }]]);
  assert.deepEqual(connection.sent, [{ __ott: true, type: "ott:attach", roomId: "OTT-ROOM", ticket: "one-use-attach-ticket" }]);
  assert.equal(storage.get("OTT-ROOM:resumeCredential"), "rotated-owner-credential");
  assert.equal([...storage.values()].includes("one-use-attach-ticket"), false);
  assert.equal(JSON.stringify(connection.sent).includes("owner-credential"), false);
  assert.deepEqual(client.resumeContext, { roomId: "OTT-ROOM", resumeCredential: "rotated-owner-credential", allocationId: "alloc-1", seat: "B" });
});

test("clears owner credentials only after explicit leave or stable resume rejection", async () => {
  const connection = fakeConnection();
  const storage = new Map([["__last_room__", "AB12"], ["AB12:resumeCredential", "owner-secret"], ["AB12:allocation", JSON.stringify({ allocationId: "alloc-1", seat: "A" })]]);
  const client = new PlayhtmlGameClient({
    connectionFactory: () => connection,
    controlRequest: async () => { throw Object.assign(new Error("rejected"), { status: 401, code: "resume_rejected" }); },
    storage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) }
  });
  await client.connect();
  assert.equal(await client.resume(" ab12 ", "owner-secret"), false);
  assert.equal(storage.has("AB12:resumeCredential"), false);
  storage.set("AB12:resumeCredential", "new-owner-secret");
  storage.set("AB12:allocation", JSON.stringify({ allocationId: "alloc-1", seat: "A" }));
  client.resumeContext = { roomId: "AB12", resumeCredential: "new-owner-secret", allocationId: "alloc-1", seat: "A" };
  client.leave();
  assert.equal(storage.has("AB12:resumeCredential"), false);
});

test("a stale resume rejection cannot clear a newer rotated owner credential", async () => {
  const connection = fakeConnection();
  const storage = new Map([[
    "AB12:allocation", JSON.stringify({ allocationId: "alloc-1", seat: "A" })
  ]]);
  let rejectOldRequest;
  const client = new PlayhtmlGameClient({
    connectionFactory: () => connection,
    controlRequest: () => new Promise((_resolve, reject) => { rejectOldRequest = reject; }),
    storage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) }
  });
  await client.connect();
  const pending = client.resume("AB12", "old-owner-credential");
  await new Promise((resolve) => setImmediate(resolve));
  await client.attachAllocation({ room: "AB12", allocationId: "alloc-1", seat: "A", ticket: "fresh-ticket", resumeCredential: "new-owner-credential" });
  rejectOldRequest(Object.assign(new Error("stale rejection"), { status: 401, code: "resume_rejected" }));
  assert.equal(await pending, false);

  assert.equal(storage.get("AB12:resumeCredential"), "new-owner-credential");
  assert.equal(client.resumeContext.resumeCredential, "new-owner-credential");
});

test("explicit join cancels auto-resume before requesting its own allocation", async () => {
  const connection = fakeConnection();
  const storage = new Map([["__last_room__", "AB12"], ["AB12:resumeCredential", "owner-secret"], ["AB12:allocation", JSON.stringify({ allocationId: "alloc-1", seat: "A" })]]);
  const requests = [];
  const client = new PlayhtmlGameClient({
    connectionFactory: () => connection,
    controlRequest: async (action, body) => { requests.push([action, body]); return { room: "CD34", allocationId: "alloc-2", seat: "B", ticket: "ticket-2", resumeCredential: "owner-2" }; },
    storage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) }
  });

  await client.connect();
  client.join("CD34", "An");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(connection.sent, [{ __ott: true, type: "ott:attach", roomId: "CD34", ticket: "ticket-2" }]);
  assert.deepEqual(requests, [["join", { allocationId: "CD34", name: "An" }]]);
  assert.equal(storage.has("AB12:resumeCredential"), false);
});

test("reconnects after leaving and starting another game", async () => {
  const first = fakeConnection();
  const second = fakeConnection();
  let connections = 0;
  let allocations = 0;
  const client = new PlayhtmlGameClient({
    connectionFactory: () => [first, second][connections++],
    controlRequest: async (action) => {
      if (action === "resume") return { room: "CD34", allocationId: "alloc-3", seat: "A", ticket: "ticket-3", resumeCredential: "owner-3" };
      allocations++;
      return { room: allocations === 1 ? "AB12" : "CD34", allocationId: `alloc-${allocations}`, seat: "A", ticket: `ticket-${allocations}`, resumeCredential: `owner-${allocations}` };
    },
    storage: { getItem() { return null; }, setItem() {}, removeItem() {} }
  });
  await client.connect();
  await client.create("An");
  client.leave();
  await client.create("An");
  first.close();
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.equal(connections, 2);
  assert.deepEqual(second.sent, [{ __ott: true, type: "ott:attach", roomId: "CD34", ticket: "ticket-3" }]);
});

test("ignores envelope-less, malformed, and foreign authoritative snapshots", async () => {
  const connection = fakeConnection();
  const client = new PlayhtmlGameClient({ connectionFactory: () => connection });
  const states = [];
  client.on("state", (message) => states.push(message));
  await client.connect();
  connection.receive(ott({ type: "ott:joined", roomId: "AB12", you: "A" }));

  connection.receive({ type: "ott:state", roomId: "AB12", revision: 1, state: { turn: "B" } });
  connection.receive(ott({ type: "ott:state", revision: 1, state: { turn: "B" } }));
  connection.receive(ott({ type: "ott:state", roomId: "AB12", revision: 1, state: null }));
  connection.receive(ott({ type: "ott:state", roomId: "AB12", revision: 1, state: [] }));
  connection.receive(ott({ type: "ott:state", roomId: "AB12", revision: 1, state: { turn: "B" }, events: [{ id: "not-an-id" }] }));
  connection.receive(ott({ type: "ott:state", roomId: "CD34", revision: 9, state: { turn: "B" } }));
  connection.receive(ott({ type: "ott:state", roomId: "AB12", revision: 1, state: { turn: "A" }, events: [{ id: 7 }] }));
  connection.receive(ott({ type: "ott:state", roomId: "AB12", revision: 2, state: { turn: "B" }, events: [{ id: 7 }] }));

  assert.equal(client.roomId, "AB12");
  assert.equal(client.state.turn, "B");
  assert.deepEqual(states.map((message) => message.events), [[{ id: 7 }], []]);
});
