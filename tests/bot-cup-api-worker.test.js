"use strict";

/**
 * Integration: the Bot Cup API as a real Worker (`wrangler dev --local`, env "test") on a local D1 built from the
 * migration files. One registration end to end: register -> OTP from the dev outbox -> verify -> session -> /me.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const {
  availablePort,
  readWorkerHost,
  workerOrigin,
  wranglerLauncher,
  PROCESS_GROUP_SPAWN_OPTIONS,
  stopProcessTree,
} = require("../config/local-runtime");
const { spawnLocalCommand: spawnShellSafe } = require("../scripts/worker-dev");

const root = path.resolve(__dirname, "..");
const CONFIG = "apps/bot-cup-api/wrangler.jsonc";
const DATABASE = "ottv2-bot-cup-test";
const WEB = "http://localhost:5173";
const DEV_TOKEN = "integration-dev-token";
const STARTUP_TIMEOUT_MS = 60_000;
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };

function log(message) {
  process.stderr.write(`[bot-cup-api-worker ${new Date().toISOString()}] ${message}\n`);
}

function spawnWrangler(args, options = {}) {
  const launcher = wranglerLauncher();
  return spawnShellSafe(launcher.command, [...launcher.argsPrefix, ...args], { cwd: root, ...PROCESS_GROUP_SPAWN_OPTIONS, ...options }, spawn);
}

function runWrangler(args) {
  return new Promise((resolve, reject) => {
    const child = spawnWrangler(args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve(output) : reject(new Error(`wrangler ${args.join(" ")} exited ${code}\n${output.slice(-4000)}`))));
  });
}

async function startWorker(localArgs) {
  const host = readWorkerHost();
  const port = await availablePort(host);
  const base = workerOrigin(host, port);
  let output = "";
  const child = spawnWrangler([
    "dev", ...localArgs,
    "--ip", host, "--port", String(port), "--inspector-port", "0", "--show-interactive-dev-session=false",
    "--var", "OTP_PEPPER:integration-pepper-0123456789", "--var", `BOT_CUP_DEV_TOKEN:${DEV_TOKEN}`,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-32_000); });
  child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-32_000); });
  const exited = new Promise((resolve) => child.once("exit", resolve));

  async function stop() {
    if (child.exitCode === null && child.signalCode === null) await stopProcessTree(child);
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    // workerd grandchildren can keep the pipes open after the tree is killed; do not let them hold the test process.
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    log(`wrangler dev stopped (exit ${child.exitCode ?? child.signalCode})`);
  }

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      if ((await fetch(`${base}/api/t/event`)).status === 200) return { base, stop };
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  await stop();
  throw new Error(`wrangler dev did not become ready\n${output.slice(-4000)}`);
}

test("Bot Cup API Worker registers a solo team end to end on local D1", { timeout: 180_000 }, async () => {
  fs.mkdirSync(path.join(root, ".wrangler"), { recursive: true });
  const persistTo = fs.mkdtempSync(path.join(root, ".wrangler", "bot-cup-api-"));
  const local = ["--config", CONFIG, "--env", "test", "--local", "--persist-to", persistTo];
  let worker;
  try {
    log("applying migrations");
    await runWrangler(["d1", "migrations", "apply", DATABASE, ...local]);
    const now = Date.now();
    await runWrangler([
      "d1", "execute", DATABASE, ...local, "--command",
      `INSERT INTO events (id, name, mode, registration_opens_at, registration_closes_at) VALUES ('test-event', 'OTT Bot Cup Integration', 'demo', ${now - 3_600_000}, ${now + 86_400_000})`,
    ]);
    worker = await startWorker(local);
    const { base } = worker;
    log(`ready at ${base}`);

    const event = await (await fetch(`${base}/api/t/event`)).json();
    assert.equal(event.id, "test-event");
    assert.equal(event.mode, "demo");
    assert.equal(event.registrationOpen, true);

    const post = (pathname, body, headers = {}) => fetch(`${base}/api/t${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB, ...headers },
      body: JSON.stringify(body),
    });

    const registered = await post("/register", {
      kind: "solo",
      handle: "integration-team",
      displayName: "Đội Tích Hợp",
      password: "integration-pass-1",
      consent: true,
      turnstileToken: "local",
      captain: { fullName: "Nguyễn Văn Test", mssv: "21020999" },
    });
    const registeredBody = await registered.json();
    assert.equal(registered.status, 201, JSON.stringify(registeredBody));
    assert.equal(registeredBody.otpSentTo, "21****99@vnu.edu.vn");

    assert.equal((await fetch(`${base}/api/t/_dev/outbox?to=21020999@vnu.edu.vn`)).status, 404);
    const outbox = await (await fetch(`${base}/api/t/_dev/outbox?to=21020999@vnu.edu.vn`, { headers: { authorization: `Bearer ${DEV_TOKEN}` } })).json();
    const otp = outbox.messages[0]?.text_body.match(/\b(\d{6})\b/)?.[1];
    assert.match(otp, /^\d{6}$/);

    const verified = await post("/register/verify", { handle: "integration-team", otp });
    assert.equal(verified.status, 200);
    const cookie = verified.headers.get("set-cookie").split(";")[0];
    assert.match(cookie, /^__Host-ottcup_session=/);

    const me = await fetch(`${base}/api/t/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    const team = await me.json();
    assert.equal(team.status, "active");
    assert.equal(team.members[0].fullName, "Nguyễn Văn Test");

    assert.equal((await post("/logout", {}, { origin: "https://evil.test" })).status, 403);
  } finally {
    if (worker) await worker.stop();
    await fs.promises.rm(persistTo, RM_OPTIONS).catch((error) => log(`cleanup: ${error.message}`));
  }
});
