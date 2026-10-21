import { describe, expect, it } from "vitest";
import { PENDING_GAME_TTL_MS, createResumeStore, type PendingOnlineGame } from "./resumeStore";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

const game: PendingOnlineGame = { allocationId: "alloc-1", room: "ott-alloc-1", seat: "A", resumeCredential: "cred", alias: "K7N-M4P", playerName: "An", savedAt: 1_000 };

describe("resumeStore", () => {
  it("round-trips a pending game and clears it", () => {
    const storage = memoryStorage();
    const store = createResumeStore(() => storage);
    store.write(game);
    expect(store.read(2_000)).toEqual(game);
    store.clear();
    expect(store.read(2_000)).toBeNull();
  });

  it("drops records that are too old or malformed", () => {
    const storage = memoryStorage();
    const store = createResumeStore(() => storage);
    store.write(game);
    expect(store.read(game.savedAt + PENDING_GAME_TTL_MS + 1)).toBeNull();
    expect(storage.length).toBe(0);
    storage.setItem("ottv2:online:pending-game", JSON.stringify({ ...game, seat: "C" }));
    expect(store.read(2_000)).toBeNull();
    storage.setItem("ottv2:online:pending-game", "{not json");
    expect(store.read(2_000)).toBeNull();
  });

  it("never throws when storage is blocked", () => {
    const store = createResumeStore(() => { throw new Error("SecurityError"); });
    expect(() => store.write(game)).not.toThrow();
    expect(store.read()).toBeNull();
    expect(() => store.clear()).not.toThrow();
  });
});
