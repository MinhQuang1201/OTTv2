/**
 * Puts work on the runner queue (plan §8.4, §9.1). Every function returns D1 statements so callers can batch them with
 * the write that caused the work, atomically.
 */
import { BOT_CUP_POLICY, JOB_PRIORITY } from "../../../packages/bot-cup-core/src/index.mjs";

/** Syntax check of a stored submission; only enqueued when the submission row exists (same batch). */
export function enqueueCheck(store, { eventId, submissionId, now }) {
  return store.statement(
    `INSERT INTO jobs (id, event_id, kind, priority, submission_id, created_at, updated_at)
     SELECT ?, ?, 'check', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ?)`,
    crypto.randomUUID(), eventId, JOB_PRIORITY.check, submissionId, now, now, submissionId
  );
}

/**
 * One game and the job that plays it.
 * @param {{ eventId: string, stage: string, mapId: string, a: { submissionId?: string, house?: string },
 *           b: { submissionId?: string, house?: string }, gameIndex?: number, round?: number|null, pairingId?: string|null,
 *           priority?: number, now: number }} game
 * @returns {{ matchId: string, statements: object[] }}
 */
export function enqueueMatch(store, game) {
  const matchId = crypto.randomUUID();
  const priority = game.priority ?? JOB_PRIORITY[game.stage];
  return {
    matchId,
    statements: [
      store.statement(
        `INSERT INTO matches (id, event_id, stage, round, pairing_id, game_index, map_id, policy_version,
                              a_submission_id, a_house, b_submission_id, b_house, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        matchId, game.eventId, game.stage, game.round ?? null, game.pairingId ?? null, game.gameIndex ?? 0, game.mapId,
        BOT_CUP_POLICY.matchPolicyVersion,
        game.a.submissionId ?? null, game.a.house ?? null, game.b.submissionId ?? null, game.b.house ?? null, game.now
      ),
      store.statement(
        `INSERT INTO jobs (id, event_id, kind, priority, match_id, created_at, updated_at)
         VALUES (?, ?, 'match', ?, ?, ?, ?)`,
        crypto.randomUUID(), game.eventId, priority, matchId, game.now, game.now
      )
    ]
  };
}

/**
 * A practice request: two games (one per colour) and their jobs, created only while the team has room in today's limit.
 * The first INSERT carries the limit check; everything else exists only if that row does, so the batch is all or nothing
 * even with two requests racing.
 * @returns {{ matchIds: string[], statements: object[] }}
 */
export function enqueuePractice(store, { eventId, teamId, games, dayStart, gamesPerDay, now }) {
  const matchIds = games.map(() => crypto.randomUUID());
  const statements = [];
  games.forEach((game, index) => {
    const matchId = matchIds[index];
    const guard = index === 0
      ? ["(SELECT COUNT(*) FROM matches WHERE requested_by_team = ? AND created_at >= ?) <= ?", teamId, dayStart, gamesPerDay - games.length]
      : ["EXISTS (SELECT 1 FROM matches WHERE id = ?)", matchIds[0]];
    statements.push(store.statement(
      `INSERT INTO matches (id, event_id, stage, game_index, map_id, policy_version, a_submission_id, a_house, b_submission_id, b_house,
                            requested_by_team, created_at)
       SELECT ?, ?, 'practice', ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard[0]}`,
      matchId, eventId, game.gameIndex, game.mapId, BOT_CUP_POLICY.matchPolicyVersion,
      game.a.submissionId ?? null, game.a.house ?? null, game.b.submissionId ?? null, game.b.house ?? null, teamId, now,
      ...guard.slice(1)
    ));
    statements.push(store.statement(
      `INSERT INTO jobs (id, event_id, kind, priority, match_id, created_at, updated_at)
       SELECT ?, ?, 'match', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM matches WHERE id = ?)`,
      crypto.randomUUID(), eventId, JOB_PRIORITY.practice, matchId, now, now, matchId
    ));
  });
  return { matchIds, statements };
}

/** gzip of a UTF-8 string, with the Web streams API (Workers and Node). */
export async function gzipText(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzipText(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}
