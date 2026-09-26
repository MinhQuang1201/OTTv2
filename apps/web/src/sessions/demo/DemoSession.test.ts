import { describe, expect, it, vi } from "vitest";

import { DemoSession } from "./DemoSession";
import { DEMO_SCENARIOS } from "./scenarios";

describe("DemoSession fixtures", () => {
  it.each(DEMO_SCENARIOS)("builds a valid 9x9 snapshot for %s", (scenario) => {
    const session = new DemoSession(scenario);
    const snapshot = session.getSnapshot();

    expect(snapshot.mode).toBe("demo");
    expect(snapshot.board.every(({ position }) =>
      position.x >= 0 && position.x < 9 && position.y >= 0 && position.y < 9,
    )).toBe(true);
    expect(new Set(snapshot.board.map(({ position }) => `${position.x}:${position.y}`)).size)
      .toBe(snapshot.board.length);
  });

  it("publishes one immutable transition and allocates monotonic event ids", async () => {
    const session = new DemoSession("game-piece-selected");
    const listener = vi.fn();
    const before = session.getSnapshot();
    const unsubscribe = session.subscribe(listener);

    const result = await session.move({ x: 0, y: 2 }, { x: 0, y: 1 });

    expect(result).toEqual({ accepted: true });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot()).not.toBe(before);
    expect(session.getSnapshot().events.at(-1)?.id).toBeGreaterThan(0);
    expect(Object.isFrozen(session.getSnapshot())).toBe(true);
    expect(Object.isFrozen(session.getSnapshot().board)).toBe(true);
    expect(Object.isFrozen(session.getSnapshot().board[0])).toBe(true);
    unsubscribe();
  });

  it("does not replay a duplicate event when a destination is rejected", async () => {
    const session = new DemoSession("game-move-rejected");
    const listener = vi.fn();
    session.subscribe(listener);

    expect(session.getLegalMoves({ x: 0, y: 2 })).toEqual([{ x: 0, y: 1 }]);
    const before = session.getSnapshot();
    const result = await session.move({ x: 0, y: 2 }, { x: 0, y: 1 });

    expect(result).toMatchObject({ accepted: false, error: { code: "invalid_move", retryable: false } });
    expect(listener).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toBe(before);
    expect(session.getSnapshot().events).toEqual(before.events);
  });

  it("increments board revision for a move but retains it for display-only scenarios", async () => {
    const moving = new DemoSession("game-active-a");
    const movingRevision = moving.getSnapshot().boardRevision;
    await moving.move({ x: 0, y: 2 }, { x: 0, y: 1 });
    expect(moving.getSnapshot().boardRevision).toBe(movingRevision + 1);

    const warning = new DemoSession("game-clock-warning");
    expect(warning.getSnapshot().boardRevision).toBe(1);
    expect(warning.getSnapshot().players.A?.remainingMs).toBeLessThan(60_000);
  });

  it("supports unsubscribe and dispose without further notifications", async () => {
    const session = new DemoSession("game-active-a");
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);
    unsubscribe();
    await session.move({ x: 0, y: 2 }, { x: 0, y: 1 });
    expect(listener).not.toHaveBeenCalled();

    const disposedListener = vi.fn();
    session.subscribe(disposedListener);
    session.dispose();
    await session.move({ x: 0, y: 2 }, { x: 0, y: 1 });
    expect(disposedListener).not.toHaveBeenCalled();
  });
});
