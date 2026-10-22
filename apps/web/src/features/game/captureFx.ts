import type { GameEventView, PieceType, PieceView, Position, Seat, SessionMode } from "../../shared/model/game";

/**
 * Presentation helpers for capture feedback. Nothing here decides legality:
 * capture effects are derived from authoritative events and snapshots, and
 * blocked-move hints only explain squares the session already refused.
 */

export const PIECE_NAME: Readonly<Record<PieceType, string>> = { dam: "Đấm", la: "Lá", keo: "Kéo" };
export const PIECE_GLYPH: Readonly<Record<PieceType, string>> = { dam: "✊", la: "📄", keo: "✂" };
export const SEAT_NAME: Readonly<Record<Seat, string>> = { A: "Đỏ", B: "Xanh" };

/** Mirrors `BEATS` in `packages/game-core/src/config.js`: key beats value. */
export const BEATS: Readonly<Record<PieceType, PieceType>> = { dam: "keo", keo: "la", la: "dam" };

/** Pieces per kind at the start of a standard game (mirrors `A_SETUP`). */
export const INITIAL_COUNTS: Readonly<Record<PieceType, number>> = { dam: 3, la: 4, keo: 3 };

export const PIECE_TYPES: readonly PieceType[] = ["dam", "la", "keo"];

/** Longest a capture effect stays on screen; input is never blocked meanwhile. */
export const CAPTURE_EFFECT_MS = 900;
export const CAPTURE_EFFECT_REDUCED_MS = 600;
export const WIN_EFFECT_MS = 240;
/** Older effects are dropped so a burst of events (reconnect, fast replay) cannot lag behind the board. */
export const MAX_QUEUED_EFFECTS = 3;

export interface PieceIdentity {
  readonly seat: Seat;
  readonly type: PieceType;
}

export interface CaptureEffect {
  readonly id: number;
  readonly at: Position;
  readonly attacker: PieceIdentity;
  readonly captured: PieceIdentity;
}

export interface BoardEffect {
  readonly id: number;
  readonly capture: CaptureEffect | null;
}

const otherSeat = (seat: Seat): Seat => (seat === "A" ? "B" : "A");
const beaterOf = (type: PieceType): PieceType => PIECE_TYPES.find((candidate) => BEATS[candidate] === type)!;
const PIECE_ID = /^([AB])-(dam|la|keo)-/;

/** Resolves a piece's seat and kind from the board, falling back to the core id format `A-dam-0`. */
export function identifyPiece(pieceId: string, board: readonly PieceView[]): PieceIdentity | null {
  const onBoard = board.find((piece) => piece.id === pieceId);
  if (onBoard) return { seat: onBoard.seat, type: onBoard.type };
  const match = PIECE_ID.exec(pieceId);
  return match ? { seat: match[1] as Seat, type: match[2] as PieceType } : null;
}

export function captureEffectFor(event: GameEventView, board: readonly PieceView[]): CaptureEffect | null {
  if (event.type !== "capture") return null;
  const capturedById = identifyPiece(event.capturedId, []);
  let attacker = identifyPiece(event.pieceId, board);
  const capturedSeat = attacker ? otherSeat(attacker.seat) : capturedById?.seat;
  const capturedType = event.capturedType ?? capturedById?.type ?? (attacker ? BEATS[attacker.type] : undefined);
  if (!capturedSeat || !capturedType) return null;
  attacker ??= { seat: otherSeat(capturedSeat), type: beaterOf(capturedType) };
  return { id: event.id, at: event.to, attacker, captured: { seat: capturedSeat, type: capturedType } };
}

/** Builds queued board effects for unseen events, oldest first. */
export function effectsForEvents(events: readonly GameEventView[], board: readonly PieceView[]): BoardEffect[] {
  return events
    .filter((event) => event.type === "capture" || event.type === "win")
    .map((event) => ({ id: event.id, capture: captureEffectFor(event, board) }));
}

export function enqueueEffects(queue: readonly BoardEffect[], incoming: readonly BoardEffect[], max = MAX_QUEUED_EFFECTS): BoardEffect[] {
  return [...queue, ...incoming].slice(-max);
}

export function effectDurationMs(effect: BoardEffect, reducedMotion: boolean): number {
  if (!effect.capture) return WIN_EFFECT_MS;
  return reducedMotion ? CAPTURE_EFFECT_REDUCED_MS : CAPTURE_EFFECT_MS;
}

/** Floating label such as "✂ Kéo ăn 📄 Lá". */
export function captureLabel(effect: CaptureEffect): string {
  const { attacker, captured } = effect;
  return `${PIECE_GLYPH[attacker.type]} ${PIECE_NAME[attacker.type]} ăn ${PIECE_GLYPH[captured.type]} ${PIECE_NAME[captured.type]}`;
}

/** Screen-reader sentence for a capture. */
export function captureAnnouncement(effect: CaptureEffect, square: string): string {
  const { attacker, captured } = effect;
  return `${PIECE_NAME[attacker.type]} ${SEAT_NAME[attacker.seat]} ăn ${PIECE_NAME[captured.type]} ${SEAT_NAME[captured.seat]} tại ${square}.`;
}

export type CaptureCue = "capture" | "captureGain" | "captureLoss";

/** Personal cues only make sense when the screen belongs to one seat. */
export function captureCue(effect: CaptureEffect | null, mode: SessionMode, viewerSeat: Seat | null): CaptureCue {
  if (!effect || viewerSeat === null || (mode !== "online" && mode !== "ai")) return "capture";
  return effect.attacker.seat === viewerSeat ? "captureGain" : "captureLoss";
}

export interface HistoryEntry {
  readonly id: number;
  readonly mover: PieceIdentity | null;
  readonly from: Position;
  readonly to: Position;
  readonly captured: PieceIdentity | null;
}

export function historyEntries(events: readonly GameEventView[], board: readonly PieceView[]): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const event of events) {
    if (event.type === "move") {
      entries.push({ id: event.id, mover: identifyPiece(event.pieceId, board), from: event.from, to: event.to, captured: null });
    } else if (event.type === "capture") {
      const effect = captureEffectFor(event, board);
      entries.push({ id: event.id, mover: effect?.attacker ?? null, from: event.from, to: event.to, captured: effect?.captured ?? null });
    }
  }
  return entries;
}

/** Pieces a seat has taken, derived from the opponent's remaining counts so it survives event eviction and reconnects. */
export function capturedCounts(opponentCounts: Readonly<Record<PieceType, number>> | undefined): Record<PieceType, number> {
  const result = { dam: 0, la: 0, keo: 0 };
  if (!opponentCounts) return result;
  for (const type of PIECE_TYPES) result[type] = Math.max(0, INITIAL_COUNTS[type] - (opponentCounts[type] ?? 0));
  return result;
}

export interface BlockedTarget {
  readonly position: Position;
  /** Short tooltip, for example "Lá thua Kéo". */
  readonly hint: string;
  /** Toast text explaining why the square cannot be entered. */
  readonly message: string;
}

/**
 * Explains neighbouring opponent pieces that the selected piece cannot enter.
 * Squares listed in `legalMoves` are never reported, so the session stays the
 * only source of legality.
 */
export function blockedTargets(mover: PieceView, board: readonly PieceView[], legalMoves: readonly Position[]): BlockedTarget[] {
  const result: BlockedTarget[] = [];
  for (const piece of board) {
    if (piece.seat === mover.seat) continue;
    const dx = Math.abs(piece.position.x - mover.position.x);
    const dy = Math.abs(piece.position.y - mover.position.y);
    if (Math.max(dx, dy) !== 1) continue;
    if (legalMoves.some((move) => move.x === piece.position.x && move.y === piece.position.y)) continue;
    const mine = PIECE_NAME[mover.type];
    const theirs = PIECE_NAME[piece.type];
    if (piece.type === mover.type) {
      result.push({ position: piece.position, hint: `${mine} gặp ${theirs}`, message: `Hai quân ${mine} cùng loại — không ăn được nhau.` });
    } else if (BEATS[piece.type] === mover.type) {
      result.push({ position: piece.position, hint: `${mine} thua ${theirs}`, message: `${mine} thua ${theirs} — không đi vào ô này được.` });
    }
  }
  return result;
}

export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
