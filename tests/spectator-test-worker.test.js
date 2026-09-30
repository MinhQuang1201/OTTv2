const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");
const { build } = require("esbuild");

const root = path.resolve(__dirname, "..");

let cachedWorkerModule = null;
let cachedPublicMatchModule = null;

async function loadPublicMatchModule() {
  if (!cachedPublicMatchModule) {
    const { outputFiles } = await build({
      entryPoints: [path.join(root, "apps", "worker", "src", "lobby", "public-match.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false,
    });
    const filename = path.join(root, "apps", "worker", "src", "lobby", "public-match-test-bundle.cjs");
    const m = new Module(filename, module);
    m.filename = filename;
    m.paths = Module._nodeModulePaths(root);
    m._compile(outputFiles[0].text, filename);
    cachedPublicMatchModule = m.exports;
  }
  return cachedPublicMatchModule;
}

async function loadTestWorker() {
  if (!cachedWorkerModule) {
    const { outputFiles } = await build({
      entryPoints: [path.join(root, "apps", "worker", "src", "entry", "ott-test-worker.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      plugins: [
        {
          name: "partyserver-double",
          setup(b) {
            b.onResolve({ filter: /^partyserver$/ }, () => ({ path: "partyserver-double", namespace: "test" }));
            b.onLoad({ filter: /.*/, namespace: "test" }, () => ({
              contents: `
                export async function routePartykitRequest(req, env) {
                  global.__lastRoutedPartyRequest = { url: req.url, env };
                  return new Response("routed-by-partyserver", { status: 200 });
                }
              `,
              loader: "js",
            }));
          },
        },
        {
          name: "cloudflare-workers-double",
          setup(b) {
            b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "cloudflare-workers-double", namespace: "cf-test" }));
            b.onLoad({ filter: /.*/, namespace: "cf-test" }, () => ({
              contents: `export class DurableObject {}`,
              loader: "js",
            }));
          },
        },
        {
          name: "y-partyserver-double",
          setup(b) {
            b.onResolve({ filter: /^y-partyserver$/ }, () => ({ path: "y-partyserver-double", namespace: "y-test" }));
            b.onLoad({ filter: /.*/, namespace: "y-test" }, () => ({
               contents: `export class YServer {
                 constructor(ctx, env) { this.ctx = ctx; this.env = env; }
                 onConnect() {}
                 onCustomMessage() {}
                 onClose() {}
                 alarm() {}
                  sendCustomMessage(connection, message) {
                    try { connection.send?.("__YPS:" + message); } catch {}
                 }
                 fetch() { return Promise.resolve(new Response("Not found", { status: 404 })); }
                 getConnections() { return this.ctx?.connections ?? []; }
               }`,
              loader: "js",
            }));
          },
        },
      ],
      write: false,
    });
    const filename = path.join(root, "apps", "worker", "src", "entry", "ott-test-worker-bundle.cjs");
    const m = new Module(filename, module);
    m.filename = filename;
    m.paths = Module._nodeModulePaths(root);
    m._compile(outputFiles[0].text, filename);
    cachedWorkerModule = m.exports;
  }
  return cachedWorkerModule;
}

test("ott-test-worker exports all Durable Object classes declared in wrangler.spectator-test.jsonc", async () => {
  const mod = await loadTestWorker();
  const configRaw = fs.readFileSync(path.join(root, "apps", "worker", "wrangler.spectator-test.jsonc"), "utf8");
  const config = JSON.parse(configRaw);

  assert.ok(mod.OttTestGameServer, "OttTestGameServer must be exported");
  assert.ok(mod.OttLobbyServer, "OttLobbyServer must be exported");
  assert.ok(mod.OttLobbyStreamServer, "OttLobbyStreamServer must be exported");

  for (const binding of config.durable_objects.bindings) {
    assert.ok(
      typeof mod[binding.class_name] === "function",
      `Bound class ${binding.class_name} for binding ${binding.name} must be exported as a constructor`,
    );
  }
});

test("production Worker enables the public spectator route", () => {
  const configRaw = fs.readFileSync(path.join(root, "apps", "worker", "wrangler.jsonc"), "utf8");
  const config = JSON.parse(configRaw);

  assert.equal(config.vars.OTT_SPECTATOR_ENABLED, "true");
});

test("Worker public-match normalization returns only the exact public summary shape", async () => {
  const { normalizePublicMatchSummary } = await loadPublicMatchModule();
  const summary = {
    allocationId: "123e4567-e89b-12d3-a456-426614174000",
    roomId: "ott-123e4567-e89b-12d3-a456-426614174000",
    status: "playing",
    players: {
      A: { seat: "A", name: "Alice", connected: true, remainingMs: 600000 },
      B: { seat: "B", name: "Bob", connected: false, remainingMs: 599000 },
    },
    spectatorCount: 2,
    serverNow: 1700000000000,
    runningSeat: "A",
  };

  const result = normalizePublicMatchSummary(summary);

  assert.deepEqual(result, { ok: true, value: summary });
  assert.notStrictEqual(result.value, summary);
  assert.notStrictEqual(result.value.players, summary.players);
});

test("Worker public-match normalization rejects private and malformed summaries", async () => {
  const { normalizePublicMatchSummary } = await loadPublicMatchModule();
  const summary = {
    allocationId: "123e4567-e89b-12d3-a456-426614174000",
    roomId: "ott-123e4567-e89b-12d3-a456-426614174000",
    status: "playing",
    players: {
      A: { seat: "A", name: "Alice", connected: true, remainingMs: 600000 },
      B: { seat: "B", name: "Bob", connected: false, remainingMs: 599000 },
    },
    spectatorCount: 2,
    serverNow: 1700000000000,
    runningSeat: "A",
  };

  for (const invalid of [
    { ...summary, ticket: "private" },
    { ...summary, resumeCredential: "private" },
    { ...summary, allocationId: "not-canonical" },
    { ...summary, players: { ...summary.players, A: { ...summary.players.A, privateToken: "private" } } },
    { ...summary, players: { ...summary.players, B: { ...summary.players.B, remainingMs: -1 } } },
  ]) {
    assert.deepEqual(normalizePublicMatchSummary(invalid), {
      ok: false,
      error: "invalid_public_match_summary",
    });
  }
});

test("ott-test-worker routes provider WebSocket paths through routePartykitRequest without probe secret", async () => {
  const mod = await loadTestWorker();
  const worker = mod.default;

  const env = {
    OTT_INTERNAL_SECRET: "internal-secret",
    OTT_TEST_PROBE_SECRET: "probe-secret",
    OTT_SPECTATOR_ENABLED: "true",
    OTT_BROWSER_ORIGIN: "http://127.0.0.1:3000",
  };

  global.__lastRoutedPartyRequest = null;

  // 1. Standard game provider path (no probe secret header)
  const gameRes = await worker.fetch(
    new Request("https://worker.test/parties/main/ott-00000000-0000-4000-8000-000000000001", {
      headers: { Upgrade: "websocket" },
    }),
    env,
  );
  assert.equal(gameRes.status, 200);
  assert.equal(await gameRes.text(), "routed-by-partyserver");
  assert.equal(
    global.__lastRoutedPartyRequest?.url,
    "https://worker.test/parties/main/ott-00000000-0000-4000-8000-000000000001",
  );

  // 2. Standard lobby stream provider path when spectator enabled (no probe secret header)
  const lobbyRes = await worker.fetch(
    new Request("https://worker.test/parties/lobby/ott-lobby-public", {
      headers: { Upgrade: "websocket" },
    }),
    env,
  );
  assert.equal(lobbyRes.status, 200);
  assert.equal(await lobbyRes.text(), "routed-by-partyserver");

  // 3. Lobby stream provider path fails closed when spectator disabled
  const disabledEnv = { ...env, OTT_SPECTATOR_ENABLED: "false" };
  const disabledRes = await worker.fetch(
    new Request("https://worker.test/parties/lobby/ott-lobby-public"),
    disabledEnv,
  );
  assert.equal(disabledRes.status, 404);
});

test("ott-test-worker routes control paths to OTT_LOBBY without probe secret", async () => {
  const mod = await loadTestWorker();
  const worker = mod.default;

  let lobbyFetchedUrl = null;
  const mockLobby = {
    idFromName: () => "lobby-id",
    get: () => ({
      fetch: async (req) => {
        lobbyFetchedUrl = req.url;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    }),
  };

  const env = {
    OTT_LOBBY: mockLobby,
    OTT_INTERNAL_SECRET: "internal-secret",
    OTT_TEST_PROBE_SECRET: "probe-secret",
    OTT_BROWSER_ORIGIN: "http://127.0.0.1:3000",
  };

  // Standard control request without probe secret
  const controlRes = await worker.fetch(
    new Request("https://worker.test/control/create", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:3000" },
    }),
    env,
  );
  assert.equal(controlRes.status, 200);
  assert.equal(lobbyFetchedUrl, "https://worker.test/control/create");
  assert.equal(controlRes.headers.get("access-control-allow-origin"), "http://127.0.0.1:3000");

  // CORS OPTIONS preflight
  const optionsRes = await worker.fetch(
    new Request("https://worker.test/control/create", {
      method: "OPTIONS",
      headers: { origin: "http://127.0.0.1:3000" },
    }),
    env,
  );
  assert.equal(optionsRes.status, 204);
  assert.equal(optionsRes.headers.get("access-control-allow-origin"), "http://127.0.0.1:3000");
});

test("ott-test-worker enforces OTT_TEST_PROBE_SECRET only on /__test/* paths", async () => {
  const mod = await loadTestWorker();
  const worker = mod.default;

  const env = {
    OTT_INTERNAL_SECRET: "internal-secret",
    OTT_TEST_PROBE_SECRET: "probe-secret-abc",
  };

  // 1. /__test/ready without header -> 404
  const unauthReady = await worker.fetch(new Request("https://worker.test/__test/ready"), env);
  assert.equal(unauthReady.status, 404);

  // 2. /__test/ready with wrong secret -> 404
  const wrongSecretReady = await worker.fetch(
    new Request("https://worker.test/__test/ready", {
      headers: { "x-ott-test-probe-secret": "wrong-secret" },
    }),
    env,
  );
  assert.equal(wrongSecretReady.status, 404);

  // 3. /__test/ready with correct secret -> 200 { ok: true }
  const authReady = await worker.fetch(
    new Request("https://worker.test/__test/ready", {
      headers: { "x-ott-test-probe-secret": "probe-secret-abc" },
    }),
    env,
  );
  assert.equal(authReady.status, 200);
  assert.deepEqual(await authReady.json(), { ok: true });

  // 4. /__test/inspect without header -> 404
  const unauthInspect = await worker.fetch(
    new Request("https://worker.test/__test/inspect?roomId=ott-123&nonce=456"),
    env,
  );
  assert.equal(unauthInspect.status, 404);

  // 5. Unknown /__test/* endpoint with secret -> 404
  const unknownTest = await worker.fetch(
    new Request("https://worker.test/__test/unknown-endpoint", {
      headers: { "x-ott-test-probe-secret": "probe-secret-abc" },
    }),
    env,
  );
  assert.equal(unknownTest.status, 404);

  // 6. Unknown general path -> 404
  const unknownGeneral = await worker.fetch(
    new Request("https://worker.test/some-random-path"),
    env,
  );
  assert.equal(unknownGeneral.status, 404);
});

function validSummary(overrides = {}) {
  const allocationId = "123e4567-e89b-12d3-a456-426614174000";
  return {
    allocationId,
    roomId: `ott-${allocationId}`,
    status: "playing",
    players: {
      A: { seat: "A", name: "Alice", connected: true, remainingMs: 600000 },
      B: { seat: "B", name: "Bob", connected: true, remainingMs: 599000 },
    },
    spectatorCount: 0,
    serverNow: 1700000000000,
    runningSeat: "A",
    ...overrides,
  };
}

function durableFixture(initial = []) {
  const values = new Map(initial);
  const alarms = [];
  const waits = [];
  let transactionTail = Promise.resolve();
  let pendingTransactionFailure = null;
  let transactionGetHook = null;
  const storage = {
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    async list(options = {}) {
      return new Map([...values].filter(([key]) => !options.prefix || key.startsWith(options.prefix)));
    },
    async setAlarm(deadline) { alarms.push(deadline); },
    async deleteAlarm() { alarms.push(null); },
    async transaction(callback) {
      const previous = transactionTail;
      let release;
      transactionTail = new Promise((resolve) => { release = resolve; });
      await previous;
      const pending = new Map(values);
      try {
        const transactionStorage = {
          async get(key) {
            const value = pending.get(key);
            if (transactionGetHook) await transactionGetHook({ key, value, pending, values });
            return value;
          },
          async put(key, value) { pending.set(key, value); },
          async delete(key) { pending.delete(key); },
          async list(options = {}) {
            return new Map([...pending].filter(([key]) => !options.prefix || key.startsWith(options.prefix)));
          },
        };
        const result = await callback(transactionStorage);
        if (pendingTransactionFailure) {
          const failure = pendingTransactionFailure;
          pendingTransactionFailure = null;
          throw failure;
        }
        values.clear();
        for (const [key, value] of pending) values.set(key, value);
        return result;
      } finally {
        release();
      }
    },
  };
  return {
    values,
    alarms,
    waits,
    storage,
    failNextTransaction(error) { pendingTransactionFailure = error; },
    onTransactionGet(hook) { transactionGetHook = hook; },
    ctx: {
      storage,
      waitUntil(promise) { waits.push(promise); },
    },
  };
}

function internalRequest(pathname, body) {
  return new Request(`https://ott.internal${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ott-internal-secret": "internal-secret",
    },
    body: JSON.stringify(body),
  });
}

function exactFramedMessage(envelope) {
  return `__YPS:${JSON.stringify(envelope)}`;
}

async function lobbyFixture(streamFetch) {
  const mod = await loadTestWorker();
  const allocationId = "123e4567-e89b-12d3-a456-426614174000";
  const fixture = durableFixture([[`allocation:${allocationId}`, {
    id: allocationId,
    roomId: `ott-${allocationId}`,
    names: { A: "Alice", B: "Bob" },
    seats: 2,
    status: "playing",
    creatorAttachDeadlineMs: 0,
  }]]);
  const server = Object.create(mod.OttLobbyServer.prototype);
  server.ctx = fixture.ctx;
  server.env = {
    OTT_INTERNAL_SECRET: "internal-secret",
    OTT_SPECTATOR_ENABLED: "true",
    Lobby: {
      idFromName() { return "public-lobby"; },
      get() { return { fetch: streamFetch }; },
    },
  };
  return { ...fixture, server };
}

test("OttLobbyServer accepts valid active updates, rejects stale revisions, and never stores malformed summaries", async () => {
  const fixture = await lobbyFixture(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const summary = validSummary();
  const valid = await fixture.server.fetch(internalRequest("/internal/active-update", {
    allocationId: summary.allocationId,
    roomId: summary.roomId,
    version: { roomRevision: 1, summarySequence: 1 },
    summary,
  }));
  assert.equal(valid.status, 200);

  const malformed = await fixture.server.fetch(internalRequest("/internal/active-update", {
    allocationId: summary.allocationId,
    roomId: summary.roomId,
    version: { roomRevision: 2, summarySequence: 1 },
    summary: { ...summary, ticket: "private" },
  }));
  assert.equal(malformed.status, 400);

  const stale = await fixture.server.fetch(internalRequest("/internal/active-update", {
    allocationId: summary.allocationId,
    roomId: summary.roomId,
    version: { roomRevision: 1, summarySequence: 1 },
    summary,
  }));
  assert.equal(stale.status, 409);

  const allocation = fixture.values.get(`allocation:${summary.allocationId}`);
  assert.deepEqual(allocation.summary, summary);
  assert.deepEqual(allocation.summaryVersion, { roomRevision: 1, summarySequence: 1 });
  assert.equal(fixture.values.get("public-catalog-revision"), 1);
});

test("OttLobbyServer requeues a dropped or non-OK stream notification and recovers on alarm", async () => {
  const responses = [
    new Response("dropped", { status: 503 }),
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ];
  const requests = [];
  const fixture = await lobbyFixture(async (request) => {
    requests.push(await request.json());
    return responses.shift() ?? new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const summary = validSummary();
  const result = await fixture.server.fetch(internalRequest("/internal/active-update", {
    allocationId: summary.allocationId,
    roomId: summary.roomId,
    version: { roomRevision: 1, summarySequence: 1 },
    summary,
  }));
  assert.equal(result.status, 200);
  assert.ok(fixture.values.has("public-catalog-notify"));

  fixture.values.get("public-catalog-notify").nextAttemptMs = 0;
  await fixture.server.alarm();

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], { catalogRevision: 1, matches: [summary] });
  assert.equal(fixture.values.has("public-catalog-notify"), false);
});

test("OttLobbyServer retains terminal removal until a recovered notification succeeds", async () => {
  const responses = [
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
    new Response("dropped", { status: 503 }),
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ];
  const requests = [];
  const fixture = await lobbyFixture(async (request) => {
    requests.push(await request.json());
    return responses.shift();
  });
  const summary = validSummary();
  await fixture.server.fetch(internalRequest("/internal/active-update", {
    allocationId: summary.allocationId,
    roomId: summary.roomId,
    version: { roomRevision: 1, summarySequence: 1 },
    summary,
  }));
  const terminal = await fixture.server.fetch(internalRequest("/internal/terminalize", {
    allocationId: summary.allocationId,
    roomId: summary.roomId,
    reason: "goal",
  }));
  assert.equal(terminal.status, 200);
  assert.equal(fixture.values.get(`allocation:${summary.allocationId}`).status, "terminal");
  assert.equal(fixture.values.get("public-catalog-notify").terminalRemovalPending, true);

  fixture.values.get("public-catalog-notify").nextAttemptMs = 0;
  await fixture.server.alarm();

  assert.deepEqual(requests.at(-1), { catalogRevision: 2, matches: [] });
  assert.equal(fixture.values.has("public-catalog-notify"), false);
});

test("OttLobbyStreamServer resubscribe obtains the durable latest catalog and ignores stale updates", async () => {
  const summary = validSummary();
  const lobbyFetch = async () => {
    return new Response(JSON.stringify({ catalogRevision: 4, matches: [summary] }), { status: 200 });
  };
  const mod = await loadTestWorker();
  const fixture = durableFixture();
  fixture.ctx.connections = [];
  const streamEnv = {
    OTT_SPECTATOR_ENABLED: "true",
    OTT_INTERNAL_SECRET: "internal-secret",
    OTT_LOBBY: { idFromName() { return "lobby"; }, get() { return { fetch: lobbyFetch }; } },
  };
  const firstStream = new mod.OttLobbyStreamServer(fixture.ctx, streamEnv);
  const connection = { sent: [], send(value) { this.sent.push(value); } };
  await firstStream.dispatchCustomMessage(connection, JSON.stringify({ __ott: true, type: "ott:lobby-subscribe" }));
  assert.equal(connection.sent.at(-1), exactFramedMessage({
    __ott: true,
    type: "ott:active-matches",
    catalogRevision: 4,
    matches: [summary],
  }));
  assert.equal(fixture.values.get("public-catalog-cache").catalogRevision, 4);

  const secondStream = new mod.OttLobbyStreamServer(fixture.ctx, streamEnv);
  const reconnect = { sent: [], send(value) { this.sent.push(value); } };
  await secondStream.dispatchCustomMessage(reconnect, JSON.stringify({ __ott: true, type: "ott:lobby-subscribe" }));
  assert.equal(reconnect.sent.at(-1), exactFramedMessage({
    __ott: true,
    type: "ott:active-matches",
    catalogRevision: 4,
    matches: [summary],
  }));

  const stale = await secondStream.fetch(new Request("https://ott.internal/internal/active-update", {
    method: "POST",
    headers: { "x-ott-internal-secret": "internal-secret" },
    body: JSON.stringify({ catalogRevision: 3, matches: [] }),
  }));
  assert.equal(stale.status, 200);
  assert.equal(reconnect.sent.length, 1);
});

test("OttLobbyStreamServer schedules subscription resync through Durable Object waitUntil", async () => {
  const fixture = durableFixture();
  fixture.ctx.connections = [];
  const stream = new (await loadTestWorker()).OttLobbyStreamServer(fixture.ctx, {
    OTT_SPECTATOR_ENABLED: "true",
    OTT_INTERNAL_SECRET: "internal-secret",
    OTT_LOBBY: {
      idFromName() { return "lobby"; },
      get() { return { fetch: async () => new Response(JSON.stringify({ catalogRevision: 1, matches: [] })) }; },
    },
  });
  const connection = { sent: [], send(value) { this.sent.push(value); } };

  stream.onCustomMessage(connection, JSON.stringify({ __ott: true, type: "ott:lobby-subscribe" }));

  assert.equal(fixture.waits.length, 1);
  await Promise.all(fixture.waits);
  assert.equal(connection.sent.at(-1), exactFramedMessage({
    __ott: true,
    type: "ott:active-matches",
    catalogRevision: 1,
    matches: [],
  }));
});

test("OttLobbyStreamServer retains a durable resend claim when restore storage fails", async () => {
  const fixture = durableFixture();
  let sends = 0;
  fixture.ctx.connections = [{
    send() {
      sends += 1;
      if (sends === 2) {
        fixture.failNextTransaction(new Error("resend restore storage unavailable"));
        throw new Error("connection dropped");
      }
      if (sends < 3) throw new Error("connection dropped");
    },
  }];
  const stream = new (await loadTestWorker()).OttLobbyStreamServer(fixture.ctx, {
    OTT_SPECTATOR_ENABLED: "true",
    OTT_INTERNAL_SECRET: "internal-secret",
  });
  await stream.fetch(new Request("https://ott.internal/internal/active-update", {
    method: "POST",
    headers: { "x-ott-internal-secret": "internal-secret" },
    body: JSON.stringify({ catalogRevision: 1, matches: [] }),
  }));
  fixture.values.get("lobby-stream-resend").nextAttemptMs = 0;

  await stream.alarm();

  const claim = fixture.values.get("lobby-stream-resend-claim:1");
  assert.equal(claim.catalogRevision, 1);
  assert.equal(fixture.values.has("lobby-stream-resend"), false);

  claim.leaseUntilMs = 0;
  await stream.alarm();

  assert.equal(fixture.values.has("lobby-stream-resend-claim:1"), false);
  assert.equal(fixture.values.has("lobby-stream-resend-exhausted"), false);
  assert.equal(sends, 3);
});

test("OttLobbyStreamServer frames unavailable subscription errors as custom messages", async () => {
  const fixture = durableFixture();
  fixture.ctx.connections = [];
  const stream = new (await loadTestWorker()).OttLobbyStreamServer(fixture.ctx, {
    OTT_SPECTATOR_ENABLED: "true",
    OTT_INTERNAL_SECRET: "internal-secret",
    OTT_LOBBY: {
      idFromName() { return "lobby"; },
      get() { return { fetch: async () => new Response("unavailable", { status: 503 }) }; },
    },
  });
  const connection = { frames: [], send(value) { this.frames.push(value); } };

  await stream.dispatchCustomMessage(connection, JSON.stringify({ __ott: true, type: "ott:lobby-subscribe" }));

  assert.equal(connection.frames.length, 1);
  assert.equal(connection.frames[0], exactFramedMessage({
    __ott: true,
    type: "ott:error",
    error: "active_matches_unavailable",
  }));
});

test("OttLobbyStreamServer resends the latest catalog when connected delivery failure is not observable", async () => {
  const fixture = durableFixture();
  let sends = 0;
  const connection = {
    frames: [],
    send(value) {
      sends += 1;
      this.frames.push(value);
      if (sends === 1) throw new Error("connection dropped");
    },
  };
  fixture.ctx.connections = [connection];
  const mod = await loadTestWorker();
  const stream = new mod.OttLobbyStreamServer(fixture.ctx, {
    OTT_SPECTATOR_ENABLED: "true",
    OTT_INTERNAL_SECRET: "internal-secret",
  });
  const update = await stream.fetch(new Request("https://ott.internal/internal/active-update", {
    method: "POST",
    headers: { "x-ott-internal-secret": "internal-secret" },
    body: JSON.stringify({ catalogRevision: 1, matches: [] }),
  }));
  assert.equal(update.status, 200);
  assert.ok(fixture.values.has("lobby-stream-resend"));

  fixture.values.get("lobby-stream-resend").nextAttemptMs = 0;
  await stream.alarm();
  assert.equal(sends, 2);
  assert.equal(fixture.values.has("lobby-stream-resend"), false);
  assert.equal(connection.frames[0], exactFramedMessage({
    __ott: true,
    type: "ott:active-matches",
    catalogRevision: 1,
    matches: [],
  }));

  const terminal = await stream.fetch(new Request("https://ott.internal/internal/active-update", {
    method: "POST",
    headers: { "x-ott-internal-secret": "internal-secret" },
    body: JSON.stringify({ catalogRevision: 2, matches: [] }),
  }));
  assert.equal(terminal.status, 200);
  assert.equal(fixture.values.has("lobby-stream-resend"), false);
  assert.equal(sends, 3);
  assert.equal(connection.frames.at(-1), exactFramedMessage({
    __ott: true,
    type: "ott:active-matches",
    catalogRevision: 2,
    matches: [],
  }));
});

test("OttLobbyStreamServer does not recreate a resend record after final direct-send failure", async () => {
  const fixture = durableFixture();
  let sends = 0;
  fixture.ctx.connections = [{ send() { sends += 1; throw new Error("connection closed"); } }];
  const stream = new (await loadTestWorker()).OttLobbyStreamServer(fixture.ctx, {
    OTT_SPECTATOR_ENABLED: "true",
    OTT_INTERNAL_SECRET: "internal-secret",
  });
  await stream.fetch(new Request("https://ott.internal/internal/active-update", {
    method: "POST",
    headers: { "x-ott-internal-secret": "internal-secret" },
    body: JSON.stringify({ catalogRevision: 1, matches: [] }),
  }));

  for (let attempt = 0; attempt < 10 && fixture.values.has("lobby-stream-resend"); attempt += 1) {
    fixture.values.get("lobby-stream-resend").nextAttemptMs = 0;
    await stream.alarm();
  }

  assert.equal(fixture.values.has("lobby-stream-resend"), false);
  assert.equal(sends, 5);
});

test("OttLobbyStreamServer clears pending resend state when spectator delivery is disabled", async () => {
  const fixture = durableFixture();
  let sends = 0;
  fixture.ctx.connections = [{ send() { sends += 1; throw new Error("connection closed"); } }];
  const env = {
    OTT_SPECTATOR_ENABLED: "true",
    OTT_INTERNAL_SECRET: "internal-secret",
  };
  const stream = new (await loadTestWorker()).OttLobbyStreamServer(fixture.ctx, env);
  await stream.fetch(new Request("https://ott.internal/internal/active-update", {
    method: "POST",
    headers: { "x-ott-internal-secret": "internal-secret" },
    body: JSON.stringify({ catalogRevision: 1, matches: [] }),
  }));
  assert.ok(fixture.values.has("lobby-stream-resend"));

  env.OTT_SPECTATOR_ENABLED = "false";
  fixture.values.get("lobby-stream-resend").nextAttemptMs = 0;
  await stream.alarm();

  assert.equal(fixture.values.has("lobby-stream-resend"), false);
  assert.equal(sends, 1);
});

test("OttLobbyStreamServer does not schedule resend after successful direct fan-out", async () => {
  const fixture = durableFixture();
  const frames = [];
  fixture.ctx.connections = [{ send(value) { frames.push(value); } }];
  const stream = new (await loadTestWorker()).OttLobbyStreamServer(fixture.ctx, {
    OTT_SPECTATOR_ENABLED: "true",
    OTT_INTERNAL_SECRET: "internal-secret",
  });
  const response = await stream.fetch(new Request("https://ott.internal/internal/active-update", {
    method: "POST",
    headers: { "x-ott-internal-secret": "internal-secret" },
    body: JSON.stringify({ catalogRevision: 1, matches: [] }),
  }));

  assert.equal(response.status, 200);
  assert.equal(frames.length, 1);
  assert.equal(frames[0], exactFramedMessage({
    __ott: true,
    type: "ott:active-matches",
    catalogRevision: 1,
    matches: [],
  }));
  assert.equal(fixture.values.has("lobby-stream-resend"), false);
});

test("OttLobbyStreamServer does not overwrite a newer resend revision after claiming an older retry", async () => {
  const fixture = durableFixture();
  let stream;
  let sends = 0;
  fixture.ctx.connections = [{
    send() {
      sends += 1;
      if (sends === 2) {
        fixture.values.set("lobby-stream-resend", {
          catalogRevision: 2,
          attempt: 0,
          nextAttemptMs: 0,
        });
      }
      throw new Error("connection closed");
    },
  }];
  stream = new (await loadTestWorker()).OttLobbyStreamServer(fixture.ctx, {
    OTT_SPECTATOR_ENABLED: "true",
    OTT_INTERNAL_SECRET: "internal-secret",
  });
  await stream.fetch(new Request("https://ott.internal/internal/active-update", {
    method: "POST",
    headers: { "x-ott-internal-secret": "internal-secret" },
    body: JSON.stringify({ catalogRevision: 1, matches: [] }),
  }));
  fixture.values.get("lobby-stream-resend").nextAttemptMs = 0;

  await stream.alarm();

  assert.deepEqual(fixture.values.get("lobby-stream-resend"), {
    catalogRevision: 2,
    attempt: 0,
    nextAttemptMs: 0,
  });
});

test("OttLobbyServer rejects oversized UTF-8 internal update and snapshot bodies before parsing", async () => {
  const fixture = await lobbyFixture(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const summary = validSummary();
  const updateBody = JSON.stringify({
    allocationId: summary.allocationId,
    roomId: summary.roomId,
    version: { roomRevision: 1, summarySequence: 1 },
    summary,
  }) + " ".repeat(8192);
  const oversizedUpdate = await fixture.server.fetch(new Request("https://ott.internal/internal/active-update", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ott-internal-secret": "internal-secret" },
    body: updateBody,
  }));
  assert.equal(oversizedUpdate.status, 400);
  assert.equal(fixture.values.get(`allocation:${summary.allocationId}`).summary, undefined);

  const oversizedSnapshot = await fixture.server.fetch(new Request("https://ott.internal/internal/public-active-snapshot", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ott-internal-secret": "internal-secret" },
    body: " \u{1f600}".repeat(4096),
  }));
  assert.equal(oversizedSnapshot.status, 400);

  const oversizedTerminalize = await fixture.server.fetch(new Request("https://ott.internal/internal/terminalize", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ott-internal-secret": "internal-secret" },
    body: JSON.stringify({
      allocationId: summary.allocationId,
      roomId: summary.roomId,
      reason: "goal",
    }) + " ".repeat(8192),
  }));
  assert.equal(oversizedTerminalize.status, 400);
  assert.equal(fixture.values.get(`allocation:${summary.allocationId}`).status, "playing");

  const streamFixture = durableFixture();
  streamFixture.ctx.connections = [];
  const stream = new (await loadTestWorker()).OttLobbyStreamServer(streamFixture.ctx, {
    OTT_SPECTATOR_ENABLED: "true",
    OTT_INTERNAL_SECRET: "internal-secret",
  });
  const oversizedStreamUpdate = await stream.fetch(new Request("https://ott.internal/internal/active-update", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ott-internal-secret": "internal-secret" },
    body: JSON.stringify({ catalogRevision: 1, matches: [] }) + " ".repeat(8192),
  }));
  assert.equal(oversizedStreamUpdate.status, 400);

  const misreportedStreamUpdate = await stream.fetch(new Request("https://ott.internal/internal/active-update", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": "1",
      "x-ott-internal-secret": "internal-secret",
    },
    body: JSON.stringify({ catalogRevision: 2, matches: [] }) + " ".repeat(8192),
  }));
  assert.equal(misreportedStreamUpdate.status, 400);

  const declaredOversized = await fixture.server.fetch(new Request("https://ott.internal/internal/active-update", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": "8193",
      "x-ott-internal-secret": "internal-secret",
    },
    body: "{}",
  }));
  assert.equal(declaredOversized.status, 400);

  const misreportedOversized = await fixture.server.fetch(new Request("https://ott.internal/internal/active-update", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": "1",
      "x-ott-internal-secret": "internal-secret",
    },
    body: updateBody,
  }));
  assert.equal(misreportedOversized.status, 400);

  const unauthorized = await fixture.server.fetch(new Request("https://ott.internal/internal/active-update", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ott-internal-secret": "wrong" },
    body: updateBody,
  }));
  assert.equal(unauthorized.status, 403);
});

test("OttLobbyServer rejects null, array, and primitive terminalize bodies", async () => {
  const fixture = await lobbyFixture(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  for (const body of ["null", "[]", "1", "true", "\"text\""]) {
    const response = await fixture.server.fetch(new Request("https://ott.internal/internal/terminalize", {
      method: "POST",
      headers: { "x-ott-internal-secret": "internal-secret" },
      body,
    }));
    assert.equal(response.status, 400, body);
  }
  const summary = validSummary();
  assert.equal(fixture.values.get(`allocation:${summary.allocationId}`).status, "playing");
});

test("OttLobbyStreamServer strictly validates bounded subscription messages", async () => {
  const fixture = durableFixture();
  fixture.ctx.connections = [];
  const stream = new (await loadTestWorker()).OttLobbyStreamServer(fixture.ctx, {
    OTT_SPECTATOR_ENABLED: "true",
    OTT_INTERNAL_SECRET: "internal-secret",
    OTT_LOBBY: {
      idFromName() { return "lobby"; },
      get() { return { fetch: async () => new Response(JSON.stringify({ catalogRevision: 1, matches: [] })) }; },
    },
  });
  const connection = { sent: [], send(value) { this.sent.push(value); } };
  const valid = JSON.stringify({ __ott: true, type: "ott:lobby-subscribe" });
  await stream.dispatchCustomMessage(connection, JSON.stringify({ __ott: true, type: "ott:lobby-subscribe", extra: true }));
  await stream.dispatchCustomMessage(connection, `${valid}${" ".repeat(8192)}`);
  await stream.dispatchCustomMessage(connection, JSON.stringify(["ott:lobby-subscribe"]));
  assert.equal(connection.sent.length, 0);
});

test("OttLobbyStreamServer loads durable catalog before rejecting a stale cold-wake update", async () => {
  const fixture = durableFixture();
  fixture.ctx.connections = [];
  const mod = await loadTestWorker();
  const env = { OTT_SPECTATOR_ENABLED: "true", OTT_INTERNAL_SECRET: "internal-secret" };
  const warm = new mod.OttLobbyStreamServer(fixture.ctx, env);
  const warmResponse = await warm.fetch(new Request("https://ott.internal/internal/active-update", {
    method: "POST",
    headers: { "x-ott-internal-secret": "internal-secret" },
    body: JSON.stringify({ catalogRevision: 5, matches: [] }),
  }));
  assert.equal(warmResponse.status, 200);

  const received = [];
  fixture.ctx.connections = [{ send(value) { received.push(value); } }];
  const cold = new mod.OttLobbyStreamServer(fixture.ctx, env);
  const staleResponse = await cold.fetch(new Request("https://ott.internal/internal/active-update", {
    method: "POST",
    headers: { "x-ott-internal-secret": "internal-secret" },
    body: JSON.stringify({ catalogRevision: 4, matches: [] }),
  }));
  assert.equal(staleResponse.status, 200);
  assert.equal(received.length, 0);
  assert.equal(fixture.values.get("public-catalog-cache").catalogRevision, 5);
});

test("OttLobbyServer does not overwrite a newer retry attempt after claiming an older notification", async () => {
  let fixture;
  let requests = 0;
  fixture = await lobbyFixture(async () => {
    requests += 1;
    if (requests === 1) {
      fixture.values.set("public-catalog-notify", {
        catalogRevision: 1,
        attempt: 2,
        nextAttemptMs: 0,
        terminalRemovalPending: false,
      });
    }
    return new Response("unavailable", { status: 503 });
  });
  const summary = validSummary();
  await fixture.server.fetch(internalRequest("/internal/active-update", {
    allocationId: summary.allocationId,
    roomId: summary.roomId,
    version: { roomRevision: 1, summarySequence: 1 },
    summary,
  }));

  assert.deepEqual(fixture.values.get("public-catalog-notify"), {
    catalogRevision: 1,
    attempt: 2,
    nextAttemptMs: 0,
    terminalRemovalPending: false,
  });
});

test("OttLobbyServer does not restore an older claimed notification after a newer revision succeeds", async () => {
  let firstStarted;
  let releaseFirst;
  const firstRequest = new Promise((resolve) => { firstStarted = resolve; });
  const firstResponse = new Promise((resolve) => { releaseFirst = resolve; });
  const requests = [];
  const fixture = await lobbyFixture(async (request) => {
    const body = await request.json();
    requests.push(body);
    if (requests.length === 1) {
      firstStarted();
      await firstResponse;
      return new Response("dropped", { status: 503 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const firstSummary = validSummary();
  const firstUpdate = fixture.server.fetch(internalRequest("/internal/active-update", {
    allocationId: firstSummary.allocationId,
    roomId: firstSummary.roomId,
    version: { roomRevision: 1, summarySequence: 1 },
    summary: firstSummary,
  }));
  await firstRequest;

  const secondSummary = validSummary({ serverNow: 1700000000001 });
  const secondUpdate = fixture.server.fetch(internalRequest("/internal/active-update", {
    allocationId: secondSummary.allocationId,
    roomId: secondSummary.roomId,
    version: { roomRevision: 2, summarySequence: 2 },
    summary: secondSummary,
  }));
  await secondUpdate;
  releaseFirst();
  await firstUpdate;

  assert.deepEqual(requests.map((request) => request.catalogRevision), [1, 2]);
  assert.equal(fixture.values.has("public-catalog-notify"), false);
  assert.equal(fixture.values.get("public-catalog-delivered-revision"), 2);
});

test("OttLobbyServer bounds notification retries without losing the authoritative catalog", async () => {
  let attempts = 0;
  const fixture = await lobbyFixture(async () => {
    attempts += 1;
    return new Response("unavailable", { status: 503 });
  });
  const summary = validSummary();
  await fixture.server.fetch(internalRequest("/internal/active-update", {
    allocationId: summary.allocationId,
    roomId: summary.roomId,
    version: { roomRevision: 1, summarySequence: 1 },
    summary,
  }));

  for (let i = 0; i < 10; i += 1) {
    const record = fixture.values.get("public-catalog-notify");
    if (!record) break;
    record.nextAttemptMs = 0;
    await fixture.server.alarm();
  }
  const attemptsAfterExhaustion = attempts;
  const record = fixture.values.get("public-catalog-notify");
  if (record) {
    record.nextAttemptMs = 0;
    await fixture.server.alarm();
  }

  assert.ok(attempts <= 6);
  assert.equal(attempts, attemptsAfterExhaustion);
  assert.deepEqual(fixture.values.get(`allocation:${summary.allocationId}`).summary, summary);
});

test("OttLobbyServer records terminal-removal exhaustion without losing removal state", async () => {
  const fixture = await lobbyFixture(async () => new Response("unavailable", { status: 503 }));
  const summary = validSummary();
  await fixture.server.fetch(internalRequest("/internal/active-update", {
    allocationId: summary.allocationId,
    roomId: summary.roomId,
    version: { roomRevision: 1, summarySequence: 1 },
    summary,
  }));
  await fixture.server.fetch(internalRequest("/internal/terminalize", {
    allocationId: summary.allocationId,
    roomId: summary.roomId,
    reason: "goal",
  }));

  for (let i = 0; i < 10 && fixture.values.has("public-catalog-notify"); i += 1) {
    fixture.values.get("public-catalog-notify").nextAttemptMs = 0;
    await fixture.server.alarm();
  }

  const exhausted = fixture.values.get("public-catalog-notify-exhausted");
  assert.equal(exhausted.terminalRemovalPending, true);
  assert.equal(exhausted.catalogRevision, 2);
  assert.equal(fixture.values.get(`allocation:${summary.allocationId}`).status, "terminal");
  const snapshot = await fixture.server.fetch(new Request("https://ott.internal/internal/public-active-snapshot", {
    headers: { "x-ott-internal-secret": "internal-secret" },
  }));
  assert.deepEqual(await snapshot.json(), { catalogRevision: 2, matches: [] });
});

test("OttLobbyServer keeps only the latest bounded exhaustion record", async () => {
  const fixture = await lobbyFixture(async () => new Response("unavailable", { status: 503 }));
  const allocationId = "123e4567-e89b-12d3-a456-426614174000";
  for (let revision = 1; revision <= 6; revision += 1) {
    const summary = validSummary({ serverNow: 1700000000000 + revision });
    await fixture.server.fetch(internalRequest("/internal/active-update", {
      allocationId,
      roomId: `ott-${allocationId}`,
      version: { roomRevision: revision, summarySequence: revision },
      summary,
    }));
    for (let attempt = 0; attempt < 4 && fixture.values.has("public-catalog-notify"); attempt += 1) {
      fixture.values.get("public-catalog-notify").nextAttemptMs = 0;
      await fixture.server.alarm();
    }
  }

  const exhaustionKeys = [...fixture.values.keys()].filter((key) => key.startsWith("public-catalog-notify-exhausted"));
  assert.deepEqual(exhaustionKeys, ["public-catalog-notify-exhausted"]);
  assert.equal(fixture.values.get("public-catalog-notify-exhausted").catalogRevision, 6);
});

test("OttLobbyServer schedules the earlier catalog retry instead of overwriting it with rate-limit cleanup", async () => {
  const fixture = await lobbyFixture(async () => new Response("unavailable", { status: 503 }));
  const now = Date.now();
  fixture.values.set("rate:last:list:client", now);
  const summary = validSummary();
  await fixture.server.fetch(internalRequest("/internal/active-update", {
    allocationId: summary.allocationId,
    roomId: summary.roomId,
    version: { roomRevision: 1, summarySequence: 1 },
    summary,
  }));

  const catalogDeadline = fixture.values.get("public-catalog-notify").nextAttemptMs;
  const rateDeadline = now + 60_000;
  const scheduled = fixture.alarms.at(-1);
  assert.ok(catalogDeadline < rateDeadline);
  assert.equal(scheduled, catalogDeadline);
});

test("OttLobbyServer restores a claimed notification when loading the catalog throws", async () => {
  const fixture = await lobbyFixture(async () => new Response("unavailable", { status: 503 }));
  const summary = validSummary();
  await fixture.server.fetch(internalRequest("/internal/active-update", {
    allocationId: summary.allocationId,
    roomId: summary.roomId,
    version: { roomRevision: 1, summarySequence: 1 },
    summary,
  }));

  const originalGet = fixture.storage.get;
  const originalTransaction = fixture.storage.transaction;
  let failCatalogRead = true;
  fixture.storage.get = async (key) => {
    if (key === "public-catalog-revision" && failCatalogRead && !fixture.values.has("public-catalog-notify")) {
      failCatalogRead = false;
      throw new Error("catalog storage unavailable");
    }
    return originalGet(key);
  };
  fixture.storage.transaction = async (callback) => {
    if (failCatalogRead && !fixture.values.has("public-catalog-notify")) {
      failCatalogRead = false;
      throw new Error("catalog storage unavailable");
    }
    return originalTransaction(callback);
  };
  fixture.values.get("public-catalog-notify").nextAttemptMs = 0;

  await fixture.server.alarm();

  assert.ok(fixture.values.has("public-catalog-notify"));
  assert.equal(fixture.values.get("public-catalog-notify").attempt, 2);
});

test("OttLobbyStreamServer restores a claimed resend when loading the cache throws", async () => {
  const fixture = durableFixture();
  let sends = 0;
  fixture.ctx.connections = [{ send() { sends += 1; throw new Error("connection closed"); } }];
  const stream = new (await loadTestWorker()).OttLobbyStreamServer(fixture.ctx, {
    OTT_SPECTATOR_ENABLED: "true",
    OTT_INTERNAL_SECRET: "internal-secret",
  });
  await stream.fetch(new Request("https://ott.internal/internal/active-update", {
    method: "POST",
    headers: { "x-ott-internal-secret": "internal-secret" },
    body: JSON.stringify({ catalogRevision: 1, matches: [] }),
  }));
  fixture.values.get("lobby-stream-resend").nextAttemptMs = 0;

  const originalGet = fixture.storage.get;
  fixture.storage.get = async (key) => {
    if (key === "public-catalog-cache") throw new Error("cache storage unavailable");
    return originalGet(key);
  };

  await stream.alarm();

  assert.equal(sends, 1);
  assert.deepEqual(fixture.values.get("lobby-stream-resend"), {
    catalogRevision: 1,
    attempt: 1,
    nextAttemptMs: fixture.values.get("lobby-stream-resend").nextAttemptMs,
  });
});

test("OttLobbyServer never exposes private fields from a persisted summary through control active", async () => {
  const fixture = await lobbyFixture(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const summary = validSummary({ ticket: "private-ticket" });
  const allocation = fixture.values.get(`allocation:${summary.allocationId}`);
  allocation.summary = summary;
  allocation.summaryVersion = { roomRevision: 1, summarySequence: 1 };
  fixture.values.set(`allocation:${summary.allocationId}`, allocation);

  const response = await fixture.server.fetch(new Request("https://ott.internal/control/active", {
    method: "POST",
    body: "{}",
  }));

  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /private-ticket/);
});

test("OttLobbyServer does not let an older scheduler delete a newer notification alarm", async () => {
  const fixture = await lobbyFixture(async () => new Response("unavailable", { status: 503 }));
  let scheduledAlarm = "unset";
  let markDeleteStarted;
  let releaseDelete;
  const deleteStarted = new Promise((resolve) => {
    markDeleteStarted = resolve;
  });
  const deleteBlocked = new Promise((resolve) => {
    releaseDelete = resolve;
  });
  fixture.storage.setAlarm = async (deadline) => {
    scheduledAlarm = deadline;
  };
  fixture.storage.deleteAlarm = async () => {
    markDeleteStarted();
    await deleteBlocked;
    scheduledAlarm = null;
  };

  const oldScheduler = fixture.server.scheduleAlarm();
  await deleteStarted;
  fixture.values.set("public-catalog-notify", {
    catalogRevision: 1,
    attempt: 0,
    nextAttemptMs: Date.now() + 1_000,
    terminalRemovalPending: false,
  });
  const newScheduler = fixture.server.scheduleAlarm();
  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseDelete();
  await Promise.all([oldScheduler, newScheduler]);

  assert.equal(scheduledAlarm, fixture.values.get("public-catalog-notify").nextAttemptMs);
});

test("OttLobbyServer retains a durable claim when restoring a failed delivery throws", async () => {
  let fixture;
  let deliveries = 0;
  fixture = await lobbyFixture(async () => {
    deliveries += 1;
    if (deliveries === 2) fixture.failNextTransaction(new Error("restore storage unavailable"));
    return deliveries < 3
      ? new Response("unavailable", { status: 503 })
      : new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const summary = validSummary();
  await fixture.server.fetch(internalRequest("/internal/active-update", {
    allocationId: summary.allocationId,
    roomId: summary.roomId,
    version: { roomRevision: 1, summarySequence: 1 },
    summary,
  }));
  fixture.values.get("public-catalog-notify").nextAttemptMs = 0;

  await fixture.server.alarm();

  const claim = fixture.values.get("public-catalog-notify-claim:1");
  assert.equal(claim.catalogRevision, 1);
  assert.equal(fixture.values.has("public-catalog-notify"), false);

  claim.leaseUntilMs = 0;
  await fixture.server.alarm();

  assert.equal(fixture.values.has("public-catalog-notify-claim:1"), false);
  assert.equal(fixture.values.get("public-catalog-delivered-revision"), 1);
});

test("OttLobbyServer ignores a late completion from an older same-revision claim", async () => {
  const fixture = await lobbyFixture(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  fixture.values.set("public-catalog-notify", {
    catalogRevision: 1,
    attempt: 0,
    nextAttemptMs: 0,
    terminalRemovalPending: false,
  });

  const oldClaim = await fixture.server.claimCatalogNotification(0);
  fixture.values.get("public-catalog-notify-claim:1").leaseUntilMs = 0;
  const newClaim = await fixture.server.claimCatalogNotification(1);
  fixture.values.set("public-catalog-notify", {
    catalogRevision: 1,
    attempt: 2,
    nextAttemptMs: 0,
    terminalRemovalPending: false,
  });

  await fixture.server.completeCatalogNotification(oldClaim, 1);

  assert.notEqual(oldClaim.claimToken, newClaim.claimToken);
  assert.deepEqual(fixture.values.get("public-catalog-notify"), {
    catalogRevision: 1,
    attempt: 2,
    nextAttemptMs: 0,
    terminalRemovalPending: false,
  });
  assert.equal(fixture.values.get("public-catalog-notify-claim:1").claimToken, newClaim.claimToken);
});

test("OttLobbyStreamServer ignores a late completion from an older same-revision claim", async () => {
  const fixture = durableFixture();
  const stream = new (await loadTestWorker()).OttLobbyStreamServer(fixture.ctx, {
    OTT_SPECTATOR_ENABLED: "true",
    OTT_INTERNAL_SECRET: "internal-secret",
  });
  fixture.values.set("lobby-stream-resend", {
    catalogRevision: 1,
    attempt: 0,
    nextAttemptMs: 0,
  });

  const oldClaim = await stream.claimResend(0);
  fixture.values.get("lobby-stream-resend-claim:1").leaseUntilMs = 0;
  const newClaim = await stream.claimResend(1);
  fixture.values.set("lobby-stream-resend", {
    catalogRevision: 1,
    attempt: 2,
    nextAttemptMs: 0,
  });

  await stream.completeResend(oldClaim);

  assert.notEqual(oldClaim.claimToken, newClaim.claimToken);
  assert.deepEqual(fixture.values.get("lobby-stream-resend"), {
    catalogRevision: 1,
    attempt: 2,
    nextAttemptMs: 0,
  });
  assert.equal(fixture.values.get("lobby-stream-resend-claim:1").claimToken, newClaim.claimToken);
});

test("OttLobbyStreamServer retries the same revision when cache persistence fails before memory mutation", async () => {
  const fixture = durableFixture();
  const stream = new (await loadTestWorker()).OttLobbyStreamServer(fixture.ctx, {
    OTT_SPECTATOR_ENABLED: "true",
    OTT_INTERNAL_SECRET: "internal-secret",
  });
  const originalPut = fixture.storage.put;
  let failCachePut = true;
  fixture.storage.put = async (key, value) => {
    if (key === "public-catalog-cache" && failCachePut) {
      failCachePut = false;
      throw new Error("cache storage unavailable");
    }
    return originalPut(key, value);
  };
  const request = () => new Request("https://ott.internal/internal/active-update", {
    method: "POST",
    headers: { "x-ott-internal-secret": "internal-secret" },
    body: JSON.stringify({ catalogRevision: 1, matches: [] }),
  });

  await assert.rejects(() => stream.fetch(request()), /cache storage unavailable/);
  assert.equal(fixture.values.has("public-catalog-cache"), false);

  const retry = await stream.fetch(request());
  assert.equal(retry.status, 200);
  assert.equal(fixture.values.get("public-catalog-cache").catalogRevision, 1);

  const coldWake = new (await loadTestWorker()).OttLobbyStreamServer(fixture.ctx, {
    OTT_SPECTATOR_ENABLED: "true",
    OTT_INTERNAL_SECRET: "internal-secret",
  });
  const coldRetry = await coldWake.fetch(request());
  assert.equal(coldRetry.status, 200);
  assert.equal(fixture.values.get("public-catalog-cache").catalogRevision, 1);
});

test("OttLobbyServer materializes catalog revision and allocations from one transaction", async () => {
  const fixture = await lobbyFixture(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const summary = validSummary();
  const allocationKey = `allocation:${summary.allocationId}`;
  const allocation = fixture.values.get(allocationKey);
  allocation.summary = summary;
  fixture.values.set(allocationKey, allocation);
  fixture.values.set("public-catalog-revision", 1);
  const newerSummary = validSummary({ serverNow: 1700000000001 });
  let interleaved = false;
  fixture.onTransactionGet(({ key }) => {
    if (key === "public-catalog-revision" && !interleaved) {
      interleaved = true;
      fixture.values.set("public-catalog-revision", 2);
      fixture.values.set(allocationKey, { ...allocation, summary: newerSummary });
    }
  });

  const catalog = await fixture.server.currentPublicCatalog();

  assert.equal(interleaved, true);
  assert.equal(catalog.catalogRevision, 1);
  assert.deepEqual(catalog.matches, [summary]);
});

test("OttLobbyServer clears durable claims when spectator delivery is disabled", async () => {
  const fixture = await lobbyFixture(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  fixture.server.env.OTT_SPECTATOR_ENABLED = "false";
  fixture.values.set("public-catalog-notify-claim:1", {
    catalogRevision: 1,
    attempt: 0,
    nextAttemptMs: 0,
    terminalRemovalPending: true,
    leaseUntilMs: Date.now() + 60_000,
  });
  fixture.values.set("public-catalog-notify-exhausted", {
    catalogRevision: 1,
    attempt: 4,
    nextAttemptMs: Date.now(),
    terminalRemovalPending: true,
  });

  await fixture.server.alarm();

  assert.equal(fixture.values.has("public-catalog-notify-claim:1"), false);
  assert.equal(fixture.values.has("public-catalog-notify-exhausted"), false);
});

test("durableFixture serializes concurrent transactions and preserves both updates", async () => {
  const fixture = durableFixture([["counter", 0]]);
  let firstStarted;
  let releaseFirst;
  const firstStart = new Promise((resolve) => { firstStarted = resolve; });
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
  let callbacks = 0;
  const increment = async (storage, wait = false) => {
    callbacks += 1;
    if (wait) {
      firstStarted();
      await firstRelease;
    }
    const value = await storage.get("counter");
    await storage.put("counter", value + 1);
  };

  const first = fixture.storage.transaction((storage) => increment(storage, true));
  await firstStart;
  const second = fixture.storage.transaction((storage) => increment(storage));
  await Promise.resolve();
  assert.equal(callbacks, 1);
  releaseFirst();
  await Promise.all([first, second]);

  assert.equal(fixture.values.get("counter"), 2);
});
