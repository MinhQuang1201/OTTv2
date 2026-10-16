// Sentinel: standalone Arena Protocol v1 bot, Node.js ESM.
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const beats = { dam: "keo", keo: "la", la: "dam" };
const enemy = (seat) => seat === "A" ? "B" : "A";
const dist = (p, seat) => seat === "A" ? Math.max(p.x, p.y) : Math.max(8 - p.x, 8 - p.y);
const MATE = 1000000;
const STOP = Symbol("deadline");

export function legalMoves(board, seat) {
  const cells = new Map(board.map((p) => [p.y * 9 + p.x, p]));
  const result = [];
  for (const p of board) {
    if (p.owner !== seat) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = p.x + dx, y = p.y + dy;
      if ((!dx && !dy) || x < 0 || y < 0 || x > 8 || y > 8) continue;
      const q = cells.get(y * 9 + x);
      if (q && (q.owner === seat || beats[p.type] !== q.type)) continue;
      result.push({ from: { x: p.x, y: p.y }, to: { x, y } });
    }
  }
  return result;
}

export function play(board, move) {
  return board.filter((p) => p.x !== move.to.x || p.y !== move.to.y)
    .map((p) => p.x === move.from.x && p.y === move.from.y ? { ...p, ...move.to } : p);
}

function terminal(board) {
  for (const side of ["A", "B"]) if (board.some((p) => p.owner === side && dist(p, side) === 0)) return side;
  for (const side of ["A", "B"]) if (!board.some((p) => p.owner === side)) return enemy(side);
  return null;
}

function evaluate(board, seat) {
  const score = { A: 0, B: 0 }, nearest = { A: 9, B: 9 };
  const diversity = { A: new Set(), B: new Set() };
  for (const p of board) {
    const d = dist(p, p.owner);
    nearest[p.owner] = Math.min(nearest[p.owner], d);
    diversity[p.owner].add(p.type);
    score[p.owner] += 240 + 12 * (8 - d);
    const predators = board.filter((q) => q.owner !== p.owner && beats[q.type] === p.type
      && Math.max(Math.abs(q.x - p.x), Math.abs(q.y - p.y)) === 1);
    score[p.owner] -= predators.length ? 100 : 0;
  }
  for (const side of ["A", "B"]) {
    score[side] += diversity[side].size * 65 + (9 - nearest[side]) ** 2 * 28;
  }
  return score[seat] - score[enemy(seat)];
}

function order(board, seat, moves, previous) {
  return moves.map((move) => {
    const capture = board.find((p) => p.x === move.to.x && p.y === move.to.y);
    return { move, score: (previous && sameMove(move, previous) ? MATE * 2 : 0)
      + (dist(move.to, seat) === 0 ? MATE : 0) + (capture ? 300 : 0) - dist(move.to, seat) * 20 };
  }).sort((a, b) => b.score - a.score).map(({ move }) => move);
}
const sameMove = (a, b) => a.from.x === b.from.x && a.from.y === b.from.y && a.to.x === b.to.x && a.to.y === b.to.y;

export function chooseMove(turn, options = {}) {
  const board = turn.board, seat = turn.turn, moves = turn.legalMoves;
  if (!moves?.length) throw new Error("No legal moves");
  const allowance = Math.min(turn.turnTimeLimitMs || 1000, turn.timeRemainingMs || 1000);
  const deadline = performance.now() + (options.budgetMs ?? Math.max(1, Math.min(350, allowance * 0.35)));
  let best = order(board, seat, moves)[0], depthDone = 0, nodes = 0;
  // Inspect every root move for a win and immediate opponent wins first.
  const safe = [];
  for (const move of moves) {
    const next = play(board, move);
    const replies = legalMoves(next, enemy(seat));
    if (terminal(next) === seat || !replies.length) return { move, depth: 1, nodes };
    if (!replies.some((reply) => terminal(play(next, reply)) === enemy(seat))) safe.push(move);
  }
  const candidates = safe.length ? safe : moves;
  best = order(board, seat, candidates)[0];
  function search(position, side, depth, alpha, beta, ply) {
    nodes++;
    if (performance.now() >= deadline) throw STOP;
    const won = terminal(position);
    if (won) return won === side ? MATE - ply : -MATE + ply;
    const legal = legalMoves(position, side);
    if (!legal.length) return -MATE + ply;
    if (!depth) return evaluate(position, side);
    let value = -Infinity;
    for (const move of order(position, side, legal)) {
      value = Math.max(value, -search(play(position, move), enemy(side), depth - 1, -beta, -alpha, ply + 1));
      alpha = Math.max(alpha, value);
      if (alpha >= beta) break;
    }
    return value;
  }
  for (let depth = 1; depth <= (options.maxDepth ?? 8); depth++) {
    let choice = best, value = -Infinity;
    try {
      for (const move of order(board, seat, candidates, best)) {
        const score = -search(play(board, move), enemy(seat), depth - 1, -Infinity, -value, 1);
        if (score > value) { value = score; choice = move; }
      }
      best = choice; depthDone = depth;
      if (Math.abs(value) > MATE - 100) break;
    } catch (error) {
      if (error !== STOP) throw error;
      break;
    }
  }
  return { move: best, depth: depthDone, nodes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
    let turn;
    try {
      turn = JSON.parse(line);
      const result = chooseMove(turn);
      process.stdout.write(JSON.stringify({ protocolVersion: 1, requestId: turn.requestId,
        move: result.move, comment: `Sentinel depth=${result.depth} nodes=${result.nodes}` }) + "\n");
    } catch (error) {
      process.stderr.write(`Sentinel: ${error.message}\n`);
      if (turn?.legalMoves?.length) process.stdout.write(JSON.stringify({ protocolVersion: 1,
        requestId: turn.requestId, move: turn.legalMoves[0] }) + "\n");
    }
  });
}
