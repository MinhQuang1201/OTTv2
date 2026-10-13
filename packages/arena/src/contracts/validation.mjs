import { validateMatchPolicy } from "../domain/match-policy.mjs";
import { validateRulesetSnapshot, isSupportedEngineRuleset } from "../domain/ruleset.mjs";

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
