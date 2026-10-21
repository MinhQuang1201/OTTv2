/**
 * Pure map definitions and constants for Arena 9x9 starting positions.
 * Strict invariants: 10 pieces/seat (3 dam, 4 la, 3 keo), 180° point-reflection symmetry,
 * fixed goals, no obstacles, no own-goal or one-step-own-goal, legal moves for both seats.
 * Zero Node.js imports. Standard Web API / Pure JS.
 */

export const BOARD_SIZE = 9;
export const INITIAL_CLOCK_MS = 600000; // 10 minutes per seat

export const GOALS = Object.freeze({
  A: Object.freeze({ x: 0, y: 0 }),
  B: Object.freeze({ x: 8, y: 8 })
});

export const EXPECTED_TYPE_COUNTS = Object.freeze({
  dam: 3,
  la: 4,
  keo: 3
});

export const MOVEMENT_DELTAS = Object.freeze([
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],           [1, 0],
  [-1, 1],  [0, 1],  [1, 1]
]);

export const BEATS = Object.freeze({
  dam: "keo",
  keo: "la",
  la: "dam"
});

/**
 * Pure deep clone helper.
 */
export function cloneDeep(val) {
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(cloneDeep);
  const copy = {};
  for (const k of Object.keys(val)) {
    copy[k] = cloneDeep(val[k]);
  }
  return copy;
}

/**
 * Canonical 10-piece setup for Seat A (Classic 9x9).
 * Preserves the exact initial deployment of game-core config.A_SETUP.
 */
export const CLASSIC_SETUP_A = Object.freeze([
  Object.freeze({ type: "la",  x: 4, y: 7 }),
  Object.freeze({ type: "dam", x: 5, y: 7 }),
  Object.freeze({ type: "keo", x: 4, y: 6 }),
  Object.freeze({ type: "la",  x: 5, y: 6 }),
  Object.freeze({ type: "dam", x: 6, y: 6 }),
  Object.freeze({ type: "keo", x: 5, y: 5 }),
  Object.freeze({ type: "la",  x: 6, y: 5 }),
  Object.freeze({ type: "dam", x: 7, y: 5 }),
  Object.freeze({ type: "keo", x: 6, y: 4 }),
  Object.freeze({ type: "la",  x: 7, y: 4 })
]);

/**
 * Flanks 9x9: Split-wing formation with 5 pieces on left flank (files B..D)
 * and 5 pieces on right flank (files F..H). Center file E is clear for rapid maneuvering.
 * Exactly 3 dam, 4 la, 3 keo.
 */
export const FLANKS_SETUP_A = Object.freeze([
  // Left wing (5 pieces)
  Object.freeze({ type: "la",  x: 1, y: 6 }),
  Object.freeze({ type: "dam", x: 2, y: 6 }),
  Object.freeze({ type: "keo", x: 3, y: 6 }),
  Object.freeze({ type: "la",  x: 1, y: 5 }),
  Object.freeze({ type: "dam", x: 2, y: 5 }),
  // Right wing (5 pieces)
  Object.freeze({ type: "keo", x: 5, y: 6 }),
  Object.freeze({ type: "la",  x: 6, y: 6 }),
  Object.freeze({ type: "dam", x: 7, y: 6 }),
  Object.freeze({ type: "keo", x: 6, y: 5 }),
  Object.freeze({ type: "la",  x: 7, y: 5 })
]);

/**
 * Center 9x9: Concentrated central phalanx defending ranks 5..7 across files D..F,
 * with rear vanguard at (4, 8). Focuses battle along central axis.
 * Exactly 3 dam, 4 la, 3 keo.
 */
export const CENTER_SETUP_A = Object.freeze([
  Object.freeze({ type: "la",  x: 4, y: 8 }),
  Object.freeze({ type: "dam", x: 3, y: 7 }),
  Object.freeze({ type: "keo", x: 4, y: 7 }),
  Object.freeze({ type: "dam", x: 5, y: 7 }),
  Object.freeze({ type: "la",  x: 3, y: 6 }),
  Object.freeze({ type: "la",  x: 4, y: 6 }),
  Object.freeze({ type: "la",  x: 5, y: 6 }),
  Object.freeze({ type: "keo", x: 3, y: 5 }),
  Object.freeze({ type: "dam", x: 4, y: 5 }),
  Object.freeze({ type: "keo", x: 5, y: 5 })
]);

/**
 * Generates the full 20-piece array for both Seat A and Seat B (180° rotated).
 * Matches game-core piece ID format: A-${type}-${i} and B-${type}-${i}.
 * @param {Array<{type: string, x: number, y: number}>} setupA
 * @returns {Array<{id: string, player: "A"|"B", type: string, x: number, y: number}>}
 */
export function generateCorePieces(setupA) {
  const pieces = [];
  setupA.forEach((spot, i) => {
    pieces.push({
      id: `A-${spot.type}-${i}`,
      player: "A",
      type: spot.type,
      x: spot.x,
      y: spot.y
    });
    pieces.push({
      id: `B-${spot.type}-${i}`,
      player: "B",
      type: spot.type,
      x: BOARD_SIZE - 1 - spot.x,
      y: BOARD_SIZE - 1 - spot.y
    });
  });
  return pieces;
}

/**
 * Creates a complete initial core state matching game-core rules.js structure.
 * @param {Array<{type: string, x: number, y: number}>} setupA
 * @param {number} [initialClockMs=600000]
 * @returns {object}
 */
export function createFreshCoreState(setupA, initialClockMs = INITIAL_CLOCK_MS) {
  return {
    turn: "A",
    winner: null,
    reason: null,
    eliminatedPlayer: null,
    clock: {
      remainingMs: { A: initialClockMs, B: initialClockMs },
      runningSeat: "A"
    },
    pieces: generateCorePieces(setupA)
  };
}

/**
 * Pure map definitions catalog.
 */
export const MAP_DEFINITIONS = Object.freeze({
  classic: Object.freeze({
    id: "classic",
    revision: 1,
    name: "Classic",
    description: "Standard canonical 9x9 opening with diagonal skirmish wedge around E8:H5.",
    setupA: CLASSIC_SETUP_A
  }),
  flanks: Object.freeze({
    id: "flanks",
    revision: 1,
    name: "Flanks",
    description: "Split-wing deployment with 5 pieces on each flank and open center channel.",
    setupA: FLANKS_SETUP_A
  }),
  center: Object.freeze({
    id: "center",
    revision: 1,
    name: "Center",
    description: "Concentrated center phalanx defending the middle files with rear vanguard.",
    setupA: CENTER_SETUP_A
  })
});
