/**
 * tests/arena-finalizer.test.js
 *
 * Task 11 (Milestone M3): Atomic match finalizer, idempotency, and audit.
 */

"use strict";

const { describe, it, before, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");

// Finding 3: Per-test override for portable Node 18 test run (NOT in production code)
const PORTABLE_NODE18_BINDING =
  "C:/Users/ADMIN/AppData/Local/Temp/opencode/arena-sqlite-smoke-node18/node_modules/better-sqlite3/build/Release/better_sqlite3.node";

if (
  process.versions.node.startsWith("18.") &&
  !process.env.ARENA_SQLITE_NATIVE_BINDING &&
  fs.existsSync(PORTABLE_NODE18_BINDING)
) {
  process.env.ARENA_SQLITE_NATIVE_BINDING = PORTABLE_NODE18_BINDING;
}

const TEMP_BASE_DIR = path.resolve(os.tmpdir(), "arena-finalizer-test-" + Date.now());

let openDatabase;
let closeDatabase;
let createMatchRepository;
let createBotRepository;
let createMatchFinalizer;
let createFinalizeMatchUseCase;
let computeCompletionDigest;
let FinalizerConflictError;
let StaleLeaseError;
let MatchValidationError;
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

  const matchRepoMod = await import("../packages/arena-node/src/persistence/match-repository.mjs");
  createMatchRepository = matchRepoMod.createMatchRepository;

  const botRepoMod = await import("../packages/arena-node/src/persistence/bot-repository.mjs");
  createBotRepository = botRepoMod.createBotRepository;

  const finalizerMod = await import("../packages/arena-node/src/persistence/finalizer.mjs");
  createMatchFinalizer = finalizerMod.createMatchFinalizer;
  FinalizerConflictError = finalizerMod.FinalizerConflictError;
  StaleLeaseError = finalizerMod.StaleLeaseError;
  MatchValidationError = finalizerMod.MatchValidationError;

  const usecaseMod = await import("../packages/arena/src/application/finalize-match.mjs");
  createFinalizeMatchUseCase = usecaseMod.createFinalizeMatchUseCase;
  computeCompletionDigest = usecaseMod.computeCompletionDigest;

  const rulesetMod = await import("../packages/arena/src/domain/ruleset.mjs");
  canonicalSerialize = rulesetMod.canonicalSerialize;
});

after(() => {
  try {
    fs.rmSync(TEMP_BASE_DIR, { recursive: true, force: true });
  } catch (_) {}
});

function setupTestEnvironment(subDir) {
  const dir = path.join(TEMP_BASE_DIR, subDir);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "arena.db");

  const nativeBinding = process.env.ARENA_SQLITE_NATIVE_BINDING || undefined;
  const { db } = openDatabase(dbPath, nativeBinding ? { nativeBinding } : {});

  const matchRepo = createMatchRepository(db);
  const botRepo = createBotRepository(db);
  const finalizer = createMatchFinalizer(db, { computeDigest: sha256Digest });
  const useCase = createFinalizeMatchUseCase({
    finalizationRepo: finalizer,
    computeDigest: sha256Digest
  });

  // Seed users and bots
  botRepo.createUser({ id: "user-1", normalizedUsername: "author1", passwordHash: "h1" });
  botRepo.createUser({ id: "user-2", normalizedUsername: "author2", passwordHash: "h2" });

  botRepo.createBot({ id: "bot-1", ownerId: "user-1", name: "BotAlpha" }, { idempotencyKey: "k-b1", actorId: "user-1" });
  botRepo.createBot({ id: "bot-2", ownerId: "user-2", name: "BotBeta" }, { idempotencyKey: "k-b2", actorId: "user-2" });
  botRepo.createBot({ id: "bot-3", ownerId: "user-1", name: "BotGamma" }, { idempotencyKey: "k-b3", actorId: "user-1" });

  // Register artifacts in artifacts table for FK
  botRepo.registerArtifact({ digest: "sha256:a1", kind: "build", relativePrivatePath: "builds/a1", bytes: 100 });
  botRepo.registerArtifact({ digest: "sha256:a2", kind: "build", relativePrivatePath: "builds/a2", bytes: 100 });
  botRepo.registerArtifact({ digest: "sha256:a3", kind: "build", relativePrivatePath: "builds/a3", bytes: 100 });

  // Seed bot versions and mark ready
  botRepo.createVersion({ id: "v-1", botId: "bot-1", sourceDigest: "sha256:s1", profileId: "python", profileRevision: "v1" }, { idempotencyKey: "k-v1", actorId: "user-1" });
  botRepo.markVersionReady({ botVersionId: "v-1", artifactDigest: "sha256:a1" });

  botRepo.createVersion({ id: "v-2", botId: "bot-2", sourceDigest: "sha256:s2", profileId: "python", profileRevision: "v1" }, { idempotencyKey: "k-v2", actorId: "user-2" });
  botRepo.markVersionReady({ botVersionId: "v-2", artifactDigest: "sha256:a2" });

  botRepo.createVersion({ id: "v-3", botId: "bot-3", sourceDigest: "sha256:s3", profileId: "python", profileRevision: "v1" }, { idempotencyKey: "k-v3", actorId: "user-1" });
  botRepo.markVersionReady({ botVersionId: "v-3", artifactDigest: "sha256:a3" });

  const botMeta = {
    "bot-1": { version: "v-1", artifact: "sha256:a1" },
    "bot-2": { version: "v-2", artifact: "sha256:a2" },
    "bot-3": { version: "v-3", artifact: "sha256:a3" }
  };

  // Helper to create a match and a claimed job lease
  function createAndClaimMatch({
    id,
    kind = "ranked",
    ladderId = "ladder-main",
    botA = "bot-1",
    botB = "bot-2",
    versionA = botMeta[botA]?.version || "v-1",
    versionB = botMeta[botB]?.version || "v-2",
    tournamentId = null,
    scheduleIndex = null,
    leaseDurationMs = 30000,
    ruleset,
    policy,
    profile,
    initialState
  }) {
    const FIXTURES_DIR = path.resolve(__dirname, "fixtures/arena/replays");
    const WIN_FIXTURE_DEFAULT = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "deterministic-match.json"), "utf8"));

    const match = matchRepo.createMatch({
      id,
      kind,
      ladderId,
      ruleset: ruleset || WIN_FIXTURE_DEFAULT.rulesetSnapshot,
      policy: policy || WIN_FIXTURE_DEFAULT.matchPolicy,
      profile: profile || { id: "profile-1" },
      initialState: initialState || WIN_FIXTURE_DEFAULT.initialCoreState,
      participants: [
        { seat: "A", botVersionId: versionA },
        { seat: "B", botVersionId: versionB }
      ],
      tournamentId,
      scheduleIndex
    });

    const jobId = `job-${match.id}`;
    db.prepare(`
      INSERT INTO jobs (id, kind, target_id, status, attempt_no, lease_owner, lease_token, lease_until, max_attempts)
      VALUES (?, 'match', ?, 'claimed', 1, 'worker-1', 'token-123', datetime('now', '+${Math.round(leaseDurationMs / 1000)} seconds'), 3)
    `).run(jobId, match.id);

    db.prepare(`
      INSERT INTO job_attempts (job_id, attempt_no, lease_token, status, started_at)
      VALUES (?, 1, 'token-123', 'active', datetime('now'))
    `).run(jobId);

    return { match, jobId, attemptNo: 1, leaseToken: "token-123" };
  }

  const FIXTURES_DIR = path.resolve(__dirname, "fixtures/arena/replays");
  const WIN_FIXTURE = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "deterministic-match.json"), "utf8"));
  const FORFEIT_FIXTURE = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "forfeit-ply0.json"), "utf8"));
  const DRAW_FIXTURE = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "draw-ply400.json"), "utf8"));

  function getSourceDigest(versionId) {
    if (versionId === "v-1") return "sha256:s1";
    if (versionId === "v-2") return "sha256:s2";
    if (versionId === "v-3") return "sha256:s3";
    return undefined;
  }

  function makeWinReplay(matchId, botIdA = "bot-1", botIdB = "bot-2") {
    const doc = JSON.parse(JSON.stringify(WIN_FIXTURE));
    doc.matchId = matchId;
    const metaA = botMeta[botIdA] || { version: "v-1", artifact: "sha256:a1" };
    const metaB = botMeta[botIdB] || { version: "v-2", artifact: "sha256:a2" };
    doc.participants = {
      A: {
        botId: botIdA,
        botVersionId: metaA.version,
        artifactDigest: metaA.artifact,
        profileId: "python",
        profileRevision: "v1",
        sourceDigest: getSourceDigest(metaA.version)
      },
      B: {
        botId: botIdB,
        botVersionId: metaB.version,
        artifactDigest: metaB.artifact,
        profileId: "python",
        profileRevision: "v1",
        sourceDigest: getSourceDigest(metaB.version)
      }
    };
    return doc;
  }

  function makeForfeitReplay(matchId, botIdA = "bot-1", botIdB = "bot-2") {
    const doc = JSON.parse(JSON.stringify(FORFEIT_FIXTURE));
    doc.matchId = matchId;
    const metaA = botMeta[botIdA] || { version: "v-1", artifact: "sha256:a1" };
    const metaB = botMeta[botIdB] || { version: "v-2", artifact: "sha256:a2" };
    doc.participants = {
      A: {
        botId: botIdA,
        botVersionId: metaA.version,
        artifactDigest: metaA.artifact,
        profileId: "python",
        profileRevision: "v1",
        sourceDigest: getSourceDigest(metaA.version)
      },
      B: {
        botId: botIdB,
        botVersionId: metaB.version,
        artifactDigest: metaB.artifact,
        profileId: "python",
        profileRevision: "v1",
        sourceDigest: getSourceDigest(metaB.version)
      }
    };
    return doc;
  }

  function makeDrawReplay(matchId, botIdA = "bot-1", botIdB = "bot-2") {
    const doc = JSON.parse(JSON.stringify(DRAW_FIXTURE));
    doc.matchId = matchId;
    const metaA = botMeta[botIdA] || { version: "v-1", artifact: "sha256:a1" };
    const metaB = botMeta[botIdB] || { version: "v-2", artifact: "sha256:a2" };
    doc.participants = {
      A: {
        botId: botIdA,
        botVersionId: metaA.version,
        artifactDigest: metaA.artifact,
        profileId: "python",
        profileRevision: "v1",
        sourceDigest: getSourceDigest(metaA.version)
      },
      B: {
        botId: botIdB,
        botVersionId: metaB.version,
        artifactDigest: metaB.artifact,
        profileId: "python",
        profileRevision: "v1",
        sourceDigest: getSourceDigest(metaB.version)
      }
    };
    return doc;
  }

  return {
    dir,
    dbPath,
    db,
    matchRepo,
    botRepo,
    finalizer,
    useCase,
    createAndClaimMatch,
    makeWinReplay,
    makeForfeitReplay,
    makeDrawReplay,
    WIN_FIXTURE,
    FORFEIT_FIXTURE,
    DRAW_FIXTURE,
    cleanup() {
      closeDatabase(db);
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Ranked Match Settlement (Win, Draw, Forfeit)
// ─────────────────────────────────────────────────────────────────────────────

describe("Finalizer: Ranked match settlement", () => {
  let env;

  beforeEach(() => {
    env = setupTestEnvironment("ranked-" + Math.random().toString(36).slice(2));
  });

  afterEach(() => {
    env?.cleanup();
  });

  it("settles ranked win: updates Elo ratings, records rating_changes with pre-settlement K, and finalizes job", async () => {
    const { match, attemptNo, leaseToken } = env.createAndClaimMatch({ id: "match-ranked-win" });

    const replay = env.makeWinReplay(match.id, "bot-1", "bot-2");
    const result = replay.result;
    const replayDigest = sha256Digest(replay);
    const completionDigest = sha256Digest({ matchId: match.id, result, replayDigest });

    const finalized = await env.useCase.finalizeMatch({
      matchId: match.id,
      attemptNo,
      leaseToken,
      result,
      replay,
      replayDigest,
      completionDigest
    });

    assert.equal(finalized.matchId, match.id);
    assert.equal(finalized.settlementSeq, 1);
    assert.equal(finalized.result.outcome, "win");
    assert.equal(finalized.replayDigest, replayDigest);
    assert.equal(finalized.completionDigest, completionDigest);

    // Verify match status in DB
    const settledMatch = env.matchRepo.getMatch(match.id);
    assert.equal(settledMatch.status, "completed");
    assert.equal(settledMatch.settlement_seq, 1);
    assert.ok(settledMatch.settled_at);

    // Verify rating_changes rows
    const changesA = env.db.prepare("SELECT * FROM rating_changes WHERE match_id = ? AND bot_id = ?").get(match.id, "bot-1");
    const changesB = env.db.prepare("SELECT * FROM rating_changes WHERE match_id = ? AND bot_id = ?").get(match.id, "bot-2");

    assert.ok(changesA, "Bot A rating_change must be recorded");
    assert.ok(changesB, "Bot B rating_change must be recorded");
    assert.equal(changesA.settlement_seq, 1);
    assert.equal(changesB.settlement_seq, 1);
    assert.equal(changesA.k_factor, 32); // Provisional (<30 games)
    assert.equal(changesB.k_factor, 32);
    assert.equal(changesA.score, 1.0);
    assert.equal(changesB.score, 0.0);
    assert.ok(changesA.delta > 0, "Winner delta must be positive");
    assert.ok(changesB.delta < 0, "Loser delta must be negative");

    // Verify bot_ratings updated
    const ratingA = env.matchRepo.getBotRating("ladder-main", "bot-1");
    const ratingB = env.matchRepo.getBotRating("ladder-main", "bot-2");
    assert.equal(ratingA.rated_games, 1);
    assert.equal(ratingA.wins, 1);
    assert.equal(ratingA.losses, 0);
    assert.equal(ratingB.rated_games, 1);
    assert.equal(ratingB.wins, 0);
    assert.equal(ratingB.losses, 1);

    // Verify job and attempt status
    const job = env.db.prepare("SELECT * FROM jobs WHERE target_id = ?").get(match.id);
    const attempt = env.db.prepare("SELECT * FROM job_attempts WHERE job_id = ? AND attempt_no = ?").get(job.id, attemptNo);
    assert.equal(job.status, "completed");
    assert.equal(attempt.status, "completed");
  });

  it("settles ranked draw: applies 0.5 score to both bots and increments draw count", async () => {
    const { match, attemptNo, leaseToken } = env.createAndClaimMatch({
      id: "match-ranked-draw",
      initialState: env.DRAW_FIXTURE.initialCoreState,
      ruleset: env.DRAW_FIXTURE.rulesetSnapshot,
      policy: env.DRAW_FIXTURE.matchPolicy
    });

    const replay = env.makeDrawReplay(match.id, "bot-1", "bot-2");
    const result = replay.result;
    const replayDigest = sha256Digest(replay);
    const completionDigest = sha256Digest({ matchId: match.id, result, replayDigest });

    await env.useCase.finalizeMatch({
      matchId: match.id,
      attemptNo,
      leaseToken,
      result,
      replay,
      replayDigest,
      completionDigest
    });

    const ratingA = env.matchRepo.getBotRating("ladder-main", "bot-1");
    const ratingB = env.matchRepo.getBotRating("ladder-main", "bot-2");
    assert.equal(ratingA.draws, 1);
    assert.equal(ratingB.draws, 1);
    assert.equal(ratingA.rated_games, 1);
    assert.equal(ratingB.rated_games, 1);

    const changesA = env.db.prepare("SELECT * FROM rating_changes WHERE match_id = ? AND bot_id = ?").get(match.id, "bot-1");
    assert.equal(changesA.score, 0.5);
  });

  it("settles ranked forfeit: scores forfeit like win/loss and records forfeit reason in match_results", async () => {
    const { match, attemptNo, leaseToken } = env.createAndClaimMatch({ id: "match-ranked-forfeit" });

    const replay = env.makeForfeitReplay(match.id, "bot-1", "bot-2");
    const result = replay.result;
    const replayDigest = sha256Digest(replay);
    const completionDigest = sha256Digest({ matchId: match.id, result, replayDigest });

    await env.useCase.finalizeMatch({
      matchId: match.id,
      attemptNo,
      leaseToken,
      result,
      replay,
      replayDigest,
      completionDigest
    });

    const ratingA = env.matchRepo.getBotRating("ladder-main", "bot-1");
    const ratingB = env.matchRepo.getBotRating("ladder-main", "bot-2");
    assert.equal(ratingB.wins, 1, "Winner B gets win count");
    assert.equal(ratingA.losses, 1, "Loser A gets loss count");

    const matchRes = env.matchRepo.getMatchResult(match.id);
    assert.ok(matchRes);
    const parsedResult = JSON.parse(matchRes.result_json);
    assert.equal(parsedResult.reason, "turn_timeout");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Practice Match Settlement (No Elo / Rated Stats)
// ─────────────────────────────────────────────────────────────────────────────

describe("Finalizer: Practice match settlement", () => {
  let env;

  beforeEach(() => {
    env = setupTestEnvironment("practice-" + Math.random().toString(36).slice(2));
  });

  afterEach(() => {
    env?.cleanup();
  });

  it("practice match stores result and replay, but performs NO Elo or rated stats writes", async () => {
    const { match, attemptNo, leaseToken } = env.createAndClaimMatch({
      id: "match-practice-1",
      kind: "practice"
    });

    const replay = env.makeWinReplay(match.id, "bot-1", "bot-2");
    const result = replay.result;
    const replayDigest = sha256Digest(replay);
    const completionDigest = sha256Digest({ matchId: match.id, result, replayDigest });

    const finalized = await env.useCase.finalizeMatch({
      matchId: match.id,
      attemptNo,
      leaseToken,
      result,
      replay,
      replayDigest,
      completionDigest
    });

    assert.equal(finalized.matchId, match.id);
    assert.equal(finalized.settlementSeq, 1);

    // Verify match_results exists
    const matchRes = env.matchRepo.getMatchResult(match.id);
    assert.ok(matchRes, "Practice match result must be persisted");
    assert.equal(matchRes.replay_digest, replayDigest);

    // ZERO rating_changes rows must be written!
    const countChanges = env.db.prepare("SELECT COUNT(*) AS count FROM rating_changes WHERE match_id = ?").get(match.id);
    assert.equal(countChanges.count, 0, "Practice match must not write to rating_changes");

    // ZERO updates to bot_ratings!
    const ratingA = env.matchRepo.getBotRating("ladder-main", "bot-1");
    const ratingB = env.matchRepo.getBotRating("ladder-main", "bot-2");
    assert.equal(ratingA.rated_games, 0, "Practice match must not increment rated_games");
    assert.equal(ratingB.rated_games, 0, "Practice match must not increment rated_games");
    assert.equal(ratingA.wins, 0);
    assert.equal(ratingB.losses, 0);
    assert.equal(ratingA.rating, 1200.0);
    assert.equal(ratingB.rating, 1200.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Tournament Standings and Completion
// ─────────────────────────────────────────────────────────────────────────────

describe("Finalizer: Tournament matches and standings", () => {
  let env;

  beforeEach(() => {
    env = setupTestEnvironment("tournament-" + Math.random().toString(36).slice(2));
  });

  afterEach(() => {
    env?.cleanup();
  });

  it("updates tournament standings with 3-1-0 points and marks tournament completed when all matches settle", async () => {
    // Create tournament with 2 matches
    const tourneyId = "tourney-1";
    env.db.prepare(`
      INSERT INTO tournaments (id, name, status, ruleset_json, policy_json, point_scheme, ranked)
      VALUES (?, 'Mini Cup', 'active', '{}', '{}', '3-1-0', 1)
    `).run(tourneyId);

    // Create match 1 (Round 1: bot-1 vs bot-2)
    const m1 = env.createAndClaimMatch({
      id: "t-match-1",
      tournamentId: tourneyId,
      scheduleIndex: 0,
      botA: "bot-1",
      botB: "bot-2"
    });

    // Create match 2 (Round 2: bot-2 vs bot-1)
    const m2 = env.createAndClaimMatch({
      id: "t-match-2",
      tournamentId: tourneyId,
      scheduleIndex: 1,
      botA: "bot-2",
      botB: "bot-1",
      ruleset: env.DRAW_FIXTURE.rulesetSnapshot,
      policy: env.DRAW_FIXTURE.matchPolicy,
      initialState: env.DRAW_FIXTURE.initialCoreState
    });

    // Match 1: Bot A (bot-1) wins -> gets 3 points, Bot B gets 0 points
    const rep1 = env.makeWinReplay(m1.match.id, "bot-1", "bot-2");
    const res1 = rep1.result;
    const rDig1 = sha256Digest(rep1);
    const cDig1 = sha256Digest({ matchId: m1.match.id, result: res1, replayDigest: rDig1 });

    await env.useCase.finalizeMatch({
      matchId: m1.match.id,
      attemptNo: m1.attemptNo,
      leaseToken: m1.leaseToken,
      result: res1,
      replay: rep1,
      replayDigest: rDig1,
      completionDigest: cDig1
    });

    // Check intermediate standings
    const standingsMid = env.matchRepo.getTournamentStandings(tourneyId);
    assert.equal(standingsMid.length, 2);
    const stand1 = standingsMid.find(s => s.bot_id === "bot-1");
    const stand2 = standingsMid.find(s => s.bot_id === "bot-2");
    assert.equal(stand1.points, 3);
    assert.equal(stand1.wins, 1);
    assert.equal(stand1.played, 1);
    assert.equal(stand2.points, 0);
    assert.equal(stand2.losses, 1);

    // Tournament should still be active because match 2 is unsettled
    const tMid = env.matchRepo.getTournament(tourneyId);
    assert.equal(tMid.status, "active");

    // Match 2: Draw -> both get 1 point
    const rep2 = env.makeDrawReplay(m2.match.id, "bot-2", "bot-1");
    const res2 = rep2.result;
    const rDig2 = sha256Digest(rep2);
    const cDig2 = sha256Digest({ matchId: m2.match.id, result: res2, replayDigest: rDig2 });

    await env.useCase.finalizeMatch({
      matchId: m2.match.id,
      attemptNo: m2.attemptNo,
      leaseToken: m2.leaseToken,
      result: res2,
      replay: rep2,
      replayDigest: rDig2,
      completionDigest: cDig2
    });

    // Final standings: bot-1 has 3 + 1 = 4 points; bot-2 has 0 + 1 = 1 point
    const standingsFinal = env.matchRepo.getTournamentStandings(tourneyId);
    const sFinal1 = standingsFinal.find(s => s.bot_id === "bot-1");
    const sFinal2 = standingsFinal.find(s => s.bot_id === "bot-2");
    assert.equal(sFinal1.points, 4);
    assert.equal(sFinal1.played, 2);
    assert.equal(sFinal2.points, 1);
    assert.equal(sFinal2.played, 2);

    // All matches completed -> tournament marked completed!
    const tFinal = env.matchRepo.getTournament(tourneyId);
    assert.equal(tFinal.status, "completed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Idempotency & Conflict
// ─────────────────────────────────────────────────────────────────────────────

describe("Finalizer: Idempotency and conflict handling", () => {
  let env;

  beforeEach(() => {
    env = setupTestEnvironment("idempotency-" + Math.random().toString(36).slice(2));
  });

  afterEach(() => {
    env?.cleanup();
  });

  it("same completion retry returns canonical finalized match without duplicate writes", async () => {
    const { match, attemptNo, leaseToken } = env.createAndClaimMatch({ id: "match-idem-1" });

    const replay = env.makeWinReplay(match.id, "bot-1", "bot-2");
    const result = replay.result;
    const replayDigest = sha256Digest(replay);
    const completionDigest = sha256Digest({ matchId: match.id, result, replayDigest });

    const envPayload = {
      matchId: match.id,
      attemptNo,
      leaseToken,
      result,
      replay,
      replayDigest,
      completionDigest
    };

    const first = await env.useCase.finalizeMatch(envPayload);
    const second = await env.useCase.finalizeMatch(envPayload);

    assert.equal(second.matchId, first.matchId);
    assert.equal(second.settlementSeq, first.settlementSeq);
    assert.equal(second.completionDigest, first.completionDigest);

    // Exactly 2 rating_changes rows in total (1 for A, 1 for B)
    const countChanges = env.db.prepare("SELECT COUNT(*) AS count FROM rating_changes WHERE match_id = ?").get(match.id);
    assert.equal(countChanges.count, 2, "Duplicate completion must not create duplicate rating_changes");

    // Exactly 1 rated game per bot
    const ratingA = env.matchRepo.getBotRating("ladder-main", "bot-1");
    assert.equal(ratingA.rated_games, 1, "Duplicate completion must not double increment rated_games");
  });

  it("contradictory duplicate completion throws FinalizerConflictError with zero writes", async () => {
    const { match, attemptNo, leaseToken } = env.createAndClaimMatch({ id: "match-conflict-1" });

    const repWin = env.makeWinReplay(match.id, "bot-1", "bot-2");
    const resWin = repWin.result;
    const rDigWin = sha256Digest(repWin);
    const cDigWin = sha256Digest({ matchId: match.id, result: resWin, replayDigest: rDigWin });

    await env.useCase.finalizeMatch({
      matchId: match.id,
      attemptNo,
      leaseToken,
      result: resWin,
      replay: repWin,
      replayDigest: rDigWin,
      completionDigest: cDigWin
    });

    // Competing / contradictory completion (forfeit outcome instead of win)
    const repLoss = env.makeForfeitReplay(match.id, "bot-1", "bot-2");
    const resLoss = repLoss.result;
    const rDigLoss = sha256Digest(repLoss);
    const cDigLoss = sha256Digest({ matchId: match.id, result: resLoss, replayDigest: rDigLoss });

    await assert.rejects(
      () => env.useCase.finalizeMatch({
        matchId: match.id,
        attemptNo,
        leaseToken,
        result: resLoss,
        replay: repLoss,
        replayDigest: rDigLoss,
        completionDigest: cDigLoss
      }),
      (err) => {
        assert.ok(err instanceof FinalizerConflictError || err.code === "FINALIZER_CONFLICT");
        return true;
      }
    );
  });

  it("same completion retry from new attempt returns canonical finalized match without conflict", async () => {
    const { match, attemptNo, leaseToken } = env.createAndClaimMatch({ id: "match-retry-canonical" });

    const replay = env.makeWinReplay(match.id, "bot-1", "bot-2");
    const result = replay.result;
    const replayDigest = sha256Digest(replay);
    // Canonical completion digest excludes attemptNo and leaseToken
    const completionDigest = sha256Digest({ matchId: match.id, result, replayDigest });

    // Attempt 1 finishes and commits
    const first = await env.useCase.finalizeMatch({
      matchId: match.id,
      attemptNo,
      leaseToken,
      result,
      replay,
      replayDigest,
      completionDigest
    });

    // Attempt 2 arrives with new attempt number and new lease token, but identical canonical completion payload
    const second = await env.useCase.finalizeMatch({
      matchId: match.id,
      attemptNo: 2,
      leaseToken: "token-attempt-2-retry",
      result,
      replay,
      replayDigest,
      completionDigest
    });

    assert.equal(second.matchId, first.matchId);
    assert.equal(second.settlementSeq, first.settlementSeq);
    assert.equal(second.completionDigest, first.completionDigest);
    assert.deepEqual(second.result, first.result);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4b. Pinned Match & Participant Validation
// ─────────────────────────────────────────────────────────────────────────────

describe("Finalizer: Pinned match validation", () => {
  let env;

  beforeEach(() => {
    env = setupTestEnvironment("pinning-" + Math.random().toString(36).slice(2));
  });

  afterEach(() => {
    env?.cleanup();
  });

  it("rejects completion when rulesetSnapshot differs from DB pinned ruleset", async () => {
    const { match, attemptNo, leaseToken } = env.createAndClaimMatch({ id: "match-pin-ruleset" });
    // Mutate DB pinned ruleset_json to a different ruleset ID
    const differentRuleset = { ...env.WIN_FIXTURE.rulesetSnapshot, rulesetId: "ottv2-g-pinned-other-v1" };
    env.db.prepare("UPDATE matches SET ruleset_json = ? WHERE id = ?").run(JSON.stringify(differentRuleset), match.id);

    const replay = env.makeWinReplay(match.id, "bot-1", "bot-2");
    const result = replay.result;
    const replayDigest = sha256Digest(replay);
    const completionDigest = sha256Digest({ matchId: match.id, result, replayDigest });

    await assert.rejects(
      () => env.useCase.finalizeMatch({
        matchId: match.id,
        attemptNo,
        leaseToken,
        result,
        replay,
        replayDigest,
        completionDigest
      }),
      (err) => {
        assert.ok(err instanceof MatchValidationError || err.code?.includes("RULESET") || err.message?.includes("ruleset"));
        return true;
      }
    );
  });

  it("rejects completion when matchPolicy differs from DB pinned policy", async () => {
    const { match, attemptNo, leaseToken } = env.createAndClaimMatch({ id: "match-pin-policy" });
    // Mutate DB pinned policy_json
    const differentPolicy = { ...env.WIN_FIXTURE.matchPolicy, initialTimeMs: 120000 };
    env.db.prepare("UPDATE matches SET policy_json = ? WHERE id = ?").run(JSON.stringify(differentPolicy), match.id);

    const replay = env.makeWinReplay(match.id, "bot-1", "bot-2");
    const result = replay.result;
    const replayDigest = sha256Digest(replay);
    const completionDigest = sha256Digest({ matchId: match.id, result, replayDigest });

    await assert.rejects(
      () => env.useCase.finalizeMatch({
        matchId: match.id,
        attemptNo,
        leaseToken,
        result,
        replay,
        replayDigest,
        completionDigest
      }),
      (err) => {
        assert.ok(err instanceof MatchValidationError || err.code?.includes("POLICY") || err.message?.includes("policy"));
        return true;
      }
    );
  });

  it("rejects completion when initialCoreState differs from DB pinned initial state", async () => {
    const { match, attemptNo, leaseToken } = env.createAndClaimMatch({ id: "match-pin-state" });
    // Mutate DB pinned initial_state_json
    const differentState = {
      ...env.WIN_FIXTURE.initialCoreState,
      clock: { remainingMs: { A: 500000, B: 500000 }, runningSeat: "A" }
    };
    env.db.prepare("UPDATE matches SET initial_state_json = ? WHERE id = ?").run(JSON.stringify(differentState), match.id);

    const replay = env.makeWinReplay(match.id, "bot-1", "bot-2");
    const result = replay.result;
    const replayDigest = sha256Digest(replay);
    const completionDigest = sha256Digest({ matchId: match.id, result, replayDigest });

    await assert.rejects(
      () => env.useCase.finalizeMatch({
        matchId: match.id,
        attemptNo,
        leaseToken,
        result,
        replay,
        replayDigest,
        completionDigest
      }),
      (err) => {
        assert.ok(err instanceof MatchValidationError || err.code?.includes("INITIAL_STATE") || err.message?.includes("initial"));
        return true;
      }
    );
  });

  it("rejects completion when participant profileRevision differs from DB pinned participant", async () => {
    const { match, attemptNo, leaseToken } = env.createAndClaimMatch({ id: "match-pin-rev" });
    const replay = env.makeWinReplay(match.id, "bot-1", "bot-2");
    replay.participants.A.profileRevision = "mutated-revision";
    const result = replay.result;
    const replayDigest = sha256Digest(replay);
    const completionDigest = sha256Digest({ matchId: match.id, result, replayDigest });

    await assert.rejects(
      () => env.useCase.finalizeMatch({
        matchId: match.id,
        attemptNo,
        leaseToken,
        result,
        replay,
        replayDigest,
        completionDigest
      }),
      (err) => {
        assert.ok(err instanceof MatchValidationError || err.code?.includes("PROFILE_REVISION") || err.message?.includes("profileRevision"));
        return true;
      }
    );
  });

  it("rejects completion when participant sourceDigest differs from DB pinned bot version", async () => {
    const { match, attemptNo, leaseToken } = env.createAndClaimMatch({ id: "match-pin-source" });
    const replay = env.makeWinReplay(match.id, "bot-1", "bot-2");
    replay.participants.A.sourceDigest = "sha256:mutated-source";
    const result = replay.result;
    const replayDigest = sha256Digest(replay);
    const completionDigest = sha256Digest({ matchId: match.id, result, replayDigest });

    await assert.rejects(
      () => env.useCase.finalizeMatch({
        matchId: match.id,
        attemptNo,
        leaseToken,
        result,
        replay,
        replayDigest,
        completionDigest
      }),
      (err) => {
        assert.ok(err instanceof MatchValidationError || err.code?.includes("SOURCE") || err.message?.includes("sourceDigest"));
        return true;
      }
    );
  });

  it("accepts completion when DB pinned ruleset has different JSON key ordering (canonical comparison)", async () => {
    const replay = env.makeWinReplay("match-pin-keyorder", "bot-1", "bot-2");
    const reversedRuleset = {
      winConditions: replay.rulesetSnapshot.winConditions,
      movement: replay.rulesetSnapshot.movement,
      initialSetup: replay.rulesetSnapshot.initialSetup,
      goals: replay.rulesetSnapshot.goals,
      beats: replay.rulesetSnapshot.beats,
      types: replay.rulesetSnapshot.types,
      files: replay.rulesetSnapshot.files,
      boardHeight: replay.rulesetSnapshot.boardHeight,
      boardWidth: replay.rulesetSnapshot.boardWidth,
      rulesetId: replay.rulesetSnapshot.rulesetId
    };

    const { match, attemptNo, leaseToken } = env.createAndClaimMatch({
      id: "match-pin-keyorder",
      ruleset: reversedRuleset
    });

    const result = replay.result;
    const replayDigest = sha256Digest(replay);
    const completionDigest = sha256Digest({ matchId: match.id, result, replayDigest });

    const finalized = await env.useCase.finalizeMatch({
      matchId: match.id,
      attemptNo,
      leaseToken,
      result,
      replay,
      replayDigest,
      completionDigest
    });

    assert.equal(finalized.matchId, match.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Lease Fencing & Validation
// ─────────────────────────────────────────────────────────────────────────────

describe("Finalizer: Lease fencing and validation", () => {
  let env;

  beforeEach(() => {
    env = setupTestEnvironment("fencing-" + Math.random().toString(36).slice(2));
  });

  afterEach(() => {
    env?.cleanup();
  });

  it("rejects expired lease with StaleLeaseError", async () => {
    const { match, attemptNo, leaseToken } = env.createAndClaimMatch({ id: "match-expired" });

    // Manually force lease expiration in DB
    env.db.prepare("UPDATE jobs SET lease_until = datetime('now', '-5 seconds') WHERE target_id = ?").run(match.id);

    const replay = env.makeWinReplay(match.id, "bot-1", "bot-2");
    const result = replay.result;
    const replayDigest = sha256Digest(replay);
    const completionDigest = sha256Digest({ matchId: match.id, result, replayDigest });

    await assert.rejects(
      () => env.useCase.finalizeMatch({
        matchId: match.id,
        attemptNo,
        leaseToken,
        result,
        replay,
        replayDigest,
        completionDigest
      }),
      (err) => {
        assert.ok(err instanceof StaleLeaseError || err.code === "STALE_LEASE");
        return true;
      }
    );

    // Match remains unsettled
    const unsettled = env.matchRepo.getMatch(match.id);
    assert.notEqual(unsettled.status, "completed");
  });

  it("rejects attempt number mismatch or wrong lease token with StaleLeaseError", async () => {
    const { match, attemptNo } = env.createAndClaimMatch({ id: "match-wrong-token" });

    const replay = env.makeWinReplay(match.id, "bot-1", "bot-2");
    const result = replay.result;
    const replayDigest = sha256Digest(replay);
    const completionDigest = sha256Digest({ matchId: match.id, result, replayDigest });

    // Wrong lease token
    await assert.rejects(
      () => env.useCase.finalizeMatch({
        matchId: match.id,
        attemptNo,
        leaseToken: "INVALID_TOKEN",
        result,
        replay,
        replayDigest,
        completionDigest
      }),
      (err) => {
        assert.ok(err instanceof StaleLeaseError || err.code === "STALE_LEASE");
        return true;
      }
    );

    // Stale attempt number (envelope has valid completion digest but mismatching attempt number)
    await assert.rejects(
      () => env.useCase.finalizeMatch({
        matchId: match.id,
        attemptNo: 999,
        leaseToken: "token-123",
        result,
        replay,
        replayDigest,
        completionDigest
      }),
      (err) => {
        assert.ok(err instanceof StaleLeaseError || err.code === "STALE_LEASE");
        return true;
      }
    );
  });

  it("rejects replay/completion digest mismatch before entering transaction", async () => {
    const { match, attemptNo, leaseToken } = env.createAndClaimMatch({ id: "match-digest-mismatch" });

    const replay = env.makeWinReplay(match.id, "bot-1", "bot-2");
    const result = replay.result;

    // Forged replay digest
    await assert.rejects(
      () => env.useCase.finalizeMatch({
        matchId: match.id,
        attemptNo,
        leaseToken,
        result,
        replay,
        replayDigest: "sha256:forged_digest",
        completionDigest: "sha256:something"
      }),
      (err) => {
        assert.ok(err.message.includes("digest"));
        return true;
      }
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Rollback Mid-Update
// ─────────────────────────────────────────────────────────────────────────────

describe("Finalizer: Transaction rollback mid-update", () => {
  let env;

  beforeEach(() => {
    env = setupTestEnvironment("rollback-" + Math.random().toString(36).slice(2));
  });

  afterEach(() => {
    env?.cleanup();
  });

  it("injected failure mid-transaction rolls back everything and allows retry", async () => {
    const { match, attemptNo, leaseToken } = env.createAndClaimMatch({ id: "match-rollback" });

    const replay = env.makeWinReplay(match.id, "bot-1", "bot-2");
    const result = replay.result;
    const replayDigest = sha256Digest(replay);
    const completionDigest = sha256Digest({ matchId: match.id, result, replayDigest });

    const envelope = {
      matchId: match.id,
      attemptNo,
      leaseToken,
      result,
      replay,
      replayDigest,
      completionDigest
    };

    // Corrupt schema constraint temporarily or inject error inside transaction
    env.db.prepare("CREATE TRIGGER test_fail_trigger BEFORE INSERT ON rating_changes BEGIN SELECT RAISE(ABORT, 'injected DB failure'); END;").run();

    await assert.rejects(
      () => env.useCase.finalizeMatch(envelope),
      (err) => {
        assert.ok(err.message.includes("injected DB failure"));
        return true;
      }
    );

    // Check that transaction rolled back: match is NOT completed, match_results has 0 rows
    const matchState = env.matchRepo.getMatch(match.id);
    assert.equal(matchState.status, "pending");
    assert.equal(matchState.settled_at, null);
    assert.equal(env.matchRepo.getMatchResult(match.id), undefined);

    // Drop failing trigger
    env.db.prepare("DROP TRIGGER test_fail_trigger;").run();

    // Retry should succeed cleanly
    const retryRes = await env.useCase.finalizeMatch(envelope);
    assert.equal(retryRes.matchId, match.id);
    assert.equal(retryRes.settlementSeq, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Child Process Concurrency & Crash Recovery
// ─────────────────────────────────────────────────────────────────────────────

describe("Finalizer: Child process concurrency and crash recovery", () => {
  let env;

  beforeEach(() => {
    env = setupTestEnvironment("proc-concurrency-" + Math.random().toString(36).slice(2));
  });

  afterEach(() => {
    env?.cleanup();
  });

  function spawnWorkerProcess(config, timeoutMs = 15000) {
    const workerScript = path.resolve(__dirname, "fixtures/arena/concurrency-worker.mjs");
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [workerScript, "--stdin"], {
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error("Worker process timed out"));
      }, timeoutMs);

      proc.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
      proc.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
      proc.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.stdin.write(JSON.stringify(config));
      proc.stdin.end();
    });
  }

  it("crash/kill BEFORE commit under write TX rolls back all writes; subsequent retry credits exactly once", async () => {
    const nativeBinding = process.env.ARENA_SQLITE_NATIVE_BINDING || undefined;

    const { match, attemptNo, leaseToken } = env.createAndClaimMatch({ id: "match-crash-rollback" });
    const replay = env.makeWinReplay(match.id, "bot-1", "bot-2");
    const result = replay.result;
    const replayDigest = sha256Digest(replay);
    const completionDigest = sha256Digest({ matchId: match.id, result, replayDigest });

    const envelope = {
      matchId: match.id,
      attemptNo,
      leaseToken,
      result,
      replay,
      replayDigest,
      completionDigest
    };

    // Spawn child process that crashes inside write transaction
    const res = await spawnWorkerProcess({
      action: "crash-in-write-tx",
      dbPath: env.dbPath,
      options: nativeBinding ? { nativeBinding } : {},
      params: { envelope }
    });

    assert.equal(res.code, 77, "Child process must have terminated abruptly with exit code 77");

    // Verify complete rollback in SQLite: 0 match_results, 0 rating_changes, match still pending
    const matchRow = env.matchRepo.getMatch(match.id);
    assert.equal(matchRow.status, "pending");
    assert.equal(matchRow.settled_at, null);

    const matchResRow = env.db.prepare("SELECT * FROM match_results WHERE match_id = ?").get(match.id);
    assert.equal(matchResRow, undefined, "Uncommitted match_results write must be rolled back");

    const ratingChanges = env.db.prepare("SELECT * FROM rating_changes WHERE match_id = ?").all(match.id);
    assert.equal(ratingChanges.length, 0, "No rating changes before commit");

    // Reopen/retry proves clean finalization and exactly once credit
    const finalized = await env.useCase.finalizeMatch(envelope);
    assert.equal(finalized.matchId, match.id);
    assert.equal(finalized.settlementSeq, 1);

    const matchResAfter = env.db.prepare("SELECT * FROM match_results WHERE match_id = ?").get(match.id);
    assert.ok(matchResAfter, "Retried finalization writes match_results");

    const ratingChangesAfter = env.db.prepare("SELECT * FROM rating_changes WHERE match_id = ?").all(match.id);
    assert.equal(ratingChangesAfter.length, 2, "Retried finalization creates exactly 2 rating_changes rows");
  });

  it("two concurrent child processes finalize the exact same match: exactly 1 credit, both receive canonical result", async () => {
    const nativeBinding = process.env.ARENA_SQLITE_NATIVE_BINDING || undefined;

    const { match, attemptNo, leaseToken } = env.createAndClaimMatch({ id: "match-concurrent-same" });
    const replay = env.makeWinReplay(match.id, "bot-1", "bot-2");
    const result = replay.result;
    const replayDigest = sha256Digest(replay);
    const completionDigest = sha256Digest({ matchId: match.id, result, replayDigest });

    const envelope = {
      matchId: match.id,
      attemptNo,
      leaseToken,
      result,
      replay,
      replayDigest,
      completionDigest
    };

    async function runFinalizeChildProcess(workerId) {
      const res = await spawnWorkerProcess({
        action: "finalize-match",
        dbPath: env.dbPath,
        options: nativeBinding ? { nativeBinding } : {},
        params: { envelope, workerId }
      });
      if (res.code !== 0) {
        try {
          const parsed = JSON.parse(res.stderr || res.stdout);
          throw new Error(parsed.error || `Process exited with code ${res.code}`);
        } catch (_) {
          throw new Error(res.stderr || `Process exited with code ${res.code}`);
        }
      }
      return JSON.parse(res.stdout);
    }

    const [w1, w2] = await Promise.all([
      runFinalizeChildProcess("worker-proc-A"),
      runFinalizeChildProcess("worker-proc-B")
    ]);

    assert.ok(w1.success, `Worker 1 failed: ${w1.error}`);
    assert.ok(w2.success, `Worker 2 failed: ${w2.error}`);

    // Both workers received canonical result
    assert.equal(w1.finalized.matchId, match.id);
    assert.equal(w2.finalized.matchId, match.id);
    assert.equal(w1.finalized.settlementSeq, w2.finalized.settlementSeq);

    // Exactly 2 rating_changes rows in DB
    const countChanges = env.db.prepare("SELECT COUNT(*) AS count FROM rating_changes WHERE match_id = ?").get(match.id);
    assert.equal(countChanges.count, 2, "Exactly 2 rating_changes rows across both concurrent workers");

    // Exactly 1 rated game for Bot 1
    const rating1 = env.matchRepo.getBotRating("ladder-main", "bot-1");
    assert.equal(rating1.rated_games, 1);
  });

  it("two different matches involving the same bot finalize concurrently via child processes: pre/post ratings chain strictly without lost update", async () => {
    const nativeBinding = process.env.ARENA_SQLITE_NATIVE_BINDING || undefined;

    // Match 1: bot-1 vs bot-2
    const m1 = env.createAndClaimMatch({ id: "match-chain-1", botA: "bot-1", botB: "bot-2" });
    const rep1 = env.makeWinReplay(m1.match.id, "bot-1", "bot-2");
    const r1 = rep1.result;
    const rd1 = sha256Digest(rep1);
    const cd1 = sha256Digest({ matchId: m1.match.id, result: r1, replayDigest: rd1 });

    // Match 2: bot-1 vs bot-3 (same bot-1 in both matches!)
    const m2 = env.createAndClaimMatch({ id: "match-chain-2", botA: "bot-1", botB: "bot-3", versionB: "v-3" });
    const rep2 = env.makeWinReplay(m2.match.id, "bot-1", "bot-3");
    const r2 = rep2.result;
    const rd2 = sha256Digest(rep2);
    const cd2 = sha256Digest({ matchId: m2.match.id, result: r2, replayDigest: rd2 });

    async function runFinalizeChildProcess(envelope, workerId) {
      const res = await spawnWorkerProcess({
        action: "finalize-match",
        dbPath: env.dbPath,
        options: nativeBinding ? { nativeBinding } : {},
        params: { envelope, workerId }
      });
      if (res.code !== 0) {
        try {
          const parsed = JSON.parse(res.stderr || res.stdout);
          throw new Error(parsed.error || `Process exited with code ${res.code}`);
        } catch (_) {
          throw new Error(res.stderr || `Process exited with code ${res.code}`);
        }
      }
      return JSON.parse(res.stdout);
    }

    const [res1, res2] = await Promise.all([
      runFinalizeChildProcess({ matchId: m1.match.id, attemptNo: m1.attemptNo, leaseToken: m1.leaseToken, result: r1, replay: rep1, replayDigest: rd1, completionDigest: cd1 }, "w1"),
      runFinalizeChildProcess({ matchId: m2.match.id, attemptNo: m2.attemptNo, leaseToken: m2.leaseToken, result: r2, replay: rep2, replayDigest: rd2, completionDigest: cd2 }, "w2")
    ]);

    assert.ok(res1.success, `Worker 1 failed: ${res1.error}`);
    assert.ok(res2.success, `Worker 2 failed: ${res2.error}`);

    // Settlement sequences must be distinct (1 and 2)
    const seqs = [res1.finalized.settlementSeq, res2.finalized.settlementSeq].sort();
    assert.deepEqual(seqs, [1, 2], "Settlement sequences must be strictly 1 and 2");

    // Bot 1 rated games must be exactly 2
    const rating1 = env.matchRepo.getBotRating("ladder-main", "bot-1");
    assert.equal(rating1.rated_games, 2, "Bot 1 must have exactly 2 rated games");
    assert.equal(rating1.wins, 2, "Bot 1 must have exactly 2 wins");

    // Inspect rating_changes for bot 1: verify pre/post chain!
    const changes = env.db.prepare("SELECT * FROM rating_changes WHERE bot_id = 'bot-1' ORDER BY settlement_seq ASC").all();
    assert.equal(changes.length, 2);
    assert.equal(changes[0].before_rating, 1200.0);
    assert.equal(changes[1].before_rating, changes[0].after_rating, "Match 2 before_rating must match Match 1 after_rating (strict chain)");
    assert.equal(changes[1].after_rating, rating1.rating, "Final rating must match Match 2 after_rating");
  });
});
