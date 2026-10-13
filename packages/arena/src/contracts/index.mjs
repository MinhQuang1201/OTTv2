import {
  validatePosition,
  validateBotTurn,
  validateBotAction,
  validateArenaMatchResult,
  validateMatchPolicy,
  validateRulesetSnapshot,
  isSupportedEngineRuleset,
  validateReplayDocument
} from "./validation.mjs";

import { DEFAULT_MATCH_POLICY, MATCH_POLICY_VERSION, canonicalMatchPolicyJson } from "../domain/match-policy.mjs";
import {
  RULESET_ID_G_V1,
  canonicalize,
  canonicalSerialize,
  canonicalRulesetJson,
  createCurrentRulesetSnapshot
} from "../domain/ruleset.mjs";

export const PROTOCOL_VERSION = 1;
export const MAX_STDOUT_LINE_BYTES = 64 * 1024;
export const MAX_STDOUT_TOTAL_BYTES = 1024 * 1024;
export const MAX_STDERR_TOTAL_BYTES = 256 * 1024;
export const MAX_COMMENT_LENGTH = 2048;

export const SEATS = Object.freeze(["A", "B"]);
export const PIECE_TYPES = Object.freeze(["dam", "la", "keo"]);

export const WIN_REASONS = Object.freeze(["goal", "elimination", "no_moves"]);
export const DRAW_REASONS = Object.freeze(["max_plies"]);
export const FORFEIT_REASONS = Object.freeze([
  "turn_timeout",
  "total_timeout",
  "crash",
  "protocol_error",
  "illegal_move",
  "output_limit"
]);

export function generateTurnRequestId(matchId, seat, ply) {
  return `${matchId}:${seat}:${ply}`;
}

export function createWinResult({ winner, loser, reason, acceptedPlies }) {
  const result = { outcome: "win", winner, loser, reason, acceptedPlies };
  const validation = validateArenaMatchResult(result);
  if (!validation.ok) {
    throw new Error(`Invalid ArenaWinResult: ${JSON.stringify(validation.errors)}`);
  }
  return result;
}

export function createDrawResult({ acceptedPlies }) {
  const result = { outcome: "draw", winner: null, loser: null, reason: "max_plies", acceptedPlies };
  const validation = validateArenaMatchResult(result);
  if (!validation.ok) {
    throw new Error(`Invalid ArenaDrawResult: ${JSON.stringify(validation.errors)}`);
  }
  return result;
}

export function createForfeitResult({ winner, loser, reason, acceptedPlies }) {
  const result = { outcome: "forfeit", winner, loser, reason, acceptedPlies };
  const validation = validateArenaMatchResult(result);
  if (!validation.ok) {
    throw new Error(`Invalid ArenaForfeitResult: ${JSON.stringify(validation.errors)}`);
  }
  return result;
}

export function createInfrastructureError({ code, retryable }) {
  return {
    kind: "infrastructure_error",
    code: String(code),
    retryable: Boolean(retryable)
  };
}

export {
  // Validators
  validatePosition,
  validateBotTurn,
  validateBotAction,
  validateArenaMatchResult,
  validateMatchPolicy,
  validateRulesetSnapshot,
  isSupportedEngineRuleset,
  validateReplayDocument,
  // Policy
  DEFAULT_MATCH_POLICY,
  MATCH_POLICY_VERSION,
  canonicalMatchPolicyJson,
  // Ruleset
  RULESET_ID_G_V1,
  canonicalize,
  canonicalSerialize,
  canonicalRulesetJson,
  createCurrentRulesetSnapshot
};
