const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { Room } = require("../room");
const { connectionAdapter } = require("../partykit/connection");
const rules = require("../rules");
const config = require("../config");

let nextConnectionId = 1;

function fakeConnection() {
  const inbox = [];
  return {
    id: `connection-${nextConnectionId++}`,
    open: true,
    inbox,
    send(text) {
      inbox.push(JSON.parse(text));
    }
  };
}

function fakeClock(start = 0) {
  let now = start;
  let nextId = 1;
  const jobs = new Map();
  return {
    now: () => now,
    schedule(fn, delay) {
      const id = nextId++;
      jobs.set(id, { at: now + delay, fn });
      return id;
    },
    cancel(id) {
      jobs.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, job] of [...jobs]) {
        if (job.at <= now) {
          jobs.delete(id);
          job.fn();
        }
      }
    },
    pending() {
      return jobs.size;
    }
  };
}

function roomWithPlayers(clock) {
  const room = new Room("TEST", clock && {
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel
  });
  const a = fakeConnection();
  const b = fakeConnection();
  room.addPlayer(a, "An");
  room.addPlayer(b, "Bình");
  return { room, a, b };
}

describe("room", () => {
  it("starts revision and event allocation at zero and one", () => {
    const room = new Room("TEST");

    assert.equal(room.revision, 0);
    assert.equal(room.nextEventId, 1);
  });

  it("uses connection identity and send without WebSocket readyState", () => {
    const { room, a, b } = roomWithPlayers();
    assert.equal(room.seatOf(a), "A");
    assert.equal(room.seatOf(b), "B");

    room.emitState();

    assert.equal(a.inbox.at(-1).type, "state");
    assert.equal(a.inbox.at(-1).you, "A");
    assert.equal(b.inbox.at(-1).you, "B");
  });

  it("does not send to a connection marked closed", () => {
    const { room, a } = roomWithPlayers();
    a.open = false;

    room.emitState();

    assert.equal(a.inbox.length, 0);
  });

  it("accepts a PartyKit connection through the adapter", () => {
    const { room, a } = roomWithPlayers();
    const partyConnection = {
      id: "party-1",
      send: a.send
    };
    const adapted = connectionAdapter(partyConnection);

    assert.equal(room.seatOf(adapted), null);
    room.send(adapted, { type: "test" });
    assert.deepEqual(a.inbox.at(-1), { type: "test" });
  });

  it("seats two players and accepts the canonical opening C3 to D2", () => {
    const clock = fakeClock(0);
    const { room, a } = roomWithPlayers(clock);
    const result = room.handleMove(a, rules.parseSquare("c3"), rules.parseSquare("d2"));
    assert.equal(result.ok, true);
    assert.equal(room.revision, 3);
    assert.equal(room.state.turn, "B");
    assert.equal(room.state.clock.runningSeat, "B");
  });

  it("rejects a move from the player who is not on turn", () => {
    const { room, b } = roomWithPlayers();
    const result = room.handleMove(b, rules.parseSquare("g7"), rules.parseSquare("g6"));
    assert.equal(result.ok, false);
    assert.equal(room.revision, 2);
    assert.equal(room.nextEventId, 1);
    assert.equal(room.state.turn, "A");
    assert.equal(room.state.clock.runningSeat, "A");
  });

  it("marks goal, elimination, and no-moves results done", () => {
    const cases = [
      {
        pieces: [
          { id: "A-dam-0", player: "A", type: "dam", x: 0, y: 7 },
          { id: "B-keo-0", player: "B", type: "keo", x: 5, y: 5 }
        ],
        from: "a8", to: "a9", winner: "A", reason: "goal"
      },
      {
        pieces: [
          { id: "A-dam-0", player: "A", type: "dam", x: 4, y: 4 },
          { id: "B-keo-0", player: "B", type: "keo", x: 5, y: 4 }
        ],
        from: "e5", to: "f5", winner: "A", reason: "elimination"
      },
      {
        pieces: [
          { id: "A-dam-0", player: "A", type: "dam", x: 4, y: 4 },
          { id: "B-dam-0", player: "B", type: "dam", x: 0, y: 0 },
          { id: "A-dam-1", player: "A", type: "dam", x: 1, y: 0 },
          { id: "A-dam-2", player: "A", type: "dam", x: 0, y: 1 },
          { id: "A-dam-3", player: "A", type: "dam", x: 1, y: 1 }
        ],
        from: "e5", to: "e4", winner: "A", reason: "no_moves"
      }
    ];
    for (const item of cases) {
      const { room, a } = roomWithPlayers();
      room.state = rules.createEmptyState();
      room.state.pieces = item.pieces;
      room.status = "playing";
      const result = room.handleMove(a, rules.parseSquare(item.from), rules.parseSquare(item.to));
      assert.equal(result.ok, true);
      assert.equal(room.revision, 3);
      assert.equal(room.state.winner, item.winner);
      assert.equal(room.state.reason, item.reason);
      assert.equal(room.status, "done");
      assert.equal(room.state.clock.runningSeat, null);
    }
  });

  it("settles elapsed time before a valid move and switches the running seat", () => {
    const clock = fakeClock(1000);
    const { room, a } = roomWithPlayers(clock);
    clock.advance(1250);
    const result = room.handleMove(a, rules.parseSquare("c3"), rules.parseSquare("d2"));
    assert.equal(result.ok, true);
    assert.equal(room.revision, 3, "clock settlement and the accepted move are one action");
    assert.equal(room.state.clock.remainingMs.A, config.TIME_CONTROL.initialMs - 1250);
    assert.equal(room.state.clock.runningSeat, "B");
  });

  it("defines payload clock settlement as an observable state change", () => {
    const clock = fakeClock(0);
    const { room } = roomWithPlayers(clock);
    clock.advance(1250);

    const before = room.revision;
    const payload = room.payload();

    assert.equal(room.revision, before + 1);
    assert.equal(payload.state.clock.remainingMs.A, config.TIME_CONTROL.initialMs - 1250);
  });

  it("keeps the latest event batch when a later state change has no events", () => {
    const clock = fakeClock(0);
    const { room, b } = roomWithPlayers(clock);
    clock.advance(config.TIME_CONTROL.initialMs);
    const events = room.lastEvents;
    const revision = room.revision;

    room.removePlayer(room.players.B.connection);

    assert.equal(room.revision, revision + 1);
    assert.deepEqual(room.lastEvents, events);
    assert.deepEqual(room.payload().events, events);
    assert.equal(b.open, true);
  });

  it("times out the active seat, marks done, and cancels the deadline", () => {
    const clock = fakeClock(0);
    const { room } = roomWithPlayers(clock);
    assert.equal(clock.pending(), 1);
    clock.advance(config.TIME_CONTROL.initialMs);
    assert.equal(room.state.winner, "B");
    assert.equal(room.state.reason, "timeout");
    assert.equal(room.status, "done");
    assert.equal(room.revision, 3);
    assert.equal(room.lastEvents[0].id, 1);
    assert.equal(room.nextEventId, 2);
    assert.equal(room.state.clock.runningSeat, null);
    assert.equal(clock.pending(), 0);
  });

  it("holds a disconnected seat during grace instead of ending immediately", () => {
    const clock = fakeClock(0);
    const { room, b } = roomWithPlayers(clock);
    const removed = room.removePlayer(b);
    assert.equal(removed.reason, "disconnect");
    assert.equal(room.players.B.connected, false);
    assert.equal(room.players.B.connection, b);
    assert.equal(room.state.winner, null);
    assert.equal(room.status, "playing");
    assert.equal(room.players.B.reconnectDeadlineMs, config.TIME_CONTROL.reconnectGraceMs);
    assert.equal(room.waitingInfo().players, 2);
  });

  it("reconciles persisted connected players into reconnect grace without changing identities or game state", () => {
    const clock = fakeClock(1000);
    const { room } = roomWithPlayers(clock);
    const playerA = room.players.A;
    const playerB = room.players.B;
    const tokenA = playerA.resumeToken;
    const tokenB = playerB.resumeToken;
    const state = room.state;
    const revision = room.revision;

    const result = room.reconcileHydration(clock.now());

    assert.deepEqual(result, { ok: true, status: "playing", seats: ["A", "B"] });
    assert.equal(room.players.A, playerA);
    assert.equal(room.players.B, playerB);
    assert.equal(room.players.A.seat, "A");
    assert.equal(room.players.B.seat, "B");
    assert.equal(room.players.A.resumeToken, tokenA);
    assert.equal(room.players.B.resumeToken, tokenB);
    assert.equal(room.players.A.connected, false);
    assert.equal(room.players.B.connected, false);
    assert.equal(room.players.A.reconnectDeadlineMs, 1000 + config.TIME_CONTROL.reconnectGraceMs);
    assert.equal(room.players.B.reconnectDeadlineMs, 1000 + config.TIME_CONTROL.reconnectGraceMs);
    assert.equal(room.state, state);
    assert.equal(room.revision, revision + 1);
  });

  it("expires a waiting creator's hydration grace as winnerless and unjoinable", () => {
    const clock = fakeClock(1000);
    const room = new Room("TEST", clock);
    const creator = fakeConnection();
    const joined = room.addPlayer(creator, "An");

    const hydrated = room.reconcileHydration(clock.now());

    assert.deepEqual(hydrated, { ok: true, status: "waiting", seats: ["A"] });
    assert.equal(room.players.A.connected, false);
    assert.equal(room.players.A.reconnectDeadlineMs, 1000 + config.TIME_CONTROL.reconnectGraceMs);
    assert.equal(room.state.winner, null);

    const expired = room.expireWaitingCreator(clock.now() + config.TIME_CONTROL.reconnectGraceMs);

    assert.deepEqual(expired, { ok: true, expired: true, status: "done" });
    assert.equal(room.status, "done");
    assert.equal(room.state.winner, null);
    assert.equal(room.addPlayer(fakeConnection(), "Bình").ok, false);
    assert.equal(room.resumePlayer(fakeConnection(), joined.resumeToken).ok, false);
  });

  it("resumes the disconnected seat with its token before grace expires", () => {
    const clock = fakeClock(0);
    const { room, a, b } = roomWithPlayers(clock);
    const token = room.players.A.resumeToken;
    room.removePlayer(a);
    const replacement = fakeConnection();
    const result = room.resumePlayer(replacement, token);
    assert.equal(result.ok, true);
    assert.equal(result.seat, "A");
    assert.equal(room.players.A.connection, replacement);
    assert.equal(room.players.A.connected, true);
    assert.equal(room.players.A.reconnectDeadlineMs, null);
    assert.equal(room.state.clock.runningSeat, "A");
    assert.equal(room.resumePlayer(fakeConnection(), "wrong-token").ok, false);
    assert.equal(room.seatOf(b), "B");
  });

  it("expires reconnect grace with disconnect_timeout and keeps terminal state stable", () => {
    const clock = fakeClock(0);
    const { room, b } = roomWithPlayers(clock);
    room.removePlayer(b);
    clock.advance(config.TIME_CONTROL.reconnectGraceMs);
    assert.equal(room.state.winner, "A");
    assert.equal(room.state.reason, "disconnect_timeout");
    assert.equal(room.status, "done");
    assert.equal(room.revision, 5);
    assert.equal(room.lastEvents[0].id, 1);
    assert.equal(room.nextEventId, 2);
    const before = JSON.stringify(room.state);
    room.removePlayer(room.players.A.connection);
    assert.equal(JSON.stringify(room.state), before);
  });

  it("treats explicit leave as immediate loss", () => {
    const clock = fakeClock(0);
    const { room, b } = roomWithPlayers(clock);
    const result = room.leavePlayer(b);
    assert.equal(result.reason, "leave");
    assert.equal(room.state.winner, "A");
    assert.equal(room.state.reason, "leave");
    assert.equal(room.status, "done");
    assert.equal(room.revision, 3);
    assert.equal(room.lastEvents[0].id, 1);
    assert.equal(room.nextEventId, 2);
  });

  it("exposes the authoritative revision in snapshots", () => {
    const { room } = roomWithPlayers();

    assert.equal(room.payload().revision, 2);
  });

  it("strips markup from names", () => {
    const room = new Room("TEST");
    const joined = room.addPlayer(fakeConnection(), "  <b>Lan</b>  ");
    assert.equal(joined.name, "Lan");
  });
});
