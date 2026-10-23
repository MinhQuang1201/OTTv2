"use strict";

const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const net = require("node:net");
const fs = require("node:fs");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_DB_PATH = path.join(ROOT, "var", "arena-demo", "arena.db");
const DEFAULT_STORAGE_DIR = path.join(ROOT, "var", "arena-demo", "artifacts");
const ENTRYPOINT = path.join(ROOT, "apps", "arena-api", "src", "main.mjs");
const PINNED_RUNNER_IMAGE = "ottv2-arena-runner:local";
const PINNED_RUNNER_IMAGE_ID = "sha256:8e3ea65cf10491a329d670a7db2fb9aa15435d3e5a7a29ece7f75265e46ec6f5";

function parseOptions(argv = [], env = process.env) {
  if (env.ARENA_EXTERNAL_WORKER === "true" || env.ARENA_EXTERNAL_WORKER === "1") {
    return {
      error: "ARENA_EXTERNAL_WORKER=true is not supported in demo mode. The demo launcher requires embedded worker mode."
    };
  }
  if (env.ARENA_TRUSTED_MODE === "true" || env.ARENA_TRUSTED_MODE === "1") {
    return {
      error: "ARENA_TRUSTED_MODE=true contradicts demo container mode. The demo launcher requires untrusted container execution (ARENA_TRUSTED_MODE=false)."
    };
  }

  const options = {
    dbPath: env.ARENA_DB_PATH || DEFAULT_DB_PATH,
    storageDir: env.ARENA_STORAGE_DIR || DEFAULT_STORAGE_DIR,
    port: env.ARENA_API_PORT || "3001",
    host: env.ARENA_API_HOST || "127.0.0.1",
    allowedOrigins: env.ARENA_ALLOWED_ORIGINS || "http://127.0.0.1:3000,http://localhost:3000",
    registration: env.ARENA_PUBLIC_REGISTRATION === "true" || env.ARENA_PUBLIC_REGISTRATION === "1",
    preflight: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--public-registration") options.registration = true;
    else if (arg === "--no-public-registration") options.registration = false;
    else if (arg === "--skip-docker-preflight") options.preflight = false;
    else if (["--db", "--storage", "--port", "--host", "--origins"].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) return { error: `Missing value for ${arg}.` };
      if (arg === "--db") options.dbPath = value;
      if (arg === "--storage") options.storageDir = value;
      if (arg === "--port") options.port = value;
      if (arg === "--host") options.host = value;
      if (arg === "--origins") options.allowedOrigins = value;
    } else if (arg === "--help" || arg === "-h") {
      return { help: true };
    } else {
      return { error: `Unknown option "${arg}".` };
    }
  }

  if (!Number.isInteger(Number(options.port)) || Number(options.port) < 0 || Number(options.port) > 65535) {
    return { error: "Port must be an integer between 0 and 65535." };
  }
  if (options.host !== "127.0.0.1" && options.host !== "localhost" && options.host !== "::1") {
    return { error: "Arena demo launcher only permits a loopback host." };
  }
  const originsList = options.allowedOrigins.split(",").map((s) => s.trim()).filter(Boolean);
  if (originsList.some((o) => o === "*" || o.includes("*"))) {
    return { error: "Wildcard CORS origins are forbidden in Arena demo mode; specify explicit origins." };
  }

  return { options };
}

function buildLaunchSpec(options, baseEnv = process.env) {
  const env = {
    ...baseEnv,
    ARENA_API_HOST: options.host,
    ARENA_API_PORT: String(options.port),
    ARENA_DB_PATH: path.resolve(options.dbPath),
    ARENA_STORAGE_DIR: path.resolve(options.storageDir),
    ARENA_ALLOWED_ORIGINS: options.allowedOrigins,
    ARENA_LOCAL_DEMO_CONTAINERS: "true",
    ARENA_TRUSTED_MODE: "false",
    ARENA_EXTERNAL_WORKER: "false",
    ARENA_PUBLIC_REGISTRATION: options.registration ? "true" : "false"
  };

  if (baseEnv.ARENA_RUNNER_IMAGE) {
    env.ARENA_RUNNER_IMAGE = baseEnv.ARENA_RUNNER_IMAGE;
  }

  return {
    command: process.execPath,
    args: [ENTRYPOINT],
    options: { cwd: ROOT, env, shell: false, windowsHide: false, stdio: "inherit" }
  };
}

function defaultDockerPreflight(exec = spawnSync, runnerImage = (process.env.ARENA_RUNNER_IMAGE || PINNED_RUNNER_IMAGE)) {
  const version = exec("docker", ["version", "--format", "{{json .}}"], {
    cwd: ROOT,
    env: process.env,
    shell: false,
    windowsHide: true,
    timeout: 4000,
    encoding: "utf8"
  });
  if (!version || version.status !== 0 || !version.stdout) {
    return { ok: false, message: "Docker daemon is unavailable; prepare Docker Desktop and the pinned runner image before retrying." };
  }

  let parsed;
  try {
    parsed = JSON.parse(version.stdout.trim());
  } catch (_) {
    return { ok: false, message: "Malformed Docker version output from daemon." };
  }

  const serverOs = parsed?.Server?.Os;
  if (!serverOs || serverOs.toLowerCase() !== "linux") {
    return { ok: false, message: `Docker daemon must be running Linux containers (current: ${serverOs || "unknown"}).` };
  }

  const image = exec("docker", ["image", "inspect", "--format", "{{.Id}}", runnerImage], {
    cwd: ROOT,
    env: process.env,
    shell: false,
    windowsHide: true,
    timeout: 4000,
    encoding: "utf8"
  });
  if (!image || image.status !== 0 || !image.stdout || !image.stdout.trim()) {
    return { ok: false, message: `The pinned Arena runner image (${runnerImage}) is missing; prepare it explicitly. The demo launcher never pulls or builds images.` };
  }

  const imageId = image.stdout.trim();
  if (imageId !== PINNED_RUNNER_IMAGE_ID) {
    return { ok: false, message: `Pinned Arena runner image ID mismatch (expected ${PINNED_RUNNER_IMAGE_ID}, got ${imageId}). The demo launcher never pulls or builds images.` };
  }

  return { ok: true };
}

function defaultCheckPortFree(host, port) {
  return new Promise((resolve) => {
    if (Number(port) === 0) return resolve({ free: true });
    const socket = net.createConnection({ host, port: Number(port) });
    socket.once("connect", () => {
      socket.destroy();
      resolve({
        free: false,
        message: `Port ${port} is already in use on ${host}. The demo launcher will not terminate existing services.`
      });
    });
    socket.once("error", () => {
      resolve({ free: true });
    });
  });
}

function ensurePersistentDirectories(options, io = {}) {
  const mkdir = io.mkdirSync || fs.mkdirSync;
  if (!options) return;
  if (options.dbPath && options.dbPath !== ":memory:") {
    const dbDir = path.dirname(path.resolve(options.dbPath));
    mkdir(dbDir, { recursive: true });
  }
  if (options.storageDir) {
    const storageDir = path.resolve(options.storageDir);
    mkdir(storageDir, { recursive: true });
  }
}

async function run(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || console.log;
  const stderr = io.stderr || console.error;
  const env = io.env || process.env;
  const parsed = parseOptions(argv, env);

  if (parsed.help) {
    stdout("Usage: npm run arena:demo -- [--public-registration] [--db <path>] [--storage <path>] [--port <port>] [--origins <csv>]");
    return 0;
  }
  if (parsed.error) {
    stderr(`[arena:demo] ${parsed.error}`);
    return 2;
  }

  const options = parsed.options;
  if (options.preflight) {
    const preflight = io.preflight || defaultDockerPreflight;
    const result = preflight();
    if (!result.ok) {
      stderr(`[arena:demo] BLOCKED: ${result.message}`);
      return 1;
    }
    const checkPort = io.checkPortFree || defaultCheckPortFree;
    const portResult = await checkPort(options.host, Number(options.port));
    if (!portResult.free) {
      stderr(`[arena:demo] BLOCKED: ${portResult.message}`);
      return 1;
    }
  }

  try {
    ensurePersistentDirectories(options, io);
  } catch (err) {
    stderr(`[arena:demo] BLOCKED: Failed to create persistence directories: ${err.message}`);
    return 1;
  }

  const spec = buildLaunchSpec(options, env);
  stdout(`[arena:demo] starting loopback Arena on ${options.host}:${options.port} (publicRegistration=${options.registration})`);

  let codeResolver;
  const result = new Promise((resolve) => { codeResolver = resolve; });
  let settled = false;
  let shutdownTimer = null;

  const spawnOptions = { ...spec.options };
  if (io.stdio) spawnOptions.stdio = io.stdio;

  const child = (io.spawn || spawn)(spec.command, spec.args, spawnOptions);

  const forwardSignal = (signal) => {
    if (settled) return;
    if (child && typeof child.kill === "function") {
      try {
        child.kill(signal);
      } catch (_) {}
    }
    if (!shutdownTimer) {
      const timeoutMs = io.shutdownTimeoutMs || 5000;
      shutdownTimer = setTimeout(() => {
        if (!settled && child) {
          stderr(`[arena:demo] child process did not exit within ${timeoutMs}ms; escalating to forceful termination`);
          try {
            if (process.platform === "win32" && child.pid) {
              spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
            } else if (typeof child.kill === "function") {
              child.kill("SIGKILL");
            }
          } catch (_) {}
          finish(1);
        }
      }, timeoutMs);
    }
  };

  const onSigInt = () => forwardSignal("SIGINT");
  const onSigTerm = () => forwardSignal("SIGTERM");
  const onExit = () => forwardSignal("SIGTERM");

  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);
  process.on("exit", onExit);

  const finish = (code) => {
    if (settled) return;
    settled = true;
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }
    process.removeListener("SIGINT", onSigInt);
    process.removeListener("SIGTERM", onSigTerm);
    process.removeListener("exit", onExit);
    codeResolver(code);
  };

  child.once("error", (error) => {
    stderr(`[arena:demo] child failed to start: ${error.message}`);
    finish(1);
  });

  child.once("exit", (code, signal) => {
    if (signal) stderr(`[arena:demo] Arena stopped by ${signal}`);
    finish(typeof code === "number" ? code : 1);
  });

  return result;
}

if (require.main === module) {
  run().then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  ROOT,
  ENTRYPOINT,
  DEFAULT_DB_PATH,
  DEFAULT_STORAGE_DIR,
  PINNED_RUNNER_IMAGE,
  PINNED_RUNNER_IMAGE_ID,
  parseOptions,
  buildLaunchSpec,
  defaultDockerPreflight,
  defaultCheckPortFree,
  ensurePersistentDirectories,
  run
};
