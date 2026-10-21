import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Default core modules required from packages/game-core
const coreRulesPath = resolve(__dirname, "../../../../packages/game-core/src/rules.js");
const coreConfigPath = resolve(__dirname, "../../../../packages/game-core/src/config.js");

const defaultRules = require(coreRulesPath);
const defaultConfig = require(coreConfigPath);

/**
 * Creates an EnginePort adapter backed by Node game-core rules.js and config.js.
 * @param {object} [options]
 * @param {object} [options.rules] - Custom rules module
 * @param {object} [options.config] - Custom config module
 * @returns {import("../../arena/src/ports/index.d.mts").EnginePort}
 */
export function createNodeEngine({ rules = defaultRules, config = defaultConfig } = {}) {
  return {
    createInitialState() {
      return rules.createInitialState();
    },

    cloneState(state) {
      return rules.cloneState(state);
    },

    allMoves(state, seat) {
      return rules.allMoves(state, seat);
    },

    applyMove(state, seat, from, to) {
      return rules.applyMove(state, seat, from, to);
    },

    detectWinner(state) {
      const result = rules.detectWinner(state);
      if (!result) {
        return {
          winner: null,
          reason: null,
          eliminatedPlayer: null
        };
      }
      return {
        winner: result.winner,
        reason: result.reason,
        eliminatedPlayer: result.eliminatedPlayer || null
      };
    }
  };
}

export { defaultRules as coreRules, defaultConfig as coreConfig };
