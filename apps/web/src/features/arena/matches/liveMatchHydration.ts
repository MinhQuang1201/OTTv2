import type { CoreState } from "../../../sessions/contract";
import { normalizeCoreState } from "../../../sessions/core/normalizeCoreState";
import { INITIAL_REPLAY_SNAPSHOT } from "../../../sessions/replay/replaySnapshot";
import type { GameSnapshot, Position } from "../../../shared/model/game";
import type { LiveFrameRecord } from "../ArenaApiGateway";

type LiveFrameState = Record<string, unknown>;

function isCompleteCoreState(value: unknown): value is LiveFrameState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  const clock = state.clock;
  const remainingMs = clock && typeof clock === "object" ? (clock as Record<string, unknown>).remainingMs : null;
  const pieces = state.pieces;
  const clockValues = remainingMs as Record<string, unknown> | null;

  return (
    (state.turn === null || state.turn === "A" || state.turn === "B") &&
    (state.winner === null || state.winner === "A" || state.winner === "B") &&
    Array.isArray(pieces) &&
    pieces.every((piece) => {
      if (!piece || typeof piece !== "object") return false;
      const candidate = piece as Record<string, unknown>;
      return (
        typeof candidate.id === "string" &&
        candidate.id.length > 0 &&
        (candidate.player === "A" || candidate.player === "B") &&
        (candidate.type === "dam" || candidate.type === "la" || candidate.type === "keo") &&
        typeof candidate.x === "number" && Number.isInteger(candidate.x) &&
        typeof candidate.y === "number" && Number.isInteger(candidate.y) &&
        candidate.x >= 0 &&
        candidate.x <= 8 &&
        candidate.y >= 0 &&
        candidate.y <= 8
      );
    }) &&
    !!remainingMs &&
    typeof remainingMs === "object" &&
    typeof clockValues?.A === "number" && Number.isFinite(clockValues.A) &&
    clockValues.A >= 0 &&
    typeof clockValues.B === "number" && Number.isFinite(clockValues.B) &&
    clockValues.B >= 0
  );
}

export function validateLiveFrame(frame: LiveFrameRecord): void {
  if (!Number.isInteger(frame.ply) || frame.ply < 0) {
    throw new Error("Khung hình trực tiếp có số thứ tự ply không hợp lệ.");
  }

  const frameData = frame as Record<string, unknown>;
  const rawState = frameData.state !== undefined ? frameData.state : frameData.coreState;
  if (rawState !== undefined && !isCompleteCoreState(rawState)) {
    throw new Error("Khung hình trực tiếp chứa trạng thái bàn cờ không hợp lệ.");
  }
}

export function hydrateLiveFrameSnapshot(
  frame: LiveFrameRecord | null,
  isTerminal: boolean
): GameSnapshot {
  if (!frame) {
    return INITIAL_REPLAY_SNAPSHOT;
  }

  // Authoritative server state: accept frame.state or fallback frame.coreState
  const frameData = frame as Record<string, unknown>;
  const rawState = frameData.state !== undefined ? frameData.state : frameData.coreState;
  if (!isCompleteCoreState(rawState)) {
    return INITIAL_REPLAY_SNAPSHOT;
  }

  return normalizeCoreState(rawState as unknown as CoreState, {
    mode: "spectator",
    phase: isTerminal ? "finished" : "playing",
    connection: "online",
    boardRevision: frame.ply,
  });
}

export function extractHighlightMove(
  frame: LiveFrameRecord | null
): { from: Position; to: Position } | null {
  if (!frame?.move) return null;
  const m = frame.move as { from?: Position; to?: Position };
  if (m.from && m.to && typeof m.from.x === "number" && typeof m.to.x === "number") {
    return { from: m.from, to: m.to };
  }
  return null;
}

export function formatLiveClock(ms?: number): string {
  if (ms === undefined || ms === null || typeof ms !== "number") return "--:--";
  const totalSecs = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
}

export function extractLiveClock(
  frame: LiveFrameRecord | null,
  seat: "A" | "B"
): number | undefined {
  if (!frame) return undefined;

  // 1. Direct frame.clock?.remainingMs
  const directClock = frame.clock as any;
  if (directClock && typeof directClock === "object" && directClock.remainingMs) {
    const val = directClock.remainingMs[seat];
    if (typeof val === "number") return val;
  }

  // 2. Fallback to frame.state?.clock?.remainingMs or frame.coreState?.clock?.remainingMs
  const rawState = (frame.state ?? (frame as any).coreState) as any;
  if (rawState && typeof rawState === "object" && rawState.clock) {
    const val = rawState.clock.remainingMs?.[seat];
    if (typeof val === "number") return val;
  }

  // 3. Fallback to frame.remainingMs if this frame recorded this seat
  if (frame.seat === seat && typeof frame.remainingMs === "number") {
    return frame.remainingMs;
  }

  return undefined;
}
