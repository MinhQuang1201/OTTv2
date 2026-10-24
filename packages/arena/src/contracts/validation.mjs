import { validateMatchPolicy } from "../domain/match-policy.mjs";
import { canonicalSerialize, validateRulesetSnapshot, isSupportedEngineRuleset } from "../domain/ruleset.mjs";

const VALID_SEATS = new Set(["A", "B"]);
const VALID_PIECE_TYPES = new Set(["dam", "la", "keo"]);

const VALID_WIN_REASONS = new Set(["goal", "elimination", "no_moves"]);
const VALID_DRAW_REASONS = new Set(["max_plies"]);
const VALID_FORFEIT_REASONS = new Set([
  "turn_timeout",
  "total_timeout",
  "crash",
  "protocol_error",
  "illegal_move",
  "output_limit"
]);

export { validateMatchPolicy, validateRulesetSnapshot, isSupportedEngineRuleset };

export function validatePosition(pos, path = "position", boardWidth = 9, boardHeight = 9) {
  const errors = [];
  if (!pos || typeof pos !== "object") {
    return [{ path, code: "invalid_coordinate", message: "Position must be an object" }];
  }
  if (!Number.isInteger(pos.x) || !Number.isInteger(pos.y)) {
    errors.push({ path, code: "invalid_coordinate", message: "Coordinates must be integers" });
    return errors;
  }
  if (pos.x < 0 || pos.x >= boardWidth || pos.y < 0 || pos.y >= boardHeight) {
    errors.push({
      path,
      code: "coordinate_out_of_bounds",
      message: `Coordinate (${pos.x}, ${pos.y}) out of bounds [0..${boardWidth - 1}, 0..${boardHeight - 1}]`
    });
  }
  return errors;
}

export function validateBotTurn(turn) {
  const errors = [];
  if (!turn || typeof turn !== "object") {
    return {
      ok: false,
      errors: [{ path: "turn", code: "invalid_type", message: "Turn payload must be a non-null object" }]
    };
  }

  if (turn.protocolVersion !== 1) {
    errors.push({
      path: "turn.protocolVersion",
      code: "invalid_protocol_version",
      message: `Expected protocolVersion 1, received ${turn.protocolVersion}`
    });
  }

  if (turn.type !== "turn") {
    errors.push({
      path: "turn.type",
      code: "invalid_message_type",
      message: `Expected message type 'turn', received '${turn.type}'`
    });
  }

  if (typeof turn.requestId !== "string" || turn.requestId.length === 0) {
    errors.push({ path: "turn.requestId", code: "invalid_request_id", message: "Missing requestId" });
  }

  if (typeof turn.matchId !== "string" || turn.matchId.length === 0) {
    errors.push({ path: "turn.matchId", code: "invalid_match_id", message: "Missing matchId" });
  }

  if (typeof turn.rulesetId !== "string" || turn.rulesetId.length === 0) {
    errors.push({ path: "turn.rulesetId", code: "invalid_ruleset_id", message: "Missing rulesetId" });
  }

  if (typeof turn.rulesetHash !== "string" || turn.rulesetHash.length === 0) {
    errors.push({ path: "turn.rulesetHash", code: "invalid_ruleset_hash", message: "Missing rulesetHash" });
  }

  const width = turn.boardWidth;
  const height = turn.boardHeight;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    errors.push({
      path: "turn.boardDimensions",
      code: "invalid_board_dimensions",
      message: "boardWidth and boardHeight must be positive integers"
    });
  }

  if (!Number.isInteger(turn.ply) || turn.ply <= 0) {
    errors.push({ path: "turn.ply", code: "invalid_ply", message: "ply must be a positive integer >= 1" });
  }

  if (!VALID_SEATS.has(turn.turn)) {
    errors.push({ path: "turn.turn", code: "invalid_seat", message: `turn must be 'A' or 'B', got '${turn.turn}'` });
  }

  if (typeof turn.timeRemainingMs !== "number" || !Number.isFinite(turn.timeRemainingMs) || turn.timeRemainingMs < 0) {
    errors.push({
      path: "turn.timeRemainingMs",
      code: "invalid_time_remaining",
      message: "timeRemainingMs must be a finite non-negative number"
    });
  }

  if (typeof turn.turnTimeLimitMs !== "number" || !Number.isFinite(turn.turnTimeLimitMs) || turn.turnTimeLimitMs <= 0) {
    errors.push({
      path: "turn.turnTimeLimitMs",
      code: "invalid_turn_time_limit",
      message: "turnTimeLimitMs must be a finite positive number"
    });
  }

  if (!Array.isArray(turn.board)) {
    errors.push({ path: "turn.board", code: "invalid_board", message: "board must be an array" });
  } else {
    const occupiedCells = new Set();
    const pieceIds = new Set();

    turn.board.forEach((p, idx) => {
      const pPath = `turn.board[${idx}]`;
      if (!p || typeof p !== "object") {
        errors.push({ path: pPath, code: "invalid_piece", message: "Piece must be an object" });
        return;
      }
      if (typeof p.id !== "string" || p.id.length === 0) {
        errors.push({ path: `${pPath}.id`, code: "invalid_piece_id", message: "Piece must have string id" });
      } else {
        if (pieceIds.has(p.id)) {
          errors.push({ path: `${pPath}.id`, code: "duplicate_piece_id", message: `Duplicate piece ID: ${p.id}` });
        }
        pieceIds.add(p.id);
      }

      if (!VALID_SEATS.has(p.owner)) {
        errors.push({ path: `${pPath}.owner`, code: "invalid_piece_owner", message: "Piece owner must be 'A' or 'B'" });
      }

      if (!VALID_PIECE_TYPES.has(p.type)) {
        errors.push({ path: `${pPath}.type`, code: "invalid_piece_type", message: "Piece type must be 'dam', 'la', or 'keo'" });
      }

      const coordErrors = validatePosition(p, pPath, width || 9, height || 9);
      errors.push(...coordErrors);

      if (Number.isInteger(p.x) && Number.isInteger(p.y)) {
        const cellKey = `${p.x},${p.y}`;
        if (occupiedCells.has(cellKey)) {
          errors.push({
            path: pPath,
            code: "duplicate_cell_occupancy",
            message: `Multiple pieces found at cell (${p.x}, ${p.y})`
          });
        }
        occupiedCells.add(cellKey);
      }
    });
  }

  if (!Array.isArray(turn.legalMoves)) {
    errors.push({ path: "turn.legalMoves", code: "invalid_legal_moves", message: "legalMoves must be an array" });
  } else {
    turn.legalMoves.forEach((m, idx) => {
      const mPath = `turn.legalMoves[${idx}]`;
      if (!m || typeof m !== "object") {
        errors.push({ path: mPath, code: "invalid_move", message: "Move must be an object" });
        return;
      }
      errors.push(...validatePosition(m.from, `${mPath}.from`, width || 9, height || 9));
      errors.push(...validatePosition(m.to, `${mPath}.to`, width || 9, height || 9));
    });
  }

  return { ok: errors.length === 0, errors };
}

export function validateBotAction(action, expectedRequestId) {
  const errors = [];
  if (!action || typeof action !== "object") {
    return {
      ok: false,
      errors: [{ path: "action", code: "invalid_type", message: "Action payload must be a non-null object" }]
    };
  }

  if (action.protocolVersion !== 1) {
    errors.push({
      path: "action.protocolVersion",
      code: "invalid_protocol_version",
      message: `Expected protocolVersion 1, received ${action.protocolVersion}`
    });
  }

  if (typeof action.requestId !== "string" || action.requestId.length === 0) {
    errors.push({ path: "action.requestId", code: "invalid_request_id", message: "Missing requestId" });
  } else if (expectedRequestId && action.requestId !== expectedRequestId) {
    errors.push({
      path: "action.requestId",
      code: "request_id_mismatch",
      message: `Expected requestId '${expectedRequestId}', got '${action.requestId}'`
    });
  }

  if (!action.move || typeof action.move !== "object") {
    errors.push({ path: "action.move", code: "missing_move", message: "Action must include a move object" });
  } else {
    errors.push(...validatePosition(action.move.from, "action.move.from"));
    errors.push(...validatePosition(action.move.to, "action.move.to"));
  }

  if (action.comment !== undefined) {
    if (typeof action.comment !== "string") {
      errors.push({ path: "action.comment", code: "invalid_comment", message: "Comment must be a string" });
    } else if (action.comment.length > 2048) {
      errors.push({
        path: "action.comment",
        code: "comment_too_long",
        message: `Comment length ${action.comment.length} exceeds 2048 characters cap`
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

export function validateArenaMatchResult(result) {
  const errors = [];
  if (!result || typeof result !== "object") {
    return {
      ok: false,
      errors: [{ path: "result", code: "invalid_type", message: "Result must be a non-null object" }]
    };
  }

  if (!["win", "draw", "forfeit"].includes(result.outcome)) {
    errors.push({
      path: "result.outcome",
      code: "invalid_outcome",
      message: `Invalid outcome '${result.outcome}'; must be 'win', 'draw', or 'forfeit'`
    });
    return { ok: false, errors };
  }

  if (!Number.isInteger(result.acceptedPlies) || result.acceptedPlies < 0) {
    errors.push({
      path: "result.acceptedPlies",
      code: "invalid_accepted_plies",
      message: "acceptedPlies must be a non-negative integer"
    });
  }

  if (result.outcome === "win") {
    if (!VALID_SEATS.has(result.winner) || !VALID_SEATS.has(result.loser) || result.winner === result.loser) {
      errors.push({
        path: "result.participants",
        code: "invalid_participants",
        message: "Win outcome must have distinct winner and loser seats ('A' and 'B')"
      });
    }
    if (!VALID_WIN_REASONS.has(result.reason)) {
      errors.push({
        path: "result.reason",
        code: "invalid_reason",
        message: `Win reason must be one of [${[...VALID_WIN_REASONS].join(", ")}], got '${result.reason}'`
      });
    }
  } else if (result.outcome === "draw") {
    if (result.winner !== null || result.loser !== null) {
      errors.push({
        path: "result.participants",
        code: "invalid_participants",
        message: "Draw outcome must have null winner and loser"
      });
    }
    if (!VALID_DRAW_REASONS.has(result.reason)) {
      errors.push({
        path: "result.reason",
        code: "invalid_reason",
        message: `Draw reason must be one of [${[...VALID_DRAW_REASONS].join(", ")}], got '${result.reason}'`
      });
    }
  } else if (result.outcome === "forfeit") {
    if (!VALID_SEATS.has(result.winner) || !VALID_SEATS.has(result.loser) || result.winner === result.loser) {
      errors.push({
        path: "result.participants",
        code: "invalid_participants",
        message: "Forfeit outcome must have distinct winner and loser seats ('A' and 'B')"
      });
    }
    if (!VALID_FORFEIT_REASONS.has(result.reason)) {
      errors.push({
        path: "result.reason",
        code: "invalid_reason",
        message: `Forfeit reason must be one of [${[...VALID_FORFEIT_REASONS].join(", ")}], got '${result.reason}'`
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Helper to validate CoreEvent schema.
 */
function validateCoreEvent(ev, path) {
  const errs = [];
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) {
    return [{ path, code: "invalid_core_event", message: "Core event must be a non-null object" }];
  }
  if (!["move", "capture", "win"].includes(ev.type)) {
    return [{ path: `${path}.type`, code: "invalid_core_event", message: `Invalid core event type '${ev.type}'` }];
  }
  if (ev.type === "move") {
    if (typeof ev.pieceId !== "string" || ev.pieceId.length === 0) {
      errs.push({ path: `${path}.pieceId`, code: "invalid_piece_id", message: "Missing pieceId in move event" });
    }
    errs.push(...validatePosition(ev.from, `${path}.from`));
    errs.push(...validatePosition(ev.to, `${path}.to`));
  } else if (ev.type === "capture") {
    if (typeof ev.pieceId !== "string" || ev.pieceId.length === 0) {
      errs.push({ path: `${path}.pieceId`, code: "invalid_piece_id", message: "Missing pieceId in capture event" });
    }
    if (typeof ev.capturedId !== "string" || ev.capturedId.length === 0) {
      errs.push({ path: `${path}.capturedId`, code: "invalid_piece_id", message: "Missing capturedId in capture event" });
    }
    if (!VALID_PIECE_TYPES.has(ev.capturedType)) {
      errs.push({ path: `${path}.capturedType`, code: "invalid_piece_type", message: `Invalid capturedType in capture event: '${ev.capturedType}'` });
    }
    errs.push(...validatePosition(ev.from, `${path}.from`));
    errs.push(...validatePosition(ev.to, `${path}.to`));
  } else if (ev.type === "win") {
    if (!VALID_SEATS.has(ev.winner)) {
      errs.push({ path: `${path}.winner`, code: "invalid_seat", message: `Invalid winner in win event: '${ev.winner}'` });
    }
    if (!VALID_WIN_REASONS.has(ev.reason)) {
      errs.push({ path: `${path}.reason`, code: "invalid_reason", message: `Invalid win reason: '${ev.reason}'` });
    }
  }
  return errs;
}

/**
 * Helper to validate bounded pieces array within a CoreState.
 */
function validateStatePieces(pieces, basePath) {
  const errs = [];
  if (!Array.isArray(pieces)) {
    return [{ path: `${basePath}.pieces`, code: "invalid_pieces", message: "pieces must be an array" }];
  }

  if (pieces.length > 81) {
    errs.push({
      path: `${basePath}.pieces`,
      code: "piece_count_exceeded",
      message: `Piece count ${pieces.length} exceeds 81 pieces on 9x9 board`
    });
  }

  const seenIds = new Set();
  const seenCells = new Set();

  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const pPath = `${basePath}.pieces[${i}]`;
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      errs.push({ path: pPath, code: "invalid_piece", message: "Piece must be an object" });
      continue;
    }

    if (typeof p.id !== "string" || p.id.length === 0) {
      errs.push({ path: `${pPath}.id`, code: "invalid_piece_id", message: "Piece id must be a non-empty string" });
    } else {
      if (seenIds.has(p.id)) {
        errs.push({ path: `${pPath}.id`, code: "duplicate_piece_id", message: `Duplicate piece ID: ${p.id}` });
      }
      seenIds.add(p.id);
    }

    if (!VALID_SEATS.has(p.player)) {
      errs.push({ path: `${pPath}.player`, code: "invalid_piece_player", message: `Piece player must be 'A' or 'B', got '${p.player}'` });
    }

    if (!VALID_PIECE_TYPES.has(p.type)) {
      errs.push({ path: `${pPath}.type`, code: "invalid_piece_type", message: `Piece type must be 'dam', 'la', or 'keo', got '${p.type}'` });
    }

    const coordErrors = validatePosition(p, pPath, 9, 9);
    errs.push(...coordErrors);

    if (Number.isInteger(p.x) && Number.isInteger(p.y)) {
      const cellKey = `${p.x},${p.y}`;
      if (seenCells.has(cellKey)) {
        errs.push({
          path: pPath,
          code: "duplicate_cell_occupancy",
          message: `Multiple pieces found at cell (${p.x}, ${p.y})`
        });
      }
      seenCells.add(cellKey);
    }
  }
  return errs;
}

/**
 * Helper to validate full CoreState envelope (turn, winner, reason, eliminatedPlayer, clocks, runningSeat, pieces).
 */
function validateCoreStateEnvelope(state, path, { isTerminal = false, isInitial = false, isFinalAcceptedFrame = false, resultOutcome = null } = {}) {
  const errs = [];
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return [{ path, code: "invalid_core_state", message: "Core state must be a non-null object" }];
  }

  // 1. turn
  if (isTerminal) {
    if (state.turn !== null && !VALID_SEATS.has(state.turn)) {
      errs.push({ path: `${path}.turn`, code: "invalid_turn", message: `Terminal turn must be 'A', 'B', or null, got '${state.turn}'` });
    }
  } else {
    if (!VALID_SEATS.has(state.turn)) {
      errs.push({ path: `${path}.turn`, code: "invalid_turn", message: `Turn must be 'A' or 'B', got '${state.turn}'` });
    }
  }

  // 2. winner, reason, eliminatedPlayer
  if (isInitial || (!isTerminal && !isFinalAcceptedFrame)) {
    if (state.winner !== null) {
      errs.push({ path: `${path}.winner`, code: "non_terminal_winner", message: "Non-terminal core state must have null winner" });
    }
    if (state.reason !== null) {
      errs.push({ path: `${path}.reason`, code: "invalid_reason", message: "Non-terminal core state must have null reason" });
    }
    if (state.eliminatedPlayer !== null && state.eliminatedPlayer !== undefined) {
      errs.push({ path: `${path}.eliminatedPlayer`, code: "invalid_eliminated_player", message: "Non-terminal core state must have null eliminatedPlayer" });
    }
  } else if (isFinalAcceptedFrame) {
    if (resultOutcome === "draw" || resultOutcome === "forfeit") {
      if (state.winner !== null) {
        errs.push({ path: `${path}.winner`, code: "non_terminal_winner", message: `${resultOutcome} match last accepted frame must have null winner` });
      }
      if (state.reason !== null) {
        errs.push({ path: `${path}.reason`, code: "invalid_reason", message: `${resultOutcome} match last accepted frame must have null reason` });
      }
    } else {
      // win outcome: winner can be seat or null
      if (state.winner !== null && !VALID_SEATS.has(state.winner)) {
        errs.push({ path: `${path}.winner`, code: "invalid_seat", message: `Final frame winner must be 'A' or 'B'` });
      }
      if (state.winner !== null && state.reason !== null && !VALID_WIN_REASONS.has(state.reason)) {
        errs.push({ path: `${path}.reason`, code: "invalid_reason", message: `Final frame win reason must be in [${[...VALID_WIN_REASONS].join(", ")}]` });
      }
    }
  } else {
    // isTerminal
    if (state.winner !== null && !VALID_SEATS.has(state.winner)) {
      errs.push({ path: `${path}.winner`, code: "invalid_seat", message: `Terminal winner must be 'A', 'B', or null, got '${state.winner}'` });
    }
    if (state.winner === null) {
      if (state.reason !== null) {
        errs.push({ path: `${path}.reason`, code: "invalid_reason", message: "Terminal core state without winner must have null reason" });
      }
      if (state.eliminatedPlayer !== null && state.eliminatedPlayer !== undefined) {
        errs.push({ path: `${path}.eliminatedPlayer`, code: "invalid_eliminated_player", message: "Terminal core state without winner must have null eliminatedPlayer" });
      }
    } else {
      if (!VALID_WIN_REASONS.has(state.reason)) {
        errs.push({ path: `${path}.reason`, code: "invalid_reason", message: `Terminal core state winner reason must be in [${[...VALID_WIN_REASONS].join(", ")}], got '${state.reason}'` });
      }
    }
  }

  // 3. clock
  if (!state.clock || typeof state.clock !== "object" || Array.isArray(state.clock)) {
    errs.push({ path: `${path}.clock`, code: "invalid_clock", message: "Core state clock must be an object" });
  } else {
    if (!state.clock.remainingMs || typeof state.clock.remainingMs !== "object" || Array.isArray(state.clock.remainingMs)) {
      errs.push({ path: `${path}.clock.remainingMs`, code: "invalid_clock_remaining", message: "clock.remainingMs must be an object" });
    } else {
      const remA = state.clock.remainingMs.A;
      const remB = state.clock.remainingMs.B;
      if (typeof remA !== "number" || !Number.isFinite(remA) || remA < 0 || typeof remB !== "number" || !Number.isFinite(remB) || remB < 0) {
        errs.push({ path: `${path}.clock.remainingMs`, code: "invalid_clock_remaining", message: "clock.remainingMs values must be finite non-negative numbers" });
      }
    }

    if (isTerminal) {
      if (state.clock.runningSeat !== null && state.clock.runningSeat !== undefined) {
        errs.push({ path: `${path}.clock.runningSeat`, code: "terminal_clock_not_stopped", message: "Terminal core clock must be stopped (runningSeat null)" });
      }
    } else {
      if (state.clock.runningSeat !== null && state.clock.runningSeat !== undefined && !VALID_SEATS.has(state.clock.runningSeat)) {
        errs.push({ path: `${path}.clock.runningSeat`, code: "invalid_seat", message: `runningSeat must be 'A', 'B', or null, got '${state.clock.runningSeat}'` });
      }
    }
  }

  // 4. pieces
  errs.push(...validateStatePieces(state.pieces, path));
  return errs;
}

/**
 * Validates a ReplayDocument against schema, size budgets, and consistency invariants.
 * @param {unknown} doc
 * @param {{ maxBytes?: number }} [options]
 * @returns {import("./index.d.mts").ValidationResult}
 */
export function validateReplayDocument(doc, options = {}) {
  const errors = [];
  const maxBytes = options.maxBytes ?? (8 * 1024 * 1024); // 8 MiB budget

  // 1. Serialization check and byte size budget check (pure Web TextEncoder, no Buffer)
  let byteLength = 0;
  try {
    const serialized = typeof doc === "string" ? doc : JSON.stringify(doc);
    byteLength = new TextEncoder().encode(serialized).length;
  } catch (err) {
    return {
      ok: false,
      errors: [{ path: "document", code: "unserializable_document", message: `Replay document could not be serialized to JSON: ${err.message}` }]
    };
  }

  // Size failure early bound return
  if (byteLength > maxBytes) {
    return {
      ok: false,
      errors: [{
        path: "document",
        code: "document_size_exceeded",
        message: `Document size ${byteLength} bytes exceeds ${maxBytes} budget`
      }]
    };
  }

  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return {
      ok: false,
      errors: [{ path: "document", code: "invalid_type", message: "Replay document must be a non-null object" }]
    };
  }

  // 2. Schema version
  if (doc.schemaVersion !== 1) {
    errors.push({
      path: "document.schemaVersion",
      code: "invalid_schema_version",
      message: `Expected schemaVersion 1, received ${doc.schemaVersion}`
    });
  }

  // 3. String identifiers
  if (typeof doc.matchId !== "string" || doc.matchId.length === 0) {
    errors.push({ path: "document.matchId", code: "invalid_match_id", message: "Missing matchId" });
  }

  if (typeof doc.engineRevision !== "string" || doc.engineRevision.length === 0) {
    errors.push({ path: "document.engineRevision", code: "invalid_engine_revision", message: "Missing engineRevision" });
  }

  if (doc.engineGitRevision !== null && typeof doc.engineGitRevision !== "string") {
    errors.push({ path: "document.engineGitRevision", code: "invalid_engine_git_revision", message: "engineGitRevision must be string or null" });
  }

  if (typeof doc.rulesetId !== "string" || doc.rulesetId.length === 0) {
    errors.push({ path: "document.rulesetId", code: "invalid_ruleset_id", message: "Missing rulesetId" });
  }

  if (typeof doc.rulesetHash !== "string" || doc.rulesetHash.length === 0) {
    errors.push({ path: "document.rulesetHash", code: "invalid_ruleset_hash", message: "Missing rulesetHash" });
  }

  // 4. Ruleset snapshot validation
  const rulesetVal = validateRulesetSnapshot(doc.rulesetSnapshot);
  if (!rulesetVal.ok) {
    errors.push(...rulesetVal.errors);
  } else if (doc.rulesetSnapshot && doc.rulesetId !== doc.rulesetSnapshot.rulesetId) {
    errors.push({
      path: "document.rulesetId",
      code: "ruleset_id_mismatch",
      message: `Top-level rulesetId '${doc.rulesetId}' does not match rulesetSnapshot '${doc.rulesetSnapshot.rulesetId}'`
    });
  }

  // 5. Match policy validation
  const policyVal = validateMatchPolicy(doc.matchPolicy);
  if (!policyVal.ok) {
    errors.push(...policyVal.errors);
  }

  // 6. Participants validation
  if (!doc.participants || typeof doc.participants !== "object" || Array.isArray(doc.participants)) {
    errors.push({ path: "document.participants", code: "invalid_participants", message: "participants must be an object" });
  } else {
    for (const seat of ["A", "B"]) {
      const p = doc.participants[seat];
      if (!p || typeof p !== "object" || typeof p.botId !== "string" || p.botId.length === 0) {
        errors.push({
          path: `document.participants.${seat}`,
          code: "invalid_participant",
          message: `Participant ${seat} must have non-empty botId`
        });
      }
    }
  }

  // 7. Result validation
  const resultVal = validateArenaMatchResult(doc.result);
  if (!resultVal.ok) {
    errors.push(...resultVal.errors);
  }

  const acceptedPlies = doc.result?.acceptedPlies;
  const isAcceptedPliesValidInt = Number.isInteger(acceptedPlies) && acceptedPlies >= 0;

  // The cap comes from the (already validated) policy: 400 for arena-policy-v1, 300 for bot-cup-policy-v1.
  const maxPlies = policyVal.ok ? doc.matchPolicy.maxPlies : 400;
  if (isAcceptedPliesValidInt && acceptedPlies > maxPlies) {
    errors.push({
      path: "document.result.acceptedPlies",
      code: "accepted_plies_exceeded",
      message: `acceptedPlies ${acceptedPlies} exceeds maxPlies limit of ${maxPlies}`
    });
  }

  if (doc.result && doc.result.outcome === "draw") {
    if (acceptedPlies !== maxPlies) {
      errors.push({
        path: "document.result.acceptedPlies",
        code: "invalid_draw_plies",
        message: `Draw outcome under ${doc.matchPolicy?.matchPolicyVersion} requires acceptedPlies to reach ${maxPlies} cap, got ${acceptedPlies}`
      });
    }
  }

  // 8. InitialCoreState envelope validation
  errors.push(...validateCoreStateEnvelope(doc.initialCoreState, "document.initialCoreState", { isInitial: true }));

  // 9. Frames validation
  if (!Array.isArray(doc.frames)) {
    errors.push({ path: "document.frames", code: "invalid_frames", message: "frames must be an array" });
  } else {
    if (isAcceptedPliesValidInt && doc.frames.length !== acceptedPlies + 1) {
      errors.push({
        path: "document.frames",
        code: "frame_count_mismatch",
        message: `Frame count ${doc.frames.length} does not match acceptedPlies + 1 (${acceptedPlies + 1})`
      });
    }

    // Frame 0 checks
    if (doc.frames.length > 0) {
      const f0 = doc.frames[0];
      if (!f0 || typeof f0 !== "object" || Array.isArray(f0)) {
        errors.push({ path: "document.frames[0]", code: "invalid_frame", message: "Frame 0 must be an object" });
      } else {
        if (f0.ply !== 0) {
          errors.push({ path: "document.frames[0].ply", code: "invalid_frame_ply", message: `Frame 0 ply must be 0, got ${f0.ply}` });
        }
        if (f0.lastMove !== null) {
          errors.push({ path: "document.frames[0].lastMove", code: "invalid_frame_0_last_move", message: "Frame 0 lastMove must be null" });
        }

        errors.push(...validateCoreStateEnvelope(f0.coreState, "document.frames[0].coreState", { isInitial: true }));

        // Frame 0 canonical equivalence with initialCoreState
        if (f0.coreState && doc.initialCoreState && typeof f0.coreState === "object" && typeof doc.initialCoreState === "object") {
          if (canonicalSerialize(f0.coreState) !== canonicalSerialize(doc.initialCoreState)) {
            errors.push({
              path: "document.frames[0].coreState",
              code: "frame0_initial_state_mismatch",
              message: "Frame 0 coreState must canonically equal initialCoreState"
            });
          }
        }
      }
    }

    for (let k = 1; k < doc.frames.length; k++) {
      const frame = doc.frames[k];
      const fPath = `document.frames[${k}]`;
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
        errors.push({ path: fPath, code: "invalid_frame", message: `Frame at index ${k} must be an object` });
        continue;
      }

      if (frame.ply !== k) {
        errors.push({ path: `${fPath}.ply`, code: "invalid_frame_ply", message: `Frame at index ${k} must have ply ${k}, got ${frame.ply}` });
      }

      const isFinalAcceptedFrame = (k === acceptedPlies);
      errors.push(...validateCoreStateEnvelope(frame.coreState, `${fPath}.coreState`, {
        isFinalAcceptedFrame,
        resultOutcome: doc.result?.outcome
      }));

      const lm = frame.lastMove;
      if (!lm || typeof lm !== "object" || Array.isArray(lm)) {
        errors.push({ path: `${fPath}.lastMove`, code: "missing_last_move", message: `Frame ${k} must have a lastMove object` });
        continue;
      }

      if (lm.coreState !== undefined) {
        errors.push({
          path: `${fPath}.lastMove.coreState`,
          code: "forbidden_core_state_in_last_move",
          message: "lastMove must not contain coreState snapshot"
        });
      }

      if (typeof lm.pieceId !== "string" || lm.pieceId.length === 0) {
        errors.push({ path: `${fPath}.lastMove.pieceId`, code: "invalid_piece_id", message: "lastMove requires non-empty pieceId" });
      }

      if (!VALID_SEATS.has(lm.seat)) {
        errors.push({ path: `${fPath}.lastMove.seat`, code: "invalid_seat", message: `lastMove.seat must be 'A' or 'B'` });
      }

      errors.push(...validatePosition(lm.from, `${fPath}.lastMove.from`));
      errors.push(...validatePosition(lm.to, `${fPath}.lastMove.to`));

      if (lm.from && lm.to && Number.isInteger(lm.from.x) && Number.isInteger(lm.from.y) && Number.isInteger(lm.to.x) && Number.isInteger(lm.to.y)) {
        if (lm.from.x === lm.to.x && lm.from.y === lm.to.y) {
          errors.push({ path: `${fPath}.lastMove`, code: "zero_distance_move", message: "Move from and to positions cannot be identical" });
        } else if (Math.max(Math.abs(lm.to.x - lm.from.x), Math.abs(lm.to.y - lm.from.y)) !== 1) {
          errors.push({ path: `${fPath}.lastMove`, code: "invalid_move_distance", message: "Move distance must be exactly 1 step" });
        }
      }

      // Capture pair check
      const hasCapId = lm.capturedPieceId !== null && lm.capturedPieceId !== undefined;
      const hasCapType = lm.capturedPieceType !== null && lm.capturedPieceType !== undefined;
      if ((hasCapId && !hasCapType) || (!hasCapId && hasCapType) || (hasCapId && !VALID_PIECE_TYPES.has(lm.capturedPieceType))) {
        errors.push({
          path: `${fPath}.lastMove`,
          code: "invalid_capture_pair",
          message: "capturedPieceId and capturedPieceType must both be set with valid type or both null"
        });
      }

      if (typeof lm.elapsedMs !== "number" || !Number.isFinite(lm.elapsedMs) || lm.elapsedMs < 0) {
        errors.push({ path: `${fPath}.lastMove.elapsedMs`, code: "invalid_elapsed_ms", message: "elapsedMs must be a finite non-negative number" });
      }
      if (typeof lm.remainingMs !== "number" || !Number.isFinite(lm.remainingMs) || lm.remainingMs < 0) {
        errors.push({ path: `${fPath}.lastMove.remainingMs`, code: "invalid_remaining_ms", message: "remainingMs must be a finite non-negative number" });
      }

      if (lm.comment !== undefined) {
        if (typeof lm.comment !== "string") {
          errors.push({ path: `${fPath}.lastMove.comment`, code: "invalid_comment", message: "Comment must be a string" });
        } else if (lm.comment.length > 2048) {
          errors.push({ path: `${fPath}.lastMove.comment`, code: "comment_too_long", message: `Comment exceeds 2048 characters cap` });
        }
      }

      // Events schema validation
      if (!Array.isArray(lm.events)) {
        errors.push({ path: `${fPath}.lastMove.events`, code: "invalid_core_event", message: "lastMove.events must be an array" });
      } else {
        for (let ei = 0; ei < lm.events.length; ei++) {
          errors.push(...validateCoreEvent(lm.events[ei], `${fPath}.lastMove.events[${ei}]`));
        }
      }

      // Snapshot piece identity cross-check between frames[k - 1] and frames[k]
      const prevFrame = doc.frames[k - 1];
      if (
        prevFrame &&
        prevFrame.coreState &&
        Array.isArray(prevFrame.coreState.pieces) &&
        frame.coreState &&
        Array.isArray(frame.coreState.pieces) &&
        lm.from &&
        lm.to
      ) {
        const prevPieces = prevFrame.coreState.pieces;
        const currPieces = frame.coreState.pieces;

        const prevPiece = prevPieces.find((p) => p && p.id === lm.pieceId);
        if (!prevPiece) {
          errors.push({
            path: `${fPath}.lastMove.pieceId`,
            code: "moved_piece_not_found_in_previous_frame",
            message: `Moved piece ${lm.pieceId} not found in previous frame`
          });
        } else {
          if (prevPiece.x !== lm.from.x || prevPiece.y !== lm.from.y) {
            errors.push({
              path: `${fPath}.lastMove.from`,
              code: "moved_piece_position_mismatch",
              message: `Moved piece ${lm.pieceId} in previous frame was at (${prevPiece.x}, ${prevPiece.y}), not from (${lm.from.x}, ${lm.from.y})`
            });
          }
          if (prevPiece.player !== lm.seat) {
            errors.push({
              path: `${fPath}.lastMove.seat`,
              code: "moved_piece_owner_mismatch",
              message: `Moved piece belongs to ${prevPiece.player}, but lastMove acting seat is ${lm.seat}`
            });
          }
        }

        const currPiece = currPieces.find((p) => p && p.id === lm.pieceId);
        if (!currPiece) {
          errors.push({
            path: `${fPath}.lastMove.pieceId`,
            code: "moved_piece_missing_in_current_frame",
            message: `Moved piece ${lm.pieceId} is missing in current frame`
          });
        } else if (currPiece.x !== lm.to.x || currPiece.y !== lm.to.y) {
          errors.push({
            path: `${fPath}.lastMove.to`,
            code: "moved_piece_destination_mismatch",
            message: `Moved piece ${lm.pieceId} in current frame is at (${currPiece.x}, ${currPiece.y}), not to (${lm.to.x}, ${lm.to.y})`
          });
        }

        if (hasCapId) {
          const prevCap = prevPieces.find((p) => p && p.id === lm.capturedPieceId);
          if (!prevCap) {
            errors.push({
              path: `${fPath}.lastMove.capturedPieceId`,
              code: "captured_piece_not_in_previous_frame",
              message: `Captured piece ${lm.capturedPieceId} not found in previous frame`
            });
          } else if (prevCap.x !== lm.to.x || prevCap.y !== lm.to.y) {
            errors.push({
              path: `${fPath}.lastMove.capturedPieceId`,
              code: "captured_piece_not_at_destination",
              message: `Captured piece ${lm.capturedPieceId} in previous frame was at (${prevCap.x}, ${prevCap.y}), not destination (${lm.to.x}, ${lm.to.y})`
            });
          }

          const currCap = currPieces.find((p) => p && p.id === lm.capturedPieceId);
          if (currCap) {
            errors.push({
              path: `${fPath}.lastMove.capturedPieceId`,
              code: "captured_piece_remains_in_current_frame",
              message: `Captured piece ${lm.capturedPieceId} still present in current frame`
            });
          }

          if (currPieces.length !== prevPieces.length - 1) {
            errors.push({
              path: `${fPath}`,
              code: "piece_count_mismatch_after_capture",
              message: `Piece count in current frame ${currPieces.length} must be previous ${prevPieces.length} minus 1`
            });
          }
        } else {
          const prevAtTo = prevPieces.find((p) => p && p.x === lm.to.x && p.y === lm.to.y);
          if (prevAtTo) {
            errors.push({
              path: `${fPath}.lastMove.to`,
              code: "non_capture_onto_occupied_cell",
              message: `Non-capture move lands on occupied cell (${lm.to.x}, ${lm.to.y})`
            });
          }

          if (currPieces.length !== prevPieces.length) {
            errors.push({
              path: `${fPath}`,
              code: "piece_count_mismatch_non_capture",
              message: `Piece count in non-capture move changed from ${prevPieces.length} to ${currPieces.length}`
            });
          }
        }

        // Unmoved pieces must remain identical
        for (let pi = 0; pi < prevPieces.length; pi++) {
          const pp = prevPieces[pi];
          if (!pp || pp.id === lm.pieceId || pp.id === lm.capturedPieceId) continue;
          const cp = currPieces.find((p) => p && p.id === pp.id);
          if (!cp || cp.x !== pp.x || cp.y !== pp.y || cp.player !== pp.player || cp.type !== pp.type) {
            errors.push({
              path: `${fPath}`,
              code: "unrelated_piece_mutated",
              message: `Unrelated piece ${pp.id} was mutated between frame ${k - 1} and ${k}`
            });
            break;
          }
        }
      }
    }
  }

  // 10. Events validation
  if (!Array.isArray(doc.events)) {
    errors.push({ path: "document.events", code: "invalid_events", message: "events must be an array" });
  } else {
    if (doc.events.length === 0) {
      errors.push({ path: "document.events", code: "empty_events", message: "events must not be empty" });
    } else {
      if (doc.events.length > 2000) {
        errors.push({
          path: "document.events",
          code: "event_count_exceeded",
          message: `Event count ${doc.events.length} exceeds 2000 limit`
        });
      }

      // Event 0 guard and check
      const ev0 = doc.events[0];
      if (!ev0 || typeof ev0 !== "object" || Array.isArray(ev0)) {
        errors.push({ path: "document.events[0]", code: "invalid_event", message: "Event 0 must be an object" });
      } else {
        if (ev0.type !== "init") {
          errors.push({ path: "document.events[0].type", code: "invalid_first_event", message: "First event must be 'init'" });
        }
        if (ev0.seq !== 0) {
          errors.push({ path: "document.events[0].seq", code: "invalid_event_sequence", message: `First event seq must be 0, got ${ev0.seq}` });
        }
        if (ev0.ply !== 0) {
          errors.push({ path: "document.events[0].ply", code: "invalid_event_ply", message: `First event ply must be 0, got ${ev0.ply}` });
        }
      }

      // Terminal event guard and check
      const lastEv = doc.events[doc.events.length - 1];
      if (!lastEv || typeof lastEv !== "object" || Array.isArray(lastEv)) {
        errors.push({ path: `document.events[${doc.events.length - 1}]`, code: "invalid_event", message: "Last event must be an object" });
      } else if (lastEv.type !== "terminal") {
        errors.push({
          path: `document.events[${doc.events.length - 1}].type`,
          code: "invalid_last_event",
          message: "Last event must be 'terminal'"
        });
      }

      let terminalCount = 0;
      for (let i = 0; i < doc.events.length; i++) {
        if (doc.events[i] && doc.events[i].type === "terminal") {
          terminalCount++;
        }
      }
      if (terminalCount !== 1) {
        errors.push({
          path: "document.events",
          code: "invalid_terminal_event_count",
          message: `Expected exactly 1 terminal event, got ${terminalCount}`
        });
      }

      const ALLOWED_EVENT_TYPES = new Set(["init", "move", "capture", "technical", "terminal"]);
      let prevPly = 0;

      for (let i = 0; i < doc.events.length; i++) {
        const ev = doc.events[i];
        const evPath = `document.events[${i}]`;
        if (!ev || typeof ev !== "object" || Array.isArray(ev)) {
          errors.push({ path: evPath, code: "invalid_event", message: "Event must be an object" });
          continue;
        }

        if (ev.seq !== i) {
          errors.push({
            path: `${evPath}.seq`,
            code: "invalid_event_sequence",
            message: `Event at index ${i} must have contiguous seq ${i}, got ${ev.seq}`
          });
        }

        if (!ALLOWED_EVENT_TYPES.has(ev.type)) {
          errors.push({
            path: `${evPath}.type`,
            code: "invalid_event_type",
            message: `Invalid event type '${ev.type}'; allowed: [${[...ALLOWED_EVENT_TYPES].join(", ")}]`
          });
        }

        if (!Number.isInteger(ev.ply) || ev.ply < 0) {
          errors.push({ path: `${evPath}.ply`, code: "invalid_event_ply", message: "Event ply must be non-negative integer" });
        } else {
          if (ev.ply < prevPly) {
            errors.push({ path: `${evPath}.ply`, code: "non_monotonic_event_ply", message: `Event ply ${ev.ply} cannot decrease from ${prevPly}` });
          }
          prevPly = ev.ply;

          if (isAcceptedPliesValidInt && ev.ply > acceptedPlies) {
            errors.push({ path: `${evPath}.ply`, code: "event_ply_exceeded", message: `Event ply ${ev.ply} exceeds acceptedPlies ${acceptedPlies}` });
          }
        }
      }

      // Ply event distribution: exactly 1 move event each ply 1..acceptedPlies, matching lastMove record
      if (isAcceptedPliesValidInt && Array.isArray(doc.frames)) {
        for (let p = 1; p <= acceptedPlies; p++) {
          const lastMove = doc.frames[p]?.lastMove;
          const moveEvents = doc.events.filter((e) => e && e.ply === p && e.type === "move");
          if (moveEvents.length !== 1) {
            errors.push({
              path: "document.events",
              code: "move_event_count_mismatch",
              message: `Expected exactly 1 move event at ply ${p}, got ${moveEvents.length}`
            });
          } else if (lastMove) {
            const mp = moveEvents[0].payload;
            if (
              !mp ||
              typeof mp !== "object" ||
              mp.seat !== lastMove.seat ||
              mp.pieceId !== lastMove.pieceId ||
              mp.from?.x !== lastMove.from?.x ||
              mp.from?.y !== lastMove.from?.y ||
              mp.to?.x !== lastMove.to?.x ||
              mp.to?.y !== lastMove.to?.y ||
              mp.elapsedMs !== lastMove.elapsedMs ||
              mp.remainingMs !== lastMove.remainingMs
            ) {
              errors.push({
                path: `document.events[${moveEvents[0].seq}].payload`,
                code: "move_payload_mismatch",
                message: `Move event payload at ply ${p} does not match frame ${p} lastMove`
              });
            }
          }

          const capEvents = doc.events.filter((e) => e && e.ply === p && e.type === "capture");
          if (lastMove && lastMove.capturedPieceId !== null && lastMove.capturedPieceId !== undefined) {
            if (capEvents.length !== 1) {
              errors.push({
                path: "document.events",
                code: "capture_event_count_mismatch",
                message: `Expected exactly 1 capture event at ply ${p}, got ${capEvents.length}`
              });
            } else {
              const cp = capEvents[0].payload;
              if (
                !cp ||
                typeof cp !== "object" ||
                cp.pieceId !== lastMove.pieceId ||
                cp.capturedPieceId !== lastMove.capturedPieceId ||
                cp.capturedPieceType !== lastMove.capturedPieceType ||
                cp.from?.x !== lastMove.from?.x ||
                cp.from?.y !== lastMove.from?.y ||
                cp.to?.x !== lastMove.to?.x ||
                cp.to?.y !== lastMove.to?.y
              ) {
                errors.push({
                  path: `document.events[${capEvents[0].seq}].payload`,
                  code: "capture_payload_mismatch",
                  message: `Capture event payload at ply ${p} does not match frame ${p} lastMove`
                });
              }
            }
          } else {
            if (capEvents.length > 0) {
              errors.push({
                path: "document.events",
                code: "unexpected_capture_event",
                message: `Unexpected capture event at non-capture ply ${p}`
              });
            }
          }
        }
      }
    }
  }

  // 11. TerminalCoreState & Result consistency
  errors.push(...validateCoreStateEnvelope(doc.terminalCoreState, "document.terminalCoreState", { isTerminal: true }));

  if (doc.result && doc.terminalCoreState && typeof doc.terminalCoreState === "object") {
    if (doc.result.outcome === "win") {
      if (doc.terminalCoreState.winner !== doc.result.winner || doc.terminalCoreState.reason !== doc.result.reason) {
        errors.push({
          path: "document.terminalCoreState",
          code: "result_terminal_mismatch",
          message: `terminalCoreState (${doc.terminalCoreState.winner}, ${doc.terminalCoreState.reason}) does not match result (${doc.result.winner}, ${doc.result.reason})`
        });
      }
      if (doc.result.reason === "elimination" && doc.terminalCoreState.eliminatedPlayer !== doc.result.loser) {
        errors.push({
          path: "document.terminalCoreState",
          code: "result_terminal_mismatch",
          message: `terminalCoreState.eliminatedPlayer '${doc.terminalCoreState.eliminatedPlayer}' must match elimination loser '${doc.result.loser}'`
        });
      }
    } else if (doc.result.outcome === "draw" || doc.result.outcome === "forfeit") {
      if (
        doc.terminalCoreState.winner !== null ||
        doc.terminalCoreState.reason !== null ||
        (doc.terminalCoreState.eliminatedPlayer !== null && doc.terminalCoreState.eliminatedPlayer !== undefined)
      ) {
        errors.push({
          path: "document.terminalCoreState",
          code: "result_terminal_mismatch",
          message: `${doc.result.outcome} outcome requires terminalCoreState winner, reason, and eliminatedPlayer to be null`
        });
      }
    }

    // Terminal piece position equality with last accepted frame
    if (Array.isArray(doc.frames) && isAcceptedPliesValidInt && doc.frames[acceptedPlies]?.coreState) {
      const lastPieces = doc.frames[acceptedPlies].coreState.pieces;
      if (canonicalSerialize(doc.terminalCoreState.pieces) !== canonicalSerialize(lastPieces)) {
        errors.push({
          path: "document.terminalCoreState.pieces",
          code: "terminal_position_mismatch",
          message: "Terminal piece positions must match the last accepted frame"
        });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validates a MatchCompletionEnvelope before finalization.
 * Ensures matchId, attemptNo, leaseToken, result, replay, and digests are valid.
 *
 * @param {unknown} envelope
 * @returns {import("./index.d.mts").ValidationResult}
 */
export function validateMatchCompletionEnvelope(envelope) {
  const errors = [];
  if (!envelope || typeof envelope !== "object") {
    return {
      ok: false,
      errors: [{ path: "envelope", code: "invalid_type", message: "Envelope must be a non-null object" }]
    };
  }

  if (typeof envelope.matchId !== "string" || envelope.matchId.trim().length === 0) {
    errors.push({ path: "envelope.matchId", code: "invalid_match_id", message: "matchId must be a non-empty string" });
  }

  if (!Number.isInteger(envelope.attemptNo) || envelope.attemptNo < 1) {
    errors.push({ path: "envelope.attemptNo", code: "invalid_attempt_no", message: "attemptNo must be an integer >= 1" });
  }

  if (typeof envelope.leaseToken !== "string" || envelope.leaseToken.trim().length === 0) {
    errors.push({ path: "envelope.leaseToken", code: "invalid_lease_token", message: "leaseToken must be a non-empty string" });
  }

  if (typeof envelope.replayDigest !== "string" || !envelope.replayDigest.startsWith("sha256:")) {
    errors.push({ path: "envelope.replayDigest", code: "invalid_replay_digest", message: "replayDigest must be a string starting with 'sha256:'" });
  }

  if (typeof envelope.completionDigest !== "string" || !envelope.completionDigest.startsWith("sha256:")) {
    errors.push({ path: "envelope.completionDigest", code: "invalid_completion_digest", message: "completionDigest must be a string starting with 'sha256:'" });
  }

  if (!envelope.result || typeof envelope.result !== "object") {
    errors.push({ path: "envelope.result", code: "missing_result", message: "result must be an object" });
  } else {
    const resVal = validateArenaMatchResult(envelope.result);
    if (!resVal.ok) {
      errors.push(...resVal.errors.map(e => ({ ...e, path: `envelope.${e.path}` })));
    }
  }

  if (!envelope.replay || typeof envelope.replay !== "object") {
    errors.push({ path: "envelope.replay", code: "missing_replay", message: "replay must be a ReplayDocument object" });
  } else {
    const repVal = validateReplayDocument(envelope.replay);
    if (!repVal.ok) {
      errors.push(...repVal.errors.map(e => ({ ...e, path: `envelope.${e.path}` })));
    }

    if (envelope.matchId && envelope.replay.matchId && envelope.matchId !== envelope.replay.matchId) {
      errors.push({
        path: "envelope.matchId",
        code: "match_id_mismatch",
        message: `envelope.matchId '${envelope.matchId}' does not match replay.matchId '${envelope.replay.matchId}'`
      });
    }

    if (
      envelope.result &&
      envelope.replay.result &&
      envelope.result.outcome !== envelope.replay.result.outcome
    ) {
      errors.push({
        path: "envelope.result.outcome",
        code: "outcome_mismatch",
        message: `envelope.result outcome '${envelope.result.outcome}' does not match replay.result outcome '${envelope.replay.result.outcome}'`
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

