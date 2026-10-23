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
  const sockets = { a: [], b: [], c: [] };
  const requests = { a: [], b: [], c: [] };
  const frames = { a: [], b: [], c: [] };
  const pageErrors = { a: [], b: [], c: [] };
  const consoleErrors = { a: [], b: [], c: [] };
  const contexts = [];
  t.after(async () => {
    for (const context of contexts) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (fixture) await fixture.stop();
  });

  fixture = await createBrowserDemoFixture({ spectator: process.env.OTT_SPECTATOR_RUNTIME_TEST === "1" });
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
      window.__activeWebSockets = [];
      const OriginalWS = window.WebSocket;
      if (typeof OriginalWS === "function") {
        const TrackedWebSocket = function (...args) {
          const ws = new OriginalWS(...args);
          window.__activeWebSockets.push(ws);
          return ws;
        };
        TrackedWebSocket.prototype = OriginalWS.prototype;
        TrackedWebSocket.CONNECTING = OriginalWS.CONNECTING;
        TrackedWebSocket.OPEN = OriginalWS.OPEN;
        TrackedWebSocket.CLOSING = OriginalWS.CLOSING;
        TrackedWebSocket.CLOSED = OriginalWS.CLOSED;
        window.WebSocket = TrackedWebSocket;
      }
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
  const roomLabel = a.locator('[data-testid="room-label"]');
  assert.match(await roomLabel.getAttribute("data-room-id") ?? "", /^ott-[0-9a-f-]+$/, "creator should be attached to its canonical Worker room");
  assert.match(await roomLabel.textContent() ?? "", /^Phòng [A-Z0-9]{3}-[A-Z0-9]{3}$/, "players should see the short room code, not the internal room id");

  const b = await openProfile("b", "Bob");
  await b.reload({ waitUntil: "networkidle" });
  const roomButton = b.locator('[data-testid="room-list"] button').first();
  await roomButton.waitFor({ state: "visible" });
  await roomButton.click();
  await b.locator('[data-testid="game-screen"]').waitFor({ state: "visible" });
  await b.waitForFunction(() => document.querySelectorAll('[data-testid^="board-cell-"]').length === 81);

  let c;
  if (process.env.OTT_SPECTATOR_RUNTIME_TEST === "1") {
    c = await openProfile("c", "Carol");
    const watchButton = c.getByRole("button", { name: /Xem trận.*Alice.*Bob/i });
    await watchButton.waitFor({ state: "visible", timeout: 10_000 });
    await watchButton.click();
    await c.locator('[data-testid="game-screen"]').waitFor({ state: "visible" });
    await c.waitForFunction(() => document.querySelectorAll('[data-testid^="board-cell-"]').length === 81);
    assert.equal(await c.locator('[data-testid^="board-cell-"]').first().isDisabled(), true, "spectator board must be read-only");
    assert.deepEqual(pageErrors.c, [], "spectator browser console should have no uncaught page errors");
    assert.deepEqual(consoleErrors.c, [], "spectator browser console should have no error messages");
  }

  // The Worker intentionally rate-limits each socket to one OTT command per 40 ms.
  // Leave ample room after B's attach and between the two UI clicks.
  await a.waitForTimeout(500);
  const source = a.locator('[data-testid^="board-cell-"][aria-label*="Người A"]').first();
  const sourcePosition = await source.evaluate((cell) => ({ x: cell.dataset.x, y: cell.dataset.y }));
  await source.click();
  const target = a.locator('[data-testid^="board-cell-"][aria-label*="nước hợp lệ"]').first();
  await target.waitFor({ state: "visible" });
  const destination = await target.evaluate((cell) => ({ x: cell.dataset.x, y: cell.dataset.y }));
  await a.waitForTimeout(100);
  await target.click();

  try {
    await b.waitForFunction(({ x, y, sourceX, sourceY }) => {
      const from = document.querySelector(`[data-x="${sourceX}"][data-y="${sourceY}"]`);
      const to = document.querySelector(`[data-x="${x}"][data-y="${y}"]`);
      return from && to && from.getAttribute("aria-label")?.includes("trống") && !to.getAttribute("aria-label")?.includes("trống");
    }, { ...destination, sourceX: sourcePosition.x, sourceY: sourcePosition.y }, { timeout: 10_000 });
  } catch {
    const diagnostics = await fixture.diagnostics();
    const ui = await Promise.all([a, b].map((page) => page.evaluate(() => ({ game: Boolean(document.querySelector('[data-testid="game-screen"]')), pieces: [...document.querySelectorAll('[data-testid^="board-cell-"]')].filter((cell) => !cell.getAttribute("aria-label")?.includes("trống")).map((cell) => cell.getAttribute("aria-label")) }))));
    throw new Error(`Move did not propagate. destination=${JSON.stringify(destination)} ui=${JSON.stringify(ui)} frames=${JSON.stringify(frames)} sockets=${JSON.stringify(sockets)} worker=${JSON.stringify(diagnostics)}`);
  }

  if (process.env.OTT_RECONNECT_RUNTIME_TEST === "1") {
    // Bounded real-browser reconnect acceptance:
    // Induce observable close on Bob's active game room WebSocket (avoiding setOffline socket leakage)
    const initialFrameCountB = frames.b.length;

    const closed = await b.evaluate(() => {
      const isGameRoomSocket = (ws) => {
        const url = ws?.url || "";
        return /\/parties\/main\/ott-[0-9a-f-]+/i.test(url) && !url.includes("/parties/lobby/");
      };
      const active = (window.__activeWebSockets || []).find(
        (ws) => isGameRoomSocket(ws) && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
      );
      if (!active) return false;
      // Per WHATWG WebSocket spec, client close code must be 1000 or 3000-4999 (1001 throws InvalidAccessError)
      active.close(4001, "browser_reconnect_test");
      return true;
    });
    assert.ok(closed, "Bob's active game room WebSocket must be found and closed cleanly");

    // Wait for Bob's provider to observe disconnect and reconnect to the game room
    await b.waitForFunction(() => {
      const isGameRoomSocket = (ws) => {
        const url = ws?.url || "";
        return /\/parties\/main\/ott-[0-9a-f-]+/i.test(url) && !url.includes("/parties/lobby/");
      };
      const active = (window.__activeWebSockets || []).filter(isGameRoomSocket);
      return active.length > 1 && active[active.length - 1].readyState === WebSocket.OPEN;
    }, { timeout: 15_000 });

    // Verify Bob's game board remains intact with 81 accessible cells
    await b.locator('[data-testid="game-screen"]').waitFor({ state: "visible", timeout: 10_000 });
    await b.waitForFunction(() => document.querySelectorAll('[data-testid^="board-cell-"]').length === 81);

    // Assert the expected reconnect socket and no duplicate events across reconnect
    const postReconnectFrames = frames.b.slice(initialFrameCountB);
    const stateFrames = postReconnectFrames.filter((f) => f.direction === "received" && f.type === "ott:state");
    for (const f of stateFrames) {
      assert.ok(typeof f.revision === "number" && f.revision >= 1, "reconnected state revision must be valid and non-regressing");
    }

    // Phase: Authoritative move following reconnect
    await b.waitForTimeout(500);
    const bSource = b.locator('[data-testid^="board-cell-"][aria-label*="Người B"]').first();
    try {
      await bSource.waitFor({ state: "visible", timeout: 5_000 });
    } catch {
      const reconnectUi = await b.evaluate(() => ({
        body: document.body.innerText.slice(0, 2_000),
        game: Boolean(document.querySelector('[data-testid="game-screen"]')),
        boardLabels: [...document.querySelectorAll('[data-testid^="board-cell-"]')].map((cell) => ({
          label: cell.getAttribute("aria-label"),
          disabled: cell.hasAttribute("disabled"),
          x: cell.getAttribute("data-x"),
          y: cell.getAttribute("data-y"),
        })),
        playerPanels: [...document.querySelectorAll('[aria-label^="Người chơi"]')].map((panel) => panel.getAttribute("aria-label")),
        activeSockets: (window.__activeWebSockets || []).map((ws) => ({ url: ws.url, readyState: ws.readyState })),
      }));
      throw new Error(`Bob post-reconnect board diagnostics=${JSON.stringify({ reconnectUi, frames: frames.b, sockets: sockets.b, pageErrors: pageErrors.b, consoleErrors: consoleErrors.b })}`);
    }
    const bSourcePosition = await bSource.evaluate((cell) => ({ x: cell.dataset.x, y: cell.dataset.y }));
    await bSource.click();
    const bTarget = b.locator('[data-testid^="board-cell-"][aria-label*="nước hợp lệ"]').first();
    await bTarget.waitFor({ state: "visible", timeout: 5_000 });
    const bDestination = await bTarget.evaluate((cell) => ({ x: cell.dataset.x, y: cell.dataset.y }));
    await b.waitForTimeout(100);
    await bTarget.click();

    try {
      await a.waitForFunction(({ x, y, sourceX, sourceY }) => {
        const from = document.querySelector(`[data-x="${sourceX}"][data-y="${sourceY}"]`);
        const to = document.querySelector(`[data-x="${x}"][data-y="${y}"]`);
        return from && to && from.getAttribute("aria-label")?.includes("trống") && !to.getAttribute("aria-label")?.includes("trống");
      }, { ...bDestination, sourceX: bSourcePosition.x, sourceY: bSourcePosition.y }, { timeout: 10_000 });
    } catch {
      const diagnostics = await fixture.diagnostics();
      const ui = await Promise.all([a, b].map((page) => page.evaluate(() => ({ game: Boolean(document.querySelector('[data-testid="game-screen"]')), pieces: [...document.querySelectorAll('[data-testid^="board-cell-"]')].filter((cell) => !cell.getAttribute("aria-label")?.includes("trống")).map((cell) => cell.getAttribute("aria-label")) }))));
      throw new Error(`Bob's post-reconnect move did not propagate. destination=${JSON.stringify(bDestination)} ui=${JSON.stringify(ui)} frames=${JSON.stringify(frames)} sockets=${JSON.stringify(sockets)} worker=${JSON.stringify(diagnostics)}`);
    }

    if (process.env.OTT_SPECTATOR_RUNTIME_TEST === "1" && c) {
      assert.equal(await c.locator('[data-testid^="board-cell-"]').first().isDisabled(), true, "spectator board remains read-only after peer reconnect");
    }
  }

  for (const key of ["a", "b"]) {
    const baseExpected = process.env.OTT_SPECTATOR_RUNTIME_TEST === "1" ? 2 : 1;
    const expectedSocketCount = key === "b" && process.env.OTT_RECONNECT_RUNTIME_TEST === "1" ? baseExpected + 1 : baseExpected;
    assert.ok(sockets[key].length >= expectedSocketCount, `${key} profile should use the expected provider WebSockets`);
    assert.ok(sockets[key].some((url) => /\/parties\/main\/ott-[0-9a-f-]+/.test(url)));
    if (process.env.OTT_SPECTATOR_RUNTIME_TEST === "1") assert.ok(sockets[key].some((url) => /\/parties\/lobby\/ott-lobby-public/.test(url)));
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
