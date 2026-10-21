const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const rules = require("../packages/game-core/src/rules.js");
const path = require("node:path");
function payload(state) {
  return { protocolVersion: 1, requestId: "test", turn: state.turn,
    turnTimeLimitMs: 1000, timeRemainingMs: 600000,
    board: state.pieces.map(({ player, ...p }) => ({ ...p, owner: player })),
    legalMoves: rules.allMoves(state, state.turn).map(({ from, to }) => ({ from, to })) };
}
test("standalone simulator matches authoritative rules over reachable positions", async () => {
  const bot = await import("../bots/strategist.mjs");
  let state = rules.createInitialState();
  for (let n = 0; n < 80 && !state.winner; n++) {
    const turn = payload(state);
    assert.deepEqual(bot.movesFor(turn.board, state.turn), turn.legalMoves);
    const move = turn.legalMoves[(n * 17 + 3) % turn.legalMoves.length];
    const result = rules.applyMove(state, state.turn, move.from, move.to);
    assert.equal(result.ok, true);
    assert.deepEqual(bot.advance(turn.board, move), payload(result.state).board);
    state = result.state;
  }
});
test("takes immediate goal and blocks opponent goal threat", async () => {
  const { choose } = await import("../bots/strategist.mjs");
  const piece = (id, player, type, x, y) => ({ id, player, type, x, y });
  const win = { turn: "A", pieces: [piece("a", "A", "dam", 1, 0), piece("b", "B", "la", 6, 6)] };
  assert.deepEqual(choose(payload(win)).move.to, { x: 0, y: 0 });
  const block = { turn: "A", pieces: [piece("a", "A", "dam", 6, 6), piece("b", "B", "keo", 7, 7)] };
  assert.deepEqual(choose(payload(block), { budgetMs: 200, maxDepth: 3 }).move.to, { x: 7, y: 7 });
});
test("submission handles multiple NDJSON turns with clean stdout", () => {
  const turn = payload(rules.createInitialState());
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../bots/strategist.mjs")], {
    input: JSON.stringify(turn) + "\n" + JSON.stringify({ ...turn, requestId: "second" }) + "\n",
    encoding: "utf8", timeout: 5000
  });
  assert.equal(result.status, 0, result.stderr);
  const replies = result.stdout.trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(replies.length, 2);
  assert.equal(replies[1].requestId, "second");
  for (const reply of replies) {
    assert.equal(reply.protocolVersion, 1);
    assert.ok(turn.legalMoves.some((m) => JSON.stringify(m) === JSON.stringify(reply.move)));
  }
});
