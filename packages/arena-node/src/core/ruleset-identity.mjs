import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { canonicalRulesetJson, canonicalSerialize } from "../../../arena/src/domain/ruleset.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Computes SHA-256 hash of the canonical JSON string of a ruleset snapshot.
 * Returns formatted hash string with "sha256:" prefix.
 */
export function computeRulesetHash(snapshot) {
  const canonicalJson = canonicalRulesetJson(snapshot);
  const hash = createHash("sha256").update(canonicalJson, "utf8").digest("hex");
  return `sha256:${hash}`;
}

/**
 * Computes SHA-256 hash of the canonical JSON string of a match policy.
 * Returns formatted hash string with "sha256:" prefix.
 */
export function computeMatchPolicyHash(policy) {
  const canonicalJson = canonicalSerialize(policy);
  const hash = createHash("sha256").update(canonicalJson, "utf8").digest("hex");
  return `sha256:${hash}`;
}

/**
 * Computes raw engine fingerprint from raw config and rules content.
 * Returns formatted fingerprint with "sha256:" prefix.
 */
export function computeEngineFingerprint(rawConfigContent, rawRulesContent) {
  const hash = createHash("sha256")
    .update(rawConfigContent, "utf8")
    .update("\n---\n")
    .update(rawRulesContent, "utf8")
    .digest("hex");
  return `sha256:${hash}`;
}

/**
 * Resolves default paths to packages/game-core config.js and rules.js.
 */
export function getDefaultCorePaths() {
  const repoRoot = resolve(__dirname, "../../../../");
  return {
    configPath: resolve(repoRoot, "packages/game-core/src/config.js"),
    rulesPath: resolve(repoRoot, "packages/game-core/src/rules.js")
  };
}

/**
 * Computes current core engine fingerprint by reading packages/game-core files.
 */
export function computeCurrentEngineFingerprint(customPaths = {}) {
  const defaults = getDefaultCorePaths();
  const configPath = customPaths.configPath || defaults.configPath;
  const rulesPath = customPaths.rulesPath || defaults.rulesPath;

  const rawConfig = readFileSync(configPath, "utf8");
  const rawRules = readFileSync(rulesPath, "utf8");

  return computeEngineFingerprint(rawConfig, rawRules);
}

/**
 * Verifies if a given ruleset snapshot matches an expected hash.
 */
export function verifyRulesetHash(snapshot, expectedHash) {
  return computeRulesetHash(snapshot) === expectedHash;
}

/**
 * Verifies if a given match policy matches an expected hash.
 */
export function verifyMatchPolicyHash(policy, expectedHash) {
  return computeMatchPolicyHash(policy) === expectedHash;
}
