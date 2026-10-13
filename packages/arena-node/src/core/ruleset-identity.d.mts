import type { RulesetSnapshot, MatchPolicy } from "../../../arena/src/contracts/index.d.mts";

export declare function computeRulesetHash(snapshot: RulesetSnapshot): string;
export declare function computeMatchPolicyHash(policy: MatchPolicy): string;
export declare function computeEngineFingerprint(rawConfigContent: string, rawRulesContent: string): string;
export declare function getDefaultCorePaths(): { configPath: string; rulesPath: string };
export declare function computeCurrentEngineFingerprint(customPaths?: { configPath?: string; rulesPath?: string }): string;
export declare function verifyRulesetHash(snapshot: RulesetSnapshot, expectedHash: string): boolean;
export declare function verifyMatchPolicyHash(policy: MatchPolicy, expectedHash: string): boolean;
