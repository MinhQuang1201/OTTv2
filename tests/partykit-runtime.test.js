const test = require("node:test");
const assert = require("node:assert/strict");

const config = require("../config");
const { OttLobby } = require("../partykit/ott-lobby");
const { PartyKitOttRoom } = require("../partykit/ott-room");

// This models only the documented named-party stub/socket boundary used by the
// application. It is deliberately not a substitute for a PlayHTML runtime.
function runtime(start = 0) {
  let now = start;
  const lobbyStorage = durableStorage();
  const games = new Map();
  const pending = new Set();
  const track = (work) => {
    const promise = Promise.resolve(work);
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
    return promise;
  };
  const game = (id) => {
    if (games.has(id)) return games.get(id);
    const entry = {
      storage: durableStorage(),
      party: null
    };
    entry.party = new PartyKitOttRoom({
      id,
      storage: entry.storage,
      context: { now: () => now }
    });
    games.set(id, entry);
    return entry;
  };
  const context = {
    parties: {
      game: {
        get(id) {
          return {
            socket: async (path) => {
              assert.equal(path, "/");
              const entry = game(id);
              const listeners = [];
              const connection = {
                id: `socket-${id}-${Math.random()}`,
                readyState: 1,
                send(data) {
                  for (const listener of listeners) listener({ data });
                }
              };
              await entry.party.onStart();
              await entry.party.onConnect(connection);
              return {
                addEventListener(type, listener) {
                  if (type === "message") listeners.push(listener);
                },
                send(data) { track(entry.party.onMessage(data, connection)); },
                close() { track(entry.party.onClose(connection)); }
              };
            },
            async fetch() {
              const entry = game(id);
              await entry.party.onStart();
              return entry.party.onRequest();
            }
          };
        }
      }
    }
  };
  const lobby = new OttLobby({ id: "lobby", storage: lobbyStorage, context, now: () => now });
  return {
    lobby,
    lobbyStorage,
    game,
    now: () => now,
    advance(ms) { now += ms; },
    async settle() {
      // Socket.send is synchronous in PartyKit, but the room handler it starts
      // is async and is not returned by the socket API.
      for (let turn = 0; turn < 4; turn += 1) {
        while (pending.size) await Promise.all([...pending]);
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  };
}

function durableStorage() {
  const values = new Map();
  const alarms = [];
  return {
    values,
    alarms,
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    async list(options = {}) {
      return new Map([...values].filter(([key]) => !options.prefix || key.startsWith(options.prefix)));
    },
    async setAlarm(deadline) { alarms.push({ type: "set", deadline }); },
    async deleteAlarm() { alarms.push({ type: "delete" }); }
  };
}

function client(id) {
  const inbox = [];
  return { id, inbox, send(raw) { inbox.push(JSON.parse(raw)); } };
}

async function send(lobby, connection, message, delay = true) {
  await lobby.onMessage(JSON.stringify(message), connection);
  if (delay) await new Promise((resolve) => setImmediate(resolve));
}

test("runtime rejects direct game create without allocating a seat", async () => {
  const fixture = runtime();
  const game = fixture.game("AB12").party;
  const attacker = client("attacker");
  await game.onStart();
  await game.onConnect(attacker);

  await game.onMessage(JSON.stringify({ type: "ott:create", name: "attacker" }), attacker);

  assert.deepEqual(attacker.inbox.at(-1), { type: "ott:error", message: "Lệnh không hỗ trợ" });
  assert.equal(game.impl.room.players.A, null);
  assert.equal(game.impl.room.status, "waiting");
});

test("runtime routes an active-game resume after its waiting listing is removed", async () => {
  const fixture = runtime();
  const creator = client("creator");
  const joiner = client("joiner");
  await fixture.lobby.onConnect(creator);
  await send(fixture.lobby, creator, { type: "ott:create", name: "Alice" });
  await fixture.settle();
  const [waiting] = await fixture.lobby.registry.list();
  const createdGame = fixture.game(waiting.id).party.impl.room.players.A;
  assert.ok(createdGame, "lobby create must initialize the allocated game party");
  const joined = {
    roomId: waiting.id,
    resumeToken: createdGame.resumeToken
  };

  fixture.advance(40);
  await fixture.lobby.onConnect(joiner);
  await send(fixture.lobby, joiner, { type: "ott:join", roomId: joined.roomId, name: "Bob" });
  await fixture.settle();
  assert.equal(await fixture.lobby.registry.get(joined.roomId), undefined);

  await fixture.lobby.onClose(creator);
  fixture.advance(40);
  const resumed = client("creator-reconnected");
  await fixture.lobby.onConnect(resumed);
  await send(fixture.lobby, resumed, { type: "ott:resume", roomId: joined.roomId, resumeToken: joined.resumeToken });
  await fixture.settle();

  assert.equal(resumed.inbox.at(-1).type, "ott:state");
  assert.equal(resumed.inbox.some((message) => message.type === "ott:joined" && message.resumed), true);
});

test("runtime expires a disconnected waiting creator and makes the room unjoinable", async () => {
  const fixture = runtime();
  const creator = client("creator");
  await fixture.lobby.onConnect(creator);
  await send(fixture.lobby, creator, { type: "ott:create", name: "Alice" });
  await fixture.settle();
  const [waiting] = await fixture.lobby.registry.list();
  const game = fixture.game(waiting.id).party;
  assert.ok(game.impl.room.players.A, "lobby create must initialize the allocated game party");
  await fixture.lobby.onClose(creator);
  fixture.advance(config.TIME_CONTROL.reconnectGraceMs);

  await game.onAlarm();
  const joiner = client("joiner");
  await game.onConnect(joiner);
  await game.onMessage(JSON.stringify({ type: "ott:join", roomId: waiting.id, name: "Bob" }), joiner);

  assert.equal(game.impl.room.status, "done");
  assert.equal(game.impl.room.state.reason, "disconnect_timeout");
  assert.equal(joiner.inbox.at(-1).type, "ott:error");
});

test("runtime hydration gives persisted live seats a grace deadline that can resume", async () => {
  const fixture = runtime();
  const entry = fixture.game("AB12");
  const original = entry.party;
  const a = client("a");
  const b = client("b");
  await original.onStart();
  await original.onConnect(a);
  await original.onMessage(JSON.stringify({ type: "ott:create", name: "Alice" }), a);
  fixture.advance(40);
  await original.onConnect(b);
  await original.onMessage(JSON.stringify({ type: "ott:join", roomId: "AB12", name: "Bob" }), b);
  const token = original.impl.room.players.A.resumeToken;

  fixture.advance(1000);
  entry.party = new PartyKitOttRoom({ id: "AB12", storage: entry.storage, context: { now: fixture.now } });
  await entry.party.onStart();
  const resumed = client("a-restarted");
  await entry.party.onConnect(resumed);
  await entry.party.onMessage(JSON.stringify({ type: "ott:resume", roomId: "AB12", resumeToken: token }), resumed);

  assert.equal(entry.party.impl.room.players.A.reconnectDeadlineMs, null);
  assert.equal(resumed.inbox.at(-1).type, "ott:state");
});

test("runtime never leaks a resume token through lobby listings or opponent snapshots", async () => {
  const fixture = runtime();
  const creator = client("creator");
  const opponent = client("opponent");
  const observer = client("observer");
  await fixture.lobby.onConnect(creator);
  await send(fixture.lobby, creator, { type: "ott:create", name: "Alice" });
  await fixture.settle();
  const [waiting] = await fixture.lobby.registry.list();
  const createdGame = fixture.game(waiting.id).party.impl.room.players.A;
  assert.ok(createdGame, "lobby create must initialize the allocated game party");
  const joined = {
    roomId: waiting.id,
    resumeToken: createdGame.resumeToken
  };

  fixture.advance(40);
  await fixture.lobby.onConnect(opponent);
  await send(fixture.lobby, opponent, { type: "ott:join", roomId: joined.roomId, name: "Bob" });
  await fixture.settle();
  fixture.advance(40);
  await fixture.lobby.onConnect(observer);
  await send(fixture.lobby, observer, { type: "ott:list" });

  assert.equal(JSON.stringify(opponent.inbox).includes(joined.resumeToken), false);
  assert.equal(JSON.stringify(observer.inbox).includes(joined.resumeToken), false);
});

test("runtime schedules the single earliest durable alarm across clock and reconnect grace", async () => {
  const fixture = runtime();
  const game = fixture.game("AB12").party;
  const a = client("a");
  const b = client("b");
  await game.onStart();
  await game.onConnect(a);
  await game.onMessage(JSON.stringify({ type: "ott:create", name: "Alice" }), a);
  fixture.advance(40);
  await game.onConnect(b);
  await game.onMessage(JSON.stringify({ type: "ott:join", roomId: "AB12", name: "Bob" }), b);
  await game.onClose(b);

  const alarms = fixture.game("AB12").storage.alarms;
  assert.deepEqual(alarms.at(-1), { type: "set", deadline: fixture.now() + config.TIME_CONTROL.reconnectGraceMs });
  assert.equal(alarms.filter((alarm) => alarm.type === "set" && alarm.deadline === fixture.now() + config.TIME_CONTROL.reconnectGraceMs).length, 1);
});

test("PlayHTML runtime forwarding is skipped until Task 5 supplies a source-backed worker entry", {
  skip: "The pinned project has no verified PlayHTML worker entry; stub bridges are not runtime evidence."
}, () => {});
