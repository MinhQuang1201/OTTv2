const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { parseArgs, checkControlList, checkSpectatorCatalog, checkFrontend } = require("../scripts/smoke-deploy");

const FRONTEND = "https://ottv2-staging.vercel.app";

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

function fakeWorker({ status = 200, allowOrigin = FRONTEND, body = { rooms: [] } } = {}) {
  return listen((request, response) => {
    if (request.method !== "POST" || request.url !== "/control/list" || request.headers.origin !== FRONTEND) {
      response.writeHead(404).end();
      return;
    }
    const headers = { "content-type": "application/json" };
    if (allowOrigin) headers["access-control-allow-origin"] = allowOrigin;
    response.writeHead(status, headers).end(JSON.stringify(body));
  });
}

function fakeFrontend(bundle) {
  return listen((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" })
        .end('<script type="module" crossorigin src="/assets/index-abc.js"></script>');
    } else if (request.url === "/assets/index-abc.js") {
      response.writeHead(200, { "content-type": "text/javascript" }).end(bundle);
    } else {
      response.writeHead(404).end();
    }
  });
}

test("smoke args require worker and frontend and normalize to origins", () => {
  assert.deepEqual(
    parseArgs(["--worker", "https://ottv2-staging.example.workers.dev/", "--frontend", `${FRONTEND}/lobby`]),
    { worker: "https://ottv2-staging.example.workers.dev", frontend: FRONTEND },
  );
  assert.throws(() => parseArgs(["--worker", "https://w.example"]), /Missing --frontend/);
});

test("smoke control list accepts 200 with rooms and matching CORS origin", async (t) => {
  const { server, origin } = await fakeWorker({ body: { rooms: [{ roomId: "ott-1" }] } });
  t.after(() => server.close());
  assert.equal(await checkControlList(origin, FRONTEND), 1);
});

test("smoke control list rejects wrong status, missing CORS and missing rooms", async (t) => {
  for (const [options, message] of [
    [{ status: 503 }, /HTTP 200, got 503/],
    [{ allowOrigin: null }, /CORS origin/],
    [{ body: { ok: true } }, /no rooms array/],
  ]) {
    const { server, origin } = await fakeWorker(options);
    t.after(() => server.close());
    await assert.rejects(checkControlList(origin, FRONTEND), message);
  }
});

test("smoke frontend requires a bundle that targets the Worker without secret markers", async (t) => {
  const worker = "https://ottv2-staging.example.workers.dev";
  const good = await fakeFrontend(`const host="${worker}";`);
  t.after(() => good.server.close());
  assert.equal(await checkFrontend(worker, good.origin), 1);

  const wrongWorker = await fakeFrontend('const host="https://other.example";');
  t.after(() => wrongWorker.server.close());
  await assert.rejects(checkFrontend(worker, wrongWorker.origin), /no bundle references Worker/);

  const leaky = await fakeFrontend(`const host="${worker}";const k="OTT_INTERNAL_SECRET";`);
  t.after(() => leaky.server.close());
  await assert.rejects(checkFrontend(worker, leaky.origin), /contains OTT_INTERNAL_SECRET/);
});

test("smoke spectator catalog requires /control/active to answer 200 with a matches array", async (t) => {
  for (const [status, body, expected] of [
    [200, { matches: [{ roomId: "ott-1" }] }, 1],
    [404, { error: "not_found" }, /HTTP 200, got 404/],
    [200, { ok: true }, /no matches array/],
  ]) {
    const { server, origin } = await listen((request, response) => {
      if (request.method !== "POST" || request.url !== "/control/active" || request.headers.origin !== FRONTEND) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    t.after(() => server.close());
    if (typeof expected === "number") assert.equal(await checkSpectatorCatalog(origin, FRONTEND), expected);
    else await assert.rejects(checkSpectatorCatalog(origin, FRONTEND), expected);
  }
});
