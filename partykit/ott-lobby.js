const { WaitingRoomRegistry, sanitizeName } = require("./lobby");
const { parseClientMessage, createRateLimiter } = require("./protocol");

const GAME_PARTY = "game";

// PartyKit 0.0.115 exposes context.parties[name].get(roomId), whose stub has
// fetch(...) and async socket(...). This adapter deliberately uses that API,
// rather than constructing a Party URL or keeping process-local room state.
async function routeToGame(context, roomId, message) {
  const stub = context?.parties?.[GAME_PARTY]?.get(roomId);
  if (!stub || typeof stub.socket !== "function") throw new Error("Game party unavailable");
  const socket = await stub.socket("/");
  if (message !== undefined) socket.send(JSON.stringify(message));
  return socket;
}

class OttLobby {
  constructor(room) {
    this.room = room || {};
    this.connections = new Map();
    this.routes = new Map();
    this.rateLimiter = createRateLimiter({ now: () => this.now() });
    this.registry = new WaitingRoomRegistry(this.room.storage, {
      random: this.room.random,
      publish: this.room.publish
    });
  }

  async onConnect(connection) {
    this.connections.set(String(connection.id || ""), connection);
    this.send(connection, { type: "ott:hello", rooms: await this.listWaitingRooms() });
  }

  async onClose(connection) {
    const id = String(connection.id || "");
    const route = this.routes.get(id);
    this.routes.delete(id);
    if (route && typeof route.close === "function") route.close();
    this.connections.delete(id);
  }

  async onMessage(message, sender) {
    const connectionId = String(sender.id || "");
    const rate = this.rateLimiter.check(connectionId);
    if (!rate.allowed) return;
    const parsed = parseClientMessage(typeof message === "string" ? message : String(message));
    if (!parsed.ok) return this.error(sender, "Gói tin không hợp lệ", parsed.error.code);
    const command = parsed.value;
    if (command.type === "ott:ping") return this.send(sender, { type: "ott:pong" });
    if (command.type === "ott:list") return this.send(sender, { type: "ott:rooms", rooms: await this.listWaitingRooms() });
    if (command.type === "ott:create") return this.create(sender, command);
    if (command.type === "ott:join" || command.type === "ott:resume") return this.join(sender, command);
    return this.forward(sender, command);
  }

  async create(sender, command) {
    const record = await this.registry.create({ names: { A: sanitizeName(command.name) }, players: 1 });
    try {
      await this.forward(sender, { ...command, name: sanitizeName(command.name), roomId: record.id });
    } catch (error) {
      await this.registry.remove(record.id);
      throw error;
    }
  }

  async join(sender, command) {
    const roomId = command.roomId;
    const record = command.type === "ott:join" ? await this.registry.get(roomId) : null;
    if (command.type === "ott:join" && (!record || record.status !== "waiting")) {
      return this.error(sender, "Không tìm thấy phòng");
    }
    return this.forward(sender, command);
  }

  async forward(sender, command) {
    const id = String(sender.id || "");
    const roomId = command.roomId;
    if (!roomId) return this.error(sender, "Không tìm thấy phòng");
    let route = this.routes.get(id);
    if (!route || route.roomId !== roomId) {
      try {
        const socket = await routeToGame(this.room.context, roomId);
        route = this.createRoute(id, roomId, sender, socket);
        this.routes.set(id, route);
      } catch {
        return this.error(sender, "Không tìm thấy phòng");
      }
    }
    route.socket.send(JSON.stringify(command));
  }

  createRoute(connectionId, roomId, client, socket) {
    const relay = (event) => {
      const data = event?.data === undefined ? event : event.data;
      if (data !== undefined) {
        this.applyLifecycle(roomId, data);
        this.send(client, typeof data === "string" ? data : data);
      }
    };
    if (typeof socket.addEventListener === "function") socket.addEventListener("message", relay);
    else socket.onmessage = relay;
    return { connectionId, roomId, socket, close: () => socket.close?.() };
  }

  async applyLifecycle(roomId, data) {
    let message;
    try { message = typeof data === "string" ? JSON.parse(data) : data; } catch { return; }
    if (message?.type === "ott:state" && message.status === "playing") return this.registry.remove(roomId);
    if (message?.type === "ott:gameover" || message?.type === "ott:left") return this.registry.remove(roomId);
  }

  async listWaitingRooms() {
    const rooms = await this.registry.list();
    const visible = [];
    for (const room of rooms) {
      const stub = this.room.context?.parties?.[GAME_PARTY]?.get(room.id);
      if (!stub || typeof stub.fetch !== "function") {
        visible.push(room);
        continue;
      }
      try {
        const response = await stub.fetch("/");
        if (response.status === 404 || response.status === 410) {
          await this.registry.remove(room.id);
          continue;
        }
        if (!response.ok) {
          visible.push(room);
          continue;
        }
        const status = (await response.json())?.status;
        if (status === "waiting") visible.push(room);
        else await this.registry.remove(room.id);
      } catch {
        visible.push(room);
      }
    }
    return visible;
  }

  now() { return typeof this.room.now === "function" ? this.room.now() : Date.now(); }
  send(connection, message) { if (connection?.send) connection.send(typeof message === "string" ? message : JSON.stringify(message)); }
  error(connection, message, code) { this.send(connection, { type: "ott:error", message, ...(code ? { code } : {}) }); }
}

module.exports = OttLobby;
module.exports.OttLobby = OttLobby;
module.exports.routeToGame = routeToGame;
