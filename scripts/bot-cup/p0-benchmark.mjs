#!/usr/bin/env node
/**
 * P0 benchmark for the Bot Cup plan (docs/superpowers/plans/2026-10-23-uet-k71-bot-cup.md §9.1, §12 P0).
 *
 * Runs real container matches on this machine with the Bot Cup timing (500 ms/turn, 30 s bank; 400 plies until P4).
 *
 *   node scripts/bot-cup/p0-benchmark.mjs throughput --games 24 --concurrency 4
 *   node scripts/bot-cup/p0-benchmark.mjs jitter --sleep 450 --plies 300 --concurrency 4 --lang node
 *   node scripts/bot-cup/p0-benchmark.mjs throughput --games 48 --concurrency 8 --referee-limit 5000 --bot-budget 175
 *
 * --referee-limit raises the referee's per-turn limit (default 500) and --bot-budget pins the house bots' thinking
 * time, so a run can measure cold-start latency and throughput without the first turn being judged a timeout.
 *
 * throughput: strategist vs sentinel (bots/), colours swapped, maps rotated. Reports seconds per game and games/hour.
 * jitter:     bots that sleep --sleep ms and then play a random legal move. Reports how much the referee's measured
 *             elapsedMs exceeds the sleep, and how many turns were judged as timeouts.
 *
 * Results are printed and written to var/bot-cup/p0/<mode>-<timestamp>.json.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createContainerBot, createContainerBuildService, probeContainerRuntime, PINNED_RUNNER_IMAGE } from "../../packages/arena-node/src/execution/container-executor.mjs";
import { createNodeEngine, coreConfig } from "../../packages/arena-node/src/core/node-engine.mjs";
import { createHeadlessMatchController } from "../../packages/arena/src/application/match-controller.mjs";
import { createReplayJournal } from "../../packages/arena/src/application/replay-journal.mjs";
import { createNodeClock } from "../../packages/arena-node/src/clock/node-clock.mjs";
import { createArtifactStore } from "../../packages/arena-node/src/artifacts/artifact-store.mjs";
import { createCurrentRulesetSnapshot } from "../../packages/arena/src/contracts/index.mjs";
import { computeRulesetHash } from "../../packages/arena-node/src/core/ruleset-identity.mjs";
import { DEFAULT_MATCH_POLICY } from "../../packages/arena/src/domain/match-policy.mjs";
import { createMapState } from "../../packages/arena/src/domain/maps/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAPS = ["classic", "flanks", "center"];

// Bot Cup policy (plan §7.3). The controller takes clocks from the initial state, so the bank is set there too.
// arena-policy-v1 only accepts maxPlies 400; the planned 300 needs bot-cup-policy-v1 (P4), so P0 measures with 400.
const BANK_MS = 30000;
let POLICY = { ...DEFAULT_MATCH_POLICY, turnTimeLimitMs: 500, initialTimeMs: BANK_MS };

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const opts = { mode, games: 24, concurrency: 4, sleep: 450, plies: 300, lang: "node" };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].replace(/^--/, "");
    const value = rest[i + 1];
    opts[key.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = key === "lang" ? value : Number(value);
  }
  if (!["throughput", "jitter"].includes(opts.mode)) {
    throw new Error("Usage: p0-benchmark.mjs <throughput|jitter> [--games N] [--concurrency C] [--sleep MS] [--plies N] [--lang node|python]");
  }
  return opts;
}

function sleeperSource(lang, sleepMs) {
  if (lang === "python") {
    return [
      "import json, random, sys, time",
      "for line in sys.stdin:",
      "    line = line.strip()",
      "    if not line:",
      "        continue",
      "    turn = json.loads(line)",
      "    if turn.get('type') != 'turn' or not turn.get('legalMoves'):",
      "        continue",
      `    time.sleep(${sleepMs / 1000})`,
      "    move = random.choice(turn['legalMoves'])",
      "    sys.stdout.write(json.dumps({'protocolVersion': 1, 'requestId': turn['requestId'], 'move': move}) + '\\n')",
      "    sys.stdout.flush()",
      ""
    ].join("\n");
  }
  return [
    'import readline from "node:readline";',
    "const rl = readline.createInterface({ input: process.stdin, terminal: false });",
    'rl.on("line", (line) => {',
    "  const turn = line.trim() ? JSON.parse(line) : null;",
    '  if (!turn || turn.type !== "turn" || !turn.legalMoves || !turn.legalMoves.length) return;',
    "  setTimeout(() => {",
    "    const move = turn.legalMoves[Math.floor(Math.random() * turn.legalMoves.length)];",
    '    process.stdout.write(JSON.stringify({ protocolVersion: 1, requestId: turn.requestId, move }) + "\\n");',
    `  }, ${sleepMs});`,
    "});",
    ""
  ].join("\n");
}

async function build(buildService, sourceContent, profileId) {
  const result = await buildService.build({ sourceContent, profileId });
  if (result.status !== "READY") throw new Error(`build failed for ${profileId}: ${JSON.stringify(result).slice(0, 400)}`);
  return { ...result, profileId };
}

// Pins the thinking time of bots/strategist.mjs and bots/sentinel.mjs, which otherwise derive it from turnTimeLimitMs.
const withBudget = (source, budgetMs) => (budgetMs ? source.replace(/options\.budgetMs \?\?/g, `options.budgetMs ?? ${budgetMs} ??`) : source);

async function playOne({ index, artifactStore, a, b, mapId, onMove }) {
  const clock = createNodeClock();
  const engine = createNodeEngine(coreConfig);
  const snapshot = createCurrentRulesetSnapshot(coreConfig);
  const rulesetHash = computeRulesetHash(snapshot);
  const matchId = `p0-${index}`;
  const bot = (side, artifact) => createContainerBot({
    botId: `${matchId}-${side}`,
    profileId: artifact.profileId,
    artifactStore,
    artifactDigest: artifact.artifactDigest,
    expectedManifest: artifact.manifest,
    clock
  });
  const moves = [];
  const initialState = createMapState(mapId);
  initialState.clock.remainingMs = { A: BANK_MS, B: BANK_MS };
  const controller = createHeadlessMatchController({
    matchId,
    engine,
    botA: bot("A", a),
    botB: bot("B", b),
    journal: createReplayJournal({ matchId, policyId: POLICY.matchPolicyVersion, rulesetId: snapshot.rulesetId, engineFingerprint: "p0-benchmark", rulesetHash }),
    clock,
    policy: POLICY,
    rulesetSnapshot: snapshot,
    rulesetHash,
    initialState,
    onAcceptedMove: (event) => {
      moves.push({ ply: event.ply, elapsedMs: event.frame.elapsedMs });
      onMove?.(event);
    }
  });
  const started = performance.now();
  const result = await controller.run();
  const turns = moves.map((m) => m.elapsedMs);
  return {
    index,
    mapId,
    seconds: (performance.now() - started) / 1000,
    outcome: result.outcome || result.kind,
    winner: result.winner ?? null,
    reason: result.reason || result.code || null,
    plies: result.acceptedPlies ?? null,
    firstTurnsMs: turns.slice(0, 2).map((ms) => Math.round(ms)),
    // Time spent outside bot turns: container create/start/stop and referee work.
    lifecycleSeconds: (performance.now() - started - turns.reduce((sum, ms) => sum + ms, 0)) / 1000
  };
}

async function pool(total, concurrency, task) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < total) {
      const index = next++;
      results.push(await task(index));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  return results.sort((x, y) => x.index - y.index);
}

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const round = (n, digits = 1) => (n === null ? null : Number(n.toFixed(digits)));
const countBy = (items, key) => items.reduce((acc, item) => ({ ...acc, [item[key]]: (acc[item[key]] || 0) + 1 }), {});

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.refereeLimit) POLICY = { ...POLICY, turnTimeLimitMs: opts.refereeLimit };
  const probe = probeContainerRuntime({ image: PINNED_RUNNER_IMAGE });
  if (!probe.available) throw new Error(`container runtime unavailable: ${probe.reason}`);

  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-cup-p0-"));
  const artifactStore = createArtifactStore({ storageDir: storeDir });
  const buildService = createContainerBuildService({ artifactStore });
  const host = { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memGb: round(os.totalmem() / 2 ** 30), docker: probe.dockerVersion, imageId: probe.imageId };
  const wallStart = performance.now();
  let summary;

  try {
    if (opts.mode === "throughput") {
      const source = (file) => withBudget(fs.readFileSync(path.join(ROOT, file), "utf8"), opts.botBudget);
      const strategist = await build(buildService, source("bots/strategist.mjs"), "node");
      const sentinel = await build(buildService, source("bots/sentinel.mjs"), "node");
      const games = await pool(opts.games, opts.concurrency, (index) => {
        const swap = index % 2 === 1;
        return playOne({ index, artifactStore, a: swap ? sentinel : strategist, b: swap ? strategist : sentinel, mapId: MAPS[Math.floor(index / 2) % MAPS.length] });
      });
      const wallSeconds = (performance.now() - wallStart) / 1000;
      const seconds = games.map((g) => g.seconds);
      const firstTurns = games.flatMap((g) => g.firstTurnsMs);
      const lifecycle = games.map((g) => g.lifecycleSeconds);
      summary = {
        mode: "throughput", policy: POLICY, host, gameCount: opts.games, concurrency: opts.concurrency, botBudgetMs: opts.botBudget ?? null,
        firstTurnMs: { p50: percentile(firstTurns, 50), p95: percentile(firstTurns, 95), max: firstTurns.length ? Math.max(...firstTurns) : null },
        lifecycleSecondsPerGame: { p50: round(percentile(lifecycle, 50)), p95: round(percentile(lifecycle, 95)) },
        wallSeconds: round(wallSeconds),
        gamesPerHour: Math.round((opts.games / wallSeconds) * 3600),
        secondsPerGame: { p50: round(percentile(seconds, 50)), p95: round(percentile(seconds, 95)), max: round(Math.max(...seconds)) },
        pliesPerGame: { p50: percentile(games.map((g) => g.plies ?? 0), 50), max: Math.max(...games.map((g) => g.plies ?? 0)) },
        outcomes: countBy(games, "outcome"), reasons: countBy(games, "reason"),
        games
      };
    } else {
      const sleeper = await build(buildService, sleeperSource(opts.lang, opts.sleep), opts.lang);
      const overheads = [];
      const games = [];
      let index = 0;
      while (overheads.length < opts.plies) {
        const batch = await pool(opts.concurrency, opts.concurrency, (i) => playOne({
          index: index + i, artifactStore, a: sleeper, b: sleeper, mapId: "classic",
          onMove: ({ frame }) => overheads.push(frame.elapsedMs - opts.sleep)
        }));
        index += batch.length;
        games.push(...batch);
      }
      const timeouts = games.filter((g) => g.reason && /timeout/i.test(String(g.reason)));
      summary = {
        mode: "jitter", policy: POLICY, host, lang: opts.lang, sleepMs: opts.sleep, concurrency: opts.concurrency,
        acceptedTurns: overheads.length,
        overheadMs: { p50: round(percentile(overheads, 50)), p95: round(percentile(overheads, 95)), p99: round(percentile(overheads, 99)), max: round(Math.max(...overheads)) },
        gamesEndedByTimeout: timeouts.length, gameCount: games.length,
        outcomes: countBy(games, "outcome"), reasons: countBy(games, "reason")
      };
    }
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }

  const outDir = path.join(ROOT, "var/bot-cup/p0");
  fs.mkdirSync(outDir, { recursive: true });
  const label = opts.mode === "jitter" ? `jitter-${opts.lang}-${opts.sleep}ms-c${opts.concurrency}` : `throughput-c${opts.concurrency}`;
  const outFile = path.join(outDir, `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
  const { games: _games, ...printable } = summary;
  console.log(JSON.stringify(opts.mode === "throughput" ? printable : summary, null, 2));
  console.log(`written: ${path.relative(ROOT, outFile)}`);
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
