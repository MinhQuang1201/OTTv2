/**
 * Bot submissions (plan §6, §8.2, §8.5): what a team may upload, when, how often, and the normalised form used to
 * spot copies. Pure: callers pass the bytes, the event and `now`; hashing happens in the caller.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Days for the daily limit start at midnight in Vietnam (UTC+7, no daylight saving). */
const VIETNAM_OFFSET_MS = 7 * HOUR;

export const SUBMISSION_POLICY = Object.freeze({
  maxBytes: 200 * 1024,
  perDay: 10,
  maxVersions: 200,
  filenameMax: 64
});

export const SUBMISSION_LANGUAGES = Object.freeze({ python: [".py"], node: [".js", ".mjs"] });

/**
 * `checking`: stored, waiting for the runner's syntax check and smoke test (P4). The runner moves it to `ready`,
 * `build_failed` or `smoke_failed`.
 */
export const SUBMISSION_STATUS = Object.freeze({
  CHECKING: "checking",
  READY: "ready",
  BUILD_FAILED: "build_failed",
  SMOKE_FAILED: "smoke_failed"
});

/**
 * Statuses a team may pick as its final submission. `checking` is allowed until the runner exists; sealing at code
 * freeze (P7) only accepts `ready`.
 */
export const FINAL_ELIGIBLE_STATUSES = Object.freeze([SUBMISSION_STATUS.CHECKING, SUBMISSION_STATUS.READY]);

/** @returns {"python"|"node"|null} */
export function languageForFilename(filename) {
  const lower = String(filename ?? "").toLowerCase();
  for (const [language, extensions] of Object.entries(SUBMISSION_LANGUAGES)) {
    if (extensions.some((extension) => lower.endsWith(extension) && lower.length > extension.length)) return language;
  }
  return null;
}

/** The last path segment without control characters, cut to `filenameMax` keeping the extension. */
export function cleanFilename(filename) {
  const base = String(filename ?? "").split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (base.length <= SUBMISSION_POLICY.filenameMax) return base;
  const dot = base.lastIndexOf(".");
  const extension = dot > 0 ? base.slice(dot) : "";
  return base.slice(0, SUBMISSION_POLICY.filenameMax - extension.length) + extension;
}

// C0 controls other than tab, line feed, form feed and carriage return: a text bot file never contains them.
function hasBinaryBytes(bytes) {
  for (const byte of bytes) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) return true;
  }
  return false;
}

/**
 * Static checks done when a file arrives (plan §6.1, §6.2). The syntax check and smoke test run later on the runner.
 * @param {Uint8Array} bytes
 * @param {string} filename
 * @returns {{ ok: true, language: "python"|"node", filename: string, text: string }
 *         | { ok: false, error: "submission_empty"|"submission_too_large"|"submission_extension"|"submission_binary"|"submission_encoding" }}
 */
export function inspectSource(bytes, filename) {
  const name = cleanFilename(filename);
  const language = languageForFilename(name);
  if (!language) return { ok: false, error: "submission_extension" };
  if (bytes.length > SUBMISSION_POLICY.maxBytes) return { ok: false, error: "submission_too_large" };
  if (hasBinaryBytes(bytes)) return { ok: false, error: "submission_binary" };
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, error: "submission_encoding" };
  }
  if (text.trim() === "") return { ok: false, error: "submission_empty" };
  return { ok: true, language, filename: name, text };
}

/**
 * Whether a team may upload now: practice has opened and the code is not frozen (plan §7.1). Times come from the
 * server clock only (§8.2).
 * @returns {null | "submissions_not_open" | "code_frozen"}
 */
export function submissionWindow(event, now) {
  if (event.codeFreezeAt != null && now >= event.codeFreezeAt) return "code_frozen";
  if (event.practiceOpensAt == null || now < event.practiceOpensAt) return "submissions_not_open";
  return null;
}

/** The final submission can change until code freeze, also before practice opens. */
export function finalSubmissionLocked(event, now) {
  return event.codeFreezeAt != null && now >= event.codeFreezeAt;
}

/** Start of the Vietnamese calendar day containing `now`, in epoch ms. */
export function vietnamDayStart(now) {
  return Math.floor((now + VIETNAM_OFFSET_MS) / DAY) * DAY - VIETNAM_OFFSET_MS;
}

/**
 * The submission that plays: the team's explicit choice while it is still eligible, otherwise the newest eligible one.
 * @param {Array<{ id: string, seq: number, status: string }>} submissions
 * @param {string|null} chosenId
 */
export function effectiveFinalSubmission(submissions, chosenId) {
  const eligible = submissions.filter((submission) => FINAL_ELIGIBLE_STATUSES.includes(submission.status));
  const chosen = chosenId ? eligible.find((submission) => submission.id === chosenId) : null;
  if (chosen) return chosen;
  return eligible.reduce((latest, submission) => (!latest || submission.seq > latest.seq ? submission : latest), null);
}

// ---------- normalisation for copy detection (plan §8.5, layer 1) ----------

const KEYWORDS = Object.freeze({
  python: new Set([
    "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif",
    "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or",
    "pass", "raise", "return", "try", "while", "with", "yield", "match", "case"
  ]),
  node: new Set([
    "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
    "else", "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "let", "new",
    "null", "of", "return", "static", "super", "switch", "this", "throw", "true", "try", "typeof", "undefined", "var",
    "void", "while", "with", "yield"
  ])
});

const PYTHON_STRING_PREFIX = /^(?:[rRuUbBfF]|[rR][bBfF]|[bBfF][rR])$/;
const IDENTIFIER_START = /[\p{L}_$]/u;
const IDENTIFIER_PART = /[\p{L}\p{N}_$]/u;
const DIGIT = /[0-9]/;

/** Index just past a string literal that opens at `start` with `quote` (one or three characters). */
function skipString(text, start, quote) {
  let i = start + quote.length;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text.startsWith(quote, i)) return i + quote.length;
    // Unterminated single-line literal: stop at the line end so one stray quote does not swallow the file.
    if (quote.length === 1 && quote !== "`" && text[i] === "\n") return i;
    i += 1;
  }
  return i;
}

/**
 * Token stream with comments, whitespace and string literals removed, every identifier replaced by `I` and every
 * number by `N`; keywords and punctuation stay. Two files that differ only in names, comments, formatting, messages
 * or constants give the same result. A JavaScript regular-expression literal is read as punctuation and identifiers,
 * which is good enough for this purpose.
 * @param {string} text
 * @param {"python"|"node"} language
 */
export function normalizeSource(text, language) {
  const keywords = KEYWORDS[language];
  if (!keywords) throw new Error(`unknown language ${language}`);
  const python = language === "python";
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (/\s/.test(char)) {
      i += 1;
    } else if (python && char === "#") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (!python && text.startsWith("//", i)) {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (!python && text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (char === '"' || char === "'" || (!python && char === "`")) {
      const triple = python && text.startsWith(char.repeat(3), i);
      i = skipString(text, i, triple ? char.repeat(3) : char);
    } else if (DIGIT.test(char) || (char === "." && DIGIT.test(text[i + 1] ?? ""))) {
      while (i < text.length && /[0-9a-zA-Z_.]/.test(text[i])) i += 1;
      tokens.push("N");
    } else if (IDENTIFIER_START.test(char)) {
      let end = i + 1;
      while (end < text.length && IDENTIFIER_PART.test(text[end])) end += 1;
      const word = text.slice(i, end);
      const next = text[end];
      if (python && (next === '"' || next === "'") && PYTHON_STRING_PREFIX.test(word)) {
        i = skipString(text, end, text.startsWith(next.repeat(3), end) ? next.repeat(3) : next);
        continue;
      }
      tokens.push(keywords.has(word) ? word : "I");
      i = end;
    } else {
      tokens.push(char);
      i += 1;
    }
  }
  return `${language}:${tokens.join(" ")}`;
}
