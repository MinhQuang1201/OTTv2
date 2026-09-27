import "../../../../../packages/game-core/src/config.js";
import "../../../../../packages/game-core/src/rules.js";
import "../../../../../packages/game-core/src/ai.js";

import type { Position, Seat, PieceType } from "../../shared/model/game";

export type CoreState = OttCoreState;
export type CoreEvent = OttCoreEvent;
export type CoreMoveResult = OttCoreMoveResult;

export interface GameCoreBridge {
  readonly config: OttCoreConfig;
  readonly rules: OttCoreRules;
  readonly ai: OttCoreAi;
  createInitialState(): CoreState;
  getLegalMoves(state: CoreState, pieceId: string): readonly Position[];
  applyMove(state: CoreState, player: Seat, from: Position, to: Position): CoreMoveResult;
  elapseClock(state: CoreState, elapsedMs: number): CoreMoveResult;
  countByType(state: CoreState, player: Seat): Readonly<Record<PieceType, number>>;
}

export class GameCoreUnavailableError extends Error {
  readonly code = "session_failed" as const;
  readonly retryable = false;

  constructor() {
    super("Không thể khởi tạo luật chơi.");
    this.name = "GameCoreUnavailableError";
  }
}

function requireGlobals(): { config: OttCoreConfig; rules: OttCoreRules; ai: OttCoreAi } {
  const config = globalThis.OTT_CONFIG;
  const rules = globalThis.OTT_RULES;
  const ai = globalThis.OTT_AI;
  if (!config || !rules || !ai || typeof rules.createInitialState !== "function" || typeof rules.applyMove !== "function" || typeof rules.elapseClock !== "function" || typeof rules.getLegalMoves !== "function" || typeof rules.countByType !== "function") {
    throw new GameCoreUnavailableError();
  }
  return { config, rules, ai };
}

export function getGameCoreBridge(): GameCoreBridge {
  const globals = requireGlobals();
  return {
    ...globals,
    createInitialState: () => globals.rules.createInitialState(),
    getLegalMoves: (state, pieceId) => globals.rules.getLegalMoves(state, pieceId).map((move) => ({ x: move.x, y: move.y })),
    applyMove: (state, player, from, to) => globals.rules.applyMove(state, player, from, to),
    elapseClock: (state, elapsedMs) => globals.rules.elapseClock(state, elapsedMs),
    countByType: (state, player) => globals.rules.countByType(state, player),
  };
}

export const gameCoreBridge = getGameCoreBridge;
