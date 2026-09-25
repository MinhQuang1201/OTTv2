const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { Room } = require("../room");
const rules = require("../rules");
const config = require("../config");

function fakeWs() {
  const inbox = [];
  return {
    readyState: 1,
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
  const a = fakeWs();
  const b = fakeWs();
  room.addPlayer(a, "An");
  room.addPlayer(b, "Bình");
  return { room, a, b };
}

describe("room", () => {
  it("seats two players and accepts the canonical opening C3 to D2", () => {
    const { room, a } = roomWithPlayers();
    const result = room.handleMove(a, rules.parseSquare("c3"), rules.parseSquare("d2"));
    assert.equal(result.ok, true);
    assert.equal(room.state.turn, "B");
    assert.equal(room.state.clock.runningSeat, "B");
  });

  it("rejects a move from the player who is not on turn", () => {
    const { room, b } = roomWithPlayers();
    const result = room.handleMove(b, rules.parseSquare("g7"), rules.parseSquare("g6"));
    assert.equal(result.ok, false);
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
    assert.equal(room.state.clock.remainingMs.A, config.TIME_CONTROL.initialMs - 1250);
    assert.equal(room.state.clock.runningSeat, "B");
  });

  it("times out the active seat, marks done, and cancels the deadline", () => {
    const clock = fakeClock(0);
    const { room } = roomWithPlayers(clock);
    assert.equal(clock.pending(), 1);
    clock.advance(config.TIME_CONTROL.initialMs);
    assert.equal(room.state.winner, "B");
    assert.equal(room.state.reason, "timeout");
    assert.equal(room.status, "done");
    assert.equal(room.state.clock.runningSeat, null);
    assert.equal(clock.pending(), 0);
  });

  it("holds a disconnected seat during grace instead of ending immediately", () => {
    const clock = fakeClock(0);
    const { room, b } = roomWithPlayers(clock);
    const removed = room.removePlayer(b);
    assert.equal(removed.reason, "disconnect");
    assert.equal(room.players.B.connected, false);
    assert.equal(room.players.B.ws, b);
    assert.equal(room.state.winner, null);
    assert.equal(room.status, "playing");
    assert.equal(room.players.B.reconnectDeadlineMs, config.TIME_CONTROL.reconnectGraceMs);
    assert.equal(room.waitingInfo().players, 2);
  });

  it("resumes the disconnected seat with its token before grace expires", () => {
    const clock = fakeClock(0);
    const { room, a, b } = roomWithPlayers(clock);
    const token = room.players.A.resumeToken;
    room.removePlayer(a);
    const replacement = fakeWs();
    const result = room.resumePlayer(replacement, token);
    assert.equal(result.ok, true);
    assert.equal(result.seat, "A");
    assert.equal(room.players.A.ws, replacement);
    assert.equal(room.players.A.connected, true);
    assert.equal(room.players.A.reconnectDeadlineMs, null);
    assert.equal(room.state.clock.runningSeat, "A");
    assert.equal(room.resumePlayer(fakeWs(), "wrong-token").ok, false);
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
    const before = JSON.stringify(room.state);
    room.removePlayer(room.players.A.ws);
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
  });

  it("strips markup from names", () => {
    const room = new Room("TEST");
    const joined = room.addPlayer(fakeWs(), "  <b>Lan</b>  ");
    assert.equal(joined.name, "Lan");
  });
});
