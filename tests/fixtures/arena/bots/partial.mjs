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
    // Write partial JSON without newline, then exit immediately
    process.stdout.write(`{"protocolVersion": 1, "requestId": "${turn.requestId}"`);
    process.exit(0);
  } catch (_) {
    process.exit(1);
  }
});
