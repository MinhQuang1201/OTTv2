import type { MatchPolicy, ValidationResult } from "../contracts/index.d.mts";

export declare const MATCH_POLICY_VERSION: "arena-policy-v1";
export declare const DEFAULT_MATCH_POLICY: Readonly<MatchPolicy>;

export declare function canonicalMatchPolicyJson(policy: unknown): string;
export declare function validateMatchPolicy(policy: unknown): ValidationResult;
