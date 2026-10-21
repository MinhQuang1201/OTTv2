const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const rules = require("../packages/game-core/src/rules.js");
function turn(state) {
  return { protocolVersion: 1, requestId: "sentinel-test", turn: state.turn,
    turnTimeLimitMs: 1000, timeRemainingMs: 600000,
    board: state.pieces.map(({ player, ...p }) => ({ ...p, owner: player })),
    legalMoves: rules.allMoves(state, state.turn).map(({ from, to }) => ({ from, to })) };
}
test("Sentinel simulator agrees with real rules on reachable positions", async () => {
  const bot = await import("../bots/sentinel.mjs");
  let state = rules.createInitialState();
  for (let i = 0; i < 80 && !state.winner; i++) {
    const input = turn(state);
    assert.deepEqual(bot.legalMoves(input.board, state.turn), input.legalMoves);
    const move = input.legalMoves[(i * 11 + 7) % input.legalMoves.length];
    const next = rules.applyMove(state, state.turn, move.from, move.to);
    assert.equal(next.ok, true);
    assert.deepEqual(bot.play(input.board, move), turn(next.state).board);
    state = next.state;
  }
});
test("Sentinel blocks immediate goal even with no completed search iteration", async () => {
  const { chooseMove } = await import("../bots/sentinel.mjs");
  const state = { turn: "A", pieces: [
    { id: "a", player: "A", type: "dam", x: 6, y: 6 },
    { id: "a2", player: "A", type: "la", x: 4, y: 4 },
    { id: "b", player: "B", type: "keo", x: 7, y: 7 }
  ] };
  assert.deepEqual(chooseMove(turn(state), { budgetMs: 0 }).move.to, { x: 7, y: 7 });
});
test("Sentinel submission accepts repeated NDJSON turns and emits legal protocol replies", () => {
  const input = turn(rules.createInitialState());
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../bots/sentinel.mjs")], {
    input: JSON.stringify(input) + "\n" + JSON.stringify({ ...input, requestId: "second" }) + "\n",
    encoding: "utf8", timeout: 5000
  });
  assert.equal(result.status, 0, result.stderr);
  const replies = result.stdout.trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(replies.length, 2);
  assert.equal(replies[1].requestId, "second");
  for (const reply of replies) {
    assert.equal(reply.protocolVersion, 1);
    assert.ok(input.legalMoves.some((move) => JSON.stringify(move) === JSON.stringify(reply.move)));
  }
});
