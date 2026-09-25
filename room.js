const rules = require("./rules");
const config = require("./config");

function sanitizeName(name) {
  const raw = String(name || "")
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "Khách";
  return raw.slice(0, config.NAME_MAX);
}

function snapshotPlayers(room) {
  return {
    A: room.players.A ? { name: room.players.A.name } : null,
    B: room.players.B ? { name: room.players.B.name } : null
  };
}

class Room {
  constructor(id) {
    this.id = id;
    this.players = { A: null, B: null };
    this.state = rules.createInitialState();
    this.status = "waiting";
    this.lastEvents = [];
    this.createdAt = Date.now();
  }

  isEmpty() {
    return !this.players.A && !this.players.B;
  }

  seatOf(ws) {
    if (this.players.A && this.players.A.ws === ws) return "A";
    if (this.players.B && this.players.B.ws === ws) return "B";
    return null;
  }

  addPlayer(ws, name) {
    if (this.status === "done") {
      return { ok: false, error: "Phòng đã kết thúc" };
    }
    const clean = sanitizeName(name);
    let seat = null;
    if (!this.players.A) seat = "A";
    else if (!this.players.B) seat = "B";
    else return { ok: false, error: "Phòng đã đủ người" };

    this.players[seat] = { ws, name: clean };
    if (this.players.A && this.players.B) {
      this.status = "playing";
      if (!this.state.winner) this.state = rules.createInitialState();
    }
    return { ok: true, seat, name: clean };
  }

  removePlayer(ws) {
    const seat = this.seatOf(ws);
    if (!seat) return null;
    const leaving = this.players[seat];
    this.players[seat] = null;
    if (this.status === "playing" && !this.state.winner) {
      const other = seat === "A" ? "B" : "A";
      this.state.winner = other;
      this.state.reason = "disconnect";
      this.status = "done";
    }
    if (this.isEmpty()) this.status = "done";
    return { seat, name: leaving.name };
  }

  handleMove(ws, from, to) {
    const seat = this.seatOf(ws);
    if (!seat) return { ok: false, error: "Bạn không ở trong phòng này" };
    if (this.status !== "playing") return { ok: false, error: "Ván chưa bắt đầu" };
    const result = rules.applyMove(this.state, seat, from, to);
    if (!result.ok) return result;
    this.state = result.state;
    this.lastEvents = result.events;
    if (this.state.winner) this.status = "done";
    return result;
  }

  payload() {
    return {
      roomId: this.id,
      status: this.status,
      players: snapshotPlayers(this),
      state: rules.publicState(this.state),
      events: this.lastEvents || []
    };
  }

  waitingInfo() {
    return {
      id: this.id,
      players: Number(!!this.players.A) + Number(!!this.players.B),
      names: [
        this.players.A && this.players.A.name,
        this.players.B && this.players.B.name
      ].filter(Boolean)
    };
  }

  send(ws, msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  broadcast(msg, except) {
    for (const seat of ["A", "B"]) {
      const slot = this.players[seat];
      if (slot && slot.ws !== except) this.send(slot.ws, msg);
    }
  }

  emitState() {
    const payload = this.payload();
    for (const seat of ["A", "B"]) {
      const slot = this.players[seat];
      if (!slot) continue;
      this.send(slot.ws, Object.assign({ type: "state", you: seat }, payload));
    }
  }
}

module.exports = { Room, sanitizeName, snapshotPlayers };
