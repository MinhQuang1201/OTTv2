import "../../../../../packages/game-core/src/config.js";
import "../../../../../packages/game-core/src/rules.js";
import "../../../../../packages/game-core/src/ai.js";

import { describe, expect, it, vi } from "vitest";
import { AiSession, type AiSessionDependencies } from "./AiSession";
import { getGameCoreBridge, type GameCoreBridge } from "../core/gameCoreBridge";

function scheduler() {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  const setTimeout = vi.fn((callback: () => void) => {
    const id = nextId++;
    callbacks.set(id, callback);
    return id as unknown as ReturnType<typeof globalThis.setTimeout>;
  });
  const clearTimeout = vi.fn((handle: ReturnType<typeof globalThis.setTimeout>) => {
    callbacks.delete(handle as unknown as number);
  });
  const runNext = () => {
    const entry = callbacks.entries().next().value as [number, () => void] | undefined;
    if (!entry) return;
    callbacks.delete(entry[0]);
    entry[1]();
  };
  return { setTimeout, clearTimeout, runNext, pending: () => callbacks.size };
}

function dependencies(overrides: Partial<AiSessionDependencies> = {}) {
  const timer = scheduler();
  const bridge = getGameCoreBridge();
  const chooseMove = vi.fn(() => ({ from: { x: 8, y: 6 }, to: { x: 8, y: 7 } }));
  return {
    timer,
    chooseMove,
    deps: {
      scheduler: timer,
      chooseMove,
      local: { bridge },
      ...overrides,
    } satisfies AiSessionDependencies,
  };
}

describe("AiSession", () => {
  it("allows only the human seat to preview and submit moves", async () => {
    const { deps } = dependencies();
    const session = new AiSession(deps);
    await session.start({ mode: "ai", playerName: "An", humanSeat: "A" });

    expect(session.getSnapshot()).toMatchObject({ mode: "ai", viewerSeat: "A", aiThinking: false, turn: "A" });
    expect(session.getLegalMoves({ x: 8, y: 6 })).toEqual([]);
    expect((await session.move({ x: 8, y: 6 }, { x: 8, y: 5 })).accepted).toBe(false);
    expect((await session.move({ x: 0, y: 2 }, { x: 0, y: 1 })).accepted).toBe(true);
  });

  it("schedules exactly one AI decision and disables input while thinking", async () => {
    const { deps, timer, chooseMove } = dependencies();
    const session = new AiSession(deps);
    await session.start({ mode: "ai", playerName: "An" });

    await session.move({ x: 0, y: 2 }, { x: 0, y: 1 });
    expect(session.getSnapshot()).toMatchObject({ aiThinking: true, pendingMove: true, turn: "B" });
    expect(timer.setTimeout).toHaveBeenCalledTimes(1);
    expect((await session.move({ x: 0, y: 3 }, { x: 0, y: 2 })).accepted).toBe(false);
    expect(timer.setTimeout).toHaveBeenCalledTimes(1);

    timer.runNext();
    await vi.waitFor(() => expect(chooseMove).toHaveBeenCalledTimes(1));
    expect(chooseMove).toHaveBeenCalledTimes(1);
    expect(chooseMove).toHaveBeenCalledWith(expect.anything(), "B");
    await vi.waitFor(() => expect(session.getSnapshot()).toMatchObject({ aiThinking: false, pendingMove: false, turn: "A" }));
    expect(session.getSnapshot().events.at(-1)).toMatchObject({ type: "move", from: { x: 8, y: 6 }, to: { x: 8, y: 7 } });
  });

  it("cancels pending AI work on leave and dispose", async () => {
    const first = dependencies();
    const leaving = new AiSession(first.deps);
    await leaving.start({ mode: "ai", playerName: "An" });
    await leaving.move({ x: 0, y: 2 }, { x: 0, y: 1 });
    await leaving.leave();
    first.timer.runNext();
    expect(first.chooseMove).not.toHaveBeenCalled();
    expect(first.timer.clearTimeout).toHaveBeenCalledTimes(1);

    const second = dependencies();
    const disposed = new AiSession(second.deps);
    await disposed.start({ mode: "ai", playerName: "An" });
    await disposed.move({ x: 0, y: 2 }, { x: 0, y: 1 });
    disposed.dispose();
    second.timer.runNext();
    expect(second.chooseMove).not.toHaveBeenCalled();
    expect(second.timer.clearTimeout).toHaveBeenCalledTimes(1);
  });

  it("schedules the AI opening move when the human is seat B", async () => {
    const { deps, timer } = dependencies();
    const session = new AiSession(deps);
    await session.start({ mode: "ai", playerName: "Bình", humanSeat: "B" });

    expect(session.getSnapshot()).toMatchObject({ viewerSeat: "B", aiThinking: true, pendingMove: true, turn: "A" });
    expect(timer.setTimeout).toHaveBeenCalledTimes(1);
  });

  it("does not schedule an AI move when the human move ends the game", async () => {
    const timer = scheduler();
    const core = getGameCoreBridge();
    const bridge: GameCoreBridge = {
      ...core,
      createInitialState: () => ({
        ...core.createInitialState(),
        pieces: [
          { id: "A-la-0", player: "A", type: "la", x: 0, y: 7 },
          { id: "B-dam-0", player: "B", type: "dam", x: 8, y: 8 },
        ],
      }),
    };
    const chooseMove = vi.fn(() => ({ from: { x: 8, y: 8 }, to: { x: 7, y: 8 } }));
    const session = new AiSession({ scheduler: timer, chooseMove, local: { bridge } });
    await session.start({ mode: "ai", playerName: "An" });

    const result = await session.move({ x: 0, y: 7 }, { x: 0, y: 8 });
    expect(result).toEqual({ accepted: true });
    expect(session.getSnapshot()).toMatchObject({ phase: "finished", result: { winner: "A", reason: "goal" }, aiThinking: false });
    expect(timer.setTimeout).not.toHaveBeenCalled();
  });
});
