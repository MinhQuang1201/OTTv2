import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const turn = JSON.parse(trimmed);
    if (turn.legalMoves && turn.legalMoves.length > 0) {
      const action = {
        protocolVersion: 1,
        requestId: turn.requestId,
        move: turn.legalMoves[0],
        comment: "isolated node legal move"
      };
      process.stdout.write(JSON.stringify(action) + "\n");
    }
  } catch (err) {
    process.stderr.write(`legal-isolated-bot.mjs error: ${err.message}\n`);
  }
});
