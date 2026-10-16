import test from "node:test";
import assert from "node:assert/strict";
import worker, { ArenaDiscoveryConfig } from "./src/index.mjs";

const API = "https://proposition-lot-love-volunteers.trycloudflare.com/api/arena/v1";
const ORIGIN = "https://ottv2-arena-demo-20261016.vercel.app";
const LOOPBACK = "http://127.0.0.1:3000";
const TOKEN = "test-write-token";

function createHarness(options = {}) {
  const token = Object.hasOwn(options, "token") ? options.token : TOKEN;
  const initial = options.initial || null;
  const storage = new Map(initial ? [["config", initial]] : []);
  const object = new ArenaDiscoveryConfig({
    storage: {
      async get(key) { return storage.get(key); },
      async put(key, value) { storage.set(key, value); },
    },
  }, token === undefined ? {} : { ARENA_DISCOVERY_WRITE_TOKEN: token });
  const namespace = {
    idFromName(name) { assert.equal(name, "config"); return name; },
    get() { return { fetch: (request) => object.fetch(request) }; },
  };
  const env = { ARENA_DISCOVERY: namespace };
  if (token !== undefined) env.ARENA_DISCOVERY_WRITE_TOKEN = token;
  return { env, storage };
}

async function request(env, method, body, headers = {}, url = "https://discovery.example.com/api/arena-discovery/v1/config") {
  return worker.fetch(new Request(url, {
    method,
    headers: { Origin: ORIGIN, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
}

test("GET returns empty persisted config with no-store and allowed CORS", async () => {
  const { env } = createHarness();
  const response = await request(env, "GET");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { arenaApiEndpoint: null, updatedAt: null });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN);
});

test("OPTIONS supports production and loopback origins", async () => {
  const { env } = createHarness();
  const response = await request(env, "OPTIONS", undefined, {}, "https://discovery.example.com/api/arena-discovery/v1/config");
  assert.equal(response.status, 204);
  assert.match(response.headers.get("access-control-allow-methods"), /GET/);

  const loopback = await worker.fetch(new Request("https://discovery.example.com/api/arena-discovery/v1/config", {
    method: "OPTIONS", headers: { Origin: LOOPBACK },
  }), env);
  assert.equal(loopback.status, 204);
});

test("PUT requires configured bearer token and persists an accepted endpoint", async () => {
  const { env, storage } = createHarness();
  assert.equal((await request(env, "PUT", { arenaApiEndpoint: API })).status, 401);
  assert.equal((await request(env, "PUT", { arenaApiEndpoint: API }, { Authorization: "Bearer wrong" })).status, 401);

  const response = await request(env, "PUT", { arenaApiEndpoint: API }, { Authorization: `Bearer ${TOKEN}` });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { arenaApiEndpoint: API, updatedAt: storage.get("config").updatedAt });
  assert.match(storage.get("config").updatedAt, /^\d{4}-\d{2}-\d{2}T/);

  const read = await request(env, "GET");
  assert.deepEqual(await read.json(), { arenaApiEndpoint: API, updatedAt: storage.get("config").updatedAt });
});

test("PUT fails closed when write token is missing", async () => {
  const { env } = createHarness({ token: undefined });
  const response = await request(env, "PUT", { arenaApiEndpoint: API }, { Authorization: `Bearer ${TOKEN}` });
  assert.equal(response.status, 503);
});

test("rejects malformed, non-HTTPS, non-single-label, and credential-bearing endpoints", async () => {
  const { env } = createHarness();
  const invalid = [
    "http://one.trycloudflare.com/api/arena/v1",
    "https://one.two.trycloudflare.com/api/arena/v1",
    "https://one.trycloudflare.com/api/arena/v2",
    "https://one.trycloudflare.com/api/arena/v1/",
    "https://one.trycloudflare.com:443/api/arena/v1",
    "https://user:pass@one.trycloudflare.com/api/arena/v1",
    "https://one.trycloudflare.com/api/arena/v1?token=x",
    "https://one.trycloudflare.com/api/arena/v1#fragment",
  ];
  for (const arenaApiEndpoint of invalid) {
    const response = await request(env, "PUT", { arenaApiEndpoint }, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(response.status, 422, arenaApiEndpoint);
  }
});

test("rejects unknown fields, bad JSON, and disallowed origins", async () => {
  const { env } = createHarness();
  const unknown = await request(env, "PUT", { arenaApiEndpoint: API, extra: "nope" }, { Authorization: `Bearer ${TOKEN}` });
  assert.equal(unknown.status, 400);

  const badJson = await worker.fetch(new Request("https://discovery.example.com/api/arena-discovery/v1/config", {
    method: "PUT", headers: { Origin: ORIGIN, Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: "{",
  }), env);
  assert.equal(badJson.status, 400);

  const cors = await worker.fetch(new Request("https://discovery.example.com/api/arena-discovery/v1/config", {
    headers: { Origin: "https://not-approved.example" },
  }), env);
  assert.equal(cors.status, 403);
});

test("rejects request bodies over 2 KiB", async () => {
  const { env } = createHarness();
  const response = await request(env, "PUT", { arenaApiEndpoint: `${API}${"x".repeat(2100)}` }, { Authorization: `Bearer ${TOKEN}` });
  assert.equal(response.status, 413);
});
