(function (global) {
  function defaultUrl() {
    if (typeof location === "undefined") return "ws://127.0.0.1:3000";
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return proto + "://" + location.host;
  }

  class Playfull {
    constructor(options) {
      this.url = (options && options.url) || defaultUrl();
      this.ws = null;
      this.handlers = Object.create(null);
      this.you = null;
      this.roomId = null;
      this.state = null;
      this.connected = false;
      this.resumeContext = null;
      this._ping = null;
      this._reconnectTimer = null;
      this._reconnectAttempt = 0;
      this._intentionalClose = false;
      this._resuming = false;
      this._connectPromise = null;
    }

    on(event, fn) {
      if (!this.handlers[event]) this.handlers[event] = [];
      this.handlers[event].push(fn);
      return () => {
        this.handlers[event] = (this.handlers[event] || []).filter((h) => h !== fn);
      };
    }

    emit(event, payload) {
      for (const fn of this.handlers[event] || []) fn(payload);
      for (const fn of this.handlers["*"] || []) fn(event, payload);
    }

    send(msg) {
      if (!this.ws || this.ws.readyState !== 1) {
        this.emit("error", { message: "Chưa kết nối máy chủ" });
        return false;
      }
      this.ws.send(JSON.stringify(msg));
      return true;
    }

    connect() {
      if (this.ws && this.ws.readyState === 1) return Promise.resolve();
      if (this._connectPromise) return this._connectPromise;
      this._intentionalClose = false;
      this._connectPromise = new Promise((resolve, reject) => {
        let settled = false;
        const ws = new WebSocket(this.url);
        this.ws = ws;
        ws.onopen = () => {
          this.connected = true;
          this._reconnectAttempt = 0;
          this.emit("open");
          this._ping = setInterval(() => this.send({ type: "ping" }), 20000);
          if (this.resumeContext) {
            this._resuming = true;
            this.send({ type: "resume", roomId: this.resumeContext.roomId, resumeToken: this.resumeContext.resumeToken });
          }
          if (!settled) {
            settled = true;
            resolve();
          }
          this._connectPromise = null;
        };
        ws.onerror = () => {
          this.emit("error", { message: "Lỗi kết nối Playfull" });
          if (!settled) {
            settled = true;
            reject(new Error("Lỗi kết nối Playfull"));
            this._connectPromise = null;
          }
        };
        ws.onclose = () => {
          this.connected = false;
          if (this._ping) clearInterval(this._ping);
          this._ping = null;
          this.ws = null;
          this.emit("close");
          if (!this._intentionalClose && this.resumeContext) this.scheduleReconnect();
        };
        ws.onmessage = (ev) => {
          let msg;
          try {
            msg = JSON.parse(ev.data);
          } catch (err) {
            this.emit("error", { message: "Máy chủ gửi gói lạ" });
            return;
          }
          if (msg.type === "joined") {
            this.you = msg.you;
            this.roomId = msg.roomId;
            if (msg.resumeToken) {
              this.resumeContext = { roomId: msg.roomId, resumeToken: msg.resumeToken, name: msg.name };
            }
            if (msg.resumed) this.emit("resumed", msg);
            this._resuming = false;
          }
          if (msg.type === "state") {
            this.you = msg.you || this.you;
            this.roomId = msg.roomId || this.roomId;
            this.state = msg.state;
          }
          if (msg.type === "left") {
            this.you = null;
            this.roomId = null;
            this.state = null;
            this.resumeContext = null;
          }
          if (msg.type === "error" && this._resuming) {
            this.resumeContext = null;
            this._resuming = false;
          }
          this.emit(msg.type, msg);
        };
      });
      return this._connectPromise;
    }

    scheduleReconnect() {
      if (this._reconnectTimer || !this.resumeContext) return;
      const delay = Math.min(2000, 200 * Math.pow(2, this._reconnectAttempt++));
      this.emit("reconnecting", { delay });
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        this.connect().catch(() => this.scheduleReconnect());
      }, delay);
    }

    create(name) {
      return this.send({ type: "create", name });
    }

    join(roomId, name) {
      return this.send({ type: "join", roomId, name });
    }

    resume(roomId, resumeToken) {
      this.resumeContext = { roomId, resumeToken };
      return this.send({ type: "resume", roomId, resumeToken });
    }

    list() {
      return this.send({ type: "list" });
    }

    move(from, to) {
      return this.send({ type: "move", from, to });
    }

    leave() {
      this._intentionalClose = true;
      this.resumeContext = null;
      if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      return this.send({ type: "leave" });
    }

    close() {
      this._intentionalClose = true;
      this.resumeContext = null;
      if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      if (this._ping) clearInterval(this._ping);
      this._ping = null;
      if (this.ws) this.ws.close();
    }
  }

  Playfull.defaultUrl = defaultUrl;
  global.Playfull = Playfull;
  if (typeof module === "object" && module.exports) module.exports = { Playfull };
})(typeof globalThis !== "undefined" ? globalThis : this);
