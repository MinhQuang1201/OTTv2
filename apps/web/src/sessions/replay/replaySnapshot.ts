import type { GameSnapshot, Seat } from "../../shared/model/game";
import type { CoreEvent } from "../core/gameCoreBridge";
import type { ReplayDocument } from "../../../../../packages/arena/src/contracts/index.d.mts";
import { normalizeCoreEvents, normalizeCoreState } from "../core/normalizeCoreState";

export const deepFreeze = <T,>(value: T): T => {
  if (value && typeof value === "object") {
    if (!Object.isFrozen(value)) {
      Object.freeze(value);
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
      if (child && typeof child === "object" && !Object.isFrozen(child)) {
        deepFreeze(child);
      }
    }
  }
  return value;
};

export const INITIAL_REPLAY_SNAPSHOT: GameSnapshot = deepFreeze({
  mode: "replay",
  phase: "idle",
  boardRevision: 0,
  viewer: { role: "spectator" as const },
  viewerSeat: null,
  capabilities: {
    canMove: false,
    canLeaveGame: false,
    canSpectate: false,
  },
  spectatorCount: 0,
  turn: null,
  board: [],
  players: {},
  connection: "offline",
  pendingMove: false,
  aiThinking: false,
  roomId: null,
  waitingRooms: [],
  publicMatches: [],
  result: null,
  events: [],
  error: null,
});

/**
 * Creates an immutable GameSnapshot for ReplaySession based on the given ReplayDocument,
 * current cursor position, and current board revision.
 *
 * Uses normalizeCoreState for canonical board representation and player metrics,
 * overriding mode, phase, capabilities, and viewer according to replay rules.
 *
 * Notice:
 * - At cursor === maxCursor, phase is 'finished' even when winner is null (e.g. draw).
 * - Legacy snapshot.result only contains core win results ("goal", "elimination", "no_moves").
 * - Draw and forfeit results are excluded from snapshot.result and exposed exclusively via ReplayPlaybackView.
 * - When cursor < maxCursor, phase is 'playing' and snapshot.result is always null.
 */
export function createReplaySnapshot(
  document: ReplayDocument,
  cursor: number,
  boardRevision: number,
): GameSnapshot {
  const maxCursor = document.result.acceptedPlies;
  const clampedCursor = Math.max(0, Math.min(maxCursor, Math.round(cursor)));
  const isTerminal = clampedCursor === maxCursor;

  const coreState = isTerminal
    ? document.terminalCoreState
    : document.frames[clampedCursor]?.coreState ?? document.terminalCoreState;

  const playerNames: Partial<Record<Seat, string>> = {
    A: document.participants?.A?.name || document.participants?.A?.botId || "Bot A",
    B: document.participants?.B?.name || document.participants?.B?.botId || "Bot B",
  };

  const cumulativeCoreEvents: CoreEvent[] = [];
  for (let i = 1; i <= clampedCursor; i++) {
    const frame = document.frames[i];
    if (frame?.lastMove?.events) {
      cumulativeCoreEvents.push(...frame.lastMove.events);
    }
  }
  const events = normalizeCoreEvents(cumulativeCoreEvents);

  const phase: GameSnapshot["phase"] = isTerminal ? "finished" : "playing";

  const baseSnapshot = normalizeCoreState(coreState, {
    mode: "replay",
    phase,
    playerNames,
    boardRevision,
    events,
    connection: "offline",
  });

  const legacyResult = isTerminal && document.result.outcome === "win"
    ? { winner: document.result.winner, reason: document.result.reason }
    : null;

  const snapshot: GameSnapshot = {
    ...baseSnapshot,
    mode: "replay",
    phase,
    boardRevision,
    viewer: Object.freeze({ role: "spectator" as const }),
    viewerSeat: null,
    capabilities: Object.freeze({
      canMove: false,
      canLeaveGame: false,
      canSpectate: false,
    }),
    turn: isTerminal ? null : coreState.turn,
    result: legacyResult,
    connection: "offline",
  };

  return deepFreeze(snapshot);
}
