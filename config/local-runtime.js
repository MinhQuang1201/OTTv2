const net = require("node:net");
const dotenv = require("dotenv");

const DEFAULT_WORKER_HOST = "127.0.0.1";

function loadLocalEnv() {
  dotenv.config({ override: false });
}

function readWorkerHost(value = process.env.OTT_WORKER_HOST) {
  const host = String(value || DEFAULT_WORKER_HOST).trim();
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("OTT_WORKER_HOST must be 127.0.0.1, localhost, or ::1");
  }
  return host;
}

function readConfiguredPort(value, variableName = "OTT_WORKER_PORT") {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new Error(`${variableName} must be an integer between 1 and 65535`);
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${variableName} must be an integer between 1 and 65535`);
  }
  return port;
}

function availablePort(host = readWorkerHost()) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : null;
      server.close((error) => {
        if (error) return reject(error);
        if (!port) return reject(new Error("Could not reserve a Worker port"));
        resolve(port);
      });
    });
  });
}

async function resolveWorkerPort(value = process.env.OTT_WORKER_PORT) {
  const configured = readConfiguredPort(value);
  return configured ?? availablePort();
}

function workerOrigin(host, port, protocol = "http") {
  const normalizedHost = readWorkerHost(host);
  const formattedHost = normalizedHost.includes(":") ? `[${normalizedHost}]` : normalizedHost;
  return `${protocol}://${formattedHost}:${readConfiguredPort(port, "Worker port")}`;
}

function wranglerLauncher() {
  return {
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    argsPrefix: ["--no-install", "wrangler"],
  };
}

loadLocalEnv();

module.exports = {
  DEFAULT_WORKER_HOST,
  loadLocalEnv,
  readWorkerHost,
  readConfiguredPort,
  availablePort,
  resolveWorkerPort,
  workerOrigin,
  wranglerLauncher,
};
