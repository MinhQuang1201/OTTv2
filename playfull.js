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
      this._ping = null;
    }

    on(event, fn) {
      if (!this.handlers[event]) this.handlers[event] = [];
      this.handlers[event].push(fn);
      return () => {
        this.handlers[event] = (this.handlers[event] || []).filter((h) => h !== fn);
      };
    }

    emit(event, payload) {
      const list = this.handlers[event] || [];
      for (const fn of list) fn(payload);
      if (this.handlers["*"]) {
        for (const fn of this.handlers["*"]) fn(event, payload);
      }
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
      const self = this;
      return new Promise(function (resolve, reject) {
        if (self.ws && self.ws.readyState === 1) {
          resolve();
          return;
        }
        let settled = false;
        const ws = new WebSocket(self.url);
        self.ws = ws;
        ws.onopen = function () {
          self.connected = true;
          self.emit("open");
          self._ping = setInterval(function () {
            self.send({ type: "ping" });
          }, 20000);
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        ws.onerror = function () {
          self.emit("error", { message: "Lỗi kết nối Playfull" });
          if (!settled) {
            settled = true;
            reject(new Error("Lỗi kết nối Playfull"));
          }
        };
        ws.onclose = function () {
          self.connected = false;
          if (self._ping) {
            clearInterval(self._ping);
            self._ping = null;
          }
          self.emit("close");
        };
        ws.onmessage = function (ev) {
          let msg;
          try {
            msg = JSON.parse(ev.data);
          } catch (err) {
            self.emit("error", { message: "Máy chủ gửi gói lạ" });
            return;
          }
          if (msg.type === "joined") {
            self.you = msg.you;
            self.roomId = msg.roomId;
          }
          if (msg.type === "state") {
            self.you = msg.you || self.you;
            self.roomId = msg.roomId || self.roomId;
            self.state = msg.state;
          }
          if (msg.type === "left") {
            self.you = null;
            self.roomId = null;
            self.state = null;
          }
          self.emit(msg.type, msg);
        };
      });
    }

    create(name) {
      return this.send({ type: "create", name: name });
    }

    join(roomId, name) {
      return this.send({ type: "join", roomId: roomId, name: name });
    }

    list() {
      return this.send({ type: "list" });
    }

    move(from, to) {
      return this.send({ type: "move", from: from, to: to });
    }

    leave() {
      return this.send({ type: "leave" });
    }

    close() {
      if (this._ping) {
        clearInterval(this._ping);
        this._ping = null;
      }
      if (this.ws) this.ws.close();
    }
  }

  Playfull.defaultUrl = defaultUrl;
  global.Playfull = Playfull;
  if (typeof module === "object" && module.exports) module.exports = { Playfull };
})(typeof globalThis !== "undefined" ? globalThis : this);
