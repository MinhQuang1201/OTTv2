import {
  validatePublicMatchSummary,
  type ParseResult,
  type PublicMatchView,
} from "../../../../packages/protocol/src/index.js";

export function normalizePublicMatchSummary(value: unknown): ParseResult<PublicMatchView> {
  const result = validatePublicMatchSummary(value);
  if (!result.ok) return result;

  const summary = result.value;
  return {
    ok: true,
    value: {
      allocationId: summary.allocationId,
      roomId: summary.roomId,
      status: "playing",
      players: {
        A: {
          seat: "A",
          name: summary.players.A.name,
          connected: summary.players.A.connected,
          remainingMs: summary.players.A.remainingMs,
        },
        B: {
          seat: "B",
          name: summary.players.B.name,
          connected: summary.players.B.connected,
          remainingMs: summary.players.B.remainingMs,
        },
      },
      spectatorCount: summary.spectatorCount,
      serverNow: summary.serverNow,
      runningSeat: summary.runningSeat,
    },
  };
}
