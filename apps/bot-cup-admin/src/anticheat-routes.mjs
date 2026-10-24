/**
 * Anti-cheat tools for organisers (plan §8.5, §8.7, P8):
 *
 *   GET  /anticheat/export?scope=sealed|final   source bundle for scripts/bot-cup/similarity.mjs (JPlag); audited
 *   POST /anticheat/jplag                       import the report that script wrote: pairs ≥ 70% become 'jplag' flags
 *   POST /anticheat/probes                      queue behaviour-fingerprint jobs for one secret set (named by its SHA-256)
 *   GET  /anticheat/probes                      progress per set
 *   GET  /anticheat/anomalies?set=<sha256>      result anomalies and behaviour twins (§8.7); leads, not verdicts
 *   POST /anticheat/collusion                   turn an anomaly into a 'collusion' flag on both teams' code
 */
import {
  FINGERPRINT_POLICY,
  findAnomalies,
  sealedSubmission
} from "../../../packages/bot-cup-core/src/index.mjs";
import { HttpError, json, readJson } from "../../bot-cup-api/src/http.mjs";
import { enqueueProbes } from "../../bot-cup-api/src/queue.mjs";
import { fingerprintTwins } from "../../bot-cup-api/src/anticheat.mjs";

export const SOURCES_FORMAT = "ott-bot-cup-sources-1";
export const JPLAG_FORMAT = "ott-bot-cup-jplag-1";
export const JPLAG_POLICY = Object.freeze({ flag: 0.7, priority: 0.85, maxPairs: 5000, maxBytes: 2 * 1024 * 1024 });

const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[\w-]{1,80}$/;
const REFERENCE = /^[\w./-]{1,160}$/;
const TEAM_STAGES = ["round_robin", "swiss", "knockout"];
const STRONG_HOUSE = ["medium", "hard", "sentinel", "strategist"];

/**
 * @param {{ store: object, now: () => number, eventId: string, audited: Function, reasonOf: Function, requireWriter: Function }} options
 */
export function anticheatRoutes({ store, now, eventId, audited, reasonOf, requireWriter }) {
  const all = async (sql, ...args) => (await store.statement(sql, ...args).all()).results;
  const first = (sql, ...args) => store.statement(sql, ...args).first();

  /** Submissions in scope: the sealed ones after code freeze, else each active team's ready final version. */
  async function scopeSubmissions(scope) {
    if (scope === "sealed") {
      return all(
        `SELECT s.id, s.team_id, t.display_name, s.seq, s.language, s.sha256
         FROM entrants e JOIN submissions s ON s.id = e.submission_id JOIN teams t ON t.id = e.team_id
         WHERE e.event_id = ? ORDER BY t.display_name`,
        eventId
      );
    }
    if (scope !== "final") throw new HttpError(400, "invalid_request", { field: "scope" });
    const teams = await all("SELECT id, display_name, final_submission_id FROM teams WHERE event_id = ? AND status = 'active' AND disqualified_at IS NULL ORDER BY display_name", eventId);
    const submissions = await all(
      "SELECT s.id, s.team_id, s.seq, s.language, s.sha256, s.status FROM submissions s JOIN teams t ON t.id = s.team_id WHERE t.event_id = ?",
      eventId
    );
    return teams.flatMap((team) => {
      const chosen = sealedSubmission(submissions.filter((submission) => submission.team_id === team.id), team.final_submission_id);
      return chosen ? [{ ...chosen, display_name: team.display_name }] : [];
    });
  }

  async function exportSources(url, admin) {
    const scope = url.searchParams.get("scope") ?? "sealed";
    const list = await scopeSubmissions(scope);
    const decoder = new TextDecoder();
    const submissions = [];
    for (const row of list) {
      const bytes = await store.getSourceBytes(row.sha256);
      submissions.push({ id: row.id, team: row.display_name, version: row.seq, language: row.language, sha256: row.sha256, source: bytes ? decoder.decode(bytes) : "" });
    }
    const bundle = { format: SOURCES_FORMAT, eventId, scope, exportedAt: now(), submissions };
    // Reading team code is audited like viewing one submission (plan §8.8).
    await audited(admin, { action: "anticheat.export_sources", target: `event:${eventId}`, reason: `JPlag ${scope}`, payload: { scope, submissions: submissions.length } });
    return new Response(JSON.stringify(bundle), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="bot-cup-sources-${scope}.json"`,
        "cache-control": "no-store"
      }
    });
  }

  async function importJplag(request, admin) {
    requireWriter(admin);
    const body = await readJson(request, JPLAG_POLICY.maxBytes);
    const reason = reasonOf(body);
    const report = body.report;
    if (report?.format !== JPLAG_FORMAT || !Array.isArray(report.pairs) || report.pairs.length > JPLAG_POLICY.maxPairs) {
      throw new HttpError(400, "invalid_request", { field: "report" });
    }
    const known = new Set((await all(
      "SELECT s.id FROM submissions s JOIN teams t ON t.id = s.team_id WHERE t.event_id = ?", eventId
    )).map((row) => row.id));
    const existing = await all("SELECT submission_id, other_submission_id, reference FROM similarity_flags WHERE event_id = ? AND kind = 'jplag'", eventId);
    const seen = new Set(existing.map((flag) => [flag.submission_id, flag.other_submission_id ?? "", flag.reference ?? ""].join("|")));
    const statements = [];
    let skipped = 0;
    for (const pair of report.pairs) {
      const similarity = Number(pair.similarity);
      const valid = ID.test(pair.a ?? "") && known.has(pair.a) && Number.isFinite(similarity) && similarity >= 0 && similarity <= 1
        && ((pair.b && ID.test(pair.b) && known.has(pair.b) && pair.b !== pair.a && !pair.reference) || (!pair.b && REFERENCE.test(pair.reference ?? "")));
      if (!valid) throw new HttpError(400, "invalid_request", { field: "report.pairs" });
      if (similarity < JPLAG_POLICY.flag) continue;
      const [a, b] = pair.b ? [pair.a, pair.b].sort() : [pair.a, null];
      const key = [a, b ?? "", pair.b ? "" : pair.reference].join("|");
      const reverse = pair.b ? [b, a, ""].join("|") : key;
      if (seen.has(key) || seen.has(reverse)) {
        skipped += 1;
        continue;
      }
      seen.add(key);
      const details = { tool: String(report.tool ?? "JPlag").slice(0, 40), language: String(pair.language ?? "").slice(0, 20), max: Number.isFinite(Number(pair.max)) ? Number(pair.max) : null, priority: similarity >= JPLAG_POLICY.priority };
      statements.push(store.statement(
        `INSERT INTO similarity_flags (id, event_id, kind, submission_id, other_submission_id, reference, score, details, created_at)
         VALUES (?, ?, 'jplag', ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(), eventId, a, b, pair.b ? null : pair.reference, Math.round(similarity * 1000) / 1000, JSON.stringify(details), now()
      ));
    }
    await audited(admin, { action: "anticheat.import_jplag", target: `event:${eventId}`, reason, payload: { pairs: report.pairs.length, flags: statements.length, skipped } }, statements);
    return json({ ok: true, pairs: report.pairs.length, flags: statements.length, skipped });
  }

  async function queueProbes(request, admin) {
    requireWriter(admin);
    const body = await readJson(request);
    const reason = reasonOf(body);
    if (!SHA256.test(body.probeSet ?? "")) throw new HttpError(400, "invalid_request", { field: "probeSet" });
    const submissions = await scopeSubmissions(body.scope ?? "sealed");
    const done = await all(
      `SELECT submission_id, house FROM fingerprints WHERE event_id = ? AND probe_set = ?
       UNION ALL SELECT submission_id, probe_house FROM jobs WHERE event_id = ? AND kind = 'probe' AND probe_set = ? AND status IN ('queued', 'leased')`,
      eventId, body.probeSet, eventId, body.probeSet
    );
    const has = new Set(done.map((row) => row.submission_id ?? `house:${row.house}`));
    const targets = [
      ...FINGERPRINT_POLICY.references.filter((house) => !has.has(`house:${house}`)).map((house) => ({ house })),
      ...submissions.filter((submission) => !has.has(submission.id)).map((submission) => ({ submissionId: submission.id }))
    ];
    await audited(admin, { action: "anticheat.queue_probes", target: `event:${eventId}`, reason, payload: { probeSet: body.probeSet, scope: body.scope ?? "sealed", jobs: targets.length } },
      targets.length ? enqueueProbes(store, { eventId, probeSet: body.probeSet, targets, now: now() }) : []);
    return json({ ok: true, jobs: targets.length });
  }

  async function probeProgress() {
    const sets = await all(
      `SELECT probe_set, COUNT(*) AS jobs, SUM(status = 'done') AS done, SUM(status IN ('queued', 'leased')) AS pending, SUM(status = 'failed') AS failed,
              MIN(created_at) AS started_at
       FROM jobs WHERE event_id = ? AND kind = 'probe' GROUP BY probe_set ORDER BY started_at DESC`,
      eventId
    );
    const counts = await all("SELECT probe_set, COUNT(*) AS fingerprints FROM fingerprints WHERE event_id = ? GROUP BY probe_set", eventId);
    const byset = new Map(counts.map((row) => [row.probe_set, row.fingerprints]));
    return json({ sets: sets.map((row) => ({ ...row, fingerprints: byset.get(row.probe_set) ?? 0 })) });
  }

  async function anomalies(url) {
    const rows = await all(
      `SELECT m.id, m.stage, m.status, m.outcome, m.winner, m.loser, m.reason, m.plies, sa.team_id AS a, sb.team_id AS b
       FROM matches m LEFT JOIN submissions sa ON sa.id = m.a_submission_id LEFT JOIN submissions sb ON sb.id = m.b_submission_id
       WHERE m.event_id = ? AND m.stage IN (${TEAM_STAGES.map(() => "?").join(", ")}) AND m.status = 'finished'`,
      eventId, ...TEAM_STAGES
    );
    const practiceRows = await all(
      `SELECT m.requested_by_team AS team, m.outcome, m.winner, CASE WHEN m.a_submission_id IS NOT NULL THEN 'A' ELSE 'B' END AS seat
       FROM matches m WHERE m.event_id = ? AND m.stage = 'practice' AND m.status = 'finished'
         AND COALESCE(m.a_house, m.b_house) IN (${STRONG_HOUSE.map(() => "?").join(", ")})`,
      eventId, ...STRONG_HOUSE
    );
    const practice = new Map();
    for (const row of practiceRows) {
      const record = practice.get(row.team) ?? { points: 0, played: 0 };
      record.played += 1;
      record.points += row.outcome === "draw" ? 0.5 : row.winner === row.seat ? 1 : 0;
      practice.set(row.team, record);
    }
    const latest = await first("SELECT probe_set FROM fingerprints WHERE event_id = ? ORDER BY created_at DESC LIMIT 1", eventId);
    const probeSet = url.searchParams.get("set") ?? latest?.probe_set ?? null;
    const twins = probeSet ? await fingerprintTwins(store, eventId, probeSet) : [];
    const names = new Map((await all("SELECT id, display_name FROM teams WHERE event_id = ?", eventId)).map((row) => [row.id, row.display_name]));
    return json({ probeSet, rows: findAnomalies({ games: rows, practice, twins, names }) });
  }

  /** The code a team plays with now: its sealed entry after code freeze, else its final version. */
  async function playingSubmission(teamId) {
    for (const scope of ["sealed", "final"]) {
      const found = (await scopeSubmissions(scope)).find((submission) => submission.team_id === teamId);
      if (found) return found;
    }
    return null;
  }

  async function flagCollusion(request, admin) {
    requireWriter(admin);
    const body = await readJson(request);
    const reason = reasonOf(body);
    if (!ID.test(body.teamId ?? "") || !ID.test(body.opponentId ?? "") || body.teamId === body.opponentId) throw new HttpError(400, "invalid_request");
    const [mine, theirs] = [await playingSubmission(body.teamId), await playingSubmission(body.opponentId)];
    if (!mine || !theirs) throw new HttpError(404, "not_found");
    const open = await first(
      `SELECT 1 AS ok FROM similarity_flags WHERE event_id = ? AND kind = 'collusion' AND status = 'open'
         AND ((submission_id = ? AND other_submission_id = ?) OR (submission_id = ? AND other_submission_id = ?))`,
      eventId, mine.id, theirs.id, theirs.id, mine.id
    );
    if (open) throw new HttpError(409, "already_flagged");
    const note = typeof body.note === "string" ? body.note.slice(0, 500) : "";
    const id = crypto.randomUUID();
    await audited(admin, { action: "anticheat.flag_collusion", target: `flag:${id}`, reason, payload: { teamId: body.teamId, opponentId: body.opponentId } }, [
      store.statement(
        `INSERT INTO similarity_flags (id, event_id, kind, submission_id, other_submission_id, details, created_at)
         VALUES (?, ?, 'collusion', ?, ?, ?, ?)`,
        id, eventId, mine.id, theirs.id, JSON.stringify({ note }), now()
      )
    ]);
    return json({ ok: true, flagId: id }, 201);
  }

  return [
    ["POST", /^\/anticheat\/collusion$/, (request, admin) => flagCollusion(request, admin)],
    ["GET", /^\/anticheat\/export$/, (request, admin) => exportSources(new URL(request.url), admin)],
    ["POST", /^\/anticheat\/jplag$/, (request, admin) => importJplag(request, admin)],
    ["POST", /^\/anticheat\/probes$/, (request, admin) => queueProbes(request, admin)],
    ["GET", /^\/anticheat\/probes$/, () => probeProgress()],
    ["GET", /^\/anticheat\/anomalies$/, (request) => anomalies(new URL(request.url))]
  ];
}
