/**
 * Hashing and random tokens with WebCrypto only, so the same code runs in Workers and in Node tests.
 */

const encoder = new TextEncoder();
const PBKDF2_ITERATIONS = 100_000; // the Workers runtime caps PBKDF2 at 100 000 iterations

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text) {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32) {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** SHA-256 of a string (as UTF-8) or of raw bytes, as lower-case hex. */
export async function sha256Hex(value) {
  return toHex(await crypto.subtle.digest("SHA-256", typeof value === "string" ? encoder.encode(value) : value));
}

/** HMAC-SHA256 with a server-side pepper, for short secrets (OTP codes) that a leaked table must not reveal. */
export async function hmacHex(key, value) {
  const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value)));
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

/** @returns {Promise<string>} "pbkdf2-sha256$<iterations>$<salt>$<hash>" */
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, iterations, salt, expected] = String(stored).split("$");
  if (scheme !== "pbkdf2-sha256" || !iterations || !salt || !expected) return false;
  const actual = await pbkdf2(password, fromBase64Url(salt), Number(iterations));
  const wanted = fromBase64Url(expected);
  if (actual.length !== wanted.length) return false;
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual[i] ^ wanted[i];
  return difference === 0;
}

/** Same-length constant-time comparison of two hex digests. */
export function sameDigest(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
