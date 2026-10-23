/**
 * Time limits and counters for registration and login (plan §5.2, §5.3). Pure: callers pass `now` in ms.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const OTP_POLICY = Object.freeze({ digits: 6, ttlMs: 10 * MINUTE, maxAttempts: 5, maxSendsPerHour: 3 });
export const INVITE_TTL_MS = 72 * HOUR;
export const INVITE_MAX_SENDS_PER_HOUR = 3;
/** A team whose captain never enters the OTP stops holding its handle, name and MSSV after this long. */
export const PENDING_CAPTAIN_TTL_MS = DAY;
export const SESSION_TTL_MS = 14 * DAY;
export const LOGIN_POLICY = Object.freeze({ maxFailures: 10, lockMs: 15 * MINUTE });

/**
 * Uniform 6-digit code from a CSPRNG (rejection sampling keeps every code equally likely).
 * @param {(array: Uint32Array) => Uint32Array} getRandomValues
 */
export function generateOtp(getRandomValues) {
  const space = 10 ** OTP_POLICY.digits;
  const limit = Math.floor(0x1_0000_0000 / space) * space;
  const buffer = new Uint32Array(1);
  for (;;) {
    getRandomValues(buffer);
    if (buffer[0] < limit) return String(buffer[0] % space).padStart(OTP_POLICY.digits, "0");
  }
}

/**
 * Decides an OTP attempt before and after comparing the code.
 * @param {{ expiresAt: number, attempts: number, consumedAt: number|null } | null} record
 * @param {number} now
 * @param {boolean} codeMatches
 * @returns {{ result: "ok"|"otp_invalid"|"otp_expired"|"otp_locked", attempts: number }}
 *          `attempts` is the value to store back (unchanged unless this attempt counted).
 */
export function evaluateOtpAttempt(record, now, codeMatches) {
  if (!record || record.consumedAt) return { result: "otp_invalid", attempts: record?.attempts ?? 0 };
  if (record.attempts >= OTP_POLICY.maxAttempts) return { result: "otp_locked", attempts: record.attempts };
  if (now >= record.expiresAt) return { result: "otp_expired", attempts: record.attempts };
  if (codeMatches) return { result: "ok", attempts: record.attempts };
  const attempts = record.attempts + 1;
  return { result: attempts >= OTP_POLICY.maxAttempts ? "otp_locked" : "otp_invalid", attempts };
}

/** @param {{ failedLogins: number, lockedUntil: number|null }} state */
export function loginLocked(state, now) {
  return typeof state.lockedUntil === "number" && now < state.lockedUntil;
}

/** State to store after a failed login. */
export function afterFailedLogin(state, now) {
  const failedLogins = state.failedLogins + 1;
  if (failedLogins >= LOGIN_POLICY.maxFailures) return { failedLogins: 0, lockedUntil: now + LOGIN_POLICY.lockMs };
  return { failedLogins, lockedUntil: null };
}

/**
 * Registration window of an event (plan §5.1): open from `registrationOpensAt` until `registrationClosesAt` (exclusive).
 * Membership changes and invite acceptance follow the same window.
 */
export function registrationOpen(event, now) {
  return now >= event.registrationOpensAt && now < event.registrationClosesAt;
}
