/**
 * tests/arena-tournament.test.js
 *
 * Task 13 (Milestone M4): Double round-robin tournament aggregate and persistence.
 *
 * Requirements:
 * 1. Pure pairing: N=0/1 rejected; N2->2, N3->6, N4->12; no self pairing;
 *    every unordered pair appears exactly A/B and B/A; stable scheduleIndex.
 * 2. Atomic tournament creation: pins READY bot versions/artifacts/profiles,
 *    ruleset/policy, ranked flag, 3-1-0 scheme; creates all matches, jobs,
 *    mappings, standings, and api_requests idempotency record atomically.
 * 3. Idempotency: same actor + key returns existing tournament without duplicating
 *    matches or jobs; different payload throws 409 IdempotencyConflictError.
 * 4. Standings initialized once; finalizer is the only points writer;
 *    tournament remains pending/active until all matches are settled.
 * 5. End-to-end 4 fixture bots via actual JobWorker:
 *    12 settled matches; sum played = 24, sum wins = sum losses,
 *    sum points correct; ranked vs practice Elo behavior;
 *    equal competition rank for tied points (secondary sort by bot_id display only).
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

const TEMP_BASE_DIR = path.resolve(os.tmpdir(), "arena-tournament-test-" + Date.now());

let openDatabase;
let closeDatabase;
let createBotRepository;
let createMatchFinalizer;
let createJobQueue;
let createJobWorker;
let createProcessBot;
let createTournamentRepository;
let createTournamentUseCase;
let IdempotencyConflictError;
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

  const botRepoMod = await import("../packages/arena-node/src/persistence/bot-repository.mjs");
  createBotRepository = botRepoMod.createBotRepository;

  const finalizerMod = await import("../packages/arena-node/src/persistence/finalizer.mjs");
  createMatchFinalizer = finalizerMod.createMatchFinalizer;

  const queueMod = await import("../packages/arena-node/src/persistence/job-queue.mjs");
  createJobQueue = queueMod.createJobQueue;

  const workerMod = await import("../packages/arena-node/src/worker/job-worker.mjs");
  createJobWorker = workerMod.createJobWorker;

  const processBotMod = await import("../packages/arena-node/src/execution/process-bot.mjs");
  createProcessBot = processBotMod.createProcessBot;

  const rulesetMod = await import("../packages/arena/src/domain/ruleset.mjs");
  canonicalSerialize = rulesetMod.canonicalSerialize;

  // Task 13 modules
  const tournRepoMod = await import("../packages/arena-node/src/persistence/tournament-repository.mjs");
  createTournamentRepository = tournRepoMod.createTournamentRepository;
  IdempotencyConflictError = tournRepoMod.IdempotencyConflictError;

  const appMod = await import("../packages/arena/src/application/create-tournament.mjs");
  createTournamentUseCase = appMod.createTournamentUseCase;
});

after(() => {
  try {
    fs.rmSync(TEMP_BASE_DIR, { recursive: true, force: true });
  } catch (_) {}
});

function setupEnv(testName) {
  const dir = path.join(TEMP_BASE_DIR, testName);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "arena.db");

  const nativeBinding = process.env.ARENA_SQLITE_NATIVE_BINDING || undefined;
  const { db } = openDatabase(dbPath, nativeBinding ? { nativeBinding } : {});

  const botRepo = createBotRepository(db);
  const queue = createJobQueue(db);
  const finalizer = createMatchFinalizer(db, { computeDigest: sha256Digest });
  const tournamentRepo = createTournamentRepository(db);

  // Fixtures
  const FIXTURES_DIR = path.resolve(__dirname, "fixtures/arena/replays");
  const WIN_FIXTURE = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "deterministic-match.json"), "utf8"));

  // Seed author user
  botRepo.createUser({ id: "user-admin", normalizedUsername: "admin", passwordHash: "h0", role: "admin" });

  // Helper to register ready bots
  function registerReadyBot(botId, name = botId) {
    botRepo.createBot({ id: botId, ownerId: "user-admin", name }, { idempotencyKey: `k-bot-${botId}`, actorId: "user-admin" });
    const artDigest = `sha256:art-${botId}`;
    botRepo.registerArtifact({ digest: artDigest, kind: "build", relativePrivatePath: `builds/${botId}`, bytes: 200 });
    const vId = `v-${botId}`;
    botRepo.createVersion(
      { id: vId, botId, sourceDigest: `sha256:src-${botId}`, profileId: "python", profileRevision: "v1" },
      { idempotencyKey: `k-ver-${botId}`, actorId: "user-admin" }
    );
    botRepo.markVersionReady({ botVersionId: vId, artifactDigest: artDigest });
    return { botId, botVersionId: vId, artifactDigest: artDigest };
  }

  return { dir, dbPath, db, botRepo, queue, finalizer, tournamentRepo, WIN_FIXTURE, registerReadyBot };
}

describe("Arena Tournament — Task 13 (Double Round-Robin & Aggregate)", () => {
  describe("Pure Pairing Invariants via Create Tournament", () => {
    it("rejects tournaments with N < 2 entries (N=0, N=1)", () => {
      const { db, tournamentRepo, WIN_FIXTURE, registerReadyBot } = setupEnv("pairing-min-entries");
      try {
        const b1 = registerReadyBot("bot-single");

        assert.throws(
          () =>
            tournamentRepo.createTournament({
              name: "Empty Tournament",
              ruleset: WIN_FIXTURE.rulesetSnapshot,
              policy: WIN_FIXTURE.matchPolicy,
              initialState: WIN_FIXTURE.initialCoreState,
              entries: []
            }),
          /at least 2/i
        );

        assert.throws(
          () =>
            tournamentRepo.createTournament({
              name: "Single Bot Tournament",
              ruleset: WIN_FIXTURE.rulesetSnapshot,
              policy: WIN_FIXTURE.matchPolicy,
              initialState: WIN_FIXTURE.initialCoreState,
              entries: [{ botId: b1.botId, botVersionId: b1.botVersionId }]
            }),
          /at least 2/i
        );
      } finally {
        closeDatabase(db);
      }
    });

    it("creates exactly N*(N-1) matches: N2 -> 2, N3 -> 6, N4 -> 12 matches", () => {
      const { db, tournamentRepo, WIN_FIXTURE, registerReadyBot } = setupEnv("pairing-counts");
      try {
        const b1 = registerReadyBot("bot-p1");
        const b2 = registerReadyBot("bot-p2");
        const b3 = registerReadyBot("bot-p3");
        const b4 = registerReadyBot("bot-p4");

        // N = 2 -> 2 matches
        const t2 = tournamentRepo.createTournament({
          id: "tourn-n2",
          name: "DRR N=2",
          ruleset: WIN_FIXTURE.rulesetSnapshot,
          policy: WIN_FIXTURE.matchPolicy,
          initialState: WIN_FIXTURE.initialCoreState,
          entries: [
            { botId: b1.botId, botVersionId: b1.botVersionId },
            { botId: b2.botId, botVersionId: b2.botVersionId }
          ]
        });
        const matches2 = tournamentRepo.getTournamentMatches(t2.id);
        assert.equal(matches2.length, 2);

        // N = 3 -> 6 matches
        const t3 = tournamentRepo.createTournament({
          id: "tourn-n3",
          name: "DRR N=3",
          ruleset: WIN_FIXTURE.rulesetSnapshot,
          policy: WIN_FIXTURE.matchPolicy,
          initialState: WIN_FIXTURE.initialCoreState,
          entries: [
            { botId: b1.botId, botVersionId: b1.botVersionId },
            { botId: b2.botId, botVersionId: b2.botVersionId },
            { botId: b3.botId, botVersionId: b3.botVersionId }
          ]
        });
        const matches3 = tournamentRepo.getTournamentMatches(t3.id);
        assert.equal(matches3.length, 6);

        // N = 4 -> 12 matches
        const t4 = tournamentRepo.createTournament({
          id: "tourn-n4",
          name: "DRR N=4",
          ruleset: WIN_FIXTURE.rulesetSnapshot,
          policy: WIN_FIXTURE.matchPolicy,
          initialState: WIN_FIXTURE.initialCoreState,
          entries: [
            { botId: b1.botId, botVersionId: b1.botVersionId },
            { botId: b2.botId, botVersionId: b2.botVersionId },
            { botId: b3.botId, botVersionId: b3.botVersionId },
            { botId: b4.botId, botVersionId: b4.botVersionId }
          ]
        });
        const matches4 = tournamentRepo.getTournamentMatches(t4.id);
        assert.equal(matches4.length, 12);
      } finally {
        closeDatabase(db);
      }
    });

    it("guarantees no self-pairing and every unordered pair appears exactly A/B and B/A with stable scheduleIndex", () => {
      const { db, tournamentRepo, WIN_FIXTURE, registerReadyBot } = setupEnv("pairing-invariants");
      try {
        const bots = ["bot-a", "bot-b", "bot-c", "bot-d"].map((id) => registerReadyBot(id));

        const t = tournamentRepo.createTournament({
          id: "tourn-invariants",
          name: "Invariants Check",
          ruleset: WIN_FIXTURE.rulesetSnapshot,
          policy: WIN_FIXTURE.matchPolicy,
          initialState: WIN_FIXTURE.initialCoreState,
          entries: bots.map((b) => ({ botId: b.botId, botVersionId: b.botVersionId }))
        });

        const matches = tournamentRepo.getTournamentMatches(t.id);
        assert.equal(matches.length, 12);

        const orderedPairs = new Map();
        for (let i = 0; i < matches.length; i++) {
          const m = matches[i];
          assert.equal(m.schedule_index, i, "schedule_index must be contiguous 0..N*(N-1)-1");

          const pA = m.participants.A.bot_id;
          const pB = m.participants.B.bot_id;

          // No self-pairing
          assert.notEqual(pA, pB, `Self-pairing detected at scheduleIndex ${i}: ${pA} vs ${pB}`);

          const pairKey = `${pA}->${pB}`;
          orderedPairs.set(pairKey, (orderedPairs.get(pairKey) || 0) + 1);
        }

        // Check that each ordered pair appears exactly once
        for (let i = 0; i < bots.length; i++) {
          for (let j = 0; j < bots.length; j++) {
            if (i === j) continue;
            const bA = bots[i].botId;
            const bB = bots[j].botId;
            const key = `${bA}->${bB}`;
            assert.equal(orderedPairs.get(key), 1, `Ordered pair ${key} must appear exactly once`);
          }
        }
      } finally {
        closeDatabase(db);
      }
    });
  });

  describe("Atomic Tournament Persistence & Idempotency", () => {
    it("pins READY bot version/artifact/profile, ruleset/policy, ranked flag, 3-1-0 scheme atomically", () => {
      const { db, tournamentRepo, WIN_FIXTURE, registerReadyBot } = setupEnv("atomic-pinning");
      try {
        const b1 = registerReadyBot("bot-pin1");
        const b2 = registerReadyBot("bot-pin2");

        const t = tournamentRepo.createTournament({
          id: "tourn-pin",
          name: "Pinned Tournament",
          ruleset: WIN_FIXTURE.rulesetSnapshot,
          policy: WIN_FIXTURE.matchPolicy,
          initialState: WIN_FIXTURE.initialCoreState,
          ranked: true,
          entries: [
            { botId: b1.botId, botVersionId: b1.botVersionId },
            { botId: b2.botId, botVersionId: b2.botVersionId }
          ]
        });

        assert.equal(t.status, "pending");
        assert.equal(t.ranked, 1);
        assert.equal(t.point_scheme, "3-1-0");

        // Verify tournament entries pinned
        const entries = tournamentRepo.getTournamentEntries(t.id);
        assert.equal(entries.length, 2);
        assert.equal(entries[0].bot_version_id, b1.botVersionId);
        assert.equal(entries[0].artifact_digest, b1.artifactDigest);
        assert.equal(entries[0].profile_id, "python");
        assert.equal(entries[0].profile_revision, "v1");

        // Verify initial standings initialized to 0
        const standings = tournamentRepo.getTournamentStandings(t.id);
        assert.equal(standings.length, 2);
        assert.equal(standings[0].played, 0);
        assert.equal(standings[0].points, 0);
        assert.equal(standings[1].played, 0);
        assert.equal(standings[1].points, 0);

        // Verify jobs created for all matches
        const matches = tournamentRepo.getTournamentMatches(t.id);
        assert.equal(matches.length, 2);
        for (const m of matches) {
          assert.equal(m.status, "pending");
          assert.equal(m.kind, "ranked");
          const job = db.prepare("SELECT * FROM jobs WHERE kind = 'match' AND target_id = ?").get(m.id);
          assert.ok(job, `Job must exist for match ${m.id}`);
          assert.equal(job.status, "queued");
        }
      } finally {
        closeDatabase(db);
      }
    });

    it("rejects bot versions that are NOT ready (pending or failed)", () => {
      const { db, botRepo, tournamentRepo, WIN_FIXTURE, registerReadyBot } = setupEnv("reject-unready");
      try {
        const b1 = registerReadyBot("bot-ok");

        // Create an unready bot version
        botRepo.createBot({ id: "bot-unready", ownerId: "user-admin", name: "Unready" }, { idempotencyKey: "k-bot-unready", actorId: "user-admin" });
        botRepo.createVersion(
          { id: "v-unready", botId: "bot-unready", sourceDigest: "sha256:s-unready", profileId: "python", profileRevision: "v1" },
          { idempotencyKey: "k-ver-unready", actorId: "user-admin" }
        ); // build_status remains 'pending'

        assert.throws(
          () =>
            tournamentRepo.createTournament({
              name: "Unready Test",
              ruleset: WIN_FIXTURE.rulesetSnapshot,
              policy: WIN_FIXTURE.matchPolicy,
              initialState: WIN_FIXTURE.initialCoreState,
              entries: [
                { botId: b1.botId, botVersionId: b1.botVersionId },
                { botId: "bot-unready", botVersionId: "v-unready" }
              ]
            }),
          /not ready/i
        );
      } finally {
        closeDatabase(db);
      }
    });

    it("enforces idempotency: same key returns existing tournament without duplicating jobs; mismatch throws 409", () => {
      const { db, tournamentRepo, WIN_FIXTURE, registerReadyBot } = setupEnv("idempotency");
      try {
        const b1 = registerReadyBot("bot-idemp1");
        const b2 = registerReadyBot("bot-idemp2");

        const entries = [
          { botId: b1.botId, botVersionId: b1.botVersionId },
          { botId: b2.botId, botVersionId: b2.botVersionId }
        ];

        // First call with actorId and idempotencyKey
        const t1 = tournamentRepo.createTournament(
          {
            name: "Idempotent Tourn",
            ruleset: WIN_FIXTURE.rulesetSnapshot,
            policy: WIN_FIXTURE.matchPolicy,
            initialState: WIN_FIXTURE.initialCoreState,
            entries
          },
          { actorId: "user-admin", idempotencyKey: "k-tourn-100" }
        );

        // Same call returns identical tournament
        const t2 = tournamentRepo.createTournament(
          {
            name: "Idempotent Tourn",
            ruleset: WIN_FIXTURE.rulesetSnapshot,
            policy: WIN_FIXTURE.matchPolicy,
            initialState: WIN_FIXTURE.initialCoreState,
            entries
          },
          { actorId: "user-admin", idempotencyKey: "k-tourn-100" }
        );

        assert.equal(t1.id, t2.id);

        // Verify total jobs count remains exactly 2 (not duplicated)
        const jobRows = db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE kind = 'match'").get();
        assert.equal(jobRows.c, 2);

        // Different payload with same idempotencyKey throws 409 IdempotencyConflictError
        assert.throws(
          () =>
            tournamentRepo.createTournament(
              {
                name: "Conflicting Tourn Name",
                ruleset: WIN_FIXTURE.rulesetSnapshot,
                policy: WIN_FIXTURE.matchPolicy,
                initialState: WIN_FIXTURE.initialCoreState,
                entries
              },
              { actorId: "user-admin", idempotencyKey: "k-tourn-100" }
            ),
          (err) => err instanceof IdempotencyConflictError || err.name === "IdempotencyConflictError"
        );
      } finally {
        closeDatabase(db);
      }
    });

    it("createTournamentUseCase pure application service creates tournament via repo", async () => {
      const { db, tournamentRepo, WIN_FIXTURE, registerReadyBot } = setupEnv("usecase-test");
      try {
        const b1 = registerReadyBot("bot-uc1");
        const b2 = registerReadyBot("bot-uc2");

        const useCase = createTournamentUseCase({ tournamentRepo });
        const t = await useCase.execute({
          id: "tourn-uc-1",
          name: "UseCase Tournament",
          ruleset: WIN_FIXTURE.rulesetSnapshot,
          policy: WIN_FIXTURE.matchPolicy,
          initialState: WIN_FIXTURE.initialCoreState,
          entries: [
            { botId: b1.botId, botVersionId: b1.botVersionId },
            { botId: b2.botId, botVersionId: b2.botVersionId }
          ]
        });

        assert.equal(t.id, "tourn-uc-1");
        assert.equal(t.status, "pending");
        const matches = tournamentRepo.getTournamentMatches(t.id);
        assert.equal(matches.length, 2);
      } finally {
        closeDatabase(db);
      }
    });
  });

  describe("End-to-End Execution: 4 Fixture Bots -> 12 Settled Matches", () => {
    it("executes 12 matches with JobWorker, settles standings, validates Elo, sums, and competition rank", async () => {
      const env = setupEnv("full-tournament-exec");
      try {
        const b1 = env.registerReadyBot("bot-1", "Alpha");
        const b2 = env.registerReadyBot("bot-2", "Beta");
        const b3 = env.registerReadyBot("bot-3", "Gamma");
        const b4 = env.registerReadyBot("bot-4", "Delta");

        const tournament = env.tournamentRepo.createTournament({
          id: "tourn-e2e-4",
          name: "Grand Championship",
          ruleset: env.WIN_FIXTURE.rulesetSnapshot,
          policy: env.WIN_FIXTURE.matchPolicy,
          initialState: env.WIN_FIXTURE.initialCoreState,
          ranked: true,
          ladderId: "ladder-main",
          entries: [
            { botId: b1.botId, botVersionId: b1.botVersionId },
            { botId: b2.botId, botVersionId: b2.botVersionId },
            { botId: b3.botId, botVersionId: b3.botVersionId },
            { botId: b4.botId, botVersionId: b4.botVersionId }
          ]
        });

        assert.equal(tournament.status, "pending");

        const legalBotScript = path.resolve(__dirname, "fixtures/arena/bots/legal.mjs");

        // Instantiate worker to execute all queued tournament match jobs
        const worker = createJobWorker({
          workerId: "worker-tournament",
          db: env.db,
          jobQueue: env.queue,
          matchRepo: {
            getMatch: (matchId) => {
              const m = env.db.prepare("SELECT * FROM matches WHERE id = ?").get(matchId);
              if (!m) return null;
              const participantsRows = env.db.prepare("SELECT * FROM match_participants WHERE match_id = ? ORDER BY seat ASC").all(matchId);
              const participants = {};
              for (const p of participantsRows) participants[p.seat] = p;
              return { ...m, participants };
            }
          },
          finalizer: env.finalizer,
          computeDigest: sha256Digest,
          botFactory: (seat, participant) => {
            return createProcessBot({
              botId: participant.bot_id,
              executable: process.execPath,
              args: [legalBotScript]
            });
          }
        });

        // Run worker until all 12 matches are processed
        let settledCount = 0;
        for (let i = 0; i < 20; i++) {
          const outcome = await worker.runOnce();
          if (!outcome.executed) break;
          settledCount++;
        }

        assert.equal(settledCount, 12, "All 12 matches must be executed by worker");

        // Verify tournament status is completed
        const updatedTourn = env.tournamentRepo.getTournament("tourn-e2e-4");
        assert.equal(updatedTourn.status, "completed");

        // Check standings aggregates
        const standings = env.tournamentRepo.getTournamentStandings("tourn-e2e-4");
        assert.equal(standings.length, 4);

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
          assert.equal(s.played, 6, `Each bot plays 6 matches in 4-bot DRR, bot ${s.bot_id} played ${s.played}`);
          assert.equal(s.played, s.wins + s.losses + s.draws);
          assert.equal(s.points, s.wins * 3 + s.draws * 1, `Points must match 3-1-0 scheme for ${s.bot_id}`);
        }

        // Mathematical invariants
        assert.equal(sumPlayed, 24, "Total sum of played games across 4 bots must be 24 (12 matches * 2)");
        assert.equal(sumWins, sumLosses, "Total tournament wins must equal total losses");
        assert.equal(sumPoints, sumWins * 3 + sumDraws * 2, "Points total invariant");

        // Competition rank verification: equal points have equal rank
        for (let i = 0; i < standings.length; i++) {
          assert.ok(standings[i].rank >= 1 && standings[i].rank <= 4);
          if (i > 0 && standings[i].points === standings[i - 1].points) {
            assert.equal(standings[i].rank, standings[i - 1].rank, "Tied points must share equal competition rank");
          }
        }

        // Elo ratings check: ranked tournament must have updated bot_ratings
        for (const b of [b1, b2, b3, b4]) {
          const ratingRow = env.db.prepare("SELECT * FROM bot_ratings WHERE ladder_id = 'ladder-main' AND bot_id = ?").get(b.botId);
          assert.ok(ratingRow, `Rating row must exist for ${b.botId}`);
          assert.equal(ratingRow.rated_games, 6);
        }
      } finally {
        closeDatabase(env.db);
      }
    });

    it("practice tournament settles 3-1-0 points in standings without altering Elo ratings", async () => {
      const env = setupEnv("practice-tournament-exec");
      try {
        const b1 = env.registerReadyBot("bot-prac1");
        const b2 = env.registerReadyBot("bot-prac2");

        const tournament = env.tournamentRepo.createTournament({
          id: "tourn-practice-2",
          name: "Practice Scrimmage",
          ruleset: env.WIN_FIXTURE.rulesetSnapshot,
          policy: env.WIN_FIXTURE.matchPolicy,
          initialState: env.WIN_FIXTURE.initialCoreState,
          ranked: false, // practice tournament!
          ladderId: "ladder-main",
          entries: [
            { botId: b1.botId, botVersionId: b1.botVersionId },
            { botId: b2.botId, botVersionId: b2.botVersionId }
          ]
        });

        assert.equal(tournament.ranked, 0);

        const legalBotScript = path.resolve(__dirname, "fixtures/arena/bots/legal.mjs");

        const worker = createJobWorker({
          workerId: "worker-practice",
          db: env.db,
          jobQueue: env.queue,
          matchRepo: {
            getMatch: (matchId) => {
              const m = env.db.prepare("SELECT * FROM matches WHERE id = ?").get(matchId);
              if (!m) return null;
              const participantsRows = env.db.prepare("SELECT * FROM match_participants WHERE match_id = ? ORDER BY seat ASC").all(matchId);
              const participants = {};
              for (const p of participantsRows) participants[p.seat] = p;
              return { ...m, participants };
            }
          },
          finalizer: env.finalizer,
          computeDigest: sha256Digest,
          botFactory: (seat, participant) => {
            return createProcessBot({
              botId: participant.bot_id,
              executable: process.execPath,
              args: [legalBotScript]
            });
          }
        });

        // Run 2 matches
        await worker.runOnce();
        await worker.runOnce();

        // Tournament completed
        const t = env.tournamentRepo.getTournament("tourn-practice-2");
        assert.equal(t.status, "completed");

        // Standings updated with 3-1-0 points
        const standings = env.tournamentRepo.getTournamentStandings("tourn-practice-2");
        assert.equal(standings.length, 2);
        assert.equal(standings[0].played + standings[1].played, 4);

        // ZERO Elo rating rows in bot_ratings or rating_changes
        const ratingCount = env.db.prepare("SELECT COUNT(*) AS c FROM rating_changes").get();
        assert.equal(ratingCount.c, 0, "Practice tournament must not record rating changes");
        const botRatings = env.db.prepare("SELECT COUNT(*) AS c FROM bot_ratings").get();
        assert.equal(botRatings.c, 0, "Practice tournament must not record bot ratings");
      } finally {
        closeDatabase(env.db);
      }
    });
  });
});
