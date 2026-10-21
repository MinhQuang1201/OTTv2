import "../../../../../packages/game-core/src/config.js";
import "../../../../../packages/game-core/src/rules.js";
import "../../../../../packages/game-core/src/ai.js";

interface Request {
  readonly id: number;
  readonly state: OttCoreState;
  readonly player: "A" | "B";
  readonly level: "easy" | "medium" | "hard";
}

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = (event) => {
  const { id, state, player, level } = event.data;
  try {
    const move = globalThis.OTT_AI?.chooseMove(state, player, { level }) ?? null;
    scope.postMessage({ id, move });
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : "ai_failed" });
  }
};
