/**
 * Runner API (plan §3.2, §8.4, §10.3): organiser machines pull work over outbound HTTPS with a bearer token.
 *
 *   POST /runner/heartbeat          {version, imageId, slots, active}
 *   POST /runner/claim              {slots} -> {jobs: [...]}
 *   GET  /runner/source/:sha256     bytes of a submission this runner currently holds a lease for
 *   POST /runner/complete           {jobId, attempt, ...result}   check: {ok, log}; match: {replay, stderr}; probe: {moves}
 *   POST /runner/fail               {jobId, attempt, detail}   infrastructure failure: retried up to 3 leases
 *
 * Runners are not trusted with results: every replay is played again with rules.js (bot-cup-core.verifyReplay) and a
 * refuted one marks the runner as suspect. Error codes here are for machines, not players, so they live outside src/*.mjs
 * (the web app's message test only covers player-facing codes).
 */
import {
  BOT_CUP_POLICY,
  JOB_POLICY,
  SUBMISSION_STATUS,
  expiredLeaseStatus,
  isMoveKey,
  smokeGames,
  smokeVerdict,
  tailText,
  verifyReplay
} from "../../../../packages/bot-cup-core/src/index.mjs";
import { HttpError, json, readJson } from "../http.mjs";
import { enqueueMatch, gzipText } from "../queue.mjs";
import { sha256Hex } from "../security.mjs";
import { insertFingerprint, setFlagStatements } from "../anticheat.mjs";

const MAX_COMPLETE_BYTES = 512 * 1024;
const STDERR_MAX_CHARS = 8 * 1024;
const LOG_MAX_CHARS = 16 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_PROBE_POSITIONS = 1000;

/**
 * @param {{ db: object, store: object, now: () => number, eventId: string, expectedImageId?: string|null }} options
 */
export function createRunnerApi({ store, now, eventId, expectedImageId = null }) {
  const first = (sql, ...args) => store.statement(sql, ...args).first();
  const all = async (sql, ...args) => (await store.statement(sql, ...args).all()).results;
  const run = (sql, ...args) => store.statement(sql, ...args).run();

  async function authenticate(request) {
    const header = request.headers.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const runner = token.length >= 32 ? await first("SELECT * FROM runners WHERE token_hash = ? AND revoked_at IS NULL", await sha256Hex(token)) : null;
    if (!runner) throw new HttpError(401, "runner_unauthorized");
    return runner;
  }

  async function heartbeat(request, runner) {
    const body = await readJson(request);
    const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : null);
    await run(
      "UPDATE runners SET last_seen_at = ?, version = ?, image_id = ?, slots = ?, active = ? WHERE id = ?",
      now(), text(body.version, 64), text(body.imageId, 100),
      Number.isInteger(body.slots) ? body.slots : null, Number.isInteger(body.active) ? body.active : null, runner.id
    );
    return json({ ok: true, serverTime: now(), policy: BOT_CUP_POLICY, expectedImageId });
  }

  /** Leases that ran out go back to the queue, or fail once their attempts are used up. */
  async function expireLeases() {
    const expired = await all(
      `UPDATE jobs SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END,
              lease_runner_id = NULL, lease_expires_at = NULL, updated_at = ?, last_error = 'lease_expired'
       WHERE event_id = ? AND status = 'leased' AND lease_expires_at <= ?
       RETURNING id, status, match_id`,
      JOB_POLICY.maxAttempts, now(), eventId, now()
    );
    const statements = expired.filter((job) => job.match_id).map((job) => store.statement(
      "UPDATE matches SET status = ?, runner_id = NULL WHERE id = ? AND status = 'running'",
      job.status === "failed" ? "failed" : "queued", job.match_id
    ));
    if (statements.length) await store.batch(statements);
  }

  async function seatOf(match, side) {
    const submissionId = match[`${side}_submission_id`];
    if (!submissionId) return { house: match[`${side}_house`] };
    const submission = await first("SELECT sha256, language FROM submissions WHERE id = ?", submissionId);
    return { submission: { sha256: submission.sha256, language: submission.language } };
  }

  async function claim(request, runner) {
    const body = await readJson(request);
    if (expectedImageId && runner.image_id !== expectedImageId) throw new HttpError(409, "runner_image_mismatch", { expectedImageId });
    const slots = Math.max(0, Math.min(JOB_POLICY.maxClaim, Number.isInteger(body.slots) ? body.slots : 0));
    if (!slots) return json({ jobs: [] });
    await expireLeases();
    const leased = await all(
      `UPDATE jobs SET status = 'leased', lease_runner_id = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
       WHERE id IN (SELECT id FROM jobs WHERE event_id = ? AND status = 'queued' ORDER BY priority DESC, created_at, id LIMIT ?)
       RETURNING id, kind, priority, created_at, attempts, submission_id, match_id, lease_expires_at, probe_house, probe_set`,
      runner.id, now() + JOB_POLICY.leaseMs, now(), eventId, slots
    );
    // RETURNING comes back in table order; hand the work out by priority.
    leased.sort((x, y) => y.priority - x.priority || x.created_at - y.created_at || (x.id < y.id ? -1 : 1));
    const jobs = [];
    for (const job of leased) {
      const base = { jobId: job.id, attempt: job.attempts, kind: job.kind, leaseExpiresAt: job.lease_expires_at };
      if (job.kind === "check") {
        const submission = await first("SELECT id, sha256, language FROM submissions WHERE id = ?", job.submission_id);
        jobs.push({ ...base, submission: { sha256: submission.sha256, language: submission.language } });
      } else if (job.kind === "probe") {
        // The positions stay on the organisers' machine; the job only names the set by its SHA-256 (plan §8.5).
        const target = job.submission_id
          ? { submission: await first("SELECT sha256, language FROM submissions WHERE id = ?", job.submission_id) }
          : { house: job.probe_house };
        jobs.push({ ...base, probe: { set: job.probe_set, policy: BOT_CUP_POLICY, ...target } });
      } else {
        const match = await first("SELECT * FROM matches WHERE id = ?", job.match_id);
        await run("UPDATE matches SET status = 'running', runner_id = ?, started_at = ? WHERE id = ?", runner.id, now(), match.id);
        // Only what the referee needs: no team names or ids reach the runner or the bots (plan §8.3).
        jobs.push({ ...base, match: { id: match.id, mapId: match.map_id, policy: BOT_CUP_POLICY, seats: { A: await seatOf(match, "a"), B: await seatOf(match, "b") } } });
      }
    }
    return json({ jobs });
  }

  async function source(runner, sha256) {
    if (!SHA256.test(sha256)) throw new HttpError(404, "not_found");
    const allowed = await first(
      `SELECT 1 AS ok FROM jobs j
         LEFT JOIN submissions s ON s.id = j.submission_id
         LEFT JOIN matches m ON m.id = j.match_id
         LEFT JOIN submissions sa ON sa.id = m.a_submission_id
         LEFT JOIN submissions sb ON sb.id = m.b_submission_id
       WHERE j.status = 'leased' AND j.lease_runner_id = ? AND j.lease_expires_at > ?
         AND (s.sha256 = ? OR sa.sha256 = ? OR sb.sha256 = ?)
       LIMIT 1`,
      runner.id, now(), sha256, sha256, sha256
    );
    if (!allowed) throw new HttpError(404, "not_found");
    const bytes = await store.getSourceBytes(sha256);
    if (!bytes) throw new HttpError(404, "not_found");
    return new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream", "x-sha256": sha256, "cache-control": "no-store" } });
  }

  /** The job this runner holds a live lease on for `attempt`, or the reason it does not. */
  async function leasedJob(runner, body) {
    if (typeof body.jobId !== "string" || !Number.isInteger(body.attempt)) throw new HttpError(400, "invalid_request");
    const job = await first("SELECT * FROM jobs WHERE id = ? AND event_id = ?", body.jobId, eventId);
    if (!job) throw new HttpError(404, "not_found");
    // A retried request after a lost response: the job is already done with this very attempt.
    if (job.status === "done" && job.attempts === body.attempt && job.lease_runner_id === runner.id) return { job, duplicate: true };
    if (job.status !== "leased" || job.lease_runner_id !== runner.id || job.attempts !== body.attempt) throw new HttpError(409, "lease_lost");
    return { job, duplicate: false };
  }

  const finishJob = (job) => store.statement(
    "UPDATE jobs SET status = 'done', lease_expires_at = NULL, updated_at = ? WHERE id = ? AND attempts = ?", now(), job.id, job.attempts
  );

  async function completeCheck(job, body) {
    const submission = await first("SELECT * FROM submissions WHERE id = ?", job.submission_id);
    const log = tailText(body.log, LOG_MAX_CHARS);
    if (body.ok !== true) {
      await store.batch([
        finishJob(job),
        store.statement("UPDATE submissions SET status = ?, check_log = ? WHERE id = ? AND status = 'checking'", SUBMISSION_STATUS.BUILD_FAILED, log, submission.id)
      ]);
      return json({ ok: true, status: SUBMISSION_STATUS.BUILD_FAILED });
    }
    const statements = [finishJob(job), store.statement("UPDATE submissions SET check_log = ? WHERE id = ?", log, submission.id)];
    for (const game of smokeGames(submission.id)) {
      statements.push(...enqueueMatch(store, { eventId, stage: "smoke", now: now(), ...game }).statements);
    }
    await store.batch(statements);
    return json({ ok: true, status: SUBMISSION_STATUS.CHECKING, smokeGames: 2 });
  }

  /** Effects of a finished game on the rest of the event. Later phases add practice, gate and tournament stages. */
  async function afterMatch(match) {
    if (match.stage !== "smoke") return;
    const submissionId = match.a_submission_id ?? match.b_submission_id;
    const games = await all(
      `SELECT status, outcome, loser, reason, map_id, CASE WHEN a_submission_id = ? THEN 'A' ELSE 'B' END AS seat
       FROM matches WHERE stage = 'smoke' AND status <> 'cancelled' AND (a_submission_id = ? OR b_submission_id = ?) ORDER BY game_index`,
      submissionId, submissionId, submissionId
    );
    const verdict = smokeVerdict(games.map((game) => ({ ...game, mapId: game.map_id })));
    if (!verdict) return;
    await run(
      "UPDATE submissions SET status = ?, check_log = COALESCE(check_log, '') || ? WHERE id = ? AND status = 'checking'",
      verdict.status, `\n${verdict.log}`, submissionId
    );
  }

  async function completeMatch(runner, job, body) {
    const match = await first("SELECT * FROM matches WHERE id = ?", job.match_id);
    const checked = verifyReplay(body.replay, { mapId: match.map_id });
    if (!checked.ok) {
      const reason = `${checked.error}${checked.ply ? ` at ply ${checked.ply}` : ""}`;
      await store.batch([
        store.statement("UPDATE runners SET suspect_at = ?, suspect_reason = ? WHERE id = ?", now(), `match ${match.id}: ${reason}`, runner.id),
        store.statement("UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?", `replay_rejected: ${reason}`, now(), job.id),
        store.statement("UPDATE matches SET status = 'failed' WHERE id = ?", match.id)
      ]);
      console.error(JSON.stringify({ event: "bot_cup_replay_rejected", runner: runner.name, matchId: match.id, reason }));
      throw new HttpError(422, "replay_rejected", { reason });
    }
    const replayText = JSON.stringify(body.replay);
    const result = checked.result;
    await store.batch([
      store.statement(
        `UPDATE matches SET status = 'finished', outcome = ?, winner = ?, loser = ?, reason = ?, plies = ?, replay_gz = ?, replay_sha256 = ?,
                stderr_a = ?, stderr_b = ?, runner_id = ?, finished_at = ? WHERE id = ?`,
        result.outcome, result.winner, result.loser, result.reason, result.acceptedPlies, await gzipText(replayText), await sha256Hex(replayText),
        tailText(body.stderr?.A, STDERR_MAX_CHARS) || null, tailText(body.stderr?.B, STDERR_MAX_CHARS) || null, runner.id, now(), match.id
      ),
      finishJob(job)
    ]);
    await afterMatch({ ...match, status: "finished" });
    return json({ ok: true, result });
  }

  /**
   * A probe's answers: one move key (or null) per position of the set. When it was the last probe of its set still
   * waiting, the set is compared as a whole and flags are raised in the same batch (plan §8.5).
   */
  async function completeProbe(job, body) {
    const moves = body.moves;
    if (!Array.isArray(moves) || moves.length === 0 || moves.length > MAX_PROBE_POSITIONS || !moves.every(isMoveKey)) {
      throw new HttpError(400, "invalid_request", { field: "moves" });
    }
    // A fingerprint for this target and set may exist from an earlier job: keep the first one.
    const exists = await first(
      "SELECT 1 AS ok FROM fingerprints WHERE probe_set = ? AND (submission_id = ? OR house = ?)",
      job.probe_set, job.submission_id, job.probe_house
    );
    const statements = [finishJob(job)];
    let extra = null;
    if (!exists) {
      statements.push(insertFingerprint(store, { eventId, probeSet: job.probe_set, submissionId: job.submission_id, house: job.probe_house, moves, now: now() }));
      const team = job.submission_id ? (await first("SELECT team_id FROM submissions WHERE id = ?", job.submission_id)).team_id : null;
      extra = { submissionId: job.submission_id, house: job.probe_house, teamId: team, moves };
    }
    const waiting = await first(
      "SELECT COUNT(*) AS n FROM jobs WHERE event_id = ? AND kind = 'probe' AND probe_set = ? AND status IN ('queued', 'leased') AND id <> ?",
      eventId, job.probe_set, job.id
    );
    const flagStatements = waiting.n === 0 ? await setFlagStatements(store, { eventId, probeSet: job.probe_set, now: now(), extra }) : [];
    await store.batch([...statements, ...flagStatements]);
    const flags = flagStatements.length;
    return json({ ok: true, setComplete: waiting.n === 0, flags });
  }

  async function complete(request, runner) {
    const body = await readJson(request, MAX_COMPLETE_BYTES);
    const { job, duplicate } = await leasedJob(runner, body);
    if (duplicate) return json({ ok: true, duplicate: true });
    if (job.kind === "check") return completeCheck(job, body);
    if (job.kind === "probe") return completeProbe(job, body);
    return completeMatch(runner, job, body);
  }

  async function fail(request, runner) {
    const body = await readJson(request);
    const { job, duplicate } = await leasedJob(runner, body);
    if (duplicate) return json({ ok: true, duplicate: true });
    const status = expiredLeaseStatus(job.attempts);
    const statements = [store.statement(
      "UPDATE jobs SET status = ?, lease_runner_id = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ? WHERE id = ?",
      status, tailText(typeof body.detail === "string" ? body.detail : "infrastructure_error", 2000), now(), job.id
    )];
    if (job.match_id) statements.push(store.statement("UPDATE matches SET status = ?, runner_id = NULL WHERE id = ?", status === "failed" ? "failed" : "queued", job.match_id));
    await store.batch(statements);
    return json({ ok: true, status });
  }

  const routes = [
    ["POST", /^\/runner\/heartbeat$/, (request, runner) => heartbeat(request, runner)],
    ["POST", /^\/runner\/claim$/, (request, runner) => claim(request, runner)],
    ["GET", /^\/runner\/source\/([^/]+)$/, (request, runner, match) => source(runner, match[1])],
    ["POST", /^\/runner\/complete$/, (request, runner) => complete(request, runner)],
    ["POST", /^\/runner\/fail$/, (request, runner) => fail(request, runner)]
  ];

  return {
    async fetch(request, path) {
      const candidates = routes.filter(([, pattern]) => pattern.test(path));
      if (candidates.length === 0) throw new HttpError(404, "not_found");
      const route = candidates.find(([method]) => method === request.method);
      if (!route) throw new HttpError(405, "method_not_allowed");
      const runner = await authenticate(request);
      return route[2](request, runner, path.match(route[1]));
    }
  };
}
