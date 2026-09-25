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
  client.resume("K7P2", "secret");
  client.list();
  client.move({ x: 1, y: 1 }, { x: 2, y: 2 });
  client.leave();
  connection.receive(ott({ type: "ott:joined", roomId: "K7P2", you: "A", resumeToken: "secret" }));
  connection.receive(ott({ type: "ott:state", roomId: "K7P2", revision: 0, you: "A", state: { turn: "A" } }));
  assert.deepEqual(connection.sent, [
    { __ott: true, type: "ott:create", name: "An" },
    { __ott: true, type: "ott:join", roomId: "K7P2", name: "An" },
    { __ott: true, type: "ott:resume", roomId: "K7P2", resumeToken: "secret" },
    { __ott: true, type: "ott:list" },
    { __ott: true, type: "ott:move", from: { x: 1, y: 1 }, to: { x: 2, y: 2 } },
    { __ott: true, type: "ott:leave" }
  ]);
  assert.equal(states[0].state.turn, "A");
  assert.equal(storage.get("K7P2"), "secret");
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

test("normalizes room ids and preserves tokens across ordinary close", async () => {
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
  assert.deepEqual(client.resumeContext, { roomId: "AB12", resumeToken: "secret" });
  assert.equal(storage.get("AB12"), "secret");
});

test("resumes a stored room automatically after a fresh connection", async () => {
  const connection = fakeConnection();
  const storage = new Map([["__last_room__", "AB12"], ["AB12", "secret"]]);
  const client = new PlayhtmlGameClient({
    connectionFactory: () => connection,
    storage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) }
  });

  await client.connect();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(connection.sent[0], { __ott: true, type: "ott:resume", roomId: "AB12", resumeToken: "secret" });
});

test("clears tokens only after explicit leave or stable resume rejection", async () => {
  const connection = fakeConnection();
  const storage = new Map([["AB12", "secret"]]);
  const client = new PlayhtmlGameClient({
    connectionFactory: () => connection,
    storage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) }
  });
  await client.connect();
  assert.equal(client.resume(" ab12 ", "secret"), true);
  connection.receive(ott({ type: "ott:error", roomId: "ab12", code: "resume_rejected" }));
  assert.equal(storage.has("AB12"), false);

  connection.receive(ott({ type: "ott:joined", roomId: "ab12", resumeToken: "new-secret" }));
  client.leave();
  assert.equal(storage.has("AB12"), false);
});

test("does not resume automatically before an explicit join after connect", async () => {
  const connection = fakeConnection();
  const storage = new Map([["__last_room__", "AB12"], ["AB12", "secret"]]);
  const client = new PlayhtmlGameClient({
    connectionFactory: () => connection,
    storage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) }
  });

  await client.connect();
  client.join("CD34", "An");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(connection.sent, [{ __ott: true, type: "ott:join", roomId: "CD34", name: "An" }]);
  assert.equal(storage.has("AB12"), false);
});

test("reconnects after leaving and starting another game", async () => {
  const first = fakeConnection();
  const second = fakeConnection();
  let connections = 0;
  const client = new PlayhtmlGameClient({ connectionFactory: () => [first, second][connections++] });
  await client.connect();
  first.receive(ott({ type: "ott:joined", roomId: "AB12", resumeToken: "first" }));
  client.leave();
  client.create("An");
  first.receive(ott({ type: "ott:joined", roomId: "CD34", resumeToken: "second" }));
  first.close();
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.equal(connections, 2);
  assert.deepEqual(second.sent, [{ __ott: true, type: "ott:resume", roomId: "CD34", resumeToken: "second" }]);
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
