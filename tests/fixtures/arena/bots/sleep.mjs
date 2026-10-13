import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on("line", () => {
  // Do not reply; sleep indefinitely
  setTimeout(() => {}, 60000);
});
