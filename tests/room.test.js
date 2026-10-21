const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { Room } = require("../packages/game-core/src/room");
const { connectionAdapter } = require("../partykit/connection");
const rules = require("../packages/game-core/src/rules");
const config = require("../packages/game-core/src/config");

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

  it("seats two players and accepts the canonical opening E8 to D7", () => {
    const clock = fakeClock(0);
    const { room, a } = roomWithPlayers(clock);
    const result = room.handleMove(a, rules.parseSquare("e8"), rules.parseSquare("d7"));
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
          { id: "A-dam-0", player: "A", type: "dam", x: 0, y: 1 },
          { id: "B-keo-0", player: "B", type: "keo", x: 5, y: 5 }
        ],
        from: "a2", to: "a1", winner: "A", reason: "goal"
      },
      {
        pieces: [
          { id: "A-keo-0", player: "A", type: "keo", x: 4, y: 4 },
          { id: "B-dam-0", player: "B", type: "dam", x: 8, y: 7 }
        ],
        from: "i8", to: "i9", winner: "B", reason: "goal", turn: "B"
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
      const { room, a, b } = roomWithPlayers();
      room.state = rules.createEmptyState();
      room.state.pieces = item.pieces;
      room.state.turn = item.turn || "A";
      room.status = "playing";
      const actor = item.turn === "B" ? b : a;
      const result = room.handleMove(actor, rules.parseSquare(item.from), rules.parseSquare(item.to));
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
    const result = room.handleMove(a, rules.parseSquare("e8"), rules.parseSquare("d7"));
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

  it("resolves both seats expiring grace on the same instant by clock, then by turn", () => {
    // Equal clocks: the seat on turn (A) loses. Otherwise the seat with less clock left loses.
    for (const [spentB, expectedWinner] of [[0, "B"], [5000, "A"]]) {
      const clock = fakeClock(0);
      const { room, a, b } = roomWithPlayers(clock);
      room.state.clock.remainingMs.B -= spentB;
      room.removePlayer(a);
      room.removePlayer(b);
      clock.advance(config.TIME_CONTROL.reconnectGraceMs);
      assert.equal(room.status, "done");
      assert.equal(room.state.reason, "disconnect_timeout");
      assert.equal(room.state.winner, expectedWinner);
    }
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
    const clock = fakeClock(0);
    const { room } = roomWithPlayers(clock);

    assert.equal(room.payload().revision, 2);
  });

  it("strips markup from names", () => {
    const room = new Room("TEST");
    const joined = room.addPlayer(fakeConnection(), "  <b>Lan</b>  ");
    assert.equal(joined.name, "Lan");
  });

  it("safely rejects null or invalid coordinates without crashing on dedupe check", () => {
    const clock = fakeClock(0);
    const { room, a, b } = roomWithPlayers(clock);
    const firstMove = room.handleMove(a, rules.parseSquare("e8"), rules.parseSquare("d7"));
    assert.equal(firstMove.ok, true);
    assert.ok(room.lastMove);

    // Call from same seat 'a' with null/undefined to trigger dedupe property access
    assert.doesNotThrow(() => {
      const nullFromResult = room.handleMove(a, null, rules.parseSquare("d2"));
      assert.equal(nullFromResult.ok, false);
    });

    assert.doesNotThrow(() => {
      const nullToResult = room.handleMove(a, rules.parseSquare("d1"), null);
      assert.equal(nullToResult.ok, false);
    });

    assert.doesNotThrow(() => {
      const undefFromResult = room.handleMove(a, undefined, rules.parseSquare("d2"));
      assert.equal(undefFromResult.ok, false);
    });

    assert.doesNotThrow(() => {
      const primitiveResult = room.handleMove(a, 42, "invalid");
      assert.equal(primitiveResult.ok, false);
    });
  });

  it("uses injected reconnectGraceMs when scheduling reconnect expiry timer", () => {
    const clock = fakeClock(0);
    const customGraceMs = 15000;
    const room = new Room("TEST_GRACE", {
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      reconnectGraceMs: customGraceMs
    });
    const a = fakeConnection();
    const b = fakeConnection();
    room.addPlayer(a, "An");
    room.addPlayer(b, "Bình");

    room.removePlayer(b);
    assert.equal(room.players.B.reconnectDeadlineMs, customGraceMs);

    clock.advance(customGraceMs);
    assert.equal(room.status, "done");
    assert.equal(room.state.winner, "A");
    assert.equal(room.state.reason, "disconnect_timeout");
  });

  it("accepts moves during clock-only revision intervals but rejects moves predating structural transitions, future revisions, or malformed revisions", () => {
    const clock = fakeClock(0);
    const { room, a, b } = roomWithPlayers(clock);
    assert.equal(room.revision, 2);
    assert.equal(room.structuralRevision, 2);

    // 1. Clock-only read advances revision but not structural revision
    clock.advance(500);
    const readPayload = room.payload();
    assert.equal(readPayload.revision, 3);
    assert.equal(room.revision, 3);
    assert.equal(room.structuralRevision, 2);

    // Future revision is rejected
    const futureMove = room.handleMove(a, rules.parseSquare("e8"), rules.parseSquare("d7"), 99);
    assert.equal(futureMove.ok, false);
    assert.equal(futureMove.error, "stale_revision");

    // Malformed revisions are rejected
    const negativeMove = room.handleMove(a, rules.parseSquare("e8"), rules.parseSquare("d7"), -1);
    assert.equal(negativeMove.ok, false);
    assert.equal(negativeMove.error, "stale_revision");

    const fractionalMove = room.handleMove(a, rules.parseSquare("e8"), rules.parseSquare("d7"), 2.5);
    assert.equal(fractionalMove.ok, false);
    assert.equal(fractionalMove.error, "stale_revision");

    // Valid move with expectedRevision within clock-only interval [2..3] is ACCEPTED
    const moveResult = room.handleMove(a, rules.parseSquare("e8"), rules.parseSquare("d7"), 2);
    assert.equal(moveResult.ok, true);
    // Structural revision advanced on move to current revision
    assert.equal(room.revision, 4);
    assert.equal(room.structuralRevision, 4);

    // 2. Intervening move: move with expectedRevision predating move is rejected
    const staleMoveresult = room.handleMove(b, rules.parseSquare("e2"), rules.parseSquare("e3"), 2);
    assert.equal(staleMoveresult.ok, false);
    assert.equal(staleMoveresult.error, "stale_revision");
    assert.equal(staleMoveresult.currentRevision, 4);
  });

  it("rejects moves predating seat disconnect/reconnect transitions even within same turn", () => {
    const clock = fakeClock(0);
    const { room, a, b } = roomWithPlayers(clock);
    assert.equal(room.revision, 2);
    assert.equal(room.structuralRevision, 2);

    // Seat disconnect structural transition
    room.removePlayer(b);
    assert.equal(room.revision, 3);
    assert.equal(room.structuralRevision, 3);

    // Move from A with expectedRevision 2 (predating seat disconnect) is rejected
    const result = room.handleMove(a, rules.parseSquare("e8"), rules.parseSquare("d7"), 2);
    assert.equal(result.ok, false);
    assert.equal(result.error, "stale_revision");

    // Move from A with expectedRevision 3 (matching post-disconnect structural revision) is accepted
    const validResult = room.handleMove(a, rules.parseSquare("e8"), rules.parseSquare("d7"), 3);
    assert.equal(validResult.ok, true);
  });

  it("defaults cold restore without structuralRevision fail-closed to current revision", () => {
    const clock = fakeClock(0);
    // Cold restore where structuralRevision is absent in persisted snapshot
    const room = new Room("TEST_COLD", {
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
      revision: 5
      // structuralRevision omitted
    });
    assert.equal(room.revision, 5);
    assert.equal(room.structuralRevision, 5, "defaults fail-closed to current revision");

    // Add players and check structural advance
    const a = fakeConnection();
    const b = fakeConnection();
    room.addPlayer(a, "An");
    room.addPlayer(b, "Bình");
    assert.equal(room.revision, 7);
    assert.equal(room.structuralRevision, 7);
  });

  it("enforces disconnected seat clock invariant when opponent moves during reconnect grace", () => {
    const clock = fakeClock(0);
    const { room, a, b } = roomWithPlayers(clock);
    const tokenB = room.players.B.resumeToken;
    room.removePlayer(b);
    assert.equal(room.players.B.connected, false);
    assert.equal(room.state.clock.runningSeat, "A");

    const moveResult = room.handleMove(a, rules.parseSquare("e8"), rules.parseSquare("d7"));
    assert.equal(moveResult.ok, true);
    assert.equal(room.state.turn, "B");
    // Under Rule 14.2: disconnected player's clock must stop
    assert.equal(room.state.clock.runningSeat, null);

    // Advancing time does not elapse B's clock
    const remainingBBefore = room.state.clock.remainingMs.B;
    clock.advance(5000);
    assert.equal(room.state.clock.remainingMs.B, remainingBBefore);

    // When B resumes, their clock is restored to running
    const resumeConn = fakeConnection();
    const resumeResult = room.resumePlayer(resumeConn, tokenB);
    assert.equal(resumeResult.ok, true);
    assert.equal(room.state.clock.runningSeat, "B");
  });

  it("keeps the on-turn seat's clock stopped when only the off-turn seat resumes", () => {
    const clock = fakeClock(0);
    const { room, a, b } = roomWithPlayers(clock);
    const tokenA = room.players.A.resumeToken;
    const tokenB = room.players.B.resumeToken;
    assert.equal(room.handleMove(a, rules.parseSquare("e8"), rules.parseSquare("d7")).ok, true);
    room.removePlayer(b);
    room.removePlayer(a);

    assert.equal(room.resumePlayer(fakeConnection(), tokenA).ok, true);
    assert.equal(room.state.turn, "B");
    assert.equal(room.state.clock.runningSeat, null);
    const remainingB = room.state.clock.remainingMs.B;
    clock.advance(30_000);
    room.settleClock(clock.now());
    assert.equal(room.state.clock.remainingMs.B, remainingB);

    assert.equal(room.resumePlayer(fakeConnection(), tokenB).ok, true);
    assert.equal(room.state.clock.runningSeat, "B");
  });

  it("does not run the creator's clock when B joins during the creator's reconnect grace", () => {
    const clock = fakeClock(0);
    const room = new Room("TEST", { now: clock.now, schedule: clock.schedule, cancel: clock.cancel });
    const a = fakeConnection();
    const tokenA = room.addPlayer(a, "An").resumeToken;
    room.removePlayer(a);
    room.addPlayer(fakeConnection(), "Bình");

    assert.equal(room.status, "playing");
    assert.equal(room.state.clock.runningSeat, null);
    clock.advance(10_000);
    room.settleClock(clock.now());
    assert.equal(room.state.clock.remainingMs.A, config.TIME_CONTROL.initialMs);

    assert.equal(room.resumePlayer(fakeConnection(), tokenA).ok, true);
    assert.equal(room.state.clock.runningSeat, "A");
  });
});
