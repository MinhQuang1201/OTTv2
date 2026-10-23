/**
 * Small HTTP helpers: JSON bodies and errors, the session cookie, client IP behind the Vercel rewrite.
 */

const MAX_BODY_BYTES = 16 * 1024;
export const SESSION_COOKIE = "__Host-ottcup_session";

export class HttpError extends Error {
  /** @param {number} status @param {string} code @param {Record<string, unknown>} [details] */
  constructor(status, code, details = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}

export function errorResponse(error) {
  return json({ error: error.code, ...error.details }, error.status);
}

export async function readJson(request) {
  const type = request.headers.get("content-type") || "";
  if (!type.toLowerCase().startsWith("application/json")) throw new HttpError(415, "invalid_request");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new HttpError(413, "invalid_request");
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return body;
  } catch {
    throw new HttpError(400, "invalid_request");
  }
}

export function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export function sessionCookie(token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/**
 * The browser's address. Requests arrive through the Vercel rewrite, so cf-connecting-ip is Vercel's egress address
 * and shared by every player; the forwarded header carries the real one. It can be forged by calling the Worker
 * directly, which only lets a caller dodge the per-IP limit — every limit that matters is per email or handle.
 */
export function clientIp(request) {
  const forwarded = request.headers.get("x-real-ip") || request.headers.get("x-forwarded-for")?.split(",")[0];
  return (forwarded || request.headers.get("cf-connecting-ip") || "unknown").trim().slice(0, 64);
}
