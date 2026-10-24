import type { MatchPolicy, ValidationResult } from "../contracts/index.d.mts";

export declare const MATCH_POLICY_VERSION: "arena-policy-v1";
export declare const DEFAULT_MATCH_POLICY: Readonly<MatchPolicy>;

export declare function canonicalMatchPolicyJson(policy: unknown): string;
export declare function validateMatchPolicy(policy: unknown): ValidationResult;

export declare const BOT_CUP_POLICY_VERSION: "bot-cup-policy-v1";
export declare const BOT_CUP_MATCH_POLICY: Readonly<{
  matchPolicyVersion: "bot-cup-policy-v1";
  maxPlies: 300;
  initialTimeMs: 30000;
  turnTimeLimitMs: 500;
  firstMoveGraceMs: 5000;
  clockBoundary: "strict_less_than_budget";
  clockSource: "referee_monotonic";
}>;
