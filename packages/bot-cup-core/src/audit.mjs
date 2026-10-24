/**
 * Hash-chained audit log (plan §8.8): each admin action is a row whose hash covers the previous row's hash, so editing or
 * removing any row breaks every hash after it. Hashing uses WebCrypto (Workers and Node).
 */

export const AUDIT_GENESIS = "0".repeat(64);

/** Actions that need a second admin's approval before they run (plan §8.8). */
export const FOUR_EYES_ACTIONS = Object.freeze(["team.disqualify", "match.set_result", "flag.confirm"]);

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The exact text that is hashed for a row: fixed field order, JSON-escaped values. */
export function auditCanonical(row) {
  return JSON.stringify([row.prev_hash, row.at, row.actor_email, row.action, row.target ?? null, row.reason ?? null, row.payload_json ?? "{}"]);
}

export async function auditHash(row) {
  return sha256Hex(auditCanonical(row));
}

/**
 * Checks a run of rows in `seq` order, starting from the genesis or from `previousHash`.
 * @returns {Promise<{ ok: true, rows: number, head: string } | { ok: false, seq: number, error: "audit_prev_mismatch"|"audit_hash_mismatch" }>}
 */
export async function verifyAuditChain(rows, previousHash = AUDIT_GENESIS) {
  let prev = previousHash;
  for (const row of rows) {
    if (row.prev_hash !== prev) return { ok: false, seq: row.seq, error: "audit_prev_mismatch" };
    if ((await auditHash(row)) !== row.hash) return { ok: false, seq: row.seq, error: "audit_hash_mismatch" };
    prev = row.hash;
  }
  return { ok: true, rows: rows.length, head: prev };
}

/** One CSV field: quoted when needed; a leading =, +, - or @ is defused so spreadsheets do not run it as a formula. */
export function csvField(value) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header, rows) {
  return [header, ...rows].map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}
