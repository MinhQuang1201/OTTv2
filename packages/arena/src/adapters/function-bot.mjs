/**
 * Pure FunctionBot adapter for Arena AI protocol v1.
 * Wraps synchronous or asynchronous chooseMove function into BotPort.
 * No Node.js imports. Pure JS / standard Web API.
 */

function cloneDeep(val) {
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(cloneDeep);
  const copy = {};
  for (const k of Object.keys(val)) {
    copy[k] = cloneDeep(val[k]);
  }
  return copy;
}

/**
 * Creates a BotPort adapter backed by an in-memory decision function.
 * @param {object} options
 * @param {string} options.botId - unique bot identifier
 * @param {function} options.chooseFn - (turn: BotTurn, signal: AbortSignal) => BotAction | WireMove | Promise<...>
 * @param {function} [options.onStop] - optional callback when bot stops
 * @returns {import("../ports/index.d.mts").BotPort & { readonly botId: string }}
 */
export function createFunctionBot(options) {
  if (!options || typeof options !== "object") {
    throw new Error("FunctionBot options must be a non-null object");
  }

  const { botId, chooseFn, onStop } = options;

  if (typeof botId !== "string" || botId.length === 0) {
    throw new Error("FunctionBot requires a non-empty string botId");
  }

  if (typeof chooseFn !== "function") {
    throw new Error("FunctionBot requires a chooseFn function");
  }

  let started = false;
  let stopped = false;
  let startContext = null;

  return {
    get botId() {
      return botId;
    },

    async start(context) {
      if (stopped) return;
      if (started) return; // idempotent
      startContext = cloneDeep(context);
      started = true;
    },

    async requestMove(turn, signal) {
      if (!started) {
        throw new Error(`Bot ${botId} called requestMove before start`);
      }
      if (signal?.aborted) {
        const abortErr = new Error(`Request aborted for bot ${botId}`);
        abortErr.name = "AbortError";
        throw abortErr;
      }

      // Clone turn input so chooseFn policy cannot mutate referee state
      const clonedTurn = cloneDeep(turn);
      const actionOrMove = await chooseFn(clonedTurn, signal);

      if (!actionOrMove || typeof actionOrMove !== "object") {
        throw new Error(`Bot ${botId} returned invalid non-object action`);
      }

      // If policy returned simple WireMove ({ from, to }), wrap into canonical BotAction
      if (actionOrMove.from && actionOrMove.to && !actionOrMove.move) {
        return {
          protocolVersion: 1,
          requestId: turn.requestId,
          move: {
            from: { x: actionOrMove.from.x, y: actionOrMove.from.y },
            to: { x: actionOrMove.to.x, y: actionOrMove.to.y }
          },
          ...(actionOrMove.comment !== undefined ? { comment: String(actionOrMove.comment) } : {})
        };
      }

      // If policy returned full BotAction
      return {
        protocolVersion: actionOrMove.protocolVersion ?? 1,
        requestId: actionOrMove.requestId ?? turn.requestId,
        move: actionOrMove.move
          ? {
              from: { x: actionOrMove.move.from.x, y: actionOrMove.move.from.y },
              to: { x: actionOrMove.move.to.x, y: actionOrMove.move.to.y }
            }
          : actionOrMove.move,
        ...(actionOrMove.comment !== undefined ? { comment: String(actionOrMove.comment) } : {})
      };
    },

    async stop() {
      if (stopped) return; // idempotent
      stopped = true;
      if (typeof onStop === "function") {
        try {
          await onStop();
        } catch (_) {}
      }
    }
  };
}
