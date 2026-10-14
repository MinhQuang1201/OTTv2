/**
 * packages/arena-node/src/persistence/competition-repository.mjs
 *
 * Task 1 (Arena Part A): SQLite repository for Competition / Event lifecycle.
 *
 * Lifecycle Phases:
 *   registration -> preparation -> locked -> running -> completed
 *
 * Key guarantees:
 * - Atomic phase transitions and tournament creation inside transactions.
 * - Rollback on any failure during tournament launch leaves competition locked.
 * - Idempotency per user registration and mandatory capacity enforcement.
 * - Ownership & readiness validation on bot version submissions.
 * - Immutable version pinning at lock.
 * - Linked tournament match error retry API.
 */

import { createHash, randomUUID } from "node:crypto";
import { withTransaction, applyMigration } from "./sqlite-database.mjs";
import { IdempotencyConflictError, NotFoundError } from "./bot-repository.mjs";
import { createTournamentRepository } from "./tournament-repository.mjs";
import { createNodeEngine, coreConfig } from "../core/node-engine.mjs";
import {
  DEFAULT_MATCH_POLICY,
  createCurrentRulesetSnapshot
} from "../../../arena/src/contracts/index.mjs";

export { IdempotencyConflictError, NotFoundError };

export class CompetitionValidationError extends Error {
  constructor(message, code = "VALIDATION_ERROR") {
    super(message);
    this.name = "CompetitionValidationError";
    this.code = code;
  }
}

export class CompetitionPhaseError extends Error {
  constructor(message, code = "PHASE_MISMATCH") {
    super(message);
    this.name = "CompetitionPhaseError";
    this.code = code;
  }
}

export class CompetitionCapacityError extends Error {
  constructor(message, code = "CAPACITY_EXCEEDED") {
    super(message);
    this.name = "CompetitionCapacityError";
    this.code = code;
  }
}

export class BotNotReadyError extends Error {
  constructor(message, code = "BOT_VERSION_NOT_READY") {
    super(message);
    this.name = "BotNotReadyError";
    this.code = code;
  }
}

export class ForbiddenError extends Error {
  constructor(message, code = "FORBIDDEN") {
    super(message);
    this.name = "ForbiddenError";
    this.code = code;
  }
}

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

function mapCompetition(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    phase: row.phase,
    capacity: row.capacity,
    ranked: Boolean(row.ranked),
    tournamentId: row.tournament_id || null,
    createdAt: row.created_at
  };
}

function mapEntry(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    username: row.username,
    status: row.status,
    botId: row.bot_id || null,
    botName: row.bot_name || null,
    botVersionId: row.bot_version_id || null,
    versionNo: row.version_no !== null && row.version_no !== undefined ? row.version_no : null,
    buildStatus: row.build_status || null
  };
}

/**
 * Creates a CompetitionRepository instance bound to a SQLite database.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [options]
 * @param {object} [options.tournamentRepo]
 */
export function createCompetitionRepository(db, options = {}) {
  if (!db) {
    throw new TypeError("createCompetitionRepository requires a database instance");
  }

  // Ensure migration 002-competitions is applied
  applyMigration(db, "002-competitions");

  const tournamentRepo = options.tournamentRepo || createTournamentRepository(db);

  const stmts = {
    selectCompetition: db.prepare(`
      SELECT id, name, description, phase, capacity, ranked, tournament_id, created_at, updated_at
      FROM competitions WHERE id = ?
    `),
    insertCompetition: db.prepare(`
      INSERT INTO competitions (id, name, description, phase, capacity, ranked, created_at, updated_at)
      VALUES (?, ?, ?, 'registration', ?, ?, datetime('now'), datetime('now'))
    `),
    listCompetitions: db.prepare(`
      SELECT id, name, description, phase, capacity, ranked, tournament_id, created_at, updated_at
      FROM competitions
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `),
    updatePhase: db.prepare(`
      UPDATE competitions
      SET phase = ?,
          tournament_id = COALESCE(?, tournament_id),
          updated_at = datetime('now')
      WHERE id = ?
    `),
    selectEntriesForCompetition: db.prepare(`
      SELECT
        ce.user_id,
        u.normalized_username AS username,
        ce.status,
        ce.bot_id,
        b.name AS bot_name,
        ce.bot_version_id,
        bv.version_no,
        bv.build_status,
        ce.created_at,
        ce.updated_at
      FROM competition_entries ce
      JOIN users u ON u.id = ce.user_id
      LEFT JOIN bots b ON b.id = ce.bot_id
      LEFT JOIN bot_versions bv ON bv.id = ce.bot_version_id
      WHERE ce.competition_id = ?
      ORDER BY ce.created_at ASC, ce.user_id ASC
    `),
    selectSingleEntry: db.prepare(`
      SELECT
        ce.competition_id,
        ce.user_id,
        u.normalized_username AS username,
        ce.status,
        ce.bot_id,
        b.name AS bot_name,
        ce.bot_version_id,
        bv.version_no,
        bv.build_status,
        ce.created_at,
        ce.updated_at
      FROM competition_entries ce
      JOIN users u ON u.id = ce.user_id
      LEFT JOIN bots b ON b.id = ce.bot_id
      LEFT JOIN bot_versions bv ON bv.id = ce.bot_version_id
      WHERE ce.competition_id = ? AND ce.user_id = ?
    `),
    countEntries: db.prepare(`
      SELECT
        COUNT(*) AS total_count,
        SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted_count,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN status = 'declined' THEN 1 ELSE 0 END) AS declined_count
      FROM competition_entries
      WHERE competition_id = ?
    `),
    insertEntry: db.prepare(`
      INSERT INTO competition_entries (
        competition_id, user_id, status, bot_id, bot_version_id, created_at, updated_at
      ) VALUES (?, ?, 'pending', NULL, NULL, datetime('now'), datetime('now'))
    `),
    updateEntryStatus: db.prepare(`
      UPDATE competition_entries
      SET status = ?, updated_at = datetime('now')
      WHERE competition_id = ? AND user_id = ?
    `),
    updateEntryBotVersion: db.prepare(`
      UPDATE competition_entries
      SET bot_id = ?, bot_version_id = ?, updated_at = datetime('now')
      WHERE competition_id = ? AND user_id = ?
    `),
    selectBotVersionWithBot: db.prepare(`
      SELECT bv.*, b.owner_id, b.status AS bot_status
      FROM bot_versions bv
      JOIN bots b ON b.id = bv.bot_id
      WHERE bv.id = ?
    `),
    selectApiRequest: db.prepare(`
      SELECT * FROM api_requests WHERE actor_id = ? AND operation = ? AND idempotency_key = ?
    `),
    insertApiRequest: db.prepare(`
      INSERT INTO api_requests (
        actor_id, operation, idempotency_key, payload_digest, target_id, response_status
      ) VALUES (?, 'createCompetition', ?, ?, ?, 201)
    `),
    selectMatchCountsForTournament: db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errored
      FROM matches
      WHERE tournament_id = ?
    `),
    selectTournamentMatchBySchedule: db.prepare(`
      SELECT m.id, m.status
      FROM tournament_matches tm
      JOIN matches m ON tm.match_id = m.id
      WHERE tm.tournament_id = ? AND tm.schedule_index = ?
    `)
  };

  /**
   * Creates a competition in the registration phase.
   */
  function createCompetition(input, opts = {}) {
    if (!input || typeof input !== "object") {
      throw new CompetitionValidationError("Missing competition input");
    }

    const { actorId, idempotencyKey } = opts;

    const rawName = input.name;
    if (typeof rawName !== "string" || rawName.trim().length === 0) {
      throw new CompetitionValidationError("Competition name is required and cannot be empty");
    }
    const name = rawName.trim();
    if (name.length > 255) {
      throw new CompetitionValidationError("Competition name exceeds maximum length of 255 characters");
    }

    const description = typeof input.description === "string" ? input.description.trim() : "";

    let capacity = 16;
    if (input.capacity !== undefined && input.capacity !== null) {
      const cap = Number(input.capacity);
      if (!Number.isInteger(cap) || cap < 2 || cap > 128) {
        throw new CompetitionValidationError("Competition capacity must be an integer between 2 and 128");
      }
      capacity = cap;
    }

    const ranked = input.ranked === undefined ? true : Boolean(input.ranked);
    const rankedInt = ranked ? 1 : 0;

    const payloadDigest = canonicalDigest({
      name,
      description,
      capacity,
      ranked: rankedInt,
      operation: "createCompetition"
    });

    const competitionId = input.id || `comp-${randomUUID()}`;

    return withTransaction(db, () => {
      if (actorId && idempotencyKey) {
        const existingReq = stmts.selectApiRequest.get(actorId, "createCompetition", idempotencyKey);
        if (existingReq) {
          if (existingReq.payload_digest !== payloadDigest) {
            throw new IdempotencyConflictError(idempotencyKey, "createCompetition");
          }
          return getCompetition(existingReq.target_id);
        }
      }

      stmts.insertCompetition.run(
        competitionId,
        name,
        description,
        capacity,
        rankedInt
      );

      if (actorId && idempotencyKey) {
        stmts.insertApiRequest.run(actorId, idempotencyKey, payloadDigest, competitionId);
      }

      return getCompetition(competitionId);
    });
  }

  /**
   * Retrieves competition by ID.
   */
  function getCompetition(competitionId) {
    const row = stmts.selectCompetition.get(competitionId);
    return mapCompetition(row);
  }

  /**
   * Lists competitions paginated.
   */
  function listCompetitions({ limit = 50, offset = 0 } = {}) {
    const lim = Math.max(1, Math.min(100, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    const rows = stmts.listCompetitions.all(lim, off);
    return rows.map(mapCompetition);
  }

  /**
   * Retrieves competition along with all participant entries.
   */
  function getCompetitionWithEntries(competitionId) {
    const comp = getCompetition(competitionId);
    if (!comp) return null;

    const rows = stmts.selectEntriesForCompetition.all(competitionId);
    const entries = rows.map(mapEntry);

    return { competition: comp, entries };
  }

  /**
   * Registers a participant entry (idempotent per user).
   */
  function registerEntry(competitionId, userId) {
    return withTransaction(db, () => {
      const comp = stmts.selectCompetition.get(competitionId);
      if (!comp) {
        throw new NotFoundError("competition", competitionId);
      }
      if (comp.phase !== "registration") {
        throw new CompetitionPhaseError(`Cannot register: competition phase is '${comp.phase}'`);
      }

      const existing = stmts.selectSingleEntry.get(competitionId, userId);
      if (existing) {
        return mapEntry(existing);
      }

      const counts = stmts.countEntries.get(competitionId);
      const activeCount = (counts ? (counts.accepted_count || 0) + (counts.pending_count || 0) : 0);
      if (activeCount >= comp.capacity) {
        throw new CompetitionCapacityError("Competition has reached maximum capacity");
      }

      stmts.insertEntry.run(competitionId, userId);
      const created = stmts.selectSingleEntry.get(competitionId, userId);
      return mapEntry(created);
    });
  }

  /**
   * Reviews a participant entry (admin accept/decline).
   */
  function reviewEntry(competitionId, userId, accepted) {
    if (typeof accepted !== "boolean") {
      throw new CompetitionValidationError("Field 'accepted' must be a boolean");
    }

    return withTransaction(db, () => {
      const comp = stmts.selectCompetition.get(competitionId);
      if (!comp) {
        throw new NotFoundError("competition", competitionId);
      }
      if (comp.phase !== "registration") {
        throw new CompetitionPhaseError(`Entries can only be reviewed during registration phase (current: '${comp.phase}')`);
      }

      const existing = stmts.selectSingleEntry.get(competitionId, userId);
      if (!existing) {
        throw new NotFoundError("competition_entry", `${competitionId}:${userId}`);
      }

      if (accepted) {
        if (existing.status !== "accepted") {
          const counts = stmts.countEntries.get(competitionId);
          const acceptedCount = counts ? (counts.accepted_count || 0) : 0;
          if (acceptedCount >= comp.capacity) {
            throw new CompetitionCapacityError("Competition accepted participant capacity reached");
          }
          stmts.updateEntryStatus.run("accepted", competitionId, userId);
        }
      } else {
        stmts.updateEntryStatus.run("declined", competitionId, userId);
      }

      const updated = stmts.selectSingleEntry.get(competitionId, userId);
      return mapEntry(updated);
    });
  }

  /**
   * Submits a bot version for an admitted participant during preparation phase.
   */
  function submitBotVersion(competitionId, userId, botVersionId) {
    if (!botVersionId || typeof botVersionId !== "string" || botVersionId.trim().length === 0) {
      throw new CompetitionValidationError("Field 'botVersionId' is required");
    }

    return withTransaction(db, () => {
      const comp = stmts.selectCompetition.get(competitionId);
      if (!comp) {
        throw new NotFoundError("competition", competitionId);
      }
      if (comp.phase !== "preparation") {
        throw new CompetitionPhaseError(`Bot submission is only allowed during preparation phase (current: '${comp.phase}')`);
      }

      const entry = stmts.selectSingleEntry.get(competitionId, userId);
      if (!entry) {
        throw new ForbiddenError("User is not registered for this competition");
      }
      if (entry.status !== "accepted") {
        throw new ForbiddenError("Only admitted (accepted) participants can submit bot versions");
      }

      const bv = stmts.selectBotVersionWithBot.get(botVersionId.trim());
      if (!bv) {
        throw new NotFoundError("bot_version", botVersionId);
      }

      if (bv.owner_id !== userId) {
        throw new ForbiddenError("You can only submit bots you own");
      }
      if (bv.bot_status !== "active") {
        throw new CompetitionValidationError("Bot is not active");
      }
      if (bv.build_status !== "ready") {
        throw new BotNotReadyError(`Bot version ${botVersionId} is not ready (status: ${bv.build_status})`);
      }
      if (!bv.artifact_digest) {
        throw new CompetitionValidationError("Bot version is missing artifact_digest");
      }

      stmts.updateEntryBotVersion.run(bv.bot_id, bv.id, competitionId, userId);
      const updated = stmts.selectSingleEntry.get(competitionId, userId);
      return mapEntry(updated);
    });
  }

  /**
   * Advances the competition lifecycle phase.
   * Atomic launch: locked -> running launches double-round-robin tournament within transaction.
   */
  function advancePhase(competitionId, expectedPhase, opts = {}) {
    if (!expectedPhase || typeof expectedPhase !== "string") {
      throw new CompetitionValidationError("Field 'expectedPhase' is required");
    }

    return withTransaction(db, () => {
      const comp = stmts.selectCompetition.get(competitionId);
      if (!comp) {
        throw new NotFoundError("competition", competitionId);
      }

      if (comp.phase !== expectedPhase) {
        throw new CompetitionPhaseError(
          `Expected phase '${expectedPhase}' does not match current phase '${comp.phase}'`
        );
      }

      switch (expectedPhase) {
        case "registration": {
          const counts = stmts.countEntries.get(competitionId);
          const pendingCount = counts ? (counts.pending_count || 0) : 0;
          if (pendingCount > 0) {
            throw new CompetitionPhaseError("Cannot advance: pending entries exist that must be reviewed");
          }
          const acceptedCount = counts ? (counts.accepted_count || 0) : 0;
          if (acceptedCount < 2) {
            throw new CompetitionPhaseError(
              `Cannot advance: requires at least 2 accepted participants, got ${acceptedCount}`
            );
          }

          stmts.updatePhase.run("preparation", null, competitionId);
          return getCompetition(competitionId);
        }

        case "preparation": {
          const rows = db.prepare(`
            SELECT ce.user_id, ce.bot_id, ce.bot_version_id, bv.build_status, bv.artifact_digest, u.normalized_username
            FROM competition_entries ce
            JOIN users u ON u.id = ce.user_id
            LEFT JOIN bot_versions bv ON bv.id = ce.bot_version_id
            WHERE ce.competition_id = ? AND ce.status = 'accepted'
            ORDER BY ce.user_id ASC
          `).all(competitionId);

          if (rows.length < 2) {
            throw new CompetitionPhaseError(
              `Cannot lock: requires at least 2 accepted participants, got ${rows.length}`
            );
          }

          for (const r of rows) {
            if (!r.bot_version_id) {
              throw new CompetitionPhaseError(
                `Cannot lock: participant '${r.normalized_username || r.user_id}' has not submitted a bot version`
              );
            }
            if (r.build_status !== "ready" || !r.artifact_digest) {
              throw new BotNotReadyError(
                `Cannot lock: bot version for '${r.normalized_username || r.user_id}' is not ready`
              );
            }
          }

          const botIds = rows.map((r) => r.bot_id);
          if (new Set(botIds).size !== botIds.length) {
            throw new CompetitionValidationError("Each admitted participant must use a distinct bot");
          }

          stmts.updatePhase.run("locked", null, competitionId);
          return getCompetition(competitionId);
        }

        case "locked": {
          if (comp.tournament_id) {
            throw new CompetitionPhaseError("Tournament has already been launched for this competition");
          }

          const rows = db.prepare(`
            SELECT bot_id, bot_version_id
            FROM competition_entries
            WHERE competition_id = ? AND status = 'accepted'
            ORDER BY bot_id ASC
          `).all(competitionId);

          if (rows.length < 2) {
            throw new CompetitionPhaseError("Cannot launch tournament: fewer than 2 accepted entries");
          }

          const engine = createNodeEngine();
          const defaultRuleset = createCurrentRulesetSnapshot(coreConfig);
          const defaultInitialState = engine.createInitialState();

          const tournamentId = opts.tournamentId || `tourn-${competitionId.replace(/^comp-/, "")}`;

          // Create tournament atomically — inner transaction rollback rolls back outer transaction
          const tournament = tournamentRepo.createTournament({
            id: tournamentId,
            name: `${comp.name} Tournament`,
            ranked: Boolean(comp.ranked),
            ladderId: opts.ladderId || "ladder-main",
            rulesetJson: opts.rulesetJson || defaultRuleset,
            policyJson: opts.policyJson || DEFAULT_MATCH_POLICY,
            initialStateJson: opts.initialStateJson || defaultInitialState,
            entries: rows.map((r) => ({
              botId: r.bot_id,
              botVersionId: r.bot_version_id
            })),
            schedule: opts.schedule
          });

          stmts.updatePhase.run("running", tournament.id, competitionId);
          return getCompetition(competitionId);
        }

        case "running": {
          if (!comp.tournament_id) {
            throw new CompetitionPhaseError("Competition has no linked tournament");
          }

          const counts = stmts.selectMatchCountsForTournament.get(comp.tournament_id);
          const totalMatches = counts ? (counts.total || 0) : 0;
          const completedMatches = counts ? (counts.completed || 0) : 0;
          const errorMatches = counts ? (counts.errored || 0) : 0;

          if (totalMatches === 0 || completedMatches < totalMatches) {
            if (errorMatches > 0) {
              throw new CompetitionPhaseError("Cannot complete competition: matches have errors and must be retried");
            }
            throw new CompetitionPhaseError("Cannot complete competition: tournament matches are still running");
          }

          stmts.updatePhase.run("completed", null, competitionId);
          return getCompetition(competitionId);
        }

        case "completed": {
          throw new CompetitionPhaseError("Competition is already completed");
        }

        default:
          throw new CompetitionValidationError(`Unknown phase: '${expectedPhase}'`);
      }
    });
  }

  /**
   * Retries an errored match in the running competition's linked tournament.
   */
  function retryCompetitionMatch(competitionId, scheduleIndex) {
    const comp = stmts.selectCompetition.get(competitionId);
    if (!comp) {
      throw new NotFoundError("competition", competitionId);
    }
    if (comp.phase !== "running") {
      throw new CompetitionPhaseError(`Competition must be in running phase to retry matches (current: '${comp.phase}')`);
    }
    if (!comp.tournament_id) {
      throw new CompetitionPhaseError("Competition has no linked tournament");
    }

    const sIndex = Number(scheduleIndex);
    if (!Number.isInteger(sIndex) || sIndex < 0) {
      throw new CompetitionValidationError("Invalid scheduleIndex: must be non-negative integer");
    }

    const matchRow = stmts.selectTournamentMatchBySchedule.get(comp.tournament_id, sIndex);
    if (!matchRow) {
      throw new NotFoundError("tournament_match", `${comp.tournament_id}#${sIndex}`);
    }

    if (matchRow.status !== "error") {
      throw new CompetitionPhaseError(
        `Only matches in 'error' status can be retried (current status: '${matchRow.status}')`
      );
    }

    tournamentRepo.retryMatch(comp.tournament_id, sIndex);
    return { ok: true };
  }

  return {
    createCompetition,
    getCompetition,
    listCompetitions,
    getCompetitionWithEntries,
    registerEntry,
    reviewEntry,
    submitBotVersion,
    advancePhase,
    retryCompetitionMatch
  };
}
