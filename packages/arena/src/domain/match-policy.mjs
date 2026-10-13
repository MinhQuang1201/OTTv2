import { canonicalSerialize } from "./ruleset.mjs";

export const MATCH_POLICY_VERSION = "arena-policy-v1";

export const DEFAULT_MATCH_POLICY = Object.freeze({
  matchPolicyVersion: MATCH_POLICY_VERSION,
  maxPlies: 400,
  initialTimeMs: 600000,
  turnTimeLimitMs: 1000,
  clockBoundary: "strict_less_than_budget",
  clockSource: "referee_monotonic"
});

/**
 * Pure helper to serialize match policy into canonical JSON string.
 */
export function canonicalMatchPolicyJson(policy) {
  return canonicalSerialize(policy);
}


export function validateMatchPolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== "object") {
    return {
      ok: false,
      errors: [{ path: "policy", code: "invalid_type", message: "Policy must be a non-null object" }]
    };
  }
  if (policy.matchPolicyVersion !== MATCH_POLICY_VERSION) {
    errors.push({
      path: "policy.matchPolicyVersion",
      code: "unsupported_policy_version",
      message: `Unsupported matchPolicyVersion: ${policy.matchPolicyVersion}`
    });
  }
  // arena-policy-v1 strictly requires exact maxPlies of 400.
  // Custom unsupported caps require a different future policy version, not silently same version.
  if (policy.matchPolicyVersion === MATCH_POLICY_VERSION) {
    if (policy.maxPlies !== 400) {
      errors.push({
        path: "policy.maxPlies",
        code: "unsupported_max_plies",
        message: `arena-policy-v1 requires exact maxPlies of 400, received ${policy.maxPlies}`
      });
    }
  } else if (!Number.isInteger(policy.maxPlies) || policy.maxPlies <= 0) {
    errors.push({
      path: "policy.maxPlies",
      code: "invalid_max_plies",
      message: "maxPlies must be a positive integer"
    });
  }

  if (!Number.isInteger(policy.initialTimeMs) || policy.initialTimeMs <= 0) {
    errors.push({
      path: "policy.initialTimeMs",
      code: "invalid_initial_time",
      message: "initialTimeMs must be a positive integer"
    });
  }
  if (!Number.isInteger(policy.turnTimeLimitMs) || policy.turnTimeLimitMs <= 0) {
    errors.push({
      path: "policy.turnTimeLimitMs",
      code: "invalid_turn_time_limit",
      message: "turnTimeLimitMs must be a positive integer"
    });
  }
  if (policy.clockBoundary !== "strict_less_than_budget") {
    errors.push({
      path: "policy.clockBoundary",
      code: "invalid_clock_boundary",
      message: "clockBoundary must be strict_less_than_budget"
    });
  }
  if (policy.clockSource !== "referee_monotonic") {
    errors.push({
      path: "policy.clockSource",
      code: "invalid_clock_source",
      message: "clockSource must be referee_monotonic"
    });
  }
  return { ok: errors.length === 0, errors };
}
