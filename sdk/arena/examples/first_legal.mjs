/**
 * Reference First-Legal Node.js Bot for Arena AI protocol v1.
 * Demonstrates minimal compliant JavaScript bot.
 * Selects the first legal move from referee-provided legalMoves array.
 * Diagnostic logs are directed strictly to stderr; stdout is reserved for NDJSON.
 */

import readline from "node:readline";

const PROTOCOL_VERSION = 1;

function log(...args) {
  process.stderr.write(args.join(" ") + "\n");
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let turn;
  try {
    turn = JSON.parse(trimmed);
  } catch (err) {
    log("Failed to parse JSON:", err.message);
    return;
  }

  if (turn.protocolVersion !== PROTOCOL_VERSION || turn.type !== "turn") {
    return;
  }

  const requestId = turn.requestId;
  const legalMoves = turn.legalMoves;

  if (!requestId || typeof requestId !== "string") {
    log("Missing or invalid requestId");
    return;
  }

  if (!Array.isArray(legalMoves) || legalMoves.length === 0) {
    log("No legal moves available in turn payload!");
    process.exit(1);
  }

  const chosenMove = legalMoves[0];
  const response = {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    move: {
      from: { x: Number(chosenMove.from.x), y: Number(chosenMove.from.y) },
      to: { x: Number(chosenMove.to.x), y: Number(chosenMove.to.y) }
    },
    comment: `Node first-legal ply ${turn.ply ?? 0}`
  };

  process.stdout.write(JSON.stringify(response) + "\n");
});
