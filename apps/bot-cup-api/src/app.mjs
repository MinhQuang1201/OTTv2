/**
 * Bot Cup registration API (plan §5, §10.2), mounted at /api/t through the Vercel rewrite.
 *
 * Dependencies are injected so the same handlers run in the Worker and in Node tests:
 *   db        D1Database-compatible
 *   mailer    { send({ to, subject, text, html }) }
 *   turnstile { verify(token, ip) }
 *   now       () => epoch ms
 *   config    { eventId, otpPepper, webOrigin, allowedOrigins: string[], turnstileSiteKey?, devToken? }
 */
import {
  OTP_POLICY,
  FINAL_ELIGIBLE_STATUSES,
  HOUSE_BOT_LABELS,
  INVITE_TTL_MS,
  MAPS,
  PRACTICE_OPPONENTS,
  PRACTICE_POLICY,
  PUBLIC_STAGES,
  SUBMISSION_STATUS,
  INVITE_MAX_SENDS_PER_HOUR,
  PENDING_CAPTAIN_TTL_MS,
  SESSION_TTL_MS,
  SUBMISSION_POLICY,
  MEMBER_STATUS,
  TEAM_KINDS,
  TEAM_STATUS,
  afterFailedLogin,
  cannotAddMember,
  checkStudent,
  deriveTeamStatus,
  effectiveFinalSubmission,
  eligibilityRules,
  expandReplay,
  gamePoints,
  evaluateOtpAttempt,
  finalSubmissionLocked,
  generateOtp,
  inspectSource,
  loginLocked,
  maskEmail,
  normalizeMssv,
  normalizeSource,
  practiceGames,
  practiceLeaderboard,
  registrationOpen,
  submissionWindow,
  validateDisplayName,
  validateFullName,
  validateHandle,
  validatePassword,
  validatePracticeRequest,
  vietnamDayStart
} from "../../../packages/bot-cup-core/src/index.mjs";
import { HttpError, clearedSessionCookie, clientIp, errorResponse, json, readCookie, readJson, readUpload, sessionCookie, SESSION_COOKIE } from "./http.mjs";
import { inviteEmail, otpEmail } from "./mail.mjs";
import { enqueueCheck, enqueuePractice, gunzipText } from "./queue.mjs";
import { REFERENCE_HASHES } from "./reference-hashes.mjs";
import { createRunnerApi } from "./runner/api.mjs";
import { hashPassword, hmacHex, randomToken, sameDigest, sha256Hex, verifyPassword } from "./security.mjs";
import { createStore, uniqueViolation } from "./store.mjs";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Room for the multipart boundary and headers around a file of SUBMISSION_POLICY.maxBytes.
const UPLOAD_OVERHEAD_BYTES = 16 * 1024;
const PREFIX = "/api/t";
// Per hour and per client address. Generous on purpose: dormitories and campus Wi-Fi put many students behind one NAT
// address; the limits that matter are per email, per OTP and per handle (plan §5.3).
const IP_LIMITS = Object.freeze({ register: 60, login: 300, reset: 60, verify: 300 });

export function createBotCupApi({ db, mailer, turnstile, now, config }) {
  const store = createStore(db);

  // ---------- shared steps ----------

  async function loadEvent() {
    const event = await store.getEvent(config.eventId);
    if (!event) throw new HttpError(503, "event_unavailable");
    return { ...event, rules: eligibilityRules(event.mode, event.config.eligibility) };
  }

  function requireOpen(event) {
    if (!registrationOpen(event, now())) throw new HttpError(409, "registration_closed");
  }

  async function requireTurnstile(body, request) {
    if (!(await turnstile.verify(body.turnstileToken, clientIp(request)))) throw new HttpError(403, "turnstile_failed");
  }

  async function limitIp(request, action) {
    const windowStart = Math.floor(now() / HOUR) * HOUR;
    const count = await store.hit(`${action}:ip:${clientIp(request)}`, windowStart);
    if (count > IP_LIMITS[action]) throw new HttpError(429, "rate_limited");
  }

  function check(result, field) {
    if (!result.ok) throw new HttpError(400, result.error, { field: result.field ?? field });
    return result;
  }

  async function otpHash(otpId, code) {
    return hmacHex(config.otpPepper, `${otpId}:${code}`);
  }

  async function sendOtp({ event, team, email, purpose }) {
    if ((await store.countOtpSince(email, now() - HOUR)) >= OTP_POLICY.maxSendsPerHour) throw new HttpError(429, "rate_limited");
    const id = crypto.randomUUID();
    const code = generateOtp((array) => crypto.getRandomValues(array));
    await store.batch([
      store.retireOtps(team.id, purpose, now()),
      store.insertOtp({ id, teamId: team.id, purpose, email, codeHash: await otpHash(id, code), createdAt: now(), expiresAt: now() + OTP_POLICY.ttlMs })
    ]);
    await mailer.send({ to: email, ...otpEmail({ eventName: event.name, teamName: team.display_name, code, purpose }) });
  }

  /** Checks the latest OTP of `purpose`; consumes it on success. Throws the attempt's error otherwise. */
  async function consumeOtp(team, purpose, code) {
    const record = await store.latestOtp(team.id, purpose);
    const codeText = typeof code === "string" ? code.trim() : "";
    const matches = record && /^\d{6}$/.test(codeText) ? sameDigest(await otpHash(record.id, codeText), record.code_hash) : false;
    const outcome = evaluateOtpAttempt(
      record && { expiresAt: record.expires_at, attempts: record.attempts, consumedAt: record.consumed_at },
      now(),
      matches
    );
    if (record && outcome.attempts !== record.attempts) await store.setOtpAttempts(record.id, outcome.attempts);
    if (outcome.result !== "ok") throw new HttpError(outcome.result === "otp_locked" ? 429 : 400, outcome.result);
    return store.consumeOtp(record.id, now());
  }

  async function refreshTeamStatus(teamId) {
    const team = await store.getTeam(teamId);
    const members = await store.listMembers(teamId);
    const status = deriveTeamStatus({ kind: team.kind, captainVerified: team.verified_at !== null, members });
    const activeAt = status === TEAM_STATUS.ACTIVE ? team.active_at ?? now() : null;
    if (status !== team.status || activeAt !== team.active_at) await store.setTeamStatus(teamId, status, activeAt);
    return { ...team, status, active_at: activeAt };
  }

  async function startSession(team, request) {
    const token = randomToken();
    await store.insertSession({
      idHash: await sha256Hex(token),
      teamId: team.id,
      createdAt: now(),
      expiresAt: now() + SESSION_TTL_MS,
      userAgent: (request.headers.get("user-agent") || "").slice(0, 200)
    });
    return sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000));
  }

  async function sessionHash(request) {
    const token = readCookie(request, SESSION_COOKIE);
    return token ? sha256Hex(token) : null;
  }

  async function requireTeam(request) {
    const idHash = await sessionHash(request);
    const team = idHash ? await store.getSessionTeam(idHash, now()) : null;
    if (!team || team.event_id !== config.eventId) throw new HttpError(401, "unauthorized");
    return { team, idHash };
  }

  async function teamView(team) {
    const members = await store.listMembers(team.id);
    return {
      handle: team.handle,
      displayName: team.display_name,
      kind: team.kind,
      status: team.status,
      createdAt: team.created_at,
      activeAt: team.active_at,
      disqualified: Boolean(team.disqualified_at),
      dqReason: team.disqualified_at ? team.dq_reason : null,
      members: members.map((member) => ({
        mssv: member.mssv,
        fullName: member.full_name,
        email: maskEmail(member.email),
        role: member.role,
        status: member.status,
        showName: member.show_name === 1
      }))
    };
  }

  async function freeLapsedReservations(event, mssv, email) {
    await store.deleteStalePendingTeams(event.id, now() - PENDING_CAPTAIN_TTL_MS);
    await store.deleteLapsedInvitees(event.id, mssv, email, now());
  }

  async function inviteFor(token) {
    const invite = typeof token === "string" && token.length >= 20 && token.length <= 64 ? await store.getInvite(await sha256Hex(token)) : null;
    if (!invite || invite.event_id !== config.eventId) throw new HttpError(404, "invite_invalid");
    if (invite.accepted_at) throw new HttpError(409, "invite_used");
    if (now() >= invite.expires_at) throw new HttpError(410, "invite_expired");
    const member = await store.getMember(invite.event_id, invite.mssv);
    if (!member || member.team_id !== invite.team_id || member.status !== MEMBER_STATUS.PENDING) throw new HttpError(404, "invite_invalid");
    return { invite, member, team: await store.getTeam(invite.team_id) };
  }

  async function sendInvite({ event, team, member, inviter }) {
    const token = randomToken();
    await store.batch([
      store.statement("UPDATE invites SET expires_at = ? WHERE team_id = ? AND mssv = ? AND accepted_at IS NULL AND expires_at > ?", now(), team.id, member.mssv, now()),
      store.statement(
        "INSERT INTO invites (token_hash, event_id, team_id, mssv, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        await sha256Hex(token), event.id, team.id, member.mssv, now(), now() + INVITE_TTL_MS
      )
    ]);
    const link = `${config.webOrigin}/?view=bot-cup&invite=${encodeURIComponent(token)}`;
    await mailer.send({ to: member.email, ...inviteEmail({ eventName: event.name, teamName: team.display_name, fullName: member.full_name, inviter, link }) });
  }

  // ---------- handlers ----------

  async function getEvent() {
    const event = await loadEvent();
    return json({
      id: event.id,
      name: event.name,
      mode: event.mode,
      phase: event.phase,
      registrationOpen: registrationOpen(event, now()),
      registrationOpensAt: event.registrationOpensAt,
      registrationClosesAt: event.registrationClosesAt,
      practiceOpensAt: event.practiceOpensAt,
      codeFreezeAt: event.codeFreezeAt,
      finalsAt: event.finalsAt,
      eligibility: {
        mssvDigits: event.rules.mssvDigits,
        mssvPrefix: event.rules.mssvPrefix,
        emailDomain: event.rules.emailDomain,
        allowExternalEmail: event.rules.allowExternalEmail
      },
      turnstileSiteKey: config.turnstileSiteKey ?? null,
      serverTime: now()
    });
  }

  async function register(request) {
    const body = await readJson(request);
    await requireTurnstile(body, request);
    await limitIp(request, "register");
    const event = await loadEvent();
    requireOpen(event);

    if (!TEAM_KINDS.includes(body.kind)) throw new HttpError(400, "invalid_request", { field: "kind" });
    const { handle } = check(validateHandle(body.handle), "handle");
    const { displayName, key } = check(validateDisplayName(body.displayName), "displayName");
    check(validatePassword(body.password), "password");
    if (body.consent !== true) throw new HttpError(400, "consent_required", { field: "consent" });
    const { fullName } = check(validateFullName(body.captain?.fullName), "captain.fullName");
    const student = checkStudent({ mssv: body.captain?.mssv, email: body.captain?.email }, event.rules);
    if (!student.ok) throw new HttpError(400, student.error, { field: `captain.${student.field}` });

    await freeLapsedReservations(event, student.mssv, student.email);
    const conflict = await store.findConflict(event.id, { handle, displayKey: key, mssv: student.mssv, email: student.email });
    if (conflict) throw new HttpError(409, conflict);
    if ((await store.countOtpSince(student.email, now() - HOUR)) >= OTP_POLICY.maxSendsPerHour) throw new HttpError(429, "rate_limited");

    const team = {
      id: crypto.randomUUID(),
      handle,
      display_name: displayName,
      kind: body.kind
    };
    try {
      await store.batch([
        store.statement(
          `INSERT INTO teams (id, event_id, handle, display_name, display_key, kind, status, captain_mssv, password_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          team.id, event.id, handle, displayName, key, body.kind, TEAM_STATUS.PENDING_CAPTAIN, student.mssv, await hashPassword(body.password), now()
        ),
        store.statement(
          `INSERT INTO members (event_id, mssv, team_id, full_name, email, role, status, show_name, consent_at, created_at)
           VALUES (?, ?, ?, ?, ?, 'captain', 'pending', ?, ?, ?)`,
          event.id, student.mssv, team.id, fullName, student.email, body.showName === true ? 1 : 0, now(), now()
        )
      ]);
    } catch (error) {
      const code = uniqueViolation(error);
      if (code) throw new HttpError(409, code);
      throw error;
    }

    try {
      await sendOtp({ event, team, email: student.email, purpose: "register" });
    } catch (error) {
      await store.deleteTeam(team.id);
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, "email_unavailable");
    }
    return json({ handle, status: TEAM_STATUS.PENDING_CAPTAIN, otpSentTo: maskEmail(student.email) }, 201);
  }

  async function verifyRegistration(request) {
    const body = await readJson(request);
    await limitIp(request, "verify");
    const event = await loadEvent();
    requireOpen(event);
    const handle = validateHandle(body.handle);
    const team = handle.ok ? await store.getTeamByHandle(event.id, handle.handle) : null;
    if (!team || team.status !== TEAM_STATUS.PENDING_CAPTAIN) throw new HttpError(400, "otp_invalid");

    const consume = await consumeOtp(team, "register", body.otp);
    await store.batch([
      consume,
      store.statement("UPDATE teams SET verified_at = ? WHERE id = ?", now(), team.id),
      store.statement("UPDATE members SET status = 'confirmed', confirmed_at = ? WHERE event_id = ? AND mssv = ?", now(), event.id, team.captain_mssv)
    ]);
    const updated = await refreshTeamStatus(team.id);
    return json(await teamView(updated), 200, { "set-cookie": await startSession(updated, request) });
  }

  async function resendRegistration(request) {
    const body = await readJson(request);
    await requireTurnstile(body, request);
    const event = await loadEvent();
    requireOpen(event);
    const handle = validateHandle(body.handle);
    const team = handle.ok ? await store.getTeamByHandle(event.id, handle.handle) : null;
    if (!team || team.status !== TEAM_STATUS.PENDING_CAPTAIN) throw new HttpError(404, "not_found");
    const captain = await store.getMember(event.id, team.captain_mssv);
    try {
      await sendOtp({ event, team, email: captain.email, purpose: "register" });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, "email_unavailable");
    }
    return json({ otpSentTo: maskEmail(captain.email) }, 202);
  }

  async function login(request) {
    const body = await readJson(request);
    await requireTurnstile(body, request);
    await limitIp(request, "login");
    const event = await loadEvent();
    const handle = validateHandle(body.handle);
    const team = handle.ok ? await store.getTeamByHandle(event.id, handle.handle) : null;
    if (!team) throw new HttpError(401, "login_failed");

    const state = { failedLogins: team.failed_logins, lockedUntil: team.login_locked_until };
    if (loginLocked(state, now())) throw new HttpError(423, "login_locked", { retryAfterMs: team.login_locked_until - now() });
    if (typeof body.password !== "string" || !(await verifyPassword(body.password, team.password_hash))) {
      const next = afterFailedLogin(state, now());
      await store.setLoginState(team.id, next.failedLogins, next.lockedUntil);
      if (next.lockedUntil) throw new HttpError(423, "login_locked", { retryAfterMs: next.lockedUntil - now() });
      throw new HttpError(401, "login_failed");
    }
    await store.setLoginState(team.id, 0, null);
    if (team.status === TEAM_STATUS.PENDING_CAPTAIN) throw new HttpError(403, "verification_required");
    return json(await teamView(team), 200, { "set-cookie": await startSession(team, request) });
  }

  async function logout(request) {
    const idHash = await sessionHash(request);
    if (idHash) await store.deleteSession(idHash);
    return json({ ok: true }, 200, { "set-cookie": clearedSessionCookie() });
  }

  async function me(request) {
    const { team } = await requireTeam(request);
    return json(await teamView(team));
  }

  async function addMember(request) {
    const { team } = await requireTeam(request);
    const body = await readJson(request);
    const event = await loadEvent();
    requireOpen(event);
    const members = await store.listMembers(team.id);
    const blocked = cannotAddMember({ kind: team.kind, memberCount: members.length });
    if (blocked) throw new HttpError(409, blocked);
    const { fullName } = check(validateFullName(body.fullName), "fullName");
    const student = checkStudent({ mssv: body.mssv, email: body.email }, event.rules);
    if (!student.ok) throw new HttpError(400, student.error, { field: student.field });

    await freeLapsedReservations(event, student.mssv, student.email);
    const conflict = await store.findConflict(event.id, { mssv: student.mssv, email: student.email });
    if (conflict) throw new HttpError(409, conflict);
    try {
      await store.statement(
        `INSERT INTO members (event_id, mssv, team_id, full_name, email, role, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'member', 'pending', ?)`,
        event.id, student.mssv, team.id, fullName, student.email, now()
      ).run();
    } catch (error) {
      const code = uniqueViolation(error);
      if (code) throw new HttpError(409, code);
      throw error;
    }

    const member = { mssv: student.mssv, email: student.email, full_name: fullName };
    try {
      await sendInvite({ event, team, member, inviter: members.find((m) => m.role === "captain")?.full_name ?? team.display_name });
    } catch {
      await store.statement("DELETE FROM members WHERE event_id = ? AND mssv = ? AND status = 'pending'", event.id, student.mssv).run();
      throw new HttpError(503, "email_unavailable");
    }
    return json(await teamView(await refreshTeamStatus(team.id)), 201);
  }

  async function removeMember(request, mssvParam) {
    const { team } = await requireTeam(request);
    const event = await loadEvent();
    requireOpen(event);
    const mssv = normalizeMssv(mssvParam);
    const member = mssv ? await store.getMember(event.id, mssv) : null;
    if (!member || member.team_id !== team.id) throw new HttpError(404, "not_found");
    if (member.role === "captain") throw new HttpError(409, "captain_required");
    await store.batch([
      store.statement("DELETE FROM invites WHERE team_id = ? AND mssv = ?", team.id, mssv),
      store.statement("DELETE FROM members WHERE event_id = ? AND mssv = ?", event.id, mssv)
    ]);
    return json(await teamView(await refreshTeamStatus(team.id)));
  }

  async function resendInvite(request, mssvParam) {
    const { team } = await requireTeam(request);
    const event = await loadEvent();
    requireOpen(event);
    const mssv = normalizeMssv(mssvParam);
    const member = mssv ? await store.getMember(event.id, mssv) : null;
    if (!member || member.team_id !== team.id) throw new HttpError(404, "not_found");
    if (member.status !== MEMBER_STATUS.PENDING) throw new HttpError(409, "already_confirmed");
    if ((await store.countInvitesSince(event.id, mssv, now() - HOUR)) >= INVITE_MAX_SENDS_PER_HOUR) throw new HttpError(429, "rate_limited");
    const captain = await store.getMember(event.id, team.captain_mssv);
    try {
      await sendInvite({ event, team, member, inviter: captain?.full_name ?? team.display_name });
    } catch {
      throw new HttpError(503, "email_unavailable");
    }
    return json({ sentTo: maskEmail(member.email) }, 202);
  }

  async function previewInvite(token) {
    const event = await loadEvent();
    const { member, team } = await inviteFor(token);
    return json({
      eventName: event.name,
      teamName: team.display_name,
      fullName: member.full_name,
      email: maskEmail(member.email),
      registrationOpen: registrationOpen(event, now())
    });
  }

  async function acceptInvite(request) {
    const body = await readJson(request);
    const event = await loadEvent();
    requireOpen(event);
    const { invite, member, team } = await inviteFor(body.token);
    if (body.consent !== true) throw new HttpError(400, "consent_required", { field: "consent" });
    await store.batch([
      store.statement("UPDATE invites SET accepted_at = ? WHERE token_hash = ?", now(), invite.token_hash),
      store.statement(
        "UPDATE members SET status = 'confirmed', confirmed_at = ?, consent_at = ?, show_name = ? WHERE event_id = ? AND mssv = ?",
        now(), now(), body.showName === true ? 1 : 0, event.id, member.mssv
      )
    ]);
    const updated = await refreshTeamStatus(team.id);
    return json({ teamName: updated.display_name, status: updated.status });
  }

  async function requestReset(request) {
    const body = await readJson(request);
    await requireTurnstile(body, request);
    await limitIp(request, "reset");
    const event = await loadEvent();
    const handle = validateHandle(body.handle);
    const team = handle.ok ? await store.getTeamByHandle(event.id, handle.handle) : null;
    if (!team || team.status === TEAM_STATUS.PENDING_CAPTAIN) throw new HttpError(404, "not_found");
    const members = await store.listMembers(team.id);
    const requested = normalizeMssv(body.mssv);
    const recipient = members.find((m) => m.mssv === requested && m.status === MEMBER_STATUS.CONFIRMED) ?? members.find((m) => m.role === "captain");
    try {
      await sendOtp({ event, team, email: recipient.email, purpose: "reset" });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, "email_unavailable");
    }
    return json({ otpSentTo: maskEmail(recipient.email) }, 202);
  }

  async function confirmReset(request) {
    const body = await readJson(request);
    await limitIp(request, "verify");
    const event = await loadEvent();
    check(validatePassword(body.newPassword), "newPassword");
    const handle = validateHandle(body.handle);
    const team = handle.ok ? await store.getTeamByHandle(event.id, handle.handle) : null;
    if (!team) throw new HttpError(400, "otp_invalid");
    const consume = await consumeOtp(team, "reset", body.otp);
    await store.batch([
      consume,
      store.statement("UPDATE teams SET password_hash = ?, failed_logins = 0, login_locked_until = NULL WHERE id = ?", await hashPassword(body.newPassword), team.id),
      store.deleteSessionsOfTeam(team.id)
    ]);
    return json({ ok: true });
  }

  async function changePassword(request) {
    const { team, idHash } = await requireTeam(request);
    const body = await readJson(request);
    check(validatePassword(body.newPassword), "newPassword");
    if (typeof body.currentPassword !== "string" || !(await verifyPassword(body.currentPassword, team.password_hash))) {
      throw new HttpError(403, "password_mismatch");
    }
    await store.batch([
      store.statement("UPDATE teams SET password_hash = ? WHERE id = ?", await hashPassword(body.newPassword), team.id),
      store.deleteSessionsOfTeam(team.id, idHash)
    ]);
    return json({ ok: true });
  }

  async function revokeAllSessions(request) {
    const { team } = await requireTeam(request);
    await store.deleteSessionsOfTeam(team.id).run();
    return json({ ok: true }, 200, { "set-cookie": clearedSessionCookie() });
  }

  async function devOutbox(request, url) {
    const auth = request.headers.get("authorization") || "";
    if (!config.devToken || !sameDigest(await sha256Hex(auth), await sha256Hex(`Bearer ${config.devToken}`))) throw new HttpError(404, "not_found");
    const to = (url.searchParams.get("to") || "").toLowerCase();
    return json({ messages: await store.readOutbox(to) });
  }

  // ---------- submissions (plan §6, P3) ----------

  function submissionView(row) {
    return {
      id: row.id,
      version: row.seq,
      language: row.language,
      filename: row.filename,
      size: row.size,
      sha256: row.sha256,
      origin: row.origin,
      status: row.status,
      createdAt: row.created_at
    };
  }

  async function requireActiveTeam(request) {
    const { team } = await requireTeam(request);
    if (team.status !== TEAM_STATUS.ACTIVE) throw new HttpError(403, "team_not_active");
    if (team.disqualified_at) throw new HttpError(403, "team_disqualified");
    return team;
  }

  async function ownSubmission(team, id) {
    const submission = typeof id === "string" && id.length <= 64 ? await store.getSubmission(id) : null;
    // Another team's submission answers exactly like a missing one.
    if (!submission || submission.team_id !== team.id) throw new HttpError(404, "not_found");
    return submission;
  }

  async function submissionsOf(team) {
    const event = await loadEvent();
    const fresh = await store.getTeam(team.id);
    const rows = await store.listSubmissions(team.id);
    const final = effectiveFinalSubmission(rows, fresh.final_submission_id);
    const dayStart = vietnamDayStart(now());
    const closed = fresh.status === TEAM_STATUS.ACTIVE ? submissionWindow(event, now()) : "team_not_active";
    return json({
      submissions: rows.map(submissionView),
      finalSubmissionId: final?.id ?? null,
      finalChosen: Boolean(final && final.id === fresh.final_submission_id),
      window: {
        open: closed === null,
        reason: closed,
        practiceOpensAt: event.practiceOpensAt,
        codeFreezeAt: event.codeFreezeAt,
        finalLocked: finalSubmissionLocked(event, now())
      },
      quota: {
        perDay: SUBMISSION_POLICY.perDay,
        usedToday: rows.filter((row) => row.created_at >= dayStart).length,
        resetsAt: dayStart + DAY,
        maxVersions: SUBMISSION_POLICY.maxVersions,
        total: rows.length
      },
      maxBytes: SUBMISSION_POLICY.maxBytes
    });
  }

  async function listSubmissions(request) {
    const { team } = await requireTeam(request);
    return submissionsOf(team);
  }

  /** Flags a submission whose normalised source equals another team's or a public reference file (plan §8.5). */
  async function flagCopies(event, team, submissionId, normalizedHash) {
    const flags = [];
    const reference = REFERENCE_HASHES.get(normalizedHash);
    if (reference) flags.push({ other: null, reference });
    for (const match of await store.normalizedMatches(event.id, team.id, normalizedHash)) flags.push({ other: match.id, reference: null });
    if (!flags.length) return;
    await store.batch(flags.map((flag) => store.statement(
      `INSERT INTO similarity_flags (id, event_id, kind, submission_id, other_submission_id, reference, score, created_at)
       VALUES (?, ?, 'hash', ?, ?, ?, 1, ?)`,
      crypto.randomUUID(), event.id, submissionId, flag.other, flag.reference, now()
    )));
  }

  async function createSubmission(request) {
    const team = await requireActiveTeam(request);
    const event = await loadEvent();
    const closed = submissionWindow(event, now());
    if (closed) throw new HttpError(409, closed);

    const upload = await readUpload(request, SUBMISSION_POLICY.maxBytes + UPLOAD_OVERHEAD_BYTES);
    const source = inspectSource(upload.bytes, upload.filename);
    if (!source.ok) throw new HttpError(source.error === "submission_too_large" ? 413 : 400, source.error, { field: "file" });
    const sha256 = await sha256Hex(upload.bytes);
    const existing = await store.findSubmissionBySha(team.id, sha256);
    if (existing) throw new HttpError(409, "submission_duplicate", { version: existing.seq });
    const normalizedHash = await sha256Hex(normalizeSource(source.text, source.language));

    const id = crypto.randomUUID();
    const dayStart = vietnamDayStart(now());
    let results;
    try {
      // The limits are checked inside the INSERT, so two uploads racing each other cannot both slip past them.
      results = await store.batch([
        store.statement(
          `INSERT INTO submissions (id, event_id, team_id, seq, language, filename, size, sha256, normalized_hash, created_at)
           SELECT ?, ?, ?, stats.next_seq, ?, ?, ?, ?, ?, ?
           FROM (SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq, COUNT(*) AS total,
                        COUNT(CASE WHEN created_at >= ? THEN 1 END) AS today
                 FROM submissions WHERE team_id = ?) AS stats
           WHERE stats.total < ? AND stats.today < ?`,
          id, event.id, team.id, source.language, source.filename, upload.bytes.length, sha256, normalizedHash, now(),
          dayStart, team.id, SUBMISSION_POLICY.maxVersions, SUBMISSION_POLICY.perDay
        ),
        store.statement(
          `INSERT OR IGNORE INTO submission_sources (sha256, content, size, created_at)
           SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ?)`,
          sha256, upload.bytes, upload.bytes.length, now(), id
        ),
        // The runner checks syntax in the container, then plays the smoke test (P4).
        enqueueCheck(store, { eventId: event.id, submissionId: id, now: now() })
      ]);
    } catch (error) {
      const code = uniqueViolation(error);
      if (code) throw new HttpError(409, code);
      throw error;
    }
    if (!results[0]?.meta?.changes) {
      const counts = await store.countSubmissions(team.id, dayStart);
      if (counts.total >= SUBMISSION_POLICY.maxVersions) throw new HttpError(409, "submission_version_limit");
      throw new HttpError(429, "submission_daily_limit", { retryAfterMs: dayStart + DAY - now() });
    }

    try {
      await flagCopies(event, team, id, normalizedHash);
    } catch (error) {
      // The submission is stored; a missing flag only weakens a later review, so the upload still succeeds.
      console.error(JSON.stringify({ event: "bot_cup_flag_failed", submissionId: id, message: String(error?.message || error) }));
    }
    return json({ submission: submissionView(await store.getSubmission(id)) }, 201);
  }

  async function getSubmission(request, id) {
    const { team } = await requireTeam(request);
    const submission = await ownSubmission(team, id);
    const smoke = (await store.smokeMatches(submission.id)).map((match) => {
      const seat = match.a_submission_id === submission.id ? "A" : "B";
      return {
        id: match.id,
        mapId: match.map_id,
        seat,
        opponent: seat === "A" ? match.b_house : match.a_house,
        status: match.status,
        outcome: match.outcome,
        winner: match.winner,
        reason: match.reason,
        plies: match.plies,
        // Only this team's own bot's stderr (plan §4.1); the opponent here is a house bot anyway.
        stderr: seat === "A" ? match.stderr_a : match.stderr_b
      };
    });
    return json({ submission: { ...submissionView(submission), checkLog: submission.check_log ?? null, smoke } });
  }

  async function getSubmissionSource(request, id) {
    const { team } = await requireTeam(request);
    const submission = await ownSubmission(team, id);
    const bytes = await store.getSourceBytes(submission.sha256);
    if (!bytes) throw new HttpError(404, "not_found");
    const extension = submission.language === "python" ? "py" : "mjs";
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="${team.handle}-v${submission.seq}.${extension}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      }
    });
  }

  async function chooseFinalSubmission(request) {
    const team = await requireActiveTeam(request);
    const body = await readJson(request);
    const event = await loadEvent();
    if (finalSubmissionLocked(event, now())) throw new HttpError(409, "code_frozen");
    if (body.submissionId === null) {
      await store.setFinalSubmission(team.id, null);
      return submissionsOf(team);
    }
    const submission = await ownSubmission(team, body.submissionId);
    if (!FINAL_ELIGIBLE_STATUSES.includes(submission.status)) throw new HttpError(409, "submission_not_eligible");
    await store.setFinalSubmission(team.id, submission.id);
    return submissionsOf(team);
  }

  // ---------- practice, games, replays, leaderboard (plan §7.1, §11.2, P5) ----------

  /** The current session's team, or null for a guest; never throws for a missing session. */
  async function optionalTeam(request) {
    const idHash = await sessionHash(request);
    const team = idHash ? await store.getSessionTeam(idHash, now()) : null;
    return team && team.event_id === config.eventId ? team : null;
  }

  function seatName(match, side) {
    const house = match[`${side}_house`];
    if (house) return { kind: "house", name: HOUSE_BOT_LABELS[house] ?? house, house };
    return { kind: "team", name: match[`${side}_team_name`], version: match[`${side}_seq`] };
  }

  function mySeats(match, teamId) {
    return ["A", "B"].filter((seat) => teamId && match[`${seat.toLowerCase()}_team_id`] === teamId);
  }

  function matchView(match, teamId) {
    const mine = mySeats(match, teamId);
    return {
      id: match.id,
      stage: match.stage,
      round: match.round,
      gameIndex: match.game_index,
      mapId: match.map_id,
      status: match.status,
      seats: { A: seatName(match, "a"), B: seatName(match, "b") },
      mySeat: mine.length === 1 ? mine[0] : null,
      outcome: match.outcome,
      winner: match.winner,
      reason: match.reason,
      plies: match.plies,
      createdAt: match.created_at,
      finishedAt: match.finished_at
    };
  }

  /** Official games are public (plan §8.8); smoke and practice games only to the team that played them. */
  async function visibleMatch(request, id) {
    const match = typeof id === "string" && id.length <= 64 ? await store.getMatchWithTeams(id) : null;
    if (!match || match.event_id !== config.eventId) throw new HttpError(404, "not_found");
    const team = await optionalTeam(request);
    if (!PUBLIC_STAGES.includes(match.stage) && mySeats(match, team?.id).length === 0) throw new HttpError(404, "not_found");
    return { match, team };
  }

  async function requestPractice(request) {
    const team = await requireActiveTeam(request);
    const body = await readJson(request);
    const event = await loadEvent();
    const closed = submissionWindow(event, now());
    if (closed) throw new HttpError(409, closed);
    const practice = validatePracticeRequest(body);
    if (!practice.ok) throw new HttpError(400, practice.error, { field: practice.error === "practice_map_invalid" ? "mapId" : "opponent" });

    const fresh = await store.getTeam(team.id);
    const rows = await store.listSubmissions(team.id);
    const submission = body.submissionId ? rows.find((row) => row.id === body.submissionId) : effectiveFinalSubmission(rows, fresh.final_submission_id);
    if (!submission) throw new HttpError(409, "practice_no_submission");
    if (submission.status !== SUBMISSION_STATUS.READY) throw new HttpError(409, "practice_not_ready");

    const dayStart = vietnamDayStart(now());
    const { matchIds, statements } = enqueuePractice(store, {
      eventId: event.id,
      teamId: team.id,
      games: practiceGames(submission.id, practice.opponent, practice.mapId),
      dayStart,
      gamesPerDay: PRACTICE_POLICY.gamesPerDay,
      now: now()
    });
    const results = await store.batch(statements);
    if (!results[0]?.meta?.changes) throw new HttpError(429, "practice_daily_limit", { retryAfterMs: dayStart + DAY - now() });
    const matches = await Promise.all(matchIds.map((id) => store.getMatchWithTeams(id)));
    return json({ matches: matches.map((match) => matchView(match, team.id)) }, 201);
  }

  async function listMyMatches(request) {
    const { team } = await requireTeam(request);
    const dayStart = vietnamDayStart(now());
    const matches = await store.teamMatches(team.id);
    return json({
      matches: matches.map((match) => matchView(match, team.id)),
      practice: {
        gamesPerDay: PRACTICE_POLICY.gamesPerDay,
        usedToday: matches.filter((match) => match.requested_by_team === team.id && match.created_at >= dayStart).length,
        opponents: PRACTICE_OPPONENTS.map((id) => ({ id, name: HOUSE_BOT_LABELS[id] })),
        maps: MAPS
      }
    });
  }

  async function getMatch(request, id) {
    const { match, team } = await visibleMatch(request, id);
    const view = matchView(match, team?.id);
    // A team reads its own bot's stderr, never the opponent's (plan §4.1).
    const stderr = Object.fromEntries(mySeats(match, team?.id).map((seat) => [seat, match[`stderr_${seat.toLowerCase()}`] ?? ""]));
    return json({ match: { ...view, stderr } });
  }

  async function getMatchReplay(request, id) {
    const { match } = await visibleMatch(request, id);
    if (match.status !== "finished" || !match.replay_gz) throw new HttpError(404, "not_found");
    const compact = JSON.parse(await gunzipText(new Uint8Array(match.replay_gz)));
    const label = (side) => {
      const seat = seatName(match, side);
      return seat.kind === "house" ? seat.name : `${seat.name} (v${seat.version})`;
    };
    const document = await expandReplay(compact, {
      matchId: match.id,
      participants: {
        A: { botId: match.a_submission_id ?? `house-${match.a_house}`, name: label("a") },
        B: { botId: match.b_submission_id ?? `house-${match.b_house}`, name: label("b") }
      }
    });
    return json({ replay: document, sha256: match.replay_sha256 });
  }

  /** Public practice leaderboard: each active team's current final submission against the house bots. */
  async function leaderboard() {
    const submissions = await store.activeTeamSubmissions(config.eventId);
    const byTeam = new Map();
    for (const row of submissions) {
      const team = byTeam.get(row.team_id) ?? { displayName: row.display_name, finalId: row.final_submission_id, rows: [] };
      team.rows.push(row);
      byTeam.set(row.team_id, team);
    }
    const finalOwner = new Map();
    for (const [teamId, team] of byTeam) {
      const final = effectiveFinalSubmission(team.rows, team.finalId);
      if (final) finalOwner.set(final.id, { teamId, displayName: team.displayName });
    }
    const games = [];
    for (const game of await store.finishedPractice(config.eventId)) {
      const seat = finalOwner.has(game.a_submission_id) ? "A" : finalOwner.has(game.b_submission_id) ? "B" : null;
      if (!seat) continue;
      const owner = finalOwner.get(seat === "A" ? game.a_submission_id : game.b_submission_id);
      games.push({ ...owner, opponent: seat === "A" ? game.b_house : game.a_house, points: gamePoints(game, seat) });
    }
    return json({
      opponents: PRACTICE_OPPONENTS.map((id) => ({ id, name: HOUSE_BOT_LABELS[id] })),
      rows: practiceLeaderboard(games).map(({ teamId, ...row }, index) => ({ rank: index + 1, ...row })),
      updatedAt: now()
    });
  }

  /** Announcements the organisers published (plan §4.1), newest first. Public. */
  async function announcements() {
    const rows = await store.statement(
      "SELECT id, title, body, published_at FROM announcements WHERE event_id = ? AND published_at IS NOT NULL AND withdrawn_at IS NULL ORDER BY published_at DESC LIMIT 20",
      config.eventId
    ).all();
    return json({ announcements: rows.results.map((row) => ({ id: row.id, title: row.title, body: row.body, publishedAt: row.published_at })) });
  }

  // ---------- routing ----------

  const routes = [
    ["GET", /^\/event$/, () => getEvent()],
    ["POST", /^\/register$/, (request) => register(request)],
    ["POST", /^\/register\/verify$/, (request) => verifyRegistration(request)],
    ["POST", /^\/register\/resend$/, (request) => resendRegistration(request)],
    ["POST", /^\/login$/, (request) => login(request)],
    ["POST", /^\/logout$/, (request) => logout(request)],
    ["GET", /^\/me$/, (request) => me(request)],
    ["POST", /^\/team\/members$/, (request) => addMember(request)],
    ["DELETE", /^\/team\/members\/([^/]+)$/, (request, match) => removeMember(request, decodeURIComponent(match[1]))],
    ["POST", /^\/team\/members\/([^/]+)\/resend$/, (request, match) => resendInvite(request, decodeURIComponent(match[1]))],
    ["GET", /^\/invites\/([A-Za-z0-9_-]+)$/, (request, match) => previewInvite(match[1])],
    ["POST", /^\/invites\/accept$/, (request) => acceptInvite(request)],
    ["POST", /^\/password\/reset\/request$/, (request) => requestReset(request)],
    ["POST", /^\/password\/reset\/confirm$/, (request) => confirmReset(request)],
    ["POST", /^\/password\/change$/, (request) => changePassword(request)],
    ["POST", /^\/sessions\/revoke-all$/, (request) => revokeAllSessions(request)],
    ["GET", /^\/submissions$/, (request) => listSubmissions(request)],
    ["POST", /^\/submissions$/, (request) => createSubmission(request)],
    ["GET", /^\/submissions\/([A-Za-z0-9-]+)$/, (request, match) => getSubmission(request, match[1])],
    ["GET", /^\/submissions\/([A-Za-z0-9-]+)\/source$/, (request, match) => getSubmissionSource(request, match[1])],
    ["PUT", /^\/team\/final-submission$/, (request) => chooseFinalSubmission(request)],
    ["POST", /^\/practice$/, (request) => requestPractice(request)],
    ["GET", /^\/matches$/, (request) => listMyMatches(request)],
    ["GET", /^\/matches\/([A-Za-z0-9-]+)$/, (request, match) => getMatch(request, match[1])],
    ["GET", /^\/matches\/([A-Za-z0-9-]+)\/replay$/, (request, match) => getMatchReplay(request, match[1])],
    ["GET", /^\/leaderboard$/, () => leaderboard()],
    ["GET", /^\/announcements$/, () => announcements()],
    ["GET", /^\/_dev\/outbox$/, (request, match, url) => devOutbox(request, url)]
  ];

  const runnerApi = createRunnerApi({ store, now, eventId: config.eventId, expectedImageId: config.runnerImageId ?? null });

  return {
    async fetch(request) {
      const url = new URL(request.url);
      // Runners call the Worker directly (not through the Vercel rewrite) with a bearer token; no cookies, no Origin.
      if (url.pathname.startsWith("/runner/")) {
        try {
          return await runnerApi.fetch(request, url.pathname);
        } catch (error) {
          if (error instanceof HttpError) return errorResponse(error);
          console.error(JSON.stringify({ event: "bot_cup_runner_api_error", path: url.pathname, message: String(error?.message || error) }));
          return json({ error: "internal_error" }, 500);
        }
      }
      if (!url.pathname.startsWith(`${PREFIX}/`)) return json({ error: "not_found" }, 404);
      const path = url.pathname.slice(PREFIX.length);
      try {
        const candidates = routes.filter(([, pattern]) => pattern.test(path));
        if (candidates.length === 0) throw new HttpError(404, "not_found");
        const route = candidates.find(([method]) => method === request.method);
        if (!route) throw new HttpError(405, "method_not_allowed");
        // Every write must come from the site itself (plan §5.3); the session cookie is SameSite=Strict as well.
        if (request.method !== "GET" && !config.allowedOrigins.includes(request.headers.get("origin") || "")) {
          throw new HttpError(403, "forbidden_origin");
        }
        return await route[2](request, path.match(route[1]), url);
      } catch (error) {
        if (error instanceof HttpError) return errorResponse(error);
        console.error(JSON.stringify({ event: "bot_cup_api_error", path, message: String(error?.message || error) }));
        return json({ error: "internal_error" }, 500);
      }
    }
  };
}
