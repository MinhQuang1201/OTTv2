const { test } = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../packages/game-core/src/rules');
const { chooseMove } = require('../packages/game-core/src/ai');

function position(pieces) {
  return { ...rules.createEmptyState(), pieces };
}

test('AI blocks an immediate opposing goal instead of taking a tempting capture', () => {
  const state = position([
    { id: 'guard', player: 'A', type: 'dam', x: 7, y: 7 },
    { id: 'attacker', player: 'A', type: 'la', x: 3, y: 3 },
    { id: 'runner', player: 'B', type: 'keo', x: 8, y: 7 },
    { id: 'bait', player: 'B', type: 'dam', x: 2, y: 2 }
  ]);
  const before = structuredClone(state);
  const move = chooseMove(state, 'A');
  const next = rules.applyMove(state, 'A', move.from, move.to).state;
  assert.equal(rules.allMoves(next, 'B').some(reply =>
    rules.applyMove(next, 'B', reply.from, reply.to).state?.winner === 'B'), false);
  assert.deepEqual(state, before);
});

test('AI takes an immediate win and is deterministic without shared game state', () => {
  const state = position([
    { id: 'goal', player: 'A', type: 'dam', x: 1, y: 1 },
    { id: 'enemy', player: 'B', type: 'la', x: 5, y: 5 }
  ]);
  const move = chooseMove(state, 'A');
  assert.equal(rules.applyMove(state, 'A', move.from, move.to).state.winner, 'A');
  assert.deepEqual(chooseMove(rules.createInitialState(), 'A'), chooseMove(rules.createInitialState(), 'A'));
});

test('AI returns no move for a finished game or a seat out of turn', () => {
  assert.equal(chooseMove({ ...rules.createInitialState(), winner: 'A' }, 'A'), null);
  assert.equal(chooseMove(rules.createInitialState(), 'B'), null);
});

test('AI avoids a capture that immediately loses its moved piece when a safe step exists', () => {
  const state = position([
    { id: 'mover', player: 'A', type: 'la', x: 4, y: 4 },
    { id: 'bait', player: 'B', type: 'dam', x: 3, y: 3 },
    { id: 'hunter', player: 'B', type: 'keo', x: 2, y: 2 }
  ]);
  const move = chooseMove(state, 'A');
  const next = rules.applyMove(state, 'A', move.from, move.to).state;
  assert.equal(rules.allMoves(next, 'B').some(reply => {
    const response = rules.applyMove(next, 'B', reply.from, reply.to);
    return response.events.some(event => event.type === 'capture' && event.capturedId === 'mover');
  }), false);
});

function seeded(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

test('every level returns only moves the rules accept, across a whole game', () => {
  for (const level of ['easy', 'medium', 'hard']) {
    const rng = seeded(7);
    let state = rules.createInitialState();
    for (let ply = 0; ply < 40 && !state.winner; ply++) {
      const move = chooseMove(state, state.turn, { level, rng, maxNodes: 5000 });
      const result = rules.applyMove(state, state.turn, move.from, move.to);
      assert.equal(result.ok, true, `${level} ply ${ply}: ${result.error}`);
      state = result.state;
    }
  }
});

test('every level takes a win in one and refuses a move that hands the opponent a win', () => {
  const winning = position([
    { id: 'goal', player: 'A', type: 'dam', x: 1, y: 1 },
    { id: 'enemy', player: 'B', type: 'la', x: 5, y: 5 }
  ]);
  for (const level of ['easy', 'medium', 'hard']) {
    // 0.01 forces easy into its random-move branch, which must still keep the win.
    for (const roll of [0.01, 0.99]) {
      const move = chooseMove(winning, 'A', { level, rng: () => roll });
      assert.equal(rules.applyMove(winning, 'A', move.from, move.to).state.winner, 'A', `${level} roll ${roll}`);
    }
  }
  const defend = position([
    { id: 'guard', player: 'A', type: 'dam', x: 7, y: 7 },
    { id: 'runner', player: 'B', type: 'keo', x: 8, y: 7 },
    { id: 'far', player: 'A', type: 'la', x: 2, y: 5 }
  ]);
  for (const level of ['medium', 'hard']) {
    const move = chooseMove(defend, 'A', { level });
    const next = rules.applyMove(defend, 'A', move.from, move.to).state;
    assert.equal(rules.allMoves(next, 'B').some((reply) =>
      rules.applyMove(next, 'B', reply.from, reply.to).state?.winner === 'B'), false, level);
  }
});

test('medium and hard are deterministic, easy varies with its random source', () => {
  const state = rules.createInitialState();
  for (const level of ['medium', 'hard']) {
    assert.deepEqual(chooseMove(state, 'A', { level, rng: () => 0.1 }), chooseMove(state, 'A', { level, rng: () => 0.9 }));
  }
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const move = chooseMove(state, 'A', { level: 'easy', rng: seeded(i + 1) });
    seen.add(JSON.stringify(move));
  }
  assert.ok(seen.size > 1);
});

test('hard stays inside its node budget so a move costs bounded time', () => {
  const started = Date.now();
  chooseMove(rules.createInitialState(), 'A', { level: 'hard' });
  assert.ok(Date.now() - started < 5000);
});

test('the node budget covers every deepening step of a move', () => {
  let state = rules.createInitialState();
  for (let ply = 0; ply < 12 && !state.winner; ply++) {
    const stats = {};
    const move = chooseMove(state, state.turn, { level: 'hard', maxNodes: 3000, stats });
    // A search notices the budget one node late, then deepening stops.
    assert.ok(stats.nodes <= 3001, `ply ${ply}: ${stats.nodes} nodes`);
    state = rules.applyMove(state, state.turn, move.from, move.to).state;
  }
});

test('hard completes its full depth from the opening within the default budget', () => {
  const stats = {};
  chooseMove(rules.createInitialState(), 'A', { level: 'hard', stats });
  assert.equal(stats.depth, 4);
  assert.ok(stats.nodes <= 100001);
});
