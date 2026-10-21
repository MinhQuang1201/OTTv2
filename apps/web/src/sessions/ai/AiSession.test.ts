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
  const chooseMove = vi.fn(() => ({ from: { x: 4, y: 1 }, to: { x: 5, y: 2 } }));
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

    expect(session.getSnapshot()).toMatchObject({ mode: "ai", viewer: { role: "player", seat: "A" }, viewerSeat: "A", capabilities: { canMove: true, canLeaveGame: false, canSpectate: false }, spectatorCount: 0, aiThinking: false, turn: "A" });
    expect(session.getLegalMoves({ x: 8, y: 6 })).toEqual([]);
    expect((await session.move({ x: 8, y: 6 }, { x: 8, y: 5 })).accepted).toBe(false);
    expect((await session.move({ x: 4, y: 7 }, { x: 3, y: 6 })).accepted).toBe(true);
  });

  it("asks the engine for the chosen level and plays its answer", async () => {
    const timer = scheduler();
    const choose = vi.fn(async () => ({ from: { x: 4, y: 1 }, to: { x: 5, y: 2 } }));
    const engine = { choose, dispose: vi.fn() };
    const session = new AiSession({ scheduler: timer, engine, local: { bridge: getGameCoreBridge() } });
    await session.start({ mode: "ai", playerName: "An", level: "hard" });
    await session.move({ x: 4, y: 7 }, { x: 3, y: 6 });

    timer.runNext();
    await vi.waitFor(() => expect(choose).toHaveBeenCalledTimes(1));
    expect(choose).toHaveBeenCalledWith(expect.anything(), "B", "hard");
    await vi.waitFor(() => expect(session.getSnapshot().aiThinking).toBe(false));
    expect(session.getSnapshot().turn).toBe("A");
    session.dispose();
    expect(engine.dispose).toHaveBeenCalled();
  });

  it("ignores an engine answer that arrives after a new game started", async () => {
    const timer = scheduler();
    let resolveStale!: (move: { from: { x: number; y: number }; to: { x: number; y: number } }) => void;
    const choose = vi.fn(() => new Promise<{ from: { x: number; y: number }; to: { x: number; y: number } }>((resolve) => { resolveStale = resolve; }));
    const session = new AiSession({ scheduler: timer, engine: { choose, dispose: vi.fn() }, local: { bridge: getGameCoreBridge() } });
    await session.start({ mode: "ai", playerName: "An" });
    await session.move({ x: 4, y: 7 }, { x: 3, y: 6 });
    timer.runNext();
    await vi.waitFor(() => expect(choose).toHaveBeenCalled());

    await session.start({ mode: "ai", playerName: "An" });
    resolveStale({ from: { x: 4, y: 1 }, to: { x: 5, y: 2 } });
    await Promise.resolve();
    await Promise.resolve();

    expect(session.getSnapshot().turn).toBe("A");
    expect(session.getSnapshot().events).toHaveLength(0);
    session.dispose();
  });

  it("schedules exactly one AI decision and disables input while thinking", async () => {
    const { deps, timer, chooseMove } = dependencies();
    const session = new AiSession(deps);
    await session.start({ mode: "ai", playerName: "An" });

    await session.move({ x: 4, y: 7 }, { x: 3, y: 6 });
    expect(session.getSnapshot()).toMatchObject({ aiThinking: true, pendingMove: true, turn: "B" });
    expect(timer.setTimeout).toHaveBeenCalledTimes(1);
    expect((await session.move({ x: 5, y: 6 }, { x: 5, y: 5 })).accepted).toBe(false);
    expect(timer.setTimeout).toHaveBeenCalledTimes(1);

    timer.runNext();
    await vi.waitFor(() => expect(chooseMove).toHaveBeenCalledTimes(1));
    expect(chooseMove).toHaveBeenCalledTimes(1);
    expect(chooseMove).toHaveBeenCalledWith(expect.anything(), "B");
    await vi.waitFor(() => expect(session.getSnapshot()).toMatchObject({ aiThinking: false, pendingMove: false, turn: "A" }));
    expect(session.getSnapshot().events.at(-1)).toMatchObject({ type: "move", from: { x: 4, y: 1 }, to: { x: 5, y: 2 } });
  });

  it("cancels pending AI work on leave and dispose", async () => {
    const first = dependencies();
    const leaving = new AiSession(first.deps);
    await leaving.start({ mode: "ai", playerName: "An" });
    await leaving.move({ x: 4, y: 7 }, { x: 3, y: 6 });
    await leaving.leave();
    first.timer.runNext();
    expect(first.chooseMove).not.toHaveBeenCalled();
    expect(first.timer.clearTimeout).toHaveBeenCalledTimes(1);

    const second = dependencies();
    const disposed = new AiSession(second.deps);
    await disposed.start({ mode: "ai", playerName: "An" });
    await disposed.move({ x: 4, y: 7 }, { x: 3, y: 6 });
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
          { id: "A-la-0", player: "A", type: "la", x: 0, y: 1 },
          { id: "B-dam-0", player: "B", type: "dam", x: 8, y: 8 },
        ],
      }),
    };
    const chooseMove = vi.fn(() => ({ from: { x: 8, y: 8 }, to: { x: 7, y: 8 } }));
    const session = new AiSession({ scheduler: timer, chooseMove, local: { bridge } });
    await session.start({ mode: "ai", playerName: "An" });

    const result = await session.move({ x: 0, y: 1 }, { x: 0, y: 0 });
    expect(result).toEqual({ accepted: true });
    expect(session.getSnapshot()).toMatchObject({ phase: "finished", result: { winner: "A", reason: "goal" }, aiThinking: false });
    expect(timer.setTimeout).not.toHaveBeenCalled();
  });

  it("hydrates from practice, schedules AI thinking if current turn is AI seat, and cancels on dispose", async () => {
    const { deps, timer, chooseMove } = dependencies();
    chooseMove.mockReturnValueOnce({ from: { x: 2, y: 0 }, to: { x: 2, y: 1 } });
    const session = new AiSession(deps);
    const practice = {
      practiceId: "practice-ai-1",
      parentMatchId: "match-001",
      parentPly: 5,
      rulesetId: "ottv2-g-default-v1",
      rulesetHash: "sha256:a00ee0cddc9d1dba495babf87bea2184d20feaa964b1741ec06c9bb972fd5e88",
      engineRevision: "sha256:d9cec0298cf11aba83a986223446ad220ec2c390a2b4e63906b4218681a5d164",
      coreState: {
        turn: "B" as const,
        winner: null,
        reason: null,
        eliminatedPlayer: null,
        clock: { remainingMs: { A: 600000, B: 600000 }, runningSeat: "B" as const },
        pieces: [
          { id: "A-la-0", player: "A" as const, type: "la" as const, x: 3, y: 4 },
          { id: "B-la-0", player: "B" as const, type: "la" as const, x: 2, y: 0 },
        ],
      },
    };

    // Human plays A, current turn at practice is B -> AI's turn
    await session.start({ mode: "ai", playerName: "An", humanSeat: "A", practice });
    const snapshot = session.getSnapshot();
    expect(snapshot.turn).toBe("B");
    expect(snapshot.aiThinking).toBe(true);
    expect(timer.setTimeout).toHaveBeenCalledTimes(1);

    // AI timer fires, AI executes move
    timer.runNext();
    await vi.waitFor(() =>
      expect(session.getSnapshot()).toMatchObject({
        turn: "A",
        aiThinking: false,
      })
    );

    // Starting new practice and disposing cancels pending timer
    await session.start({ mode: "ai", playerName: "An", humanSeat: "A", practice });
    expect(timer.pending()).toBe(1);
    session.dispose();
    expect(timer.pending()).toBe(0);
  });

  it("rejects forged practice objects and does not schedule AI thinking", async () => {
    const { deps, timer } = dependencies();
    const session = new AiSession(deps);
    const forgedPractice = {
      practiceId: "forged-ai-1",
      parentMatchId: "match-001",
      parentPly: 5,
      rulesetId: "ottv2-g-default-v1",
      rulesetHash: "sha256:a00ee0cddc9d1dba495babf87bea2184d20feaa964b1741ec06c9bb972fd5e88",
      engineRevision: "sha256:unauthorized-engine",
      coreState: {
        turn: "B" as const,
        winner: "B" as const,
        reason: "goal",
        eliminatedPlayer: null,
        clock: { remainingMs: { A: 600000, B: 600000 }, runningSeat: "B" as const },
        pieces: [{ id: "B-la-0", player: "B" as const, type: "la" as const, x: 8, y: 8 }],
      },
    };
    await session.start({ mode: "ai", playerName: "An", practice: forgedPractice as any });
    expect(session.getSnapshot().phase).toBe("error");
    expect(session.getSnapshot().aiThinking).toBe(false);
    expect(timer.pending()).toBe(0);
    const moveResult = await session.move({ x: 8, y: 8 }, { x: 7, y: 7 });
    expect(moveResult.accepted).toBe(false);
  });

  it("cancels AI thinking timer when session starts a new game before timer fires", async () => {
    const { deps, timer } = dependencies();
    const session = new AiSession(deps);
    const practice = {
      practiceId: "practice-ai-switch",
      parentMatchId: "match-001",
      parentPly: 5,
      rulesetId: "ottv2-g-default-v1",
      rulesetHash: "sha256:a00ee0cddc9d1dba495babf87bea2184d20feaa964b1741ec06c9bb972fd5e88",
      engineRevision: "sha256:d9cec0298cf11aba83a986223446ad220ec2c390a2b4e63906b4218681a5d164",
      coreState: {
        turn: "B" as const,
        winner: null,
        reason: null,
        eliminatedPlayer: null,
        clock: { remainingMs: { A: 600000, B: 600000 }, runningSeat: "B" as const },
        pieces: [
          { id: "A-la-0", player: "A" as const, type: "la" as const, x: 3, y: 4 },
          { id: "B-la-0", player: "B" as const, type: "la" as const, x: 2, y: 0 },
        ],
      },
    };
    await session.start({ mode: "ai", playerName: "An", humanSeat: "A", practice });
    expect(session.getSnapshot().aiThinking).toBe(true);
    expect(timer.pending()).toBe(1);

    // Switch before timer fires to a new standard game
    await session.start({ mode: "ai", playerName: "An", humanSeat: "A" });
    expect(timer.pending()).toBe(0);
    expect(session.getSnapshot().turn).toBe("A");
    expect(session.getSnapshot().aiThinking).toBe(false);
  });
});
