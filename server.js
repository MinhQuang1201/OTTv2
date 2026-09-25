const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const config = require("./config");
const { Room, sanitizeName } = require("./room");

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
  "package.json",
  "package-lock.json",
  ".gitignore"
]);

const rooms = new Map();
const sockets = new WeakMap();

function publicPath(urlPath) {
  const clean = decodeURIComponent((urlPath || "/").split("?")[0]);
  const rel = clean === "/" ? "index.html" : clean.replace(/^\/+/, "");
  const resolved = path.resolve(ROOT, rel);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) return null;
  const base = path.basename(resolved);
  if (DENY.has(base)) return null;
  if (rel.startsWith("node_modules") || rel.startsWith("tests") || rel.startsWith(".")) {
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
      "Cache-Control": ext === ".html" || ext === ".js" ? "no-store" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff"
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Chỉ nhận GET");
    return;
  }
  const filePath = publicPath(req.url);
  if (!filePath) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Không cho phép");
    return;
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
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
  for (let i = 0; i < config.ROOM_ID_LEN; i += 1) {
    id += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return id;
}

function uniqueRoomId() {
  for (let i = 0; i < 50; i += 1) {
    const id = roomCode();
    if (!rooms.has(id)) return id;
  }
  return roomCode() + Date.now().toString(36).slice(-2).toUpperCase();
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function waitingList() {
  const list = [];
  for (const room of rooms.values()) {
    if (room.status === "waiting") list.push(room.waitingInfo());
  }
  return list;
}

function broadcastLobby() {
  const roomsList = waitingList();
  for (const ws of wss.clients) {
    if (ws.readyState === 1) send(ws, { type: "rooms", rooms: roomsList });
  }
}

function broadcastTerminal(room) {
  if (!room || !room.state.winner || room._terminalBroadcasted) return;
  room._terminalBroadcasted = true;
  room.broadcast({
    type: "gameover",
    winner: room.state.winner,
    reason: room.state.reason,
    eliminatedPlayer: room.state.eliminatedPlayer
  });
}

function publishRoom(room) {
  room.emitState();
  broadcastTerminal(room);
}

function leaveRoom(ws, intent) {
  const meta = sockets.get(ws);
  if (!meta || !meta.roomId) return;
  const room = rooms.get(meta.roomId);
  meta.roomId = null;
  if (!room) return;
  const result = intent === "leave" ? room.leavePlayer(ws) : room.disconnectPlayer(ws);
  if (room.isEmpty()) rooms.delete(room.id);
  else if (result && room.status !== "done") room.emitState();
  else publishRoom(room);
  broadcastLobby();
}

function joinRoom(ws, room, name) {
  leaveRoom(ws, "leave");
  const added = room.addPlayer(ws, name);
  if (!added.ok) return added;
  const meta = sockets.get(ws) || {};
  meta.roomId = room.id;
  meta.name = added.name;
  sockets.set(ws, meta);
  send(ws, {
    type: "joined",
    roomId: room.id,
    you: added.seat,
    name: added.name,
    resumeToken: added.resumeToken,
    players: room.payload().players,
    status: room.status
  });
  room.emitState();
  broadcastLobby();
  return added;
}

wss.on("connection", (ws) => {
  sockets.set(ws, { roomId: null, name: "Khách", last: 0 });
  send(ws, { type: "hello", rooms: waitingList() });

  ws.on("message", (raw) => {
    const meta = sockets.get(ws);
    const now = Date.now();
    if (now - (meta.last || 0) < 40) {
      send(ws, { type: "error", message: "Gửi quá nhanh" });
      return;
    }
    meta.last = now;

    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch (err) {
      send(ws, { type: "error", message: "Gói tin không đọc được" });
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
      send(ws, { type: "error", message: "Gói tin không hợp lệ" });
      return;
    }

    if (msg.type === "ping") {
      send(ws, { type: "pong" });
      return;
    }

    if (msg.type === "list") {
      send(ws, { type: "rooms", rooms: waitingList() });
      return;
    }

    if (msg.type === "create") {
      if (rooms.size >= config.MAX_ROOMS) {
        send(ws, { type: "error", message: "Máy chủ đang đầy phòng" });
        return;
      }
      const room = new Room(uniqueRoomId());
      room.onUpdate = () => publishRoom(room);
      rooms.set(room.id, room);
      const added = joinRoom(ws, room, sanitizeName(msg.name));
      if (!added.ok) send(ws, { type: "error", message: added.error });
      return;
    }

    if (msg.type === "join") {
      const id = String(msg.roomId || "")
        .trim()
        .toUpperCase();
      const room = rooms.get(id);
      if (!room) {
        send(ws, { type: "error", message: "Không tìm thấy phòng " + id });
        return;
      }
      const added = joinRoom(ws, room, sanitizeName(msg.name));
      if (!added.ok) send(ws, { type: "error", message: added.error });
      return;
    }

    if (msg.type === "resume") {
      const id = String(msg.roomId || "").trim().toUpperCase();
      const room = rooms.get(id);
      if (!room) {
        send(ws, { type: "error", message: "Không tìm thấy phòng " + id });
        return;
      }
      const resumed = room.resumePlayer(ws, String(msg.resumeToken || ""));
      if (!resumed.ok) {
        send(ws, { type: "error", message: resumed.error });
        return;
      }
      const nextMeta = sockets.get(ws) || {};
      nextMeta.roomId = room.id;
      nextMeta.name = resumed.name;
      sockets.set(ws, nextMeta);
      send(ws, {
        type: "joined",
        roomId: room.id,
        you: resumed.seat,
        name: resumed.name,
        resumeToken: room.players[resumed.seat].resumeToken,
        players: room.payload().players,
        status: room.status,
        resumed: true
      });
      publishRoom(room);
      return;
    }

    if (msg.type === "leave") {
      leaveRoom(ws, "leave");
      send(ws, { type: "left" });
      return;
    }

    if (msg.type === "move") {
      const room = rooms.get(meta.roomId);
      if (!room) {
        send(ws, { type: "error", message: "Bạn chưa vào phòng" });
        return;
      }
      const from = msg.from;
      const to = msg.to;
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
    sockets.delete(ws);
  });
});

server.listen(config.PORT, config.HOST, () => {
  console.log("OTTv2 chạy tại http://localhost:" + config.PORT);
});
