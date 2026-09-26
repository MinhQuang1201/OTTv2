const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "game.js"), "utf8");
const functionStart = source.indexOf("  function controlRequest(");
const functionEnd = source.indexOf("\n  function playerName(", functionStart);
const functionSource = functionStart >= 0 && functionEnd > functionStart ? source.slice(functionStart, functionEnd).trim() : null;

test("controlRequest rejects non-HTTPS endpoints before sending credentials", async () => {
  assert.ok(functionSource, "game.js controlRequest function is available to exercise");
  let fetchCalls = 0;
  const controlRequest = vm.runInNewContext(`(${functionSource})`, {
    URL,
    window: {
      OTT_PLAYHTML_CONTROL_ENDPOINT: "http://worker.example",
      fetch: async () => {
        fetchCalls += 1;
        return { ok: true, json: async () => ({ ok: true }) };
      },
    },
  });

  await assert.rejects(controlRequest("resume", { allocationId: "alloc-1", resumeCredential: "do-not-send" }), /HTTPS/i);
  assert.equal(fetchCalls, 0, "an insecure endpoint must not receive the owner credential");
});

test("controlRequest accepts HTTPS control endpoints", async () => {
  assert.ok(functionSource);
  const calls = [];
  const controlRequest = vm.runInNewContext(`(${functionSource})`, {
    URL,
    window: {
      OTT_PLAYHTML_CONTROL_ENDPOINT: "https://worker.example/",
      fetch: async (url, options) => {
        calls.push([url, options]);
        return { ok: true, json: async () => ({ ok: true }) };
      },
    },
  });

  assert.deepEqual(await controlRequest("resume", { allocationId: "alloc-1" }), { ok: true });
  assert.equal(calls[0][0], "https://worker.example/control/resume");
});
