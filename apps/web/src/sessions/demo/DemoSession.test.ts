import { describe, expect, it, vi } from "vitest";
import type { DemoScenario } from "../../shared/model/game";

import { DemoSession } from "./DemoSession";
import { freezeFixture } from "./fixtureBuilders";
import { createScenarioFixture, DEMO_SCENARIOS } from "./scenarios";

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

  it("keeps lobby leave and finished moves as no-op commands", async () => {
    const lobby = new DemoSession("lobby-default");
    const lobbyBefore = lobby.getSnapshot();
    await lobby.leave();
    expect(lobby.getSnapshot()).toBe(lobbyBefore);

    const finished = new DemoSession("result-goal");
    const finishedBefore = finished.getSnapshot();
    const result = await finished.move({ x: 0, y: 2 }, { x: 0, y: 1 });
    expect(result).toMatchObject({ accepted: false, error: { code: "session_failed" } });
    expect(finished.getSnapshot()).toBe(finishedBefore);
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

  it("removes the losing attacker on strike loss without duplicating the defender", async () => {
    const session = new DemoSession("game-strike-loss");
    const beforeRevision = session.getSnapshot().boardRevision;

    const result = await session.move({ x: 1, y: 2 }, { x: 6, y: 5 });
    const snapshot = session.getSnapshot();

    expect(result).toEqual({ accepted: true });
    expect(snapshot.board.filter(({ position }) => position.x === 6 && position.y === 5)).toHaveLength(1);
    expect(snapshot.board.find(({ id }) => id === "B-la-1")?.position).toEqual({ x: 6, y: 5 });
    expect(snapshot.board.some(({ id }) => id === "A-dam-0")).toBe(false);
    expect(snapshot.boardRevision).toBe(beforeRevision + 1);
    expect(snapshot.events.at(-1)).toMatchObject({
      id: 2,
      type: "strike_loss",
      pieceId: "A-dam-0",
      byId: "B-la-1",
    });
  });

  it("updates both player counts for capture and strike-loss transitions", async () => {
    const capture = new DemoSession("game-capture");
    await capture.move({ x: 1, y: 2 }, { x: 6, y: 5 });
    expect(capture.getSnapshot().players.B?.counts.la).toBe(2);
    expect(capture.getSnapshot().players.A?.counts.dam).toBe(3);

    const strike = new DemoSession("game-strike-loss");
    await strike.move({ x: 1, y: 2 }, { x: 6, y: 5 });
    expect(strike.getSnapshot().players.A?.counts.dam).toBe(2);
    expect(strike.getSnapshot().players.B?.counts.la).toBe(3);
  });

  it("exposes explicit waiting-room data only for the rooms lobby", () => {
    const rooms = new DemoSession("lobby-rooms").getSnapshot();
    expect(rooms.waitingRooms).toEqual([
      { roomId: "DEMO-17", hostName: "Chi", playerCount: 1, maxPlayers: 2 },
      { roomId: "DEMO-23", hostName: "Dũng", playerCount: 1, maxPlayers: 2 },
    ]);
    expect(new DemoSession("lobby-default").getSnapshot().waitingRooms).toEqual([]);
  });

  it("freezes the complete fixture graph and validates scenario keys", () => {
    const fixture = createScenarioFixture("game-move-rejected");
    expect(Object.isFrozen(fixture)).toBe(true);
    expect(Object.isFrozen(fixture.moves)).toBe(true);
    expect(Object.isFrozen(fixture.moves[0])).toBe(true);
    expect(Object.isFrozen(fixture.rejectMoves)).toBe(true);
    expect(() => createScenarioFixture("not-a-scenario" as never)).toThrow(/Unknown demo scenario/);
  });

  it("covers category-specific scenario state and result reasons", () => {
    expect(new DemoSession("lobby-online-unavailable").getSnapshot()).toMatchObject({ connection: "unavailable", error: { code: "online_unavailable" } });
    expect(new DemoSession("lobby-online-connecting").getSnapshot()).toMatchObject({ phase: "preparing", connection: "connecting" });
    expect(new DemoSession("game-waiting").getSnapshot()).toMatchObject({ phase: "waiting", turn: null });
    expect(new DemoSession("game-piece-selected").getSnapshot()).toMatchObject({ pendingMove: false, turn: "A" });
    expect(new DemoSession("game-ai-thinking").getSnapshot()).toMatchObject({ aiThinking: true, turn: "A" });
    expect(new DemoSession("game-reconnecting").getSnapshot()).toMatchObject({ connection: "reconnecting", players: { B: { connected: false } } });
    expect(new DemoSession("game-clock-warning").getSnapshot().players.A?.remainingMs).toBe(35_000);
    expect(new DemoSession("game-recoverable-error").getSnapshot()).toMatchObject({ phase: "error", error: { retryable: true } });

    const reasons = ["goal", "elimination", "no_moves", "timeout", "disconnect_timeout", "leave"] as const;
    for (const reason of reasons) {
      const scenario = `result-${reason.replace("_", "-")}` as DemoScenario;
      const snapshot = new DemoSession(scenario).getSnapshot();
      expect(snapshot.result?.reason).toBe(reason);
      expect(snapshot.events.at(-1)).toMatchObject({ type: "win", reason });
    }
  });

  it("preserves event continuity across start and leave transitions", async () => {
    const session = new DemoSession("game-active-a");
    const listener = vi.fn();
    session.subscribe(listener);
    await session.start({ mode: "demo", scenario: "result-goal" });
    const started = session.getSnapshot();
    await session.leave();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot()).toBe(started);

    const playing = new DemoSession("game-active-a");
    await playing.start({ mode: "demo", scenario: "game-capture" });
    expect(playing.getSnapshot().events.at(-1)?.id).toBeGreaterThan(0);
    await playing.leave();
    expect(playing.getSnapshot().events.at(-1)?.id).toBeGreaterThan(1);
  });

  it("clears legal destinations after leave and dispose", async () => {
    const session = new DemoSession("game-active-a");
    expect(session.getLegalMoves({ x: 0, y: 2 })).toEqual([{ x: 0, y: 1 }]);
    await session.leave();
    expect(session.getLegalMoves({ x: 0, y: 2 })).toEqual([]);

    const disposed = new DemoSession("game-active-a");
    disposed.dispose();
    expect(disposed.getLegalMoves({ x: 0, y: 2 })).toEqual([]);
  });

  it("freezes the scenario registry and recursively freezes shallow-frozen parents", () => {
    expect(Object.isFrozen(DEMO_SCENARIOS)).toBe(true);
    const child = { value: { ok: true } };
    const parent = Object.freeze({ child });
    freezeFixture(parent);
    expect(Object.isFrozen(parent.child)).toBe(true);
    expect(Object.isFrozen(parent.child.value)).toBe(true);
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
