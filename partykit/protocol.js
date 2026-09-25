const config = require("../config");

const MAX_MESSAGE = config.MAX_MESSAGE;
const RATE_LIMIT_MS = 40;

const ERROR_CODES = Object.freeze({
  MALFORMED_JSON: "malformed_json",
  MESSAGE_TOO_LARGE: "message_too_large",
  INVALID_MESSAGE: "invalid_message",
  MISSING_TYPE: "missing_type",
  UNSUPPORTED_TYPE: "unsupported_type",
  INVALID_PAYLOAD: "invalid_payload",
  INVALID_NAME: "invalid_name",
  INVALID_ROOM_ID: "invalid_room_id",
  INVALID_TOKEN: "invalid_token",
  INVALID_MOVE: "invalid_move"
});

const COMMANDS = new Set([
  "ott:list",
  "ott:create",
  "ott:join",
  "ott:resume",
  "ott:move",
  "ott:leave",
  "ott:ping"
]);

function error(code) {
  return { ok: false, error: { code } };
}

function success(value) {
  return { ok: true, value };
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isValidStateResponse(value) {
  if (!isPlainObject(value) || value.type !== "ott:state") return false;
  if (!validString(value.roomId) || !validString(value.status)) return false;
  if (!Number.isFinite(value.serverNow) || !isPlainObject(value.players) || !isPlainObject(value.state)) return false;
  if (!Number.isInteger(value.revision) || value.revision < 0) return false;
  if (!Array.isArray(value.events)) return false;
  let previousId = 0;
  return value.events.every((event) => {
    if (!isPlainObject(event) || !Number.isInteger(event.id) || event.id <= previousId) return false;
    previousId = event.id;
    return true;
  });
}

function hasOnlyKeys(value, keys) {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function validString(value) {
  return typeof value === "string" && value.length > 0;
}

function normalizeRoomId(value) {
  if (typeof value !== "string") return null;
  const roomId = value.toUpperCase();
  return new RegExp(`^[A-Z0-9]{${config.ROOM_ID_LEN}}$`).test(roomId) ? roomId : null;
}

function validPoint(value) {
  return isPlainObject(value) &&
    hasOnlyKeys(value, ["x", "y"]) &&
    Number.isInteger(value.x) &&
    Number.isInteger(value.y);
}

function parseClientMessage(raw) {
  if (typeof raw !== "string") return error(ERROR_CODES.INVALID_MESSAGE);
  if (Buffer.byteLength(raw, "utf8") > MAX_MESSAGE) return error(ERROR_CODES.MESSAGE_TOO_LARGE);

  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return error(ERROR_CODES.MALFORMED_JSON);
  }

  if (!isPlainObject(message)) return error(ERROR_CODES.INVALID_MESSAGE);
  if (typeof message.type !== "string") return error(ERROR_CODES.MISSING_TYPE);
  if (!COMMANDS.has(message.type)) return error(ERROR_CODES.UNSUPPORTED_TYPE);

  switch (message.type) {
    case "ott:list":
    case "ott:leave":
    case "ott:ping":
      return hasOnlyKeys(message, ["type"])
        ? success({ type: message.type })
        : error(ERROR_CODES.INVALID_PAYLOAD);
    case "ott:create":
      return hasOnlyKeys(message, ["type", "name"])
        ? validString(message.name)
          ? success({ type: message.type, name: message.name })
          : error(ERROR_CODES.INVALID_NAME)
        : error(ERROR_CODES.INVALID_PAYLOAD);
    case "ott:join": {
      if (!hasOnlyKeys(message, ["type", "roomId", "name"])) return error(ERROR_CODES.INVALID_PAYLOAD);
      const roomId = normalizeRoomId(message.roomId);
      if (!roomId) return error(ERROR_CODES.INVALID_ROOM_ID);
      if (!validString(message.name)) return error(ERROR_CODES.INVALID_NAME);
      return success({ type: message.type, roomId, name: message.name });
    }
    case "ott:resume": {
      if (!hasOnlyKeys(message, ["type", "roomId", "resumeToken"])) return error(ERROR_CODES.INVALID_PAYLOAD);
      const roomId = normalizeRoomId(message.roomId);
      if (!roomId) return error(ERROR_CODES.INVALID_ROOM_ID);
      if (!validString(message.resumeToken)) return error(ERROR_CODES.INVALID_TOKEN);
      return success({ type: message.type, roomId, resumeToken: message.resumeToken });
    }
    case "ott:move":
      return hasOnlyKeys(message, ["type", "from", "to"]) && validPoint(message.from) && validPoint(message.to)
        ? success({ type: message.type, from: { x: message.from.x, y: message.from.y }, to: { x: message.to.x, y: message.to.y } })
        : error(ERROR_CODES.INVALID_MOVE);
    default:
      return error(ERROR_CODES.UNSUPPORTED_TYPE);
  }
}

function createRateLimiter(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const lastSeen = new Map();

  return {
    check(connection) {
      const current = now();
      const previous = lastSeen.get(connection);
      if (previous !== undefined && current - previous < RATE_LIMIT_MS) {
        return { allowed: false, code: "rate_limited" };
      }
      lastSeen.set(connection, current);
      return { allowed: true };
    }
  };
}

module.exports = {
  ERROR_CODES,
  MAX_MESSAGE,
  RATE_LIMIT_MS,
  parseClientMessage,
  isValidStateResponse,
  createRateLimiter
};
