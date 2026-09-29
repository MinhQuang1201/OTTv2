const fs = require("node:fs");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { availablePort, readWorkerHost, workerOrigin, wranglerLauncher } = require("../../config/local-runtime");

const ROOT = path.resolve(__dirname, "..", "..");
const APP_PORT = 3000;
const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
const LOG_LIMIT = 32_000;

function appendLog(target, chunk) {
  const value = target + chunk.toString();
  return value.length > LOG_LIMIT ? value.slice(-LOG_LIMIT) : value;
}

function ensurePortFree(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`Required browser-test port ${port} is already in use`));
    });
    socket.once("error", (error) => error.code === "ECONNREFUSED" ? resolve() : reject(error));
  });
}

function waitFor(operation, label, timeoutMs = 30_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => operation().then((value) => {
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error(`${label} readiness timed out`));
      setTimeout(poll, 200);
    }, () => {
      if (Date.now() - started > timeoutMs) return reject(new Error(`${label} readiness timed out`));
      setTimeout(poll, 200);
    });
    poll();
  });
}

async function stopProcess(processInfo) {
  if (!processInfo || processInfo.child.exitCode !== null || processInfo.child.signalCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(processInfo.child.pid), "/t", "/f"], { stdio: "ignore" });
    await new Promise((resolve) => killer.once("exit", resolve));
  } else {
    processInfo.child.kill("SIGTERM");
  }
  await Promise.race([
    processInfo.exited,
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
}

function startProcess(command, args, env) {
  const quote = (value) => {
    const text = String(value);
    return /[\s"&|<>^]/.test(text) ? `"${text.replaceAll('"', '\\"')}"` : text;
  };
  const child = process.platform === "win32" && (command === "npx" || command === "npx.cmd")
    ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", [command, ...args].map((value, index) => index === 0 ? String(value) : quote(value)).join(" ")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] })
    : spawn(command, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const logs = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => { logs.stdout = appendLog(logs.stdout, chunk); });
  child.stderr.on("data", (chunk) => { logs.stderr = appendLog(logs.stderr, chunk); });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return { child, logs, exited };
}

function workerReady(workerOrigin) {
  return new Promise((resolve) => {
    const request = https.get(`${workerOrigin}/__browser_fixture_ready__`, { rejectUnauthorized: false, timeout: 1_000 }, (response) => {
      response.resume();
      resolve(true);
    });
    request.on("error", () => resolve(false));
    request.on("timeout", () => { request.destroy(); resolve(false); });
  });
}

async function createBrowserDemoFixture() {
  await ensurePortFree(APP_PORT);
  if (!fs.existsSync(path.join(ROOT, "apps", "web", "dist", "index.html"))) throw new Error("Browser fixture requires the built React app; run npm run build:web first");
  const workerHost = readWorkerHost();
  const workerPort = await availablePort(workerHost);
  const origin = workerOrigin(workerHost, workerPort, "https");
  const envFile = path.join(ROOT, ".dev.vars");
  if (!fs.existsSync(envFile)) throw new Error("Browser fixture requires the ignored .dev.vars file used by Worker runtime tests");
  fs.mkdirSync(path.join(ROOT, ".wrangler"), { recursive: true });
  const persistTo = fs.mkdtempSync(path.join(ROOT, ".wrangler", "browser-worker-"));
  const workerRuns = [];
  function startWorker() {
    const launcher = wranglerLauncher();
    const current = startProcess(launcher.command, [
      ...launcher.argsPrefix, "dev", "--config", "apps/worker/wrangler.jsonc", "--env", "demo",
      "--local", "--local-protocol", "https", "--env-file", envFile, "--persist-to", persistTo,
      "--ip", workerHost, "--port", String(workerPort), "--inspector-port", "0", "--show-interactive-dev-session=false",
    ], process.env);
    workerRuns.push(current);
    return current;
  }
  let worker = startWorker();
  let app;
  try {
    await waitFor(() => workerReady(origin), "Wrangler HTTPS Worker");
    app = startProcess(process.execPath, ["server.js"], { ...process.env, PORT: String(APP_PORT) });
    await waitFor(async () => {
      try {
        const response = await fetch(APP_ORIGIN);
        return response.ok;
      } catch { return false; }
    }, "static PlayHTML app");
  } catch (error) {
    await stopProcess(app);
    await stopProcess(worker);
    if (fs.existsSync(persistTo)) fs.rmSync(persistTo, { recursive: true, force: true });
    throw new Error(`${error.message}\nWrangler stderr:\n${worker.logs.stderr}\nWrangler stdout:\n${worker.logs.stdout}`);
  }

  let stopped = false;
  return {
    appOrigin: APP_ORIGIN,
    workerOrigin: origin,
    diagnostics() {
      return {
        workerStdout: workerRuns.map((run) => run.logs.stdout).join("\n"),
        workerStderr: workerRuns.map((run) => run.logs.stderr).join("\n"),
        appStdout: app.logs.stdout,
        appStderr: app.logs.stderr,
      };
    },
    async restartWorker() {
      if (stopped) throw new Error("Cannot restart a stopped browser fixture");
      await stopProcess(worker);
      worker = startWorker();
       await waitFor(() => workerReady(origin), "restarted Wrangler HTTPS Worker");
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await stopProcess(app);
      await stopProcess(worker);
      if (fs.existsSync(persistTo)) fs.rmSync(persistTo, { recursive: true, force: true });
    },
  };
}

module.exports = { createBrowserDemoFixture };
