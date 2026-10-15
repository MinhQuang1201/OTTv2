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
