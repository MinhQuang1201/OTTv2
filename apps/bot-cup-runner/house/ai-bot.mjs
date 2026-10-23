// House bot "easy" / "medium" / "hard" for the Bot Cup runner: the in-game AI (packages/game-core/src/ai.js) speaking Bot
// Protocol v1. Bundled per level by src/house-bots.mjs and run in the same container sandbox as team bots, so both sides
// get the same CPU and clock. __HOUSE_LEVEL__ is replaced at bundle time.
import readline from "node:readline";
import ai from "../../../packages/game-core/src/ai.js";

/* global __HOUSE_LEVEL__ */
const LEVEL = __HOUSE_LEVEL__;
// ai.js bounds its search by nodes, not time: "hard" can spend ~200 ms a move and run out of a 30 s bank in a long game
// (found in P3). With little bank left, play at the fastest level instead of losing on time.
const LOW_BANK_MS = 5000;

function stateFromTurn(turn) {
  return {
    pieces: turn.board.map((piece) => ({ id: piece.id, player: piece.owner, type: piece.type, x: piece.x, y: piece.y })),
    turn: turn.turn,
    winner: null
  };
}

const input = readline.createInterface({ input: process.stdin, terminal: false });
input.on("line", (line) => {
  if (!line.trim()) return;
  const turn = JSON.parse(line);
  if (turn.type !== "turn") return;
  const level = turn.timeRemainingMs < LOW_BANK_MS ? "easy" : LEVEL;
  const chosen = ai.chooseMove(stateFromTurn(turn), turn.turn, { level });
  const move = chosen ? { from: chosen.from, to: chosen.to } : turn.legalMoves[0];
  process.stdout.write(JSON.stringify({ protocolVersion: 1, requestId: turn.requestId, move }) + "\n");
});
