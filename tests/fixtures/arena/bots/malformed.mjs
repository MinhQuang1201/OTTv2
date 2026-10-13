import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  // Emits completely malformed non-JSON output
  process.stdout.write("{ NOT_VALID_JSON ... invalid syntax\n");
});
