"use strict";

/**
 * tests/browser-arena-registration-demo.test.js
 *
 * Task 6 (Milestone M6b): Browser Local Acceptance Harness for Arena Public Demo.
 *
 * Self-contained end-to-end acceptance suite:
 * 1. Opt-in via OTT_ARENA_DEMO_E2E=1 (cleanly skipped by default).
 * 2. Preflight verification of Docker container runtime and pinned runner image.
 * 3. Ephemeral SQLite database and storage dir under os.tmpdir().
 * 4. Loopback Arena API HTTP service (with embedded worker and public registration enabled).
 * 5. Static web server (Node server.js serving built apps/web/dist) on dynamic loopback port.
 * 6. Playwright Chromium with route guard enforcing loopback only.
 * 7. Real account UI registration:
 *    - User enters username, password, confirmPassword -> submits "Tạo tài khoản".
 *    - Asserts notice banner and automatic transition to login mode with username populated.
 * 8. Registration duplicate (409) assertion:
 *    - Re-attempts registration with same username.
 *    - Asserts readable error banner and verifies single database user record.
 * 9. Account login via UI:
 *    - User enters credentials -> asserts welcome greeting banner.
 * 10. Code creation & sandbox draft:
 *     - Creates new bot via UI.
 *     - Pastes protocol v1 compliant starter code into editor.
 *     - Runs sandbox draft -> asserts candidate move and diagnostics.
 * 11. Version submission & build readiness:
 *     - Submits version -> waits for build status "ready".
 * 12. Distinct opponent setup (Account B):
 *     - Registers and logs in distinct author account.
 *     - Provisions ready bot version.
 * 13. Cross-author ownership enforcement:
 *     - Account B attempts to upload version to Account A's bot.
 *     - Asserts HTTP 403 Forbidden with code OWNERSHIP_DENIED.
 * 14. Practice match execution & live frame streaming:
 *     - Account A initiates practice match against Account B's bot via UI.
 *     - Observes live board streaming.
 *     - Waits for match completion in database (acceptedPlies > 0, no crash).
 * 15. Replay inspection & schema validation:
 *     - Opens replay view in UI, verifies 81 cells.
 *     - Validates replay JSON against validateReplayDocument contract.
 * 16. Stop and restart persistence assertion:
 *     - Stops Arena service.
 *     - Starts new Arena service with the EXACT same persistent DB and storage dir.
 *     - Re-authenticates Account A.
 *     - Verifies account, bot, ready version, and match replay survive the restart intact.
 * 17. Clean teardown and redacted diagnostics on failure.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const {
  ROOT,
  getFreePort,
  waitFor,
  startArenaTestService,
  startStaticWebServer,
  createIsolatedUserPage,
  redactTokens
} = require("./arena-demo/fixture.js");

const isE2EOptIn = (process.env.OTT_ARENA_DEMO_E2E || "").trim() === "1" || (process.env.OTT_ARENA_DEMO_E2E || "").trim().toLowerCase() === "true";

// Compliant Node.js starter bot code for Arena protocol v1
const LEGAL_BOT_CODE = `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    if (msg.type === 'start') {
      if (msg.requestId) {
        process.stdout.write(JSON.stringify({ protocolVersion: 1, type: 'ready', requestId: msg.requestId }) + '\\n');
      }
      return;
    }
    if (msg.type === 'turn') {
      const moves = msg.legalMoves || msg.observation?.legalMoves || [];
      let move = moves[0];
      if (!move) {
        const pieces = msg.state?.pieces || msg.board || [];
        const seat = msg.seat || msg.turn || 'A';
        const myPieces = pieces.filter((p) => (p.owner === seat || p.player === seat));
        for (const p of myPieces) {
          const px = Number(p.x);
          const py = Number(p.y);
          const deltas = [[0, 1], [0, -1], [1, 0], [-1, 0]];
          for (const [dx, dy] of deltas) {
            const tx = px + dx;
            const ty = py + dy;
            if (tx >= 0 && tx < 9 && ty >= 0 && ty < 9) {
              const occupied = pieces.some((o) => Number(o.x) === tx && Number(o.y) === ty);
              if (!occupied) {
                move = { from: { x: px, y: py }, to: { x: tx, y: ty } };
                break;
              }
            }
          }
          if (move) break;
        }
        if (!move) {
          move = { from: { x: 0, y: 1 }, to: { x: 0, y: 2 } };
        }
      }
      const response = {
        protocolVersion: 1,
        type: 'action',
        requestId: msg.requestId,
        move,
        comment: 'demo verified legal move'
      };
      process.stdout.write(JSON.stringify(response) + '\\n');
    }
  } catch (err) {
    process.stderr.write('bot-err: ' + err.message + '\\n');
  }
});
`.trim();

test("Arena Public Demo Browser Local Acceptance", {
  skip: !isE2EOptIn ? "Opt-in only via OTT_ARENA_DEMO_E2E=1. Real E2E is coordinated by supervisor." : false,
  timeout: 120_000
}, async (t) => {
  console.log("[E2E] Starting Arena Public Demo Acceptance Test...");

  // Sanitize inherited environment variables
  delete process.env.OTT_ARENA_API_ENDPOINT;
  delete process.env.VITE_OTT_ARENA_API_ENDPOINT;

  // Dynamically import ESM modules when test is opted-in
  const { chromium } = await import("playwright");
  const { validateReplayDocument } = await import("../packages/arena/src/contracts/index.mjs");
  const { probeContainerRuntime } = await import("../packages/arena-node/src/execution/container-executor.mjs");

  // ── Step 1: Preflight Container Probe ─────────────────────────────────────
  const containerProbe = probeContainerRuntime();
  if (!containerProbe.available) {
    throw new Error(
      `[E2E BLOCKED] Docker container runtime unavailable (${containerProbe.reason || "daemon down"}). Prepare Docker Desktop before running E2E.`
    );
  }

  // ── Step 2: Temporary Storage and Port Setup ──────────────────────────────
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ott-arena-demo-e2e-"));
  const dbPath = path.join(tempDir, "arena.db");
  const storageDir = path.join(tempDir, "artifacts");
  fs.mkdirSync(storageDir, { recursive: true });

  const webPort = await getFreePort();
  const apiPort = await getFreePort();
  const appOrigin = `http://127.0.0.1:${webPort}`;
  const apiOrigin = `http://127.0.0.1:${apiPort}`;

  // ── Step 3: Fresh Frontend Assets Build with Explicit Loopback Endpoint ───
  console.log(`[E2E] Building fresh frontend assets with explicit loopback endpoint ${apiOrigin}...`);
  const buildResult = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:web"], {
    cwd: ROOT,
    env: {
      ...process.env,
      VITE_OTT_ARENA_API_ENDPOINT: apiOrigin,
      VITE_OTT_PLAYHTML_HOST: "",
      VITE_OTT_PLAYHTML_CONTROL_ENDPOINT: ""
    },
    shell: process.platform === "win32",
    stdio: "inherit"
  });
  assert.equal(buildResult.status, 0, "Frontend build (npm run build:web) must succeed");

  let staticServer = null;
  let arenaService = null;
  let browser = null;
  let activeContextA = null;
  let activePageA = null;
  let testPassed = false;
  const recordedApiLogs = [];

  t.after(async () => {
    console.log("[E2E] Tearing down test resources...");
    if (activeContextA) await activeContextA.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (staticServer) await staticServer.stop().catch(() => {});
    if (arenaService) await arenaService.stop().catch(() => {});

    if (testPassed) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log("[E2E] Cleaned up temporary directory.");
      } catch (_) {}
    } else {
      console.warn(`[E2E EVIDENCE PRESERVED] Temp data preserved at: ${tempDir}`);
      if (recordedApiLogs.length > 0) {
        const dumpPath = path.join(ROOT, "tests", "arena-demo-e2e-network-failure.json");
        try {
          fs.writeFileSync(dumpPath, JSON.stringify(redactTokens(recordedApiLogs.slice(-50)), null, 2));
          console.warn(`[E2E EVIDENCE PRESERVED] Redacted network logs saved to: ${dumpPath}`);
        } catch (_) {}
      }
    }
  });

  // ── Step 4: Start Services ────────────────────────────────────────────────
  console.log(`[E2E] Starting static web server on ${appOrigin}...`);
  staticServer = await startStaticWebServer({ port: webPort });

  console.log(`[E2E] Starting loopback Arena service on ${apiOrigin}...`);
  arenaService = await startArenaTestService({
    port: apiPort,
    dbPath,
    storageDir,
    allowedOrigins: [appOrigin, `http://localhost:${webPort}`],
    localDemoContainers: true,
    trustedMode: false,
    externalWorker: false,
    publicRegistration: true
  });
  const db = arenaService.db || arenaService.arenaService.db;

  // Verify capability flag
  const capRes = await fetch(`${apiOrigin}/api/arena/v1/capabilities`);
  assert.equal(capRes.status, 200);
  const capData = await capRes.json();
  assert.equal(capData.publicRegistration, true, "Capabilities must reflect publicRegistration: true");

  // ── Step 5: Launch Browser & Open Arena ───────────────────────────────────
  console.log("[E2E] Launching browser and navigating to Arena...");
  browser = await chromium.launch({ headless: true });

  const { context, page } = await createIsolatedUserPage(browser, {
    appOrigin,
    apiOrigin,
    onApiRecord: (entry) => recordedApiLogs.push(entry)
  });
  activeContextA = context;
  activePageA = page;

  await page.goto(appOrigin, { waitUntil: "networkidle" });
  const enterBtn = page.getByRole("button", { name: /Vào đấu trường/i });
  await enterBtn.waitFor({ state: "visible", timeout: 12_000 });
  await enterBtn.click();
  await page.locator('[data-testid="app-state"][data-state="arena"]').waitFor({ state: "visible", timeout: 10_000 });

  // Assert runtime endpoint is explicitly configured to loopback
  const resolvedEndpoint = await page.evaluate(() => {
    return typeof window.OTT_ARENA_API_ENDPOINT === "string" ? window.OTT_ARENA_API_ENDPOINT : "";
  });
  assert.equal(resolvedEndpoint, apiOrigin, `Web app runtime config must resolve to loopback endpoint ${apiOrigin}`);

  // ── Step 6: Account UI Registration ───────────────────────────────────────
  console.log("[E2E] Performing full account UI registration...");
  const usernameA = `author_a_${Date.now().toString(36)}`;
  const passwordA = "AlphaPass123!";

  // Switch to register tab
  const registerTab = page.getByRole("tab", { name: "Đăng ký" });
  await registerTab.waitFor({ state: "visible", timeout: 8_000 });
  await registerTab.click();

  await page.getByLabel("Tên đăng nhập").fill(usernameA);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(passwordA);
  await page.getByLabel("Xác nhận mật khẩu").fill(passwordA);

  const createAccountBtn = page.getByRole("button", { name: "Tạo tài khoản" });
  await createAccountBtn.waitFor({ state: "visible" });
  await createAccountBtn.click();

  // Assert registration success feedback and switch to login
  const noticeMsg = page.getByRole("status");
  await noticeMsg.waitFor({ state: "visible", timeout: 8_000 });
  const noticeText = await noticeMsg.innerText();
  assert.ok(
    noticeText.includes("Tài khoản đã tạo") || noticeText.includes("đăng nhập"),
    `Expected notice indicating registration success, got: ${noticeText}`
  );

  // ── Step 7: Registration Duplicate 409 Assertion ──────────────────────────
  console.log("[E2E] Verifying duplicate registration (409 USERNAME_TAKEN) UI handling...");
  await registerTab.click();
  await page.getByLabel("Tên đăng nhập").fill(usernameA);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(passwordA);
  await page.getByLabel("Xác nhận mật khẩu").fill(passwordA);
  await createAccountBtn.click();

  const errorAlert = page.locator('[data-testid="login-error-alert"]');
  await errorAlert.waitFor({ state: "visible", timeout: 8_000 });
  const errorText = await errorAlert.innerText();
  assert.ok(
    errorText.toLowerCase().includes("taken") ||
    errorText.toLowerCase().includes("tồn tại") ||
    errorText.toLowerCase().includes("trùng") ||
    errorText.includes("USERNAME_TAKEN"),
    `Duplicate registration should display readable error, got: ${errorText}`
  );

  // Verify only 1 row was created in SQLite users table
  const userCount = db
    .prepare("SELECT COUNT(*) as count FROM users WHERE normalized_username = ?")
    .get(usernameA.toLowerCase()).count;
  assert.equal(userCount, 1, "Database must strictly contain 1 row for unique registered username");

  // ── Step 8: Account Login ─────────────────────────────────────────────────
  console.log("[E2E] Logging in with newly registered account...");
  const loginTab = page.getByRole("tab", { name: "Đăng nhập" });
  await loginTab.click();
  await page.getByLabel("Mật khẩu", { exact: true }).fill(passwordA);
  await page.getByRole("button", { name: "Đăng nhập" }).click();

  await page.getByText(new RegExp(`Xin chào,.*${usernameA}`, "i")).waitFor({ state: "visible", timeout: 10_000 });
  console.log("[E2E] Account successfully logged in.");

  // ── Step 9: Create Bot, Run Draft & Submit Version to READY ───────────────
  console.log("[E2E] Creating bot and executing sandbox draft...");
  await page.getByRole("tab", { name: "Quản lý Bot" }).click();
  await page.getByRole("heading", { name: "Danh sách Bot" }).waitFor({ state: "visible" });

  const botNameA = "bot-alpha";
  await page.getByLabel("Tên Bot mới").fill(botNameA);
  await page.getByRole("button", { name: "Tạo Bot" }).click();

  const botBtnA = page.getByRole("button", { name: new RegExp(botNameA, "i") });
  await botBtnA.waitFor({ state: "visible", timeout: 8_000 });
  await botBtnA.click();

  const editor = page.locator("textarea").first();
  await editor.waitFor({ state: "visible" });
  await editor.fill(LEGAL_BOT_CODE);

  // Run Draft
  const runDraftBtn = page.locator('[data-testid="btn-run-draft"]');
  await runDraftBtn.waitFor({ state: "visible" });
  await runDraftBtn.click();

  const draftCard = page.locator('[data-testid="draft-diagnostics-card"]');
  await draftCard.waitFor({ state: "visible", timeout: 25_000 });
  const draftText = await draftCard.innerText();
  assert.ok(draftText.includes("Nước đi hợp lệ"), `Draft badge must indicate legal move: ${draftText}`);
  assert.ok(draftText.includes("Cách ly: OCI Container"), `Draft must indicate OCI container isolation: ${draftText}`);
  assert.match(draftText, /Nước đi đề xuất:\s*\(\d+,\s*\d+\)\s*→\s*\(\d+,\s*\d+\)/, "Draft must render candidate move coordinates");
  assert.ok(draftText.includes("Có (Chấp nhận)"), "Draft must indicate move acceptance by referee rules");
  await page.locator('[data-testid="draft-next-state-summary"]').waitFor({ state: "visible", timeout: 5000 });
  console.log("[E2E] Draft candidate move and referee diagnostics successfully verified in container.");

  // Submit Version
  console.log("[E2E] Submitting bot version...");
  await page.getByRole("button", { name: "Nộp phiên bản" }).click();
  await page.waitForTimeout(2000);

  // Poll for READY status
  await waitFor(async () => {
    await page.getByRole("tab", { name: "Trận đấu" }).click();
    await page.waitForTimeout(200);
    await page.getByRole("tab", { name: "Quản lý Bot" }).click();
    const cells = await page.locator("td").allInnerTexts();
    return cells.some((cell) => cell.includes("ready"));
  }, "Bot version build ready", 35_000, 1000);

  const botARow = db.prepare("SELECT id FROM bots WHERE name = ?").get(botNameA);
  assert.ok(botARow, "bot-alpha record must exist in DB");
  const verARow = db.prepare("SELECT id FROM bot_versions WHERE bot_id = ? AND build_status = 'ready'").get(botARow.id);
  assert.ok(verARow, "bot-alpha ready version must exist in DB");
  console.log(`[E2E] bot-alpha version ${verARow.id} reached ready status.`);

  // ── Step 10: Provision Opponent (Account B) & Cross-Author Ownership ──────
  console.log("[E2E] Setting up distinct opponent Account B...");
  const usernameB = `author_b_${Date.now().toString(36)}`;
  const passwordB = "BetaPass123!";

  // Register Account B via API
  const regBRes = await fetch(`${apiOrigin}/api/arena/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: usernameB, password: passwordB })
  });
  assert.equal(regBRes.status, 201, "Account B registration must return 201");

  // Login Account B via API
  const loginBRes = await fetch(`${apiOrigin}/api/arena/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: usernameB, password: passwordB })
  });
  assert.equal(loginBRes.status, 200, "Account B login must return 200");
  const { token: tokenB } = await loginBRes.json();

  // Ownership Assertion: Account B tries to upload a version to Account A's bot
  console.log("[E2E] Asserting cross-author ownership protection (403 OWNERSHIP_DENIED)...");
  const attackRes = await fetch(`${apiOrigin}/api/arena/v1/bots/${botARow.id}/versions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${tokenB}`,
      "Idempotency-Key": `cross-attack-${Date.now()}`
    },
    body: JSON.stringify({ source: LEGAL_BOT_CODE, profileId: "node" })
  });
  assert.equal(attackRes.status, 403, "Cross-author upload must be 403 Forbidden");
  const attackBody = await attackRes.json().catch(() => ({}));
  assert.equal(attackBody.error?.code || attackBody.code, "OWNERSHIP_DENIED");
  console.log("[E2E] Ownership barrier verified: 403 OWNERSHIP_DENIED.");

  // Create Bot B and build ready version for Account B
  const botBRes = await fetch(`${apiOrigin}/api/arena/v1/bots`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${tokenB}`,
      "Idempotency-Key": `create-bot-b-${Date.now()}`
    },
    body: JSON.stringify({ name: "bot-beta" })
  });
  assert.equal(botBRes.status, 201);
  const { bot: botB } = await botBRes.json();

  const verBRes = await fetch(`${apiOrigin}/api/arena/v1/bots/${botB.id}/versions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${tokenB}`,
      "Idempotency-Key": `upload-ver-b-${Date.now()}`
    },
    body: JSON.stringify({ source: LEGAL_BOT_CODE, profileId: "node" })
  });
  assert.equal(verBRes.status, 201);
  const { version: verB } = await verBRes.json();

  const verBRow = await waitFor(async () => {
    const row = db.prepare("SELECT * FROM bot_versions WHERE id = ?").get(verB.id);
    return row && row.build_status === "ready" ? row : false;
  }, "Bot B ready version in DB", 30_000, 1000);
  assert.ok(verBRow, "Bot B ready version must exist");
  console.log(`[E2E] bot-beta version ${verBRow.id} reached ready status.`);

  // ── Step 11: Practice Match via UI & Live Frame Observation ───────────────
  console.log("[E2E] Initiating practice match between bot-alpha and bot-beta...");
  await page.getByRole("tab", { name: "Quản lý Bot" }).click();

  const refreshPracticeBtn = page.getByRole("button", { name: "Làm mới danh sách" });
  await refreshPracticeBtn.waitFor({ state: "visible", timeout: 8_000 });
  await refreshPracticeBtn.click();

  // Wait for bot-beta version to appear in Seat B select
  await page.waitForFunction(
    (v2Id) => {
      const sel = document.querySelector('select[aria-label="Phiên bản bot Seat B"]');
      return sel && Array.from(sel.options).some((o) => o.value === v2Id);
    },
    verBRow.id,
    { timeout: 15_000 }
  );

  const seatASelect = page.getByLabel("Phiên bản bot Seat A");
  const seatBSelect = page.getByLabel("Phiên bản bot Seat B");
  await seatASelect.selectOption(verARow.id);
  await seatBSelect.selectOption(verBRow.id);

  const practiceResponsePromise = page.waitForResponse(
    (res) => res.url().includes("/api/arena/v1/matches") && res.request().method() === "POST" && res.status() === 201
  );
  await page.getByRole("button", { name: "Bắt đầu trận đấu tập" }).click();
  const practiceRes = await practiceResponsePromise;
  const practiceData = await practiceRes.json();
  const practiceMatchId = practiceData?.match?.id;
  assert.ok(practiceMatchId, "Practice match creation must return match ID");
  console.log(`[E2E] Created practice match: ${practiceMatchId}`);

  // Assert navigation to Matches tab
  await page.getByRole("heading", { name: "Lịch sử trận đấu Arena" }).waitFor({ state: "visible", timeout: 8_000 });

  // Observe live frame (non-optional live observation)
  const watchLiveBtn = page.locator(`[data-testid="match-live-${practiceMatchId}"]`).or(
    page.getByRole("button", { name: "Xem trực tiếp" }).first()
  );
  await watchLiveBtn.waitFor({ state: "visible", timeout: 10_000 });
  await watchLiveBtn.click();
  await page.locator('[data-testid^="board-cell-"]').first().waitFor({ state: "visible", timeout: 10_000 });
  const liveCellsCount = await page.locator('[data-testid^="board-cell-"]').count();
  assert.equal(liveCellsCount, 81, "Live match streaming must display 81 board cells");
  console.log(`[E2E] Live match streaming cells verified (${liveCellsCount} cells).`);

  // Wait for match completion in database strictly by practiceMatchId
  const matchResultRow = await waitFor(async () => {
    const row = db.prepare("SELECT * FROM match_results WHERE match_id = ?").get(practiceMatchId);
    return row ? row : false;
  }, `Practice match ${practiceMatchId} completion in DB`, 45_000, 1000);
  assert.ok(matchResultRow, `Practice match result row for ${practiceMatchId} must exist`);
  const matchResult = JSON.parse(matchResultRow.result_json);
  console.log(`[E2E] Practice match ${practiceMatchId} completed: moves=${matchResult.acceptedPlies}, reason=${matchResult.reason}`);
  assert.ok(matchResult.acceptedPlies > 0, "Practice match accepted plies must be > 0");
  assert.ok(!["crash", "protocol_error", "output_limit"].includes(matchResult.reason), "Must not crash");

  // ── Step 12: Replay Inspection & Contract Validation ──────────────────────
  console.log("[E2E] Inspecting match replay...");
  const liveReplayBtn = page.locator('[data-testid="btn-live-view-replay"]');
  if (await liveReplayBtn.isVisible()) {
    await liveReplayBtn.click();
  } else {
    await page.locator("header").getByRole("button", { name: "Làm mới" }).first().click();
    const viewReplayBtn = page.getByRole("button", { name: /Xem Replay/i }).first();
    await viewReplayBtn.waitFor({ state: "visible", timeout: 10_000 });
    await viewReplayBtn.click();
  }

  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="board-cell-"]').length === 81, { timeout: 15_000 });
  console.log("[E2E] Replay board verified with 81 cells.");

  // Fetch replay JSON from API with Authorization and validate against contracts schema
  const loginARes = await fetch(`${apiOrigin}/api/arena/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: usernameA, password: passwordA })
  });
  assert.equal(loginARes.status, 200);
  const { token: tokenA } = await loginARes.json();

  const replayRes = await fetch(`${apiOrigin}/api/arena/v1/matches/${practiceMatchId}/replay`, {
    headers: { "Authorization": `Bearer ${tokenA}` }
  });
  assert.equal(replayRes.status, 200);
  const replayBody = await replayRes.json();
  const replayDoc = replayBody.replay || replayBody;
  const replayValidation = validateReplayDocument(replayDoc);
  assert.equal(replayValidation.ok, true, `Replay document must satisfy schema: ${JSON.stringify(replayValidation.errors)}`);
  console.log("[E2E] Replay document schema validation passed.");

  // ── Step 13: Stop & Restart Persistence Assertion ─────────────────────────
  console.log("[E2E] Testing Arena stop and restart persistence on same database and storage...");
  await arenaService.stop();

  // Restart new service instance pointing to SAME dbPath and storageDir
  const restartedService = await startArenaTestService({
    port: apiPort,
    dbPath,
    storageDir,
    allowedOrigins: [appOrigin, `http://localhost:${webPort}`],
    localDemoContainers: true,
    trustedMode: false,
    externalWorker: false,
    publicRegistration: true
  });
  arenaService = restartedService;

  // DB assertions: verify bot and captured version with build_status='ready'
  const persistedVersionRow = restartedService.db.prepare("SELECT * FROM bot_versions WHERE id = ?").get(verARow.id);
  assert.ok(persistedVersionRow, `Version ${verARow.id} must exist in DB after restart`);
  assert.equal(persistedVersionRow.build_status, "ready", "Version build_status must remain 'ready' in DB");

  // Re-verify login of Account A after restart via API
  const reloginRes = await fetch(`${apiOrigin}/api/arena/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: usernameA, password: passwordA })
  });
  assert.equal(reloginRes.status, 200, "Account A must still be able to log in after restart");
  const { token: reloginToken } = await reloginRes.json();

  // Verify Bot A and ready version exist after restart via API
  const listBotsRes = await fetch(`${apiOrigin}/api/arena/v1/bots`, {
    headers: { "Authorization": `Bearer ${reloginToken}` }
  });
  assert.equal(listBotsRes.status, 200);
  const { bots: postRestartBots } = await listBotsRes.json();
  const foundBotA = postRestartBots.find((b) => b.name === botNameA);
  assert.ok(foundBotA, "bot-alpha must persist across service restart");

  const readyVerRes = await fetch(`${apiOrigin}/api/arena/v1/bots/${foundBotA.id}/ready-versions`, {
    headers: { "Authorization": `Bearer ${reloginToken}` }
  });
  assert.equal(readyVerRes.status, 200);
  const { versions: postRestartReadyVersions } = await readyVerRes.json();
  assert.ok(
    postRestartReadyVersions.some((v) => v.id === verARow.id && v.buildStatus === "ready"),
    `Captured READY version ${verARow.id} with buildStatus='ready' must persist across restart`
  );

  // Verify match replay still queryable and valid after restart via API
  const postRestartReplayRes = await fetch(`${apiOrigin}/api/arena/v1/matches/${practiceMatchId}/replay`, {
    headers: { "Authorization": `Bearer ${reloginToken}` }
  });
  assert.equal(postRestartReplayRes.status, 200, "Match replay must persist across service restart");
  const postRestartBody = await postRestartReplayRes.json();
  const postRestartReplay = postRestartBody.replay || postRestartBody;
  const postValidation = validateReplayDocument(postRestartReplay);
  assert.equal(postValidation.ok, true, "Replay must remain valid after restart");

  // UI Browser assertions: reload page and relogin in browser UI
  console.log("[E2E] Verifying browser reload and UI relogin post-restart...");
  await page.reload({ waitUntil: "networkidle" });
  const enterBtnRestart = page.getByRole("button", { name: /Vào đấu trường/i });
  if (await enterBtnRestart.isVisible()) {
    await enterBtnRestart.click();
    await page.locator('[data-testid="app-state"][data-state="arena"]').waitFor({ state: "visible", timeout: 8_000 });
  }

  const postRestartLoginTab = page.getByRole("tab", { name: "Đăng nhập" });
  await postRestartLoginTab.waitFor({ state: "visible", timeout: 10_000 });
  await postRestartLoginTab.click();
  await page.getByLabel("Tên đăng nhập").fill(usernameA);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(passwordA);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.getByText(new RegExp(`Xin chào,.*${usernameA}`, "i")).waitFor({ state: "visible", timeout: 10_000 });

  // Navigate to bot tab and verify bot and ready version are visible in UI
  await page.getByRole("tab", { name: "Quản lý Bot" }).click();
  const postRestartBotBtn = page.getByRole("button", { name: new RegExp(botNameA, "i") });
  await postRestartBotBtn.waitFor({ state: "visible", timeout: 8_000 });
  await postRestartBotBtn.click();

  // Click radio "Phiên bản đã lưu" (role="radio") and verify version scoped to saved-versions panel
  const savedRadio = page.getByRole("radio", { name: /Phiên bản đã lưu/i }).or(page.locator('[data-testid="toggle-mode-saved"]'));
  await savedRadio.waitFor({ state: "visible", timeout: 8_000 });
  await savedRadio.click();

  const savedVersionsView = page.locator('[data-testid="saved-versions-view"]');
  await savedVersionsView.waitFor({ state: "visible", timeout: 8_000 });
  await savedVersionsView.getByText(/v1/i).first().waitFor({ state: "visible", timeout: 8_000 });
  await savedVersionsView.getByText(/ready/i).first().waitFor({ state: "visible", timeout: 8_000 });

  // Navigate to matches tab and verify match replay in UI
  await page.getByRole("tab", { name: "Trận đấu" }).click();
  await page.getByRole("heading", { name: "Lịch sử trận đấu Arena" }).waitFor({ state: "visible" });
  const postRestartReplayBtn = page.getByRole("button", { name: /Xem Replay/i }).first();
  await postRestartReplayBtn.waitFor({ state: "visible", timeout: 8_000 });
  await postRestartReplayBtn.click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="board-cell-"]').length === 81, { timeout: 15_000 });
  console.log("[E2E] Browser UI reload, login, bot ready version, and replay verified post-restart.");

  testPassed = true;
  console.log("[E2E SUCCESS] All Arena public demo acceptance criteria passed!");
});
