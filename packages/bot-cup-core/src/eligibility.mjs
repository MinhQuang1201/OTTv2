/**
 * Who may register for a Bot Cup event (plan §0, §5.1).
 *
 * production: K71 only — an 8-digit MSSV starting with "26" and the school address MSSV@vnu.edu.vn.
 * demo:       any 8-digit MSSV from any cohort; the school address is the default but another address may be used.
 * Both modes verify the address by OTP; this module only decides whether the pair is acceptable.
 */

export const EVENT_MODES = Object.freeze(["demo", "production"]);

const MSSV_PATTERN = /^\d{8}$/;
const EMAIL_PATTERN = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

const MODE_RULES = Object.freeze({
  production: Object.freeze({ mssvPrefix: "26", emailDomain: "vnu.edu.vn", allowExternalEmail: false }),
  demo: Object.freeze({ mssvPrefix: null, emailDomain: "vnu.edu.vn", allowExternalEmail: true })
});

/**
 * Eligibility rules for a mode. `overrides` comes from events.config_json.eligibility and may only set the known keys.
 * @param {"demo"|"production"} mode
 * @param {{ mssvPrefix?: string|null, emailDomain?: string, allowExternalEmail?: boolean }} [overrides]
 */
export function eligibilityRules(mode, overrides = {}) {
  if (!EVENT_MODES.includes(mode)) throw new Error(`Unknown event mode: ${mode}`);
  const rules = { mode, mssvDigits: 8, ...MODE_RULES[mode] };
  if (overrides.mssvPrefix === null || (typeof overrides.mssvPrefix === "string" && /^\d{0,8}$/.test(overrides.mssvPrefix))) {
    rules.mssvPrefix = overrides.mssvPrefix || null;
  }
  if (typeof overrides.emailDomain === "string" && overrides.emailDomain) rules.emailDomain = overrides.emailDomain.toLowerCase();
  if (typeof overrides.allowExternalEmail === "boolean") rules.allowExternalEmail = overrides.allowExternalEmail;
  return Object.freeze(rules);
}

/** @returns {string|null} the MSSV as 8 digits, or null. */
export function normalizeMssv(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return MSSV_PATTERN.test(text) ? text : null;
}

export function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return EMAIL_PATTERN.test(email) && email.length <= 254 ? email : null;
}

export function schoolEmail(mssv, rules) {
  return `${mssv}@${rules.emailDomain}`;
}

/**
 * Checks one student against the event rules.
 * @param {{ mssv: unknown, email?: unknown }} student
 * @returns {{ ok: true, mssv: string, email: string } | { ok: false, error: string, field: "mssv"|"email" }}
 */
export function checkStudent(student, rules) {
  const mssv = normalizeMssv(student?.mssv);
  if (!mssv) return { ok: false, error: "mssv_invalid", field: "mssv" };
  if (rules.mssvPrefix && !mssv.startsWith(rules.mssvPrefix)) return { ok: false, error: "mssv_not_eligible", field: "mssv" };

  const school = schoolEmail(mssv, rules);
  const given = student?.email;
  if (given === undefined || given === null || (typeof given === "string" && given.trim() === "")) {
    return { ok: true, mssv, email: school };
  }
  const email = normalizeEmail(given);
  if (!email) return { ok: false, error: "email_invalid", field: "email" };
  if (email !== school && !rules.allowExternalEmail) return { ok: false, error: "email_not_allowed", field: "email" };
  return { ok: true, mssv, email };
}

/** "26020123@vnu.edu.vn" -> "26****23@vnu.edu.vn"; enough for the owner to recognise, useless to anyone else. */
export function maskEmail(email) {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const masked = local.length <= 4 ? `${local[0]}***` : `${local.slice(0, 2)}${"*".repeat(local.length - 4)}${local.slice(-2)}`;
  return masked + email.slice(at);
}
