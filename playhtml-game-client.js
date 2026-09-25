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
    return String(roomId || "").trim().toUpperCase();
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
      this.connection.send({ __ott: true, type: "ott:" + type, ...(payload || {}) });
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
        const resumeToken = roomId && this.storage.getItem(roomId);
        if (roomId && resumeToken) {
          this.resumeContext = { roomId, resumeToken };
        }
      }
      if (this.resumeContext) this.scheduleAutoResume();
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
        if (msg.resumeToken) {
          this.resumeContext = { roomId: this.roomId, resumeToken: msg.resumeToken };
          if (this.storage) {
            this.storage.setItem(this.roomId, msg.resumeToken);
            this.storage.setItem(this.resumeRoomKey, this.roomId);
          }
        }
        if (msg.resumed) this.emit("resumed", msg);
      } else if (event === "state") {
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
        if (this.connected && this.resumeContext) this.send("resume", this.resumeContext);
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
      return this.send("create", { name });
    }
    join(roomId, name) {
      roomId = normalizeRoomId(roomId);
      this.beginExplicitSession(roomId);
      return this.send("join", { roomId, name });
    }
    resume(roomId, resumeToken) {
      roomId = normalizeRoomId(roomId);
      const storedToken = resumeToken || (this.storage && this.storage.getItem(roomId));
      if (!storedToken) {
        this.emit("error", { message: "Thiếu mã khôi phục" });
        return false;
      }
      this.intentionalClose = false;
      this.cancelAutoResume();
      this.resumeContext = { roomId, resumeToken: storedToken };
      this.setRoomId(roomId);
      return this.send("resume", this.resumeContext);
    }
    list() { return this.send("list"); }
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
      return sent;
    }
    clearResume() {
      this.cancelAutoResume();
      if (this.resumeContext && this.storage) {
        this.storage.removeItem(this.resumeContext.roomId);
        this.storage.removeItem(this.resumeRoomKey);
      }
      this.resumeContext = null;
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
