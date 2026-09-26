const config = require("../config");
const { Room } = require("../room");
const { connectionAdapter } = require("./connection");
const { serializeRoom, hydrateRoom } = require("./room-storage");
const { parseClientMessage, createRateLimiter } = require("./protocol");

const MAX_PAYLOAD = config.MAX_MESSAGE || 8 * 1024;
const MIN_PACKET_MS = 40;

function nextDeadline(room) {
  if (!room || room.status === "done" || room.state.winner) return null;
  const deadlines = [];
  if (room.status === "playing") {
    const seat = room.state.clock.runningSeat;
    if (seat) deadlines.push(room.clockAnchorMs + room.state.clock.remainingMs[seat]);
  }
  for (const player of [room.players.A, room.players.B]) {
    if (player && !player.connected && player.reconnectDeadlineMs !== null) deadlines.push(player.reconnectDeadlineMs);
  }
  return deadlines.length ? Math.min(...deadlines) : null;
}

class OttRoom {
  constructor(ctx) {
    this.ctx = ctx || {};
    this.id = String(this.ctx.id || this.ctx.roomId || "");
    this.connections = new Map();
    this.rateLimiter = createRateLimiter({ now: () => this.now() });
    this.room = null;
    this.loaded = false;
    this.lifecycle = this.ctx.lifecycle || null;
    this.alarmDeadline = null;
    this.unusable = false;
  }

  async onStart() {
    if (await this.storageGet("unusable")) {
      this.unusable = true;
      this.loaded = true;
      await this.storageDeleteAlarm();
      return;
    }
    const saved = await this.storageGet("room");
    const deps = this.roomDeps();
    try {
      this.room = saved ? hydrateRoom(saved, this.id, deps) : new Room(this.id, deps);
    } catch {
      this.unusable = true;
      this.loaded = true;
      await this.storageDeleteAlarm();
      return;
    }
    this.loaded = true;
    if (saved) {
      const before = JSON.stringify(serializeRoom(this.room));
      for (const seat of ["A", "B"]) {
        if (saved.players[seat]?.connected) this.room.players[seat].connected = true;
      }
      this.room.reconcileHydration(this.now());
      this.room.settleClock(this.now());
      if (this.room.state.winner) this.room.finishTerminal();
      if (JSON.stringify(serializeRoom(this.room)) !== before) await this.changed();
    }
    this.rescheduleReconnects();
    if (this.room.status === "playing" && !this.room.state.winner) this.room.scheduleClockDeadline();
    await this.syncDeadline();
    if (this.room.status === "done" || this.room.state.winner) await this.storageDeleteAlarm();
  }

  async onConnect(connection) {
    this.connections.set(String(connection.id || ""), connectionAdapter(connection));
    if (this.unusable) return this.error(connection, "Phòng không khả dụng");
    this.send(connection, { type: "ott:hello", rooms: [] });
  }

  async onClose(connection) {
    const adapter = this.connections.get(String(connection.id || ""));
    if (!adapter || !this.room) return;
    const result = this.room.disconnectPlayer(adapter);
    this.connections.delete(adapter.id);
    if (result) await this.changed();
  }

  async onMessage(connection, raw) {
    if (!this.room) await this.onStart();
    const adapter = this.connections.get(String(connection.id || ""));
    if (!adapter) return;
    if (this.unusable) return this.error(adapter, "Phòng không khả dụng");
    const rate = this.rateLimiter.check(adapter.id);
    if (!rate.allowed) return this.error(adapter, "Gửi quá nhanh", rate.code);
    const parsed = parseClientMessage(typeof raw === "string" ? raw : String(raw));
    if (!parsed.ok) return this.error(adapter, "Gói tin không hợp lệ", parsed.error.code);
    const message = parsed.value;
    const type = message.type.slice(4);
    if (type === "ping") return this.send(adapter, { type: "ott:pong" });
    if (type === "create" || type === "list") return this.error(adapter, "Lệnh không hỗ trợ");
    if (type === "join") return this.join(adapter, type, message);
    if (type === "resume") return this.resume(adapter, message);
    if (type === "move") return this.move(adapter, message);
    if (type === "leave") return this.leave(adapter);
    return this.error(adapter, "Lệnh không hỗ trợ");
  }

  async join(adapter, type, message) {
    if (type === "join" && String(message.roomId || "").trim().toUpperCase() !== this.id) return this.error(adapter, "Không tìm thấy phòng");
    const result = this.room.addPlayer(adapter, message.name);
    if (!result.ok) return this.error(adapter, result.error);
    this.send(adapter, { type: "ott:joined", roomId: this.id, you: result.seat, name: result.name, resumeToken: result.resumeToken, players: this.room.payload().players, status: this.room.status });
    await this.changed();
    if (this.lifecycle) {
      if (this.room.status === "playing") await this.lifecycle.started(this.id);
      else await this.lifecycle.created(this.id, this.room.payload());
    }
  }

  async resume(adapter, message) {
    if (String(message.roomId || "").trim().toUpperCase() !== this.id) return this.error(adapter, "Không tìm thấy phòng");
    const result = this.room.resumePlayer(adapter, String(message.resumeToken || ""));
    if (!result.ok) return this.error(adapter, result.error);
    this.send(adapter, { type: "ott:joined", roomId: this.id, you: result.seat, name: result.name, resumeToken: this.room.players[result.seat].resumeToken, players: this.room.payload().players, status: this.room.status, resumed: true });
    await this.changed();
    if (this.lifecycle) await this.lifecycle.started(this.id);
  }

  async move(adapter, message) {
    if (!validSquare(message.from) || !validSquare(message.to)) return this.error(adapter, "Tọa độ không hợp lệ");
    const result = this.room.handleMove(adapter, message.from, message.to);
    if (!result.ok) {
      if (this.room.state.winner) await this.changed();
      return this.error(adapter, result.error);
    }
    await this.changed();
  }

  async leave(adapter) {
    const result = this.room.leavePlayer(adapter);
    if (result) await this.changed();
    if (result && this.lifecycle) await this.lifecycle.left(this.id, this.room.payload());
    this.send(adapter, { type: "ott:left" });
  }

  async changed() {
    this.publish();
    await this.storagePut("room", serializeRoom(this.room));
    await this.syncDeadline();
  }

  publish() {
    for (const seat of ["A", "B"]) {
      const player = this.room.players[seat];
      if (!player || !player.connected) continue;
      const payload = this.room.payload();
      this.send(player.connection, { type: "ott:state", you: seat, ...payload });
    }
    if (this.room.state.winner && !this.room._terminalBroadcasted) {
      this.room._terminalBroadcasted = true;
      for (const seat of ["A", "B"]) {
        const player = this.room.players[seat];
        if (player && player.connected) this.send(player.connection, { type: "ott:gameover", winner: this.room.state.winner, reason: this.room.state.reason, eliminatedPlayer: this.room.state.eliminatedPlayer });
      }
    }
  }

  roomDeps() {
    return {
      now: () => this.now(),
      schedule: (fn, delay) => this.schedule(fn, delay),
      cancel: (timer) => this.cancel(timer),
      onUpdate: () => { this.changed(); }
    };
  }

  rescheduleReconnects() {
    for (const seat of ["A", "B"]) {
      const player = this.room.players[seat];
      if (player && !player.connected && player.reconnectDeadlineMs !== null) {
        const delay = Math.max(0, player.reconnectDeadlineMs - this.now());
        this.schedule(() => { const result = this.room.expireReconnect(this.now(), seat); if (result.events.length || this.room.state.winner) this.changed(); }, delay);
      }
    }
  }

  nextDeadline() {
    return nextDeadline(this.room);
  }

  async syncDeadline() {
    const deadline = this.nextDeadline();
    if (deadline === this.alarmDeadline) return;
    this.alarmDeadline = deadline;
    if (deadline === null) return this.storageDeleteAlarm();
    return this.storageSetAlarm(deadline);
  }

  async alarm() {
    if (!this.room) await this.onStart();
    if (this.unusable) return;
    const before = JSON.stringify(serializeRoom(this.room));
    this.room.settleClock(this.now());
    this.room.expireReconnect(this.now());
    const waitingExpired = this.room.expireWaitingCreator(this.now());
    if (waitingExpired.expired) {
      await this.storagePut("unusable", { reason: "waiting_creator_expired" });
      await this.storageDelete("room");
      await this.storageDeleteAlarm();
      return;
    }
    const changed = JSON.stringify(serializeRoom(this.room)) !== before;
    if (changed) await this.changed();
    else await this.syncDeadline();
    if (this.room.status === "done" || this.room.state.winner) await this.storageDeleteAlarm();
  }

  now() { return typeof this.ctx.now === "function" ? this.ctx.now() : Date.now(); }
  schedule(fn, delay) { return typeof this.ctx.schedule === "function" ? this.ctx.schedule(fn, delay) : setTimeout(fn, delay); }
  cancel(timer) { return typeof this.ctx.cancel === "function" ? this.ctx.cancel(timer) : clearTimeout(timer); }
  async storageGet(key) { return this.ctx.storage && typeof this.ctx.storage.get === "function" ? this.ctx.storage.get(key) : undefined; }
  async storagePut(key, value) { if (this.ctx.storage && typeof this.ctx.storage.put === "function") await this.ctx.storage.put(key, value); }
  async storageDelete(key) { if (this.ctx.storage && typeof this.ctx.storage.delete === "function") await this.ctx.storage.delete(key); }
  async storageSetAlarm(deadline) { if (this.ctx.storage && typeof this.ctx.storage.setAlarm === "function") await this.ctx.storage.setAlarm(deadline); }
  async storageDeleteAlarm() { if (this.ctx.storage && typeof this.ctx.storage.deleteAlarm === "function") await this.ctx.storage.deleteAlarm(); }
  send(connection, message) { if (connection && typeof connection.send === "function") connection.send(JSON.stringify(message)); }
  error(connection, message, code) { this.send(connection, { type: "ott:error", message, ...(code ? { code } : {}) }); }
}

class PartyKitOttRoom {
  constructor(room) {
    this.room = room;
    // PartyKit 0.0.115 does not expose context.parties during alarms, so
    // production lifecycle cleanup uses the lobby's verified fetch probe.
    this.impl = new OttRoom({
      id: room.id,
      storage: room.storage,
      now: () => typeof room.context?.now === "function" ? room.context.now() : Date.now(),
      schedule: () => null,
      cancel: () => {},
    });
  }

  onStart() { return this.impl.onStart(); }
  onConnect(connection) { return this.impl.onConnect(connection); }
  onMessage(message, sender) { return this.impl.onMessage(sender, message); }
  onClose(connection) { return this.impl.onClose(connection); }
  async onAlarm() {
    await this.impl.alarm();
  }
  async onRequest() {
    return new Response(JSON.stringify({ status: this.impl.unusable ? "unavailable" : this.impl.room?.status || "waiting" }), {
      headers: { "Content-Type": "application/json" }
    });
  }
}

function validSquare(square) { return square && Number.isInteger(square.x) && Number.isInteger(square.y); }

function createLobbyLifecycle(registry) {
  if (!registry) throw new TypeError("Lobby registry is required");
  return {
    created: (id, room) => room === undefined
      ? registry.create(id)
      : registry.create({ id, ...(room || {}) }),
    started: (id) => registry.remove(id),
    left: (id, room) => registry.update(id, room),
    graceExpired: (id) => registry.remove(id),
    cleanedUp: (id) => registry.remove(id)
  };
}

module.exports = PartyKitOttRoom;
module.exports.OttRoom = OttRoom;
module.exports.PartyKitOttRoom = PartyKitOttRoom;
module.exports.createLobbyLifecycle = createLobbyLifecycle;
module.exports.nextDeadline = nextDeadline;
