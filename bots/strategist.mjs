// Arena Protocol v1 — standalone Node.js ESM submission.
// No repository imports, network, files or dependencies required.
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const BEATS = { dam: "keo", keo: "la", la: "dam" };
const OTHER = { A: "B", B: "A" };
const WIN = 1000000;
const TIMEOUT = Symbol("search-timeout");
const distance = (p, seat) => seat === "A" ? Math.max(p.x, p.y) : Math.max(8 - p.x, 8 - p.y);
const goal = (p, seat) => distance(p, seat) === 0;

export function movesFor(board, seat) {
  const occupied = new Map(board.map((p) => [p.y * 9 + p.x, p]));
  const moves = [];
  for (let i = 0; i < board.length; i++) {
    const p = board[i];
    if (p.owner !== seat) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const x = p.x + dx, y = p.y + dy;
      if (x < 0 || y < 0 || x > 8 || y > 8) continue;
      const target = occupied.get(y * 9 + x);
      if (target && (target.owner === seat || BEATS[p.type] !== target.type)) continue;
      moves.push({ from: { x: p.x, y: p.y }, to: { x, y } });
    }
  }
  return moves;
}

export function advance(board, move) {
  return board.filter((p) => p.x !== move.to.x || p.y !== move.to.y).map((p) =>
    p.x === move.from.x && p.y === move.from.y ? { ...p, ...move.to } : p);
}

function winner(board) {
  for (const seat of ["A", "B"]) if (board.some((p) => p.owner === seat && goal(p, seat))) return seat;
  if (!board.some((p) => p.owner === "A")) return "B";
  if (!board.some((p) => p.owner === "B")) return "A";
  return null;
}

function evaluate(board, seat) {
  const values = { A: 0, B: 0 }, nearest = { A: 9, B: 9 };
  const types = { A: new Set(), B: new Set() };
  for (const p of board) {
    const d = distance(p, p.owner);
    nearest[p.owner] = Math.min(nearest[p.owner], d);
    types[p.owner].add(p.type);
    values[p.owner] += 180 + (8 - d) * 8;
    let threatened = false, supported = false;
    for (const q of board) {
      if (q === p || Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y)) !== 1) continue;
      if (q.owner !== p.owner && BEATS[q.type] === p.type) threatened = true;
      if (q.owner === p.owner && q.type !== p.type) supported = true;
    }
    if (threatened) values[p.owner] -= supported ? 25 : 65;
  }
  for (const s of ["A", "B"]) {
    values[s] += types[s].size * 50 + (9 - nearest[s]) ** 2 * 22;
  }
  return values[seat] - values[OTHER[seat]];
}

const keyOfMove = (m) => `${m.from.x},${m.from.y}:${m.to.x},${m.to.y}`;
function ordered(board, seat, moves, preferred) {
  return moves.map((move) => {
    const p = board.find((p) => p.x === move.from.x && p.y === move.from.y);
    const capture = board.some((p) => p.x === move.to.x && p.y === move.to.y);
    return { move, score: (keyOfMove(move) === preferred ? WIN * 2 : 0)
      + (goal(move.to, seat) ? WIN : 0) + (capture ? 250 : 0)
      + (distance(p, seat) - distance(move.to, seat)) * 40 };
  }).sort((a, b) => b.score - a.score).map((entry) => entry.move);
}

export function choose(turn, options = {}) {
  const legal = turn.legalMoves;
  if (!Array.isArray(legal) || !legal.length) throw new Error("No legal moves supplied");
  const board = turn.board.map((p) => ({ ...p }));
  const seat = turn.turn;
  const allowance = Math.min(Number(turn.turnTimeLimitMs) || 1000, Number(turn.timeRemainingMs) || 1000);
  const budget = options.budgetMs ?? Math.max(1, Math.min(300, Math.floor(allowance * 0.35)));
  const deadline = performance.now() + budget;
  const table = new Map();
  let nodes = 0, completedDepth = 0;
  let best = ordered(board, seat, legal)[0];
  // Immediate wins take priority even before the first complete search iteration.
  for (const move of legal) {
    const next = advance(board, move);
    if (winner(next) === seat || movesFor(next, OTHER[seat]).length === 0) {
      return { move, depth: 1, nodes, score: WIN };
    }
  }
  function search(position, side, depth, alpha, beta, ply) {
    nodes++;
    if (performance.now() >= deadline) throw TIMEOUT;
    const won = winner(position);
    if (won) return won === side ? WIN - ply : -WIN + ply;
    const moves = movesFor(position, side);
    if (!moves.length) return -WIN + ply;
    if (!depth) return evaluate(position, side);
    const key = side + position.map((p) => `${p.owner}${p.type}${p.x}${p.y}`).sort().join("|");
    const cached = table.get(key);
    // Mate scores depend on ply; only use cached entries at the same ply.
    if (cached && cached.depth >= depth && cached.ply === ply) {
      if (cached.flag === "exact") return cached.score;
      if (cached.flag === "lower") alpha = Math.max(alpha, cached.score);
      if (cached.flag === "upper") beta = Math.min(beta, cached.score);
      if (alpha >= beta) return cached.score;
    }
    const originalAlpha = alpha, originalBeta = beta;
    let value = -Infinity, preferred;
    for (const move of ordered(position, side, moves, cached?.move)) {
      const score = -search(advance(position, move), OTHER[side], depth - 1, -beta, -alpha, ply + 1);
      if (score > value) { value = score; preferred = keyOfMove(move); }
      alpha = Math.max(alpha, value);
      if (alpha >= beta) break;
    }
    if (table.size < 25000) table.set(key, { depth, ply, score: value, move: preferred,
      flag: value <= originalAlpha ? "upper" : value >= originalBeta ? "lower" : "exact" });
    return value;
  }
  let bestScore = 0;
  for (let depth = 1; depth <= (options.maxDepth ?? 8); depth++) {
    try {
      let iterationMove = best, value = -Infinity, alpha = -Infinity;
      for (const move of ordered(board, seat, legal, keyOfMove(best))) {
        const score = -search(advance(board, move), OTHER[seat], depth - 1, -Infinity, -alpha, 1);
        if (score > value) { value = score; iterationMove = move; }
        alpha = Math.max(alpha, value);
      }
      best = iterationMove; bestScore = value; completedDepth = depth;
      if (Math.abs(value) > WIN - 100) break;
    } catch (error) {
      if (error !== TIMEOUT) throw error;
      break;
    }
  }
  return { move: best, depth: completedDepth, nodes, score: bestScore };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    let turn;
    try {
      turn = JSON.parse(line);
      const result = choose(turn);
      process.stdout.write(JSON.stringify({ protocolVersion: 1, requestId: turn.requestId,
        move: result.move, comment: `Strategist depth=${result.depth} nodes=${result.nodes}` }) + "\n");
    } catch (error) {
      process.stderr.write(`Strategist: ${error.message}\n`);
      if (turn?.legalMoves?.length) process.stdout.write(JSON.stringify({ protocolVersion: 1,
        requestId: turn.requestId, move: turn.legalMoves[0], comment: "legal fallback" }) + "\n");
    }
  });
}
