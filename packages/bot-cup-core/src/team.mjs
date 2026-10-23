/**
 * Team accounts (plan §5.1, §5.2): one account per team, 1–3 students, a handle to log in with and a display name.
 * Pure: no I/O and no clock; callers pass in what they read from storage.
 */
import names from "../../game-core/src/names.js";

export const TEAM_KINDS = Object.freeze(["solo", "group"]);

export const TEAM_STATUS = Object.freeze({
  PENDING_CAPTAIN: "pending_captain",
  PENDING_MEMBERS: "pending_members",
  ACTIVE: "active"
});

export const MEMBER_STATUS = Object.freeze({ PENDING: "pending", CONFIRMED: "confirmed" });

export const GROUP_SIZE = Object.freeze({ min: 2, max: 3 });
export const DISPLAY_NAME_MAX = 32;
export const FULL_NAME_MAX = 64;
export const PASSWORD_LENGTH = Object.freeze({ min: 10, max: 128 });

const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,22})[a-z0-9]$/;
const RESERVED_HANDLES = new Set(["admin", "btc", "api", "root", "system", "support", "ott", "ottcup", "bot-cup", "null", "undefined"]);

// Whole words, compared on the lower-cased name with its diacritics kept, then on the folded name for the
// ASCII abbreviations. Folding Vietnamese words would flag innocent names ("các bạn" folds to "cac ban").
const BLOCKED_WORDS = ["địt", "đụ", "lồn", "cặc", "buồi", "đéo", "fuck", "shit", "bitch"];
const BLOCKED_ABBREVIATIONS = ["dm", "dcm", "dmm", "vcl", "vkl", "clgt", "cmm", "wtf"];

/** @returns {{ ok: true, handle: string } | { ok: false, error: "handle_invalid"|"handle_reserved" }} */
export function validateHandle(value) {
  if (typeof value !== "string") return { ok: false, error: "handle_invalid" };
  const handle = value.trim().toLowerCase();
  if (!HANDLE_PATTERN.test(handle) || handle.includes("--")) return { ok: false, error: "handle_invalid" };
  if (RESERVED_HANDLES.has(handle)) return { ok: false, error: "handle_reserved" };
  return { ok: true, handle };
}

/** Folds case, Vietnamese diacritics and punctuation, so "Đội Một" and "doi  mot!" collide. */
export function nameKey(value) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function words(text) {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export function isBlockedName(value) {
  const plain = new Set(words(value.normalize("NFC")));
  if (BLOCKED_WORDS.some((word) => plain.has(word))) return true;
  const folded = new Set(nameKey(value).split(" "));
  return BLOCKED_ABBREVIATIONS.some((word) => folded.has(word));
}

/**
 * @returns {{ ok: true, displayName: string, key: string } | { ok: false, error: "display_name_invalid"|"display_name_blocked" }}
 */
export function validateDisplayName(value) {
  const displayName = names.cleanDisplayName(value, DISPLAY_NAME_MAX);
  const key = displayName ? nameKey(displayName) : "";
  if (displayName.length < 3 || key.length < 2) return { ok: false, error: "display_name_invalid" };
  if (isBlockedName(displayName)) return { ok: false, error: "display_name_blocked" };
  return { ok: true, displayName, key };
}

/** @returns {{ ok: true, fullName: string } | { ok: false, error: "full_name_invalid" }} */
export function validateFullName(value) {
  const fullName = names.cleanDisplayName(value, FULL_NAME_MAX);
  if (fullName.length < 2 || !/\p{L}/u.test(fullName)) return { ok: false, error: "full_name_invalid" };
  return { ok: true, fullName };
}

export function validatePassword(value) {
  if (typeof value !== "string" || value.length < PASSWORD_LENGTH.min || value.length > PASSWORD_LENGTH.max) {
    return { ok: false, error: "password_weak" };
  }
  return { ok: true };
}

/**
 * A team's status follows from its members (plan §5.2): the captain must verify by OTP; a solo team is then active;
 * a group is active only with 2–3 members who have all confirmed.
 * @param {{ kind: "solo"|"group", captainVerified: boolean, members: Array<{ status: string }> }} team
 */
export function deriveTeamStatus({ kind, captainVerified, members }) {
  if (!captainVerified) return TEAM_STATUS.PENDING_CAPTAIN;
  if (kind === "solo") return TEAM_STATUS.ACTIVE;
  const allConfirmed = members.every((member) => member.status === MEMBER_STATUS.CONFIRMED);
  return members.length >= GROUP_SIZE.min && allConfirmed ? TEAM_STATUS.ACTIVE : TEAM_STATUS.PENDING_MEMBERS;
}

/** @returns {null | "not_group" | "team_full"} why another member cannot be invited. */
export function cannotAddMember({ kind, memberCount }) {
  if (kind !== "group") return "not_group";
  if (memberCount >= GROUP_SIZE.max) return "team_full";
  return null;
}
