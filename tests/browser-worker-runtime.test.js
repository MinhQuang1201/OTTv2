const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const test = require("node:test");
const { createBrowserDemoFixture } = require("./worker-runtime/fixture");

test("two isolated browser profiles create, join, attach and play a legal move over one YProvider each", async (t) => {
  if (process.env.OTT_BROWSER_RUNTIME_TEST !== "1") {
    t.skip("run with npm run test:browser-worker-runtime to start local Wrangler and Chromium");
    return;
  }
  let fixture;
  let browser;
  const sockets = { a: [], b: [] };
  const requests = { a: [], b: [] };
  const frames = { a: [], b: [] };
  const pageErrors = { a: [], b: [] };
  const consoleErrors = { a: [], b: [] };
  const contexts = [];
  t.after(async () => {
    for (const context of contexts) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (fixture) await fixture.stop();
  });

  fixture = await createBrowserDemoFixture();
  browser = await chromium.launch({ headless: true });

  async function openProfile(key, name) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    contexts.push(context);
    const page = await context.newPage();
    page.on("request", (request) => {
      const url = new URL(request.url());
      requests[key].push({ method: request.method(), path: url.pathname });
    });
    page.on("websocket", (socket) => {
      const url = new URL(socket.url());
      sockets[key].push(`${url.origin}${url.pathname}`);
      for (const [eventName, direction] of [["framesent", "sent"], ["framereceived", "received"]]) {
        socket.on(eventName, (event) => {
          const payload = event.payload;
          if (typeof payload !== "string" || !payload.startsWith("__YPS:")) return;
          try {
            const message = JSON.parse(payload.slice(6));
            if (message.__ott === true) frames[key].push({ at: Date.now(), direction, type: message.type, error: message.error, ok: message.ok, revision: message.revision });
          } catch {}
        });
      }
    });
    page.on("pageerror", (error) => { pageErrors[key].push(error.message); });
    page.on("console", (message) => { if (message.type() === "error") consoleErrors[key].push(message.text()); });
    await page.addInitScript(({ workerOrigin }) => {
      window.OTT_PLAYHTML_CONTROL_ENDPOINT = workerOrigin;
      window.OTT_PLAYHTML_HOST = workerOrigin;
    }, { workerOrigin: fixture.workerOrigin });
    await page.goto(fixture.appOrigin, { waitUntil: "networkidle" });
    await page.getByLabel("Tên của bạn").first().fill(name);
    return page;
  }

  const a = await openProfile("a", "Alice");
  await a.getByRole("button", { name: "Tạo phòng" }).click();
  try {
    await a.locator('[data-testid="game-screen"]').waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    const diagnostics = await fixture.diagnostics();
    const ui = await a.evaluate(() => ({ game: Boolean(document.querySelector('[data-testid="game-screen"]')), factory: typeof window.OTT_PLAYHTML_CONNECTION_FACTORY, bootstrap: typeof window.OTT_PLAYHTML_BOOTSTRAP }));
    throw new Error(`Creator did not attach. body=${JSON.stringify((await a.locator("body").innerText()).slice(0, 500))} ui=${JSON.stringify(ui)} pageErrors=${JSON.stringify(pageErrors.a)} consoleErrors=${JSON.stringify(consoleErrors.a)} sockets=${JSON.stringify(sockets.a)} frames=${JSON.stringify(frames.a)} worker=${JSON.stringify(diagnostics)}`);
  }
  await a.waitForFunction(() => document.querySelectorAll('[data-testid^="board-cell-"]').length === 81);
  const roomLabel = await a.locator('[data-testid="room-label"]').textContent();
  assert.ok(roomLabel && /ott-[0-9a-f-]+/.test(roomLabel), "creator should be attached to its canonical Worker room");

  const b = await openProfile("b", "Bob");
  await b.reload({ waitUntil: "networkidle" });
  const roomButton = b.locator('[data-testid="room-list"] button').first();
  await roomButton.waitFor({ state: "visible" });
  await roomButton.click();
  await b.locator('[data-testid="game-screen"]').waitFor({ state: "visible" });
  await b.waitForFunction(() => document.querySelectorAll('[data-testid^="board-cell-"]').length === 81);

  // The Worker intentionally rate-limits each socket to one OTT command per 40 ms.
  // Leave ample room after B's attach and between the two UI clicks.
  await a.waitForTimeout(500);
  const source = a.locator('[data-testid="board-cell-A3"]');
  await source.click();
  const target = a.locator('[data-testid^="board-cell-"][aria-label*="nước hợp lệ"]').first();
  await target.waitFor({ state: "visible" });
  const destination = await target.evaluate((cell) => ({ x: cell.dataset.x, y: cell.dataset.y }));
  await a.waitForTimeout(100);
  await target.click();

  try {
    await b.waitForFunction(({ x, y }) => {
      const from = document.querySelector('[data-testid="board-cell-A3"]');
      const to = document.querySelector(`[data-x="${x}"][data-y="${y}"]`);
      return from && to && from.getAttribute("aria-label")?.includes("trống") && !to.getAttribute("aria-label")?.includes("trống");
    }, destination, { timeout: 10_000 });
  } catch {
    const diagnostics = await fixture.diagnostics();
    const ui = await Promise.all([a, b].map((page) => page.evaluate(() => ({ game: Boolean(document.querySelector('[data-testid="game-screen"]')), pieces: [...document.querySelectorAll('[data-testid^="board-cell-"]')].filter((cell) => !cell.getAttribute("aria-label")?.includes("trống")).map((cell) => cell.getAttribute("aria-label")) }))));
    throw new Error(`Move did not propagate. destination=${JSON.stringify(destination)} ui=${JSON.stringify(ui)} frames=${JSON.stringify(frames)} sockets=${JSON.stringify(sockets)} worker=${JSON.stringify(diagnostics)}`);
  }
  for (const key of ["a", "b"]) {
    assert.equal(sockets[key].length, 1, `${key} profile should use exactly one provider WebSocket`);
    assert.match(sockets[key][0], /\/parties\/main\/ott-[0-9a-f-]+/);
    assert.deepEqual(pageErrors[key], [], `${key} browser console should have no uncaught page errors`);
    assert.deepEqual(consoleErrors[key], [], `${key} browser console should have no error messages`);
  }
  const requestCounts = Object.fromEntries(Object.entries(requests).map(([key, values]) => [key, values.length]));
  await a.waitForTimeout(1_200);
  for (const key of ["a", "b"]) {
    assert.equal(requests[key].length, requestCounts[key], `${key} profile should not poll over HTTP after attach`);
    assert.deepEqual(requests[key].filter(({ path }) => /party|presence|cursor|awareness/i.test(path)), [], `${key} profile should not open a secondary collaboration endpoint`);
  }
});
