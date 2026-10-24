/**
 * Who is calling the admin API (plan §4.2): an organiser behind Cloudflare Access, whose email the Access JWT carries, or
 * (fallback, ADMIN_AUTH_MODE=password) one who signed in with password + TOTP. Either way the email must be an enabled row
 * of `admins`: Access alone is not enough (two layers).
 */

const encoder = new TextEncoder();

function base64UrlDecode(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

export class AuthError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * Verifies a Cloudflare Access JWT (RS256) against the team's published keys.
 * @param {string} token value of the Cf-Access-Jwt-Assertion header
 * @param {{ teamDomain: string, aud: string, now: () => number, fetchImpl?: typeof fetch, cache?: Map }} options
 * @returns {Promise<string>} the verified email, lower-cased
 */
export async function verifyAccessJwt(token, { teamDomain, aud, now, fetchImpl = fetch, cache = new Map() }) {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) throw new AuthError("access_jwt_missing");
  let header;
  let payload;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
  } catch {
    throw new AuthError("access_jwt_invalid");
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new AuthError("access_jwt_invalid");

  const issuer = teamDomain.replace(/\/$/, "");
  let keys = cache.get("keys");
  if (!keys || cache.get("expires") < now() || !keys.some((key) => key.kid === header.kid)) {
    const response = await fetchImpl(`${issuer}/cdn-cgi/access/certs`);
    if (!response.ok) throw new AuthError("access_certs_unavailable");
    keys = (await response.json()).keys ?? [];
    cache.set("keys", keys);
    cache.set("expires", now() + 10 * 60 * 1000);
  }
  const jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) throw new AuthError("access_jwt_invalid");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlDecode(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new AuthError("access_jwt_invalid");

  const seconds = now() / 1000;
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(aud) || payload.iss !== issuer) throw new AuthError("access_jwt_invalid");
  if (typeof payload.exp !== "number" || payload.exp < seconds || (typeof payload.nbf === "number" && payload.nbf > seconds + 60)) {
    throw new AuthError("access_jwt_expired");
  }
  if (typeof payload.email !== "string" || !payload.email.includes("@")) throw new AuthError("access_jwt_invalid");
  return payload.email.toLowerCase();
}

// ---------- TOTP (RFC 6238: HMAC-SHA1, 6 digits, 30 s) ----------

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, "");
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export async function totpCode(secret, timeMs, stepMs = 30_000) {
  const counter = Math.floor(timeMs / stepMs);
  const message = new Uint8Array(8);
  new DataView(message.buffer).setUint32(4, counter >>> 0);
  new DataView(message.buffer).setUint32(0, Math.floor(counter / 2 ** 32));
  const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 1_000_000).padStart(6, "0");
}

/** Accepts the current code and the ones just before and after it (clock drift). */
export async function verifyTotp(secret, code, timeMs) {
  if (!/^\d{6}$/.test(String(code ?? ""))) return false;
  for (const drift of [-1, 0, 1]) {
    if ((await totpCode(secret, timeMs + drift * 30_000)) === code) return true;
  }
  return false;
}
