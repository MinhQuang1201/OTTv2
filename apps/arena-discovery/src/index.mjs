const PATH = "/api/arena-discovery/v1/config";
const STORAGE_KEY = "config";
const PUBLIC_ORIGIN = "https://ottv2-arena-demo-20261016.vercel.app";
const LOOPBACK_ORIGINS = new Set(["http://127.0.0.1:3000", "http://localhost:3000"]);
const ENDPOINT_PATTERN = /^https:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.trycloudflare\.com\/api\/arena\/v1$/i;
const MAX_BODY_BYTES = 2048;

function allowedOrigin(origin) {
  return origin === PUBLIC_ORIGIN || LOOPBACK_ORIGINS.has(origin);
}

function constantTimeEqual(left, right) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  }
  return difference === 0;
}

function corsHeaders(origin) {
  const headers = new Headers({ Vary: "Origin" });
  if (allowedOrigin(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  }
  return headers;
}

function jsonResponse(status, body, origin) {
  const headers = corsHeaders(origin);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

function emptyResponse(status, origin) {
  const headers = corsHeaders(origin);
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status, headers });
}

function validateEndpoint(value) {
  if (typeof value !== "string" || !ENDPOINT_PATTERN.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.port === "" && parsed.username === "" && parsed.password === "" && parsed.search === "" && parsed.hash === "" && parsed.pathname === "/api/arena/v1";
  } catch {
    return false;
  }
}

async function parseJson(request) {
  try {
    const declaredLength = request.headers.get("Content-Length");
    if (declaredLength && Number(declaredLength) > MAX_BODY_BYTES) return { tooLarge: true };
    if (!request.body) return null;
    const reader = request.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        totalBytes += result.value.byteLength;
        if (totalBytes > MAX_BODY_BYTES) {
          await reader.cancel("payload_too_large");
          return { tooLarge: true };
        }
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const raw = new TextDecoder().decode(bytes);
    const body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, "arenaApiEndpoint")) return null;
    return body;
  } catch {
    return null;
  }
}

export class ArenaDiscoveryConfig {
  constructor(state, env) {
    this.storage = state.storage;
    this.writeToken = env?.ARENA_DISCOVERY_WRITE_TOKEN;
  }

  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    if (!allowedOrigin(origin) && origin !== "") return jsonResponse(403, { error: "CORS_FORBIDDEN" }, origin);
    if (request.method === "OPTIONS") return allowedOrigin(origin) ? emptyResponse(204, origin) : jsonResponse(403, { error: "CORS_FORBIDDEN" }, origin);
    if (request.method === "GET") {
      const value = (await this.storage.get(STORAGE_KEY)) || { arenaApiEndpoint: null, updatedAt: null };
      return jsonResponse(200, value, origin);
    }
    if (request.method !== "PUT") return jsonResponse(405, { error: "METHOD_NOT_ALLOWED" }, origin);

    const authorization = request.headers.get("Authorization") || "";
    if (!this.writeToken) return jsonResponse(503, { error: "WRITE_AUTH_UNAVAILABLE" }, origin);
    const suppliedToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!constantTimeEqual(suppliedToken, this.writeToken)) return jsonResponse(401, { error: "UNAUTHORIZED" }, origin);

    const body = await parseJson(request);
    if (body?.tooLarge) return jsonResponse(413, { error: "PAYLOAD_TOO_LARGE" }, origin);
    if (!body) return jsonResponse(400, { error: "INVALID_PAYLOAD" }, origin);
    if (!validateEndpoint(body.arenaApiEndpoint)) return jsonResponse(422, { error: "INVALID_ARENA_ENDPOINT" }, origin);
    const value = { arenaApiEndpoint: body.arenaApiEndpoint, updatedAt: new Date().toISOString() };
    await this.storage.put(STORAGE_KEY, value);
    return jsonResponse(200, value, origin);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== PATH) return new Response("Not found", { status: 404 });
    if (request.method === "OPTIONS") {
      const origin = request.headers.get("Origin") || "";
      return allowedOrigin(origin) ? emptyResponse(204, origin) : jsonResponse(403, { error: "CORS_FORBIDDEN" }, origin);
    }
    const namespace = env.ARENA_DISCOVERY;
    if (!namespace) return jsonResponse(503, { error: "STORAGE_UNAVAILABLE" }, request.headers.get("Origin") || "");
    const id = namespace.idFromName("config");
    return namespace.get(id).fetch(request);
  },
};
