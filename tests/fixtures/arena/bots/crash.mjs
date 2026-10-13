import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on("line", () => {
  // Exit abruptly with non-zero exit code
  process.exit(42);
});
