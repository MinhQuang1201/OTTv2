const path = require("node:path");
const { spawn } = require("node:child_process");

const {
  readWorkerHost,
  resolveWorkerPort,
  workerOrigin,
  wranglerLauncher,
} = require("../config/local-runtime");

const root = path.resolve(__dirname, "..");

function spawnLocalCommand(command, args, options, spawnProcess) {
  if (process.platform !== "win32") return spawnProcess(command, args, options);
  const quote = (value) => {
    const text = String(value);
    return /[\s"&|<>^]/.test(text) ? `"${text.replaceAll('"', '\\"')}"` : text;
  };
  const commandLine = [command, ...args].map((value, index) => index === 0 ? String(value) : quote(value)).join(" ");
  return spawnProcess(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", commandLine], options);
}

function buildWranglerArgs(port, extraArgs = [], host = readWorkerHost()) {
  return [
    ...wranglerLauncher().argsPrefix,
    "dev",
    "--config", "apps/worker/wrangler.jsonc",
    "--local",
    "--ip", host,
    "--port", String(port),
    "--inspector-port", "0",
    "--show-interactive-dev-session=false",
    ...extraArgs,
  ];
}

function main({ spawnProcess = spawn } = {}) {
  const host = readWorkerHost();
  return resolveWorkerPort().then((port) => new Promise((resolve, reject) => {
    const launcher = wranglerLauncher();
    const child = spawnLocalCommand(launcher.command, buildWranglerArgs(port, [], host), {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    }, spawnProcess);
    process.stderr.write(`Worker local runtime: ${workerOrigin(host, port)}\n`);

    const forwardSignal = (signal) => child.kill(signal);
    process.once("SIGINT", forwardSignal);
    process.once("SIGTERM", forwardSignal);
    const cleanup = () => {
      process.removeListener("SIGINT", forwardSignal);
      process.removeListener("SIGTERM", forwardSignal);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve(signal ? 1 : (code ?? 1));
    });
  }));
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { buildWranglerArgs, main };
