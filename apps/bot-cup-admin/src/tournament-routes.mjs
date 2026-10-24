/**
 * Tournament control for organisers (plan §7, P7): each step is one audited D1 batch built by the shared engine
 * (apps/bot-cup-api/src/tournament/engine.mjs). Steps refuse to run out of order (phase) or while games are pending.
 */
import { HttpError, json, readJson } from "../../bot-cup-api/src/http.mjs";
import { createTournament } from "../../bot-cup-api/src/tournament/engine.mjs";

const STEPS = Object.freeze({
  freeze: "planFreeze",
  "gate-start": "planGateStart",
  "gate-close": "planGateClose",
  "qualifying-start": "planQualifyingStart",
  "swiss-next": "planSwissNextRound",
  "qualifying-close": "planQualifyingClose",
  "knockout-start": "planKnockoutStart",
  "knockout-advance": "planKnockoutAdvance",
  finish: "planFinishWithoutKnockout"
});

function reasonOf(body) {
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  if (reason.length < 3) throw new HttpError(400, "reason_required", { field: "reason" });
  return reason;
}

function requireWriter(admin) {
  if (admin.role !== "admin") throw new HttpError(403, "read_only");
}

/**
 * @param {{ store: object, now: () => number, eventId: string, audited: Function, random?: () => number }} options
 * @returns {Array} routes in the admin API's format
 */
export function tournamentRoutes({ store, now, eventId, audited, random }) {
  const engine = createTournament({ store, now, eventId, random });

  async function step(request, admin, name) {
    requireWriter(admin);
    const body = await readJson(request);
    const reason = reasonOf(body);
    const plan = await engine[STEPS[name]]();
    await audited(admin, { action: `tournament.${name}`, target: `event:${eventId}`, reason, payload: plan.summary }, plan.statements);
    return json({ ok: true, step: name, ...plan.summary });
  }

  async function interview(request, admin) {
    requireWriter(admin);
    const body = await readJson(request);
    const reason = reasonOf(body);
    const plan = await engine.planInterview(String(body.teamId ?? ""), body.result);
    await audited(admin, { action: "tournament.interview", target: `team:${body.teamId}`, reason, payload: plan.summary }, plan.statements);
    return json({ ok: true, ...plan.summary });
  }

  async function answerAppeal(request, admin, id) {
    requireWriter(admin);
    const body = await readJson(request);
    const response = typeof body.response === "string" ? body.response.trim().slice(0, 2000) : "";
    if (response.length < 3) throw new HttpError(400, "invalid_request", { field: "response" });
    const appeal = await store.statement("SELECT * FROM appeals WHERE id = ? AND event_id = ?", id, eventId).first();
    if (!appeal) throw new HttpError(404, "not_found");
    if (appeal.status !== "open") throw new HttpError(409, "already_answered");
    await audited(admin, { action: "appeal.answer", target: `appeal:${id}`, reason: response, payload: { teamId: appeal.team_id, stage: appeal.stage } }, [
      store.statement("UPDATE appeals SET status = 'answered', response = ?, answered_by = ?, answered_at = ? WHERE id = ?", response, admin.email, now(), id)
    ]);
    return json({ ok: true });
  }

  return [
    ["GET", /^\/tournament$/, async () => json(await engine.adminView())],
    ["GET", /^\/tournament\/results\/(sealed|gate|qualifying|final)$/, async (request, admin, match) => {
      const doc = await engine.publishedDoc(match[1]);
      if (!doc) throw new HttpError(404, "not_found");
      return new Response(doc.json, { headers: { "content-type": "application/json; charset=utf-8", "x-sha256": doc.sha256, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    }],
    ["POST", /^\/tournament\/(freeze|gate-start|gate-close|qualifying-start|swiss-next|qualifying-close|knockout-start|knockout-advance|finish)$/, (request, admin, match) => step(request, admin, match[1])],
    ["POST", /^\/tournament\/interview$/, (request, admin) => interview(request, admin)],
    ["POST", /^\/tournament\/appeals\/([\w-]+)\/answer$/, (request, admin, match) => answerAppeal(request, admin, match[1])]
  ];
}
