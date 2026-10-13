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
    const action = JSON.stringify({
      protocolVersion: 1,
      requestId: turn.requestId,
      move: turn.legalMoves[0]
    });
    // Write 2 lines for single turn request
    process.stdout.write(action + "\n" + action + "\n");
  } catch (_) {
    process.exit(1);
  }
});
