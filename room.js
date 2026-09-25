const crypto = require("crypto");
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
    A: room.players.A ? { name: room.players.A.name, connected: room.players.A.connected } : null,
    B: room.players.B ? { name: room.players.B.name, connected: room.players.B.connected } : null
  };
}

function token() {
  return crypto.randomBytes(32).toString("hex");
}

class Room {
  constructor(id, deps = {}) {
    this.id = id;
    this.now = deps.now || Date.now;
    this.schedule = deps.schedule || setTimeout;
    this.cancel = deps.cancel || clearTimeout;
    this.onUpdate = deps.onUpdate || null;
    this.players = { A: null, B: null };
    this.state = rules.createInitialState();
    this.status = "waiting";
    this.lastEvents = [];
    this.revision = 0;
    this.nextEventId = 1;
    this.createdAt = this.now();
    this.clockAnchorMs = this.createdAt;
    this.clockTimer = null;
    this.reconnectTimers = new Map();
  }

  isEmpty() {
    if (!this.players.A && !this.players.B) return true;
    if (this.status !== "done") return false;
    return !this.players.A?.connected && !this.players.B?.connected;
  }

  seatOf(connection) {
    for (const seat of ["A", "B"]) {
      if (
        this.players[seat] &&
        this.players[seat].connected &&
        this.sameConnection(this.players[seat].connection, connection)
      ) return seat;
    }
    return null;
  }

  sameConnection(left, right) {
    if (left === right) return true;
    if (!left || !right) return false;
    return left.id !== undefined && right.id !== undefined && left.id === right.id;
  }

  notify(update) {
    if (typeof this.onUpdate === "function") this.onUpdate(update);
  }

  commitStateChange(events = null) {
    this.revision += 1;
    if (events && events.length) {
      this.lastEvents = events.map((event) => ({ ...event, id: this.nextEventId++ }));
      return this.lastEvents;
    }
    return [];
  }

  makePlayer(connection, name, seat) {
    return {
      connection,
      name: sanitizeName(name),
      seat,
      connected: true,
      resumeToken: token(),
      reconnectDeadlineMs: null
    };
  }

  addPlayer(connection, name) {
    if (this.status === "done") return { ok: false, error: "Phòng đã kết thúc" };
    let seat = null;
    if (!this.players.A) seat = "A";
    else if (!this.players.B) seat = "B";
    else return { ok: false, error: "Phòng đã đủ người" };

    const player = this.makePlayer(connection, name, seat);
    this.players[seat] = player;
    this.commitStateChange();
    if (this.players.A && this.players.B) {
      this.status = "playing";
      this.state = rules.createInitialState();
      this.clockAnchorMs = this.now();
      this.scheduleClockDeadline();
    }
    return { ok: true, seat, name: player.name, resumeToken: player.resumeToken };
  }

  reconcileHydration(now = this.now()) {
    if (this.status === "done") return { ok: true, status: this.status, seats: [] };
    const seats = ["A", "B"].filter((seat) => this.players[seat] && this.players[seat].connected);
    if (!seats.length) return { ok: true, status: this.status, seats: [] };
    for (const seat of seats) {
      const player = this.players[seat];
      player.connected = false;
      player.reconnectDeadlineMs = now + config.TIME_CONTROL.reconnectGraceMs;
    }
    if (this.status === "playing" && this.state.clock.runningSeat) {
      this.state.clock.runningSeat = null;
      this.clockAnchorMs = now;
      this.cancelClockDeadline();
    }
    this.commitStateChange();
    return { ok: true, status: this.status, seats };
  }

  expireWaitingCreator(now = this.now()) {
    const creator = this.players.A;
    const isExpiredWaitingCreator =
      this.status === "waiting" &&
      creator &&
      !this.players.B &&
      !creator.connected &&
      creator.reconnectDeadlineMs !== null &&
      creator.reconnectDeadlineMs <= now;
    if (!isExpiredWaitingCreator) return { ok: true, expired: false, status: this.status };
    const timer = this.reconnectTimers.get("A");
    if (timer !== undefined) this.cancel(timer);
    this.reconnectTimers.delete("A");
    this.status = "done";
    this.commitStateChange();
    return { ok: true, expired: true, status: this.status };
  }

  settleClock(now = this.now(), options = {}) {
    if (this.status !== "playing" || !this.state.clock || !this.state.clock.runningSeat) {
      this.clockAnchorMs = now;
      return { ok: true, state: this.state, events: [] };
    }
    const elapsed = Math.max(0, Math.floor(now - this.clockAnchorMs));
    if (elapsed === 0) return { ok: true, state: this.state, events: [] };
    const result = rules.elapseClock(this.state, elapsed);
    this.state = result.state;
    this.clockAnchorMs = now;
    if (this.state.winner) this.finishTerminal();
    result.events = options.commit === false ? result.events : this.commitStateChange(result.events);
    return result;
  }

  cancelClockDeadline() {
    if (this.clockTimer !== null) {
      this.cancel(this.clockTimer);
      this.clockTimer = null;
    }
  }

  scheduleJob(fn, delay) {
    const handle = this.schedule(fn, delay);
    if (handle && typeof handle.unref === "function") handle.unref();
    return handle;
  }

  scheduleClockDeadline() {
    this.cancelClockDeadline();
    if (this.status !== "playing" || !this.state.clock.runningSeat) return;
    const seat = this.state.clock.runningSeat;
    const delay = Math.max(0, this.state.clock.remainingMs[seat]);
    this.clockTimer = this.scheduleJob(() => {
      this.clockTimer = null;
      const result = this.settleClock(this.now());
      if (result.events.length || this.state.winner) {
        this.notify({ type: "clock", result, terminal: Boolean(this.state.winner) });
      }
    }, delay);
  }

  finishTerminal() {
    this.cancelClockDeadline();
    for (const handle of this.reconnectTimers.values()) this.cancel(handle);
    this.reconnectTimers.clear();
    this.state.clock.runningSeat = null;
    this.status = "done";
  }

  handleMove(connection, from, to) {
    const seat = this.seatOf(connection);
    if (!seat) return { ok: false, error: "Bạn không ở trong phòng này", state: null, events: [] };
    if (this.status !== "playing") return { ok: false, error: "Ván chưa bắt đầu", state: null, events: [] };
    const settled = this.settleClock(this.now(), { commit: false });
    if (this.state.winner) {
      if (settled.events.length) settled.events = this.commitStateChange(settled.events);
      return { ok: false, error: "Ván đã kết thúc", state: this.state, events: settled.events };
    }
    const result = rules.applyMove(this.state, seat, from, to);
    if (!result.ok) {
      if (settled.events.length) settled.events = this.commitStateChange(settled.events);
      return result;
    }
    this.state = result.state;
    this.clockAnchorMs = this.now();
    if (this.state.winner) this.finishTerminal();
    else this.scheduleClockDeadline();
    result.events = this.commitStateChange([...(settled.events || []), ...(result.events || [])]);
    return result;
  }

  disconnectPlayer(connection) {
    const seat = this.seatOf(connection);
    if (!seat) return null;
    const player = this.players[seat];
    if (this.status === "done") {
      player.connected = false;
      this.commitStateChange();
      return { seat, name: player.name, reason: "disconnect" };
    }
    const now = this.now();
    const settled = this.settleClock(now);
    if (this.state.winner) {
      player.connected = false;
      this.commitStateChange();
      return { seat, name: player.name, reason: this.state.reason, events: settled.events };
    }
    player.connected = false;
    player.reconnectDeadlineMs = now + config.TIME_CONTROL.reconnectGraceMs;
    if (this.state.clock.runningSeat === seat) {
      this.state.clock.runningSeat = null;
      this.clockAnchorMs = now;
      this.cancelClockDeadline();
    }
    this.commitStateChange();
    const timer = this.scheduleJob(() => {
      this.reconnectTimers.delete(seat);
      const result = this.expireReconnect(this.now(), seat);
      if (result && result.events.length) this.notify({ type: "reconnect", result, terminal: Boolean(this.state.winner) });
    }, config.TIME_CONTROL.reconnectGraceMs);
    this.reconnectTimers.set(seat, timer);
    return { seat, name: player.name, reason: "disconnect", resumeToken: player.resumeToken };
  }

  removePlayer(connection) {
    return this.disconnectPlayer(connection);
  }

  leavePlayer(connection) {
    const seat = this.seatOf(connection);
    if (!seat) return null;
    const player = this.players[seat];
    this.settleClock(this.now());
    if (this.state.winner) return { seat, name: player.name, reason: this.state.reason };
    const other = seat === "A" ? "B" : "A";
    player.connected = false;
    player.reconnectDeadlineMs = null;
    const timer = this.reconnectTimers.get(seat);
    if (timer !== undefined) this.cancel(timer);
    this.reconnectTimers.delete(seat);
    this.state.winner = other;
    this.state.reason = "leave";
    this.state.eliminatedPlayer = null;
    this.commitStateChange([{ type: "win", winner: other, reason: "leave", eliminatedPlayer: null }]);
    this.finishTerminal();
    return { seat, name: player.name, reason: "leave", result: { ok: true, state: this.state, events: this.lastEvents } };
  }

  resumePlayer(connection, resumeToken) {
    if (this.status === "done") return { ok: false, error: "Ván đã kết thúc" };
    const now = this.now();
    const seat = ["A", "B"].find((candidate) => {
      const player = this.players[candidate];
      return player && !player.connected && player.resumeToken === resumeToken && player.reconnectDeadlineMs >= now;
    });
    if (!seat) return { ok: false, error: "Mã khôi phục không hợp lệ hoặc đã hết hạn" };
    const player = this.players[seat];
    const settled = this.settleClock(now);
    const timer = this.reconnectTimers.get(seat);
    if (timer !== undefined) this.cancel(timer);
    this.reconnectTimers.delete(seat);
    player.connection = connection;
    player.connected = true;
    player.reconnectDeadlineMs = null;
    if (!this.state.winner) {
      this.state.clock.runningSeat = this.state.turn;
      this.clockAnchorMs = now;
      this.scheduleClockDeadline();
    }
    this.commitStateChange();
    return { ok: true, seat, name: player.name, state: this.state, events: settled.events };
  }

  expireReconnect(now = this.now(), onlySeat = null) {
    if (this.status !== "playing") return { ok: false, state: this.state, events: [] };
    const expiredAll = ["A", "B"].filter((seat) => {
      const p = this.players[seat];
      return p && !p.connected && p.reconnectDeadlineMs !== null && p.reconnectDeadlineMs <= now;
    });
    const expired = onlySeat ? expiredAll.filter((seat) => seat === onlySeat) : expiredAll;
    if (!expired.length) return { ok: true, state: this.state, events: [] };
    const simultaneous = expiredAll.length === 2 && this.players.A.reconnectDeadlineMs === this.players.B.reconnectDeadlineMs;
    if (simultaneous) {
      // Rule.md does not define a winner when both grace deadlines tie.
      return { ok: true, state: this.state, events: [] };
    }
    const loser = expired[0];
    const winner = loser === "A" ? "B" : "A";
    const settled = this.settleClock(now);
    if (this.state.winner) return settled;
    this.state.winner = winner;
    this.state.reason = "disconnect_timeout";
    this.state.eliminatedPlayer = null;
    this.commitStateChange([{ type: "win", winner, reason: "disconnect_timeout", eliminatedPlayer: null }]);
    this.finishTerminal();
    return { ok: true, state: this.state, events: this.lastEvents };
  }

  payload() {
    // Snapshots settle the server clock; callers must treat this read as stateful.
    this.settleClock(this.now());
    return {
      roomId: this.id,
      status: this.status,
      serverNow: this.now(),
      revision: this.revision,
      players: snapshotPlayers(this),
      state: rules.publicState(this.state),
      events: this.lastEvents || []
    };
  }

  waitingInfo() {
    return {
      id: this.id,
      players: Number(!!this.players.A) + Number(!!this.players.B),
      names: [this.players.A && this.players.A.name, this.players.B && this.players.B.name].filter(Boolean)
    };
  }

  send(connection, msg) {
    const isOpen = connection && (connection.open !== undefined ? connection.open : connection.readyState === 1);
    if (isOpen && typeof connection.send === "function") {
      connection.send(JSON.stringify(msg));
    }
  }

  broadcast(msg, except) {
    for (const seat of ["A", "B"]) {
      const slot = this.players[seat];
      if (slot && slot.connected && !this.sameConnection(slot.connection, except)) {
        this.send(slot.connection, msg);
      }
    }
  }

  emitState() {
    const payload = this.payload();
    for (const seat of ["A", "B"]) {
      const slot = this.players[seat];
      if (!slot || !slot.connected) continue;
      this.send(slot.connection, Object.assign({ type: "state", you: seat }, payload));
    }
  }
}

module.exports = { Room, sanitizeName, snapshotPlayers };
