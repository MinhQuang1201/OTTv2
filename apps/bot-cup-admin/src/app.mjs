/**
 * Bot Cup admin API (plan §4.2, §8.8, §10.4, §11.4), served at /admin-api on its own hostname, never linked from the player
 * site. Every write adds exactly one hash-chained audit row in the same D1 batch as the change, so either both happen or
 * neither. Disqualifying a team and changing a game result wait for a second admin.
 *
 * Dependencies are injected so the Worker and Node tests run the same code:
 *   db, now, config { eventId, authMode: "access"|"password", access?: { teamDomain, aud }, allowedOrigins: string[] },
 *   fetchImpl (Access certs)
 */
import {
  AUDIT_GENESIS,
  FOUR_EYES_ACTIONS,
  HOUSE_BOT_LABELS,
  JOB_POLICY,
  auditHash,
  deriveTeamStatus,
  effectiveFinalSubmission,
  toCsv,
  validateDisplayName,
  verifyAuditChain
} from "../../../packages/bot-cup-core/src/index.mjs";
import { HttpError, errorResponse, json, readCookie, readJson } from "../../bot-cup-api/src/http.mjs";
import { enqueueCheck, enqueueMatch } from "../../bot-cup-api/src/queue.mjs";
import { randomToken, sha256Hex, verifyPassword } from "../../bot-cup-api/src/security.mjs";
import { createStore } from "../../bot-cup-api/src/store.mjs";
import { AuthError, verifyAccessJwt, verifyTotp } from "./auth.mjs";
import { tournamentRoutes } from "./tournament-routes.mjs";

const PREFIX = "/admin-api";
export const ADMIN_COOKIE = "__Host-ottcup_admin";
const SESSION_MS = 12 * 60 * 60 * 1000;
const LOGIN_LOCK = Object.freeze({ maxFailures: 5, lockMs: 15 * 60 * 1000 });
const ONLINE_MS = 2 * 60 * 1000;
const REASON_MAX = 500;

export function createAdminApi({ db, now, config, fetchImpl = fetch }) {
  const store = createStore(db);
  const first = (sql, ...args) => store.statement(sql, ...args).first();
  const all = async (sql, ...args) => (await store.statement(sql, ...args).all()).results;
  const accessCache = new Map();

  // ---------- identity ----------

  async function adminByEmail(email) {
    const admin = await first("SELECT * FROM admins WHERE email = ? AND disabled_at IS NULL", email);
    if (!admin) throw new HttpError(403, "not_an_admin");
    return admin;
  }

  async function identify(request) {
    if (config.authMode === "access") {
      try {
        const email = await verifyAccessJwt(request.headers.get("cf-access-jwt-assertion"), { ...config.access, now, fetchImpl, cache: accessCache });
        return adminByEmail(email);
      } catch (error) {
        if (error instanceof AuthError) throw new HttpError(401, error.code);
        throw error;
      }
    }
    const token = readCookie(request, ADMIN_COOKIE);
    const session = token ? await first("SELECT * FROM admin_sessions WHERE id_hash = ? AND expires_at > ?", await sha256Hex(token), now()) : null;
    if (!session) throw new HttpError(401, "unauthorized");
    return adminByEmail(session.email);
  }

  function requireWriter(admin) {
    if (admin.role !== "admin") throw new HttpError(403, "read_only");
  }

  function reasonOf(body, required = true) {
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, REASON_MAX) : "";
    if (required && reason.length < 3) throw new HttpError(400, "reason_required", { field: "reason" });
    return reason || null;
  }

  /**
   * Runs `statements` and appends the audit row in one batch. Two admins writing at once both read the same chain head;
   * UNIQUE(prev_hash) rejects the second, which then retries on the new head.
   */
  async function audited(admin, { action, target = null, reason = null, payload = {} }, statements = []) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const head = await first("SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1");
      const row = { prev_hash: head?.hash ?? AUDIT_GENESIS, at: now(), actor_email: admin.email, action, target, reason, payload_json: JSON.stringify(payload) };
      row.hash = await auditHash(row);
      try {
        await store.batch([
          ...statements,
          store.statement(
            "INSERT INTO audit_log (at, actor_email, action, target, reason, payload_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            row.at, row.actor_email, row.action, row.target, row.reason, row.payload_json, row.prev_hash, row.hash
          )
        ]);
        return row;
      } catch (error) {
        if (!String(error?.message || error).includes("audit_log.prev_hash")) throw error;
      }
    }
    throw new HttpError(503, "audit_busy");
  }

  // ---------- session (password mode) ----------

  async function login(request) {
    if (config.authMode !== "password") throw new HttpError(404, "not_found");
    const body = await readJson(request);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const admin = email ? await first("SELECT * FROM admins WHERE email = ? AND disabled_at IS NULL", email) : null;
    if (!admin || !admin.password_hash || !admin.totp_secret) throw new HttpError(401, "login_failed");
    if (admin.login_locked_until && now() < admin.login_locked_until) throw new HttpError(423, "login_locked");
    const passwordOk = typeof body.password === "string" && (await verifyPassword(body.password, admin.password_hash));
    const totpOk = passwordOk && (await verifyTotp(admin.totp_secret, String(body.totp ?? "").trim(), now()));
    if (!totpOk) {
      const failures = admin.failed_logins + 1;
      const locked = failures >= LOGIN_LOCK.maxFailures;
      await store.statement("UPDATE admins SET failed_logins = ?, login_locked_until = ? WHERE email = ?", locked ? 0 : failures, locked ? now() + LOGIN_LOCK.lockMs : null, email).run();
      throw new HttpError(401, "login_failed");
    }
    const token = randomToken();
    await audited(admin, { action: "admin.login" }, [
      store.statement("UPDATE admins SET failed_logins = 0, login_locked_until = NULL WHERE email = ?", email),
      store.statement("INSERT INTO admin_sessions (id_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)", await sha256Hex(token), email, now(), now() + SESSION_MS)
    ]);
    return json({ email, role: admin.role }, 200, {
      "set-cookie": `${ADMIN_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`
    });
  }

  async function logout(request) {
    const token = readCookie(request, ADMIN_COOKIE);
    if (token) await store.statement("DELETE FROM admin_sessions WHERE id_hash = ?", await sha256Hex(token)).run();
    return json({ ok: true }, 200, { "set-cookie": `${ADMIN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
  }

  // ---------- overview ----------

  async function overview() {
    const event = await store.getEvent(config.eventId);
    const count = async (sql, ...args) => (await first(sql, ...args))?.n ?? 0;
    const grouped = async (sql, ...args) => Object.fromEntries((await all(sql, ...args)).map((row) => [row.k, row.n]));
    return json({
      event,
      serverTime: now(),
      teams: await grouped("SELECT status AS k, COUNT(*) AS n FROM teams WHERE event_id = ? GROUP BY status", config.eventId),
      disqualifiedTeams: await count("SELECT COUNT(*) AS n FROM teams WHERE event_id = ? AND disqualified_at IS NOT NULL", config.eventId),
      submissions: await grouped("SELECT status AS k, COUNT(*) AS n FROM submissions WHERE event_id = ? GROUP BY status", config.eventId),
      submissionsLast24h: await count("SELECT COUNT(*) AS n FROM submissions WHERE event_id = ? AND created_at > ?", config.eventId, now() - 86_400_000),
      jobs: await grouped("SELECT status AS k, COUNT(*) AS n FROM jobs WHERE event_id = ? GROUP BY status", config.eventId),
      runnersOnline: await count("SELECT COUNT(*) AS n FROM runners WHERE revoked_at IS NULL AND last_seen_at > ?", now() - ONLINE_MS),
      alerts: {
        suspectRunners: await count("SELECT COUNT(*) AS n FROM runners WHERE suspect_at IS NOT NULL AND revoked_at IS NULL"),
        failedJobs: await count("SELECT COUNT(*) AS n FROM jobs WHERE event_id = ? AND status = 'failed'", config.eventId),
        openFlags: await count("SELECT COUNT(*) AS n FROM similarity_flags WHERE event_id = ? AND status = 'open'", config.eventId),
        pendingApprovals: await count("SELECT COUNT(*) AS n FROM pending_actions WHERE status = 'pending'")
      }
    });
  }

  // ---------- teams ----------

  async function teamOr404(id) {
    const team = await first("SELECT * FROM teams WHERE id = ? AND event_id = ?", id, config.eventId);
    if (!team) throw new HttpError(404, "not_found");
    return team;
  }

  async function listTeams() {
    const teams = await all(
      `SELECT t.id, t.handle, t.display_name, t.kind, t.status, t.created_at, t.active_at, t.disqualified_at, t.dq_reason,
              (SELECT COUNT(*) FROM members m WHERE m.team_id = t.id) AS members,
              (SELECT COUNT(*) FROM submissions s WHERE s.team_id = t.id) AS submissions
       FROM teams t WHERE t.event_id = ? ORDER BY t.created_at`,
      config.eventId
    );
    return json({ teams });
  }

  async function getTeam(id) {
    const team = await teamOr404(id);
    const { password_hash: _password, ...safe } = team;
    const members = await all("SELECT mssv, full_name, email, role, status, show_name, consent_at, confirmed_at FROM members WHERE team_id = ? ORDER BY role = 'captain' DESC, created_at", id);
    const submissions = await store.listSubmissions(id);
    const final = effectiveFinalSubmission(submissions, team.final_submission_id);
    return json({ team: safe, members, submissions, finalSubmissionId: final?.id ?? null });
  }

  async function renameTeam(request, admin, id) {
    requireWriter(admin);
    const body = await readJson(request);
    const team = await teamOr404(id);
    const reason = reasonOf(body);
    const name = validateDisplayName(body.displayName);
    if (!name.ok) throw new HttpError(400, name.error, { field: "displayName" });
    const clash = await first("SELECT id FROM teams WHERE event_id = ? AND display_key = ? AND id <> ?", config.eventId, name.key, id);
    if (clash) throw new HttpError(409, "display_name_taken");
    await audited(admin, { action: "team.rename", target: `team:${id}`, reason, payload: { from: team.display_name, to: name.displayName } }, [
      store.statement("UPDATE teams SET display_name = ?, display_key = ? WHERE id = ?", name.displayName, name.key, id)
    ]);
    return json({ ok: true });
  }

  /** Manual verification when a student's school email does not arrive (plan §5.4). */
  async function confirmMember(request, admin, id, mssv) {
    requireWriter(admin);
    const body = await readJson(request);
    const reason = reasonOf(body);
    const team = await teamOr404(id);
    const member = await first("SELECT * FROM members WHERE team_id = ? AND mssv = ?", id, mssv);
    if (!member) throw new HttpError(404, "not_found");
    if (member.status === "confirmed") throw new HttpError(409, "already_confirmed");
    const statements = [store.statement("UPDATE members SET status = 'confirmed', confirmed_at = ? WHERE team_id = ? AND mssv = ?", now(), id, mssv)];
    if (member.role === "captain") statements.push(store.statement("UPDATE teams SET verified_at = COALESCE(verified_at, ?) WHERE id = ?", now(), id));
    await audited(admin, { action: "member.confirm_manual", target: `team:${id}/member:${mssv}`, reason }, statements);
    // The team status follows from its members, the same rule the player API uses.
    const members = await all("SELECT role, status FROM members WHERE team_id = ?", id);
    const fresh = await teamOr404(id);
    const status = deriveTeamStatus({ kind: team.kind, captainVerified: fresh.verified_at !== null, members });
    if (status !== fresh.status) await store.setTeamStatus(id, status, status === "active" ? fresh.active_at ?? now() : null);
    return json({ ok: true, status });
  }

  // ---------- two-person actions ----------

  async function requestAction(admin, { action, target, payload, reason }) {
    const id = crypto.randomUUID();
    await audited(admin, { action: `${action}.request`, target, reason, payload: { pendingId: id, ...payload } }, [
      store.statement(
        "INSERT INTO pending_actions (id, action, target, payload_json, reason, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id, action, target, JSON.stringify(payload), reason, admin.email, now()
      )
    ]);
    return json({ pendingId: id, status: "pending" }, 202);
  }

  async function disqualifyTeam(request, admin, id) {
    requireWriter(admin);
    const body = await readJson(request);
    const reason = reasonOf(body);
    const team = await teamOr404(id);
    if (team.disqualified_at) throw new HttpError(409, "already_disqualified");
    return requestAction(admin, { action: "team.disqualify", target: `team:${id}`, payload: { teamId: id, handle: team.handle }, reason });
  }

  async function setMatchResult(request, admin, id) {
    requireWriter(admin);
    const body = await readJson(request);
    const reason = reasonOf(body);
    const match = await first("SELECT * FROM matches WHERE id = ? AND event_id = ?", id, config.eventId);
    if (!match) throw new HttpError(404, "not_found");
    const outcome = body.outcome;
    const winner = outcome === "draw" ? null : body.winner;
    if (!["win", "draw", "forfeit"].includes(outcome) || (outcome !== "draw" && !["A", "B"].includes(winner))) throw new HttpError(400, "invalid_request", { field: "outcome" });
    return requestAction(admin, {
      action: "match.set_result",
      target: `match:${id}`,
      payload: { matchId: id, outcome, winner, loser: winner ? (winner === "A" ? "B" : "A") : null, resultReason: body.resultReason ?? "admin_decision", before: { outcome: match.outcome, winner: match.winner, reason: match.reason } },
      reason
    });
  }

  function executeStatements(pending, payload) {
    if (pending.action === "team.disqualify") {
      return [store.statement("UPDATE teams SET disqualified_at = ?, dq_reason = ? WHERE id = ? AND disqualified_at IS NULL", now(), pending.reason, payload.teamId)];
    }
    if (pending.action === "match.set_result") {
      return [store.statement(
        "UPDATE matches SET status = 'finished', outcome = ?, winner = ?, loser = ?, reason = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?",
        payload.outcome, payload.winner, payload.loser, payload.resultReason, now(), payload.matchId
      )];
    }
    throw new HttpError(400, "invalid_request");
  }

  async function decide(request, admin, id, approve) {
    requireWriter(admin);
    const body = await readJson(request);
    const pending = await first("SELECT * FROM pending_actions WHERE id = ?", id);
    if (!pending) throw new HttpError(404, "not_found");
    if (pending.status !== "pending") throw new HttpError(409, "already_decided");
    // Four eyes: the admin who asked cannot be the one who approves (also a CHECK in the table).
    if (pending.requested_by === admin.email) throw new HttpError(403, "same_admin");
    const payload = JSON.parse(pending.payload_json);
    const statements = [store.statement(
      "UPDATE pending_actions SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
      approve ? "approved" : "rejected", admin.email, now(), id
    )];
    if (approve) statements.push(...executeStatements(pending, payload));
    await audited(admin, { action: `${pending.action}.${approve ? "approve" : "reject"}`, target: pending.target, reason: reasonOf(body, false), payload: { pendingId: id } }, statements);
    return json({ ok: true, status: approve ? "approved" : "rejected" });
  }

  async function listPending() {
    return json({ pending: await all("SELECT * FROM pending_actions ORDER BY status = 'pending' DESC, requested_at DESC LIMIT 100") });
  }

  // ---------- submissions, flags ----------

  async function listSubmissions(url) {
    const status = url.searchParams.get("status");
    const rows = await all(
      `SELECT s.id, s.team_id, t.handle, t.display_name, s.seq, s.language, s.filename, s.size, s.sha256, s.normalized_hash, s.status,
              s.created_at, (SELECT COUNT(*) FROM similarity_flags f WHERE f.submission_id = s.id AND f.status = 'open') AS open_flags
       FROM submissions s JOIN teams t ON t.id = s.team_id
       WHERE s.event_id = ? AND (? IS NULL OR s.status = ?) ORDER BY s.created_at DESC LIMIT 500`,
      config.eventId, status, status
    );
    return json({ submissions: rows });
  }

  async function submissionOr404(id) {
    const submission = await first("SELECT * FROM submissions WHERE id = ? AND event_id = ?", id, config.eventId);
    if (!submission) throw new HttpError(404, "not_found");
    return submission;
  }

  async function submissionSource(admin, id) {
    const submission = await submissionOr404(id);
    const bytes = await store.getSourceBytes(submission.sha256);
    if (!bytes) throw new HttpError(404, "not_found");
    // Reading a team's code is logged too (plan §8.8: everything an admin does is on the record).
    await audited(admin, { action: "submission.view_source", target: `submission:${id}` });
    return new Response(bytes, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  }

  async function recheckSubmission(request, admin, id) {
    requireWriter(admin);
    const body = await readJson(request);
    const reason = reasonOf(body);
    const submission = await submissionOr404(id);
    await audited(admin, { action: "submission.recheck", target: `submission:${id}`, reason, payload: { from: submission.status } }, [
      store.statement("UPDATE submissions SET status = 'checking', check_log = NULL WHERE id = ?", id),
      enqueueCheck(store, { eventId: config.eventId, submissionId: id, now: now() })
    ]);
    return json({ ok: true });
  }

  async function listFlags(url) {
    const status = url.searchParams.get("status") ?? "open";
    const flags = await all(
      `SELECT f.*, s.team_id, t.display_name AS team_name, s.seq, o.team_id AS other_team_id, ot.display_name AS other_team_name, o.seq AS other_seq
       FROM similarity_flags f JOIN submissions s ON s.id = f.submission_id JOIN teams t ON t.id = s.team_id
         LEFT JOIN submissions o ON o.id = f.other_submission_id LEFT JOIN teams ot ON ot.id = o.team_id
       WHERE f.event_id = ? AND f.status = ? ORDER BY f.created_at DESC LIMIT 500`,
      config.eventId, status
    );
    return json({ flags });
  }

  async function decideFlag(request, admin, id) {
    requireWriter(admin);
    const body = await readJson(request);
    const reason = reasonOf(body);
    if (!["cleared", "confirmed", "open"].includes(body.status)) throw new HttpError(400, "invalid_request", { field: "status" });
    const flag = await first("SELECT * FROM similarity_flags WHERE id = ? AND event_id = ?", id, config.eventId);
    if (!flag) throw new HttpError(404, "not_found");
    await audited(admin, { action: "flag.set_status", target: `flag:${id}`, reason, payload: { from: flag.status, to: body.status } }, [
      store.statement("UPDATE similarity_flags SET status = ?, notes = ? WHERE id = ?", body.status, reason, id)
    ]);
    return json({ ok: true });
  }

  // ---------- runners, jobs, games ----------

  async function listRunners() {
    const runners = await all("SELECT id, name, created_at, revoked_at, last_seen_at, version, image_id, slots, active, suspect_at, suspect_reason FROM runners ORDER BY name");
    return json({ runners: runners.map((runner) => ({ ...runner, online: !runner.revoked_at && runner.last_seen_at > now() - ONLINE_MS })) });
  }

  async function runnerAction(request, admin, id, action) {
    requireWriter(admin);
    const body = await readJson(request);
    const reason = reasonOf(body);
    const runner = await first("SELECT * FROM runners WHERE id = ?", id);
    if (!runner) throw new HttpError(404, "not_found");
    const change = action === "revoke"
      ? store.statement("UPDATE runners SET revoked_at = ? WHERE id = ?", now(), id)
      : store.statement("UPDATE runners SET suspect_at = NULL, suspect_reason = NULL WHERE id = ?", id);
    await audited(admin, { action: `runner.${action}`, target: `runner:${runner.name}`, reason, payload: { suspectReason: runner.suspect_reason } }, [change]);
    return json({ ok: true });
  }

  async function listJobs(url) {
    const status = url.searchParams.get("status") ?? "failed";
    const jobs = await all(
      `SELECT j.*, m.stage, m.map_id FROM jobs j LEFT JOIN matches m ON m.id = j.match_id
       WHERE j.event_id = ? AND j.status = ? ORDER BY j.updated_at DESC LIMIT 200`,
      config.eventId, status
    );
    return json({ jobs, maxAttempts: JOB_POLICY.maxAttempts });
  }

  async function requeueJob(request, admin, id) {
    requireWriter(admin);
    const body = await readJson(request);
    const reason = reasonOf(body);
    const job = await first("SELECT * FROM jobs WHERE id = ? AND event_id = ?", id, config.eventId);
    if (!job) throw new HttpError(404, "not_found");
    if (job.status !== "failed") throw new HttpError(409, "job_not_failed");
    const statements = [store.statement("UPDATE jobs SET status = 'queued', attempts = 0, lease_runner_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?", now(), id)];
    if (job.match_id) statements.push(store.statement("UPDATE matches SET status = 'queued', runner_id = NULL WHERE id = ?", job.match_id));
    await audited(admin, { action: "job.requeue", target: `job:${id}`, reason, payload: { lastError: job.last_error } }, statements);
    return json({ ok: true });
  }

  async function listMatches(url) {
    const stage = url.searchParams.get("stage");
    const status = url.searchParams.get("status");
    const matches = await all(
      `SELECT m.id, m.stage, m.round, m.pairing_id, m.game_index, m.map_id, m.status, m.outcome, m.winner, m.reason, m.plies,
              m.a_house, m.b_house, ta.display_name AS a_team, sa.seq AS a_seq, tb.display_name AS b_team, sb.seq AS b_seq,
              m.runner_id, m.created_at, m.finished_at
       FROM matches m
         LEFT JOIN submissions sa ON sa.id = m.a_submission_id LEFT JOIN teams ta ON ta.id = sa.team_id
         LEFT JOIN submissions sb ON sb.id = m.b_submission_id LEFT JOIN teams tb ON tb.id = sb.team_id
       WHERE m.event_id = ? AND (? IS NULL OR m.stage = ?) AND (? IS NULL OR m.status = ?)
       ORDER BY m.created_at DESC LIMIT 500`,
      config.eventId, stage, stage, status, status
    );
    return json({
      matches: matches.map((match) => ({
        ...match,
        a_name: match.a_house ? HOUSE_BOT_LABELS[match.a_house] ?? match.a_house : `${match.a_team} (v${match.a_seq})`,
        b_name: match.b_house ? HOUSE_BOT_LABELS[match.b_house] ?? match.b_house : `${match.b_team} (v${match.b_seq})`
      }))
    });
  }

  /** Plays a game again as a new game (plan §7.7: a verified infrastructure fault reruns the pair). */
  async function rerunMatch(request, admin, id) {
    requireWriter(admin);
    const body = await readJson(request);
    const reason = reasonOf(body);
    const match = await first("SELECT * FROM matches WHERE id = ? AND event_id = ?", id, config.eventId);
    if (!match) throw new HttpError(404, "not_found");
    const game = enqueueMatch(store, {
      eventId: config.eventId, stage: match.stage, round: match.round, pairingId: match.pairing_id, gameIndex: match.game_index, mapId: match.map_id,
      a: match.a_submission_id ? { submissionId: match.a_submission_id } : { house: match.a_house },
      b: match.b_submission_id ? { submissionId: match.b_submission_id } : { house: match.b_house },
      now: now()
    });
    await audited(admin, { action: "match.rerun", target: `match:${id}`, reason, payload: { newMatchId: game.matchId } }, [
      store.statement("UPDATE matches SET status = 'cancelled' WHERE id = ? AND status <> 'running'", id),
      store.statement("UPDATE jobs SET status = 'failed', last_error = 'cancelled_by_admin', updated_at = ? WHERE match_id = ? AND status = 'queued'", now(), id),
      ...game.statements
    ]);
    return json({ ok: true, newMatchId: game.matchId });
  }

  // ---------- announcements ----------

  async function listAnnouncements() {
    return json({ announcements: await all("SELECT * FROM announcements WHERE event_id = ? ORDER BY created_at DESC", config.eventId) });
  }

  async function createAnnouncement(request, admin) {
    requireWriter(admin);
    const body = await readJson(request);
    const title = typeof body.title === "string" ? body.title.trim().slice(0, 120) : "";
    const text = typeof body.body === "string" ? body.body.trim().slice(0, 4000) : "";
    if (title.length < 3 || text.length < 3) throw new HttpError(400, "invalid_request", { field: title.length < 3 ? "title" : "body" });
    const id = crypto.randomUUID();
    await audited(admin, { action: "announcement.create", target: `announcement:${id}`, payload: { title, publish: body.publish === true } }, [
      store.statement(
        "INSERT INTO announcements (id, event_id, title, body, created_by, created_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id, config.eventId, title, text, admin.email, now(), body.publish === true ? now() : null
      )
    ]);
    return json({ id }, 201);
  }

  async function announcementAction(request, admin, id, action) {
    requireWriter(admin);
    await readJson(request);
    const row = await first("SELECT * FROM announcements WHERE id = ? AND event_id = ?", id, config.eventId);
    if (!row) throw new HttpError(404, "not_found");
    const sql = action === "publish"
      ? "UPDATE announcements SET published_at = ?, withdrawn_at = NULL WHERE id = ?"
      : "UPDATE announcements SET withdrawn_at = ? WHERE id = ?";
    await audited(admin, { action: `announcement.${action}`, target: `announcement:${id}` }, [store.statement(sql, now(), id)]);
    return json({ ok: true });
  }

  // ---------- audit log, exports ----------

  async function listAudit(url) {
    const before = Number(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER;
    const rows = await all("SELECT * FROM audit_log WHERE seq < ? ORDER BY seq DESC LIMIT 200", before);
    return json({ rows });
  }

  async function verifyAudit() {
    const rows = await all("SELECT * FROM audit_log ORDER BY seq");
    return json(await verifyAuditChain(rows));
  }

  async function exportCsv(admin, kind) {
    let body;
    if (kind === "teams") {
      const rows = await all(
        `SELECT t.handle, t.display_name, t.kind, t.status, t.disqualified_at, m.mssv, m.full_name, m.email, m.role, m.status AS member_status, m.show_name
         FROM teams t JOIN members m ON m.team_id = t.id WHERE t.event_id = ? ORDER BY t.created_at, m.role = 'captain' DESC`,
        config.eventId
      );
      body = toCsv(
        ["handle", "team", "kind", "status", "disqualified", "mssv", "full_name", "email", "role", "member_status", "show_name"],
        rows.map((row) => [row.handle, row.display_name, row.kind, row.status, row.disqualified_at ? "yes" : "", row.mssv, row.full_name, row.email, row.role, row.member_status, row.show_name])
      );
    } else {
      const rows = await all(
        `SELECT m.id, m.stage, m.round, m.game_index, m.map_id, m.status, m.outcome, m.winner, m.reason, m.plies, m.replay_sha256,
                COALESCE(ta.handle, 'house:' || m.a_house) AS a, COALESCE(tb.handle, 'house:' || m.b_house) AS b, m.finished_at
         FROM matches m
           LEFT JOIN submissions sa ON sa.id = m.a_submission_id LEFT JOIN teams ta ON ta.id = sa.team_id
           LEFT JOIN submissions sb ON sb.id = m.b_submission_id LEFT JOIN teams tb ON tb.id = sb.team_id
         WHERE m.event_id = ? AND m.stage NOT IN ('smoke') ORDER BY m.created_at`,
        config.eventId
      );
      body = toCsv(
        ["match_id", "stage", "round", "game", "map", "status", "outcome", "winner", "reason", "plies", "replay_sha256", "red", "blue", "finished_at"],
        rows.map((row) => [row.id, row.stage, row.round, row.game_index, row.map_id, row.status, row.outcome, row.winner, row.reason, row.plies, row.replay_sha256, row.a, row.b, row.finished_at ? new Date(row.finished_at).toISOString() : ""])
      );
    }
    // Personal data leaves the system here (plan §5.5), so the export is on the record.
    await audited(admin, { action: `export.${kind}` });
    return new Response(body, {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="bot-cup-${kind}.csv"`, "cache-control": "no-store" }
    });
  }

  // ---------- routing ----------

  const routes = [
    ["GET", /^\/me$/, (request, admin) => json({ email: admin.email, role: admin.role, authMode: config.authMode, fourEyes: FOUR_EYES_ACTIONS })],
    ["GET", /^\/overview$/, () => overview()],
    ["GET", /^\/teams$/, () => listTeams()],
    ["GET", /^\/teams\/([\w-]+)$/, (request, admin, m) => getTeam(m[1])],
    ["POST", /^\/teams\/([\w-]+)\/rename$/, (request, admin, m) => renameTeam(request, admin, m[1])],
    ["POST", /^\/teams\/([\w-]+)\/members\/(\d{8})\/confirm$/, (request, admin, m) => confirmMember(request, admin, m[1], m[2])],
    ["POST", /^\/teams\/([\w-]+)\/disqualify$/, (request, admin, m) => disqualifyTeam(request, admin, m[1])],
    ["GET", /^\/submissions$/, (request, admin, m, url) => listSubmissions(url)],
    ["GET", /^\/submissions\/([\w-]+)\/source$/, (request, admin, m) => submissionSource(admin, m[1])],
    ["POST", /^\/submissions\/([\w-]+)\/recheck$/, (request, admin, m) => recheckSubmission(request, admin, m[1])],
    ["GET", /^\/flags$/, (request, admin, m, url) => listFlags(url)],
    ["POST", /^\/flags\/([\w-]+)$/, (request, admin, m) => decideFlag(request, admin, m[1])],
    ["GET", /^\/runners$/, () => listRunners()],
    ["POST", /^\/runners\/([\w-]+)\/revoke$/, (request, admin, m) => runnerAction(request, admin, m[1], "revoke")],
    ["POST", /^\/runners\/([\w-]+)\/clear-suspect$/, (request, admin, m) => runnerAction(request, admin, m[1], "clear_suspect")],
    ["GET", /^\/jobs$/, (request, admin, m, url) => listJobs(url)],
    ["POST", /^\/jobs\/([\w-]+)\/requeue$/, (request, admin, m) => requeueJob(request, admin, m[1])],
    ["GET", /^\/matches$/, (request, admin, m, url) => listMatches(url)],
    ["POST", /^\/matches\/([\w-]+)\/rerun$/, (request, admin, m) => rerunMatch(request, admin, m[1])],
    ["POST", /^\/matches\/([\w-]+)\/result$/, (request, admin, m) => setMatchResult(request, admin, m[1])],
    ["GET", /^\/pending$/, () => listPending()],
    ["POST", /^\/pending\/([\w-]+)\/approve$/, (request, admin, m) => decide(request, admin, m[1], true)],
    ["POST", /^\/pending\/([\w-]+)\/reject$/, (request, admin, m) => decide(request, admin, m[1], false)],
    ["GET", /^\/announcements$/, () => listAnnouncements()],
    ["POST", /^\/announcements$/, (request, admin) => createAnnouncement(request, admin)],
    ["POST", /^\/announcements\/([\w-]+)\/(publish|withdraw)$/, (request, admin, m) => announcementAction(request, admin, m[1], m[2])],
    ["GET", /^\/audit$/, (request, admin, m, url) => listAudit(url)],
    ["GET", /^\/audit\/verify$/, () => verifyAudit()],
    ["GET", /^\/export\/(teams|results)\.csv$/, (request, admin, m) => exportCsv(admin, m[1])]
  ];

  // Tournament control (P7); `config.random` lets tests fix the tie-break map draw.
  routes.push(...tournamentRoutes({ store, now, eventId: config.eventId, audited, random: config.random }));

  return {
    audited,
    store,
    async fetch(request) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(`${PREFIX}/`)) return json({ error: "not_found" }, 404);
      const path = url.pathname.slice(PREFIX.length);
      try {
        if (request.method !== "GET" && !config.allowedOrigins.includes(request.headers.get("origin") || "")) throw new HttpError(403, "forbidden_origin");
        if (path === "/login" && request.method === "POST") return await login(request);
        if (path === "/logout" && request.method === "POST") return await logout(request);
        const candidates = routes.filter(([, pattern]) => pattern.test(path));
        if (candidates.length === 0) throw new HttpError(404, "not_found");
        const route = candidates.find(([method]) => method === request.method);
        if (!route) throw new HttpError(405, "method_not_allowed");
        const admin = await identify(request);
        return await route[2](request, admin, path.match(route[1]), url);
      } catch (error) {
        if (error instanceof HttpError) return errorResponse(error);
        console.error(JSON.stringify({ event: "bot_cup_admin_error", path, message: String(error?.message || error) }));
        return json({ error: "internal_error" }, 500);
      }
    }
  };
}

