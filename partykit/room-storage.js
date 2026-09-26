const { Room } = require("../room");
const config = require("../config");

const SCHEMA_VERSION = 1;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function serializeRoom(room) {
  if (!room || typeof room.id !== "string" || !room.state || !room.players) {
    throw new TypeError("Invalid room");
  }
  const saved = {
    schemaVersion: SCHEMA_VERSION,
    id: room.id,
    status: room.status,
    createdAt: room.createdAt,
    clockAnchorMs: room.clockAnchorMs,
    state: clone(room.state),
    lastEvents: clone(room.lastEvents || []),
    terminalBroadcasted: Boolean(room._terminalBroadcasted),
    revision: room.revision,
    nextEventId: room.nextEventId,
    players: { A: playerData(room.players.A), B: playerData(room.players.B) }
  };
  validatePersistedRoom(saved);
  return saved;
}

function playerData(player) {
  if (!player) return null;
  return {
    name: player.name,
    seat: player.seat,
    connected: Boolean(player.connected),
    resumeToken: player.resumeToken,
    reconnectDeadlineMs: player.reconnectDeadlineMs
  };
}

function hydrateRoom(saved, id, deps = {}) {
  if (!saved || saved.schemaVersion !== SCHEMA_VERSION) throw new Error("Unsupported schemaVersion");
  validatePersistedRoom(saved);
  if (saved.id !== id) throw new Error("Invalid persisted room");
  const room = new Room(id, deps);
  room.status = saved.status;
  room.createdAt = saved.createdAt;
  room.clockAnchorMs = saved.clockAnchorMs;
  room.state = clone(saved.state);
  room.lastEvents = clone(saved.lastEvents || []);
  room._terminalBroadcasted = Boolean(saved.terminalBroadcasted);
  room.revision = saved.revision;
  room.nextEventId = saved.nextEventId;
  for (const seat of ["A", "B"]) {
    const player = saved.players[seat];
    room.players[seat] = player ? { ...player, connected: false, connection: null } : null;
  }
  return room;
}

function validatePersistedRoom(saved) {
  if (!saved || typeof saved !== "object" || saved.schemaVersion !== SCHEMA_VERSION) invalid();
  if (typeof saved.id !== "string" || !["waiting", "playing", "done"].includes(saved.status)) invalid();
  if (!finiteNonNegative(saved.createdAt) || !finiteNonNegative(saved.clockAnchorMs)) invalid();
  if (!Number.isInteger(saved.revision) || saved.revision < 0) invalid();
  if (!Number.isInteger(saved.nextEventId) || saved.nextEventId < 1) invalid();
  if (typeof saved.terminalBroadcasted !== "boolean") invalid();
  validateState(saved.state, saved.status, saved.players);
  if (!Array.isArray(saved.lastEvents)) invalid();
  let previousEventId = 0;
  for (const event of saved.lastEvents) {
    if (!event || typeof event !== "object" || !Number.isInteger(event.id) || event.id <= previousEventId || event.id >= saved.nextEventId) invalid();
    previousEventId = event.id;
  }
  if (!saved.players || typeof saved.players !== "object" || Array.isArray(saved.players)) invalid();
  for (const seat of ["A", "B"]) validatePlayer(saved.players[seat], seat);
}

function validateState(state, status, players) {
  if (!state || typeof state !== "object" || !["A", "B"].includes(state.turn)) invalid();
  if (!(state.winner === null || state.winner === "A" || state.winner === "B")) invalid();
  const reasons = [null, "goal", "elimination", "no_moves", "timeout", "leave", "disconnect_timeout"];
  if (!reasons.includes(state.reason)) invalid();
  if (!(state.eliminatedPlayer === null || state.eliminatedPlayer === "A" || state.eliminatedPlayer === "B")) invalid();
  if (!state.clock || typeof state.clock !== "object" || !state.clock.remainingMs || typeof state.clock.remainingMs !== "object") invalid();
  for (const seat of ["A", "B"]) {
    if (!finiteNonNegative(state.clock.remainingMs[seat]) || state.clock.remainingMs[seat] > config.TIME_CONTROL.initialMs) invalid();
  }
  if (!(state.clock.runningSeat === null || state.clock.runningSeat === "A" || state.clock.runningSeat === "B")) invalid();
  if (!Array.isArray(state.pieces)) invalid();
  const ids = new Set();
  const occupied = new Set();
  for (const piece of state.pieces) {
    if (!piece || typeof piece !== "object" || typeof piece.id !== "string" || !piece.id || ids.has(piece.id)) invalid();
    if (!["A", "B"].includes(piece.player) || !config.TYPES.includes(piece.type) || !boardCoordinate(piece.x) || !boardCoordinate(piece.y)) invalid();
    const position = `${piece.x},${piece.y}`;
    if (occupied.has(position)) invalid();
    ids.add(piece.id);
    occupied.add(position);
  }
  if (status === "done" && (!state.reason || state.clock.runningSeat !== null)) invalid();
  if (status === "done" && state.winner === null && !(state.reason === "disconnect_timeout" && players.A && !players.B)) invalid();
  if (status !== "done" && (state.winner !== null || state.reason !== null)) invalid();
}

function validatePlayer(player, seat) {
  if (player === null) return;
  if (!player || typeof player !== "object" || player.seat !== seat || typeof player.name !== "string" || typeof player.resumeToken !== "string" || !player.resumeToken || typeof player.connected !== "boolean") invalid();
  if (!(player.reconnectDeadlineMs === null || finiteNonNegative(player.reconnectDeadlineMs))) invalid();
}

function boardCoordinate(value) {
  return Number.isInteger(value) && value >= 0 && value < config.SIZE;
}

function finiteNonNegative(value) {
  return Number.isInteger(value) && value >= 0;
}

function invalid() {
  throw new Error("Invalid persisted room");
}

module.exports = { SCHEMA_VERSION, serializeRoom, hydrateRoom };
