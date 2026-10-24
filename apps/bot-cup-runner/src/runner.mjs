/**
 * The runner loop (plan §3.2, §9.1): keep up to `slots` jobs running, claim more as soon as one finishes, poll slowly when
 * the queue is empty, send a heartbeat every 30 s. Everything outside is injected, so the loop is tested without Docker.
 */
import { InfrastructureError } from "./executor.mjs";

export function createRunner({ client, executor, slots = 4, pollMs = 15_000, heartbeatMs = 30_000, info = {}, log = () => {}, timers = globalThis }) {
  const active = new Map();
  let running = false;
  let pollTimer = null;
  let heartbeatTimer = null;
  let claiming = false;
  let wake = null;

  async function sendHeartbeat() {
    try {
      await client.heartbeat({ ...info, slots, active: active.size });
    } catch (error) {
      log("heartbeat_failed", { message: error.message });
    }
  }

  async function handle(job) {
    const started = Date.now();
    try {
      if (job.kind === "check") {
        const checked = await executor.runCheck(job);
        await client.complete({ jobId: job.jobId, attempt: job.attempt, ok: checked.ok, log: checked.log });
        log("check_done", { jobId: job.jobId, ok: checked.ok, ms: Date.now() - started });
      } else {
        const played = await executor.runMatch(job);
        const answer = await client.complete({ jobId: job.jobId, attempt: job.attempt, replay: played.replay, stderr: played.stderr });
        log("match_done", { jobId: job.jobId, result: answer.result ?? played.replay.result, ms: Date.now() - started });
      }
    } catch (error) {
      const infrastructure = error instanceof InfrastructureError || !("status" in error);
      log(infrastructure ? "job_infrastructure_error" : "job_report_refused", { jobId: job.jobId, message: error.message });
      if (infrastructure) {
        try {
          await client.fail({ jobId: job.jobId, attempt: job.attempt, detail: String(error.message).slice(0, 1000) });
        } catch (failError) {
          // The lease will expire and the job will come back; nothing else to do here.
          log("fail_report_failed", { jobId: job.jobId, message: failError.message });
        }
      }
    }
  }

  async function fill() {
    if (!running || claiming || active.size >= slots) return;
    claiming = true;
    let jobs = [];
    try {
      jobs = await client.claim(slots - active.size);
    } catch (error) {
      log("claim_failed", { message: error.message, code: error.code });
    } finally {
      claiming = false;
    }
    for (const job of jobs) {
      const done = handle(job).finally(() => {
        active.delete(job.jobId);
        // A free slot is filled right away instead of waiting for the next poll.
        if (running) fill();
        if (wake && active.size === 0) wake();
      });
      active.set(job.jobId, done);
    }
  }

  function schedulePoll() {
    pollTimer = timers.setTimeout(async () => {
      await fill();
      if (running) schedulePoll();
    }, pollMs);
  }

  return {
    get active() {
      return active.size;
    },
    async start() {
      running = true;
      await sendHeartbeat();
      heartbeatTimer = timers.setInterval(sendHeartbeat, heartbeatMs);
      await fill();
      schedulePoll();
    },
    /** Stops claiming and waits for the jobs in hand to finish. */
    async stop() {
      running = false;
      timers.clearTimeout(pollTimer);
      timers.clearInterval(heartbeatTimer);
      if (active.size) await new Promise((resolve) => { wake = resolve; });
    },
    fill
  };
}
