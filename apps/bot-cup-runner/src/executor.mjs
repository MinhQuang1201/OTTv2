/**
 * Runs Bot Cup jobs in the container sandbox (plan §8.3, §8.4): the syntax check in a child process, games with the
 * Arena match controller under bot-cup-policy-v1. Team code only ever runs inside containers; house bots run there too so
 * both seats get the same limits.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compactReplay, legalMovesOf, moveKey, tailText } from "../../../packages/bot-cup-core/src/index.mjs";
import { createHeadlessMatchController } from "../../../packages/arena/src/application/match-controller.mjs";
import { createCurrentRulesetSnapshot } from "../../../packages/arena/src/contracts/index.mjs";
import { createMapState } from "../../../packages/arena/src/domain/maps/index.mjs";
import { createNodeClock } from "../../../packages/arena-node/src/clock/node-clock.mjs";
import { coreConfig, createNodeEngine } from "../../../packages/arena-node/src/core/node-engine.mjs";
import { computeRulesetHash } from "../../../packages/arena-node/src/core/ruleset-identity.mjs";
import { computeSha256 } from "../../../packages/arena-node/src/artifacts/artifact-store.mjs";
import { createContainerBot } from "../../../packages/arena-node/src/execution/container-executor.mjs";

const CHECK_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-worker.mjs");
const STDERR_KEEP = 8 * 1024;
// A probe answer may arrive a little after the move limit (container I/O); later than this it counts as no answer.
const PROBE_SLACK_MS = 500;
// A bot that crashes or hangs is restarted for the remaining positions at most this many times per colour.
const PROBE_MAX_RESTARTS = 5;

/** An error the runner reports with /runner/fail: not the team's fault, retried on another lease. */
export class InfrastructureError extends Error {
  constructor(message) {
    super(message);
    this.name = "InfrastructureError";
  }
}

const NO_JOURNAL = Object.freeze({ init() {}, acceptedMove() {}, technicalEvent() {}, finish() {} });

/**
 * Spaces out game launches. Docker Desktop creates containers slowly when several start at once, and a container's
 * start-up is timed inside the bot's first move (5 s grace): in P4, four games launched together on a cold daemon all lost
 * their first move. One launch every `spacingMs` keeps start-up well inside the grace.
 */
export function createLaunchGate(spacingMs, { now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let next = 0;
  return async function launch() {
    const at = Math.max(now(), next);
    next = at + spacingMs;
    const wait = at - now();
    if (wait > 0) await sleep(wait);
  };
}

/** Runs one throw-away container so the first real game does not pay for a cold Docker daemon. */
export function warmUpContainer(image) {
  return new Promise((resolve) => {
    const proc = spawn("docker", ["run", "--rm", "--network", "none", image, "node", "-e", "0"], { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      resolve(false);
    }, 60_000);
    proc.once("error", () => { clearTimeout(timer); resolve(false); });
    proc.once("close", (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

/** py_compile wraps the SyntaxError in two tracebacks of its own; the team only needs the last part. */
export function compilerMessage(logs) {
  const marker = "py_compile.PyCompileError:";
  const index = logs.lastIndexOf(marker);
  return (index >= 0 ? logs.slice(index + marker.length) : logs).trim();
}

/** A first move that timed out before the bot moved at all is retried once (plan §8.4: start-up, not the team). */
export function isStartupTimeout(result, moves) {
  return result.outcome === "forfeit" && result.reason === "turn_timeout" && !moves.some((move) => move.seat === result.loser);
}

/**
 * @param {{ artifactStore: object, image: string, expectedImageId: string, probe: () => object,
 *           fetchSource: (sha256: string) => Promise<Uint8Array>, houseSources: Record<string, string>,
 *           probeSets?: Map<string, Array<object>>, createBot?: Function, runCheckProcess?: Function, launchSpacingMs?: number }} options
 *   probeSets: secret position sets on this machine by the SHA-256 of their file (plan §8.5)
 */
export function createExecutor({ artifactStore, image, expectedImageId, probe, fetchSource, houseSources, probeSets = new Map(), createBot = createContainerBot, runCheckProcess = spawnCheck, launchSpacingMs = 1000 }) {
  const houseDigests = new Map();
  const launch = createLaunchGate(launchSpacingMs);

  async function houseArtifact(name) {
    const entry = houseSources[name];
    if (!entry) throw new InfrastructureError(`unknown house bot ${name}`);
    const { source, profileId } = typeof entry === "string" ? { source: entry, profileId: "node" } : entry;
    if (!houseDigests.has(name)) houseDigests.set(name, (await artifactStore.storeArtifact("source", source)).digest);
    return { digest: houseDigests.get(name), profileId };
  }

  /** Downloads a submission once, refusing bytes whose SHA-256 is not the one the job names (plan §12 P4). */
  async function submissionArtifact({ sha256, language }) {
    const digest = `sha256:${sha256}`;
    if (!(await artifactStore.resolveArtifact(digest))) {
      const bytes = await fetchSource(sha256);
      if (computeSha256(bytes) !== digest) throw new InfrastructureError(`source ${sha256} failed its SHA-256 check`);
      await artifactStore.storeArtifact("source", bytes);
    }
    return { digest, profileId: language === "python" ? "python" : "node" };
  }

  const artifactFor = (seat) => (seat.house ? houseArtifact(seat.house) : submissionArtifact(seat.submission));

  async function runCheck(job) {
    const bytes = await fetchSource(job.submission.sha256);
    if (computeSha256(bytes) !== `sha256:${job.submission.sha256}`) throw new InfrastructureError("source failed its SHA-256 check");
    const result = await runCheckProcess({
      profileId: job.submission.language === "python" ? "python" : "node",
      sourceBase64: Buffer.from(bytes).toString("base64"),
      image,
      expectedImageId
    });
    if (result.status === "READY") return { ok: true, log: "Kiểm tra cú pháp: đạt." };
    if (result.error === "compile_failure" || result.error === "build_timeout") {
      // Container paths only (/bot/source.py); nothing about the host leaks into the team's log.
      return { ok: false, log: `Lỗi cú pháp:\n${compilerMessage(result.logs || result.error)}` };
    }
    throw new InfrastructureError(`check failed: ${result.error || "unknown"} ${result.logs || ""}`.trim());
  }

  async function playOnce(match, attempt) {
    const clock = createNodeClock();
    const snapshot = createCurrentRulesetSnapshot(coreConfig);
    const stderr = { A: "", B: "" };
    const moves = [];
    const seats = {};
    await launch();
    for (const seat of ["A", "B"]) {
      const artifact = await artifactFor(match.seats[seat]);
      seats[seat] = createBot({
        botId: `${match.id.slice(0, 8)}-${seat}-${attempt}`,
        profileId: artifact.profileId,
        artifactStore,
        artifactDigest: artifact.digest,
        image,
        probe,
        clock,
        attempt,
        onStderr: (chunk) => {
          stderr[seat] = tailText(stderr[seat] + String(chunk), STDERR_KEEP);
        }
      });
    }
    const result = await createHeadlessMatchController({
      matchId: match.id,
      engine: createNodeEngine(),
      botA: seats.A,
      botB: seats.B,
      clock,
      journal: NO_JOURNAL,
      policy: match.policy,
      rulesetSnapshot: snapshot,
      rulesetHash: computeRulesetHash(snapshot),
      engineRevision: "bot-cup-runner",
      initialState: createMapState(match.mapId),
      onAcceptedMove: (event) => moves.push({ seat: event.seat, from: event.move.from, to: event.move.to, elapsedMs: event.frame.elapsedMs })
    }).run();
    if (result.kind === "infrastructure_error") throw new InfrastructureError(`match ${result.code}`);
    return { result, moves, stderr };
  }

  async function runMatch(job) {
    let played = await playOnce(job.match, 0);
    if (isStartupTimeout(played.result, played.moves)) played = await playOnce(job.match, 1);
    return { replay: compactReplay({ mapId: job.match.mapId, moves: played.moves, result: played.result }), stderr: played.stderr };
  }

  /**
   * Behaviour fingerprint (plan §8.5): the bot answers each position of a secret set as if it were its turn in a game
   * (same protocol, same move limit, a full time bank). One container per colour; a crash or a hang costs that position
   * and the bot is started again for the rest. Illegal or missing answers are recorded as null.
   */
  async function runProbe(job) {
    const positions = probeSets.get(job.probe.set);
    if (!positions) throw new InfrastructureError(`probe set ${String(job.probe.set).slice(0, 12)} is not on this runner`);
    const policy = job.probe.policy;
    const artifact = job.probe.house ? await houseArtifact(job.probe.house) : await submissionArtifact(job.probe.submission);
    const snapshot = createCurrentRulesetSnapshot(coreConfig);
    const rulesetHash = computeRulesetHash(snapshot);
    const matchId = `probe-${job.jobId}`;
    const moves = positions.map(() => null);
    let answered = 0;
    let restarts = 0;
    for (const seat of ["A", "B"]) {
      const indexes = positions.flatMap((position, index) => (position.turn === seat ? [index] : []));
      let cursor = 0;
      let seatRestarts = 0;
      while (cursor < indexes.length && seatRestarts <= PROBE_MAX_RESTARTS) {
        await launch();
        const bot = createBot({
          botId: `${job.jobId.slice(0, 8)}-probe-${seat}-${seatRestarts}`,
          profileId: artifact.profileId,
          artifactStore,
          artifactDigest: artifact.digest,
          image,
          probe,
          clock: createNodeClock(),
          attempt: seatRestarts,
          onStderr: () => {}
        });
        let first = true;
        try {
          await bot.start({ matchId, seat, rulesetId: snapshot.rulesetId, rulesetHash, initialTimeMs: policy.initialTimeMs, turnTimeLimitMs: policy.turnTimeLimitMs });
          for (; cursor < indexes.length; cursor += 1) {
            const index = indexes[cursor];
            const position = positions[index];
            const legal = legalMovesOf(position);
            const limitMs = first ? policy.firstMoveGraceMs : policy.turnTimeLimitMs;
            const turn = {
              protocolVersion: 1, type: "turn", requestId: `${matchId}-${seat}-${cursor}`, matchId, rulesetId: snapshot.rulesetId, rulesetHash,
              boardWidth: snapshot.boardWidth, boardHeight: snapshot.boardHeight, ply: cursor + 1, turn: seat,
              timeRemainingMs: policy.initialTimeMs, turnTimeLimitMs: limitMs,
              board: position.pieces.map((piece) => ({ id: piece.id, owner: piece.player, type: piece.type, x: piece.x, y: piece.y })),
              legalMoves: legal.map((move) => ({ from: { x: move.from.x, y: move.from.y }, to: { x: move.to.x, y: move.to.y } }))
            };
            const action = await answerWithin(bot, turn, limitMs + PROBE_SLACK_MS);
            first = false;
            const key = moveKey(action?.move);
            if (key && legal.some((move) => moveKey(move) === key)) {
              moves[index] = key;
              answered += 1;
            }
          }
        } catch {
          // The position that broke the bot stays null; start a fresh container for the rest.
          cursor += 1;
          seatRestarts += 1;
          restarts += 1;
        } finally {
          await bot.stop().catch(() => {});
        }
      }
    }
    return { moves, answered, restarts };
  }

  return { runCheck, runMatch, runProbe };
}

/** The bot's action, or a thrown error when it does not answer in time (the caller restarts the container). */
async function answerWithin(bot, turn, limitMs) {
  const controller = new AbortController();
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("probe_timeout"));
    }, limitMs);
  });
  try {
    return await Promise.race([bot.requestMove(turn, controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function spawnCheck(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHECK_WORKER], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.once("error", (error) => reject(new InfrastructureError(`check worker: ${error.message}`)));
    child.once("close", (code) => {
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new InfrastructureError(`check worker exited ${code}: ${err.slice(-500)}`));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
