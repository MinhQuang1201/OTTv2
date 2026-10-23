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
      `INSERT INTO events (id, name, mode, registration_opens_at, registration_closes_at, practice_opens_at) VALUES ('test-event', 'OTT Bot Cup Integration', 'demo', ${now - 3_600_000}, ${now + 86_400_000}, ${now - 3_600_000})`,
    ]);
    const runnerToken = "integration-runner-token-0123456789abcdef";
    const runnerHash = require("node:crypto").createHash("sha256").update(runnerToken).digest("hex");
    await runWrangler(["d1", "execute", DATABASE, ...local, "--command",
      `INSERT INTO runners (id, name, token_hash, created_at) VALUES ('runner-1', 'integration', '${runnerHash}', ${now})`]);
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

    // P3: an upload is stored as a BLOB in D1 and comes back byte for byte.
    const source = fs.readFileSync(path.join(root, "sdk/bot-cup/python/bot.py"));
    const form = new FormData();
    form.append("file", new Blob([source]), "bot.py");
    const uploaded = await fetch(`${base}/api/t/submissions`, { method: "POST", headers: { origin: WEB, cookie }, body: form });
    const uploadedBody = await uploaded.json();
    assert.equal(uploaded.status, 201, JSON.stringify(uploadedBody));
    assert.equal(uploadedBody.submission.sha256, require("node:crypto").createHash("sha256").update(source).digest("hex"));
    assert.equal(uploadedBody.submission.status, "checking");
    const downloaded = await fetch(`${base}/api/t/submissions/${uploadedBody.submission.id}/source`, { headers: { cookie } });
    assert.equal(downloaded.status, 200);
    assert.ok(Buffer.from(await downloaded.arrayBuffer()).equals(source));
    const tooBig = new FormData();
    tooBig.append("file", new Blob(["#".repeat(300 * 1024)]), "bot.py");
    assert.equal((await fetch(`${base}/api/t/submissions`, { method: "POST", headers: { origin: WEB, cookie }, body: tooBig })).status, 413);
    const listed = await (await fetch(`${base}/api/t/submissions`, { headers: { cookie } })).json();
    assert.equal(listed.finalSubmissionId, uploadedBody.submission.id);

    // P4: a runner claims the check (UPDATE … RETURNING on D1), passes it, plays the two smoke games with real replays.
    const runner = async (pathname, body) => {
      const response = await fetch(`${base}/runner/${pathname}`, {
        method: "POST",
        headers: { authorization: `Bearer ${runnerToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const { playCompactGame } = require("./bot-cup/games");
    for (let round = 0; round < 3; round++) {
      const { body } = await runner("claim", { slots: 4 });
      for (const job of body.jobs) {
        const report = job.kind === "check"
          ? { jobId: job.jobId, attempt: job.attempt, ok: true, log: "ok" }
          : { jobId: job.jobId, attempt: job.attempt, replay: await playCompactGame({ mapId: job.match.mapId }), stderr: { A: "a", B: "b" } };
        const done = await runner("complete", report);
        assert.equal(done.status, 200, JSON.stringify(done.body));
      }
    }
    const detail = await (await fetch(`${base}/api/t/submissions/${uploadedBody.submission.id}`, { headers: { cookie } })).json();
    assert.equal(detail.submission.status, "ready", JSON.stringify(detail));
    const games = await (await fetch(`${base}/api/t/matches`, { headers: { cookie } })).json();
    const smoke = games.matches.find((match) => match.stage === "smoke");
    const replay = await (await fetch(`${base}/api/t/matches/${smoke.id}/replay`, { headers: { cookie } })).json();
    assert.equal(replay.replay.frames.length, smoke.plies + 1, "the gzip BLOB comes back from D1 and expands");

    assert.equal((await post("/logout", {}, { origin: "https://evil.test" })).status, 403);
  } finally {
    if (worker) await worker.stop();
    await fs.promises.rm(persistTo, RM_OPTIONS).catch((error) => log(`cleanup: ${error.message}`));
  }
});
