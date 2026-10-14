/**
 * packages/arena-node/src/persistence/competition-rounds-repository.mjs
 *
 * Persistence and Orchestration Repository for Arena Extended Competitions
 * (Rounds, Maps, and Modes).
 *
 * Requirements:
 * - Isolated from legacy competition repository; only manages extended events (is_extended = 1).
 * - Imports pure map and format domain contracts:
 *     packages/arena/src/domain/maps/index.mjs
 *     packages/arena/src/domain/formats/index.mjs
 * - Freezes versioned map descriptor and initial core state snapshot at competition creation.
 * - Derives round count at lock phase and validates Swiss round limits.
 * - Round 1 launched at locked -> running phase transition.
 * - Explicit next-round progression with CAS check on expectedRound and verification
 *   that previous round tournament has zero running or errored matches.
 * - Completion gate: running -> completed only allowed when current_round === round_count
 *   and final round tournament is fully completed with zero errors.
 * - Stable tournament IDs: comp-<id>-r<roundNumber>.
 * - Aggregates child standings and persisted byes without mutating finalizer tables.
 */

import { createHash, randomUUID } from "node:crypto";
import { withTransaction, applyMigration } from "./sqlite-database.mjs";
import {
  IdempotencyConflictError,
  NotFoundError,
  CompetitionValidationError,
  CompetitionPhaseError,
  CompetitionCapacityError,
  BotNotReadyError,
  ForbiddenError
} from "./competition-repository.mjs";
import { createTournamentRepository } from "./tournament-repository.mjs";
import { createNodeEngine, coreConfig } from "../core/node-engine.mjs";
import {
  DEFAULT_MATCH_POLICY,
  createCurrentRulesetSnapshot
} from "../../../arena/src/contracts/index.mjs";
import {
  computeExtendedStandings,
  getCompetitionRoundHistory
} from "./competition-standings-calculator.mjs";

// Exact plan imports from domain packages (resolved dynamically to handle initial absence before supervisor supplies commits)
let listMaps, getMap, createMapState;
let listFormats, getRoundCount, pairRound;

try {
  const mapsMod = await import("../../../arena/src/domain/maps/index.mjs");
  listMaps = mapsMod.listMaps;
  getMap = mapsMod.getMap;
  createMapState = mapsMod.createMapState;
} catch (err) {
  if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
}

try {
  const formatsMod = await import("../../../arena/src/domain/formats/index.mjs");
  listFormats = formatsMod.listFormats;
  getRoundCount = formatsMod.getRoundCount;
  pairRound = formatsMod.pairRound;
} catch (err) {
  if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
}

export {
  IdempotencyConflictError,
  NotFoundError,
  CompetitionValidationError,
  CompetitionPhaseError,
  CompetitionCapacityError,
  BotNotReadyError,
  ForbiddenError
};

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

function mapExtendedCompetition(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    phase: row.phase,
    capacity: row.capacity,
    ranked: Boolean(row.ranked),
    tournamentId: row.tournament_id || null,
    createdAt: row.created_at,
    formatId: row.format_id,
    mapId: row.map_id,
    mapRevision: row.map_revision,
    mode: row.mode,
    roundCount: row.round_count,
    currentRound: row.current_round,
    isExtended: Boolean(row.is_extended)
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
 * Creates an extended CompetitionRoundsRepository instance bound to a SQLite database.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [options]
 * @param {object} [options.tournamentRepo]
 * @param {object} [options.mapsDomain]
 * @param {object} [options.formatsDomain]
 */
export function createCompetitionRoundsRepository(db, options = {}) {
  if (!db) {
    throw new TypeError("createCompetitionRoundsRepository requires a database instance");
  }

  // Ensure migrations 002 and 003 are applied
  applyMigration(db, "002-competitions");
  applyMigration(db, "003-competition-rounds");

  const tournamentRepo = options.tournamentRepo || createTournamentRepository(db);

  // Allow test injection while defaulting to imported domain modules
  const maps = options.mapsDomain || { listMaps, getMap, createMapState };
  const formats = options.formatsDomain || { listFormats, getRoundCount, pairRound };

  const stmts = {
    selectCompetition: db.prepare(`
      SELECT id, name, description, phase, capacity, ranked, tournament_id,
             format_id, map_id, map_revision, map_snapshot_json, mode,
             round_count, current_round, is_extended, created_at, updated_at
      FROM competitions WHERE id = ?
    `),
    insertCompetition: db.prepare(`
      INSERT INTO competitions (
        id, name, description, phase, capacity, ranked,
        format_id, map_id, map_revision, map_snapshot_json, mode,
        round_count, current_round, is_extended, created_at, updated_at
      ) VALUES (?, ?, ?, 'registration', ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, datetime('now'), datetime('now'))
    `),
    updatePhase: db.prepare(`
      UPDATE competitions
      SET phase = ?,
          tournament_id = COALESCE(?, tournament_id),
          current_round = COALESCE(?, current_round),
          updated_at = datetime('now')
      WHERE id = ?
    `),
    updateRoundCount: db.prepare(`
      UPDATE competitions
      SET round_count = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `),
    selectEntriesForCompetition: db.prepare(`
      SELECT ce.user_id, ce.status, ce.bot_id, ce.bot_version_id, ce.created_at,
             u.normalized_username AS username,
             b.name AS bot_name,
             bv.version_no, bv.build_status
      FROM competition_entries ce
      JOIN users u ON u.id = ce.user_id
      LEFT JOIN bots b ON b.id = ce.bot_id
      LEFT JOIN bot_versions bv ON bv.id = ce.bot_version_id
      WHERE ce.competition_id = ?
      ORDER BY ce.created_at ASC, ce.user_id ASC
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
    selectSingleEntry: db.prepare(`
      SELECT ce.user_id, ce.status, ce.bot_id, ce.bot_version_id, ce.created_at,
             u.normalized_username AS username,
             b.name AS bot_name,
             bv.version_no, bv.build_status
      FROM competition_entries ce
      JOIN users u ON u.id = ce.user_id
      LEFT JOIN bots b ON b.id = ce.bot_id
      LEFT JOIN bot_versions bv ON bv.id = ce.bot_version_id
      WHERE ce.competition_id = ? AND ce.user_id = ?
    `),
    selectApiRequest: db.prepare(`
      SELECT target_id, payload_digest
      FROM api_requests
      WHERE actor_id = ? AND operation = ? AND idempotency_key = ?
    `),
    insertApiRequest: db.prepare(`
      INSERT INTO api_requests (actor_id, idempotency_key, operation, payload_digest, target_id)
      VALUES (?, ?, ?, ?, ?)
    `),
    selectTournamentMatchCounts: db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errored,
        SUM(CASE WHEN status IN ('pending', 'running', 'active') THEN 1 ELSE 0 END) AS running
      FROM matches
      WHERE tournament_id = ?
    `),
    selectTournamentMatchBySchedule: db.prepare(`
      SELECT id, status, tournament_id, schedule_index
      FROM matches
      WHERE tournament_id = ? AND schedule_index = ?
    `),
    // Round queries
    insertRound: db.prepare(`
      INSERT INTO competition_rounds (
        competition_id, round_number, tournament_id, status,
        pairings_json, byes_json, warnings_json, created_at
      ) VALUES (?, ?, ?, 'running', ?, ?, ?, datetime('now'))
    `),
    updateRoundStatus: db.prepare(`
      UPDATE competition_rounds
      SET status = ?,
          completed_at = CASE WHEN ? = 'completed' THEN datetime('now') ELSE completed_at END
      WHERE competition_id = ? AND round_number = ?
    `),
    selectRoundsForCompetition: db.prepare(`
      SELECT competition_id, round_number, tournament_id, status,
             pairings_json, byes_json, warnings_json, created_at, completed_at
      FROM competition_rounds
      WHERE competition_id = ?
      ORDER BY round_number ASC
    `),
    selectRoundByNumber: db.prepare(`
      SELECT competition_id, round_number, tournament_id, status,
             pairings_json, byes_json, warnings_json, created_at, completed_at
      FROM competition_rounds
      WHERE competition_id = ? AND round_number = ?
    `),
    insertRoundBye: db.prepare(`
      INSERT INTO competition_round_byes (competition_id, round_number, bot_id, points, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `)
  };

  /**
   * Checks whether a competition ID is an extended competition (is_extended = 1).
   */
  function isExtendedCompetition(competitionId) {
    const row = stmts.selectCompetition.get(competitionId);
    return Boolean(row && row.is_extended === 1);
  }

  /**
   * Returns catalog describing available maps, formats, modes, and default selections.
   */
  function getCompetitionCatalog() {
    const rawMaps = typeof maps.listMaps === "function" ? maps.listMaps() : [];
    const catalogMaps = rawMaps.map((m) => {
      let initialState = null;
      if (typeof maps.createMapState === "function") {
        try {
          initialState = maps.createMapState(m.id, m.revision);
        } catch {
          initialState = null;
        }
      }
      return {
        id: m.id,
        revision: m.revision,
        name: m.name,
        description: m.description,
        initialState
      };
    });

    const rawFormats = typeof formats.listFormats === "function" ? formats.listFormats() : [];
    const catalogFormats = rawFormats.map((f) => ({
      id: f.id,
      name: f.name,
      description: f.description
    }));

    const catalogModes = [
      { id: "ranked", name: "Ranked" },
      { id: "practice", name: "Practice" }
    ];

    const defaults = {
      mapId: "classic",
      formatId: "double-round-robin",
      mode: "ranked"
    };

    return {
      maps: catalogMaps,
      formats: catalogFormats,
      modes: catalogModes,
      defaults
    };
  }

  /**
   * Creates a new extended competition event with pinned map snapshot and format configuration.
   */
  function createExtendedCompetition(input = {}, opts = {}) {
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
      if (typeof input.capacity !== "number" || !Number.isInteger(input.capacity) || input.capacity < 2 || input.capacity > 128) {
        throw new CompetitionValidationError("Competition capacity must be an integer between 2 and 128");
      }
      capacity = input.capacity;
    }

    // ── Mode and Ranked Validation ───────────────────────────────────────────
    let mode = "ranked";
    let ranked = true;

    if (input.mode !== undefined && input.mode !== null) {
      if (input.mode !== "ranked" && input.mode !== "practice") {
        throw new CompetitionValidationError(`Invalid mode '${input.mode}': must be 'ranked' or 'practice'`);
      }
      mode = input.mode;
    }

    if (input.ranked !== undefined && input.ranked !== null) {
      if (typeof input.ranked !== "boolean") {
        throw new CompetitionValidationError("Field 'ranked' must be a boolean");
      }
      ranked = Boolean(input.ranked);
    }

    // Check consistency between mode and ranked:
    if (input.mode !== undefined && input.ranked !== undefined) {
      if (mode === "ranked" && !ranked) {
        throw new CompetitionValidationError("Mode 'ranked' conflicts with ranked=false", "VALIDATION_ERROR");
      }
      if (mode === "practice" && ranked) {
        throw new CompetitionValidationError("Mode 'practice' conflicts with ranked=true", "VALIDATION_ERROR");
      }
    } else if (input.mode !== undefined && input.ranked === undefined) {
      ranked = mode === "ranked";
    } else if (input.ranked !== undefined && input.mode === undefined) {
      mode = ranked ? "ranked" : "practice";
    }

    const rankedInt = ranked ? 1 : 0;

    // ── Format Validation ───────────────────────────────────────────────────
    const formatId = input.formatId ? String(input.formatId).trim() : "double-round-robin";
    const availableFormats = typeof formats.listFormats === "function" ? formats.listFormats() : [];
    const matchedFormat = availableFormats.find((f) => f.id === formatId);
    if (!matchedFormat && availableFormats.length > 0) {
      throw new CompetitionValidationError(`Unknown format: '${formatId}'`);
    }

    // ── Map Validation & Snapshot ────────────────────────────────────────────
    const mapId = input.mapId ? String(input.mapId).trim() : "classic";
    let mapDescriptor = null;
    if (typeof maps.getMap === "function") {
      mapDescriptor = maps.getMap(mapId);
    } else if (typeof maps.listMaps === "function") {
      mapDescriptor = maps.listMaps().find((m) => m.id === mapId);
    }

    if (!mapDescriptor) {
      throw new CompetitionValidationError(`Unknown map: '${mapId}'`);
    }

    const mapRevision = mapDescriptor.revision || 1;
    let initialCoreState = null;
    if (typeof maps.createMapState === "function") {
      initialCoreState = maps.createMapState(mapId, mapRevision);
    }
    if (!initialCoreState) {
      const engine = createNodeEngine();
      initialCoreState = engine.createInitialState();
    }

    const mapSnapshotJson = JSON.stringify({
      descriptor: mapDescriptor,
      initialState: initialCoreState
    });

    // ── Round Count Validation ──────────────────────────────────────────────
    let roundCount = 1;
    if (input.roundCount !== undefined && input.roundCount !== null) {
      if (typeof input.roundCount !== "number" || !Number.isInteger(input.roundCount) || input.roundCount < 1 || input.roundCount > 32) {
        throw new CompetitionValidationError("Field 'roundCount' must be an integer between 1 and 32");
      }
      roundCount = input.roundCount;
    }

    const payloadDigest = canonicalDigest({
      name,
      description,
      capacity,
      ranked: rankedInt,
      formatId,
      mapId,
      mapRevision,
      mode,
      roundCount,
      operation: "createExtendedCompetition"
    });

    const competitionId = input.id || `comp-${randomUUID()}`;

    return withTransaction(db, () => {
      if (actorId && idempotencyKey) {
        const existingReq = stmts.selectApiRequest.get(actorId, "createExtendedCompetition", idempotencyKey);
        if (existingReq) {
          if (existingReq.payload_digest !== payloadDigest) {
            throw new IdempotencyConflictError(idempotencyKey, "createExtendedCompetition");
          }
          return getExtendedCompetition(existingReq.target_id);
        }
      }

      stmts.insertCompetition.run(
        competitionId,
        name,
        description,
        capacity,
        rankedInt,
        formatId,
        mapId,
        mapRevision,
        mapSnapshotJson,
        mode,
        roundCount
      );

      if (actorId && idempotencyKey) {
        stmts.insertApiRequest.run(actorId, idempotencyKey, payloadDigest, competitionId);
      }

      return getExtendedCompetition(competitionId);
    });
  }

  /**
   * Retrieves an extended competition row by ID.
   */
  function getExtendedCompetition(competitionId) {
    const row = stmts.selectCompetition.get(competitionId);
    return mapExtendedCompetition(row);
  }

  /**
   * Retrieves full details of an extended competition, including participants,
   * persisted round history, and aggregate standings.
   */
  function getExtendedCompetitionDetails(competitionId) {
    const comp = getExtendedCompetition(competitionId);
    if (!comp) return null;

    const entryRows = stmts.selectEntriesForCompetition.all(competitionId);
    const entries = entryRows.map(mapEntry);

    const roundRows = stmts.selectRoundsForCompetition.all(competitionId);
    const rounds = roundRows.map((r) => {
      let pairings = [];
      let byes = [];
      let warnings = [];
      try { pairings = JSON.parse(r.pairings_json); } catch {}
      try { byes = JSON.parse(r.byes_json); } catch {}
      try { warnings = JSON.parse(r.warnings_json); } catch {}

      return {
        roundNumber: r.round_number,
        tournamentId: r.tournament_id,
        status: r.status,
        pairings: Array.isArray(pairings) ? pairings : [],
        byes: Array.isArray(byes) ? byes : [],
        warnings: Array.isArray(warnings) ? warnings : [],
        createdAt: r.created_at,
        completedAt: r.completed_at || null
      };
    });

    const acceptedEntries = entries.filter((e) => e.status === "accepted");
    const standings = computeExtendedStandings(db, competitionId, acceptedEntries);

    const configuration = {
      formatId: comp.formatId,
      mapId: comp.mapId,
      mapRevision: comp.mapRevision,
      mode: comp.mode,
      roundCount: comp.roundCount,
      currentRound: comp.currentRound
    };

    return {
      competition: comp,
      entries,
      configuration,
      rounds,
      standings
    };
  }

  /**
   * Advances the extended competition lifecycle phase.
   *
   * State transitions:
   *   registration -> preparation -> locked -> running -> completed
   *
   * Special behaviors for extended events:
   * - preparation -> locked derives round_count from admitted participant count using format rules.
   * - locked -> running generates round 1 pairings and launches round 1 tournament.
   * - running -> completed only allowed when current_round === round_count AND final round tournament is complete.
   */
  function advanceExtendedPhase(competitionId, expectedPhase, opts = {}) {
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

          stmts.updatePhase.run("preparation", null, null, competitionId);
          return getExtendedCompetition(competitionId);
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

          // Derive and validate round count using format rules
          let derivedRounds = comp.round_count;
          if (typeof formats.getRoundCount === "function") {
            try {
              derivedRounds = formats.getRoundCount(comp.format_id, rows.length, comp.round_count);
            } catch (err) {
              throw new CompetitionValidationError(err.message);
            }
          }

          if (!derivedRounds || derivedRounds < 1 || derivedRounds > 32) {
            throw new CompetitionValidationError(`Invalid derived roundCount: ${derivedRounds}`);
          }

          stmts.updateRoundCount.run(derivedRounds, competitionId);
          stmts.updatePhase.run("locked", null, null, competitionId);
          return getExtendedCompetition(competitionId);
        }

        case "locked": {
          if (comp.tournament_id || comp.current_round > 0) {
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

          // Initial standings and history for round 1
          const initialStandings = rows.map((r) => ({
            botId: r.bot_id,
            points: 0,
            wins: 0,
            draws: 0,
            losses: 0,
            played: 0,
            byeCount: 0,
            seatBalance: 0
          }));

          const normalizedEntries = rows.map((r) => ({
            botId: r.bot_id,
            botVersionId: r.bot_version_id
          }));

          const round1Pairing = formats.pairRound({
            formatId: comp.format_id,
            entries: normalizedEntries,
            roundNumber: 1,
            roundCount: comp.round_count,
            standings: initialStandings,
            history: []
          });

          const pairings = Array.isArray(round1Pairing?.pairings) ? round1Pairing.pairings : [];
          const byes = Array.isArray(round1Pairing?.byes) ? round1Pairing.byes : [];
          const warnings = Array.isArray(round1Pairing?.warnings) ? round1Pairing.warnings : [];

          // Contiguous scheduleIndex per batch
          const schedule = pairings.map((p, idx) => ({
            scheduleIndex: idx,
            botAId: p.botAId,
            botBId: p.botBId
          }));

          // Parse pinned core initial state from map snapshot
          let initialStateJson = null;
          if (comp.map_snapshot_json) {
            try {
              const snapshot = JSON.parse(comp.map_snapshot_json);
              initialStateJson = snapshot.initialState || snapshot;
            } catch {
              initialStateJson = null;
            }
          }
          if (!initialStateJson) {
            const engine = createNodeEngine();
            initialStateJson = engine.createInitialState();
          }

          const tournamentId = opts.tournamentId || `${comp.id}-r1`;

          const tournament = tournamentRepo.createTournament({
            id: tournamentId,
            name: `${comp.name} Round 1`,
            ranked: comp.mode === "ranked",
            ladderId: opts.ladderId || "ladder-main",
            rulesetJson: opts.rulesetJson || createCurrentRulesetSnapshot(coreConfig),
            policyJson: opts.policyJson || DEFAULT_MATCH_POLICY,
            initialStateJson,
            entries: rows.map((r) => ({
              botId: r.bot_id,
              botVersionId: r.bot_version_id
            })),
            schedule
          });

          // Insert round 1
          stmts.insertRound.run(
            competitionId,
            1,
            tournament.id,
            JSON.stringify(schedule),
            JSON.stringify(byes),
            JSON.stringify(warnings)
          );

          // Insert byes: Swiss = 3 pts, Round-Robin = 0 pts
          const byePoints = comp.format_id === "swiss" ? 3 : 0;
          for (const byeBotId of byes) {
            stmts.insertRoundBye.run(competitionId, 1, byeBotId, byePoints);
          }

          stmts.updatePhase.run("running", tournament.id, 1, competitionId);
          return getExtendedCompetition(competitionId);
        }

        case "running": {
          if (comp.current_round < comp.round_count) {
            throw new CompetitionPhaseError(
              `Cannot complete competition: current round (${comp.current_round}) has not reached configured total rounds (${comp.round_count})`
            );
          }

          // Verify final round tournament completion
          const counts = stmts.selectTournamentMatchCounts.get(comp.tournament_id);
          const totalMatches = counts ? (counts.total || 0) : 0;
          const completedMatches = counts ? (counts.completed || 0) : 0;
          const errorMatches = counts ? (counts.errored || 0) : 0;

          if (errorMatches > 0) {
            throw new CompetitionPhaseError(
              "Cannot complete competition: matches have errors and must be retried"
            );
          }
          if (totalMatches === 0 || completedMatches < totalMatches) {
            throw new CompetitionPhaseError(
              "Cannot complete competition: tournament matches are still running"
            );
          }

          // Mark final round completed
          stmts.updateRoundStatus.run("completed", "completed", competitionId, comp.current_round);
          stmts.updatePhase.run("completed", null, null, competitionId);
          return getExtendedCompetition(competitionId);
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
   * Advances an extended competition to the next round.
   *
   * Pre-conditions:
   * - Admin only (enforced in HTTP router).
   * - CAS check: expectedRound matches current_round.
   * - Phase is 'running'.
   * - current_round < round_count.
   * - Previous round tournament matches are 100% complete with 0 errored.
   */
  function nextRound(competitionId, expectedRound, opts = {}) {
    const expRound = Number(expectedRound);
    if (!Number.isInteger(expRound) || expRound < 1 || expRound > 32) {
      throw new CompetitionValidationError("Field 'expectedRound' must be an integer between 1 and 32");
    }

    return withTransaction(db, () => {
      const comp = stmts.selectCompetition.get(competitionId);
      if (!comp) {
        throw new NotFoundError("competition", competitionId);
      }

      if (comp.phase !== "running") {
        throw new CompetitionPhaseError(
          `Competition must be in running phase to start next round (current: '${comp.phase}')`
        );
      }

      if (comp.current_round !== expRound) {
        throw new CompetitionPhaseError(
          `Expected round ${expRound} does not match current round ${comp.current_round}`
        );
      }

      if (comp.current_round >= comp.round_count) {
        throw new CompetitionPhaseError(
          `All configured rounds have already been created (round ${comp.current_round} of ${comp.round_count})`
        );
      }

      // Verify previous round tournament has finished without errors
      const counts = stmts.selectTournamentMatchCounts.get(comp.tournament_id);
      const totalMatches = counts ? (counts.total || 0) : 0;
      const completedMatches = counts ? (counts.completed || 0) : 0;
      const errorMatches = counts ? (counts.errored || 0) : 0;

      if (errorMatches > 0) {
        throw new CompetitionPhaseError(
          "Cannot start next round: previous round has errored matches that must be retried"
        );
      }
      if (totalMatches === 0 || completedMatches < totalMatches) {
        throw new CompetitionPhaseError(
          "Cannot start next round: previous round matches are still running"
        );
      }

      // Mark previous round completed
      stmts.updateRoundStatus.run("completed", "completed", competitionId, comp.current_round);

      const nextRoundNumber = comp.current_round + 1;

      // Query participants
      const entryRows = db.prepare(`
        SELECT bot_id, bot_version_id
        FROM competition_entries
        WHERE competition_id = ? AND status = 'accepted'
        ORDER BY bot_id ASC
      `).all(competitionId);

      const normalizedEntries = entryRows.map((r) => ({
        botId: r.bot_id,
        botVersionId: r.bot_version_id
      }));

      // Compute aggregate standings up to current round
      const currentStandings = computeExtendedStandings(db, competitionId, normalizedEntries);
      // Query match pairing history across past rounds
      const history = getCompetitionRoundHistory(db, competitionId);

      const pairingResult = formats.pairRound({
        formatId: comp.format_id,
        entries: normalizedEntries,
        roundNumber: nextRoundNumber,
        roundCount: comp.round_count,
        standings: currentStandings,
        history
      });

      const pairings = Array.isArray(pairingResult?.pairings) ? pairingResult.pairings : [];
      const byes = Array.isArray(pairingResult?.byes) ? pairingResult.byes : [];
      const warnings = Array.isArray(pairingResult?.warnings) ? pairingResult.warnings : [];

      const schedule = pairings.map((p, idx) => ({
        scheduleIndex: idx,
        botAId: p.botAId,
        botBId: p.botBId
      }));

      // Parse pinned core initial state from map snapshot
      let initialStateJson = null;
      if (comp.map_snapshot_json) {
        try {
          const snapshot = JSON.parse(comp.map_snapshot_json);
          initialStateJson = snapshot.initialState || snapshot;
        } catch {
          initialStateJson = null;
        }
      }
      if (!initialStateJson) {
        const engine = createNodeEngine();
        initialStateJson = engine.createInitialState();
      }

      const tournamentId = opts.tournamentId || `${comp.id}-r${nextRoundNumber}`;

      const tournament = tournamentRepo.createTournament({
        id: tournamentId,
        name: `${comp.name} Round ${nextRoundNumber}`,
        ranked: comp.mode === "ranked",
        ladderId: opts.ladderId || "ladder-main",
        rulesetJson: opts.rulesetJson || createCurrentRulesetSnapshot(coreConfig),
        policyJson: opts.policyJson || DEFAULT_MATCH_POLICY,
        initialStateJson,
        entries: entryRows.map((r) => ({
          botId: r.bot_id,
          botVersionId: r.bot_version_id
        })),
        schedule
      });

      // Insert new round
      stmts.insertRound.run(
        competitionId,
        nextRoundNumber,
        tournament.id,
        JSON.stringify(schedule),
        JSON.stringify(byes),
        JSON.stringify(warnings)
      );

      // Insert byes: Swiss = 3 pts, Round-Robin = 0 pts
      const byePoints = comp.format_id === "swiss" ? 3 : 0;
      for (const byeBotId of byes) {
        stmts.insertRoundBye.run(competitionId, nextRoundNumber, byeBotId, byePoints);
      }

      // Update competition current round & tournament pointer
      stmts.updatePhase.run("running", tournament.id, nextRoundNumber, competitionId);

      return getExtendedCompetition(competitionId);
    });
  }

  /**
   * Retries an errored match in the current running round's tournament.
   */
  function retryCompetitionMatch(competitionId, scheduleIndex) {
    const sIndex = Number(scheduleIndex);
    if (!Number.isInteger(sIndex) || sIndex < 0 || sIndex > 65535) {
      throw new CompetitionValidationError(
        "Invalid scheduleIndex: must be a non-negative integer within bounds (0..65535)"
      );
    }

    return withTransaction(db, () => {
      const comp = stmts.selectCompetition.get(competitionId);
      if (!comp) {
        throw new NotFoundError("competition", competitionId);
      }
      if (comp.phase !== "running") {
        throw new CompetitionPhaseError(
          `Competition must be in running phase to retry matches (current: '${comp.phase}')`
        );
      }
      if (!comp.tournament_id) {
        throw new CompetitionPhaseError("Competition has no linked tournament");
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
    });
  }

  return {
    isExtendedCompetition,
    getCompetitionCatalog,
    createExtendedCompetition,
    getExtendedCompetition,
    getExtendedCompetitionDetails,
    advanceExtendedPhase,
    nextRound,
    retryCompetitionMatch
  };
}
