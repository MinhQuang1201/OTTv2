const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");
const { build } = require("esbuild");

const root = path.resolve(__dirname, "..");

let cachedWorkerModule = null;

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
              contents: `export class YServer {}`,
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
