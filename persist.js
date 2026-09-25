const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "data", "store.json");

function emptyStore() {
  return { users: {}, matches: [] };
}

function load() {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return emptyStore();
    if (!parsed.users) parsed.users = {};
    if (!Array.isArray(parsed.matches)) parsed.matches = [];
    return parsed;
  } catch (err) {
    return emptyStore();
  }
}

function save(store) {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(store), "utf8");
}

function keyFor(name) {
  return String(name || "Khách").trim().toLowerCase() || "khách";
}

function ensureUser(store, name) {
  const key = keyFor(name);
  if (!store.users[key]) {
    store.users[key] = { id: key, username: name || "Khách", wins: 0, losses: 0 };
  }
  return store.users[key];
}

function recordMatch(room) {
  if (!room || !room.state || !room.state.winner) return;
  const store = load();
  const winner = room.state.winner;
  const names = {};
  for (const seat of room.seats) {
    const slot = room.players[seat];
    const name =
      (room.playerNames && room.playerNames[seat]) ||
      (slot && slot.name) ||
      seat;
    names[seat] = name;
    const user = ensureUser(store, name);
    if (seat === winner) user.wins += 1;
    else user.losses += 1;
  }
  store.matches.unshift({
    id: room.id + "-" + Date.now(),
    roomId: room.id,
    mode: room.mode,
    players: names,
    winner,
    reason: room.state.reason,
    moves: (room.history || []).length,
    timestamp: Date.now()
  });
  if (store.matches.length > 200) store.matches.length = 200;
  save(store);
}

function leaderboard(limit) {
  const store = load();
  const n = limit || 10;
  return Object.values(store.users)
    .sort((a, b) => b.wins - a.wins || a.losses - b.losses)
    .slice(0, n)
    .map((u, i) => ({
      rank: i + 1,
      username: u.username,
      wins: u.wins,
      losses: u.losses,
      badge:
        u.wins >= 100 ? "100 Wins" : u.wins >= 10 ? "Master Strategist" : u.wins >= 1 ? "First Blood" : null
    }));
}

module.exports = { recordMatch, leaderboard, load };
