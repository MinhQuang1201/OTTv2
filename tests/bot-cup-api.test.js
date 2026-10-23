"use strict";

/**
 * Bot Cup registration API (apps/bot-cup-api) against the real migrations on SQLite, with a fake clock, mailer and
 * Turnstile. Covers the P1 list in docs/superpowers/plans/2026-10-23-uet-k71-bot-cup.md §12.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { createD1 } = require("./bot-cup/d1-sqlite");

const WEB = "https://web.test";
const OPENS = Date.UTC(2026, 10, 30, 0, 0);
const CLOSES = Date.UTC(2026, 11, 4, 17, 0);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

let createBotCupApi;
before(async () => {
  ({ createBotCupApi } = await import("../apps/bot-cup-api/src/app.mjs"));
});

function setup({ mode = "demo", config = {} } = {}) {
  const db = createD1();
  db.sqlite.prepare(
    "INSERT INTO events (id, name, mode, registration_opens_at, registration_closes_at, config_json) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("ev", "OTT Bot Cup Test", mode, OPENS, CLOSES, JSON.stringify(config));

  const env = { clock: OPENS + HOUR, mailFails: false, sent: [], ip: "10.0.0.1" };
  const mailer = {
    async send(message) {
      if (env.mailFails) throw new Error("smtp down");
      env.sent.push(message);
    }
  };
  const turnstile = { async verify(token) { return token === "ok"; } };
  const api = createBotCupApi({
    db,
    mailer,
    turnstile,
    now: () => env.clock,
    config: { eventId: "ev", otpPepper: "test-pepper-0123456789", webOrigin: WEB, allowedOrigins: [WEB], turnstileSiteKey: "site-key", devToken: null }
  });

  async function call(method, path, body, { cookie, origin = WEB, headers = {} } = {}) {
    const init = { method, headers: { "x-real-ip": env.ip, ...headers } };
    if (origin) init.headers.origin = origin;
    if (cookie) init.headers.cookie = cookie;
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await api.fetch(new Request(`https://api.test/api/t${path}`, init));
    const setCookie = response.headers.get("set-cookie");
    return { status: response.status, body: await response.json(), cookie: setCookie ? setCookie.split(";")[0] : null, setCookie };
  }

  const mailsTo = (email) => env.sent.filter((m) => m.to === email);
  const lastOtp = (email) => mailsTo(email).at(-1)?.text.match(/\b(\d{6})\b/)?.[1];
  const lastInvite = (email) => mailsTo(email).at(-1)?.text.match(/invite=([A-Za-z0-9_-]+)/)?.[1];

  let counter = 0;
  function registration(overrides = {}) {
    counter += 1;
    const { captain, ...rest } = overrides;
    return {
      kind: "solo",
      handle: `team-${counter}`,
      displayName: `Đội Số ${counter}`,
      password: "correct-horse-1",
      consent: true,
      showName: true,
      turnstileToken: "ok",
      ...rest,
      captain: { fullName: "Nguyễn Văn A", mssv: String(26020100 + counter), ...captain }
    };
  }

  async function registerVerified(overrides = {}) {
    const body = registration(overrides);
    const created = await call("POST", "/register", body);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const email = body.captain.email?.toLowerCase() || `${body.captain.mssv}@vnu.edu.vn`;
    const verified = await call("POST", "/register/verify", { handle: body.handle, otp: lastOtp(email) });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    return { body, email, cookie: verified.cookie, team: verified.body };
  }

  return { db, env, call, registration, registerVerified, lastOtp, lastInvite, mailsTo };
}

describe("bot-cup-api event", () => {
  it("publishes the event, its eligibility rules and the Turnstile site key", async () => {
    const { call } = setup({ mode: "production" });
    const { status, body } = await call("GET", "/event");
    assert.equal(status, 200);
    assert.equal(body.mode, "production");
    assert.equal(body.registrationOpen, true);
    assert.deepEqual(body.eligibility, { mssvDigits: 8, mssvPrefix: "26", emailDomain: "vnu.edu.vn", allowExternalEmail: false });
    assert.equal(body.turnstileSiteKey, "site-key");
  });

  it("answers unknown paths and wrong methods", async () => {
    const { call } = setup();
    assert.equal((await call("GET", "/nope")).status, 404);
    assert.equal((await call("PUT", "/register", {})).status, 405);
  });
});

describe("bot-cup-api registration", () => {
  it("registers a solo team: OTP to the school address, verify, session, /me", async () => {
    const { call, registration, lastOtp, env } = setup();
    const body = registration({ handle: "Solo-One" });
    const created = await call("POST", "/register", body);
    assert.equal(created.status, 201);
    assert.deepEqual(created.body, { handle: "solo-one", status: "pending_captain", otpSentTo: "26****01@vnu.edu.vn" });
    assert.equal(env.sent.length, 1);
    assert.match(env.sent[0].subject, /Mã xác minh/);

    const verified = await call("POST", "/register/verify", { handle: "solo-one", otp: lastOtp("26020101@vnu.edu.vn") });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.status, "active");
    assert.match(verified.setCookie, /^__Host-ottcup_session=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=1209600$/);

    const me = await call("GET", "/me", undefined, { cookie: verified.cookie });
    assert.equal(me.status, 200);
    assert.equal(me.body.handle, "solo-one");
    assert.deepEqual(me.body.members, [{ mssv: "26020101", fullName: "Nguyễn Văn A", email: "26****01@vnu.edu.vn", role: "captain", status: "confirmed", showName: true }]);
    assert.equal((await call("GET", "/me")).status, 401);
  });

  it("always rejects an MSSV that is not 8 digits", async () => {
    for (const mode of ["demo", "production"]) {
      const { call, registration } = setup({ mode });
      const result = await call("POST", "/register", registration({ captain: { mssv: "2602012" } }));
      assert.equal(result.status, 400);
      assert.deepEqual(result.body, { error: "mssv_invalid", field: "captain.mssv" });
    }
  });

  it("production rejects other cohorts and other addresses", async () => {
    const { call, registration } = setup({ mode: "production" });
    assert.equal((await call("POST", "/register", registration({ captain: { mssv: "25020123" } }))).body.error, "mssv_not_eligible");
    assert.equal((await call("POST", "/register", registration({ captain: { mssv: "26020123", email: "me@gmail.com" } }))).body.error, "email_not_allowed");
    assert.equal((await call("POST", "/register", registration({ captain: { mssv: "26020123" } }))).status, 201);
  });

  it("demo accepts other cohorts and sends the OTP to another address", async () => {
    const { call, registration, mailsTo } = setup({ mode: "demo" });
    const result = await call("POST", "/register", registration({ captain: { mssv: "21020999", email: "Me@Gmail.com" } }));
    assert.equal(result.status, 201);
    assert.equal(result.body.otpSentTo, "m***@gmail.com");
    assert.equal(mailsTo("me@gmail.com").length, 1);
  });

  it("keeps one student in one team", async () => {
    const { call, registration, registerVerified } = setup();
    await registerVerified({ captain: { mssv: "26020500" } });
    const again = await call("POST", "/register", registration({ captain: { mssv: "26020500" } }));
    assert.deepEqual([again.status, again.body.error], [409, "mssv_taken"]);

    const group = await registerVerified({ kind: "group" });
    const invite = await call("POST", "/team/members", { fullName: "Trần B", mssv: "26020500" }, { cookie: group.cookie });
    assert.deepEqual([invite.status, invite.body.error], [409, "mssv_taken"]);
  });

  it("rejects a taken handle regardless of case and a display name that folds to a taken one", async () => {
    const { call, registration, registerVerified } = setup();
    await registerVerified({ handle: "alpha", displayName: "Đội Một" });
    assert.equal((await call("POST", "/register", registration({ handle: "ALPHA" }))).body.error, "handle_taken");
    assert.equal((await call("POST", "/register", registration({ displayName: "doi  mot" }))).body.error, "display_name_taken");
  });

  it("validates the request before touching storage", async () => {
    const { call, registration, env } = setup();
    assert.equal((await call("POST", "/register", registration({ kind: "trio" }))).body.field, "kind");
    assert.equal((await call("POST", "/register", registration({ password: "short" }))).body.error, "password_weak");
    assert.equal((await call("POST", "/register", registration({ consent: false }))).body.error, "consent_required");
    assert.equal((await call("POST", "/register", registration({ displayName: "Team VCL" }))).body.error, "display_name_blocked");
    assert.equal((await call("POST", "/register", registration({ handle: "admin" }))).body.error, "handle_reserved");
    const notJson = await call("POST", "/register", undefined, { headers: { "content-type": "text/plain" } });
    assert.equal(notJson.status, 415);
    assert.equal(env.sent.length, 0);
  });

  it("locks the OTP after five wrong codes", async () => {
    const { call, registration, lastOtp } = setup();
    const body = registration();
    await call("POST", "/register", body);
    const code = lastOtp(`${body.captain.mssv}@vnu.edu.vn`);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) {
      assert.equal((await call("POST", "/register/verify", { handle: body.handle, otp: wrong })).body.error, "otp_invalid");
    }
    const fifth = await call("POST", "/register/verify", { handle: body.handle, otp: wrong });
    assert.deepEqual([fifth.status, fifth.body.error], [429, "otp_locked"]);
    assert.equal((await call("POST", "/register/verify", { handle: body.handle, otp: code })).body.error, "otp_locked");
  });

  it("expires the OTP after 10 minutes; a resend issues a new one and retires the old", async () => {
    const { call, registration, lastOtp, env } = setup();
    const body = registration();
    const email = `${body.captain.mssv}@vnu.edu.vn`;
    await call("POST", "/register", body);
    const first = lastOtp(email);
    env.clock += 10 * MINUTE;
    assert.equal((await call("POST", "/register/verify", { handle: body.handle, otp: first })).body.error, "otp_expired");

    assert.equal((await call("POST", "/register/resend", { handle: body.handle, turnstileToken: "ok" })).status, 202);
    const second = lastOtp(email);
    if (second !== first) assert.equal((await call("POST", "/register/verify", { handle: body.handle, otp: first })).body.error, "otp_invalid");
    assert.equal((await call("POST", "/register/verify", { handle: body.handle, otp: second })).status, 200);
  });

  it("limits OTP emails to three per address per hour", async () => {
    const { call, registration, env } = setup();
    const body = registration();
    await call("POST", "/register", body);
    assert.equal((await call("POST", "/register/resend", { handle: body.handle, turnstileToken: "ok" })).status, 202);
    assert.equal((await call("POST", "/register/resend", { handle: body.handle, turnstileToken: "ok" })).status, 202);
    const fourth = await call("POST", "/register/resend", { handle: body.handle, turnstileToken: "ok" });
    assert.deepEqual([fourth.status, fourth.body.error], [429, "rate_limited"]);
    env.clock += HOUR;
    assert.equal((await call("POST", "/register/resend", { handle: body.handle, turnstileToken: "ok" })).status, 202);
  });

  it("frees the handle, name and MSSV of a team never verified within 24 hours", async () => {
    const { call, registration, env } = setup();
    const body = registration({ handle: "ghost", displayName: "Bóng Ma" });
    await call("POST", "/register", body);
    const sameCaptain = { ...body, captain: { ...body.captain } };
    assert.equal((await call("POST", "/register", sameCaptain)).body.error, "handle_taken");
    env.clock += 24 * HOUR + 1;
    assert.equal((await call("POST", "/register", sameCaptain)).status, 201);
  });

  it("does not keep a team when the OTP email cannot be sent", async () => {
    const { call, registration, env } = setup();
    const body = registration({ handle: "mailless" });
    env.mailFails = true;
    const failed = await call("POST", "/register", body);
    assert.deepEqual([failed.status, failed.body.error], [503, "email_unavailable"]);
    env.mailFails = false;
    assert.equal((await call("POST", "/register", body)).status, 201);
  });

  it("closes registration at registration_closes_at", async () => {
    const { call, registration, env } = setup();
    env.clock = CLOSES;
    const closed = await call("POST", "/register", registration());
    assert.deepEqual([closed.status, closed.body.error], [409, "registration_closed"]);
    env.clock = OPENS - 1;
    assert.equal((await call("POST", "/register", registration())).body.error, "registration_closed");
  });

  it("requires Turnstile and a same-site Origin on writes", async () => {
    const { call, registration } = setup();
    assert.deepEqual((await call("POST", "/register", registration({ turnstileToken: "bad" }))).body, { error: "turnstile_failed" });
    assert.equal((await call("POST", "/register", registration(), { origin: "https://evil.test" })).body.error, "forbidden_origin");
    assert.equal((await call("POST", "/register", registration(), { origin: null })).body.error, "forbidden_origin");
  });
});

describe("bot-cup-api groups and invites", () => {
  it("activates a group of three only when every member has confirmed", async () => {
    const { call, registerVerified, lastInvite } = setup();
    const { cookie, team } = await registerVerified({ kind: "group" });
    assert.equal(team.status, "pending_members");

    const b = await call("POST", "/team/members", { fullName: "Trần Thị B", mssv: "26020201" }, { cookie });
    assert.equal(b.status, 201);
    const c = await call("POST", "/team/members", { fullName: "Lê Văn C", mssv: "26020202" }, { cookie });
    assert.equal(c.body.members.length, 3);
    assert.equal(c.body.status, "pending_members");

    const tokenB = lastInvite("26020201@vnu.edu.vn");
    const preview = await call("GET", `/invites/${tokenB}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.fullName, "Trần Thị B");
    assert.equal((await call("POST", "/invites/accept", { token: tokenB, consent: true, showName: false })).body.status, "pending_members");
    assert.equal((await call("POST", "/invites/accept", { token: tokenB, consent: true })).body.error, "invite_used");

    const tokenC = lastInvite("26020202@vnu.edu.vn");
    assert.equal((await call("POST", "/invites/accept", { token: tokenC, consent: false })).body.error, "consent_required");
    assert.equal((await call("POST", "/invites/accept", { token: tokenC, consent: true })).body.status, "active");

    const me = await call("GET", "/me", undefined, { cookie });
    assert.equal(me.body.status, "active");
    assert.deepEqual(me.body.members.map((m) => [m.role, m.status]), [["captain", "confirmed"], ["member", "confirmed"], ["member", "confirmed"]]);

    const fourth = await call("POST", "/team/members", { fullName: "Phạm D", mssv: "26020203" }, { cookie });
    assert.deepEqual([fourth.status, fourth.body.error], [409, "team_full"]);
  });

  it("refuses members for solo teams and drops back to pending when a member is added", async () => {
    const { call, registerVerified, lastInvite } = setup();
    const solo = await registerVerified();
    assert.equal((await call("POST", "/team/members", { fullName: "X Y", mssv: "26020301" }, { cookie: solo.cookie })).body.error, "not_group");

    const group = await registerVerified({ kind: "group" });
    await call("POST", "/team/members", { fullName: "Trần B", mssv: "26020302" }, { cookie: group.cookie });
    await call("POST", "/invites/accept", { token: lastInvite("26020302@vnu.edu.vn"), consent: true });
    assert.equal((await call("GET", "/me", undefined, { cookie: group.cookie })).body.status, "active");
    const added = await call("POST", "/team/members", { fullName: "Lê C", mssv: "26020303" }, { cookie: group.cookie });
    assert.equal(added.body.status, "pending_members");

    const removed = await call("DELETE", "/team/members/26020303", undefined, { cookie: group.cookie });
    assert.equal(removed.body.status, "active");
    assert.equal((await call("DELETE", `/team/members/${group.body.captain.mssv}`, undefined, { cookie: group.cookie })).body.error, "captain_required");
  });

  it("expires invites after 72 hours and frees the invited MSSV", async () => {
    const { call, registerVerified, lastInvite, env } = setup();
    const group = await registerVerified({ kind: "group" });
    await call("POST", "/team/members", { fullName: "Trần B", mssv: "26020401" }, { cookie: group.cookie });
    const token = lastInvite("26020401@vnu.edu.vn");
    env.clock += 72 * HOUR;
    assert.equal((await call("POST", "/invites/accept", { token, consent: true })).body.error, "invite_expired");
    const elsewhere = await registerVerified({ captain: { mssv: "26020401" } });
    assert.equal(elsewhere.team.status, "active");
  });

  it("resends an invite with a new link and invalidates the old one", async () => {
    const { call, registerVerified, lastInvite } = setup();
    const group = await registerVerified({ kind: "group" });
    await call("POST", "/team/members", { fullName: "Trần B", mssv: "26020601" }, { cookie: group.cookie });
    const old = lastInvite("26020601@vnu.edu.vn");
    assert.equal((await call("POST", "/team/members/26020601/resend", undefined, { cookie: group.cookie })).status, 202);
    const fresh = lastInvite("26020601@vnu.edu.vn");
    assert.notEqual(fresh, old);
    assert.equal((await call("POST", "/invites/accept", { token: old, consent: true })).body.error, "invite_expired");
    assert.equal((await call("POST", "/invites/accept", { token: fresh, consent: true })).status, 200);
  });
});

describe("bot-cup-api login and passwords", () => {
  it("locks login for 15 minutes after ten wrong passwords", async () => {
    const { call, registerVerified, env } = setup();
    const { body } = await registerVerified();
    const attempt = (password) => call("POST", "/login", { handle: body.handle, password, turnstileToken: "ok" });
    for (let i = 0; i < 9; i++) assert.equal((await attempt("wrong-password")).body.error, "login_failed");
    assert.equal((await attempt("wrong-password")).status, 423);
    assert.equal((await attempt(body.password)).body.error, "login_locked");
    env.clock += 15 * MINUTE;
    const ok = await attempt(body.password);
    assert.equal(ok.status, 200);
    assert.ok(ok.cookie);
  });

  it("asks an unverified team to verify instead of logging in", async () => {
    const { call, registration } = setup();
    const body = registration();
    await call("POST", "/register", body);
    const result = await call("POST", "/login", { handle: body.handle, password: body.password, turnstileToken: "ok" });
    assert.deepEqual([result.status, result.body.error], [403, "verification_required"]);
    assert.equal((await call("POST", "/login", { handle: "nobody", password: "x", turnstileToken: "ok" })).body.error, "login_failed");
  });

  it("resets the password by OTP and ends every session", async () => {
    const { call, registerVerified, lastOtp } = setup();
    const { body, email, cookie } = await registerVerified();
    const requested = await call("POST", "/password/reset/request", { handle: body.handle, turnstileToken: "ok" });
    assert.equal(requested.status, 202);
    const confirmed = await call("POST", "/password/reset/confirm", { handle: body.handle, otp: lastOtp(email), newPassword: "brand-new-pass-2" });
    assert.equal(confirmed.status, 200);
    assert.equal((await call("GET", "/me", undefined, { cookie })).status, 401);
    assert.equal((await call("POST", "/login", { handle: body.handle, password: body.password, turnstileToken: "ok" })).status, 401);
    assert.equal((await call("POST", "/login", { handle: body.handle, password: "brand-new-pass-2", turnstileToken: "ok" })).status, 200);
  });

  it("sends the reset code to a confirmed member who asks for it", async () => {
    const { call, registerVerified, lastInvite, mailsTo } = setup();
    const group = await registerVerified({ kind: "group" });
    await call("POST", "/team/members", { fullName: "Trần B", mssv: "26020701" }, { cookie: group.cookie });
    await call("POST", "/invites/accept", { token: lastInvite("26020701@vnu.edu.vn"), consent: true });
    const result = await call("POST", "/password/reset/request", { handle: group.body.handle, mssv: "26020701", turnstileToken: "ok" });
    assert.equal(result.body.otpSentTo, "26****01@vnu.edu.vn");
    assert.match(mailsTo("26020701@vnu.edu.vn").at(-1).subject, /Mã xác minh/);
  });

  it("changes the password, keeps this session and ends the others", async () => {
    const { call, registerVerified } = setup();
    const { body, cookie } = await registerVerified();
    const other = await call("POST", "/login", { handle: body.handle, password: body.password, turnstileToken: "ok" });
    assert.equal((await call("POST", "/password/change", { currentPassword: "nope-nope-nope", newPassword: "another-pass-3" }, { cookie })).body.error, "password_mismatch");
    assert.equal((await call("POST", "/password/change", { currentPassword: body.password, newPassword: "another-pass-3" }, { cookie })).status, 200);
    assert.equal((await call("GET", "/me", undefined, { cookie })).status, 200);
    assert.equal((await call("GET", "/me", undefined, { cookie: other.cookie })).status, 401);

    const revoked = await call("POST", "/sessions/revoke-all", undefined, { cookie });
    assert.match(revoked.setCookie, /Max-Age=0/);
    assert.equal((await call("GET", "/me", undefined, { cookie })).status, 401);
  });

  it("logs out", async () => {
    const { call, registerVerified } = setup();
    const { cookie } = await registerVerified();
    assert.equal((await call("POST", "/logout", undefined, { cookie })).status, 200);
    assert.equal((await call("GET", "/me", undefined, { cookie })).status, 401);
  });

  it("hides the dev outbox unless a dev token is configured and presented", async () => {
    const { call } = setup();
    assert.equal((await call("GET", "/_dev/outbox?to=a@b.c", undefined, { headers: { authorization: "Bearer x" } })).status, 404);
  });
});
