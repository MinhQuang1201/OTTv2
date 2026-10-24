#!/usr/bin/env node
/**
 * Trọng tài cục bộ của OTT Bot Cup (plan §6.4). Cho hai bot đấu với nhau trên máy của bạn, đổi màu sau mỗi ván.
 *
 *   node judge.mjs <bot-1> <bot-2> [--maps classic|flanks|center|all] [--rounds N] [--replays <thư mục>] [--verbose]
 *
 * Bot là một file .py / .js / .mjs, hoặc house bot: first-legal, easy, medium, hard (AI trong game), sentinel, strategist.
 * Ví dụ:  node judge.mjs bot.py easy --maps all      (giống vòng kiểm tra: 3 bản đồ × 2 màu = 6 ván)
 *
 * Khác với máy chấm thật: bot chạy thẳng trên máy bạn (không có container, có mạng), nên chỉ dùng để thử.
 * Giới hạn thời gian giống giải: 500 ms mỗi nước, quỹ 30 s mỗi ván. Bản đóng gói một file: `npm run bot-cup:kit`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ai from "../../packages/game-core/src/ai.js";
import { chooseMove as sentinelMove } from "../../bots/sentinel.mjs";
import { choose as strategistMove } from "../../bots/strategist.mjs";
import { createHeadlessMatchController } from "../../packages/arena/src/application/match-controller.mjs";
import { createReplayJournal } from "../../packages/arena/src/application/replay-journal.mjs";
import { createFunctionBot } from "../../packages/arena/src/adapters/function-bot.mjs";
import { createCurrentRulesetSnapshot } from "../../packages/arena/src/contracts/index.mjs";
import { DEFAULT_MATCH_POLICY } from "../../packages/arena/src/domain/match-policy.mjs";
import { createMapState } from "../../packages/arena/src/domain/maps/index.mjs";
import { createNodeClock } from "../../packages/arena-node/src/clock/node-clock.mjs";
import { createNodeEngine, coreConfig } from "../../packages/arena-node/src/core/node-engine.mjs";
import { computeRulesetHash } from "../../packages/arena-node/src/core/ruleset-identity.mjs";
import { createProcessBot } from "../../packages/arena-node/src/execution/process-bot.mjs";
import { resolvePythonExecutable } from "../../packages/arena-node/src/execution/profile-registry.mjs";

const MAPS = ["classic", "flanks", "center"];
const BANK_MS = 30_000;
// Bot Cup timing (plan §7.3). The official referee also gives the first move 5 s and stops at 300 plies (P4);
// this local one still uses arena-policy-v1, so the first move must fit in 500 ms and a draw comes at 400 plies.
export const JUDGE_POLICY = Object.freeze({ ...DEFAULT_MATCH_POLICY, turnTimeLimitMs: 500, initialTimeMs: BANK_MS });

const REASONS = {
  goal: "vào ô thắng",
  elimination: "tiêu diệt hết quân",
  no_moves: "đối thủ hết nước đi",
  max_plies: "đủ số nước tối đa",
  turn_timeout: "quá 500 ms một nước",
  total_timeout: "hết quỹ 30 s",
  crash: "bot dừng hoặc lỗi khi chạy",
  protocol_error: "trả lời sai định dạng",
  illegal_move: "đi nước không hợp lệ",
  output_limit: "in quá nhiều ra stdout"
};

// ---------- house bots ----------

function stateFromTurn(turn) {
  return {
    pieces: turn.board.map((piece) => ({ id: piece.id, player: piece.owner, type: piece.type, x: piece.x, y: piece.y })),
    turn: turn.turn,
    winner: null
  };
}

const HOUSE_BOTS = {
  "first-legal": (turn) => turn.legalMoves[0],
  easy: (turn) => ai.chooseMove(stateFromTurn(turn), turn.turn, { level: "easy" }),
  medium: (turn) => ai.chooseMove(stateFromTurn(turn), turn.turn, { level: "medium" }),
  hard: (turn) => ai.chooseMove(stateFromTurn(turn), turn.turn, { level: "hard" }),
  sentinel: (turn) => sentinelMove(turn).move,
  strategist: (turn) => strategistMove(turn).move
};

// ---------- bot files ----------

/** @returns {"python"|"node"|null} */
export function languageOf(file) {
  if (/\.py$/i.test(file)) return "python";
  if (/\.m?js$/i.test(file)) return "node";
  return null;
}

/**
 * Same syntax check as the official runner (py_compile / node --check), on a copy named like the runner names it:
 * JavaScript always runs as an ES module (bot.mjs).
 * @returns {{ ok: true, dir: string, entry: string, executable: string } | { ok: false, message: string }}
 */
export function prepareBotFile(file) {
  const language = languageOf(file);
  if (!language) return { ok: false, message: `${file}: chỉ nhận file .py, .js hoặc .mjs` };
  if (!fs.existsSync(file)) return { ok: false, message: `${file}: không tìm thấy file` };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ott-judge-"));
  const entry = path.join(dir, language === "python" ? "bot.py" : "bot.mjs");
  fs.copyFileSync(file, entry);
  const executable = language === "python" ? resolvePythonExecutable().executable : process.execPath;
  const args = language === "python"
    ? ["-c", "import sys, py_compile; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)", entry, path.join(dir, "bot.pyc")]
    : ["--check", entry];
  const check = spawnSync(executable, args, { encoding: "utf8", timeout: 15_000 });
  if (check.error) return { ok: false, message: `Không chạy được ${executable}: ${check.error.message}` };
  if (check.status !== 0) {
    const detail = `${check.stderr || check.stdout}`.split(dir + path.sep).join("").trim();
    return { ok: false, message: `${file}: lỗi cú pháp\n${detail}` };
  }
  return { ok: true, dir, entry, executable };
}

function createBot(spec, botId, clock, prepared, stderrSink) {
  if (HOUSE_BOTS[spec]) return createFunctionBot({ botId, chooseFn: HOUSE_BOTS[spec] });
  return createProcessBot({
    botId,
    executable: prepared.executable,
    args: [prepared.entry],
    cwd: prepared.dir,
    clock,
    onStderr: (chunk) => stderrSink(chunk.toString("utf8"))
  });
}

// ---------- one game ----------

/**
 * @param {{ a: string, b: string, mapId: string, prepared: Record<string, object>, onStderr?: (spec: string, text: string) => void }} options
 */
export async function playGame({ a, b, mapId, prepared, onStderr = () => {} }) {
  const clock = createNodeClock();
  const snapshot = createCurrentRulesetSnapshot(coreConfig);
  const rulesetHash = computeRulesetHash(snapshot);
  const matchId = `judge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const initialState = createMapState(mapId);
  initialState.clock.remainingMs = { A: BANK_MS, B: BANK_MS };
  const journal = createReplayJournal({ matchId, policyId: JUDGE_POLICY.matchPolicyVersion, rulesetId: snapshot.rulesetId, engineFingerprint: "bot-cup-judge", rulesetHash });
  const controller = createHeadlessMatchController({
    matchId,
    engine: createNodeEngine(coreConfig),
    botA: createBot(a, `${matchId}-A`, clock, prepared[a], (text) => onStderr(a, text)),
    botB: createBot(b, `${matchId}-B`, clock, prepared[b], (text) => onStderr(b, text)),
    clock,
    journal,
    policy: JUDGE_POLICY,
    rulesetSnapshot: snapshot,
    rulesetHash,
    engineRevision: "bot-cup-judge",
    initialState,
    participants: {
      A: { botId: `${matchId}-A`, name: a, isFunctionBot: Boolean(HOUSE_BOTS[a]) },
      B: { botId: `${matchId}-B`, name: b, isFunctionBot: Boolean(HOUSE_BOTS[b]) }
    }
  });
  const result = await controller.run();
  return { result, replay: journal.getDocument() };
}

// ---------- command line ----------

function parseArgs(argv) {
  const options = { bots: [], maps: ["classic"], rounds: 1, replays: null, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--verbose") options.verbose = true;
    else if (arg === "--maps") {
      const value = argv[++i];
      if (value === "all") options.maps = [...MAPS];
      else if (MAPS.includes(value)) options.maps = [value];
      else throw new Error(`--maps phải là ${MAPS.join(", ")} hoặc all`);
    } else if (arg === "--rounds") {
      options.rounds = Number(argv[++i]);
      if (!Number.isInteger(options.rounds) || options.rounds < 1 || options.rounds > 50) throw new Error("--rounds phải từ 1 đến 50");
    } else if (arg === "--replays") options.replays = argv[++i];
    else if (arg.startsWith("--")) throw new Error(`Không hiểu tùy chọn ${arg}`);
    else options.bots.push(arg);
  }
  if (options.bots.length !== 2) throw new Error("Cần đúng hai bot");
  return options;
}

const USAGE = `Cách dùng: node judge.mjs <bot-1> <bot-2> [--maps classic|flanks|center|all] [--rounds N] [--replays <thư mục>] [--verbose]
Bot là file .py / .js / .mjs, hoặc house bot: ${Object.keys(HOUSE_BOTS).join(", ")}.`;

export async function main(argv, out = (line) => process.stdout.write(`${line}\n`)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    out(`${error.message}\n${USAGE}`);
    return 2;
  }
  const prepared = {};
  for (const spec of new Set(options.bots)) {
    if (HOUSE_BOTS[spec]) continue;
    const ready = prepareBotFile(spec);
    if (!ready.ok) {
      out(ready.message);
      return 1;
    }
    prepared[spec] = ready;
  }
  if (options.replays) fs.mkdirSync(options.replays, { recursive: true });

  const [first, second] = options.bots;
  const name = (spec) => (HOUSE_BOTS[spec] ? spec : path.basename(spec));
  const points = { 1: 0, 2: 0 };
  let game = 0;
  try {
    for (let round = 0; round < options.rounds; round++) {
      for (const mapId of options.maps) {
        for (const swap of [false, true]) {
          game += 1;
          const a = swap ? second : first;
          const b = swap ? first : second;
          const seatOf = { A: swap ? 2 : 1, B: swap ? 1 : 2 };
          const tails = { [a]: "", [b]: "" };
          const { result, replay } = await playGame({
            a,
            b,
            mapId,
            prepared,
            onStderr: (spec, text) => {
              if (options.verbose) process.stderr.write(text.replace(/^/gm, `[${name(spec)}] `));
              tails[spec] = (tails[spec] + text).slice(-2000);
            }
          });
          if (result.kind === "infrastructure_error") {
            out(`Ván ${game}: lỗi trọng tài (${result.code}). Hãy chạy lại.`);
            return 1;
          }
          const header = `Ván ${game} · ${mapId} · Đỏ (A) = ${name(a)} · Xanh (B) = ${name(b)}: `;
          if (result.outcome === "draw") {
            points[1] += 0.5;
            points[2] += 0.5;
            out(`${header}hòa (${REASONS[result.reason] ?? result.reason}) sau ${result.acceptedPlies} nước`);
          } else {
            points[seatOf[result.winner]] += 1;
            const verb = result.outcome === "forfeit" ? `${name(result.loser === "A" ? a : b)} thua vì` : `${name(result.winner === "A" ? a : b)} thắng,`;
            out(`${header}${verb} ${REASONS[result.reason] ?? result.reason} (${result.acceptedPlies} nước)`);
            const loserSpec = result.loser === "A" ? a : b;
            if (result.outcome === "forfeit" && tails[loserSpec].trim()) {
              out(`  stderr cuối của ${name(loserSpec)}:\n${tails[loserSpec].trimEnd().split("\n").slice(-10).map((line) => `    ${line}`).join("\n")}`);
            }
          }
          if (options.replays && replay) {
            const file = path.join(options.replays, `game-${String(game).padStart(2, "0")}-${mapId}.json`);
            fs.writeFileSync(file, JSON.stringify(replay, null, 2));
          }
        }
      }
    }
  } finally {
    for (const ready of Object.values(prepared)) fs.rmSync(ready.dir, { recursive: true, force: true });
  }
  out(`\nKết quả sau ${game} ván: ${name(first)} ${points[1]} – ${points[2]} ${name(second)}`);
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error(error);
    process.exit(1);
  });
}
