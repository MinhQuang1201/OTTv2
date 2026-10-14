/**
 * tests/arena-competition-rounds.test.js
 *
 * Backend integration test suite for Arena Rounds, Maps, and Modes
 * (ROOT ARENA_ROUNDS_MAPS_MODES_PLAN.local.md).
 *
 * Suites:
 * 1. Schema Migration 003 (Fresh startup, upgrade from 002, and table/column verification)
 * 2. Competition Standings Calculator & Bye Aggregation Helper
 * 3. Competition Rounds Repository (Catalog, Creation, Map Snapshot Pinning, Lifecycle & Next Round)
 * 4. HTTP API Route Matrix (/competition-catalog, extended /competitions, /advance, /next-round, /retry)
 * 5. End-to-End Progression & Final Completion Gate
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const { createHash } = require("node:crypto");

const PORTABLE_NODE18_BINDING =
  "C:/Users/ADMIN/AppData/Local/Temp/opencode/arena-sqlite-smoke-node18/node_modules/better-sqlite3/build/Release/better_sqlite3.node";

if (
  process.versions.node.startsWith("18.") &&
  !process.env.ARENA_SQLITE_NATIVE_BINDING &&
  fs.existsSync(PORTABLE_NODE18_BINDING)
) {
  process.env.ARENA_SQLITE_NATIVE_BINDING = PORTABLE_NODE18_BINDING;
}

const TEMP_BASE_DIR = path.resolve(os.tmpdir(), "arena-rounds-test-" + Date.now());

let openDatabase;
let closeDatabase;
let applyMigration;
let withTransaction;
let createBotRepository;
let createTournamentRepository;
let createCompetitionRepository;
let createCompetitionRoundsRepository;
let computeExtendedStandings;
let getCompetitionRoundHistory;
let CompetitionValidationError;
let CompetitionPhaseError;
let CompetitionCapacityError;
let BotNotReadyError;
let ForbiddenError;
let NotFoundError;
let IdempotencyConflictError;

let createArenaServer;
let hashPassword;
let createSession;

function sha256Digest(str) {
  return `sha256:${createHash("sha256").update(str, "utf8").digest("hex")}`;
}

function makeRequest(server, options, body = null) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const reqOptions = {
      hostname: "127.0.0.1",
      port: addr.port,
      path: options.path,
      method: options.method || "GET",
      headers: {
        ...(options.headers || {})
      }
    };

    if (body && !reqOptions.headers["Content-Type"] && !reqOptions.headers["content-type"]) {
      reqOptions.headers["Content-Type"] = "application/json";
    }

    const req = http.request(reqOptions, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          parsed = rawBody;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: parsed
        });
      });
    });

    req.on("error", reject);

    if (body) {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      req.write(payload);
    }
    req.end();
  });
}

// Mock domain modules adhering to the contracts in the plan
const mockMapsDomain = {
  listMaps() {
    return [
      { id: "classic", revision: 1, name: "Classic", description: "Standard starting layout" },
      { id: "flanks", revision: 1, name: "Flanks", description: "Flank starting variation" },
      { id: "center", revision: 1, name: "Center", description: "Center starting variation" }
    ];
  },
  getMap(id) {
    return this.listMaps().find((m) => m.id === id) || null;
  },
  createMapState(id, revision = 1) {
    return {
      mapId: id,
      revision,
      boardSize: 9,
      pieces: [
        { id: "A1", seat: "A", type: "R", x: 4, y: 1 },
        { id: "B1", seat: "B", type: "R", x: 4, y: 7 }
      ]
    };
  }
};

const mockFormatsDomain = {
  listFormats() {
    return [
      { id: "single-round-robin", name: "Single Round-Robin", description: "Play every opponent once" },
      { id: "double-round-robin", name: "Double Round-Robin", description: "Play every opponent twice" },
      { id: "swiss", name: "Swiss System", description: "Swiss pairing system" }
    ];
  },
  getRoundCount(formatId, participantCount, requestedRounds = null) {
    if (formatId === "single-round-robin") {
      return participantCount % 2 === 0 ? participantCount - 1 : participantCount;
    }
    if (formatId === "double-round-robin") {
      return (participantCount % 2 === 0 ? participantCount - 1 : participantCount) * 2;
    }
    if (formatId === "swiss") {
      if (requestedRounds !== null && requestedRounds !== undefined) {
        return Math.min(32, Math.max(1, requestedRounds));
      }
      return Math.min(32, Math.max(1, participantCount - 1));
    }
    return 1;
  },
  pairRound({ formatId, entries, roundNumber, roundCount, standings, history }) {
    // Deterministic pairing fixture for 2-4 entries
    if (entries.length === 2) {
      return {
        pairings: [{ scheduleIndex: 0, botAId: entries[0].botId, botBId: entries[1].botId }],
        byes: [],
        warnings: []
      };
    }
    if (entries.length === 3) {
      // 3 entries: 1 pair, 1 bye
      // Round 1: bot0 vs bot1, bye bot2
      // Round 2: bot0 vs bot2, bye bot1
      if (roundNumber === 1) {
        return {
          pairings: [{ scheduleIndex: 0, botAId: entries[0].botId, botBId: entries[1].botId }],
          byes: [entries[2].botId],
          warnings: []
        };
      }
      return {
        pairings: [{ scheduleIndex: 0, botAId: entries[0].botId, botBId: entries[2].botId }],
        byes: [entries[1].botId],
        warnings: []
      };
    }
    // 4 entries: 2 pairs
    return {
      pairings: [
        { scheduleIndex: 0, botAId: entries[0].botId, botBId: entries[1].botId },
        { scheduleIndex: 1, botAId: entries[2].botId, botBId: entries[3].botId }
      ],
      byes: [],
      warnings: []
    };
  }
};

describe("Arena Extended Competitions (Rounds, Maps, Modes)", () => {
  let testDbCounter = 0;

  function createTestDb(targetVersion = "003-competition-rounds") {
    testDbCounter++;
    const dbPath = path.resolve(TEMP_BASE_DIR, `test-${testDbCounter}.sqlite`);
    const { db, version } = openDatabase(dbPath, { targetVersion });
    return { db, dbPath, version };
  }

  function seedUser(db, { id, username, role = "author" }) {
    const passwordHash = hashPassword("password123");
    db.prepare(`
      INSERT INTO users (id, normalized_username, password_hash, role, status)
      VALUES (?, ?, ?, ?, 'active')
    `).run(id, username.toLowerCase(), passwordHash, role);
    return { id, username, role };
  }

  function seedBot(db, { id, ownerId, name = "Test Bot" }) {
    db.prepare(`
      INSERT INTO bots (id, owner_id, name, status)
      VALUES (?, ?, ?, 'active')
    `).run(id, ownerId, name);
    return { id, ownerId, name };
  }

  function seedReadyVersion(db, { id, botId, versionNo = 1 }) {
    const artifactDigest = sha256Digest(`artifact-${id}`);
    const sourceDigest = sha256Digest(`source-${id}`);
    db.prepare(`
      INSERT OR IGNORE INTO artifacts (digest, kind, relative_private_path, bytes)
      VALUES (?, 'build', 'builds/${id}.zip', 1024)
    `).run(artifactDigest);
    db.prepare(`
      INSERT OR IGNORE INTO artifacts (digest, kind, relative_private_path, bytes)
      VALUES (?, 'source', 'sources/${id}.zip', 512)
    `).run(sourceDigest);

    db.prepare(`
      INSERT INTO bot_versions (id, bot_id, version_no, source_digest, profile_id, profile_revision, artifact_digest, build_status)
      VALUES (?, ?, ?, ?, 'controlled-node', 'v1', ?, 'ready')
    `).run(id, botId, versionNo, sourceDigest, artifactDigest);
    return { id, botId, versionNo, artifactDigest };
  }

  before(async () => {
    fs.mkdirSync(TEMP_BASE_DIR, { recursive: true });

    const dbMod = await import("../packages/arena-node/src/persistence/sqlite-database.mjs");
    openDatabase = dbMod.openDatabase;
    closeDatabase = dbMod.closeDatabase;
    applyMigration = dbMod.applyMigration;
    withTransaction = dbMod.withTransaction;

    const botRepoMod = await import("../packages/arena-node/src/persistence/bot-repository.mjs");
    createBotRepository = botRepoMod.createBotRepository;

    const tournRepoMod = await import("../packages/arena-node/src/persistence/tournament-repository.mjs");
    createTournamentRepository = tournRepoMod.createTournamentRepository;

    const compRepoMod = await import("../packages/arena-node/src/persistence/competition-repository.mjs");
    createCompetitionRepository = compRepoMod.createCompetitionRepository;
    CompetitionValidationError = compRepoMod.CompetitionValidationError;
    CompetitionPhaseError = compRepoMod.CompetitionPhaseError;
    CompetitionCapacityError = compRepoMod.CompetitionCapacityError;
    BotNotReadyError = compRepoMod.BotNotReadyError;
    ForbiddenError = compRepoMod.ForbiddenError;
    NotFoundError = compRepoMod.NotFoundError;
    IdempotencyConflictError = compRepoMod.IdempotencyConflictError;

    const calcMod = await import("../packages/arena-node/src/persistence/competition-standings-calculator.mjs");
    computeExtendedStandings = calcMod.computeExtendedStandings;
    getCompetitionRoundHistory = calcMod.getCompetitionRoundHistory;

    const roundsRepoMod = await import("../packages/arena-node/src/persistence/competition-rounds-repository.mjs");
    createCompetitionRoundsRepository = roundsRepoMod.createCompetitionRoundsRepository;

    const serverMod = await import("../apps/arena-api/src/http-server.mjs");
    createArenaServer = serverMod.createArenaServer;

    const authMod = await import("../apps/arena-api/src/auth/accounts.mjs");
    hashPassword = authMod.hashPassword;
    createSession = authMod.createSession;
  });

  after(() => {
    try {
      fs.rmSync(TEMP_BASE_DIR, { recursive: true, force: true });
    } catch {}
  });

  // ── 1. Schema Migration 003 ────────────────────────────────────────────────
  describe("1. Schema Migration 003: Rounds, Maps and Modes", () => {
    it("starts fresh database with targetVersion='003-competition-rounds' applying 001, 002, 003 cleanly", () => {
      const { db, version } = createTestDb("003-competition-rounds");
      try {
        assert.equal(version, "003-competition-rounds");

        const applied = db.prepare("SELECT version FROM schema_migrations ORDER BY applied_at ASC").all();
        assert.deepEqual(
          applied.map((r) => r.version),
          ["001-arena", "002-competitions", "003-competition-rounds"]
        );

        // Check columns on competitions
        const compCols = db.prepare("PRAGMA table_info(competitions)").all().map((c) => c.name);
        assert.ok(compCols.includes("format_id"));
        assert.ok(compCols.includes("map_id"));
        assert.ok(compCols.includes("map_revision"));
        assert.ok(compCols.includes("map_snapshot_json"));
        assert.ok(compCols.includes("mode"));
        assert.ok(compCols.includes("round_count"));
        assert.ok(compCols.includes("current_round"));
        assert.ok(compCols.includes("is_extended"));

        // Check new tables
        const roundsTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'competition_rounds'").get();
        assert.ok(roundsTable);

        const byesTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'competition_round_byes'").get();
        assert.ok(byesTable);
      } finally {
        closeDatabase(db);
      }
    });

    it("upgrades existing 002-competitions database to 003 preserving data without corruption", () => {
      testDbCounter++;
      const dbPath = path.resolve(TEMP_BASE_DIR, `upgrade-${testDbCounter}.sqlite`);
      const { db: db002 } = openDatabase(dbPath, { targetVersion: "002-competitions" });

      // Insert legacy competition in 002
      db002.prepare(`
        INSERT INTO competitions (id, name, description, phase, capacity, ranked)
        VALUES ('comp-legacy-1', 'Legacy Event', 'Created under 002', 'registration', 16, 1)
      `).run();
      closeDatabase(db002);

      // Re-open and apply 003
      const { db: db003, version } = openDatabase(dbPath, { targetVersion: "003-competition-rounds" });
      try {
        assert.equal(version, "003-competition-rounds");

        const legacyRow = db003.prepare("SELECT * FROM competitions WHERE id = 'comp-legacy-1'").get();
        assert.ok(legacyRow);
        assert.equal(legacyRow.name, "Legacy Event");
        assert.equal(legacyRow.is_extended, 0);
        assert.equal(legacyRow.format_id, "double-round-robin");
        assert.equal(legacyRow.map_id, "classic");
        assert.equal(legacyRow.mode, "ranked");
        assert.equal(legacyRow.current_round, 0);
      } finally {
        closeDatabase(db003);
      }
    });
  });

  // ── 2. Standings Calculator & Bye Helper ────────────────────────────────────
  describe("2. Competition Standings Calculator & Bye Aggregator", () => {
    it("aggregates standings across child tournaments, adds bye points, calculates seatBalance and sorts deterministically", () => {
      const { db } = createTestDb();
      try {
        seedUser(db, { id: "u1", username: "alice" });
        seedUser(db, { id: "u2", username: "bob" });
        seedUser(db, { id: "u3", username: "charlie" });

        seedBot(db, { id: "b1", ownerId: "u1", name: "AlphaBot" });
        seedBot(db, { id: "b2", ownerId: "u2", name: "BetaBot" });
        seedBot(db, { id: "b3", ownerId: "u3", name: "GammaBot" });

        seedReadyVersion(db, { id: "v1", botId: "b1" });
        seedReadyVersion(db, { id: "v2", botId: "b2" });
        seedReadyVersion(db, { id: "v3", botId: "b3" });

        const compId = "comp-swiss-standings";
        db.prepare(`
          INSERT INTO competitions (id, name, phase, format_id, is_extended, round_count, current_round)
          VALUES (?, 'Swiss Event', 'running', 'swiss', 1, 3, 2)
        `).run(compId);

        // Child tournament 1
        db.prepare("INSERT INTO tournaments (id, name, status, ruleset_json, policy_json) VALUES ('tourn-r1', 'R1', 'completed', '{}', '{}')").run();
        db.prepare("INSERT INTO competition_rounds (competition_id, round_number, tournament_id, status, pairings_json, byes_json) VALUES (?, 1, 'tourn-r1', 'completed', '[]', '[\"b3\"]')").run(compId);
        // Bye for b3 in round 1 (Swiss bye = 3 points)
        db.prepare("INSERT INTO competition_round_byes (competition_id, round_number, bot_id, points) VALUES (?, 1, 'b3', 3)").run(compId);

        // Standings in tourn-r1: b1 played b2. b1 won (3 pts), b2 lost (0 pts)
        db.prepare("INSERT INTO tournament_standings (tournament_id, bot_id, played, wins, draws, losses, points) VALUES ('tourn-r1', 'b1', 1, 1, 0, 0, 3)").run();
        db.prepare("INSERT INTO tournament_standings (tournament_id, bot_id, played, wins, draws, losses, points) VALUES ('tourn-r1', 'b2', 1, 0, 0, 1, 0)").run();

        // Match 1: b1 (seat A), b2 (seat B)
        db.prepare("INSERT INTO matches (id, kind, ladder_id, ruleset_json, policy_json, profile_json, initial_state_json, status, tournament_id, schedule_index) VALUES ('m1', 'ranked', 'l1', '{}', '{}', '{}', '{}', 'completed', 'tourn-r1', 0)").run();
        db.prepare("INSERT INTO match_participants (match_id, seat, bot_id, bot_version_id, profile_id, profile_revision) VALUES ('m1', 'A', 'b1', 'v1', 'p', '1'), ('m1', 'B', 'b2', 'v2', 'p', '1')").run();

        // Child tournament 2: b1 played b3. b1 drew b3 (1 pt each). b2 got bye (3 pts)
        db.prepare("INSERT INTO tournaments (id, name, status, ruleset_json, policy_json) VALUES ('tourn-r2', 'R2', 'completed', '{}', '{}')").run();
        db.prepare("INSERT INTO competition_rounds (competition_id, round_number, tournament_id, status, pairings_json, byes_json) VALUES (?, 2, 'tourn-r2', 'completed', '[]', '[\"b2\"]')").run(compId);
        db.prepare("INSERT INTO competition_round_byes (competition_id, round_number, bot_id, points) VALUES (?, 2, 'b2', 3)").run(compId);

        db.prepare("INSERT INTO tournament_standings (tournament_id, bot_id, played, wins, draws, losses, points) VALUES ('tourn-r2', 'b1', 1, 0, 1, 0, 1)").run();
        db.prepare("INSERT INTO tournament_standings (tournament_id, bot_id, played, wins, draws, losses, points) VALUES ('tourn-r2', 'b3', 1, 0, 1, 0, 1)").run();

        // Match 2: b3 (seat A), b1 (seat B)
        db.prepare("INSERT INTO matches (id, kind, ladder_id, ruleset_json, policy_json, profile_json, initial_state_json, status, tournament_id, schedule_index) VALUES ('m2', 'ranked', 'l1', '{}', '{}', '{}', '{}', 'completed', 'tourn-r2', 0)").run();
        db.prepare("INSERT INTO match_participants (match_id, seat, bot_id, bot_version_id, profile_id, profile_revision) VALUES ('m2', 'A', 'b3', 'v3', 'p', '1'), ('m2', 'B', 'b1', 'v1', 'p', '1')").run();

        const entries = [
          { botId: "b1", botName: "AlphaBot" },
          { botId: "b2", botName: "BetaBot" },
          { botId: "b3", botName: "GammaBot" }
        ];

        const standings = computeExtendedStandings(db, compId, entries);

        // Verification:
        // b1: match pts = 3 + 1 = 4. wins = 1. draws = 1. losses = 0. played = 2. byes = 0. seatBalance: 1 (seat A in m1) - 1 (seat B in m2) = 0.
        // b3: match pts = 1. bye pts = 3. total pts = 4. wins = 0. draws = 1. played = 1. byes = 1. seatBalance: +1 (seat A in m2).
        // b2: match pts = 0. bye pts = 3. total pts = 3. wins = 0. losses = 1. played = 1. byes = 1. seatBalance: -1 (seat B in m1).
        // Tiebreak b1 vs b3: both 4 points. b1 has 1 win, b3 has 0 wins -> b1 ranks ahead of b3!

        assert.equal(standings.length, 3);
        assert.equal(standings[0].botId, "b1");
        assert.equal(standings[0].points, 4);
        assert.equal(standings[0].wins, 1);
        assert.equal(standings[0].seatBalance, 0);

        assert.equal(standings[1].botId, "b3");
        assert.equal(standings[1].points, 4);
        assert.equal(standings[1].wins, 0);
        assert.equal(standings[1].byeCount, 1);
        assert.equal(standings[1].seatBalance, 1);

        assert.equal(standings[2].botId, "b2");
        assert.equal(standings[2].points, 3);
        assert.equal(standings[2].wins, 0);
        assert.equal(standings[2].losses, 1);
        assert.equal(standings[2].seatBalance, -1);
      } finally {
        closeDatabase(db);
      }
    });

    it("extracts clean round pairing history across rounds", () => {
      const { db } = createTestDb();
      try {
        const compId = "comp-history-test";
        db.prepare(`
          INSERT INTO competitions (id, name, phase, is_extended)
          VALUES (?, 'History Event', 'running', 1)
        `).run(compId);

        db.prepare("INSERT INTO tournaments (id, name, ruleset_json, policy_json) VALUES ('t1', 'R1', '{}', '{}'), ('t2', 'R2', '{}', '{}')").run();

        const r1Pairings = [{ scheduleIndex: 0, botAId: "b1", botBId: "b2" }];
        const r2Pairings = [{ scheduleIndex: 0, botAId: "b1", botBId: "b3" }];

        db.prepare(`
          INSERT INTO competition_rounds (competition_id, round_number, tournament_id, pairings_json)
          VALUES (?, 1, 't1', ?), (?, 2, 't2', ?)
        `).run(compId, JSON.stringify(r1Pairings), compId, JSON.stringify(r2Pairings));

        const history = getCompetitionRoundHistory(db, compId);
        assert.equal(history.length, 2);
        assert.deepEqual(history[0], { roundNumber: 1, botAId: "b1", botBId: "b2" });
        assert.deepEqual(history[1], { roundNumber: 2, botAId: "b1", botBId: "b3" });
      } finally {
        closeDatabase(db);
      }
    });
  });

  // ── 3. Repository: Catalog, Creation & Lifecycle ────────────────────────────
  describe("3. Competition Rounds Repository: Creation, Pinned Snapshot, and Round 1 Launch", () => {
    it("returns catalog matching contract and default configurations", () => {
      const { db } = createTestDb();
      try {
        const roundsRepo = createCompetitionRoundsRepository(db, {
          mapsDomain: mockMapsDomain,
          formatsDomain: mockFormatsDomain
        });

        const catalog = roundsRepo.getCompetitionCatalog();
        assert.ok(Array.isArray(catalog.maps));
        assert.equal(catalog.maps.length, 3);
        assert.equal(catalog.maps[0].id, "classic");
        assert.ok(catalog.maps[0].initialState);

        assert.ok(Array.isArray(catalog.formats));
        assert.equal(catalog.formats.length, 3);

        assert.deepEqual(catalog.defaults, {
          mapId: "classic",
          formatId: "double-round-robin",
          mode: "ranked"
        });
      } finally {
        closeDatabase(db);
      }
    });

    it("creates extended competition with frozen map snapshot and validates mode/ranked consistency", () => {
      const { db } = createTestDb();
      try {
        const roundsRepo = createCompetitionRoundsRepository(db, {
          mapsDomain: mockMapsDomain,
          formatsDomain: mockFormatsDomain
        });

        // 1. Conflict: mode practice and ranked true
        assert.throws(
          () => {
            roundsRepo.createExtendedCompetition({
              name: "Conflicting Event",
              mode: "practice",
              ranked: true
            });
          },
          (err) => err instanceof CompetitionValidationError && err.message.includes("conflict")
        );

        // 2. Successful creation with custom map and Swiss format
        const comp = roundsRepo.createExtendedCompetition({
          name: "Swiss Flanks Cup",
          description: "Swiss with flanks map",
          formatId: "swiss",
          mapId: "flanks",
          roundCount: 3,
          mode: "ranked"
        });

        assert.ok(comp.id.startsWith("comp-"));
        assert.equal(comp.name, "Swiss Flanks Cup");
        assert.equal(comp.formatId, "swiss");
        assert.equal(comp.mapId, "flanks");
        assert.equal(comp.roundCount, 3);
        assert.equal(comp.mode, "ranked");
        assert.equal(comp.isExtended, true);
        assert.equal(comp.phase, "registration");

        // Verify map_snapshot_json in database
        const row = db.prepare("SELECT map_snapshot_json FROM competitions WHERE id = ?").get(comp.id);
        assert.ok(row.map_snapshot_json);
        const snapshot = JSON.parse(row.map_snapshot_json);
        assert.equal(snapshot.descriptor.id, "flanks");
        assert.equal(snapshot.initialState.mapId, "flanks");
      } finally {
        closeDatabase(db);
      }
    });

    it("executes lifecycle: registration -> preparation -> locked (derives round_count) -> running (launches round 1)", () => {
      const { db } = createTestDb();
      try {
        const baseCompRepo = createCompetitionRepository(db);
        const roundsRepo = createCompetitionRoundsRepository(db, {
          mapsDomain: mockMapsDomain,
          formatsDomain: mockFormatsDomain
        });

        seedUser(db, { id: "u-alice", username: "alice" });
        seedUser(db, { id: "u-bob", username: "bob" });

        seedBot(db, { id: "bot-alice", ownerId: "u-alice", name: "AliceBot" });
        seedBot(db, { id: "bot-bob", ownerId: "u-bob", name: "BobBot" });

        seedReadyVersion(db, { id: "bv-alice", botId: "bot-alice" });
        seedReadyVersion(db, { id: "bv-bob", botId: "bot-bob" });

        // Create competition
        const comp = roundsRepo.createExtendedCompetition({
          name: "Championship",
          formatId: "single-round-robin",
          mapId: "classic",
          mode: "ranked"
        });

        // Register and review entries via base repo (shared table)
        baseCompRepo.registerEntry(comp.id, "u-alice");
        baseCompRepo.registerEntry(comp.id, "u-bob");
        baseCompRepo.reviewEntry(comp.id, "u-alice", true);
        baseCompRepo.reviewEntry(comp.id, "u-bob", true);

        // Advance registration -> preparation
        roundsRepo.advanceExtendedPhase(comp.id, "registration");

        // Submit ready bots
        baseCompRepo.submitBotVersion(comp.id, "u-alice", "bv-alice");
        baseCompRepo.submitBotVersion(comp.id, "u-bob", "bv-bob");

        // Advance preparation -> locked: round_count derived via single-round-robin for 2 participants = 1 round
        const locked = roundsRepo.advanceExtendedPhase(comp.id, "preparation");
        assert.equal(locked.phase, "locked");
        assert.equal(locked.roundCount, 1);

        // Advance locked -> running: launches Round 1 tournament
        const running = roundsRepo.advanceExtendedPhase(comp.id, "locked");
        assert.equal(running.phase, "running");
        assert.equal(running.currentRound, 1);
        assert.ok(running.tournamentId);
        assert.ok(running.tournamentId.includes("-r1"));

        // Verify round record in competition_rounds
        const round1 = db.prepare("SELECT * FROM competition_rounds WHERE competition_id = ? AND round_number = 1").get(comp.id);
        assert.ok(round1);
        assert.equal(round1.tournament_id, running.tournamentId);
        assert.equal(round1.status, "running");

        // Verify tournament was created with the pinned core initial state
        const tourn = db.prepare("SELECT * FROM tournaments WHERE id = ?").get(running.tournamentId);
        assert.ok(tourn);
        const match = db.prepare("SELECT * FROM matches WHERE tournament_id = ?").get(running.tournamentId);
        assert.ok(match);
        const matchState = JSON.parse(match.initial_state_json);
        assert.equal(matchState.mapId, "classic");
      } finally {
        closeDatabase(db);
      }
    });
  });

  // ── 4. Explicit Next-Round Progression ─────────────────────────────────────
  describe("4. Next-Round Progression & Multi-Round Gates", () => {
    it("enforces CAS expectedRound check and blocks progression when previous round has running or errored matches", () => {
      const { db } = createTestDb();
      try {
        const baseCompRepo = createCompetitionRepository(db);
        const roundsRepo = createCompetitionRoundsRepository(db, {
          mapsDomain: mockMapsDomain,
          formatsDomain: mockFormatsDomain
        });

        seedUser(db, { id: "u-a", username: "alex" });
        seedUser(db, { id: "u-b", username: "blake" });
        seedBot(db, { id: "bot-a", ownerId: "u-a", name: "A-Bot" });
        seedBot(db, { id: "bot-b", ownerId: "u-b", name: "B-Bot" });
        seedReadyVersion(db, { id: "bv-a", botId: "bot-a" });
        seedReadyVersion(db, { id: "bv-b", botId: "bot-b" });

        const comp = roundsRepo.createExtendedCompetition({
          name: "Two-Round Event",
          formatId: "double-round-robin",
          mapId: "classic",
          roundCount: 2,
          mode: "ranked"
        });

        baseCompRepo.registerEntry(comp.id, "u-a");
        baseCompRepo.registerEntry(comp.id, "u-b");
        baseCompRepo.reviewEntry(comp.id, "u-a", true);
        baseCompRepo.reviewEntry(comp.id, "u-b", true);

        roundsRepo.advanceExtendedPhase(comp.id, "registration");
        baseCompRepo.submitBotVersion(comp.id, "u-a", "bv-a");
        baseCompRepo.submitBotVersion(comp.id, "u-b", "bv-b");

        roundsRepo.advanceExtendedPhase(comp.id, "preparation");
        roundsRepo.advanceExtendedPhase(comp.id, "locked");

        // Currently in round 1 with pending matches
        // 1. CAS Mismatch
        assert.throws(
          () => roundsRepo.nextRound(comp.id, 2),
          (err) => err instanceof CompetitionPhaseError && err.message.includes("Expected round 2 does not match current round 1")
        );

        // Out of bounds expectedRound throws validation error
        assert.throws(
          () => roundsRepo.nextRound(comp.id, 99),
          (err) => err instanceof CompetitionValidationError
        );

        // 2. Blocked because round 1 matches are still running (pending)
        assert.throws(
          () => roundsRepo.nextRound(comp.id, 1),
          (err) => err instanceof CompetitionPhaseError && err.message.includes("matches are still running")
        );

        // 3. Set match to error -> must block with error retry required message
        const match = db.prepare("SELECT id FROM matches WHERE tournament_id = (SELECT tournament_id FROM competitions WHERE id = ?)").get(comp.id);
        db.prepare("UPDATE matches SET status = 'error' WHERE id = ?").run(match.id);

        assert.throws(
          () => roundsRepo.nextRound(comp.id, 1),
          (err) => err instanceof CompetitionPhaseError && err.message.includes("errored matches that must be retried")
        );

        // 4. Complete match and tournament
        db.prepare("UPDATE matches SET status = 'completed' WHERE id = ?").run(match.id);
        const tournId = db.prepare("SELECT tournament_id FROM competitions WHERE id = ?").get(comp.id).tournament_id;
        db.prepare("UPDATE tournaments SET status = 'completed' WHERE id = ?").run(tournId);

        // 5. Next round progression succeeds atomically!
        const r2Comp = roundsRepo.nextRound(comp.id, 1);
        assert.equal(r2Comp.currentRound, 2);
        assert.ok(r2Comp.tournamentId.includes("-r2"));

        // Round 1 marked completed
        const r1Row = db.prepare("SELECT status, completed_at FROM competition_rounds WHERE competition_id = ? AND round_number = 1").get(comp.id);
        assert.equal(r1Row.status, "completed");
        assert.ok(r1Row.completed_at);

        // Round 2 created
        const r2Row = db.prepare("SELECT status FROM competition_rounds WHERE competition_id = ? AND round_number = 2").get(comp.id);
        assert.equal(r2Row.status, "running");

        // 6. Cannot advance beyond configured round count (roundCount was 2)
        assert.throws(
          () => roundsRepo.nextRound(comp.id, 2),
          (err) => err instanceof CompetitionPhaseError && err.message.includes("All configured rounds have already been created")
        );
      } finally {
        closeDatabase(db);
      }
    });

    it("blocks final completion until current_round === round_count AND final matches complete", () => {
      const { db } = createTestDb();
      try {
        const baseCompRepo = createCompetitionRepository(db);
        const roundsRepo = createCompetitionRoundsRepository(db, {
          mapsDomain: mockMapsDomain,
          formatsDomain: mockFormatsDomain
        });

        seedUser(db, { id: "u-x", username: "xav" });
        seedUser(db, { id: "u-y", username: "yves" });
        seedBot(db, { id: "bot-x", ownerId: "u-x", name: "X-Bot" });
        seedBot(db, { id: "bot-y", ownerId: "u-y", name: "Y-Bot" });
        seedReadyVersion(db, { id: "bv-x", botId: "bot-x" });
        seedReadyVersion(db, { id: "bv-y", botId: "bot-y" });

        const comp = roundsRepo.createExtendedCompetition({
          name: "Double Round Cup",
          formatId: "double-round-robin",
          roundCount: 2
        });

        baseCompRepo.registerEntry(comp.id, "u-x");
        baseCompRepo.registerEntry(comp.id, "u-y");
        baseCompRepo.reviewEntry(comp.id, "u-x", true);
        baseCompRepo.reviewEntry(comp.id, "u-y", true);

        roundsRepo.advanceExtendedPhase(comp.id, "registration");
        baseCompRepo.submitBotVersion(comp.id, "u-x", "bv-x");
        baseCompRepo.submitBotVersion(comp.id, "u-y", "bv-y");
        roundsRepo.advanceExtendedPhase(comp.id, "preparation");
        roundsRepo.advanceExtendedPhase(comp.id, "locked");

        // In round 1 of 2. Attempting advancePhase('running') must fail
        assert.throws(
          () => roundsRepo.advanceExtendedPhase(comp.id, "running"),
          (err) => err instanceof CompetitionPhaseError && err.message.includes("has not reached configured total rounds")
        );

        // Complete round 1 matches
        const r1Matches = db.prepare("SELECT id FROM matches WHERE tournament_id = (SELECT tournament_id FROM competitions WHERE id = ?)").all(comp.id);
        for (const m of r1Matches) {
          db.prepare("UPDATE matches SET status = 'completed' WHERE id = ?").run(m.id);
        }

        // Advance to round 2
        roundsRepo.nextRound(comp.id, 1);

        // In round 2 of 2, matches still running
        assert.throws(
          () => roundsRepo.advanceExtendedPhase(comp.id, "running"),
          (err) => err instanceof CompetitionPhaseError && err.message.includes("tournament matches are still running")
        );

        // Complete round 2 matches
        const r2Matches = db.prepare("SELECT id FROM matches WHERE tournament_id = (SELECT tournament_id FROM competitions WHERE id = ?)").all(comp.id);
        for (const m of r2Matches) {
          db.prepare("UPDATE matches SET status = 'completed' WHERE id = ?").run(m.id);
        }

        // Now completion succeeds!
        const completedComp = roundsRepo.advanceExtendedPhase(comp.id, "running");
        assert.equal(completedComp.phase, "completed");
      } finally {
        closeDatabase(db);
      }
    });
  });

  // ── 5. HTTP API Endpoints Matrix ───────────────────────────────────────────
  describe("5. HTTP API Matrix (/competition-catalog, /competitions, /next-round, /retry)", () => {
    let server;
    let db;
    let adminToken;
    let authorToken;

    before(async () => {
      const created = createTestDb();
      db = created.db;

      seedUser(db, { id: "u-admin", username: "admin", role: "admin" });
      seedUser(db, { id: "u-author", username: "author", role: "author" });

      const adminSession = createSession(db, "u-admin");
      adminToken = adminSession.token;

      const authorSession = createSession(db, "u-author");
      authorToken = authorSession.token;

      const tournamentRepo = createTournamentRepository(db);
      const competitionRepo = createCompetitionRepository(db, { tournamentRepo });
      const competitionRoundsRepo = createCompetitionRoundsRepository(db, {
        tournamentRepo,
        mapsDomain: mockMapsDomain,
        formatsDomain: mockFormatsDomain
      });

      server = createArenaServer({
        db,
        tournamentRepo,
        competitionRepo,
        competitionRoundsRepo
      });

      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    });

    after(async () => {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      if (db) {
        closeDatabase(db);
      }
    });

    it("GET /api/arena/v1/competition-catalog rejects unauthenticated with HTTP 401", async () => {
      const res = await makeRequest(server, { path: "/api/arena/v1/competition-catalog" });
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.error.code, "UNAUTHORIZED");
    });

    it("GET /api/arena/v1/competition-catalog returns 200 with maps, formats, and modes for authenticated users", async () => {
      const res = await makeRequest(server, {
        path: "/api/arena/v1/competition-catalog",
        headers: { Authorization: `Bearer ${authorToken}` }
      });
      assert.equal(res.statusCode, 200);
      assert.ok(Array.isArray(res.body.maps));
      assert.ok(Array.isArray(res.body.formats));
      assert.ok(Array.isArray(res.body.modes));
      assert.equal(res.body.defaults.formatId, "double-round-robin");
    });

    it("POST /api/arena/v1/competitions rejects non-admin with HTTP 403", async () => {
      const res = await makeRequest(
        server,
        {
          path: "/api/arena/v1/competitions",
          method: "POST",
          headers: { Authorization: `Bearer ${authorToken}` }
        },
        { name: "My Event", formatId: "swiss" }
      );
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error.code, "FORBIDDEN");
    });

    it("POST /api/arena/v1/competitions creates extended competition and GET /:id returns additive details", async () => {
      const res = await makeRequest(
        server,
        {
          path: "/api/arena/v1/competitions",
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` }
        },
        {
          name: "Swiss Championship",
          formatId: "swiss",
          mapId: "flanks",
          roundCount: 3,
          mode: "ranked"
        }
      );

      assert.equal(res.statusCode, 201);
      assert.ok(res.body.competition);
      const compId = res.body.competition.id;
      assert.equal(res.body.competition.isExtended, true);
      assert.equal(res.body.competition.formatId, "swiss");

      // GET detail
      const detailRes = await makeRequest(server, {
        path: `/api/arena/v1/competitions/${compId}`,
        headers: { Authorization: `Bearer ${authorToken}` }
      });

      assert.equal(detailRes.statusCode, 200);
      assert.ok(detailRes.body.competition);
      assert.ok(detailRes.body.configuration);
      assert.ok(Array.isArray(detailRes.body.rounds));
      assert.ok(Array.isArray(detailRes.body.standings));
      assert.equal(detailRes.body.configuration.formatId, "swiss");
      assert.equal(detailRes.body.configuration.mapId, "flanks");
    });

    it("POST /api/arena/v1/competitions/:id/next-round rejects non-admin with HTTP 403 and rejects invalid fields with HTTP 422", async () => {
      // 1. Non-admin
      const res403 = await makeRequest(
        server,
        {
          path: "/api/arena/v1/competitions/comp-test/next-round",
          method: "POST",
          headers: { Authorization: `Bearer ${authorToken}` }
        },
        { expectedRound: 1 }
      );
      assert.equal(res403.statusCode, 403);

      // 2. Unexpected fields
      const res422 = await makeRequest(
        server,
        {
          path: "/api/arena/v1/competitions/comp-test/next-round",
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` }
        },
        { expectedRound: 1, extraField: "invalid" }
      );
      assert.equal(res422.statusCode, 422);
      assert.equal(res422.body.error.code, "VALIDATION_ERROR");
    });
  });
});
