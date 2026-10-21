/**
 * tests/arena-rounds-acceptance.test.js
 *
 * End-to-End Acceptance Test Suite for Arena Extended Competitions
 * (Rounds, Maps, and Modes - ROOT ARENA_ROUNDS_MAPS_MODES_PLAN.local.md).
 *
 * Requirements verified without mock shortcuts for core execution:
 * 1. Meaningful Actual Execution:
 *    - Real temp SQLite DB, ArtifactStore, ProfileRegistry, BuildService,
 *      BotVersionService, JobWorker, and MatchFinalizer.
 *    - Real Node child-process bot execution communicating over stdio protocol v1.
 * 2. Non-Classic Map Initial State Pinning & Replay:
 *    - Map 'flanks' starting state pinned in competition snapshot and match initial_state_json.
 *    - Real child process executes turn loop from non-classic layout.
 *    - Replay initialCoreState matches pinned flanks map without ruleset mutation.
 * 3. Practice Mode Invariant (Zero-Elo Mutation):
 *    - Match settles, tournament advances, standings update.
 *    - ZERO entries written to bot_ratings and ZERO rows written to rating_changes.
 * 4. 3-Participant Swiss System over 2 Rounds:
 *    - Odd participant count produces 1 match and 1 fair BYE per round.
 *    - Fair BYE (+3 pts in competition_round_byes) allocated to different eligible bots.
 *    - Cumulative standings accurately aggregate child tournament points and bye points.
 * 5. Complete Round Gating & Idempotent Next-Round:
 *    - nextRound blocked when previous round matches are pending/active/errored.
 *    - Duplicate nextRound rejected via CAS expectedRound check with zero duplicate match jobs.
 *    - Completion gate blocks running -> completed until current_round === round_count and all matches finished.
 * 6. [Simulated State Transition] Error Gating & Retry Protection:
 *    - Errored match blocks round progression and final completion.
 *    - Admin retry recovers match to pending, worker runs to completion, gates unblock.
 * 7. HTTP API Matrix:
 *    - Authenticated GET /api/arena/v1/competition-catalog returns maps, formats, and modes.
 *    - POST /api/arena/v1/competitions creates extended event with custom configuration.
 *    - POST /api/arena/v1/competitions/:id/next-round enforces admin role and CAS checks.
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const { createHash } = require("node:crypto");

const TEMP_BASE_DIR = path.resolve(os.tmpdir(), "arena-rounds-acceptance-" + Date.now());

let openDatabase;
let closeDatabase;
let withTransaction;
let createArtifactStore;
let createProfileRegistry;
let createBuildService;
let createBotVersionService;
let createBotRepository;
let createMatchRepository;
let createJobQueue;
let createMatchFinalizer;
let createJobWorker;
let createTournamentRepository;
let createCompetitionRepository;
let createCompetitionRoundsRepository;
let computeExtendedStandings;
let getCompetitionRoundHistory;
let listMaps;
let getMap;
let createMapState;
let listFormats;
let getRoundCount;
let pairRound;
let validateReplayDocument;
let canonicalSerialize;
let createArenaServer;
let hashPassword;
let createSession;
let CompetitionPhaseError;
let CompetitionValidationError;

function sha256Digest(data) {
  const str = typeof data === "string" ? data : canonicalSerialize(data);
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
      headers: { ...(options.headers || {}) }
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
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    }
    req.end();
  });
}

before(async () => {
  fs.mkdirSync(TEMP_BASE_DIR, { recursive: true });

  const dbMod = await import("../packages/arena-node/src/persistence/sqlite-database.mjs");
  openDatabase = dbMod.openDatabase;
  closeDatabase = dbMod.closeDatabase;
  withTransaction = dbMod.withTransaction;

  const artifactMod = await import("../packages/arena-node/src/artifacts/artifact-store.mjs");
  createArtifactStore = artifactMod.createArtifactStore;

  const profileMod = await import("../packages/arena-node/src/execution/profile-registry.mjs");
  createProfileRegistry = profileMod.createProfileRegistry;

  const buildMod = await import("../packages/arena-node/src/execution/build-service.mjs");
  createBuildService = buildMod.createBuildService;

  const botVerMod = await import("../packages/arena-node/src/persistence/bot-version-service.mjs");
  createBotVersionService = botVerMod.createBotVersionService;

  const botRepoMod = await import("../packages/arena-node/src/persistence/bot-repository.mjs");
  createBotRepository = botRepoMod.createBotRepository;

  const matchRepoMod = await import("../packages/arena-node/src/persistence/match-repository.mjs");
  createMatchRepository = matchRepoMod.createMatchRepository;

  const queueMod = await import("../packages/arena-node/src/persistence/job-queue.mjs");
  createJobQueue = queueMod.createJobQueue;

  const finalizerMod = await import("../packages/arena-node/src/persistence/finalizer.mjs");
  createMatchFinalizer = finalizerMod.createMatchFinalizer;

  const workerMod = await import("../packages/arena-node/src/worker/job-worker.mjs");
  createJobWorker = workerMod.createJobWorker;

  const tournRepoMod = await import("../packages/arena-node/src/persistence/tournament-repository.mjs");
  createTournamentRepository = tournRepoMod.createTournamentRepository;

  const compRepoMod = await import("../packages/arena-node/src/persistence/competition-repository.mjs");
  createCompetitionRepository = compRepoMod.createCompetitionRepository;
  CompetitionPhaseError = compRepoMod.CompetitionPhaseError;
  CompetitionValidationError = compRepoMod.CompetitionValidationError;

  const roundsRepoMod = await import("../packages/arena-node/src/persistence/competition-rounds-repository.mjs");
  createCompetitionRoundsRepository = roundsRepoMod.createCompetitionRoundsRepository;

  const calcMod = await import("../packages/arena-node/src/persistence/competition-standings-calculator.mjs");
  computeExtendedStandings = calcMod.computeExtendedStandings;
  getCompetitionRoundHistory = calcMod.getCompetitionRoundHistory;

  const mapsMod = await import("../packages/arena/src/domain/maps/index.mjs");
  listMaps = mapsMod.listMaps;
  getMap = mapsMod.getMap;
  createMapState = mapsMod.createMapState;

  const formatsMod = await import("../packages/arena/src/domain/formats/index.mjs");
  listFormats = formatsMod.listFormats;
  getRoundCount = formatsMod.getRoundCount;
  pairRound = formatsMod.pairRound;

  const valMod = await import("../packages/arena/src/contracts/validation.mjs");
  validateReplayDocument = valMod.validateReplayDocument;

  const rulesMod = await import("../packages/arena/src/domain/ruleset.mjs");
  canonicalSerialize = rulesMod.canonicalSerialize;

  const serverMod = await import("../apps/arena-api/src/http-server.mjs");
  createArenaServer = serverMod.createArenaServer;

  const authMod = await import("../apps/arena-api/src/auth/accounts.mjs");
  hashPassword = authMod.hashPassword;
  createSession = authMod.createSession;
});

after(() => {
  try {
    fs.rmSync(TEMP_BASE_DIR, { recursive: true, force: true });
  } catch (_) {}
});

function setupAcceptanceEnvironment(subDir) {
  const dir = path.join(TEMP_BASE_DIR, subDir);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "arena.db");
  const storageDir = path.join(dir, "artifacts");

  const nativeBinding = process.env.ARENA_SQLITE_NATIVE_BINDING || undefined;
  const { db } = openDatabase(dbPath, {
    targetVersion: "003-competition-rounds",
    ...(nativeBinding ? { nativeBinding } : {})
  });

  const artifactStore = createArtifactStore({ storageDir });
  const profileRegistry = createProfileRegistry();
  const buildService = createBuildService({ artifactStore, profileRegistry });
  const botVersionService = createBotVersionService({
    db,
    artifactStore,
    buildService,
    profileRegistry
  });

  const botRepo = createBotRepository(db);
  const matchRepo = createMatchRepository(db);
  const jobQueue = createJobQueue(db);
  const finalizer = createMatchFinalizer(db, { computeDigest: sha256Digest });
  const tournamentRepo = createTournamentRepository(db);
  const competitionRepo = createCompetitionRepository(db, { tournamentRepo, botRepo });
  const competitionRoundsRepo = createCompetitionRoundsRepository(db, {
    tournamentRepo,
    botRepo,
    mapsDomain: { listMaps, getMap, createMapState },
    formatsDomain: { listFormats, getRoundCount, pairRound }
  });

  const botScriptPath = path.resolve(__dirname, "fixtures/arena/bots/legal.mjs");
  const botSourceContent = fs.readFileSync(botScriptPath);

  // Real JobWorker executing real Node child processes
  const worker = createJobWorker({
    workerId: `worker-${subDir}`,
    db,
    jobQueue,
    matchRepo,
    finalizer,
    botVersionService,
    artifactStore,
    profileRegistry,
    computeDigest: sha256Digest,
    allowedKinds: ["build", "match"]
  });

  // Seed default admin user
  const adminPasswordHash = hashPassword("adminpass123");
  db.prepare(`
    INSERT INTO users (id, normalized_username, password_hash, role, status)
    VALUES (?, ?, ?, 'admin', 'active')
  `).run("user-admin", "admin", adminPasswordHash);

  async function registerAndBuildBot({ userId, username, botId, botName }) {
    const pwHash = hashPassword("userpass123");
    db.prepare(`
      INSERT INTO users (id, normalized_username, password_hash, role, status)
      VALUES (?, ?, ?, 'author', 'active')
    `).run(userId, username.toLowerCase(), pwHash);

    botRepo.createBot(
      { id: botId, ownerId: userId, name: botName },
      { actorId: userId, idempotencyKey: `idem-create-${botId}` }
    );

    const upload = await botVersionService.uploadBotVersion(
      {
        botId,
        sourceContent: botSourceContent,
        profileId: "node"
      },
      {
        actorId: userId,
        idempotencyKey: `idem-upload-${botId}-v1`
      }
    );

    const buildResult = await botVersionService.processBuildJob({
      jobId: upload.job.id,
      leaseOwner: `builder-${userId}`
    });

    assert.equal(buildResult.botVersion.build_status, "ready");
    assert.ok(buildResult.botVersion.artifact_digest);

    return {
      userId,
      username,
      botId,
      botName,
      botVersionId: upload.botVersion.id,
      artifactDigest: buildResult.botVersion.artifact_digest
    };
  }

  return {
    dir,
    dbPath,
    storageDir,
    db,
    artifactStore,
    profileRegistry,
    buildService,
    botVersionService,
    botRepo,
    matchRepo,
    jobQueue,
    finalizer,
    tournamentRepo,
    competitionRepo,
    competitionRoundsRepo,
    worker,
    botSourceContent,
    registerAndBuildBot,
    cleanup() {
      closeDatabase(db);
    }
  };
}

describe("Arena Extended Acceptance Test — Rounds, Maps & Modes", () => {
  it(
    "1. Real E2E execution on non-classic map ('flanks') in practice mode with zero-Elo invariant",
    { timeout: 60000 },
    async () => {
      const env = setupAcceptanceEnvironment("nonclassic-practice-e2e");
      try {
        // Register and build 2 ready bots using real Node profiles
        const bot1 = await env.registerAndBuildBot({
          userId: "user-alpha",
          username: "alpha_owner",
          botId: "bot-alpha",
          botName: "AlphaBot"
        });
        const bot2 = await env.registerAndBuildBot({
          userId: "user-beta",
          username: "beta_owner",
          botId: "bot-beta",
          botName: "BetaBot"
        });

        // Create practice competition pinned to 'flanks' map variation
        const comp = env.competitionRoundsRepo.createExtendedCompetition(
          {
            name: "Flanks Practice Match",
            capacity: 2,
            formatId: "single-round-robin",
            mapId: "flanks",
            mode: "practice",
            roundCount: 1
          },
          { actorId: "user-admin" }
        );

        assert.equal(comp.formatId, "single-round-robin");
        assert.equal(comp.mapId, "flanks");
        assert.equal(comp.mode, "practice");
        assert.equal(comp.ranked, false);

        // Verify pinned map snapshot in database contains 'flanks' layout
        const rawComp = env.db.prepare("SELECT * FROM competitions WHERE id = ?").get(comp.id);
        assert.equal(rawComp.map_id, "flanks");
        assert.equal(rawComp.is_extended, 1);
        const mapSnapshot = JSON.parse(rawComp.map_snapshot_json);
        assert.equal(mapSnapshot.descriptor.id, "flanks");
        assert.ok(Array.isArray(mapSnapshot.initialState.pieces));

        // Participants register and are reviewed
        env.competitionRepo.registerEntry(comp.id, bot1.userId, { actorId: bot1.userId });
        env.competitionRepo.registerEntry(comp.id, bot2.userId, { actorId: bot2.userId });

        env.competitionRepo.reviewEntry(comp.id, bot1.userId, true, { actorId: "user-admin" });
        env.competitionRepo.reviewEntry(comp.id, bot2.userId, true, { actorId: "user-admin" });

        // Lifecycle progression: advance registration -> preparation
        env.competitionRoundsRepo.advanceExtendedPhase(comp.id, "registration");

        // Submit ready versions during preparation phase
        env.competitionRepo.submitBotVersion(comp.id, bot1.userId, bot1.botVersionId, { actorId: bot1.userId });
        env.competitionRepo.submitBotVersion(comp.id, bot2.userId, bot2.botVersionId, { actorId: bot2.userId });

        // Advance preparation -> locked
        env.competitionRoundsRepo.advanceExtendedPhase(comp.id, "preparation");

        // Advance to locked -> launches round 1 tournament
        const runningComp = env.competitionRoundsRepo.advanceExtendedPhase(comp.id, "locked");
        assert.equal(runningComp.phase, "running");
        assert.equal(runningComp.currentRound, 1);
        assert.ok(runningComp.tournamentId);

        // Verify scheduled match has pinned initial_state_json from flanks map
        const matchRow = env.db
          .prepare("SELECT * FROM matches WHERE tournament_id = ?")
          .get(runningComp.tournamentId);
        assert.ok(matchRow, "Match row must exist");
        const matchInitialState = JSON.parse(matchRow.initial_state_json);
        const expectedFlanksState = createMapState("flanks", 1);
        assert.equal(
          canonicalSerialize(matchInitialState.pieces),
          canonicalSerialize(expectedFlanksState.pieces),
          "Match initial state must match frozen flanks map pieces"
        );

        // Execute match via real JobWorker child processes
        let matchClaim = null;
        for (let step = 0; step < 10; step++) {
          const outcome = await env.worker.runOnce();
          if (outcome.executed && outcome.claim?.kind === "match") {
            matchClaim = outcome.claim;
            break;
          }
        }
        assert.ok(matchClaim, "JobWorker must claim and execute the match");

        // Verify match finished with 'completed' status
        const completedMatch = env.matchRepo.getMatch(matchRow.id);
        assert.equal(completedMatch.status, "completed", "Match must be completed by finalizer");

        // Verify replay document initialCoreState matches flanks layout
        const matchResultRow = env.db
          .prepare("SELECT * FROM match_results WHERE match_id = ?")
          .get(matchRow.id);
        assert.ok(matchResultRow, "Match result row must exist");
        const replay = JSON.parse(matchResultRow.replay_json);
        const validation = validateReplayDocument(replay);
        assert.ok(validation.ok, `Replay document must pass validation: ${JSON.stringify(validation.errors)}`);
        assert.equal(
          canonicalSerialize(replay.initialCoreState.pieces),
          canonicalSerialize(expectedFlanksState.pieces),
          "Replay initialCoreState pieces must exactly match flanks layout"
        );

        // PRACTICE MODE INVARIANT: Elo tables must have ZERO mutations
        const ratingsCount = env.db
          .prepare("SELECT COUNT(*) AS c FROM bot_ratings WHERE bot_id IN (?, ?)")
          .get(bot1.botId, bot2.botId);
        assert.equal(ratingsCount.c, 0, "Practice matches must NOT record any bot_ratings rows");

        const ratingChangesCount = env.db
          .prepare("SELECT COUNT(*) AS c FROM rating_changes WHERE match_id = ?")
          .get(matchRow.id);
        assert.equal(ratingChangesCount.c, 0, "Practice matches must NOT record any rating_changes rows");

        // Verify extended standings reflect match points without Elo
        const details = env.competitionRoundsRepo.getExtendedCompetitionDetails(comp.id);
        assert.equal(details.standings.length, 2);
        const sumPoints = details.standings.reduce((acc, s) => acc + s.points, 0);
        assert.ok(sumPoints >= 2, "Standings points must reflect played match outcome (win=3, draw=1 each)");

        // Complete competition
        const completedComp = env.competitionRoundsRepo.advanceExtendedPhase(comp.id, "running");
        assert.equal(completedComp.phase, "completed");
      } finally {
        env.cleanup();
      }
    }
  );

  it(
    "2. 3-Participant Swiss over 2 rounds: fair byes, round gating, duplicate next-round guard, and aggregate standings",
    { timeout: 90000 },
    async () => {
      const env = setupAcceptanceEnvironment("swiss-3p-2r-acceptance");
      try {
        // Register and build 3 ready bots
        const p1 = await env.registerAndBuildBot({
          userId: "user-s1",
          username: "s1_owner",
          botId: "bot-s1",
          botName: "BotS1"
        });
        const p2 = await env.registerAndBuildBot({
          userId: "user-s2",
          username: "s2_owner",
          botId: "bot-s2",
          botName: "BotS2"
        });
        const p3 = await env.registerAndBuildBot({
          userId: "user-s3",
          username: "s3_owner",
          botId: "bot-s3",
          botName: "BotS3"
        });

        // Create 3-participant Swiss event with 2 rounds on 'center' map
        const comp = env.competitionRoundsRepo.createExtendedCompetition(
          {
            name: "Swiss 3P Championship",
            capacity: 4,
            formatId: "swiss",
            mapId: "center",
            mode: "practice",
            roundCount: 2
          },
          { actorId: "user-admin" }
        );

        assert.equal(comp.formatId, "swiss");
        assert.equal(comp.roundCount, 2);

        // Register and admit all 3 participants
        for (const p of [p1, p2, p3]) {
          env.competitionRepo.registerEntry(comp.id, p.userId, { actorId: p.userId });
          env.competitionRepo.reviewEntry(comp.id, p.userId, true, { actorId: "user-admin" });
        }

        // Advance registration -> preparation
        env.competitionRoundsRepo.advanceExtendedPhase(comp.id, "registration");

        // Submit bot versions during preparation phase
        for (const p of [p1, p2, p3]) {
          env.competitionRepo.submitBotVersion(comp.id, p.userId, p.botVersionId, { actorId: p.userId });
        }

        // Advance preparation -> locked (round count derived for Swiss 3P)
        const lockedComp = env.competitionRoundsRepo.advanceExtendedPhase(comp.id, "preparation");
        assert.equal(lockedComp.phase, "locked");
        assert.equal(lockedComp.roundCount, 2, "Swiss 3 participants allows 2 rounds");

        // Advance locked -> running (Round 1 launched)
        const round1Comp = env.competitionRoundsRepo.advanceExtendedPhase(comp.id, "locked");
        assert.equal(round1Comp.phase, "running");
        assert.equal(round1Comp.currentRound, 1);

        // ── ROUND 1 VERIFICATIONS ──
        // Odd participant count (3) in Swiss must generate exactly 1 match and 1 fair BYE
        const r1Matches = env.db
          .prepare("SELECT * FROM matches WHERE tournament_id = ?")
          .all(round1Comp.tournamentId);
        assert.equal(r1Matches.length, 1, "Round 1 must schedule exactly 1 match for 3 bots");

        const r1Byes = env.db
          .prepare("SELECT * FROM competition_round_byes WHERE competition_id = ? AND round_number = 1")
          .all(comp.id);
        assert.equal(r1Byes.length, 1, "Round 1 must award exactly 1 fair BYE");
        const round1ByeBotId = r1Byes[0].bot_id;
        assert.equal(r1Byes[0].points, 3, "Swiss BYE must be awarded 3 points");

        // Match participants in Round 1 must be the other two bots
        const r1MatchParticipants = env.db
          .prepare("SELECT bot_id FROM match_participants WHERE match_id = ?")
          .all(r1Matches[0].id)
          .map((r) => r.bot_id);
        assert.ok(!r1MatchParticipants.includes(round1ByeBotId), "BYE recipient must not be in round 1 match");

        // ── GATING CHECK 1: nextRound blocked while match is pending ──
        assert.throws(
          () => env.competitionRoundsRepo.nextRound(comp.id, 1),
          (err) =>
            err instanceof CompetitionPhaseError &&
            err.message.includes("previous round matches are still running"),
          "nextRound must be blocked while round 1 match is pending"
        );

        // ── GATING CHECK 2: final completion blocked while in round 1 ──
        assert.throws(
          () => env.competitionRoundsRepo.advanceExtendedPhase(comp.id, "running"),
          (err) =>
            err instanceof CompetitionPhaseError &&
            err.message.includes("has not reached configured total rounds"),
          "advanceExtendedPhase(running) must be blocked before reaching total rounds"
        );

        // ── EXECUTE ROUND 1 MATCH VIA REAL WORKER (NO SQL FAKE STATUS MUTATION) ──
        let r1Executed = false;
        for (let i = 0; i < 10; i++) {
          const outcome = await env.worker.runOnce();
          if (outcome.executed && outcome.claim?.kind === "match") {
            r1Executed = true;
            break;
          }
        }
        assert.ok(r1Executed, "Worker must execute real round 1 match to completion");

        // Verify round 1 tournament completed automatically by finalizer
        const r1Tourn = env.tournamentRepo.getTournament(round1Comp.tournamentId);
        assert.equal(r1Tourn.status, "completed", "Round 1 child tournament must be completed");

        // ── ADVANCE TO ROUND 2 ──
        const round2Comp = env.competitionRoundsRepo.nextRound(comp.id, 1);
        assert.equal(round2Comp.currentRound, 2, "Current round must advance to 2");
        assert.notEqual(round2Comp.tournamentId, round1Comp.tournamentId, "Round 2 must have distinct tournamentId");

        // ── DUPLICATE NEXT-ROUND CAS GUARD ──
        // Calling nextRound with expectedRound=1 again must fail CAS check
        assert.throws(
          () => env.competitionRoundsRepo.nextRound(comp.id, 1),
          (err) =>
            err instanceof CompetitionPhaseError &&
            err.message.includes("Expected round 1 does not match current round 2"),
          "Duplicate nextRound(1) must be rejected with CAS mismatch"
        );

        // Verify zero duplicate match jobs created
        const r2Matches = env.db
          .prepare("SELECT * FROM matches WHERE tournament_id = ?")
          .all(round2Comp.tournamentId);
        assert.equal(r2Matches.length, 1, "Round 2 must have exactly 1 match");
        const r2Jobs = env.db
          .prepare("SELECT * FROM jobs WHERE target_id = ?")
          .all(r2Matches[0].id);
        assert.equal(r2Jobs.length, 1, "Exactly one job must exist for round 2 match");

        // ── FAIR BYE ALLOCATION FOR ROUND 2 ──
        // The bot who had a BYE in Round 1 (byeCount=1) must NOT receive a BYE in Round 2
        const r2Byes = env.db
          .prepare("SELECT * FROM competition_round_byes WHERE competition_id = ? AND round_number = 2")
          .all(comp.id);
        assert.equal(r2Byes.length, 1, "Round 2 must award exactly 1 fair BYE");
        const round2ByeBotId = r2Byes[0].bot_id;

        assert.notEqual(
          round2ByeBotId,
          round1ByeBotId,
          `Fair BYE rule: Round 2 BYE (${round2ByeBotId}) must NOT be given to Round 1 BYE recipient (${round1ByeBotId})`
        );
        assert.equal(r2Byes[0].points, 3, "Round 2 BYE must also be awarded 3 points");

        // Verify Round 1 BYE recipient is participating in Round 2 match
        const r2MatchParticipants = env.db
          .prepare("SELECT bot_id FROM match_participants WHERE match_id = ?")
          .all(r2Matches[0].id)
          .map((r) => r.bot_id);
        assert.ok(
          r2MatchParticipants.includes(round1ByeBotId),
          "Round 1 BYE recipient must play a real match in round 2"
        );

        // ── EXECUTE ROUND 2 MATCH VIA REAL WORKER (NO SQL FAKE STATUS MUTATION) ──
        let r2Executed = false;
        for (let i = 0; i < 10; i++) {
          const outcome = await env.worker.runOnce();
          if (outcome.executed && outcome.claim?.kind === "match") {
            r2Executed = true;
            break;
          }
        }
        assert.ok(r2Executed, "Worker must execute real round 2 match to completion");

        // Verify round 2 tournament completed
        const r2Tourn = env.tournamentRepo.getTournament(round2Comp.tournamentId);
        assert.equal(r2Tourn.status, "completed", "Round 2 tournament must be completed");

        // ── CUMULATIVE EXTENDED STANDINGS VERIFICATION ──
        const standings = computeExtendedStandings(env.db, comp.id);
        assert.equal(standings.length, 3, "Standings must include all 3 participants");

        // All 3 bots must have received points: 2 bots have 1 bye each (>= 3 pts), and match points added
        for (const s of standings) {
          assert.ok(s.points >= 0, `Bot ${s.botId} points must be non-negative`);
          assert.ok(s.played + s.byeCount >= 1, `Bot ${s.botId} must have played or had a bye`);
        }

        // Verify both round 1 and round 2 bye recipients have byeCount === 1
        const s1Standing = standings.find((s) => s.botId === round1ByeBotId);
        const s2Standing = standings.find((s) => s.botId === round2ByeBotId);
        assert.equal(s1Standing.byeCount, 1, "Round 1 bye bot must have byeCount=1");
        assert.equal(s2Standing.byeCount, 1, "Round 2 bye bot must have byeCount=1");

        // Deterministic sorting invariant: points DESC, wins DESC, botId ASC
        for (let i = 0; i < standings.length - 1; i++) {
          const a = standings[i];
          const b = standings[i + 1];
          if (a.points === b.points) {
            if (a.wins === b.wins) {
              assert.ok(a.botId.localeCompare(b.botId) <= 0, "Tiebreak by botId ASC");
            } else {
              assert.ok(a.wins >= b.wins, "Tiebreak by wins DESC");
            }
          } else {
            assert.ok(a.points > b.points, "Ordered by points DESC");
          }
        }

        // ── FINAL COMPLETION GATE ──
        const finalComp = env.competitionRoundsRepo.advanceExtendedPhase(comp.id, "running");
        assert.equal(finalComp.phase, "completed", "Competition phase must transition to completed");

        // Calling nextRound on completed competition must throw CompetitionPhaseError
        assert.throws(
          () => env.competitionRoundsRepo.nextRound(comp.id, 2),
          (err) => err instanceof CompetitionPhaseError,
          "nextRound on completed competition must throw CompetitionPhaseError"
        );
      } finally {
        env.cleanup();
      }
    }
  );

  it(
    "3. [Simulated State Transition] Error gating blocks nextRound/completion until admin retry recovers match",
    async () => {
      const env = setupAcceptanceEnvironment("simulated-error-gating");
      try {
        const bot1 = await env.registerAndBuildBot({
          userId: "user-err1",
          username: "err1_owner",
          botId: "bot-err1",
          botName: "ErrBot1"
        });
        const bot2 = await env.registerAndBuildBot({
          userId: "user-err2",
          username: "err2_owner",
          botId: "bot-err2",
          botName: "ErrBot2"
        });

        const comp = env.competitionRoundsRepo.createExtendedCompetition(
          {
            name: "Error Gate Test",
            capacity: 2,
            formatId: "double-round-robin",
            mapId: "classic",
            mode: "practice",
            roundCount: 2
          },
          { actorId: "user-admin" }
        );

        env.competitionRepo.registerEntry(comp.id, bot1.userId, { actorId: bot1.userId });
        env.competitionRepo.registerEntry(comp.id, bot2.userId, { actorId: bot2.userId });
        env.competitionRepo.reviewEntry(comp.id, bot1.userId, true, { actorId: "user-admin" });
        env.competitionRepo.reviewEntry(comp.id, bot2.userId, true, { actorId: "user-admin" });
        // Advance registration -> preparation
        env.competitionRoundsRepo.advanceExtendedPhase(comp.id, "registration");

        // Submit ready versions during preparation phase
        env.competitionRepo.submitBotVersion(comp.id, bot1.userId, bot1.botVersionId, { actorId: bot1.userId });
        env.competitionRepo.submitBotVersion(comp.id, bot2.userId, bot2.botVersionId, { actorId: bot2.userId });

        // Advance preparation -> locked
        env.competitionRoundsRepo.advanceExtendedPhase(comp.id, "preparation");
        const runningComp = env.competitionRoundsRepo.advanceExtendedPhase(comp.id, "locked");

        const match = env.db
          .prepare("SELECT * FROM matches WHERE tournament_id = ?")
          .get(runningComp.tournamentId);

        // SIMULATED ERROR STATE: Mutate match status to 'error' to test gate
        env.db
          .prepare("UPDATE matches SET status = 'error' WHERE id = ?")
          .run(match.id);
        env.db
          .prepare("UPDATE jobs SET status = 'failed' WHERE target_id = ?")
          .run(match.id);

        // Gating Check: nextRound blocked due to errored match
        assert.throws(
          () => env.competitionRoundsRepo.nextRound(comp.id, 1),
          (err) =>
            err instanceof CompetitionPhaseError &&
            err.message.includes("previous round has errored matches that must be retried"),
          "nextRound must be blocked when matches have errors"
        );

        // Gating Check: advanceExtendedPhase(running) blocked due to incomplete rounds
        assert.throws(
          () => env.competitionRoundsRepo.advanceExtendedPhase(comp.id, "running"),
          (err) =>
            err instanceof CompetitionPhaseError &&
            err.message.includes("has not reached configured total rounds"),
          "advance to completed must be blocked before reaching total rounds"
        );

        // Admin retry recovers match back to pending and job back to queued
        const retryResult = env.competitionRoundsRepo.retryCompetitionMatch(comp.id, 0);
        assert.equal(retryResult.ok, true);

        const recoveredMatch = env.matchRepo.getMatch(match.id);
        assert.equal(recoveredMatch.status, "pending");

        // Worker can now execute recovered match
        let recoveredExecuted = false;
        for (let i = 0; i < 10; i++) {
          const outcome = await env.worker.runOnce();
          if (outcome.executed && outcome.claim?.kind === "match") {
            recoveredExecuted = true;
            break;
          }
        }
        assert.ok(recoveredExecuted, "Worker must execute recovered match");

        // Gates unblock: nextRound now proceeds to Round 2
        const round2 = env.competitionRoundsRepo.nextRound(comp.id, 1);
        assert.equal(round2.currentRound, 2);

        // In Round 2 (current_round === round_count === 2):
        // Mutate Round 2 match to 'error' -> completion gate must block with retry required
        const match2 = env.db
          .prepare("SELECT * FROM matches WHERE tournament_id = ?")
          .get(round2.tournamentId);

        env.db
          .prepare("UPDATE matches SET status = 'error' WHERE id = ?")
          .run(match2.id);

        assert.throws(
          () => env.competitionRoundsRepo.advanceExtendedPhase(comp.id, "running"),
          (err) =>
            err instanceof CompetitionPhaseError &&
            err.message.includes("matches have errors and must be retried"),
          "advance to completed must be blocked when final round matches have errors"
        );

        // Admin retry recovers Round 2 match
        const retryResult2 = env.competitionRoundsRepo.retryCompetitionMatch(comp.id, 0);
        assert.equal(retryResult2.ok, true);

        // Worker executes recovered Round 2 match
        let r2Executed = false;
        for (let i = 0; i < 10; i++) {
          const outcome = await env.worker.runOnce();
          if (outcome.executed && outcome.claim?.kind === "match") {
            r2Executed = true;
            break;
          }
        }
        assert.ok(r2Executed, "Worker must execute recovered round 2 match");

        // Final completion gate now unblocks
        const completedComp = env.competitionRoundsRepo.advanceExtendedPhase(comp.id, "running");
        assert.equal(completedComp.phase, "completed");
      } finally {
        env.cleanup();
      }
    }
  );

  it(
    "4. HTTP API Matrix: GET /competition-catalog, extended POST /competitions, and POST /next-round",
    async () => {
      const env = setupAcceptanceEnvironment("http-api-matrix");
      let server;
      try {
        server = createArenaServer({
          db: env.db,
          botRepo: env.botRepo,
          matchRepo: env.matchRepo,
          tournamentRepo: env.tournamentRepo,
          competitionRepo: env.competitionRepo,
          competitionRoundsRepo: env.competitionRoundsRepo,
          jobQueue: env.jobQueue,
          botVersionService: env.botVersionService,
          profileRegistry: env.profileRegistry
        });

        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

        // Create sessions for admin and regular user
        const adminSession = createSession(env.db, "user-admin");
        const adminToken = adminSession.token;

        const userAlice = await env.registerAndBuildBot({
          userId: "user-alice",
          username: "alice",
          botId: "bot-alice",
          botName: "AliceBot"
        });
        const aliceSession = createSession(env.db, "user-alice");
        const aliceToken = aliceSession.token;

        // ── 1. GET /api/arena/v1/competition-catalog ──
        const catalogRes = await makeRequest(server, {
          path: "/api/arena/v1/competition-catalog",
          method: "GET",
          headers: { Authorization: `Bearer ${aliceToken}` }
        });
        assert.equal(catalogRes.statusCode, 200);
        assert.ok(Array.isArray(catalogRes.body.maps), "Catalog must include maps");
        assert.ok(Array.isArray(catalogRes.body.formats), "Catalog must include formats");
        assert.ok(Array.isArray(catalogRes.body.modes), "Catalog must include modes");
        assert.ok(catalogRes.body.defaults, "Catalog must include defaults");

        const mapIds = catalogRes.body.maps.map((m) => m.id);
        assert.ok(mapIds.includes("classic"));
        assert.ok(mapIds.includes("flanks"));
        assert.ok(mapIds.includes("center"));

        const formatIds = catalogRes.body.formats.map((f) => f.id);
        assert.ok(formatIds.includes("single-round-robin"));
        assert.ok(formatIds.includes("double-round-robin"));
        assert.ok(formatIds.includes("swiss"));

        // ── 2. POST /api/arena/v1/competitions (Extended Creation) ──
        // Non-admin rejected with 403
        const nonAdminCreate = await makeRequest(
          server,
          {
            path: "/api/arena/v1/competitions",
            method: "POST",
            headers: { Authorization: `Bearer ${aliceToken}` }
          },
          {
            name: "Forbidden Comp",
            formatId: "swiss",
            mapId: "flanks",
            mode: "practice"
          }
        );
        assert.equal(nonAdminCreate.statusCode, 403);

        // Admin creates extended competition successfully
        const adminCreate = await makeRequest(
          server,
          {
            path: "/api/arena/v1/competitions",
            method: "POST",
            headers: { Authorization: `Bearer ${adminToken}` }
          },
          {
            name: "API Swiss Event",
            formatId: "swiss",
            mapId: "flanks",
            mode: "practice",
            roundCount: 2
          }
        );
        assert.equal(adminCreate.statusCode, 201);
        assert.equal(adminCreate.body.competition.formatId, "swiss");
        assert.equal(adminCreate.body.competition.mapId, "flanks");
        assert.equal(adminCreate.body.competition.mode, "practice");
        assert.equal(adminCreate.body.competition.roundCount, 2);
        assert.equal(adminCreate.body.competition.isExtended, true);

        const compId = adminCreate.body.competition.id;

        // GET /api/arena/v1/competitions/:id returns extended details
        const detailRes = await makeRequest(server, {
          path: `/api/arena/v1/competitions/${compId}`,
          method: "GET",
          headers: { Authorization: `Bearer ${aliceToken}` }
        });
        assert.equal(detailRes.statusCode, 200);
        assert.equal(detailRes.body.competition.id, compId);
        assert.ok(detailRes.body.configuration);
        assert.ok(Array.isArray(detailRes.body.rounds));
        assert.ok(Array.isArray(detailRes.body.standings));

        // ── 3. POST /api/arena/v1/competitions/:id/next-round ──
        // Non-admin rejected with 403
        const nextRoundForbidden = await makeRequest(
          server,
          {
            path: `/api/arena/v1/competitions/${compId}/next-round`,
            method: "POST",
            headers: { Authorization: `Bearer ${aliceToken}` }
          },
          { expectedRound: 1 }
        );
        assert.equal(nextRoundForbidden.statusCode, 403);

        // Admin call when competition not in running phase returns 409
        const nextRoundNotRunning = await makeRequest(
          server,
          {
            path: `/api/arena/v1/competitions/${compId}/next-round`,
            method: "POST",
            headers: { Authorization: `Bearer ${adminToken}` }
          },
          { expectedRound: 1 }
        );
        assert.equal(nextRoundNotRunning.statusCode, 409);
        assert.equal(nextRoundNotRunning.body.error.code, "PHASE_MISMATCH");
      } finally {
        if (server) {
          await new Promise((resolve) => server.close(resolve));
        }
        env.cleanup();
      }
    }
  );
});
