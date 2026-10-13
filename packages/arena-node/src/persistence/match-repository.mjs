/**
 * match-repository.mjs
 *
 * Repository for matches and match participants (pinning + read foundation).
 *
 * Public API:
 *   createMatchRepository(db) → MatchRepository
 *
 * MatchRepository methods:
 *   createMatch({
 *     id?,
 *     kind,               // mandatory: "ranked" | "practice"
 *     ladderId,
 *     rulesetJson | ruleset,
 *     policyJson | policy,
 *     profileJson | profile,
 *     initialStateJson | initialState,
 *     participants: { A: { botId?, botVersionId }, B: { botId?, botVersionId } }
 *       OR [{ seat: "A", botId?, botVersionId }, { seat: "B", botId?, botVersionId }],
 *     tournamentId?,
 *     scheduleIndex?
 *   }, options?: { idempotencyKey?, actorId? }) → MatchRecord
 *
 *   getMatch(matchId) → MatchRecord | undefined
 *   listMatches(filter?: { ladderId?, status?, kind?, tournamentId?, limit?, offset? }) → MatchRecord[]
 *   getMatchParticipants(matchId) → Record<"A" | "B", ParticipantRecord>
 *   getMatchResult(matchId) → MatchResultRecord | undefined
 *   getBotRating(ladderId, botId) → BotRatingRecord
 *   getTournament(id) → TournamentRecord | undefined
 *   getTournamentStandings(tournamentId) → TournamentStandingRecord[]
 *
 * Rules enforced:
 *   - Discriminator `kind` is mandatory and must be "ranked" or "practice".
 *   - "ranked" matches require distinct bots (botA.id !== botB.id).
 *   - Pinning: Both bot versions must be READY ('build_status' === 'ready').
 *     The match_participants row pins bot_id, bot_version_id, artifact_digest,
 *     profile_id, and profile_revision at creation time within the transaction.
 *     Subsequent updates to bot or bot_version do NOT alter queued/finished matches.
 *   - Idempotency: Supports optional idempotencyKey + actorId in api_requests table.
 *
 * Scope note:
 *   Task 8 establishes match creation, pinning, and query foundation.
 *   Independent writes for result settlement, Elo changes, and tournament orchestration
 *   belong to future Tasks 11 (fenced finalizer) and 13 (tournaments) and are NOT
 *   exposed here to prevent bypassing atomic finalizer fencing.
 */

import { createHash, randomUUID } from "node:crypto";
import { IdempotencyConflictError, NotFoundError, OwnershipError } from "./bot-repository.mjs";

export { IdempotencyConflictError, NotFoundError, OwnershipError };

export class MatchValidationError extends Error {
  constructor(message, code = "MATCH_VALIDATION_ERROR") {
    super(message);
    this.name = "MatchValidationError";
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

// ── Repository factory ────────────────────────────────────────────────────────

/**
 * @param {import('better-sqlite3').Database} db
 */
export function createMatchRepository(db) {
  const stmts = {
    // Users / Bots check
    selectUser: db.prepare("SELECT * FROM users WHERE id = ?"),
    selectBot: db.prepare("SELECT * FROM bots WHERE id = ?"),
    selectBotVersion: db.prepare("SELECT * FROM bot_versions WHERE id = ?"),

    // Matches
    insertMatch: db.prepare(`
      INSERT INTO matches (
        id, kind, ladder_id, ruleset_json, policy_json, profile_json,
        initial_state_json, status, tournament_id, schedule_index
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    selectMatch: db.prepare("SELECT * FROM matches WHERE id = ?"),

    // Match Participants
    insertMatchParticipant: db.prepare(`
      INSERT INTO match_participants (
        match_id, seat, bot_id, bot_version_id, artifact_digest, profile_id, profile_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    selectParticipantsByMatch: db.prepare(`
      SELECT * FROM match_participants WHERE match_id = ? ORDER BY seat ASC
    `),

    // Match Results (read-only query in Task 8)
    selectMatchResult: db.prepare("SELECT * FROM match_results WHERE match_id = ?"),

    // Ratings (read-only query in Task 8)
    selectBotRating: db.prepare(`
      SELECT * FROM bot_ratings WHERE ladder_id = ? AND bot_id = ?
    `),

    // Tournaments (read-only query in Task 8)
    selectTournament: db.prepare("SELECT * FROM tournaments WHERE id = ?"),
    selectTournamentStandings: db.prepare(`
      SELECT * FROM tournament_standings WHERE tournament_id = ? ORDER BY points DESC, bot_id ASC
    `),

    // Idempotency
    selectApiRequest: db.prepare(`
      SELECT * FROM api_requests WHERE actor_id = ? AND operation = ? AND idempotency_key = ?
    `),
    insertApiRequest: db.prepare(`
      INSERT INTO api_requests (
        actor_id, operation, idempotency_key, payload_digest, target_id, response_status
      ) VALUES (?, ?, ?, ?, ?, 200)
    `)
  };

  // ── checkIdempotency ────────────────────────────────────────────────────────

  function checkIdempotency(actorId, operation, idempotencyKey, payloadDigest) {
    const existing = stmts.selectApiRequest.get(actorId, operation, idempotencyKey);
    if (!existing) return null;
    if (existing.payload_digest !== payloadDigest) {
      throw new IdempotencyConflictError(idempotencyKey, operation);
    }
    return existing.target_id;
  }

  // ── normalizeParticipants ───────────────────────────────────────────────────

  function normalizeParticipants(participants) {
    if (!participants) {
      throw new MatchValidationError("Missing match participants");
    }

    let pA = null;
    let pB = null;

    if (Array.isArray(participants)) {
      for (const p of participants) {
        if (p.seat === "A") pA = p;
        else if (p.seat === "B") pB = p;
      }
    } else if (typeof participants === "object") {
      pA = participants.A;
      pB = participants.B;
    }

    if (!pA || !pB) {
      throw new MatchValidationError("Match must specify participants for both seat A and seat B");
    }

    if (!pA.botVersionId || !pB.botVersionId) {
      throw new MatchValidationError("Participants must specify botVersionId");
    }

    return { A: pA, B: pB };
  }

  // ── createMatch ────────────────────────────────────────────────────────────

  function createMatch(input, options = {}) {
    const { idempotencyKey, actorId } = options;

    // Discriminator kind validation
    if (!input || !input.kind) {
      throw new MatchValidationError("Match kind is mandatory ('ranked' or 'practice')", "MISSING_MATCH_KIND");
    }
    if (input.kind !== "ranked" && input.kind !== "practice") {
      throw new MatchValidationError(`Invalid match kind '${input.kind}': must be 'ranked' or 'practice'`, "INVALID_MATCH_KIND");
    }

    if (!input.ladderId || typeof input.ladderId !== "string" || input.ladderId.trim().length === 0) {
      throw new MatchValidationError("Missing or invalid ladderId");
    }

    const normParticipants = normalizeParticipants(input.participants);

    const rulesetJson = toJsonString(input.rulesetJson ?? input.ruleset);
    const policyJson = toJsonString(input.policyJson ?? input.policy);
    const profileJson = toJsonString(input.profileJson ?? input.profile ?? {});
    const initialStateJson = toJsonString(input.initialStateJson ?? input.initialState);

    if (!rulesetJson || rulesetJson === "undefined") throw new MatchValidationError("Missing ruleset configuration");
    if (!policyJson || policyJson === "undefined") throw new MatchValidationError("Missing policy configuration");
    if (!initialStateJson || initialStateJson === "undefined") throw new MatchValidationError("Missing initial state");

    const matchId = input.id || `match-${randomUUID()}`;

    const payloadDigest = canonicalDigest({
      id: matchId,
      kind: input.kind,
      ladderId: input.ladderId,
      rulesetJson,
      policyJson,
      profileJson,
      initialStateJson,
      tournamentId: input.tournamentId ?? null,
      scheduleIndex: input.scheduleIndex ?? null,
      participants: {
        A: { botVersionId: normParticipants.A.botVersionId },
        B: { botVersionId: normParticipants.B.botVersionId }
      },
      operation: "createMatch"
    });

    return db.transaction(() => {
      // 1. Idempotency check if key provided
      if (actorId && idempotencyKey) {
        const existingId = checkIdempotency(actorId, "createMatch", idempotencyKey, payloadDigest);
        if (existingId !== null) {
          return getMatch(existingId);
        }
      }

      // 2. Fetch and validate versions
      const verA = stmts.selectBotVersion.get(normParticipants.A.botVersionId);
      if (!verA) {
        throw new NotFoundError("bot_version", normParticipants.A.botVersionId);
      }
      const verB = stmts.selectBotVersion.get(normParticipants.B.botVersionId);
      if (!verB) {
        throw new NotFoundError("bot_version", normParticipants.B.botVersionId);
      }

      // Both bot versions must be READY
      if (verA.build_status !== "ready") {
        throw new MatchValidationError(
          `Seat A bot version ${verA.id} is not ready (status: ${verA.build_status})`,
          "BOT_VERSION_NOT_READY"
        );
      }
      if (verB.build_status !== "ready") {
        throw new MatchValidationError(
          `Seat B bot version ${verB.id} is not ready (status: ${verB.build_status})`,
          "BOT_VERSION_NOT_READY"
        );
      }

      // 3. Ranked match requires distinct bots
      if (input.kind === "ranked" && verA.bot_id === verB.bot_id) {
        throw new MatchValidationError(
          `Ranked match requires distinct bots; got bot '${verA.bot_id}' for both seats`,
          "RANKED_DISTINCT_BOTS_REQUIRED"
        );
      }

      // 4. Ownership check if actorId supplied
      if (actorId) {
        const actor = stmts.selectUser.get(actorId);
        if (!actor) throw new NotFoundError("user", actorId);
        if (actor.role !== "admin") {
          const botA = stmts.selectBot.get(verA.bot_id);
          const botB = stmts.selectBot.get(verB.bot_id);
          if (botA?.owner_id !== actorId && botB?.owner_id !== actorId) {
            throw new OwnershipError("participating bots", `${verA.bot_id}/${verB.bot_id}`, actorId);
          }
        }
      }

      // 5. Insert match row
      stmts.insertMatch.run(
        matchId,
        input.kind,
        input.ladderId,
        rulesetJson,
        policyJson,
        profileJson,
        initialStateJson,
        input.status || "pending",
        input.tournamentId ?? null,
        input.scheduleIndex ?? null
      );

      // 6. Pin participants (bot_id, bot_version_id, artifact_digest, profile_id, profile_revision)
      stmts.insertMatchParticipant.run(
        matchId,
        "A",
        verA.bot_id,
        verA.id,
        verA.artifact_digest,
        verA.profile_id,
        verA.profile_revision
      );

      stmts.insertMatchParticipant.run(
        matchId,
        "B",
        verB.bot_id,
        verB.id,
        verB.artifact_digest,
        verB.profile_id,
        verB.profile_revision
      );

      // 7. Store idempotency record if requested
      if (actorId && idempotencyKey) {
        stmts.insertApiRequest.run(actorId, "createMatch", idempotencyKey, payloadDigest, matchId);
      }

      return getMatch(matchId);
    }).immediate();
  }

  // ── getMatch ───────────────────────────────────────────────────────────────

  function getMatch(matchId) {
    const match = stmts.selectMatch.get(matchId);
    if (!match) return undefined;

    const participantsRows = stmts.selectParticipantsByMatch.all(matchId);
    const participants = {};
    for (const p of participantsRows) {
      participants[p.seat] = p;
    }

    return {
      ...match,
      participants
    };
  }

  // ── listMatches ────────────────────────────────────────────────────────────

  function listMatches(filter = {}) {
    let sql = "SELECT * FROM matches WHERE 1=1";
    const params = [];

    if (filter.ladderId) {
      sql += " AND ladder_id = ?";
      params.push(filter.ladderId);
    }
    if (filter.status) {
      sql += " AND status = ?";
      params.push(filter.status);
    }
    if (filter.kind) {
      sql += " AND kind = ?";
      params.push(filter.kind);
    }
    if (filter.tournamentId) {
      sql += " AND tournament_id = ?";
      params.push(filter.tournamentId);
    }

    sql += " ORDER BY created_at DESC";

    if (typeof filter.limit === "number") {
      sql += " LIMIT ?";
      params.push(filter.limit);
      if (typeof filter.offset === "number") {
        sql += " OFFSET ?";
        params.push(filter.offset);
      }
    }

    const rows = db.prepare(sql).all(...params);
    return rows.map((m) => {
      const participantsRows = stmts.selectParticipantsByMatch.all(m.id);
      const participants = {};
      for (const p of participantsRows) {
        participants[p.seat] = p;
      }
      return { ...m, participants };
    });
  }

  // ── getMatchParticipants ───────────────────────────────────────────────────

  function getMatchParticipants(matchId) {
    const rows = stmts.selectParticipantsByMatch.all(matchId);
    const participants = {};
    for (const r of rows) {
      participants[r.seat] = r;
    }
    return participants;
  }

  // ── getMatchResult ─────────────────────────────────────────────────────────

  function getMatchResult(matchId) {
    return stmts.selectMatchResult.get(matchId) ?? undefined;
  }

  // ── getBotRating ───────────────────────────────────────────────────────────

  function getBotRating(ladderId, botId) {
    const row = stmts.selectBotRating.get(ladderId, botId);
    if (row) return row;
    return {
      ladder_id: ladderId,
      bot_id: botId,
      rating: 1200.0,
      rated_games: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      updated_at: null
    };
  }

  // ── Tournament read foundation methods ─────────────────────────────────────

  function getTournament(id) {
    return stmts.selectTournament.get(id) ?? undefined;
  }

  function getTournamentStandings(tournamentId) {
    return stmts.selectTournamentStandings.all(tournamentId);
  }

  return {
    createMatch,
    getMatch,
    listMatches,
    getMatchParticipants,
    getMatchResult,
    getBotRating,
    getTournament,
    getTournamentStandings
  };
}
