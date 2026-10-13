import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on("line", () => {
  // Flood stdout with > 100,000 bytes line without newline
  const hugePayload = "A".repeat(100000);
  process.stdout.write(hugePayload + "\n");
});
