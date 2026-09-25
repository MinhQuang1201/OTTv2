const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const config = require("./config");
const { Room, sanitizeName, sanitizeText } = require("./room");
const persist = require("./persist");

const ROOT = path.resolve(__dirname);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".ico": "image/x-icon"
};
const DENY = new Set([
  "server.js",
  "room.js",
  "persist.js",
  "package.json",
  "package-lock.json",
  ".gitignore"
]);

const rooms = new Map();
const sockets = new WeakMap();
const lobby = new Set();

function publicPath(urlPath) {
  const clean = decodeURIComponent((urlPath || "/").split("?")[0]);
  const relative = clean === "/" ? "index.html" : clean.replace(/^\/+/, "");
  const resolved = path.resolve(ROOT, relative);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) return null;
  if (DENY.has(path.basename(resolved))) return null;
  if (
    relative.startsWith("node_modules") ||
    relative.startsWith("tests") ||
    relative.startsWith("data") ||
    relative.startsWith(".")
  ) {
    return null;
  }
  return resolved;
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === "ENOENT" ? 404 : 500, {
        "Content-Type": "text/plain; charset=utf-8"
      });
      res.end(err.code === "ENOENT" ? "Không tìm thấy" : "Lỗi máy chủ");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control":
        ext === ".html" || ext === ".js" ? "no-store" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff"
    });
    res.end(data);
  });
}

function json(res, code, body) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Chỉ nhận GET");
    return;
  }

  const urlPath = (req.url || "/").split("?")[0];
  if (urlPath === "/api/leaderboard") {
    json(res, 200, { players: persist.leaderboard() });
    return;
  }

  const filePath = publicPath(req.url);
  if (!filePath) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Không cho phép");
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Không tìm thấy");
      return;
    }
    sendFile(res, filePath);
  });
});

const wss = new WebSocketServer({ server, maxPayload: config.MAX_MESSAGE });

function roomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let index = 0; index < config.ROOM_ID_LEN; index += 1) {
    id += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return id;
}

function uniqueRoomId() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const id = roomCode();
    if (!rooms.has(id)) return id;
  }
  return roomCode() + Date.now().toString(36).slice(-2).toUpperCase();
}

function send(ws, message) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
}

function enterLobby(ws) {
  lobby.add(ws);
}

function leaveLobby(ws) {
  lobby.delete(ws);
}

function publicRooms() {
  return Array.from(rooms.values())
    .filter((room) => room.status === "waiting" || room.status === "playing")
    .map((room) => room.lobbyInfo());
}

function broadcastLobby() {
  const roomsList = publicRooms();
  for (const ws of lobby) {
    if (ws.readyState === 1) send(ws, { type: "rooms", rooms: roomsList });
  }
}

function broadcastTerminal(room) {
  if (!room || !room.state.winner || room._terminalBroadcasted) return;
  room._terminalBroadcasted = true;
  persist.recordMatch(room);
  room.broadcast({
    type: "gameover",
    winner: room.state.winner,
    reason: room.state.reason,
    eliminatedPlayer: room.state.eliminatedPlayer
  });
}

function publishRoom(room) {
  if (!room) return;
  room.emitState();
  broadcastTerminal(room);
  broadcastLobby();
}

function leaveRoom(ws, intent) {
  const meta = sockets.get(ws);
  if (!meta || !meta.roomId) return;
  const room = rooms.get(meta.roomId);
  meta.roomId = null;
  enterLobby(ws);
  if (!room) return;

  const result =
    intent === "leave"
      ? room.leavePlayer(ws)
      : room.disconnectPlayer(ws);
  if (room.isEmpty()) {
    rooms.delete(room.id);
  } else {
    publishRoom(room);
  }
  broadcastLobby();
  return result;
}

function bindRoom(ws, room, added) {
  const meta = sockets.get(ws) || {};
  meta.roomId = room.id;
  meta.name = added.name;
  sockets.set(ws, meta);
  leaveLobby(ws);
  const payload = room.payload();
  send(ws, {
    type: "joined",
    roomId: room.id,
    you: added.seat,
    role: added.role || added.seat,
    name: added.name,
    resumeToken: added.resumeToken,
    players: payload.players,
    status: room.status,
    mode: room.mode,
    roomName: room.name,
    chat: room.chatLog
  });
  room.emitState();
  broadcastLobby();
}

function joinRoom(ws, room, name) {
  leaveRoom(ws, "leave");
  const added = room.addPlayer(ws, name);
  if (!added.ok) {
    enterLobby(ws);
    return added;
  }
  bindRoom(ws, room, added);
  return added;
}

function watchRoom(ws, room, name) {
  leaveRoom(ws, "leave");
  const added = room.addSpectator(ws, name);
  if (!added.ok) {
    enterLobby(ws);
    return added;
  }
  bindRoom(ws, room, added);
  return added;
}

wss.on("connection", (ws) => {
  sockets.set(ws, {
    roomId: null,
    name: "Khách",
    last: 0,
    chatAt: 0
  });
  enterLobby(ws);
  send(ws, {
    type: "hello",
    rooms: publicRooms(),
    leaderboard: persist.leaderboard()
  });

  ws.on("message", (raw) => {
    const meta = sockets.get(ws);
    const now = Date.now();
    if (now - (meta.last || 0) < 40) {
      send(ws, { type: "error", message: "Gửi quá nhanh" });
      return;
    }
    meta.last = now;

    let message;
    try {
      message = JSON.parse(String(raw));
    } catch (error) {
      send(ws, { type: "error", message: "Gói tin không đọc được" });
      return;
    }
    if (!message || typeof message !== "object" || typeof message.type !== "string") {
      send(ws, { type: "error", message: "Gói tin không hợp lệ" });
      return;
    }

    if (message.type === "ping") {
      send(ws, { type: "pong" });
      return;
    }
    if (message.type === "list") {
      send(ws, { type: "rooms", rooms: publicRooms() });
      return;
    }

    if (message.type === "create") {
      if (rooms.size >= config.MAX_ROOMS) {
        send(ws, { type: "error", message: "Máy chủ đang đầy phòng" });
        return;
      }
      let room;
      room = new Room(uniqueRoomId(), {
        mode: message.mode === "arena" ? "arena" : "duel",
        name: sanitizeText(message.roomName, config.ROOM_NAME_MAX),
        onUpdate: () => publishRoom(room)
      });
      rooms.set(room.id, room);
      const added = joinRoom(ws, room, sanitizeName(message.name));
      if (!added.ok) send(ws, { type: "error", message: added.error });
      return;
    }

    if (message.type === "join") {
      const id = String(message.roomId || "")
        .trim()
        .toUpperCase();
      const room = rooms.get(id);
      if (!room) {
        send(ws, { type: "error", message: "Không tìm thấy phòng " + id });
        return;
      }
      const added = joinRoom(ws, room, sanitizeName(message.name));
      if (!added.ok) send(ws, { type: "error", message: added.error });
      return;
    }

    if (message.type === "watch") {
      const id = String(message.roomId || "")
        .trim()
        .toUpperCase();
      const room = rooms.get(id);
      if (!room) {
        send(ws, { type: "error", message: "Không tìm thấy phòng " + id });
        return;
      }
      const added = watchRoom(ws, room, sanitizeName(message.name));
      if (!added.ok) send(ws, { type: "error", message: added.error });
      return;
    }

    if (message.type === "resume") {
      const id = String(message.roomId || "")
        .trim()
        .toUpperCase();
      const room = rooms.get(id);
      if (!room) {
        send(ws, { type: "error", message: "Không tìm thấy phòng " + id });
        return;
      }
      const resumed = room.resumePlayer(ws, String(message.resumeToken || ""));
      if (!resumed.ok) {
        send(ws, { type: "error", message: resumed.error });
        return;
      }
      const nextMeta = sockets.get(ws) || {};
      nextMeta.roomId = room.id;
      nextMeta.name = resumed.name;
      sockets.set(ws, nextMeta);
      leaveLobby(ws);
      send(ws, {
        type: "joined",
        roomId: room.id,
        you: resumed.seat,
        role: resumed.seat,
        name: resumed.name,
        resumeToken: room.players[resumed.seat].resumeToken,
        players: room.payload().players,
        status: room.status,
        mode: room.mode,
        roomName: room.name,
        chat: room.chatLog,
        resumed: true
      });
      publishRoom(room);
      return;
    }

    if (message.type === "leave") {
      leaveRoom(ws, "leave");
      send(ws, { type: "left" });
      return;
    }

    if (message.type === "chat") {
      const room = rooms.get(meta.roomId);
      if (!room) {
        send(ws, { type: "error", message: "Bạn chưa vào phòng" });
        return;
      }
      const gap = room.spectatorOf(ws) ? 120 : 40;
      if (now - (meta.chatAt || 0) < gap) {
        send(ws, { type: "error", message: "Gửi quá nhanh" });
        return;
      }
      meta.chatAt = now;
      const result = room.handleChat(ws, message.text);
      if (!result.ok) {
        send(ws, { type: "error", message: result.error });
        return;
      }
      room.broadcast({ type: "chat", message: result.message });
      return;
    }

    if (message.type === "react") {
      const room = rooms.get(meta.roomId);
      if (!room) {
        send(ws, { type: "error", message: "Bạn chưa vào phòng" });
        return;
      }
      const result = room.handleReact(ws, String(message.code || ""));
      if (!result.ok) {
        send(ws, { type: "error", message: result.error });
        return;
      }
      room.broadcast({ type: "react", react: result.react });
      return;
    }

    if (message.type === "move") {
      const room = rooms.get(meta.roomId);
      if (!room) {
        send(ws, { type: "error", message: "Bạn chưa vào phòng" });
        return;
      }
      const { from, to } = message;
      if (
        !from ||
        !to ||
        !Number.isInteger(from.x) ||
        !Number.isInteger(from.y) ||
        !Number.isInteger(to.x) ||
        !Number.isInteger(to.y)
      ) {
        send(ws, { type: "error", message: "Tọa độ không hợp lệ" });
        return;
      }
      const result = room.handleMove(ws, from, to);
      if (!result.ok) {
        if (room.state.winner) publishRoom(room);
        send(ws, { type: "error", message: result.error });
        return;
      }
      publishRoom(room);
      return;
    }

    send(ws, { type: "error", message: "Lệnh không hỗ trợ" });
  });

  ws.on("close", () => {
    leaveRoom(ws, "disconnect");
    leaveLobby(ws);
    sockets.delete(ws);
  });
});

server.listen(config.PORT, config.HOST, () => {
  console.log("OTTv2 chạy tại http://localhost:" + config.PORT);
});
