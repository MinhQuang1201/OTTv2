/**
 * Behaviour fingerprints on the server (plan §8.5). A probe job's answers are stored as they come; once no probe job of
 * that secret set is left waiting, the whole set is compared at once (bot-cup-core `flagsForSet`): a bot that plays like
 * a reference bot (ai.js, a starter template) is flagged against it, and two teams that play alike are flagged as a pair
 * unless the same reference explains it. Flags that already exist are not added twice.
 */
import { FINGERPRINT_POLICY, compareFingerprints, flagsForSet } from "../../../packages/bot-cup-core/src/index.mjs";

const round3 = (value) => Math.round(value * 1000) / 1000;

/** Every fingerprint of a set with the team behind it (null for reference bots). */
export async function fingerprintsOf(store, eventId, probeSet) {
  const rows = (await store.statement(
    `SELECT f.id, f.submission_id, f.house, f.moves_json, s.team_id
     FROM fingerprints f LEFT JOIN submissions s ON s.id = f.submission_id
     WHERE f.event_id = ? AND f.probe_set = ?`,
    eventId, probeSet
  ).all()).results;
  return rows.map((row) => ({ submissionId: row.submission_id, house: row.house, teamId: row.team_id, moves: JSON.parse(row.moves_json) }));
}

export function insertFingerprint(store, { eventId, probeSet, submissionId, house, moves, now }) {
  return store.statement(
    "INSERT INTO fingerprints (id, event_id, probe_set, submission_id, house, moves_json, answered, total, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    crypto.randomUUID(), eventId, probeSet, submissionId, house, JSON.stringify(moves), moves.filter((move) => move !== null).length, moves.length, now
  );
}

/** INSERTs for the flags of a complete set that do not exist yet; `extra` is a fingerprint stored in the same batch. */
export async function setFlagStatements(store, { eventId, probeSet, now, extra = null }) {
  const prints = await fingerprintsOf(store, eventId, probeSet);
  if (extra) prints.push(extra);
  const flags = flagsForSet(prints);
  const existing = (await store.statement(
    "SELECT submission_id, other_submission_id, reference FROM similarity_flags WHERE event_id = ? AND kind = 'behavior'", eventId
  ).all()).results;
  const key = (a, b, reference) => (reference ? `${a}|${reference}` : [a, b].sort().join("|"));
  const seen = new Set(existing.map((flag) => key(flag.submission_id, flag.other_submission_id, flag.reference)));
  const statements = [];
  for (const flag of flags) {
    const id = key(flag.submissionId, flag.otherSubmissionId, flag.reference);
    if (seen.has(id)) continue;
    seen.add(id);
    statements.push(store.statement(
      `INSERT INTO similarity_flags (id, event_id, kind, submission_id, other_submission_id, reference, score, details, created_at)
       VALUES (?, ?, 'behavior', ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(), eventId, flag.submissionId, flag.otherSubmissionId, flag.reference, round3(flag.ratio),
      JSON.stringify({ probeSet, compared: flag.compared, same: flag.same, positions: flag.positions }), now
    ));
  }
  return statements;
}

/** Pairs of different teams whose fingerprints agree at least `minRatio`, unless a shared reference explains it. */
export async function fingerprintTwins(store, eventId, probeSet, minRatio = FINGERPRINT_POLICY.flagRatio) {
  const prints = await fingerprintsOf(store, eventId, probeSet);
  const explained = new Set(flagsForSet(prints).filter((flag) => flag.reference).map((flag) => `${flag.submissionId}|${flag.reference}`));
  const references = prints.filter((print) => print.house).map((print) => `house:${print.house}`);
  const list = prints.filter((print) => print.teamId);
  const twins = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (list[i].teamId === list[j].teamId) continue;
      if (references.some((reference) => explained.has(`${list[i].submissionId}|${reference}`) && explained.has(`${list[j].submissionId}|${reference}`))) continue;
      const comparison = compareFingerprints(list[i].moves, list[j].moves);
      if (comparison.compared >= FINGERPRINT_POLICY.minCompared && comparison.ratio >= minRatio) {
        twins.push({ team: list[i].teamId, other: list[j].teamId, ratio: round3(comparison.ratio), compared: comparison.compared });
      }
    }
  }
  return twins;
}
