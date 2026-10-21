import type { Seat } from "../../shared/model/game";

/** What a player needs to get back into an unfinished online game after a reload or a closed tab. */
export interface PendingOnlineGame {
  readonly allocationId: string;
  readonly room: string;
  readonly seat: Seat;
  readonly resumeCredential: string;
  readonly alias: string | null;
  readonly playerName: string;
  readonly savedAt: number;
}

const KEY = "ottv2:online:pending-game";
/** Longer than a full game (2 × 10 min clocks plus reconnect grace); the server rejects stale credentials anyway. */
export const PENDING_GAME_TTL_MS = 30 * 60 * 1000;

export interface ResumeStore {
  read(now?: number): PendingOnlineGame | null;
  write(game: PendingOnlineGame): void;
  clear(): void;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function isPendingGame(value: unknown): value is PendingOnlineGame {
  if (!value || typeof value !== "object") return false;
  const game = value as Record<string, unknown>;
  return typeof game.allocationId === "string" && game.allocationId.length > 0 &&
    typeof game.room === "string" && game.room.length > 0 &&
    (game.seat === "A" || game.seat === "B") &&
    typeof game.resumeCredential === "string" && game.resumeCredential.length > 0 &&
    (game.alias === null || typeof game.alias === "string") &&
    typeof game.playerName === "string" &&
    typeof game.savedAt === "number" && Number.isFinite(game.savedAt);
}

/** localStorage-backed store; every access is guarded because storage can be blocked or full. */
export function createResumeStore(backing: () => Storage | null = storage): ResumeStore {
  return {
    read(now = Date.now()) {
      try {
        const raw = backing()?.getItem(KEY);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (!isPendingGame(parsed) || now - parsed.savedAt > PENDING_GAME_TTL_MS) {
          backing()?.removeItem(KEY);
          return null;
        }
        return parsed;
      } catch {
        return null;
      }
    },
    write(game) {
      try { backing()?.setItem(KEY, JSON.stringify(game)); } catch { /* resume is a convenience */ }
    },
    clear() {
      try { backing()?.removeItem(KEY); } catch { /* resume is a convenience */ }
    },
  };
}

export const resumeStore = createResumeStore();
