import type { RulesetSnapshot, ValidationResult } from "../contracts/index.d.mts";

export declare const RULESET_ID_G_V1: "ottv2-g-default-v1";

export declare function canonicalize(val: unknown): unknown;
export declare function canonicalSerialize(val: unknown): string;
export declare function createCurrentRulesetSnapshot(config: unknown): RulesetSnapshot;
export declare function canonicalRulesetJson(snapshot: RulesetSnapshot): string;
export declare function validateRulesetSnapshot(snapshot: unknown): ValidationResult;
export declare function isSupportedEngineRuleset(snapshot: unknown): boolean;
