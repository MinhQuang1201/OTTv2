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
    getEngine = null,
    getClock = null,
    getJournal = null,
    getEngineFingerprint = null,
    computeDigest = defaultComputeDigest,
    heartbeatIntervalMs = 5000,
    leaseDurationMs = 30000,
    pollIntervalMs = 500,
    allowedKinds = null
  } = options;

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

    if (botFactory) {
      botA = await botFactory("A", participants.A, { match, clock, supervisorSignal: supervisorAbort.signal });
      botB = await botFactory("B", participants.B, { match, clock, supervisorSignal: supervisorAbort.signal });
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
      supervisorSignal: supervisorAbort.signal
    });

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
      leaseDurationMs
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
