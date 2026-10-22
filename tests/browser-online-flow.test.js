const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const test = require("node:test");
const { createBrowserDemoFixture } = require("./worker-runtime/fixture");

// Phase 1 online flow in two isolated browser profiles against local Wrangler:
// short-code invite link, waiting seat, move sync, reload + "Vào lại", and "Rời bàn" ending the game at once.
test("invite by short code, resume after reload and leave end the online game for both profiles", async (t) => {
  if (process.env.OTT_BROWSER_RUNTIME_TEST !== "1") {
    t.skip("run with npm run test:e2e to start local Wrangler and Chromium");
    return;
  }
  let fixture;
  let browser;
  const contexts = [];
  const pageErrors = { a: [], b: [] };
  t.after(async () => {
    for (const context of contexts) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (fixture) await fixture.stop();
  });

  fixture = await createBrowserDemoFixture();
  browser = await chromium.launch({ headless: true });

  async function openProfile(key) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    contexts.push(context);
    const page = await context.newPage();
    page.on("pageerror", (error) => { pageErrors[key].push(error.message); });
    await page.addInitScript(({ workerOrigin }) => {
      window.OTT_PLAYHTML_CONTROL_ENDPOINT = workerOrigin;
      window.OTT_PLAYHTML_HOST = workerOrigin;
    }, { workerOrigin: fixture.workerOrigin });
    return page;
  }

  async function step(name, page, action) {
    try {
      return await action();
    } catch (error) {
      const body = await page.locator("body").innerText().catch(() => "<unavailable>");
      const diagnostics = await fixture.diagnostics();
      throw new Error(`${name}: ${error.message}\nbody=${JSON.stringify(body.slice(0, 800))}\npageErrors=${JSON.stringify(pageErrors)}\nworkerStdout=${diagnostics.workerStdout.slice(-3000)}`);
    }
  }

  const boardReady = (page) => page.waitForFunction(() => document.querySelectorAll('[data-testid^="board-cell-"]').length === 81);
  const cellAt = (page, { x, y }) => page.locator(`[data-testid^="board-cell-"][data-x="${x}"][data-y="${y}"]`);

  const a = await openProfile("a");
  const alias = await step("A creates a room and sees the invite code", a, async () => {
    await a.goto(fixture.appOrigin, { waitUntil: "networkidle" });
    await a.getByLabel("Tên của bạn").first().fill("Alice");
    await a.getByRole("button", { name: "Tạo phòng" }).click();
    await a.locator('[data-testid="game-screen"]').waitFor({ state: "visible", timeout: 15_000 });
    await boardReady(a);
    const code = (await a.locator('[data-testid="room-alias"]').textContent({ timeout: 10_000 }))?.trim();
    assert.match(code ?? "", /^[A-Z0-9]{3}-[A-Z0-9]{3}$/, "creator should see a short shareable room code");
    await a.getByRole("region", { name: "Người chơi đang chờ" }).waitFor({ state: "visible" });
    return code;
  });

  const b = await openProfile("b");
  await step("B joins through the invite link", b, async () => {
    await b.goto(`${fixture.appOrigin}/?join=${encodeURIComponent(alias)}`, { waitUntil: "networkidle" });
    await b.getByLabel("Tên của bạn").first().fill("Bob");
    const roomField = b.getByLabel("Mã phòng").first();
    assert.equal(await roomField.inputValue(), alias, "invite link should pre-fill the room code");
    await b.getByRole("button", { name: "Vào phòng" }).click();
    await b.locator('[data-testid="game-screen"]').waitFor({ state: "visible", timeout: 15_000 });
    await boardReady(b);
  });

  await step("A's invite banner closes once B is seated", a, async () => {
    await a.locator('[data-testid="room-alias"]').waitFor({ state: "detached", timeout: 10_000 });
    await a.getByRole("region", { name: "Người chơi đang chờ" }).waitFor({ state: "detached" });
  });

  // The Worker rate-limits each socket to one OTT command per 40 ms; leave room after B's attach.
  await a.waitForTimeout(500);
  const move = await step("A plays a legal move that B sees", b, async () => {
    const source = a.locator('[data-testid^="board-cell-"][aria-label*="Người A"]').first();
    const from = await source.evaluate((cell) => ({ x: cell.dataset.x, y: cell.dataset.y }));
    await source.click();
    const target = a.locator('[data-testid^="board-cell-"][aria-label*="nước hợp lệ"]').first();
    await target.waitFor({ state: "visible" });
    const to = await target.evaluate((cell) => ({ x: cell.dataset.x, y: cell.dataset.y }));
    await a.waitForTimeout(100);
    await target.click();
    await b.waitForFunction(({ from: f, to: d }) => {
      const origin = document.querySelector(`[data-testid^="board-cell-"][data-x="${f.x}"][data-y="${f.y}"]`);
      const destination = document.querySelector(`[data-testid^="board-cell-"][data-x="${d.x}"][data-y="${d.y}"]`);
      return origin?.getAttribute("aria-label")?.includes("trống") && destination?.getAttribute("aria-label")?.includes("Người A");
    }, { from, to }, { timeout: 10_000 });
    return { from, to };
  });

  await step("A reloads and re-enters the same seat with Vào lại", a, async () => {
    await a.reload({ waitUntil: "networkidle" });
    const card = a.getByRole("region", { name: "Ván online đang dở" });
    await card.waitFor({ state: "visible", timeout: 10_000 });
    assert.match(await card.innerText(), new RegExp(`${alias}[\\s\\S]*Đỏ \\(A\\)`), "resume card should name the room and seat");
    const resume = card.getByRole("button", { name: "Vào lại" });
    await assertEnabled(resume);
    await resume.click();
    await a.locator('[data-testid="game-screen"]').waitFor({ state: "visible", timeout: 15_000 });
    await boardReady(a);
    assert.match(await cellAt(a, move.to).getAttribute("aria-label"), /Người A/, "resumed board keeps the played move");
    assert.match(await cellAt(a, move.from).getAttribute("aria-label"), /trống/);
  });

  await step("B leaves and A wins immediately", a, async () => {
    await b.waitForTimeout(300);
    await b.getByRole("button", { name: "Rời bàn", exact: true }).click();
    await b.getByRole("button", { name: "Xác nhận rời bàn", exact: true }).click();
    const outcome = a.locator('[data-testid="result-dialog-outcome"]');
    await outcome.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await outcome.getAttribute("data-outcome"), "win");
    assert.match(await outcome.innerText(), /Bạn thắng[\s\S]*Đối thủ đã rời bàn/);
  });

  assert.deepEqual(pageErrors, { a: [], b: [] }, "no uncaught page errors in either profile");
});

async function assertEnabled(locator) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await locator.isEnabled()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("button stayed disabled");
}
