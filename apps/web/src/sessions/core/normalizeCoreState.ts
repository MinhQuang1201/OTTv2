import type { GameEventView, GameSnapshot, PieceType, PlayerView, Position, ResultReason, Seat, SessionMode, SessionPhase } from "../../shared/model/game";
import type { CoreEvent, CoreState } from "./gameCoreBridge";

export interface NormalizeCoreStateOptions {
  readonly mode?: SessionMode;
  readonly viewerSeat?: Seat | null;
  readonly phase?: SessionPhase;
  readonly connection?: GameSnapshot["connection"];
  readonly playerNames?: Partial<Record<Seat, string>>;
  readonly boardRevision?: number;
  readonly pendingMove?: boolean;
  readonly aiThinking?: boolean;
  readonly roomId?: string | null;
  readonly events?: readonly GameEventView[];
  readonly playerCounts?: Partial<Record<Seat, Readonly<Record<PieceType, number>>>>;
}

const deepFreeze = <T,>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

function reason(value: string | null | undefined): ResultReason | null {
  return value === "goal" || value === "elimination" || value === "no_moves" || value === "timeout" || value === "disconnect_timeout" || value === "leave" ? value : null;
}

export function normalizeCoreEvents(events: readonly CoreEvent[], firstId = 1): readonly GameEventView[] {
  return events.map((event, index): GameEventView => {
    const id = firstId + index;
    const from = event.from ?? { x: 0, y: 0 };
    const to = event.to ?? from;
    if (event.type === "capture") return { id, type: "capture", pieceId: event.pieceId ?? "unknown", capturedId: event.capturedId ?? "unknown", from, to };
    if (event.type === "strike_loss") return { id, type: "strike_loss", pieceId: event.pieceId ?? "unknown", byId: event.byId ?? "unknown", from, to };
    if (event.type === "win" && event.winner && reason(event.reason)) return { id, type: "win", winner: event.winner, reason: reason(event.reason)! };
    return { id, type: "move", pieceId: event.pieceId ?? "unknown", from, to };
  }).map((event) => deepFreeze(event));
}

function makePlayer(state: CoreState, seat: Seat, name: string, suppliedCounts?: Readonly<Record<PieceType, number>>): PlayerView {
  const counts = state ? { dam: 0, la: 0, keo: 0 } : { dam: 0, la: 0, keo: 0 };
  for (const piece of state.pieces ?? []) if (piece.player === seat && counts[piece.type] !== undefined) counts[piece.type] += 1;
  return { seat, name, connected: true, remainingMs: state.clock.remainingMs[seat], counts: suppliedCounts ? { ...suppliedCounts } : counts };
}

export function normalizeCoreState(state: CoreState, options: NormalizeCoreStateOptions = {}): GameSnapshot {
  const mode = options.mode ?? "local";
  const phase = options.phase ?? (state.winner ? "finished" : "playing");
  const players = {
    A: makePlayer(state, "A", options.playerNames?.A ?? "Người chơi Đỏ", options.playerCounts?.A),
    B: makePlayer(state, "B", options.playerNames?.B ?? "Người chơi Xanh", options.playerCounts?.B),
  };
  const board = (state.pieces ?? []).map((piece) => ({ id: piece.id, seat: piece.player, type: piece.type, position: { x: piece.x, y: piece.y } }));
  const result = state.winner && reason(state.reason) ? { winner: state.winner, reason: reason(state.reason)! } : null;
  return deepFreeze({
    mode,
    phase,
    boardRevision: options.boardRevision ?? 0,
    viewerSeat: options.viewerSeat ?? null,
    turn: state.winner ? null : state.turn,
    board,
    players,
    connection: options.connection ?? "offline",
    pendingMove: options.pendingMove ?? false,
    aiThinking: options.aiThinking ?? false,
    roomId: options.roomId ?? null,
    waitingRooms: [],
    result,
    events: options.events ?? [],
    error: null,
  });
}
