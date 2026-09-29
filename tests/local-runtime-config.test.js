const assert = require("node:assert/strict");
const net = require("node:net");
const test = require("node:test");

const runtime = require("../config/local-runtime");

test("local runtime validates worker ports", () => {
  assert.equal(runtime.readConfiguredPort("8900"), 8900);
  assert.equal(runtime.readConfiguredPort(""), null);
  for (const value of ["abc", "0", "-1", "65536"]) {
    assert.throws(() => runtime.readConfiguredPort(value), /must be an integer/);
  }
});

test("local runtime accepts loopback hosts and formats origins", () => {
  assert.equal(runtime.readWorkerHost(), "127.0.0.1");
  assert.equal(runtime.workerOrigin("127.0.0.1", 8900), "http://127.0.0.1:8900");
  assert.equal(runtime.workerOrigin("::1", 8900, "https"), "https://[::1]:8900");
  assert.throws(() => runtime.readWorkerHost("0.0.0.0"), /OTT_WORKER_HOST/);
});

test("local runtime obtains a bindable dynamic port", async () => {
  const port = await runtime.availablePort();
  assert.ok(Number.isInteger(port) && port > 0);
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("local runtime resolves explicit or dynamic worker ports", async () => {
  assert.equal(await runtime.resolveWorkerPort("8900"), 8900);
  const dynamic = await runtime.resolveWorkerPort("");
  assert.ok(Number.isInteger(dynamic) && dynamic > 0);
});
