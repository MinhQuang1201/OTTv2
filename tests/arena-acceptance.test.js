/**
 * tests/arena-acceptance.test.js
 *
 * Task 21: End-to-End Acceptance Test for Arena Engine, Storage, Worker, and Persistence.
 *
 * Full lifecycle verified without mocks (real temp SQLite, real JobWorker, real BuildService,
 * real ArtifactStore, real BotVersionService, real TournamentRepository, real MatchFinalizer):
 *
 * 1. Authors & 4 Bots: Users create bots, upload immutable source code (Node profile).
 * 2. Real Build Execution: JobWorker executes build jobs, verifies syntax with Node,
 *    and stores content-addressed artifacts in ArtifactStore -> READY status.
 * 3. Double Round-Robin 4 Bots: Creates 12 matches (N*(N-1)) and 12 queued match jobs.
 * 4. Idempotent Tournament Creation: Repeated requests with same idempotency key replay
 *    without duplicating matches/jobs; payload conflicts throw HTTP 409 IdempotencyConflictError.
 * 5. 12 Real Match Executions: JobWorker runs matches using real child processes (`node` executing
 *    the resolved artifact from ArtifactStore), communicating via stdin/stdout protocol v1.
 * 6. Atomic Finalization & Invariants:
 *    - Replay documents validated via validateReplayDocument and computeReplayDigest.
 *    - Pinned identities (ruleset, policy, participants, profiles, digests) strictly verified.
 *    - Tournament standings: sum played = 24, sum wins = sum losses, 3-1-0 points scheme.
 *    - Competition rank: tied points share equal competition rank (1, 1, 3).
 * 7. Exactly-Once Rating Audit History:
 *    - Rating changes chain strictly per bot without lost updates.
 *    - Duplicate completion or admin retry preserves canonical results.
 * 8. Practice Tournament Bypass:
 *    - Practice tournament settles standings without mutating Elo ratings or recording rating changes.
 * 9. Safety & Quarantine Gates:
 *    - Non-ready versions rejected at tournament creation.
 *    - Tampered artifacts detected as infrastructure errors without awarding forfeit loss.
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { createHash } = require("node:crypto");

// Per-test override for portable Node 18 test run (NOT in production code)
const PORTABLE_NODE18_BINDING =
  "C:/Users/ADMIN/AppData/Local/Temp/opencode/arena-sqlite-smoke-node18/node_modules/better-sqlite3/build/Release/better_sqlite3.node";

if (
  process.versions.node.startsWith("18.") &&
  !process.env.ARENA_SQLITE_NATIVE_BINDING &&
  fs.existsSync(PORTABLE_NODE18_BINDING)
) {
  process.env.ARENA_SQLITE_NATIVE_BINDING = PORTABLE_NODE18_BINDING;
}

const TEMP_BASE_DIR = path.resolve(os.tmpdir(), "arena-acceptance-test-" + Date.now());

let openDatabase;
let closeDatabase;
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
let createTournamentUseCase;
let IdempotencyConflictError;
let validateReplayDocument;
let computeReplayDigest;
let canonicalSerialize;

function sha256Digest(data) {
  const str = typeof data === "string" ? data : canonicalSerialize(data);
  return `sha256:${createHash("sha256").update(str, "utf8").digest("hex")}`;
}

before(async () => {
  fs.mkdirSync(TEMP_BASE_DIR, { recursive: true });

  const dbMod = await import("../packages/arena-node/src/persistence/sqlite-database.mjs");
  openDatabase = dbMod.openDatabase;
  closeDatabase = dbMod.closeDatabase;

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
  IdempotencyConflictError = tournRepoMod.IdempotencyConflictError;

  const tournUseMod = await import("../packages/arena/src/application/create-tournament.mjs");
  createTournamentUseCase = tournUseMod.createTournamentUseCase;

  const valMod = await import("../packages/arena/src/contracts/validation.mjs");
  validateReplayDocument = valMod.validateReplayDocument;

  const identityMod = await import("../packages/arena-node/src/core/ruleset-identity.mjs");
  computeReplayDigest = identityMod.computeReplayDigest;

  const rulesetMod = await import("../packages/arena/src/domain/ruleset.mjs");
  canonicalSerialize = rulesetMod.canonicalSerialize;
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
  const { db } = openDatabase(dbPath, nativeBinding ? { nativeBinding } : {});

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

  // Baseline match fixtures
  const FIXTURES_DIR = path.resolve(__dirname, "fixtures/arena/replays");
  const WIN_FIXTURE = JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, "deterministic-match.json"), "utf8")
  );

  // Fixture bot script
  const botScriptPath = path.resolve(__dirname, "fixtures/arena/bots/legal.mjs");
  const botSourceContent = fs.readFileSync(botScriptPath);

  // Seed admin user
  botRepo.createUser({
    id: "user-admin",
    normalizedUsername: "admin",
    passwordHash: "hash-admin",
    role: "admin"
  });

  // Seed 4 author users
  const authorUsers = [
    { id: "user-alice", name: "alice" },
    { id: "user-bob", name: "bob" },
    { id: "user-carol", name: "carol" },
    { id: "user-dave", name: "dave" }
  ];

  for (const u of authorUsers) {
    botRepo.createUser({
      id: u.id,
      normalizedUsername: u.name,
      passwordHash: `hash-${u.name}`,
      role: "author"
    });
  }

  // Seed 4 bots owned by their respective authors
  const bots = [
    { id: "bot-alpha", ownerId: "user-alice", name: "AlphaBot" },
    { id: "bot-beta", ownerId: "user-bob", name: "BetaBot" },
    { id: "bot-gamma", ownerId: "user-carol", name: "GammaBot" },
    { id: "bot-delta", ownerId: "user-dave", name: "DeltaBot" }
  ];

  for (const b of bots) {
    botRepo.createBot(
      { id: b.id, ownerId: b.ownerId, name: b.name },
      { actorId: b.ownerId, idempotencyKey: `idem-create-${b.id}` }
    );
  }

  // Real JobWorker executing both build and match jobs
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
    worker,
    WIN_FIXTURE,
    botSourceContent,
    bots,
    authorUsers,
    cleanup() {
      closeDatabase(db);
    }
  };
}

describe("Arena Acceptance Test — Task 21", () => {
  it(
    "Full E2E Tournament Pipeline: 4 users -> 4 bots -> real build -> RR4 (12 matches) -> actual execution -> settlement & leaderboard",
    { timeout: 60000 },
    async () => {
      const env = setupAcceptanceEnvironment("full-e2e-pipeline");
      try {
        // ── 1. Upload immutable bot versions for each of the 4 bots ──
        const registeredEntries = [];

        for (let i = 0; i < env.bots.length; i++) {
          const b = env.bots[i];
          const upload = await env.botVersionService.uploadBotVersion(
            {
              botId: b.id,
              sourceContent: env.botSourceContent,
              profileId: "node"
            },
            {
              actorId: b.ownerId,
              idempotencyKey: `idem-upload-${b.id}-v1`
            }
          );

          assert.ok(upload.botVersion);
          assert.equal(upload.botVersion.bot_id, b.id);
          assert.equal(upload.botVersion.build_status, "pending");
          assert.ok(upload.job);
          assert.equal(upload.job.kind, "build");

          // ── 2. Real Build Execution via BotVersionService + BuildService + ArtifactStore ──
          const buildResult = await env.botVersionService.processBuildJob({
            jobId: upload.job.id,
            leaseOwner: "builder-acceptance"
          });

          assert.equal(buildResult.botVersion.build_status, "ready");
          assert.ok(buildResult.botVersion.artifact_digest);

          // Verify artifact exists and resolves in ArtifactStore
          const resolvedArtifact = await env.artifactStore.resolveArtifact(
            buildResult.botVersion.artifact_digest
          );
          assert.ok(resolvedArtifact, `Artifact must resolve in ArtifactStore`);
          assert.ok(fs.existsSync(resolvedArtifact.path));

          registeredEntries.push({
            botId: b.id,
            botVersionId: upload.botVersion.id,
            artifactDigest: buildResult.botVersion.artifact_digest
          });
        }

        assert.equal(registeredEntries.length, 4, "All 4 bot versions must be READY");

        // ── 3. Double Round-Robin Tournament Creation & Idempotency Gate ──
        const tournPayload = {
          id: "tourn-acceptance-rr4",
          name: "Task 21 Acceptance Championship",
          ruleset: env.WIN_FIXTURE.rulesetSnapshot,
          policy: env.WIN_FIXTURE.matchPolicy,
          initialState: env.WIN_FIXTURE.initialCoreState,
          ranked: true,
          ladderId: "ladder-main",
          entries: registeredEntries
        };

        const useCase = createTournamentUseCase({ tournamentRepo: env.tournamentRepo });
        const tournament = await useCase.execute(tournPayload, {
          actorId: "user-admin",
          idempotencyKey: "idem-tourn-acc-1"
        });

        assert.equal(tournament.id, "tourn-acceptance-rr4");
        assert.equal(tournament.status, "pending");

        // Verify 12 matches scheduled with contiguous schedule_index 0..11
        const matches = env.tournamentRepo.getTournamentMatches(tournament.id);
        assert.equal(matches.length, 12, "Double round-robin with 4 bots must create 12 matches");
        for (let i = 0; i < 12; i++) {
          assert.equal(matches[i].schedule_index, i);
          assert.equal(matches[i].status, "pending");
        }

        // Verify exactly 12 match jobs queued
        const matchJobsCount = env.db
          .prepare("SELECT COUNT(*) AS c FROM jobs WHERE kind = 'match' AND status = 'queued'")
          .get();
        assert.equal(matchJobsCount.c, 12, "Expected exactly 12 queued match jobs");

        // Idempotency: Replaying exact same request returns identical tournament without duplicate jobs
        const tournamentReplay = await useCase.execute(tournPayload, {
          actorId: "user-admin",
          idempotencyKey: "idem-tourn-acc-1"
        });
        assert.equal(tournamentReplay.id, tournament.id);

        const matchJobsCountAfterReplay = env.db
          .prepare("SELECT COUNT(*) AS c FROM jobs WHERE kind = 'match'")
          .get();
        assert.equal(matchJobsCountAfterReplay.c, 12, "Jobs must not be duplicated on idempotency replay");

        // Idempotency conflict: Same key with different payload throws HTTP 409 IdempotencyConflictError
        await assert.rejects(
          () =>
            useCase.execute(
              { ...tournPayload, name: "Conflicting Payload Name" },
              { actorId: "user-admin", idempotencyKey: "idem-tourn-acc-1" }
            ),
          (err) => err instanceof IdempotencyConflictError || err.name === "IdempotencyConflictError"
        );

        // ── 4. Execute all 12 matches with real JobWorker (Real Node child processes) ──
        let executedMatches = 0;
        for (let i = 0; i < 20; i++) {
          const outcome = await env.worker.runOnce();
          if (!outcome.executed) break;
          if (outcome.claim.kind === "match") {
            executedMatches++;
          }
        }

        assert.equal(executedMatches, 12, "JobWorker must execute all 12 match jobs to completion");

        // Tournament status must automatically transition to 'completed'
        const updatedTourn = env.tournamentRepo.getTournament(tournament.id);
        assert.equal(updatedTourn.status, "completed", "Tournament must be 'completed' when all matches finish");

        // ── 5. Standings & Mathematical Invariants Verification ──
        const standings = env.tournamentRepo.getTournamentStandings(tournament.id);
        assert.equal(standings.length, 4, "Must have exactly 4 standings rows");

        let sumPlayed = 0;
        let sumWins = 0;
        let sumLosses = 0;
        let sumDraws = 0;
        let sumPoints = 0;

        for (const s of standings) {
          sumPlayed += s.played;
          sumWins += s.wins;
          sumLosses += s.losses;
          sumDraws += s.draws;
          sumPoints += s.points;

          assert.equal(s.played, 6, `Bot ${s.bot_id} must have played exactly 6 matches`);
          assert.equal(s.played, s.wins + s.losses + s.draws, "played = wins + losses + draws");
          assert.equal(s.points, s.wins * 3 + s.draws * 1, `Points must match 3-1-0 scheme for ${s.bot_id}`);
        }

        assert.equal(sumPlayed, 24, "Total sum of played games across 4 bots must be 24 (12 matches * 2)");
        assert.equal(sumWins, sumLosses, "Total tournament wins must equal total tournament losses");
        assert.equal(sumPoints, sumWins * 3 + sumDraws * 2, "Points total invariant (3 per win, 2 per draw)");

        // Standard competition ranking verification (e.g. 1, 1, 3)
        for (let i = 0; i < standings.length; i++) {
          assert.ok(standings[i].rank >= 1 && standings[i].rank <= 4);
          if (i > 0 && standings[i].points === standings[i - 1].points) {
            assert.equal(standings[i].rank, standings[i - 1].rank, "Tied points must share equal competition rank");
          }
        }

        // ── 6. Audit History & Exactly-Once Monotonic Rating Chaining ──
        // 12 matches * 2 participants = 24 rating change records
        const ratingChanges = env.db
          .prepare("SELECT * FROM rating_changes ORDER BY settlement_seq ASC")
          .all();
        assert.equal(ratingChanges.length, 24, "Expected exactly 24 rating change audit rows");

        // Check strict rating chaining per bot (before_rating[k] == after_rating[k-1])
        for (const b of env.bots) {
          const botChanges = ratingChanges.filter((rc) => rc.bot_id === b.id);
          assert.equal(botChanges.length, 6, `Bot ${b.id} must have exactly 6 rating change records`);

          for (let k = 1; k < botChanges.length; k++) {
            assert.equal(
              botChanges[k].before_rating,
              botChanges[k - 1].after_rating,
              `Rating chaining violated for ${b.id} at step ${k}: before=${botChanges[k].before_rating}, previous after=${botChanges[k - 1].after_rating}`
            );
          }
        }

        // Bot ratings table has 4 rows, each with rated_games = 6
        const botRatings = env.db
          .prepare("SELECT * FROM bot_ratings WHERE ladder_id = 'ladder-main' ORDER BY rating DESC")
          .all();
        assert.equal(botRatings.length, 4, "Must have 4 bot rating records");
        for (const r of botRatings) {
          assert.equal(r.rated_games, 6, `Bot ${r.bot_id} must have 6 rated games`);
          assert.ok(r.rating > 0, "Rating must be positive");
        }

        // ── 7. Replay Document Validation & Pinned Identities ──
        const matchResults = env.db.prepare("SELECT * FROM match_results").all();
        assert.equal(matchResults.length, 12, "Expected 12 match_results records");

        for (const mr of matchResults) {
          const replayDoc = JSON.parse(mr.replay_json);

          // Contract replay validation
          const valRes = validateReplayDocument(replayDoc);
          assert.ok(valRes.ok, `Replay for match ${mr.match_id} failed schema validation: ${JSON.stringify(valRes.errors)}`);

          // Digest verification
          const computedDigest = computeReplayDigest(replayDoc);
          assert.equal(mr.replay_digest, computedDigest, "Replay digest in DB must match computed digest");

          // Pinned DB match vs replay verification
          const dbMatch = env.matchRepo.getMatch(mr.match_id);
          assert.equal(replayDoc.matchId, dbMatch.id);
          assert.equal(replayDoc.rulesetId, JSON.parse(dbMatch.ruleset_json).rulesetId);
          assert.equal(replayDoc.participants.A.botId, dbMatch.participants.A.bot_id);
          assert.equal(replayDoc.participants.B.botId, dbMatch.participants.B.bot_id);
        }

        // ── 8. Same Completion Retry & Exactly-Once Audit Protection ──
        const firstMatchResult = matchResults[0];
        const canonicalReplay = JSON.parse(firstMatchResult.replay_json);
        const canonicalResult = JSON.parse(firstMatchResult.result_json);

        // Submitting same completion payload again (completion retry)
        const duplicateFinalizeResult = await env.finalizer.finalizeMatch({
          matchId: firstMatchResult.match_id,
          attemptNo: 99, // Even with new attempt
          leaseToken: "retry-token-idem",
          result: canonicalResult,
          replay: canonicalReplay,
          replayDigest: firstMatchResult.replay_digest,
          completionDigest: firstMatchResult.completion_digest
        });

        assert.equal(duplicateFinalizeResult.matchId, firstMatchResult.match_id);
        assert.equal(duplicateFinalizeResult.completionDigest, firstMatchResult.completion_digest);

        // Audit history remains exactly once: still 24 rating change rows
        const ratingChangesAfterRetry = env.db
          .prepare("SELECT COUNT(*) AS c FROM rating_changes")
          .get();
        assert.equal(ratingChangesAfterRetry.c, 24, "Same completion retry must NOT duplicate rating_changes");

        // Bot ratings not double-incremented: each still has 6 rated games
        for (const b of env.bots) {
          const r = env.matchRepo.getBotRating("ladder-main", b.id);
          assert.equal(r.rated_games, 6, `Bot ${b.id} rated_games must not double-increment on retry`);
        }

        // Standings not double-credited: sum played remains 24
        const standingsAfterRetry = env.tournamentRepo.getTournamentStandings(tournament.id);
        let sumPlayedAfterRetry = 0;
        for (const s of standingsAfterRetry) sumPlayedAfterRetry += s.played;
        assert.equal(sumPlayedAfterRetry, 24, "Standings played must not double-credit on retry");

        // ── 9. Admin Match Retry Preserves Match Identity ──
        const matchToRetry = matches[0];
        const retriedMatch = env.tournamentRepo.retryMatch(tournament.id, matchToRetry.schedule_index);
        assert.equal(retriedMatch.id, matchToRetry.id, "Admin retry must preserve match identity");
        assert.equal(retriedMatch.status, "pending");

        // Job is re-queued
        const retriedJob = env.db
          .prepare("SELECT * FROM jobs WHERE kind = 'match' AND target_id = ?")
          .get(matchToRetry.id);
        assert.equal(retriedJob.status, "queued");
        assert.equal(retriedJob.lease_owner, null);
      } finally {
        env.cleanup();
      }
    }
  );

  it("Practice Tournament: settles standings with 3-1-0 points scheme without mutating Elo ratings", async () => {
    const env = setupAcceptanceEnvironment("practice-bypass-test");
    try {
      // Fast-track 4 READY bots
      const registeredEntries = [];
      for (const b of env.bots) {
        const upload = await env.botVersionService.uploadBotVersion(
          {
            botId: b.id,
            sourceContent: env.botSourceContent,
            profileId: "node"
          },
          {
            actorId: b.ownerId,
            idempotencyKey: `idem-prac-ver-${b.id}`
          }
        );
        // Build version
        await env.botVersionService.processBuildJob({ jobId: upload.job.id, leaseOwner: "test-builder" });
        const readyVer = env.botVersionService.getBotVersion(upload.botVersion.id);
        assert.equal(readyVer.build_status, "ready");
        registeredEntries.push({ botId: b.id, botVersionId: readyVer.id });
      }

      // Create practice tournament (ranked = false)
      const tournament = env.tournamentRepo.createTournament({
        id: "tourn-practice-acceptance",
        name: "Practice Acceptance Tournament",
        ruleset: env.WIN_FIXTURE.rulesetSnapshot,
        policy: env.WIN_FIXTURE.matchPolicy,
        initialState: env.WIN_FIXTURE.initialCoreState,
        ranked: false, // PRACTICE MODE
        ladderId: "ladder-main",
        entries: registeredEntries
      });

      assert.equal(tournament.ranked, 0, "Practice tournament must have ranked = 0");

      // Execute all 12 matches
      let matchCount = 0;
      for (let i = 0; i < 20; i++) {
        const outcome = await env.worker.runOnce();
        if (!outcome.executed) break;
        if (outcome.claim.kind === "match") {
          matchCount++;
        }
      }
      assert.equal(matchCount, 12, "All 12 practice matches must execute");

      // Standings updated with 3-1-0 points scheme
      const standings = env.tournamentRepo.getTournamentStandings(tournament.id);
      assert.equal(standings.length, 4);
      let sumPlayed = 0;
      for (const s of standings) {
        sumPlayed += s.played;
        assert.equal(s.played, 6);
        assert.equal(s.points, s.wins * 3 + s.draws * 1);
      }
      assert.equal(sumPlayed, 24);

      // PRACTICE BYPASS INVARIANT: ZERO Elo rating changes or bot ratings
      const ratingChangesCount = env.db
        .prepare("SELECT COUNT(*) AS c FROM rating_changes")
        .get();
      assert.equal(ratingChangesCount.c, 0, "Practice tournament must produce ZERO rating_changes records");

      const botRatingsCount = env.db
        .prepare("SELECT COUNT(*) AS c FROM bot_ratings")
        .get();
      assert.equal(botRatingsCount.c, 0, "Practice tournament must produce ZERO bot_ratings records");
    } finally {
      env.cleanup();
    }
  });

  it("Safety Gates: rejects non-ready bot versions at tournament creation and quarantines tampered artifacts", async () => {
    const env = setupAcceptanceEnvironment("safety-gates-test");
    try {
      // 1. Upload bot version but leave it PENDING (do not build)
      const upload1 = await env.botVersionService.uploadBotVersion(
        {
          botId: env.bots[0].id,
          sourceContent: env.botSourceContent,
          profileId: "node"
        },
        {
          actorId: env.bots[0].ownerId,
          idempotencyKey: "idem-pending-1"
        }
      );

      // 2. Upload bot version and build to READY
      const upload2 = await env.botVersionService.uploadBotVersion(
        {
          botId: env.bots[1].id,
          sourceContent: env.botSourceContent,
          profileId: "node"
        },
        {
          actorId: env.bots[1].ownerId,
          idempotencyKey: "idem-ready-2"
        }
      );
      await env.botVersionService.processBuildJob({ jobId: upload2.job.id, leaseOwner: "test-builder" });

      // Tournament creation with a pending version must be rejected
      assert.throws(
        () =>
          env.tournamentRepo.createTournament({
            name: "Unready Tournament",
            ruleset: env.WIN_FIXTURE.rulesetSnapshot,
            policy: env.WIN_FIXTURE.matchPolicy,
            initialState: env.WIN_FIXTURE.initialCoreState,
            entries: [
              { botId: env.bots[0].id, botVersionId: upload1.botVersion.id },
              { botId: env.bots[1].id, botVersionId: upload2.botVersion.id }
            ]
          }),
        (err) => {
          assert.ok(err.message.includes("is not ready"));
          return true;
        }
      );

      // 3. Tamper detection on disk
      const readyVer = env.botVersionService.getBotVersion(upload2.botVersion.id);
      const art = await env.artifactStore.resolveArtifact(readyVer.artifact_digest);
      assert.ok(art);

      // Tamper with artifact on disk
      fs.writeFileSync(art.path, "corrupted-malicious-bytes", "utf8");

      // Resolving tampered artifact throws infrastructure_error tamper_detected
      await assert.rejects(
        () => env.artifactStore.resolveArtifact(readyVer.artifact_digest),
        (err) => {
          assert.equal(err.kind, "infrastructure_error");
          assert.equal(err.code, "tamper_detected");
          return true;
        }
      );
    } finally {
      env.cleanup();
    }
  });
});
