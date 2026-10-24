"use strict";

/**
 * Bot Cup starter kit (sdk/bot-cup, plan §6.4): the templates play legal games through the local judge, and the judge
 * refuses a file with a syntax error before playing. Bots run as local processes here (the kit is for players' own
 * machines and runs only files from this repository in tests); the official runner runs them in containers.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const KIT = path.resolve(__dirname, "../sdk/bot-cup");

async function judge(args) {
  const { main } = await import("../sdk/bot-cup/judge.mjs");
  const lines = [];
  const code = await main(args, (line) => lines.push(line));
  return { code, output: lines.join("\n") };
}

function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ott-kit-"));
  return Promise.resolve(run(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

const FAULT = /thua vì (trả lời sai|đi nước không hợp lệ|bot dừng)/;

describe("bot-cup starter kit", () => {
  it("plays the Python template against the easy house bot, both colours", async () => {
    const { code, output } = await judge([path.join(KIT, "python/bot.py"), "easy"]);
    assert.equal(code, 0, output);
    assert.match(output, /Ván 1 · classic · Đỏ \(A\) = bot\.py · Xanh \(B\) = easy/);
    assert.match(output, /Ván 2 · classic · Đỏ \(A\) = easy · Xanh \(B\) = bot\.py/);
    assert.doesNotMatch(output, FAULT);
    assert.match(output, /Kết quả sau 2 ván: bot\.py [\d.]+ – [\d.]+ easy/);
  });

  it("plays the JavaScript template and writes replays", () => withTempDir(async (dir) => {
    const { code, output } = await judge([path.join(KIT, "js/bot.mjs"), "first-legal", "--replays", dir]);
    assert.equal(code, 0, output);
    assert.doesNotMatch(output, FAULT);
    const replay = JSON.parse(fs.readFileSync(path.join(dir, "game-01-classic.json"), "utf8"));
    assert.equal(typeof replay, "object");
    assert.ok(fs.existsSync(path.join(dir, "game-02-classic.json")));
  }));

  it("refuses a bot with a syntax error before any game", () => withTempDir(async (dir) => {
    const brokenJs = path.join(dir, "broken.js");
    fs.writeFileSync(brokenJs, "const x = ;\n");
    const js = await judge([brokenJs, "easy"]);
    assert.equal(js.code, 1);
    assert.match(js.output, /lỗi cú pháp/);
    assert.doesNotMatch(js.output, /Ván 1/);

    const brokenPy = path.join(dir, "broken.py");
    fs.writeFileSync(brokenPy, "def f(:\n  pass\n");
    const py = await judge([brokenPy, "easy"]);
    assert.equal(py.code, 1);
    assert.match(py.output, /lỗi cú pháp/);
  }));

  it("reports a bot that prints junk to stdout as a protocol error, with its stderr", () => withTempDir(async (dir) => {
    const noisy = path.join(dir, "noisy.py");
    fs.writeFileSync(noisy, "import sys\nfor line in sys.stdin:\n    sys.stderr.write('thinking\\n')\n    sys.stderr.flush()\n    print('hello', flush=True)\n");
    const { code, output } = await judge([noisy, "first-legal"]);
    assert.equal(code, 0, output);
    assert.match(output, /noisy\.py thua vì trả lời sai định dạng/);
    assert.match(output, /stderr cuối của noisy\.py:\n {4}thinking/);
  }));

  it("packs into a folder whose judge runs with Node alone, outside the repository", () => withTempDir(async (dir) => {
    const { buildKit } = await import("../scripts/bot-cup/build-kit.mjs");
    await buildKit(dir);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["GUIDE.vi.md", "bot.mjs", "bot.py", "judge.mjs"]);
    const { spawnSync } = require("node:child_process");
    const run = spawnSync(process.execPath, ["judge.mjs", "bot.mjs", "first-legal"], { cwd: dir, encoding: "utf8", timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Kết quả sau 2 ván: bot\.mjs [\d.]+ – [\d.]+ first-legal/);
  }));

  it("explains its usage", async () => {
    const { code, output } = await judge(["only-one"]);
    assert.equal(code, 2);
    assert.match(output, /Cách dùng/);
  });
});
