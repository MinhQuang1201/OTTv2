"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

let core;
before(async () => {
  core = await import("../packages/bot-cup-core/src/index.mjs");
});

describe("bot-cup-core eligibility", () => {
  it("production accepts only 8-digit K71 MSSVs with the school address", () => {
    const rules = core.eligibilityRules("production");
    assert.deepEqual(core.checkStudent({ mssv: "26020123" }, rules), { ok: true, mssv: "26020123", email: "26020123@vnu.edu.vn" });
    assert.deepEqual(core.checkStudent({ mssv: " 26020123 ", email: "26020123@VNU.edu.vn" }, rules), { ok: true, mssv: "26020123", email: "26020123@vnu.edu.vn" });
    assert.equal(core.checkStudent({ mssv: "25020123" }, rules).error, "mssv_not_eligible");
    assert.equal(core.checkStudent({ mssv: "2602012" }, rules).error, "mssv_invalid");
    assert.equal(core.checkStudent({ mssv: "260201234" }, rules).error, "mssv_invalid");
    assert.equal(core.checkStudent({ mssv: "2602012a" }, rules).error, "mssv_invalid");
    assert.deepEqual(core.checkStudent({ mssv: "26020123", email: "someone@gmail.com" }, rules), { ok: false, error: "email_not_allowed", field: "email" });
    assert.equal(core.checkStudent({ mssv: "26020123", email: "26020124@vnu.edu.vn" }, rules).error, "email_not_allowed");
  });

  it("demo accepts any cohort and another email address", () => {
    const rules = core.eligibilityRules("demo");
    assert.deepEqual(core.checkStudent({ mssv: "21020999" }, rules), { ok: true, mssv: "21020999", email: "21020999@vnu.edu.vn" });
    assert.deepEqual(core.checkStudent({ mssv: "21020999", email: " Me@Gmail.com " }, rules), { ok: true, mssv: "21020999", email: "me@gmail.com" });
    assert.equal(core.checkStudent({ mssv: "2102099" }, rules).error, "mssv_invalid");
    assert.equal(core.checkStudent({ mssv: "21020999", email: "not-an-email" }, rules).error, "email_invalid");
  });

  it("lets events.config_json override known eligibility keys only", () => {
    const rules = core.eligibilityRules("production", { mssvPrefix: "2602", allowExternalEmail: true, unknown: 1 });
    assert.equal(rules.mssvPrefix, "2602");
    assert.equal(rules.allowExternalEmail, true);
    assert.equal("unknown" in rules, false);
    assert.throws(() => core.eligibilityRules("staging"));
  });

  it("masks addresses", () => {
    assert.equal(core.maskEmail("26020123@vnu.edu.vn"), "26****23@vnu.edu.vn");
    assert.equal(core.maskEmail("abc@gmail.com"), "a***@gmail.com");
  });
});

describe("bot-cup-core team", () => {
  it("validates handles", () => {
    assert.deepEqual(core.validateHandle(" Team-Alpha "), { ok: true, handle: "team-alpha" });
    for (const bad of ["ab", "-team", "team-", "te--am", "đội", "a".repeat(25), 42]) {
      assert.equal(core.validateHandle(bad).ok, false, String(bad));
    }
    assert.equal(core.validateHandle("admin").error, "handle_reserved");
  });

  it("folds display names so near-duplicates collide", () => {
    const a = core.validateDisplayName("Đội  Một!");
    const b = core.validateDisplayName("doi mot");
    assert.equal(a.ok && b.ok, true);
    assert.equal(a.key, b.key);
    assert.equal(a.displayName, "Đội Một!");
    assert.equal(core.validateDisplayName("<b>x</b>").error, "display_name_invalid");
    assert.equal(core.validateDisplayName("a".repeat(40)).displayName.length, 32);
  });

  it("blocks offensive names without flagging ordinary Vietnamese", () => {
    assert.equal(core.validateDisplayName("Đội lồn").error, "display_name_blocked");
    assert.equal(core.validateDisplayName("Team VCL").error, "display_name_blocked");
    assert.equal(core.validateDisplayName("Các Bạn Lớn").ok, true);
    assert.equal(core.validateDisplayName("Con Cáo").ok, true);
  });

  it("validates full names and passwords", () => {
    assert.equal(core.validateFullName("Nguyễn Văn A").ok, true);
    assert.equal(core.validateFullName("12").ok, false);
    assert.equal(core.validatePassword("short").ok, false);
    assert.equal(core.validatePassword("long-enough-1").ok, true);
  });

  it("derives team status from captain verification and members", () => {
    const confirmed = { status: "confirmed" };
    const pending = { status: "pending" };
    assert.equal(core.deriveTeamStatus({ kind: "solo", captainVerified: false, members: [pending] }), "pending_captain");
    assert.equal(core.deriveTeamStatus({ kind: "solo", captainVerified: true, members: [confirmed] }), "active");
    assert.equal(core.deriveTeamStatus({ kind: "group", captainVerified: true, members: [confirmed] }), "pending_members");
    assert.equal(core.deriveTeamStatus({ kind: "group", captainVerified: true, members: [confirmed, pending, confirmed] }), "pending_members");
    assert.equal(core.deriveTeamStatus({ kind: "group", captainVerified: true, members: [confirmed, confirmed, confirmed] }), "active");
    assert.equal(core.cannotAddMember({ kind: "solo", memberCount: 1 }), "not_group");
    assert.equal(core.cannotAddMember({ kind: "group", memberCount: 3 }), "team_full");
    assert.equal(core.cannotAddMember({ kind: "group", memberCount: 2 }), null);
  });
});

describe("bot-cup-core policy", () => {
  it("generates 6-digit codes and rejects biased draws", () => {
    const draws = [0xffffffff, 123456];
    const code = core.generateOtp((array) => { array[0] = draws.shift(); return array; });
    assert.equal(code, "123456");
    const random = core.generateOtp((array) => crypto.getRandomValues(array));
    assert.match(random, /^\d{6}$/);
  });

  it("counts OTP attempts and locks after five wrong codes", () => {
    const record = { expiresAt: 1000, attempts: 0, consumedAt: null };
    assert.deepEqual(core.evaluateOtpAttempt(record, 0, true), { result: "ok", attempts: 0 });
    assert.deepEqual(core.evaluateOtpAttempt(record, 0, false), { result: "otp_invalid", attempts: 1 });
    assert.deepEqual(core.evaluateOtpAttempt({ ...record, attempts: 4 }, 0, false), { result: "otp_locked", attempts: 5 });
    assert.deepEqual(core.evaluateOtpAttempt({ ...record, attempts: 5 }, 0, true), { result: "otp_locked", attempts: 5 });
    assert.deepEqual(core.evaluateOtpAttempt(record, 1000, true), { result: "otp_expired", attempts: 0 });
    assert.deepEqual(core.evaluateOtpAttempt({ ...record, consumedAt: 5 }, 0, true), { result: "otp_invalid", attempts: 0 });
    assert.deepEqual(core.evaluateOtpAttempt(null, 0, true), { result: "otp_invalid", attempts: 0 });
  });

  it("locks login for 15 minutes after ten failures", () => {
    let state = { failedLogins: 0, lockedUntil: null };
    for (let i = 0; i < 9; i++) state = core.afterFailedLogin(state, 0);
    assert.deepEqual(state, { failedLogins: 9, lockedUntil: null });
    state = core.afterFailedLogin(state, 0);
    assert.deepEqual(state, { failedLogins: 0, lockedUntil: 15 * 60 * 1000 });
    assert.equal(core.loginLocked(state, 15 * 60 * 1000 - 1), true);
    assert.equal(core.loginLocked(state, 15 * 60 * 1000), false);
  });

  it("opens registration on [opensAt, closesAt)", () => {
    const event = { registrationOpensAt: 10, registrationClosesAt: 20 };
    assert.equal(core.registrationOpen(event, 9), false);
    assert.equal(core.registrationOpen(event, 10), true);
    assert.equal(core.registrationOpen(event, 19), true);
    assert.equal(core.registrationOpen(event, 20), false);
  });
});

describe("bot-cup-core submissions", () => {
  const bytes = (text) => new TextEncoder().encode(text);

  it("inspects uploads: language from the extension, size, binary bytes, encoding", () => {
    assert.deepEqual(core.inspectSource(bytes("print(1)\n"), "C:\\Users\\me\\bot.py"), { ok: true, language: "python", filename: "bot.py", text: "print(1)\n" });
    assert.equal(core.inspectSource(bytes("x\n"), "Bot.MJS").language, "node");
    assert.equal(core.inspectSource(bytes("x\n"), "bot.js").language, "node");
    assert.equal(core.inspectSource(bytes("x\n"), "bot.ts").error, "submission_extension");
    assert.equal(core.inspectSource(new Uint8Array(200 * 1024 + 1).fill(0x23), "bot.py").error, "submission_too_large");
    assert.equal(core.inspectSource(new Uint8Array([0x61, 0x0b]), "bot.py").error, "submission_binary");
    assert.equal(core.inspectSource(new Uint8Array([0xff, 0xfe]), "bot.py").error, "submission_encoding");
    assert.equal(core.inspectSource(bytes("\t\r\n\f"), "bot.py").error, "submission_empty");
    assert.equal(core.cleanFilename(`${"a".repeat(80)}.py`).length, 64);
    assert.ok(core.cleanFilename(`${"a".repeat(80)}.py`).endsWith(".py"));
  });

  it("opens uploads with practice and closes them at code freeze, on the server clock", () => {
    const event = { practiceOpensAt: 1000, codeFreezeAt: 2000 };
    assert.equal(core.submissionWindow(event, 999), "submissions_not_open");
    assert.equal(core.submissionWindow(event, 1000), null);
    assert.equal(core.submissionWindow(event, 2000), "code_frozen");
    assert.equal(core.submissionWindow({ practiceOpensAt: null, codeFreezeAt: null }, 5), "submissions_not_open");
    assert.equal(core.finalSubmissionLocked(event, 500), false);
    assert.equal(core.finalSubmissionLocked(event, 2000), true);
  });

  it("counts days from midnight in Vietnam", () => {
    const midnightVn = Date.UTC(2026, 10, 30, 17, 0);
    assert.equal(core.vietnamDayStart(midnightVn), midnightVn);
    assert.equal(core.vietnamDayStart(midnightVn - 1), midnightVn - 24 * 3600 * 1000);
    assert.equal(core.vietnamDayStart(midnightVn + 23 * 3600 * 1000), midnightVn);
  });

  it("picks the chosen final submission while eligible, else the newest eligible one", () => {
    const list = [
      { id: "a", seq: 1, status: "ready" },
      { id: "b", seq: 2, status: "checking" },
      { id: "c", seq: 3, status: "smoke_failed" }
    ];
    assert.equal(core.effectiveFinalSubmission(list, null).id, "b");
    assert.equal(core.effectiveFinalSubmission(list, "a").id, "a");
    assert.equal(core.effectiveFinalSubmission(list, "c").id, "b");
    assert.equal(core.effectiveFinalSubmission([], null), null);
  });

  it("normalises away names, comments, strings, numbers and layout but not structure", () => {
    const a = "def f(x):\n    # comment\n    return x + 1  # one\n";
    const b = "def   g( y ) :\n  '''doc'''\n  return y+2\n";
    const c = "def f(x):\n    return x - 1\n";
    assert.equal(core.normalizeSource(a, "python"), core.normalizeSource(b, "python"));
    assert.notEqual(core.normalizeSource(a, "python"), core.normalizeSource(c, "python"));
    assert.equal(core.normalizeSource("x = f'a{b}' + rb\"\"\"q\"\"\"\n", "python"), "python:I = +");

    const js1 = "let best = (moves) => moves[0]; // first\n/* block */ log(`turn ${n}`);\n";
    const js2 = "let  pick=(m)=>m[ 7 ];\nlog('x');";
    assert.equal(core.normalizeSource(js1, "node"), core.normalizeSource(js2, "node"));
    assert.notEqual(core.normalizeSource("let a = b;", "node"), core.normalizeSource("const a = b;", "node"));
  });

  it("ships reference hashes that match the reference files", async () => {
    const { computeReferenceHashes, renderModule, OUTPUT } = await import("../scripts/bot-cup/reference-hashes.mjs");
    const fs = require("node:fs");
    const path = require("node:path");
    const current = fs.readFileSync(path.join(__dirname, "..", OUTPUT), "utf8").replace(/\r\n/g, "\n");
    assert.equal(current, renderModule(computeReferenceHashes()), "run node scripts/bot-cup/reference-hashes.mjs");
  });
});
