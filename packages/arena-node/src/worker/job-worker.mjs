/**
 * packages/arena-node/src/worker/job-worker.mjs
 *
 * Task 12 (Milestone M3): Job worker and dispatcher for OTTv2 Arena.
 *
 * Responsibilities:
 * - Dispatches 'build' and 'match' jobs from JobQueue.
 * - STRICTLY NO SQLite transaction held across child process spawns or bot turn execution.
 * - Heartbeat timer independent of bot turn clock.
 * - Graceful stop: aborts bots and releases lease without awarding forfeit loss or mutating Elo.
 * - Fenced completion: passes leaseToken and attemptNo to finalizer. If lease lost/expired,
 *   aborts local attempt and does not settle.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHeadlessMatchController } from "../../../arena/src/application/match-controller.mjs";
import { createReplayJournal } from "../../../arena/src/application/replay-journal.mjs";
import {
  computeCompletionPayload,
  computeCompletionDigest,
  StaleLeaseError
} from "../../../arena/src/application/finalize-match.mjs";
import {
  computeRulesetHash,
  computeCurrentEngineFingerprint,
  computeReplayDigest
} from "../core/ruleset-identity.mjs";
import { createNodeEngine } from "../core/node-engine.mjs";
import { createNodeClock } from "../clock/node-clock.mjs";
import { canonicalSerialize } from "../../../arena/src/domain/ruleset.mjs";
import { createContainerBot } from "../execution/container-executor.mjs";

function defaultComputeDigest(data) {
  const str = typeof data === "string" ? data : canonicalSerialize(data);
  return `sha256:${createHash("sha256").update(str, "utf8").digest("hex")}`;
}

/**
 * Creates an Arena JobWorker.
 *
 * @param {object} options
 * @param {string} options.workerId
 * @param {import('better-sqlite3').Database} options.db
 * @param {import('../persistence/job-queue.d.mts').JobQueue} options.jobQueue
 * @param {object} options.matchRepo
 * @param {object} [options.finalizer]
 * @param {object} [options.botVersionService]
 * @param {(seat: "A" | "B", participant: object, context: object) => Promise<object> | object} [options.botFactory]
 * @param {() => object} [options.getEngine]
 * @param {() => object} [options.getClock]
 * @param {() => object} [options.getJournal]
 * @param {() => string} [options.getEngineFingerprint]
 * @param {(val: string) => string} [options.computeDigest]
 * @param {number} [options.heartbeatIntervalMs=5000]
 * @param {number} [options.leaseDurationMs=30000]
 * @param {number} [options.pollIntervalMs=500]
 * @param {string[]} [options.allowedKinds=null]
 */
export function createJobWorker(options) {
  if (!options) {
    throw new TypeError("createJobWorker requires options");
  }
  const {
    workerId,
    db,
    jobQueue,
    matchRepo,
    finalizer = null,
    botVersionService = null,
    botFactory = null,
    artifactStore = null,
    profileRegistry = null,
    getEngine = null,
    getClock = null,
    getJournal = null,
    getEngineFingerprint = null,
    computeDigest = defaultComputeDigest,
    heartbeatIntervalMs = 5000,
    leaseDurationMs = 30000,
    pollIntervalMs = 500,
    allowedKinds = null,
    liveFrameStore = null
  } = options;

  const resolvedBotFactory =
    botFactory ||
    (artifactStore && profileRegistry
      ? createProfileBotFactory({ artifactStore, profileRegistry })
      : null);

  if (!workerId) throw new TypeError("options.workerId is required");
  if (!db) throw new TypeError("options.db is required");
  if (!jobQueue) throw new TypeError("options.jobQueue is required");
  if (!matchRepo) throw new TypeError("options.matchRepo is required");

  let isRunning = false;
  let isStopping = false;
  let currentJob = null;
  let currentAbortController = null;
  let pollTimeoutHandle = null;

  /**
   * Executes a single claimed match job.
   * STRICTLY NO SQLite transaction held while child processes are spawned or turns are executed.
   */
  async function executeMatchJob(claim, supervisorAbort) {
    const match = matchRepo.getMatch(claim.targetId);
    if (!match) {
      throw new Error(`Match not found: ${claim.targetId}`);
    }

    if (match.status === "completed" || match.status === "cancelled") {
      return { skipped: true, status: match.status };
    }

    let rulesetSnapshot;
    let matchPolicy;
    let initialCoreState;

    try {
      rulesetSnapshot = typeof match.ruleset_json === "string" ? JSON.parse(match.ruleset_json) : match.ruleset_json;
      matchPolicy = typeof match.policy_json === "string" ? JSON.parse(match.policy_json) : match.policy_json;
      initialCoreState = typeof match.initial_state_json === "string" ? JSON.parse(match.initial_state_json) : match.initial_state_json;
    } catch (err) {
      throw new Error(`Failed parsing match configuration JSON: ${err.message}`);
    }

    const rulesetHash = computeRulesetHash(rulesetSnapshot);
    const engineRevision = getEngineFingerprint ? getEngineFingerprint() : computeCurrentEngineFingerprint();

    const engine = getEngine ? getEngine() : createNodeEngine();
    const clock = getClock ? getClock() : createNodeClock();
    const journal = getJournal ? getJournal() : createReplayJournal();

    const participants = match.participants;
    if (!participants || !participants.A || !participants.B) {
      throw new Error(`Match ${match.id} missing participants`);
    }

    let botA;
    let botB;

    if (resolvedBotFactory) {
      botA = await resolvedBotFactory("A", participants.A, { match, clock, supervisorSignal: supervisorAbort.signal });
      botB = await resolvedBotFactory("B", participants.B, { match, clock, supervisorSignal: supervisorAbort.signal });
    } else {
      const { createFunctionBot } = await import("../../../arena/src/adapters/function-bot.mjs");
      botA = createFunctionBot({ botId: participants.A.bot_id });
      botB = createFunctionBot({ botId: participants.B.bot_id });
    }

    const controller = createHeadlessMatchController({
      matchId: match.id,
      engine,
      botA,
      botB,
      clock,
      journal,
      policy: matchPolicy,
      rulesetSnapshot,
      rulesetHash,
      engineRevision,
      participants: {
        A: {
          botId: participants.A.bot_id,
          botVersionId: participants.A.bot_version_id,
          artifactDigest: participants.A.artifact_digest,
          profileId: participants.A.profile_id,
          profileRevision: participants.A.profile_revision
        },
        B: {
          botId: participants.B.bot_id,
          botVersionId: participants.B.bot_version_id,
          artifactDigest: participants.B.artifact_digest,
          profileId: participants.B.profile_id,
          profileRevision: participants.B.profile_revision
        }
      },
      initialState: initialCoreState,
      supervisorSignal: supervisorAbort.signal,
      onAcceptedMove: liveFrameStore
        ? (evt) => {
            try {
              const clock = evt.frame?.clock || evt.frame?.state?.clock || {
                remainingMs: {
                  A: evt.frame?.state?.clock?.remainingMs?.A,
                  B: evt.frame?.state?.clock?.remainingMs?.B
                }
              };
              const frameWithClock = {
                ...evt.frame,
                clock
              };
              liveFrameStore.recordFrame({
                matchId: match.id,
                attemptNo: claim.attemptNo,
                leaseToken: claim.leaseToken,
                ply: evt.ply,
                seat: evt.seat,
                move: evt.move,
                frame: frameWithClock
              });
            } catch (_) {}
          }
        : undefined
    });

    if (liveFrameStore) {
      try {
        liveFrameStore.recordFrame({
          matchId: match.id,
          attemptNo: claim.attemptNo,
          leaseToken: claim.leaseToken,
          ply: 0,
          seat: null,
          move: null,
          frame: {
            ply: 0,
            seat: null,
            move: null,
            clock: initialCoreState?.clock || {
              remainingMs: {
                A: matchPolicy.initialTimeMs,
                B: matchPolicy.initialTimeMs
              }
            },
            state: initialCoreState
          }
        });
      } catch (_) {}
    }

    let matchResult;
    try {
      matchResult = await controller.run();
    } catch (runErr) {
      if (isStopping || supervisorAbort.signal.aborted) {
        return null;
      }
      throw runErr;
    }

    if (isStopping || supervisorAbort.signal.aborted) {
      return null;
    }

    if (!finalizer) {
      return matchResult;
    }

    // Prepare completion envelope
    const replay = journal.getDocument();
    if (!replay) {
      throw new Error(`Replay journal failed to produce finalized document for match ${match.id}`);
    }

    const replayDigest = computeReplayDigest(replay);
    const completionPayload = computeCompletionPayload({
      matchId: match.id,
      result: matchResult,
      replayDigest
    });
    const completionDigest = computeCompletionDigest(completionPayload, computeDigest);

    const envelope = {
      matchId: match.id,
      result: matchResult,
      replay,
      replayDigest,
      completionDigest,
      attemptNo: claim.attemptNo,
      leaseToken: claim.leaseToken
    };

    try {
      const finalized = await finalizer.finalizeMatch(envelope);
      return finalized;
    } catch (finErr) {
      if (finErr instanceof StaleLeaseError || finErr.name === "StaleLeaseError") {
        // Lease was lost, expired, or overtaken. Abort local attempt and do not settle.
        return null;
      }
      throw finErr;
    }
  }

  /**
   * Executes a single claimed build job.
   */
  async function executeBuildJob(claim, _supervisorAbort) {
    if (!botVersionService) {
      throw new Error(`Worker cannot execute build job without botVersionService`);
    }
    return await botVersionService.processBuildJob({
      jobId: claim.jobId,
      leaseOwner: workerId,
      leaseDurationMs,
      claimedLease: claim
    });
  }

  /**
   * Claims and executes a single job to completion if one is available in the queue.
   */
  async function runOnce() {
    if (isStopping) return { executed: false, claim: null };

    const claim = jobQueue.claimNextJob({
      workerId,
      leaseDurationMs,
      allowedKinds
    });

    if (!claim) {
      return { executed: false, claim: null };
    }

    currentJob = claim;
    const supervisorAbort = new AbortController();
    currentAbortController = supervisorAbort;

    let heartbeatTimer = null;
    let heartbeatFailed = false;

    // Independent heartbeat timer
    heartbeatTimer = setInterval(() => {
      if (isStopping || heartbeatFailed) return;
      try {
        const ok = jobQueue.heartbeatJob({
          jobId: claim.jobId,
          leaseToken: claim.leaseToken,
          attemptNo: claim.attemptNo,
          extendDurationMs: leaseDurationMs
        });
        if (!ok) {
          heartbeatFailed = true;
          supervisorAbort.abort(new Error("Lease lost or expired"));
        }
      } catch (hbErr) {
        heartbeatFailed = true;
        supervisorAbort.abort(hbErr);
      }
    }, heartbeatIntervalMs);

    let result = null;
    let error = null;

    try {
      if (claim.kind === "match") {
        result = await executeMatchJob(claim, supervisorAbort);
      } else if (claim.kind === "build") {
        result = await executeBuildJob(claim, supervisorAbort);
      } else {
        throw new Error(`Unsupported job kind: ${claim.kind}`);
      }
    } catch (err) {
      error = err;
    } finally {
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      currentAbortController = null;
      currentJob = null;
    }

    if (error && !isStopping && !heartbeatFailed) {
      throw error;
    }

    return {
      executed: true,
      claim,
      result,
      error
    };
  }

  /**
   * Starts continuous background polling and job dispatching.
   */
  function start() {
    if (isRunning) return;
    isRunning = true;
    isStopping = false;

    async function pollLoop() {
      if (!isRunning || isStopping) return;

      try {
        await runOnce();
      } catch (_) {
        // Suppress unhandled exceptions in background poll loop to prevent crash
      }

      if (isRunning && !isStopping) {
        pollTimeoutHandle = setTimeout(pollLoop, pollIntervalMs);
      }
    }

    pollLoop();
  }

  /**
   * Gracefully stops the worker:
   * aborts any active bot processes, releases the lease back to 'queued'
   * without awarding forfeit loss or mutating Elo.
   */
  async function stop() {
    isStopping = true;
    isRunning = false;

    if (pollTimeoutHandle !== null) {
      clearTimeout(pollTimeoutHandle);
      pollTimeoutHandle = null;
    }

    if (currentAbortController) {
      currentAbortController.abort(new Error("Worker stopping"));
    }

    if (currentJob) {
      try {
        jobQueue.releaseJob({
          jobId: currentJob.jobId,
          leaseToken: currentJob.leaseToken,
          attemptNo: currentJob.attemptNo,
          reason: "graceful_stop"
        });
      } catch (_) {}
    }
  }

  function getStatus() {
    return {
      workerId,
      state: isStopping ? "stopping" : isRunning ? "running" : "idle",
      currentJob: currentJob ? { ...currentJob } : null
    };
  }

  return {
    start,
    stop,
    runOnce,
    getStatus
  };
}

/**
 * Creates a BotFactory that delegates to pinned execution profiles in ProfileRegistry.
 * Supports Python, Node, C++, Java, etc. according to participant profileId,
 * handles Node 18 extensionless ESM artifacts, and provides a sanitized environment
 * without leaking host secrets or environment tokens.
 *
 * @param {object} options
 * @param {import('../artifacts/artifact-store.d.mts').ArtifactStore} options.artifactStore
 * @param {import('../execution/profile-registry.d.mts').ProfileRegistry} options.profileRegistry
 * @returns {(seat: "A" | "B", participant: object, context?: object) => Promise<object>}
 */
export function createProfileBotFactory({ artifactStore, profileRegistry, containerExecutor = null }) {
  if (!artifactStore) throw new TypeError("createProfileBotFactory requires artifactStore");
  if (!profileRegistry) throw new TypeError("createProfileBotFactory requires profileRegistry");

  return async function profileBotFactory(seat, participant, context = {}) {
    const digest = participant.artifactDigest || participant.artifact_digest;
    const botId = participant.botId || participant.bot_id || `bot-${seat}`;
    const profileId = participant.profileId || participant.profile_id || "node";

    const artifact = await artifactStore.resolveArtifact(digest);
    if (!artifact) {
      throw new Error(`Artifact not found for participant ${seat} (${digest})`);
    }

    const profile = profileRegistry.getProfile(profileId);
    if (!profile) {
      throw new Error(`Execution profile not found: ${profileId}`);
    }

    if (containerExecutor) {
      if (profileId !== "python" && profileId !== "node") {
        const err = new Error(`ContainerBot does not support profile '${profileId}'. Scoped profiles: 'python', 'node'.`);
        err.kind = "infrastructure_error";
        err.code = "unsupported_isolated_profile";
        err.retryable = false;
        throw err;
      }
      const probe = containerExecutor.probe ? containerExecutor.probe() : null;
      if (probe && !probe.available) {
        const err = new Error(`Container runtime unavailable: ${probe.reason || "daemon or image missing"}`);
        err.kind = "infrastructure_error";
        err.code = "runtime_unavailable";
        err.retryable = false;
        throw err;
      }
      return createContainerBot({
        botId,
        profileId,
        artifactStore,
        artifactDigest: digest,
        image: containerExecutor.image,
        commandRunner: containerExecutor.commandRunner,
        limits: containerExecutor.limits,
        probe: containerExecutor.probe
      });
    }

    // Sanitized bot environment — DO NOT leak secrets or auth tokens from host process.env
    const botEnv = {
      NODE_ENV: process.env.NODE_ENV || "production",
      PATH: process.env.PATH || "",
      SYSTEMROOT: process.env.SYSTEMROOT || "",
      WINDIR: process.env.WINDIR || "",
      HOMEPATH: process.env.HOMEPATH || "",
      USERPROFILE: process.env.USERPROFILE || "",
      TMP: process.env.TMP || "",
      TEMP: process.env.TEMP || "",
      ARENA_STRICT_TERMINATION: "1"
    };

    let targetPath = artifact.path;
    // Node 18 ESM handling: Node fails on extensionless files without package.json type=module.
    // If the profile is node/javascript and targetPath lacks .mjs or .js, link/copy with .mjs.
    if (
      (profileId === "node" || profile.language === "javascript") &&
      !targetPath.endsWith(".mjs") &&
      !targetPath.endsWith(".js")
    ) {
      const extPath = `${targetPath}.mjs`;
      if (!fs.existsSync(extPath)) {
        try {
          fs.linkSync(targetPath, extPath);
        } catch (_) {
          fs.copyFileSync(targetPath, extPath);
        }
      }
      targetPath = extPath;
    }

    return profile.createBot(targetPath, {
      botId,
      env: botEnv,
      clock: context?.clock,
      supervisorSignal: context?.supervisorSignal
    });
  };
}

/**
 * CLI runner for standalone worker process (`arena:worker`).
 *
 * @param {string[]} args
 */
export async function runWorkerCli(args = []) {
  let dbPath = process.env.ARENA_DB_PATH || path.resolve(process.cwd(), "var/arena/arena.db");
  let storageDir = process.env.ARENA_STORAGE_DIR || path.resolve(process.cwd(), "var/arena/artifacts");
  let workerId = process.env.ARENA_WORKER_ID || `worker-${os.hostname()}-${process.pid}`;
  let pollIntervalMs = process.env.ARENA_POLL_INTERVAL_MS ? parseInt(process.env.ARENA_POLL_INTERVAL_MS, 10) : 1000;
  let leaseDurationMs = process.env.ARENA_LEASE_DURATION_MS ? parseInt(process.env.ARENA_LEASE_DURATION_MS, 10) : 30000;
  let heartbeatIntervalMs = process.env.ARENA_HEARTBEAT_INTERVAL_MS ? parseInt(process.env.ARENA_HEARTBEAT_INTERVAL_MS, 10) : 5000;
  let allowedKinds = process.env.ARENA_ALLOWED_KINDS ? process.env.ARENA_ALLOWED_KINDS.split(",") : ["build", "match"];
  const localDemoContainers = process.env.ARENA_LOCAL_DEMO_CONTAINERS === "true" || process.env.ARENA_LOCAL_DEMO_CONTAINERS === "1";
  let once = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--db" && i + 1 < args.length) {
      dbPath = path.resolve(args[++i]);
    } else if (arg === "--storage" && i + 1 < args.length) {
      storageDir = path.resolve(args[++i]);
    } else if (arg === "--worker-id" && i + 1 < args.length) {
      workerId = args[++i];
    } else if (arg === "--kinds" && i + 1 < args.length) {
      allowedKinds = args[++i].split(",");
    } else if (arg === "--poll-interval" && i + 1 < args.length) {
      pollIntervalMs = parseInt(args[++i], 10);
    } else if (arg === "--lease-duration" && i + 1 < args.length) {
      leaseDurationMs = parseInt(args[++i], 10);
    } else if (arg === "--heartbeat-interval" && i + 1 < args.length) {
      heartbeatIntervalMs = parseInt(args[++i], 10);
    } else if (arg === "--once") {
      once = true;
    }
  }

  const { openDatabase, closeDatabase } = await import("../persistence/sqlite-database.mjs");
  const { createArtifactStore } = await import("../artifacts/artifact-store.mjs");
  const { createProfileRegistry } = await import("../execution/profile-registry.mjs");
  const { createBuildService } = await import("../execution/build-service.mjs");
  const { probeContainerRuntime, createContainerBuildService } = await import("../execution/container-executor.mjs");
  const { createBotVersionService } = await import("../persistence/bot-version-service.mjs");
  const { createMatchRepository } = await import("../persistence/match-repository.mjs");
  const { createJobQueue } = await import("../persistence/job-queue.mjs");
  const { createMatchFinalizer } = await import("../persistence/finalizer.mjs");
  const { createLiveFrameStore } = await import("../persistence/live-frame-store.mjs");

  const opened = openDatabase(dbPath, { targetVersion: "latest" });
  const db = opened.db || opened;
  const artifactStore = createArtifactStore({ storageDir });
  const profileRegistry = createProfileRegistry();
  const executionCapabilities = localDemoContainers ? probeContainerRuntime() : null;
  const containerExecutor = localDemoContainers
    ? { image: executionCapabilities?.image, probe: () => probeContainerRuntime() }
    : null;
  const buildService = localDemoContainers
    ? createContainerBuildService({ artifactStore, image: executionCapabilities?.image, probe: () => probeContainerRuntime() })
    : createBuildService({ artifactStore, profileRegistry });
  const botVersionService = createBotVersionService({
    db,
    artifactStore,
    buildService,
    profileRegistry
  });

  const matchRepo = createMatchRepository(db);
  const jobQueue = createJobQueue(db);
  const finalizer = createMatchFinalizer(db);
  const botFactory = createProfileBotFactory({ artifactStore, profileRegistry, containerExecutor });

  const hasLiveFramesTable = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'match_live_frames'").get()
  );
  const liveFrameStore = hasLiveFramesTable ? createLiveFrameStore(db) : null;

  const worker = createJobWorker({
    workerId,
    db,
    jobQueue,
    matchRepo,
    finalizer,
    botVersionService,
    botFactory,
    liveFrameStore,
    allowedKinds,
    pollIntervalMs,
    leaseDurationMs,
    heartbeatIntervalMs
  });

  if (once) {
    const res = await worker.runOnce();
    console.log(`[arena:worker] runOnce finished:`, res.executed ? `executed ${res.claim.jobId}` : "idle");
    closeDatabase(db);
    return;
  }

  console.log(`[arena:worker] Worker ${workerId} active on ${dbPath} (kinds: ${allowedKinds.join(", ")})`);
  worker.start();

  const shutdown = async () => {
    console.log(`\n[arena:worker] Stopping worker ${workerId}...`);
    await worker.stop();
    closeDatabase(db);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain =
  process.argv[1] &&
  (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
    process.argv[1].endsWith("packages/arena-node/src/worker/job-worker.mjs") ||
    process.argv[1].endsWith("packages\\arena-node\\src\\worker\\job-worker.mjs"));

if (isMain) {
  runWorkerCli(process.argv.slice(2)).catch((err) => {
    console.error("[arena:worker] Fatal error:", err);
    process.exit(1);
  });
}


