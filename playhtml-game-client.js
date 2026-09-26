(function (global, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(global);
  else global.PlayhtmlGameClient = factory(global);
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  const EVENT_TYPES = new Set([
    "open", "close", "reconnecting", "resumed", "error", "rooms", "hello",
    "joined", "state", "gameover", "left"
  ]);

  function storageFor(scope) {
    if (!global || !global.sessionStorage) return null;
    return {
      getItem: (key) => global.sessionStorage.getItem(scope + ":" + key),
      setItem: (key, value) => global.sessionStorage.setItem(scope + ":" + key, value),
      removeItem: (key) => global.sessionStorage.removeItem(scope + ":" + key)
    };
  }

  function validPoint(point) {
    return point && Number.isInteger(point.x) && Number.isInteger(point.y);
  }

  function normalizeRoomId(roomId) {
    const normalized = String(roomId || "").trim();
    if (/^(?:ott-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalized)) {
      return normalized.toLowerCase();
    }
    return normalized.toUpperCase();
  }

  function roomIdFrom(message, fallback) {
    return message.roomId === undefined ? fallback : normalizeRoomId(message.roomId);
  }

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  class PlayhtmlGameClient {
    constructor(options) {
      options = options || {};
      if (typeof options.connectionFactory !== "function") {
        throw new Error("PlayHTML game connection is not configured");
      }
      this.connectionFactory = options.connectionFactory;
      this.controlRequest = options.controlRequest || null;
      this.playhtmlBootstrap = options.playhtmlBootstrap || null;
      this.playhtmlHost = options.playhtmlHost || null;
      this.storage = options.storage || storageFor(options.storageScope || "ottv2");
      this.handlers = Object.create(null);
      this.connection = null;
      this.connected = false;
      this.roomId = null;
      this.you = null;
      this.state = null;
      this.resumeContext = null;
      this.reconnectTimer = null;
      this.reconnectAttempt = 0;
      this.intentionalClose = false;
      this.connectPromise = null;
      this.attachingAllocation = false;
      this.autoResumeTimer = null;
      this.stateRevision = null;
      this.resumeRoomKey = "__last_room__";
      this.eventDedupeLimit = Number.isInteger(options.eventDedupeLimit) && options.eventDedupeLimit > 0
        ? options.eventDedupeLimit : 256;
      this.seenEventIds = new Set();
      this.seenEventQueue = [];
    }

    on(event, fn) {
      (this.handlers[event] || (this.handlers[event] = [])).push(fn);
      return () => {
        this.handlers[event] = (this.handlers[event] || []).filter((handler) => handler !== fn);
      };
    }

    emit(event, payload) {
      for (const fn of this.handlers[event] || []) fn(payload);
    }

    send(type, payload) {
      if (!this.connection || !this.connected) {
        this.emit("error", { message: "Chưa kết nối máy chủ" });
        return false;
      }
      this.connection.send({
        __ott: true,
        type: "ott:" + type,
        ...((type === "move" || type === "leave") && this.roomId ? { roomId: this.roomId } : {}),
        ...(payload || {})
      });
      return true;
    }

    connect() {
      if (this.connected) return Promise.resolve();
      if (this.connectPromise) return this.connectPromise;
      this.intentionalClose = false;
      this.connectPromise = Promise.resolve(this.connectionFactory()).then((connection) => {
        this.connection = connection;
        if (!connection || typeof connection.send !== "function" || typeof connection.on !== "function") {
          throw new Error("PlayHTML game connection adapter is invalid");
        }
        connection.on("open", () => this.handleOpen());
        connection.on("message", (message) => this.handleMessage(message));
        connection.on("close", () => this.handleClose());
        connection.on("error", (error) => this.emit("error", error || { message: "Lỗi kết nối" }));
        if (typeof connection.connect === "function") return connection.connect();
      }).then(() => {
        if (!this.connected) this.handleOpen();
      }).finally(() => {
        this.connectPromise = null;
      });
      return this.connectPromise;
    }

    handleOpen() {
      this.connected = true;
      this.reconnectAttempt = 0;
      this.emit("open");
      if (!this.resumeContext && this.storage) {
        const roomId = normalizeRoomId(this.storage.getItem(this.resumeRoomKey));
        let metadata = null;
        try { metadata = roomId && JSON.parse(this.storage.getItem(roomId + ":allocation") || "null"); } catch (_) {}
        const resumeCredential = roomId && this.storage.getItem(roomId + ":resumeCredential");
        if (roomId && resumeCredential && metadata && metadata.allocationId) {
          this.resumeContext = { roomId, resumeCredential, allocationId: metadata.allocationId, seat: metadata.seat };
        }
      }
      if (this.resumeContext && !this.attachingAllocation) this.scheduleAutoResume();
    }

    handleClose() {
      this.connected = false;
      this.emit("close");
      if (!this.intentionalClose && this.resumeContext) this.scheduleReconnect();
    }

    handleMessage(message) {
      let msg = message;
      if (typeof message === "string") {
        try { msg = JSON.parse(message); } catch (_) { this.emit("error", { message: "Máy chủ gửi gói lạ" }); return; }
      }
      if (!isPlainObject(msg) || msg.__ott !== true || typeof msg.type !== "string") {
        this.emit("error", { message: "Máy chủ gửi gói lạ" });
        return;
      }
      const event = msg.type.replace(/^ott:/, "");
      if (!EVENT_TYPES.has(event)) return;
      if (event === "joined") {
        const roomId = normalizeRoomId(msg.roomId);
        if (!roomId || (this.roomId && roomId !== this.roomId)) return;
        this.setRoomId(roomId);
        msg = { ...msg, roomId: this.roomId };
        this.you = msg.you;
        if (msg.resumed) this.emit("resumed", msg);
      } else if (event === "state") {
        const projection = msg.state;
        if (isPlainObject(projection) && projection.roomId !== undefined && projection.you !== undefined) {
          if (normalizeRoomId(projection.roomId) !== normalizeRoomId(msg.roomId) ||
            !["A", "B"].includes(projection.you) || !isPlainObject(projection.state)) return;
          msg = {
            ...msg,
            status: projection.status,
            players: projection.players,
            events: projection.events,
            you: projection.you,
            state: projection.state,
          };
        }
        if (!Number.isInteger(msg.revision) || msg.revision < 0 || !isPlainObject(msg.state) ||
          (msg.events !== undefined && (!Array.isArray(msg.events) || !msg.events.every((item) =>
            isPlainObject(item) && Number.isInteger(item.id) && item.id > 0)))) return;
        const roomId = roomIdFrom(msg, null);
        if (!roomId || (this.roomId && roomId !== this.roomId)) return;
        this.setRoomId(roomId);
        msg = { ...msg, roomId: this.roomId };
        if (this.stateRevision !== null && msg.revision <= this.stateRevision) return;
        this.stateRevision = msg.revision;
        this.you = msg.you || this.you;
        this.state = msg.state;
      } else if (event === "left") {
        this.clearResume();
        this.roomId = null;
        this.you = null;
        this.state = null;
        this.resetOrdering();
      } else if (event === "error" && this.resumeContext &&
        (msg.code === "invalid_token" || msg.code === "resume_rejected") &&
        (!msg.roomId || normalizeRoomId(msg.roomId) === this.resumeContext.roomId)) {
        this.clearResume();
      }
      if (event === "state" && Array.isArray(msg.events)) {
        msg = { ...msg, events: msg.events.filter((item) => this.acceptEvent(item)) };
      }
      this.emit(event, msg);
    }

    scheduleReconnect() {
      if (this.reconnectTimer || !this.resumeContext) return;
      const delay = Math.min(2000, 200 * Math.pow(2, this.reconnectAttempt++));
      this.emit("reconnecting", { delay });
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect().catch(() => this.scheduleReconnect());
      }, delay);
    }

    scheduleAutoResume() {
      if (this.autoResumeTimer || !this.resumeContext) return;
      this.autoResumeTimer = setTimeout(() => {
        this.autoResumeTimer = null;
        if (this.connected && this.resumeContext) {
          const attempt = this.resumeContext;
          if (this.controlRequest && attempt.allocationId && attempt.resumeCredential) {
            this.controlRequest("resume", {
              allocationId: attempt.allocationId,
              resumeCredential: attempt.resumeCredential
            }).then((allocation) => this.attachAllocation(allocation)).catch((error) => {
              if (error && (error.status === 401 || error.code === "resume_rejected")) {
                this.clearResumeIfCurrent(attempt.roomId, attempt.resumeCredential);
              }
              this.emit("error", { message: error.message || "Không khôi phục được phòng" });
            });
          }
        }
      }, 0);
    }

    cancelAutoResume() {
      if (this.autoResumeTimer) clearTimeout(this.autoResumeTimer);
      this.autoResumeTimer = null;
    }

    beginExplicitSession(roomId) {
      this.intentionalClose = false;
      this.cancelAutoResume();
      this.clearResume();
      this.setRoomId(roomId);
      this.you = null;
      this.state = null;
    }
    create(name) {
      this.beginExplicitSession(null);
      return this.allocate("create", { name });
    }
    join(roomId, name) {
      roomId = normalizeRoomId(roomId);
      this.beginExplicitSession(roomId);
      return this.controlRequest
        ? this.allocate("join", { allocationId: roomId, name })
        : this.send("join", { roomId, name });
    }
    resume(roomId, resumeCredential) {
      roomId = normalizeRoomId(roomId);
      resumeCredential = resumeCredential || (this.storage && this.storage.getItem(roomId + ":resumeCredential"));
      let metadata = null;
      try { metadata = this.storage && JSON.parse(this.storage.getItem(roomId + ":allocation") || "null"); } catch (_) {}
      if (!resumeCredential || !metadata || !metadata.allocationId || !this.controlRequest) {
        this.emit("error", { message: "Thiếu mã khôi phục" });
        return false;
      }
      this.intentionalClose = false;
      this.cancelAutoResume();
      this.resumeContext = { roomId, resumeCredential, allocationId: metadata.allocationId, seat: metadata.seat };
      const attempt = this.resumeContext;
      this.setRoomId(roomId);
      if (this.controlRequest && this.storage) {
        let metadata = null;
        try { metadata = JSON.parse(this.storage.getItem(roomId + ":allocation") || "null"); } catch (_) {}
        if (metadata && metadata.allocationId) {
          return this.controlRequest("resume", {
            allocationId: metadata.allocationId,
            resumeCredential
          }).then((allocation) => this.attachAllocation(allocation)).catch((error) => {
            if (error && (error.status === 401 || error.code === "resume_rejected")) {
              this.clearResumeIfCurrent(attempt.roomId, attempt.resumeCredential);
            }
            this.emit("error", { message: error.message || "Không khôi phục được phòng" });
            return false;
          });
        }
      }
      return false;
    }
    list() { return this.send("list"); }

    async listRooms() {
      if (!this.controlRequest) return this.list();
      try {
        const result = await this.controlRequest("list", {});
        this.emit("rooms", result || { rooms: [] });
        return result;
      } catch (error) {
        this.emit("error", { message: error.message || "Không tải được danh sách phòng" });
        return false;
      }
    }

    async allocate(action, body) {
      if (!this.controlRequest) return this.send(action, body);
      try {
        const allocation = await this.controlRequest(action, body);
        if (!allocation || typeof allocation.room !== "string" || typeof allocation.ticket !== "string" || typeof allocation.resumeCredential !== "string") {
          throw new Error("Phản hồi phân bổ phòng không hợp lệ");
        }
        return this.attachAllocation(allocation);
      } catch (error) {
        this.emit("error", { message: error.message || "Không phân bổ được phòng" });
        return false;
      }
    }

    async attachAllocation(allocation) {
      if (!allocation || typeof allocation.room !== "string" || typeof allocation.ticket !== "string" ||
        typeof allocation.resumeCredential !== "string" || typeof allocation.allocationId !== "string" || !["A", "B"].includes(allocation.seat)) {
        throw new Error("Phản hồi phân bổ phòng không hợp lệ");
      }
      const roomId = normalizeRoomId(allocation.room);
      this.setRoomId(roomId);
      this.resumeContext = {
        roomId,
        resumeCredential: allocation.resumeCredential,
        allocationId: allocation.allocationId,
        seat: allocation.seat
      };
      if (this.storage) {
        this.storage.setItem(roomId + ":resumeCredential", allocation.resumeCredential);
        this.storage.setItem(this.resumeRoomKey, roomId);
        this.storage.setItem(roomId + ":allocation", JSON.stringify({ allocationId: allocation.allocationId, seat: allocation.seat }));
      }
      this.attachingAllocation = true;
      try {
        const bootstrap = this.playhtmlBootstrap || global.OTT_PLAYHTML_BOOTSTRAP;
        if (typeof bootstrap === "function") await bootstrap({ host: this.playhtmlHost, room: allocation.room });
        if (!this.connected) await this.connect();
        return this.send("attach", { roomId, ticket: allocation.ticket });
      } finally {
        this.attachingAllocation = false;
      }
    }
    move(from, to) {
      if (!validPoint(from) || !validPoint(to)) {
        this.emit("error", { message: "Tọa độ không hợp lệ" });
        return false;
      }
      return this.send("move", { from, to });
    }
    leave() {
      this.intentionalClose = true;
      this.cancelAutoResume();
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      const sent = this.send("leave");
      this.clearResume();
      this.roomId = null;
      this.you = null;
      this.state = null;
      this.resetOrdering();
      return sent;
    }
    clearResume() {
      this.cancelAutoResume();
      if (this.resumeContext && this.storage) {
        this.storage.removeItem(this.resumeContext.roomId);
        this.storage.removeItem(this.resumeContext.roomId + ":resumeCredential");
        this.storage.removeItem(this.resumeRoomKey);
        this.storage.removeItem(this.resumeContext.roomId + ":allocation");
      }
      this.resumeContext = null;
    }
    clearResumeIfCurrent(roomId, resumeCredential) {
      if (!this.resumeContext || this.resumeContext.roomId !== roomId || this.resumeContext.resumeCredential !== resumeCredential) return false;
      this.clearResume();
      return true;
    }
    setRoomId(roomId) {
      const normalized = normalizeRoomId(roomId);
      if (normalized !== this.roomId) this.resetOrdering();
      this.roomId = normalized;
    }
    resetOrdering() {
      this.stateRevision = null;
      this.seenEventIds.clear();
      this.seenEventQueue = [];
    }
    acceptEvent(event) {
      if (!event || !Number.isInteger(event.id)) return true;
      if (this.seenEventIds.has(event.id)) return false;
      this.seenEventIds.add(event.id);
      this.seenEventQueue.push(event.id);
      while (this.seenEventQueue.length > this.eventDedupeLimit) {
        this.seenEventIds.delete(this.seenEventQueue.shift());
      }
      return true;
    }
    close() {
      this.intentionalClose = true;
      this.cancelAutoResume();
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      if (this.connection && typeof this.connection.close === "function") this.connection.close();
      this.connection = null;
      this.connected = false;
    }
  }

  return PlayhtmlGameClient;
});
