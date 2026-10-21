"use strict";

/**
 * tests/arena-demo/fixture.js
 *
 * Self-contained orchestration fixture for Arena Public Demo browser acceptance tests.
 * Manages:
 * - Temporary SQLite database & artifact directories.
 * - Loopback Arena API service with embedded worker and local container demo mode.
 * - Loopback static web server (Node server.js serving apps/web/dist) with dynamic port.
 * - Route-guarded Playwright browser context enforcing strictly loopback traffic.
 * - Redacted failure logs & diagnostics.
 */

const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");

/**
 * Allocates an ephemeral free TCP port on 127.0.0.1.
 * @returns {Promise<number>}
 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/**
 * Checks that a port is free on host.
 * @param {number} port
 * @param {string} [host="127.0.0.1"]
 * @returns {Promise<boolean>}
 */
function ensurePortFree(port, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`Port ${port} is already in use on ${host}`));
    });
    socket.once("error", (error) => {
      if (error.code === "ECONNREFUSED") return resolve(true);
      reject(error);
    });
  });
}

/**
 * Bounded polling helper.
 * @template T
 * @param {() => Promise<T|null|boolean> | T|null|boolean} operation
 * @param {string} label
 * @param {number} [timeoutMs=30000]
 * @param {number} [intervalMs=250]
 * @returns {Promise<T>}
 */
function waitFor(operation, label, timeoutMs = 30_000, intervalMs = 250) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await operation();
        if (value) return resolve(value);
      } catch (_) {}
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`${label} readiness timed out after ${timeoutMs}ms`));
      }
      setTimeout(poll, intervalMs);
    };
    poll();
  });
}

/**
 * Gracefully terminates a spawned process tree.
 * @param {import("node:child_process").ChildProcess} child
 * @returns {Promise<void>}
 */
async function stopProcess(child, timeoutMs = 5000) {
  if (!child || child.killed || child.exitCode !== null) return;
  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    }, timeoutMs);

    child.once("exit", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve();
      }
    });

    try {
      if (process.platform === "win32" && child.pid) {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGTERM");
      }
    } catch (_) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve();
      }
    }
  });
}

/**
 * Starts an in-process loopback Arena service using startArenaService.
 * @param {object} options
 * @returns {Promise<{ arenaService: object, port: number, apiOrigin: string, stop: () => Promise<void> }>}
 */
async function startArenaTestService(options) {
  const { startArenaService } = await import("../../apps/arena-api/src/main.mjs");
  const bind = options.bind || "127.0.0.1";
  const port = options.port || (await getFreePort());

  const arenaService = await startArenaService({
    port,
    bind,
    dbPath: options.dbPath,
    storageDir: options.storageDir,
    allowedOrigins: options.allowedOrigins,
    localDemoContainers: options.localDemoContainers ?? true,
    trustedMode: options.trustedMode ?? false,
    externalWorker: options.externalWorker ?? false,
    publicRegistration: options.publicRegistration ?? true
  });

  const addr = arenaService.server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const apiOrigin = `http://${bind}:${actualPort}`;

  await waitFor(async () => {
    try {
      const res = await fetch(`${apiOrigin}/api/arena/v1/capabilities`);
      return res.ok;
    } catch {
      return false;
    }
  }, "Arena HTTP API capabilities readiness");

  return {
    arenaService,
    db: arenaService.db,
    port: actualPort,
    apiOrigin,
    stop: async () => {
      await arenaService.stop();
    }
  };
}

/**
 * Starts the static Node server (server.js) serving apps/web/dist.
 * @param {object} [options={}]
 * @returns {Promise<{ process: import("node:child_process").ChildProcess, port: number, appOrigin: string, stop: () => Promise<void> }>}
 */
async function startStaticWebServer(options = {}) {
  const port = options.port || (await getFreePort());
  const appOrigin = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });

  await waitFor(async () => {
    try {
      const res = await fetch(appOrigin);
      return res.ok;
    } catch {
      return false;
    }
  }, "Static web server readiness");

  return {
    process: child,
    port,
    appOrigin,
    stop: async () => {
      await stopProcess(child);
    }
  };
}

/**
 * Launches an isolated browser page configured with route guard and API endpoint injection.
 * @param {import("playwright").Browser} browser
 * @param {object} options
 * @returns {Promise<{ context: import("playwright").BrowserContext, page: import("playwright").Page }>}
 */
async function createIsolatedUserPage(browser, options) {
  const { appOrigin, apiOrigin, onApiRecord } = options;
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 }
  });

  const page = await context.newPage();

  // Route guard: strictly reject all non-loopback network calls
  await page.route("**/*", (route) => {
    const reqUrl = route.request().url();
    try {
      const parsed = new URL(reqUrl);
      if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
        return route.continue();
      }
      return route.abort("blockedbyclient");
    } catch {
      return route.continue();
    }
  });

  // Attach network response logging if requested
  if (typeof onApiRecord === "function") {
    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes("/api/arena/v1")) {
        let snippet = "";
        try {
          snippet = (await response.text()).slice(0, 300);
        } catch {}
        onApiRecord({
          url,
          status: response.status(),
          method: response.request().method(),
          body: snippet
        });
      }
    });
  }

  // Pre-seed API endpoint before any script executes
  await page.addInitScript(({ endpoint }) => {
    window.OTT_ARENA_API_ENDPOINT = endpoint;
    globalThis.OTT_ARENA_API_ENDPOINT = endpoint;
  }, { endpoint: apiOrigin });

  return { context, page };
}

/**
 * Redacts tokens, passwords, and sensitive keys from JSON or string diagnostics.
 * @param {any} data
 * @returns {any}
 */
function redactTokens(data) {
  if (typeof data === "string") {
    return data
      .replace(/("token"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
      .replace(/("password"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[REDACTED]");
  }
  if (Array.isArray(data)) {
    return data.map(redactTokens);
  }
  if (data && typeof data === "object") {
    const out = {};
    for (const [key, value] of Object.entries(data)) {
      if (key.toLowerCase().includes("token") || key.toLowerCase().includes("password") || key.toLowerCase().includes("secret")) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactTokens(value);
      }
    }
    return out;
  }
  return data;
}

module.exports = {
  ROOT,
  getFreePort,
  ensurePortFree,
  waitFor,
  stopProcess,
  startArenaTestService,
  startStaticWebServer,
  createIsolatedUserPage,
  redactTokens
};
