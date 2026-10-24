/**
 * Behaviour fingerprints (plan §8.5): every bot answers the same secret set of positions; two bots that pick the same
 * move in ≥ 90% of non-trivial positions are flagged. This catches a copy that was translated to another language or
 * renamed beyond what the source checks see. Pure: the set is generated here, played by the runner, compared by the API.
 *
 * Position (set file and probe job):  { turn: "A"|"B", pieces: [{ id, player, type, x, y }] }  (rules.js state shape)
 * Fingerprint:                        one "x,y-x,y" per position, or null when the bot gave no legal answer
 */
import rules from "../../game-core/src/rules.js";
import ai from "../../game-core/src/ai.js";
import { createMapState } from "../../arena/src/domain/maps/index.mjs";
import { MAPS } from "./replay.mjs";

export const PROBE_SET_FORMAT = "ott-bot-cup-probe-set-1";

export const FINGERPRINT_POLICY = Object.freeze({
  /** Share of identical moves that raises a flag (plan §8.5). */
  flagRatio: 0.9,
  /** Positions both bots must have answered before a ratio means anything. */
  minCompared: 20,
  /** Size of the secret set: 100 for everyone, 300 for the Top 32 (plan §8.5). */
  positions: 100,
  topPositions: 300,
  /** A position is non-trivial when the side to move has at least this many legal moves and no move wins at once. */
  minLegalMoves: 4,
  /**
   * Reference bots every fingerprint is compared with (plan §8.5): ai.js easy/medium/hard and the two starter templates.
   * Teams that play like the same reference get one flag each against it, not a flag for every pair of them.
   */
  references: Object.freeze(["easy", "medium", "hard", "template-python", "template-js"])
});

const MOVE_KEY = /^[0-8],[0-8]-[0-8],[0-8]$/;

/** "x,y-x,y" for a move, or null. */
export function moveKey(move) {
  if (!move || !move.from || !move.to) return null;
  const key = `${move.from.x},${move.from.y}-${move.to.x},${move.to.y}`;
  return MOVE_KEY.test(key) ? key : null;
}

export function isMoveKey(value) {
  return value === null || (typeof value === "string" && MOVE_KEY.test(value));
}

function stateOf(position) {
  return { turn: position.turn, winner: null, reason: null, eliminatedPlayer: null, clock: null, pieces: position.pieces.map((piece) => ({ ...piece })) };
}

export function legalMovesOf(position) {
  return rules.allMoves(stateOf(position), position.turn);
}

/** True when the side to move has real choices: several legal moves and none that ends the game at once. */
export function isNonTrivialPosition(position) {
  const state = stateOf(position);
  if (rules.detectWinner(state)) return false;
  const moves = rules.allMoves(state, position.turn);
  if (moves.length < FINGERPRINT_POLICY.minLegalMoves) return false;
  return !moves.some((move) => {
    const next = rules.applyMove(state, position.turn, move.from, move.to);
    return Boolean(next.ok && next.state.winner);
  });
}

/** Deterministic PRNG for reproducible sets in tests; real sets use crypto randomness. */
export function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function boardKey(position) {
  return `${position.turn}|${position.pieces.map((piece) => `${piece.player}${piece.type}${piece.x}${piece.y}`).sort().join(",")}`;
}

/**
 * A secret set: positions reached in games where each side plays ai.js "easy" or a random legal move, sampled at a
 * random ply, kept only when non-trivial and new. Both colours and all three maps are covered.
 * @param {{ count: number, random?: () => number, maxPly?: number }} options
 */
export function generateProbePositions({ count, random = Math.random, maxPly = 60 }) {
  const positions = [];
  const seen = new Set();
  let games = 0;
  while (positions.length < count && games < count * 20) {
    const mapId = MAPS[games % MAPS.length];
    games += 1;
    let state = createMapState(mapId);
    const stopAt = 4 + Math.floor(random() * (maxPly - 4));
    for (let ply = 0; ply < stopAt && !state.winner; ply += 1) {
      const moves = rules.allMoves(state, state.turn);
      if (!moves.length) break;
      const move = random() < 0.5 ? moves[Math.floor(random() * moves.length)] : ai.chooseMove(state, state.turn, { level: "easy", rng: random }) ?? moves[0];
      const next = rules.applyMove(state, state.turn, move.from, move.to);
      if (!next.ok) break;
      state = next.state;
    }
    if (state.winner) continue;
    const position = { turn: state.turn, pieces: state.pieces.map(({ id, player, type, x, y }) => ({ id, player, type, x, y })) };
    const key = boardKey(position);
    if (seen.has(key) || !isNonTrivialPosition(position)) continue;
    seen.add(key);
    positions.push(position);
  }
  if (positions.length < count) throw new Error(`only ${positions.length} of ${count} positions generated`);
  return positions;
}

/** The exact text of a set file; its SHA-256 names the set in jobs and fingerprints. */
export function probeSetText(positions) {
  return JSON.stringify({ format: PROBE_SET_FORMAT, positions });
}

/** Checks a set file's content (the runner refuses to probe with anything else). */
export function parseProbeSet(text) {
  const data = JSON.parse(text);
  if (data?.format !== PROBE_SET_FORMAT || !Array.isArray(data.positions) || data.positions.length === 0) throw new Error("not a probe set");
  for (const position of data.positions) {
    if (!["A", "B"].includes(position.turn) || !Array.isArray(position.pieces)) throw new Error("bad probe position");
  }
  return data.positions;
}

/** The fingerprint of an in-process chooser (house bots in tests and reports): chooser(position) -> move. */
export function fingerprintWith(positions, chooser) {
  return positions.map((position) => {
    const move = chooser(position);
    const key = moveKey(move);
    if (!key) return null;
    return legalMovesOf(position).some((legal) => moveKey(legal) === key) ? key : null;
  });
}

/**
 * Share of positions where both bots answered and chose the same move.
 * @returns {{ compared: number, same: number, ratio: number }}
 */
export function compareFingerprints(a, b) {
  let compared = 0;
  let same = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] === null || b[index] === null) continue;
    compared += 1;
    if (a[index] === b[index]) same += 1;
  }
  return { compared, same, ratio: compared ? same / compared : 0 };
}

export function fingerprintFlagged(comparison) {
  return comparison.compared >= FINGERPRINT_POLICY.minCompared && comparison.ratio >= FINGERPRINT_POLICY.flagRatio;
}

/**
 * Flags for a whole set once every fingerprint is in (so the result does not depend on the order jobs finish):
 * a submission that plays like references gets one flag against the closest; two teams that play alike get a pair
 * flag unless both play like the same reference (then the reference explains it). Versions of one team are not compared.
 * @param {Array<{ submissionId: string|null, house: string|null, teamId: string|null, moves: Array<string|null> }>} prints
 * @returns {Array<{ submissionId: string, otherSubmissionId: string|null, reference: string|null, compared: number, same: number, ratio: number, positions: number }>}
 */
export function flagsForSet(prints) {
  const references = prints.filter((print) => print.house);
  const submissions = prints.filter((print) => print.submissionId);
  const flags = [];
  const matched = new Map();
  for (const submission of submissions) {
    const hits = new Set();
    let best = null;
    for (const reference of references) {
      const comparison = compareFingerprints(submission.moves, reference.moves);
      if (!fingerprintFlagged(comparison)) continue;
      hits.add(reference.house);
      if (!best || comparison.ratio > best.ratio) best = { ...comparison, house: reference.house, positions: Math.min(submission.moves.length, reference.moves.length) };
    }
    // One flag against the closest reference: the two templates play alike, and one copy is one finding.
    if (best) flags.push({ submissionId: submission.submissionId, otherSubmissionId: null, reference: `house:${best.house}`, compared: best.compared, same: best.same, ratio: best.ratio, positions: best.positions });
    matched.set(submission.submissionId, hits);
  }
  for (let i = 0; i < submissions.length; i += 1) {
    for (let j = i + 1; j < submissions.length; j += 1) {
      const [a, b] = [submissions[i], submissions[j]];
      if (a.teamId && a.teamId === b.teamId) continue;
      const comparison = compareFingerprints(a.moves, b.moves);
      if (!fingerprintFlagged(comparison)) continue;
      const shared = [...matched.get(a.submissionId)].some((house) => matched.get(b.submissionId).has(house));
      if (shared) continue;
      flags.push({ submissionId: a.submissionId, otherSubmissionId: b.submissionId, reference: null, ...comparison, positions: Math.min(a.moves.length, b.moves.length) });
    }
  }
  return flags;
}
