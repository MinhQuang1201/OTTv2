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

function sanitizeText(text, max) {
  const raw = String(text || "")
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return raw.slice(0, max);
}

function token() {
  return crypto.randomBytes(32).toString("hex");
}

function snapshotPlayers(room) {
  const out = {};
  for (const seat of room.seats) {
    const player = room.players[seat];
    out[seat] = player
      ? { name: player.name, connected: player.connected !== false }
      : null;
  }
  return out;
}

class Room {
  constructor(id, options) {
    const opts = options || {};
    this.id = id;
    this.now = opts.now || Date.now;
    this.schedule = opts.schedule || setTimeout;
    this.cancel = opts.cancel || clearTimeout;
    this.onUpdate = opts.onUpdate || null;
    this.mode = rules.normalizeMode(opts.mode);
    this.seats = config.MODES[this.mode].seats.slice();
    this.name =
      sanitizeText(opts.name, config.ROOM_NAME_MAX) || "Phòng " + id;
    this.players = {};
    for (const seat of this.seats) this.players[seat] = null;
    this.spectators = [];
    this.state = rules.createInitialState(this.mode);
    this.status = "waiting";
    this.lastEvents = [];
    this.history = [];
    this.chatLog = [];
    this.playerNames = {};
    this.createdAt = this.now();
    this.clockAnchorMs = this.createdAt;
    this.clockTimer = null;
    this.reconnectTimers = new Map();
  }

  filledCount() {
    return this.seats.reduce(
      (count, seat) => count + (this.players[seat] ? 1 : 0),
      0
    );
  }

  isEmpty() {
    if (this.spectators.length) return false;
    const players = this.seats
      .map((seat) => this.players[seat])
      .filter(Boolean);
    if (!players.length) return true;
    if (this.status !== "done") return false;
    return players.every((player) => player.connected === false);
  }

  seatOf(ws) {
    for (const seat of this.seats) {
      const player = this.players[seat];
      if (player && player.connected !== false && player.ws === ws) {
        return seat;
      }
    }
    return null;
  }

  spectatorOf(ws) {
    return this.spectators.find((spectator) => spectator.ws === ws) || null;
  }

  notify(update) {
    if (typeof this.onUpdate === "function") this.onUpdate(update);
  }

  makePlayer(ws, name, seat) {
    return {
      ws,
      name: sanitizeName(name),
      seat,
      connected: true,
      resumeToken: token(),
      reconnectDeadlineMs: null
    };
  }

  addPlayer(ws, name) {
    if (this.status === "done") {
      return { ok: false, error: "Phòng đã kết thúc" };
    }
    const seat = this.seats.find((candidate) => !this.players[candidate]);
    if (!seat) return { ok: false, error: "Phòng đã đủ người" };

    const player = this.makePlayer(ws, name, seat);
    this.players[seat] = player;
    this.playerNames[seat] = player.name;
    if (this.filledCount() === this.seats.length) {
      this.status = "playing";
      this.state = rules.createInitialState(this.mode);
      this.clockAnchorMs = this.now();
      this.scheduleClockDeadline();
    }
    return {
      ok: true,
      seat,
      role: seat,
      name: player.name,
      resumeToken: player.resumeToken
    };
  }

  addSpectator(ws, name) {
    if (this.status === "done") {
      return { ok: false, error: "Phòng đã kết thúc" };
    }
    if (this.spectators.length >= config.MAX_SPECTATORS) {
      return { ok: false, error: "Đã đủ người xem" };
    }
    if (this.seatOf(ws) || this.spectatorOf(ws)) {
      return { ok: false, error: "Bạn đã ở trong phòng" };
    }
    const spectator = { ws, name: sanitizeName(name) };
    this.spectators.push(spectator);
    return {
      ok: true,
      seat: "spectator",
      role: "spectator",
      name: spectator.name
    };
  }

  settleClock(now = this.now()) {
    if (
      this.status !== "playing" ||
      !this.state.clock ||
      !this.state.clock.runningSeat
    ) {
      this.clockAnchorMs = now;
      return { ok: true, state: this.state, events: [] };
    }
    const elapsed = Math.max(0, Math.floor(now - this.clockAnchorMs));
    if (elapsed === 0) {
      return { ok: true, state: this.state, events: [] };
    }
    const result = rules.elapseClock(this.state, elapsed);
    this.state = result.state;
    this.clockAnchorMs = now;
    if (result.events.length) this.lastEvents = result.events;
    if (this.state.winner) this.finishTerminal();
    else if (result.events.length) this.scheduleClockDeadline();
    return result;
  }

  scheduleJob(fn, delay) {
    const handle = this.schedule(fn, delay);
    if (handle && typeof handle.unref === "function") handle.unref();
    return handle;
  }

  cancelClockDeadline() {
    if (this.clockTimer !== null) {
      this.cancel(this.clockTimer);
      this.clockTimer = null;
    }
  }

  scheduleClockDeadline() {
    this.cancelClockDeadline();
    if (this.status !== "playing" || !this.state.clock.runningSeat) return;
    const seat = this.state.clock.runningSeat;
    const delay = Math.max(
      0,
      this.state.clock.remainingMs[seat] || config.TIME_CONTROL.initialMs
    );
    this.clockTimer = this.scheduleJob(() => {
      this.clockTimer = null;
      const result = this.settleClock(this.now());
      if (result.events.length || this.state.winner) {
        this.notify({
          type: "clock",
          result,
          terminal: Boolean(this.state.winner)
        });
      }
    }, delay);
  }

  finishTerminal() {
    this.cancelClockDeadline();
    for (const handle of this.reconnectTimers.values()) this.cancel(handle);
    this.reconnectTimers.clear();
    if (this.state.clock) this.state.clock.runningSeat = null;
    this.status = "done";
  }

  handleMove(ws, from, to) {
    const seat = this.seatOf(ws);
    if (!seat) {
      return {
        ok: false,
        error: "Bạn không ở trong phòng này",
        state: null,
        events: []
      };
    }
    if (this.status !== "playing") {
      return {
        ok: false,
        error: "Ván chưa bắt đầu",
        state: null,
        events: []
      };
    }

    const settled = this.settleClock(this.now());
    if (this.state.winner) {
      return {
        ok: false,
        error: "Ván đã kết thúc",
        state: this.state,
        events: settled.events
      };
    }

    const result = rules.applyMove(this.state, seat, from, to);
    if (!result.ok) return result;
    this.state = result.state;
    this.lastEvents = result.events;
    this.history.push({
      seat,
      from: { x: from.x, y: from.y },
      to: { x: to.x, y: to.y },
      events: result.events
    });
    this.clockAnchorMs = this.now();
    if (this.state.winner) this.finishTerminal();
    else this.scheduleClockDeadline();
    return result;
  }

  disconnectPlayer(ws) {
    if (this.mode === "arena") return this.abandonArena(ws, "disconnect");

    const seat = this.seatOf(ws);
    if (!seat) return null;
    const player = this.players[seat];
    if (this.status === "done") {
      player.connected = false;
      return { seat, name: player.name, reason: "disconnect" };
    }

    const now = this.now();
    const settled = this.settleClock(now);
    if (this.state.winner) {
      player.connected = false;
      return {
        seat,
        name: player.name,
        reason: this.state.reason,
        events: settled.events
      };
    }

    player.connected = false;
    player.reconnectDeadlineMs = now + config.TIME_CONTROL.reconnectGraceMs;
    if (this.state.clock.runningSeat === seat) {
      this.state.clock.runningSeat = null;
      this.clockAnchorMs = now;
      this.cancelClockDeadline();
    }

    const timer = this.scheduleJob(() => {
      this.reconnectTimers.delete(seat);
      const result = this.expireReconnect(this.now(), seat);
      if (result && result.events.length) {
        this.notify({
          type: "reconnect",
          result,
          terminal: Boolean(this.state.winner)
        });
      }
    }, config.TIME_CONTROL.reconnectGraceMs);
    this.reconnectTimers.set(seat, timer);
    return {
      seat,
      name: player.name,
      reason: "disconnect",
      resumeToken: player.resumeToken
    };
  }

  removePlayer(ws) {
    return this.disconnectPlayer(ws);
  }

  leavePlayer(ws) {
    if (this.mode === "arena") return this.abandonArena(ws, "leave");

    const seat = this.seatOf(ws);
    if (!seat) return null;
    const player = this.players[seat];
    this.settleClock(this.now());

    if (this.status !== "playing") {
      this.players[seat] = null;
      return { seat, name: player.name, reason: "leave" };
    }
    if (this.state.winner) {
      return { seat, name: player.name, reason: this.state.reason };
    }

    const other = seat === "A" ? "B" : "A";
    player.connected = false;
    player.reconnectDeadlineMs = null;
    const timer = this.reconnectTimers.get(seat);
    if (timer !== undefined) this.cancel(timer);
    this.reconnectTimers.delete(seat);
    this.state.winner = other;
    this.state.reason = "leave";
    this.state.eliminatedPlayer = null;
    this.lastEvents = [
      { type: "win", winner: other, reason: "leave", eliminatedPlayer: null }
    ];
    this.finishTerminal();
    return {
      seat,
      name: player.name,
      reason: "leave",
      result: { ok: true, state: this.state, events: this.lastEvents }
    };
  }

  abandonArena(ws, reason) {
    const spectator = this.spectatorOf(ws);
    if (spectator) {
      this.spectators = this.spectators.filter((item) => item.ws !== ws);
      return { seat: "spectator", name: spectator.name, reason };
    }

    const seat = this.seatOf(ws);
    if (!seat) return null;
    const player = this.players[seat];
    this.players[seat] = null;

    if (this.status === "playing" && !this.state.winner) {
      this.state = rules.eliminatePlayer(this.state, seat);
      if (this.state.winner) {
        this.state.reason = reason;
        this.lastEvents = [
          {
            type: "win",
            winner: this.state.winner,
            reason,
            eliminatedPlayer: seat
          }
        ];
        this.finishTerminal();
      } else {
        this.clockAnchorMs = this.now();
        this.scheduleClockDeadline();
      }
    }
    return { seat, name: player.name, reason };
  }

  resumePlayer(ws, resumeToken) {
    if (this.mode !== "duel" || this.status === "done") {
      return { ok: false, error: "Ván đã kết thúc" };
    }
    const now = this.now();
    const seat = this.seats.find((candidate) => {
      const player = this.players[candidate];
      return (
        player &&
        player.connected === false &&
        player.resumeToken === resumeToken &&
        player.reconnectDeadlineMs !== null &&
        player.reconnectDeadlineMs >= now
      );
    });
    if (!seat) {
      return {
        ok: false,
        error: "Mã khôi phục không hợp lệ hoặc đã hết hạn"
      };
    }

    const player = this.players[seat];
    const settled = this.settleClock(now);
    const timer = this.reconnectTimers.get(seat);
    if (timer !== undefined) this.cancel(timer);
    this.reconnectTimers.delete(seat);
    player.ws = ws;
    player.connected = true;
    player.reconnectDeadlineMs = null;
    if (!this.state.winner) {
      this.state.clock.runningSeat = this.state.turn;
      this.clockAnchorMs = now;
      this.scheduleClockDeadline();
    }
    return {
      ok: true,
      seat,
      name: player.name,
      state: this.state,
      events: settled.events
    };
  }

  expireReconnect(now = this.now(), onlySeat = null) {
    if (this.mode !== "duel" || this.status !== "playing") {
      return { ok: false, state: this.state, events: [] };
    }
    const expiredAll = this.seats.filter((seat) => {
      const player = this.players[seat];
      return (
        player &&
        player.connected === false &&
        player.reconnectDeadlineMs !== null &&
        player.reconnectDeadlineMs <= now
      );
    });
    const expired = onlySeat
      ? expiredAll.filter((seat) => seat === onlySeat)
      : expiredAll;
    if (!expired.length) {
      return { ok: true, state: this.state, events: [] };
    }
    const deadlines = expiredAll.map(
      (seat) => this.players[seat].reconnectDeadlineMs
    );
    const simultaneous =
      expiredAll.length === 2 && deadlines[0] === deadlines[1];
    // Rule.md has no draw outcome. If both grace windows expire together,
    // the seat whose turn was active is the deterministic loser.
    const loser = simultaneous && expiredAll.includes(this.state.turn)
      ? this.state.turn
      : expired[0];
    const winner = loser === "A" ? "B" : "A";
    const settled = this.settleClock(now);
    if (this.state.winner) return settled;
    this.state.winner = winner;
    this.state.reason = "disconnect_timeout";
    this.state.eliminatedPlayer = null;
    this.lastEvents = [
      {
        type: "win",
        winner,
        reason: "disconnect_timeout",
        eliminatedPlayer: null
      }
    ];
    this.finishTerminal();
    return { ok: true, state: this.state, events: this.lastEvents };
  }

  handleChat(ws, text) {
    const seat = this.seatOf(ws);
    const spectator = this.spectatorOf(ws);
    if (!seat && !spectator) {
      return { ok: false, error: "Bạn không ở trong phòng này" };
    }
    const clean = sanitizeText(text, config.CHAT_MAX);
    if (!clean) return { ok: false, error: "Tin trống" };
    const message = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      seat: seat || "spectator",
      name: seat ? this.players[seat].name : spectator.name,
      text: clean,
      at: Date.now()
    };
    this.chatLog.push(message);
    if (this.chatLog.length > config.CHAT_KEEP) this.chatLog.shift();
    return { ok: true, message };
  }

  handleReact(ws, code) {
    const seat = this.seatOf(ws);
    const spectator = this.spectatorOf(ws);
    if (!seat && !spectator) {
      return { ok: false, error: "Bạn không ở trong phòng này" };
    }
    if (!Object.prototype.hasOwnProperty.call(config.REACTS, code)) {
      return { ok: false, error: "Cảm xúc không hợp lệ" };
    }
    return {
      ok: true,
      react: {
        code,
        glyph: config.REACTS[code],
        seat: seat || "spectator",
        name: seat ? this.players[seat].name : spectator.name
      }
    };
  }

  payload() {
    this.settleClock(this.now());
    return {
      roomId: this.id,
      name: this.name,
      mode: this.mode,
      status: this.status,
      serverNow: this.now(),
      players: snapshotPlayers(this),
      spectators: this.spectators.length,
      state: rules.publicState(this.state),
      events: this.lastEvents || [],
      history: this.history,
      chat: this.chatLog
    };
  }

  lobbyInfo() {
    return {
      id: this.id,
      name: this.name,
      mode: this.mode,
      players: this.filledCount(),
      maxPlayers: this.seats.length,
      viewers: this.spectators.length,
      status: this.status,
      names: this.seats
        .map((seat) => this.players[seat] && this.players[seat].name)
        .filter(Boolean)
    };
  }

  waitingInfo() {
    return {
      id: this.id,
      players: this.filledCount(),
      names: this.seats
        .map((seat) => this.players[seat] && this.players[seat].name)
        .filter(Boolean)
    };
  }

  send(ws, msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  eachClient(fn) {
    for (const seat of this.seats) {
      const player = this.players[seat];
      if (player && player.connected !== false) fn(player.ws, seat);
    }
    for (const spectator of this.spectators) fn(spectator.ws, "spectator");
  }

  broadcast(msg, except) {
    this.eachClient((ws) => {
      if (ws !== except) this.send(ws, msg);
    });
  }

  emitState() {
    const payload = this.payload();
    this.eachClient((ws, role) => {
      this.send(
        ws,
        Object.assign({ type: "state", you: role, role }, payload)
      );
    });
  }
}

module.exports = {
  Room,
  sanitizeName,
  sanitizeText,
  snapshotPlayers
};
