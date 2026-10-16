/**
 * packages/arena-node/src/persistence/tournament-repository.mjs
 *
 * Task 13 (Milestone M4): SQLite repository for Double Round-Robin tournaments.
 *
 * Features:
 * - Atomic creation of tournament, entries, initial standings, matches, mappings, and jobs.
 * - Pins READY bot versions, artifacts, execution profiles, ruleset, and policy.
 * - Enforces idempotency via api_requests (same key -> replay; different payload -> 409).
 * - Standings initialized once to 0 (finalizer is the sole points writer).
 * - Equal competition rank computation for standings display.
 * - Admin match retry preserving match identity.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  generateDoubleRoundRobinSchedule,
  validateTournamentEntries
} from "../../../arena/src/domain/round-robin.mjs";

import { withTransaction } from "./sqlite-database.mjs";
import { IdempotencyConflictError, NotFoundError } from "./bot-repository.mjs";
import { createNodeEngine, coreConfig } from "../core/node-engine.mjs";

export { IdempotencyConflictError, NotFoundError };

export class TournamentValidationError extends Error {
  constructor(message, code = "TOURNAMENT_VALIDATION_ERROR") {
    super(message);
    this.name = "TournamentValidationError";
    this.code = code;
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

function sortKeys(val) {
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(sortKeys);
  const out = {};
  for (const k of Object.keys(val).sort()) out[k] = sortKeys(val[k]);
  return out;
}

function canonicalDigest(value) {
  const json = JSON.stringify(sortKeys(value));
  return createHash("sha256").update(json, "utf8").digest("hex");
}

function toJsonString(val) {
  if (typeof val === "string") return val;
  return JSON.stringify(val);
}

// ── Repository Factory ────────────────────────────────────────────────────────

/**
 * Creates a TournamentRepository instance bound to a SQLite database.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [options]
 */
export function createTournamentRepository(db, options = {}) {
  if (!db) {
    throw new TypeError("createTournamentRepository requires a database instance");
  }

  const scheduleGenerator = options.scheduleGenerator || generateDoubleRoundRobinSchedule;
  const validateEntries = options.validateEntries || validateTournamentEntries;

  // Prepared SQL statements
  const stmts = {
    selectTournament: db.prepare("SELECT * FROM tournaments WHERE id = ?"),
    insertTournament: db.prepare(`
      INSERT INTO tournaments (
        id, name, status, ruleset_json, policy_json, point_scheme, ranked
      ) VALUES (?, ?, 'pending', ?, ?, '3-1-0', ?)
    `),
    updateTournamentCompleted: db.prepare("UPDATE tournaments SET status = 'completed' WHERE id = ?"),

    selectBotVersion: db.prepare("SELECT * FROM bot_versions WHERE id = ?"),
    selectBot: db.prepare("SELECT * FROM bots WHERE id = ?"),

    insertTournamentEntry: db.prepare(`
      INSERT INTO tournament_entries (
        tournament_id, bot_id, bot_version_id, profile_id, profile_revision, artifact_digest
      ) VALUES (?, ?, ?, ?, ?, ?)
    `),
    selectTournamentEntries: db.prepare(`
      SELECT * FROM tournament_entries WHERE tournament_id = ? ORDER BY bot_id ASC
    `),

    insertTournamentStanding: db.prepare(`
      INSERT INTO tournament_standings (
        tournament_id, bot_id, played, wins, draws, losses, points
      ) VALUES (?, ?, 0, 0, 0, 0, 0)
    `),
    selectTournamentStandings: db.prepare(`
      SELECT * FROM tournament_standings WHERE tournament_id = ? ORDER BY points DESC, bot_id ASC
    `),

    insertMatch: db.prepare(`
      INSERT INTO matches (
        id, kind, ladder_id, ruleset_json, policy_json, profile_json,
        initial_state_json, status, tournament_id, schedule_index
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `),
    selectMatchById: db.prepare("SELECT * FROM matches WHERE id = ?"),
    insertMatchParticipant: db.prepare(`
      INSERT INTO match_participants (
        match_id, seat, bot_id, bot_version_id, artifact_digest, profile_id, profile_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    selectParticipantsByMatch: db.prepare(`
      SELECT * FROM match_participants WHERE match_id = ? ORDER BY seat ASC
    `),
    insertTournamentMatch: db.prepare(`
      INSERT INTO tournament_matches (tournament_id, schedule_index, match_id)
      VALUES (?, ?, ?)
    `),
    selectTournamentMatches: db.prepare(`
      SELECT tm.schedule_index, m.*
      FROM tournament_matches tm
      JOIN matches m ON tm.match_id = m.id
      WHERE tm.tournament_id = ?
      ORDER BY tm.schedule_index ASC
    `),
    countTournamentMatches: db.prepare(`
      SELECT
        COUNT(*) AS total_matches,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_matches
      FROM matches
      WHERE tournament_id = ?
    `),

    insertJob: db.prepare(`
      INSERT INTO jobs (id, kind, target_id, status, attempt_no, max_attempts)
      VALUES (?, 'match', ?, 'queued', 0, 3)
    `),
    selectJobByTarget: db.prepare("SELECT * FROM jobs WHERE kind = 'match' AND target_id = ?"),
    resetJobPending: db.prepare(`
      UPDATE jobs
      SET status = 'queued',
          max_attempts = MAX(max_attempts, attempt_no + 3),
          lease_owner = NULL,
          lease_token = NULL,
          lease_until = NULL,
          heartbeat_at = NULL
      WHERE kind = 'match' AND target_id = ?
    `),
    resetMatchPending: db.prepare(`
      UPDATE matches SET status = 'pending' WHERE id = ?
    `),

    selectApiRequest: db.prepare(`
      SELECT * FROM api_requests WHERE actor_id = ? AND operation = ? AND idempotency_key = ?
    `),
    insertApiRequest: db.prepare(`
      INSERT INTO api_requests (
        actor_id, operation, idempotency_key, payload_digest, target_id, response_status
      ) VALUES (?, 'createTournament', ?, ?, ?, 201)
    `)
  };

  /**
   * Synchronously creates a tournament.
   * If schedule is provided upfront (e.g. from createTournamentUseCase), it is used directly; otherwise generated.
   */
  function createTournament(input, options = {}) {
    if (!input || typeof input !== "object") {
      throw new TournamentValidationError("Missing tournament input");
    }

    const { actorId, idempotencyKey } = options;
    const name = input.name;
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      throw new TournamentValidationError("Tournament name is mandatory and non-empty");
    }

    if (!Array.isArray(input.entries) || input.entries.length < 2) {
      throw new TournamentValidationError(
        `Tournament requires at least 2 distinct bots, got ${input.entries ? input.entries.length : 0}`
      );
    }

    const rulesetJson = toJsonString(input.rulesetJson ?? input.ruleset);
    const policyJson = toJsonString(input.policyJson ?? input.policy);
    const profileJson = toJsonString(input.profileJson ?? input.profile ?? {});
    const initialStateJson = toJsonString(input.initialStateJson ?? input.initialState);

    if (!rulesetJson || rulesetJson === "undefined") throw new TournamentValidationError("Missing ruleset configuration");
    if (!policyJson || policyJson === "undefined") throw new TournamentValidationError("Missing policy configuration");
    if (!initialStateJson || initialStateJson === "undefined") throw new TournamentValidationError("Missing initial state");

    const isRanked = input.ranked === undefined ? true : Boolean(input.ranked);
    const rankedInt = isRanked ? 1 : 0;
    const matchKind = isRanked ? "ranked" : "practice";
    const ladderId = input.ladderId || "ladder-main";

    // Use schedule from input if provided, or generate using generator
    let schedule = input.schedule;
    if (!schedule) {
      schedule = scheduleGenerator(input.entries);
    }

    const tournamentId = input.id || `tourn-${randomUUID()}`;

    // Normalize entries mapping
    const entryMap = new Map();
    for (const entry of input.entries) {
      const botId = entry.botId || entry.id;
      if (!botId) throw new TournamentValidationError("Entry missing botId");
      if (!entry.botVersionId) throw new TournamentValidationError(`Entry for ${botId} missing botVersionId`);
      entryMap.set(botId, entry);
    }

    const sortedBotIds = Array.from(entryMap.keys()).sort();

    // Compute canonical payload digest for idempotency
    const payloadDigest = canonicalDigest({
      name,
      ranked: rankedInt,
      ladderId,
      rulesetJson,
      policyJson,
      profileJson,
      initialStateJson,
      entries: sortedBotIds.map((bId) => ({
        botId: bId,
        botVersionId: entryMap.get(bId).botVersionId
      })),
      operation: "createTournament"
    });

    return withTransaction(db, () => {
      // 1. Idempotency check if key provided
      if (actorId && idempotencyKey) {
        const existingReq = stmts.selectApiRequest.get(actorId, "createTournament", idempotencyKey);
        if (existingReq) {
          if (existingReq.payload_digest !== payloadDigest) {
            throw new IdempotencyConflictError(idempotencyKey, "createTournament");
          }
          return getTournament(existingReq.target_id);
        }
      }

      // 2. Validate all bot versions are READY and pin them
      const pinnedEntries = new Map();
      for (const botId of sortedBotIds) {
        const entry = entryMap.get(botId);
        const ver = stmts.selectBotVersion.get(entry.botVersionId);
        if (!ver) {
          throw new NotFoundError("bot_version", entry.botVersionId);
        }
        if (ver.bot_id !== botId) {
          throw new TournamentValidationError(
            `Bot version ${ver.id} belongs to bot '${ver.bot_id}', not '${botId}'`
          );
        }
        if (ver.build_status !== "ready") {
          throw new TournamentValidationError(
            `Bot version ${ver.id} for bot '${botId}' is not ready (status: ${ver.build_status})`
          );
        }
        if (!ver.artifact_digest) {
          throw new TournamentValidationError(
            `Bot version ${ver.id} for bot '${botId}' is missing artifact_digest`
          );
        }
        pinnedEntries.set(botId, {
          botId,
          botVersionId: ver.id,
          profileId: ver.profile_id,
          profileRevision: ver.profile_revision,
          artifactDigest: ver.artifact_digest
        });
      }

      // 3. Insert into tournaments
      stmts.insertTournament.run(
        tournamentId,
        name,
        rulesetJson,
        policyJson,
        rankedInt
      );

      // 4. Insert tournament_entries and initial tournament_standings
      for (const botId of sortedBotIds) {
        const pinned = pinnedEntries.get(botId);
        stmts.insertTournamentEntry.run(
          tournamentId,
          botId,
          pinned.botVersionId,
          pinned.profileId,
          pinned.profileRevision,
          pinned.artifactDigest
        );
        stmts.insertTournamentStanding.run(tournamentId, botId);
      }

      if (input.startImmediately === false) {
        if (actorId && idempotencyKey) stmts.insertApiRequest.run(actorId, idempotencyKey, payloadDigest, tournamentId);
        return getTournament(tournamentId);
      }

      // 5. Create all matches, participants, tournament_matches, and jobs
      for (const matchSlot of schedule) {
        const matchId = `${tournamentId}-m${matchSlot.scheduleIndex}`;
        const pinnedA = pinnedEntries.get(matchSlot.botAId);
        const pinnedB = pinnedEntries.get(matchSlot.botBId);

        if (!pinnedA || !pinnedB) {
          throw new TournamentValidationError(
            `Match slot ${matchSlot.scheduleIndex} references unknown participant: ${matchSlot.botAId} vs ${matchSlot.botBId}`
          );
        }

        // Insert match row
        stmts.insertMatch.run(
          matchId,
          matchKind,
          ladderId,
          rulesetJson,
          policyJson,
          profileJson,
          initialStateJson,
          tournamentId,
          matchSlot.scheduleIndex
        );

        // Pin participants A and B
        stmts.insertMatchParticipant.run(
          matchId,
          "A",
          pinnedA.botId,
          pinnedA.botVersionId,
          pinnedA.artifactDigest,
          pinnedA.profileId,
          pinnedA.profileRevision
        );

        stmts.insertMatchParticipant.run(
          matchId,
          "B",
          pinnedB.botId,
          pinnedB.botVersionId,
          pinnedB.artifactDigest,
          pinnedB.profileId,
          pinnedB.profileRevision
        );

        // Map tournament match slot
        stmts.insertTournamentMatch.run(tournamentId, matchSlot.scheduleIndex, matchId);

        // Create job row
        const jobId = `job-${matchId}`;
        stmts.insertJob.run(jobId, matchId);
      }

      // 6. Record idempotency if requested
      if (actorId && idempotencyKey) {
        stmts.insertApiRequest.run(actorId, idempotencyKey, payloadDigest, tournamentId);
      }

      return getTournament(tournamentId);
    });
  }

  /**
   * Retrieves tournament record with completed and total matches counts.
   */
  function getTournament(tournamentId) {
    const t = stmts.selectTournament.get(tournamentId);
    if (!t) return undefined;

    const counts = stmts.countTournamentMatches.get(tournamentId);
    const totalMatches = counts ? counts.total_matches : 0;
    const completedMatches = counts ? counts.completed_matches : 0;

    let status = t.status;
    if (status !== "completed" && totalMatches > 0 && completedMatches === totalMatches) {
      stmts.updateTournamentCompleted.run(tournamentId);
      status = "completed";
    }

    return {
      ...t,
      status,
      totalMatches,
      completedMatches
    };
  }

  /**
   * Retrieves all entries for a tournament.
   */
  function getTournamentEntries(tournamentId) {
    return stmts.selectTournamentEntries.all(tournamentId);
  }

  /**
   * Retrieves all matches for a tournament with participants.
   */
  function getTournamentMatches(tournamentId) {
    const rows = stmts.selectTournamentMatches.all(tournamentId);
    return rows.map((m) => {
      const pRows = stmts.selectParticipantsByMatch.all(m.id);
      const participants = {};
      for (const p of pRows) {
        participants[p.seat] = p;
      }
      return {
        ...m,
        participants
      };
    });
  }

  /**
   * Retrieves tournament standings sorted by points DESC, bot_id ASC,
   * with standard competition rank assigned (tied points share equal rank).
   */
  function getTournamentStandings(tournamentId) {
    const rows = stmts.selectTournamentStandings.all(tournamentId);
    if (rows.length === 0) return [];

    let currentRank = 1;
    for (let i = 0; i < rows.length; i++) {
      if (i > 0 && rows[i].points < rows[i - 1].points) {
        currentRank = i + 1; // standard competition rank: 1, 1, 3
      }
      rows[i].rank = currentRank;
    }

    return rows;
  }

  function startTournament(tournamentId) {
    return withTransaction(db, () => {
      const tournament = getTournament(tournamentId);
      if (!tournament) throw new NotFoundError("tournament", tournamentId);
      const existing = stmts.selectTournamentMatches.all(tournamentId);
      if (existing.length > 0) return tournament;
      const entries = stmts.selectTournamentEntries.all(tournamentId).map((entry) => ({
        botId: entry.bot_id,
        botVersionId: entry.bot_version_id
      }));
      const schedule = scheduleGenerator(entries);
      const engine = createNodeEngine();
      const initialStateJson = JSON.stringify(engine.createInitialState());
      const matchKind = tournament.ranked ? "ranked" : "practice";
      const pinned = new Map(entries.map((entry) => {
        const row = db.prepare("SELECT * FROM bot_versions WHERE id = ?").get(entry.botVersionId);
        return [entry.botId, { botId: entry.botId, botVersionId: row.id, profileId: row.profile_id, profileRevision: row.profile_revision, artifactDigest: row.artifact_digest }];
      }));
      for (const slot of schedule) {
        const matchId = `${tournamentId}-m${slot.scheduleIndex}`;
        const a = pinned.get(slot.botAId);
        const b = pinned.get(slot.botBId);
        db.prepare("INSERT INTO matches (id, kind, ladder_id, ruleset_json, policy_json, profile_json, initial_state_json, status, tournament_id, schedule_index) VALUES (?, ?, 'ladder-main', ?, ?, '{}', ?, 'pending', ?, ?)").run(matchId, matchKind, tournament.ruleset_json, tournament.policy_json, initialStateJson, tournamentId, slot.scheduleIndex);
        stmts.insertMatchParticipant.run(matchId, "A", a.botId, a.botVersionId, a.artifactDigest, a.profileId, a.profileRevision);
        stmts.insertMatchParticipant.run(matchId, "B", b.botId, b.botVersionId, b.artifactDigest, b.profileId, b.profileRevision);
        stmts.insertTournamentMatch.run(tournamentId, slot.scheduleIndex, matchId);
        stmts.insertJob.run(`job-${matchId}`, matchId);
      }
      db.prepare("UPDATE tournaments SET status = 'active' WHERE id = ? AND status = 'pending'").run(tournamentId);
      return getTournament(tournamentId);
    });
  }

  /**
   * Retries a tournament match by resetting match status to 'pending' and re-queueing its job.
   */
  function retryMatch(tournamentId, scheduleIndex) {
    const matchRow = db
      .prepare("SELECT match_id FROM tournament_matches WHERE tournament_id = ? AND schedule_index = ?")
      .get(tournamentId, scheduleIndex);

    if (!matchRow) {
      throw new NotFoundError("tournament_match", `${tournamentId}#${scheduleIndex}`);
    }

    const matchId = matchRow.match_id;

    return withTransaction(db, () => {
      stmts.resetMatchPending.run(matchId);
      stmts.resetJobPending.run(matchId);
      return stmts.selectMatchById.get(matchId);
    });
  }

  return {
    createTournament,
    getTournament,
    getTournamentEntries,
    getTournamentMatches,
    getTournamentStandings,
    startTournament,
    retryMatch
  };
}
