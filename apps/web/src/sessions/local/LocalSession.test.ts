import "../../../../../packages/game-core/src/config.js";
import "../../../../../packages/game-core/src/rules.js";
import "../../../../../packages/game-core/src/ai.js";

import { describe, expect, it, vi } from "vitest";
import { LocalSession } from "./LocalSession";

function clock() {
  let current = 0;
  const callbacks = new Set<() => void>();
  const setInterval = vi.fn((callback: () => void) => { callbacks.add(callback); return callback as unknown as ReturnType<typeof globalThis.setInterval>; });
  const clearInterval = vi.fn((handle: ReturnType<typeof globalThis.setInterval>) => callbacks.delete(handle as unknown as () => void));
  return { now: () => current, advance: (ms: number) => { current += ms; callbacks.forEach((callback) => callback()); }, setInterval, clearInterval };
}

describe("LocalSession", () => {
  it("starts with canonical pieces, goals, names, counts, and clocks", async () => {
    const time = clock();
    const session = new LocalSession(time);
    await session.start({ mode: "local", playerNames: [" An ", "Bình"] });
    const snapshot = session.getSnapshot();
    expect(snapshot.mode).toBe("local");
    expect(snapshot.phase).toBe("playing");
    expect(snapshot.board).toHaveLength(18);
    expect(snapshot.turn).toBe("A");
    expect(snapshot.players.A?.name).toBe("An");
    expect(snapshot.players.B?.name).toBe("Bình");
    expect(snapshot.players.A?.remainingMs).toBe(600_000);
    expect(snapshot.board.some((piece) => piece.position.x === 0 && piece.position.y === 8)).toBe(false);
    expect(snapshot.board.some((piece) => piece.position.x === 8 && piece.position.y === 0)).toBe(false);
  });

  it("previews legal moves, accepts moves, changes turn, and emits monotonic events", async () => {
    const time = clock();
    const session = new LocalSession(time);
    const listener = vi.fn();
    session.subscribe(listener);
    await session.start({ mode: "local", playerNames: ["An", "Bình"] });
    expect(session.getLegalMoves({ x: 0, y: 2 })).toContainEqual({ x: 0, y: 1 });
    const result = await session.move({ x: 0, y: 2 }, { x: 0, y: 1 });
    expect(result).toEqual({ accepted: true });
    expect(session.getSnapshot().turn).toBe("B");
    expect(session.getSnapshot().viewerSeat).toBe("B");
    expect(session.getSnapshot().events.at(-1)).toMatchObject({ id: 1, type: "move" });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot().boardRevision).toBe(2);
  });

  it("rejects invalid moves without changing the board", async () => {
    const session = new LocalSession(clock());
    await session.start({ mode: "local", playerNames: ["An", "Bình"] });
    const before = session.getSnapshot();
    const result = await session.move({ x: 0, y: 2 }, { x: 0, y: 0 });
    expect(result).toMatchObject({ accepted: false, error: { code: "invalid_move" } });
    expect(session.getSnapshot()).toBe(before);
  });

  it("decrements the running clock, times out, and stops the timer", async () => {
    const time = clock();
    const session = new LocalSession(time);
    await session.start({ mode: "local", playerNames: ["An", "Bình"] });
    time.advance(2_500);
    expect(session.getSnapshot().players.A?.remainingMs).toBe(597_500);
    time.advance(597_500);
    expect(session.getSnapshot().phase).toBe("finished");
    expect(session.getSnapshot().result).toEqual({ winner: "B", reason: "timeout" });
    expect(session.getSnapshot().events.at(-1)).toMatchObject({ id: 1, type: "win", reason: "timeout" });
    expect(time.clearInterval).toHaveBeenCalled();
  });

  it("supports unsubscribe and leave/dispose timer cleanup", async () => {
    const time = clock();
    const session = new LocalSession(time);
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);
    await session.start({ mode: "local", playerNames: ["An", "Bình"] });
    unsubscribe();
    await session.leave();
    expect(session.getSnapshot().result).toEqual({ winner: "B", reason: "leave" });
    session.dispose();
    expect(time.clearInterval).toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
