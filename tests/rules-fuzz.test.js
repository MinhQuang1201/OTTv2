const { test } = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../packages/game-core/src/rules');

function random(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

test('seeded legal trajectories preserve occupancy, capture, turn and rejection invariants', () => {
  for (let seed = 1; seed <= 32; seed++) {
    const rng = random(seed);
    let state = rules.createInitialState();
    for (let ply = 0; ply < 160 && !state.winner; ply++) {
      const context = `seed=${seed} ply=${ply}`;
      const before = structuredClone(state);
      const invalid = rules.applyMove(state, state.turn, { x: -1, y: 0 }, { x: 0, y: 0 });
      assert.equal(invalid.ok, false, context);
      assert.deepEqual(state, before, context);
      const moves = rules.allMoves(state, state.turn);
      assert.ok(moves.length, context);
      const move = moves[Math.floor(rng() * moves.length)];
      const applied = rules.applyMove(state, state.turn, move.from, move.to);
      assert.equal(applied.ok, true, context);
      assert.deepEqual(state, before, context);
      const next = applied.state;
      assert.equal(new Set(next.pieces.map(p => `${p.x},${p.y}`)).size, next.pieces.length, context);
      assert.ok(next.pieces.every(p => Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.x < 9 && p.y >= 0 && p.y < 9), context);
      const captures = applied.events.filter(event => event.type === 'capture');
      assert.equal(state.pieces.length - next.pieces.length, captures.length, context);
      assert.ok(captures.length <= 1, context);
      if (!next.winner) {
        assert.equal(next.turn, state.turn === 'A' ? 'B' : 'A', context);
        assert.equal(rules.detectWinner(next), null, context);
      } else if (next.reason === 'no_moves') {
        assert.equal(rules.allMoves({ ...next, winner: null }, next.winner === 'A' ? 'B' : 'A').length, 0, context);
      } else {
        assert.equal(rules.detectWinner(next)?.winner, next.winner, context);
      }
      state = next;
    }
  }
});
