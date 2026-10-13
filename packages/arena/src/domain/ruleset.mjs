export const RULESET_ID_G_V1 = "ottv2-g-default-v1";

const CANONICAL_A_SETUP = Object.freeze([
  { type: "la", x: 4, y: 7 },
  { type: "dam", x: 5, y: 7 },
  { type: "keo", x: 4, y: 6 },
  { type: "la", x: 5, y: 6 },
  { type: "dam", x: 6, y: 6 },
  { type: "keo", x: 5, y: 5 },
  { type: "la", x: 6, y: 5 },
  { type: "dam", x: 7, y: 5 },
  { type: "keo", x: 6, y: 4 },
  { type: "la", x: 7, y: 4 }
]);

const CANONICAL_DELTAS = Object.freeze([
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],           [1, 0],
  [-1, 1],  [0, 1],  [1, 1]
]);

const CANONICAL_WIN_CONDITIONS = Object.freeze(["goal", "elimination", "no_moves"]);

/**
 * Pure helper to recursively sort all object keys in lexical order,
 * preserving array order.
 */
export function canonicalize(val) {
  if (val === null || typeof val !== "object") {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(canonicalize);
  }
  const sorted = {};
  const keys = Object.keys(val).sort();
  for (const k of keys) {
    sorted[k] = canonicalize(val[k]);
  }
  return sorted;
}

/**
 * Canonical JSON serialization of any data structure.
 * Keys of objects are sorted lexically at every level.
 */
export function canonicalSerialize(val) {
  return JSON.stringify(canonicalize(val));
}

/**
 * Creates the standard RulesetSnapshot matching configuration G v1.
 * @param {object} config - core configuration object (from packages/game-core/src/config)
 */
export function createCurrentRulesetSnapshot(config) {
  if (!config) {
    throw new Error("Missing config object for createCurrentRulesetSnapshot");
  }

  const { SIZE, FILES, TYPES, BEATS, GOAL, A_SETUP, DELTAS } = config;

  const aPieces = (A_SETUP || CANONICAL_A_SETUP).map((s) => ({
    type: s.type,
    x: s.x,
    y: s.y
  }));

  const bPieces = aPieces.map((s) => ({
    type: s.type,
    x: SIZE - 1 - s.x,
    y: SIZE - 1 - s.y
  }));

  return {
    rulesetId: RULESET_ID_G_V1,
    boardWidth: SIZE,
    boardHeight: SIZE,
    files: FILES,
    types: [...TYPES],
    beats: { ...BEATS },
    goals: {
      A: { x: GOAL.A.x, y: GOAL.A.y },
      B: { x: GOAL.B.x, y: GOAL.B.y }
    },
    initialSetup: {
      A: aPieces,
      B: bPieces
    },
    movement: {
      deltas: (DELTAS || CANONICAL_DELTAS).map((d) => [d[0], d[1]]),
      maxDistance: 1
    },
    winConditions: [...CANONICAL_WIN_CONDITIONS]
  };
}

/**
 * Generates canonical JSON string for a ruleset snapshot.
 */
export function canonicalRulesetJson(snapshot) {
  return canonicalSerialize(snapshot);
}

/**
 * Validates the schema of a ruleset snapshot (structural validation).
 * Bounded strictly to fixed 9x9 shape, valid coordinates and piece types.
 * Rejects unsupported board shapes, arrays, non-objects, and malformed nested values without throwing.
 */
export function validateRulesetSnapshot(snapshot) {
  const errors = [];
  try {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      return {
        ok: false,
        errors: [{ path: "snapshot", code: "invalid_type", message: "Snapshot must be a non-null object" }]
      };
    }

    if (typeof snapshot.rulesetId !== "string" || snapshot.rulesetId.trim().length === 0) {
      errors.push({ path: "snapshot.rulesetId", code: "invalid_ruleset_id", message: "Missing or invalid rulesetId" });
    }

    // Bounded fixed 9x9 board shape
    if (snapshot.boardWidth !== 9 || snapshot.boardHeight !== 9) {
      errors.push({
        path: "snapshot.boardDimensions",
        code: "unsupported_board_dimensions",
        message: `Board dimensions must be fixed 9x9, received ${snapshot.boardWidth}x${snapshot.boardHeight}`
      });
    }

    if (snapshot.files !== "abcdefghi") {
      errors.push({
        path: "snapshot.files",
        code: "unsupported_files",
        message: "files specification must be 'abcdefghi' for 9x9 board"
      });
    }

    if (!Array.isArray(snapshot.types) || snapshot.types.length === 0) {
      errors.push({ path: "snapshot.types", code: "invalid_types", message: "types must be a non-empty array" });
    } else {
      const typeSet = new Set();
      for (let i = 0; i < snapshot.types.length; i++) {
        const t = snapshot.types[i];
        if (typeof t !== "string" || t.trim().length === 0) {
          errors.push({ path: `snapshot.types[${i}]`, code: "invalid_type_entry", message: "Type must be a non-empty string" });
        } else if (typeSet.has(t)) {
          errors.push({ path: `snapshot.types[${i}]`, code: "duplicate_type", message: `Duplicate piece type: ${t}` });
        }
        typeSet.add(t);
      }
    }

    if (!snapshot.beats || typeof snapshot.beats !== "object" || Array.isArray(snapshot.beats)) {
      errors.push({ path: "snapshot.beats", code: "invalid_beats", message: "beats must be an object map" });
    }

    if (!snapshot.goals || typeof snapshot.goals !== "object" || Array.isArray(snapshot.goals)) {
      errors.push({ path: "snapshot.goals", code: "invalid_goals", message: "goals must be an object" });
    } else {
      for (const seat of ["A", "B"]) {
        const goal = snapshot.goals[seat];
        if (!goal || typeof goal !== "object" || Array.isArray(goal)) {
          errors.push({ path: `snapshot.goals.${seat}`, code: "invalid_goal", message: `Missing goal for seat ${seat}` });
        } else if (!Number.isInteger(goal.x) || !Number.isInteger(goal.y) || goal.x < 0 || goal.x >= 9 || goal.y < 0 || goal.y >= 9) {
          errors.push({ path: `snapshot.goals.${seat}`, code: "invalid_goal_coordinate", message: `Goal coordinate out of bounds for seat ${seat}` });
        }
      }
    }

    if (!snapshot.initialSetup || typeof snapshot.initialSetup !== "object" || Array.isArray(snapshot.initialSetup)) {
      errors.push({ path: "snapshot.initialSetup", code: "invalid_setup", message: "initialSetup must be an object" });
    } else {
      for (const seat of ["A", "B"]) {
        const pieces = snapshot.initialSetup[seat];
        if (!Array.isArray(pieces)) {
          errors.push({ path: `snapshot.initialSetup.${seat}`, code: "invalid_setup_pieces", message: `Setup for ${seat} must be an array` });
        } else {
          const cells = new Set();
          pieces.forEach((p, idx) => {
            const pPath = `snapshot.initialSetup.${seat}[${idx}]`;
            if (!p || typeof p !== "object" || Array.isArray(p)) {
              errors.push({ path: pPath, code: "invalid_piece", message: "Piece must be an object" });
              return;
            }
            if (typeof p.type !== "string" || p.type.trim().length === 0) {
              errors.push({ path: `${pPath}.type`, code: "invalid_piece_type", message: "Piece type must be string" });
            }
            if (!Number.isInteger(p.x) || !Number.isInteger(p.y) || p.x < 0 || p.x >= 9 || p.y < 0 || p.y >= 9) {
              errors.push({ path: pPath, code: "invalid_piece_coordinate", message: "Coordinates out of bounds 0..8" });
            } else {
              const cellKey = `${p.x},${p.y}`;
              if (cells.has(cellKey)) {
                errors.push({ path: pPath, code: "duplicate_setup_cell", message: `Duplicate piece at cell ${cellKey}` });
              }
              cells.add(cellKey);
            }
          });
        }
      }
    }

    if (!snapshot.movement || typeof snapshot.movement !== "object" || Array.isArray(snapshot.movement)) {
      errors.push({ path: "snapshot.movement", code: "invalid_movement", message: "movement must be an object" });
    } else {
      if (!Number.isInteger(snapshot.movement.maxDistance) || snapshot.movement.maxDistance < 1) {
        errors.push({ path: "snapshot.movement.maxDistance", code: "invalid_max_distance", message: "maxDistance must be integer >= 1" });
      }
      if (!Array.isArray(snapshot.movement.deltas)) {
        errors.push({ path: "snapshot.movement.deltas", code: "invalid_deltas", message: "movement.deltas must be an array" });
      } else {
        snapshot.movement.deltas.forEach((d, idx) => {
          if (!Array.isArray(d) || d.length !== 2 || !Number.isInteger(d[0]) || !Number.isInteger(d[1])) {
            errors.push({ path: `snapshot.movement.deltas[${idx}]`, code: "invalid_delta_entry", message: "Delta must be [dx, dy] integer pair" });
          }
        });
      }
    }

    if (!Array.isArray(snapshot.winConditions) || snapshot.winConditions.length === 0) {
      errors.push({ path: "snapshot.winConditions", code: "invalid_win_conditions", message: "winConditions must be non-empty array" });
    }
  } catch (err) {
    return {
      ok: false,
      errors: [{ path: "snapshot", code: "malformed_snapshot_exception", message: err.message }]
    };
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Strict engine check: returns true if and only if the snapshot matches
 * the full semantics of core ruleset G v1:
 * - ID ottv2-g-default-v1
 * - 9x9 board with files abcdefghi
 * - Types: dam, la, keo (no duplicates, no omissions)
 * - Beats: dam beats keo, keo beats la, la beats dam
 * - Goals: A at (0, 0), B at (8, 8)
 * - Initial setup: A matches canonical 10 piece coordinates and types; B matches 180° rotation
 * - Movement: 8 adjacent directions (deltas), maxDistance 1
 * - Win conditions: goal, elimination, no_moves
 */
export function isSupportedEngineRuleset(snapshot) {
  const schemaVal = validateRulesetSnapshot(snapshot);
  if (!schemaVal.ok) return false;

  // 1. Ruleset ID
  if (snapshot.rulesetId !== RULESET_ID_G_V1) return false;

  // 2. Types
  if (!Array.isArray(snapshot.types) || snapshot.types.length !== 3) return false;
  const canonicalTypes = ["dam", "la", "keo"];
  for (const t of canonicalTypes) {
    if (!snapshot.types.includes(t)) return false;
  }

  // 3. Beats
  const expectedBeats = { dam: "keo", keo: "la", la: "dam" };
  const beatKeys = Object.keys(snapshot.beats);
  if (beatKeys.length !== 3) return false;
  for (const k of Object.keys(expectedBeats)) {
    if (snapshot.beats[k] !== expectedBeats[k]) return false;
  }

  // 4. Goals
  if (snapshot.goals.A.x !== 0 || snapshot.goals.A.y !== 0) return false;
  if (snapshot.goals.B.x !== 8 || snapshot.goals.B.y !== 8) return false;

  // 5. Initial Setup A
  const setupA = snapshot.initialSetup.A;
  if (!Array.isArray(setupA) || setupA.length !== 10) return false;
  for (let i = 0; i < 10; i++) {
    const expected = CANONICAL_A_SETUP[i];
    const actual = setupA[i];
    if (actual.type !== expected.type || actual.x !== expected.x || actual.y !== expected.y) {
      return false;
    }
  }

  // 6. Initial Setup B (must mirror A 180 degrees)
  const setupB = snapshot.initialSetup.B;
  if (!Array.isArray(setupB) || setupB.length !== 10) return false;
  for (let i = 0; i < 10; i++) {
    const expectedA = CANONICAL_A_SETUP[i];
    const actualB = setupB[i];
    if (actualB.type !== expectedA.type || actualB.x !== 8 - expectedA.x || actualB.y !== 8 - expectedA.y) {
      return false;
    }
  }

  // 7. Movement deltas & maxDistance
  if (snapshot.movement.maxDistance !== 1) return false;
  if (!Array.isArray(snapshot.movement.deltas) || snapshot.movement.deltas.length !== 8) return false;
  const deltaSet = new Set(snapshot.movement.deltas.map((d) => `${d[0]},${d[1]}`));
  for (const [dx, dy] of CANONICAL_DELTAS) {
    if (!deltaSet.has(`${dx},${dy}`)) return false;
  }

  // 8. Win conditions
  if (!Array.isArray(snapshot.winConditions) || snapshot.winConditions.length !== 3) return false;
  for (const wc of CANONICAL_WIN_CONDITIONS) {
    if (!snapshot.winConditions.includes(wc)) return false;
  }

  return true;
}
