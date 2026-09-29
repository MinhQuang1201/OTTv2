import type { GameEventView, GameSnapshot, PieceType, PlayerView, ResultReason, Seat } from "../../shared/model/game";

export interface OnlineRawPiece {
  readonly id: string;
  readonly player: Seat;
  readonly type: PieceType;
  readonly x: number;
  readonly y: number;
}

export interface OnlineRawState {
  readonly turn: Seat | null;
  readonly winner: Seat | null;
  readonly reason: ResultReason | null;
  readonly clock: { readonly remainingMs: { readonly A: number; readonly B: number }; readonly runningSeat: Seat | null };
  readonly pieces: readonly OnlineRawPiece[];
}

export interface OnlineStateMessage {
  readonly roomId?: string;
  readonly revision: number;
  readonly you?: Seat;
  readonly viewer?: { readonly role: "player"; readonly seat: Seat } | { readonly role: "spectator" };
  readonly status?: "waiting" | "playing" | "done";
  readonly serverNow?: number;
  readonly players?: Partial<Record<Seat, { readonly name?: string; readonly connected?: boolean } | null>>;
  readonly spectatorCount?: number;
  readonly state: unknown;
  readonly events?: readonly unknown[];
}

export interface NormalizedOnlineState {
  readonly snapshot: GameSnapshot;
  readonly rawState: OnlineRawState;
  readonly serverRevision: number;
  readonly boardFingerprint: string;
  readonly receivedAt: number;
}

const isSeat = (value: unknown): value is Seat => value === "A" || value === "B";
const isType = (value: unknown): value is PieceType => value === "dam" || value === "la" || value === "keo";
const isReason = (value: unknown): value is ResultReason => value === "goal" || value === "elimination" || value === "no_moves" || value === "timeout" || value === "disconnect_timeout" || value === "leave";
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function parseOnlineRawState(value: unknown): OnlineRawState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const clock = candidate.clock;
  if (!clock || typeof clock !== "object") return null;
  const clockValue = clock as Record<string, unknown>;
  const remaining = clockValue.remainingMs;
  if (!remaining || typeof remaining !== "object") return null;
  const remainingValue = remaining as Record<string, unknown>;
  if (!finite(remainingValue.A) || !finite(remainingValue.B)) return null;
  if (candidate.turn !== null && !isSeat(candidate.turn)) return null;
  if (candidate.winner !== null && !isSeat(candidate.winner)) return null;
  if (candidate.reason !== null && !isReason(candidate.reason)) return null;
  if (clockValue.runningSeat !== null && !isSeat(clockValue.runningSeat)) return null;
  if (!Array.isArray(candidate.pieces)) return null;
  const pieces: OnlineRawPiece[] = [];
  const occupied = new Set<string>();
  for (const valuePiece of candidate.pieces) {
    if (!valuePiece || typeof valuePiece !== "object") return null;
    const piece = valuePiece as Record<string, unknown>;
    if (typeof piece.id !== "string" || !isSeat(piece.player) || !isType(piece.type) || !Number.isInteger(piece.x) || !Number.isInteger(piece.y)) return null;
    const x = piece.x as number;
    const y = piece.y as number;
    if (x < 0 || x > 8 || y < 0 || y > 8) return null;
    const key = `${x}:${y}`;
    if (occupied.has(key)) return null;
    occupied.add(key);
    pieces.push({ id: piece.id, player: piece.player, type: piece.type, x, y });
  }
  return Object.freeze({
    turn: candidate.turn as Seat | null,
    winner: candidate.winner as Seat | null,
    reason: candidate.reason as ResultReason | null,
    clock: Object.freeze({ remainingMs: Object.freeze({ A: remainingValue.A, B: remainingValue.B }), runningSeat: clockValue.runningSeat as Seat | null }),
    pieces: Object.freeze(pieces.map((piece) => Object.freeze(piece))),
  });
}

function event(value: unknown): GameEventView | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (!Number.isInteger(source.id) || (source.id as number) <= 0 || !Number.isInteger((source.from as any)?.x) || !Number.isInteger((source.from as any)?.y) || !Number.isInteger((source.to as any)?.x) || !Number.isInteger((source.to as any)?.y)) return null;
  const from = { x: (source.from as any).x, y: (source.from as any).y };
  const to = { x: (source.to as any).x, y: (source.to as any).y };
  if (source.type === "capture" && typeof source.pieceId === "string" && typeof source.capturedId === "string") return { id: source.id as number, type: "capture", pieceId: source.pieceId, capturedId: source.capturedId, from, to };
  if (source.type === "strike_loss" && typeof source.pieceId === "string" && typeof source.byId === "string") return { id: source.id as number, type: "strike_loss", pieceId: source.pieceId, byId: source.byId, from, to };
  if (source.type === "move" && typeof source.pieceId === "string") return { id: source.id as number, type: "move", pieceId: source.pieceId, from, to };
  if (source.type === "win" && isSeat(source.winner) && isReason(source.reason)) return { id: source.id as number, type: "win", winner: source.winner, reason: source.reason };
  return null;
}

export function normalizeOnlineEvents(values: readonly unknown[] | undefined): readonly GameEventView[] {
  if (!values) return [];
  const seen = new Set<number>();
  const result: GameEventView[] = [];
  for (const value of values) {
    const item = event(value);
    if (item && !seen.has(item.id)) { seen.add(item.id); result.push(item); }
  }
  return result;
}

function player(value: unknown, seat: Seat, state: OnlineRawState): PlayerView {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const counts = { dam: 0, la: 0, keo: 0 };
  for (const piece of state.pieces) if (piece.player === seat) counts[piece.type] += 1;
  return { seat, name: typeof source.name === "string" && source.name ? source.name : seat === "A" ? "Người chơi Đỏ" : "Người chơi Xanh", connected: source.connected !== false, remainingMs: Math.max(0, state.clock.remainingMs[seat]), counts };
}

export function boardFingerprint(state: OnlineRawState): string {
  return JSON.stringify({ turn: state.turn, winner: state.winner, reason: state.reason, pieces: state.pieces.map((piece) => [piece.id, piece.player, piece.type, piece.x, piece.y]) });
}

export function normalizeOnlineState(message: OnlineStateMessage, receivedAt = Date.now(), boardRevision = message.revision): NormalizedOnlineState | null {
  if (!Number.isInteger(message.revision) || message.revision < 0) return null;
  const state = parseOnlineRawState(message.state);
  if (!state) return null;
  if (message.you !== undefined && !isSeat(message.you)) return null;
  const phase = message.status === "waiting" ? "waiting" : message.status === "done" || state.winner ? "finished" : "playing";
  const events = normalizeOnlineEvents(message.events);
  const players = {
    A: player(message.players?.A, "A", state),
    B: player(message.players?.B, "B", state),
  };
  const isSpectator = message.viewer?.role === "spectator";
  const viewerSeat = isSpectator ? null : message.you ?? null;
  const viewer = isSpectator
    ? { role: "spectator" as const }
    : viewerSeat === null
      ? null
      : { role: "player" as const, seat: viewerSeat };
  const capabilities = isSpectator
    ? { canMove: false, canLeaveGame: false, canSpectate: true }
    : viewer
      ? { canMove: true, canLeaveGame: true, canSpectate: false }
      : { canMove: false, canLeaveGame: false, canSpectate: false };
  const rawSpectatorCount = message.spectatorCount;
  const spectatorCount = typeof rawSpectatorCount === "number" && Number.isInteger(rawSpectatorCount) && rawSpectatorCount >= 0 ? rawSpectatorCount : 0;
  const snapshot: GameSnapshot = Object.freeze({
    mode: isSpectator ? "spectator" : "online",
    phase,
    boardRevision,
    viewer,
    viewerSeat,
    capabilities,
    spectatorCount,
    turn: state.winner ? null : state.turn,
    board: Object.freeze(state.pieces.map((piece) => Object.freeze({ id: piece.id, seat: piece.player, type: piece.type, position: { x: piece.x, y: piece.y } }))),
    players,
    connection: "online",
    pendingMove: false,
    aiThinking: false,
    roomId: message.roomId ?? null,
    waitingRooms: [],
    publicMatches: [],
    result: state.winner && state.reason ? { winner: state.winner, reason: state.reason } : null,
    events,
    error: null,
  });
  return { snapshot, rawState: state, serverRevision: message.revision, boardFingerprint: boardFingerprint(state), receivedAt };
}
