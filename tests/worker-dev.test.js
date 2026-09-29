const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { buildWranglerArgs, main } = require("../scripts/worker-dev");

test("worker dev builds local Wrangler arguments", () => {
  const args = buildWranglerArgs(8900, ["--env", "test"]);
  assert.deepEqual(args.slice(0, 2), ["--no-install", "wrangler"]);
  assert.ok(args.includes("--config") && args.includes("apps/worker/wrangler.jsonc"));
  assert.ok(args.includes("--local"));
  assert.ok(args.includes("--ip") && args.includes("127.0.0.1"));
  assert.ok(args.includes("--port") && args.includes("8900"));
  assert.ok(args.includes("--inspector-port") && args.includes("0"));
  assert.deepEqual(args.slice(-2), ["--env", "test"]);
});

function fakeChild() {
  const child = new EventEmitter();
  child.kill = () => true;
  return child;
}

test("worker dev returns Wrangler exit code", async () => {
  const child = fakeChild();
  const result = main({ spawnProcess: () => {
    setImmediate(() => child.emit("exit", 7, null));
    return child;
  } });
  assert.equal(await result, 7);
});

test("worker dev reports child startup errors", async () => {
  const child = fakeChild();
  const result = main({ spawnProcess: () => {
    setImmediate(() => child.emit("error", new Error("spawn failed")));
    return child;
  } });
  await assert.rejects(result, /spawn failed/);
});
