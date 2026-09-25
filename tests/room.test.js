const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { Room } = require("../room");
const rules = require("../rules");

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

describe("room", () => {
  it("seats two players then accepts a legal move from A", () => {
    const room = new Room("TEST");
    const a = fakeWs();
    const b = fakeWs();
    assert.equal(room.addPlayer(a, "An").seat, "A");
    assert.equal(room.addPlayer(b, "Bình").seat, "B");
    assert.equal(room.status, "playing");
    const from = rules.parseSquare("a3");
    const to = rules.parseSquare("a2");
    const res = room.handleMove(a, from, to);
    assert.equal(res.ok, true);
    assert.equal(room.state.turn, "B");
  });

  it("rejects a move from the player who is not on turn", () => {
    const room = new Room("TEST");
    const a = fakeWs();
    const b = fakeWs();
    room.addPlayer(a, "An");
    room.addPlayer(b, "Bình");
    const res = room.handleMove(b, { x: 8, y: 6 }, { x: 8, y: 7 });
    assert.equal(res.ok, false);
  });

  it("awards the remaining player when the opponent disconnects mid-game", () => {
    const room = new Room("TEST");
    const a = fakeWs();
    const b = fakeWs();
    room.addPlayer(a, "An");
    room.addPlayer(b, "Bình");
    room.removePlayer(b);
    assert.equal(room.state.winner, "A");
    assert.equal(room.state.reason, "disconnect");
    assert.equal(room.status, "done");
  });

  it("strips markup from names", () => {
    const room = new Room("TEST");
    const a = fakeWs();
    const joined = room.addPlayer(a, "  <b>Lan</b>  ");
    assert.equal(joined.name, "Lan");
  });
});
