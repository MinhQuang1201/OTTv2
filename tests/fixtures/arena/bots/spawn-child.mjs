import { spawn } from "node:child_process";
import readline from "node:readline";

// Spawn background child that keeps running
const backgroundChild = spawn(
  process.execPath,
  ["-e", "setInterval(() => {}, 1000)"],
  {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  }
);
backgroundChild.unref();

// Report child PID on stderr for test assertions
process.stderr.write(`CHILD_PID:${backgroundChild.pid}\n`);

if (process.env.TEST_ROOT_EXIT_EARLY === "1") {
  // Exit parent immediately leaving child running as orphan
  setTimeout(() => {
    process.exit(0);
  }, 50);
} else {
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
      const action = {
        protocolVersion: 1,
        requestId: turn.requestId,
        move: turn.legalMoves[0],
        comment: "spawned child"
      };
      process.stdout.write(JSON.stringify(action) + "\n");
    } catch (_) {}
  });
}
