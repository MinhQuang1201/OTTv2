import "../../../../../packages/game-core/src/config.js";
import "../../../../../packages/game-core/src/rules.js";
import "../../../../../packages/game-core/src/ai.js";

import { describe, expect, it, vi } from "vitest";
import { OnlineSession } from "./OnlineSession";
import { normalizeOnlineState } from "./normalizeOnlineState";
import type { OnlineLobbyGateway } from "./OnlineLobbyGateway";
import type { PlayhtmlAllocation, PlayhtmlGameClientLike } from "./globals";

const allocation: PlayhtmlAllocation = { allocationId: "allocation-a", room: "room-a", seat: "A", ticket: "ticket", resumeCredential: "resume" };

function state(revision: number, x = 0, remainingMs = 600_000) {
  return { roomId: "room-a", revision, you: "A" as const, status: "playing" as const, state: {
    turn: "A" as const, winner: null, reason: null, clock: { remainingMs: { A: remainingMs, B: 600_000 }, runningSeat: "A" as const },
    pieces: [{ id: "a-dam", player: "A" as const, type: "dam" as const, x, y: 2 }],
  } };
}

class FakeClient implements PlayhtmlGameClientLike {
  readonly handlers = new Map<string, Set<(payload?: unknown) => void>>();
  readonly move = vi.fn(() => true);
  readonly leave = vi.fn(() => true);
  readonly close = vi.fn();
  attachAllocation = vi.fn(async () => true);
  on = (event: string, listener: (payload?: unknown) => void) => {
    const listeners = this.handlers.get(event) ?? new Set();
    listeners.add(listener);
    this.handlers.set(event, listeners);
    return () => listeners.delete(listener);
  };
  emit(event: string, payload?: unknown) { this.handlers.get(event)?.forEach((listener) => listener(payload)); }
}

function sessionWith(client: FakeClient, now = () => 0) {
  const gateway = { available: true, createRoom: vi.fn(async () => allocation), joinRoom: vi.fn(async () => allocation) } as unknown as OnlineLobbyGateway;
  const runtime = { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) };
  return new OnlineSession({ gateway, runtime, clientFactory: () => client, host: "https://play.example", now, tickMs: 100 });
}

describe("OnlineSession", () => {
  it("rejects an online snapshot with an invalid viewer seat", () => {
    const normalized = normalizeOnlineState({ ...state(1), you: "invalid" as never });
    expect(normalized).toBeNull();
  });

  it("preserves player viewerSeat identity and capabilities during waiting phase", () => {
    const normalized = normalizeOnlineState({ ...state(1), status: "waiting", you: "A" });
    expect(normalized).not.toBeNull();
    expect(normalized?.snapshot.phase).toBe("waiting");
    expect(normalized?.snapshot.viewerSeat).toBe("A");
    expect(normalized?.snapshot.viewer).toEqual({ role: "player", seat: "A" });
    expect(normalized?.snapshot.capabilities).toEqual({
      canMove: true,
      canLeaveGame: true,
      canSpectate: false,
    });
  });

  it("retains viewer identity in waiting phase while blocking moves and enabling player leave", async () => {
    const client = new FakeClient();
    const session = sessionWith(client);
    await session.start({ mode: "online", intent: "create", playerName: "An" });
    client.emit("state", { ...state(1), status: "waiting", you: "A" });

    const snapshot = session.getSnapshot();
    expect(snapshot.phase).toBe("waiting");
    expect(snapshot.viewerSeat).toBe("A");
    expect(snapshot.viewer).toEqual({ role: "player", seat: "A" });
    expect(snapshot.capabilities).toEqual({ canMove: true, canLeaveGame: true, canSpectate: false });

    expect(session.getLegalMoves({ x: 0, y: 2 })).toEqual([]);
    const moveResult = await session.move({ x: 0, y: 2 }, { x: 0, y: 1 });
    expect(moveResult.accepted).toBe(false);
    expect(client.move).not.toHaveBeenCalled();

    await session.leave();
    expect(client.leave).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().result).toEqual({ winner: "B", reason: "leave" });
  });

  it("maps public lifecycle events and delegates create/join without owning transport state", async () => {
    const client = new FakeClient();
    const session = sessionWith(client);
    await session.start({ mode: "online", intent: "create", playerName: "An" });
    client.emit("joined", { roomId: "room-a", you: "A" });
    expect(session.getSnapshot()).toMatchObject({ phase: "waiting", roomId: "room-a", viewer: null, viewerSeat: null, capabilities: { canMove: false, canLeaveGame: false, canSpectate: false }, spectatorCount: 0, connection: "online" });
    client.emit("state", state(1));
    expect(session.getSnapshot()).toMatchObject({ phase: "playing", viewer: { role: "player", seat: "A" }, viewerSeat: "A", capabilities: { canMove: true, canLeaveGame: true, canSpectate: false }, spectatorCount: 0, board: [{ id: "a-dam", position: { x: 0, y: 2 } }] });
    client.emit("reconnecting");
    expect(session.getSnapshot().connection).toBe("reconnecting");
    client.emit("resumed");
    expect(session.getSnapshot().connection).toBe("online");
    expect(client.attachAllocation).toHaveBeenCalledWith(allocation);
  });

  it("uses safe explicit defaults while preparing and after an error", async () => {
    const client = new FakeClient();
    const session = sessionWith(client);
    await session.start({ mode: "online", intent: "create", playerName: "An" });
    expect(session.getSnapshot()).toMatchObject({ phase: "preparing", viewer: null, viewerSeat: null, capabilities: { canMove: false, canLeaveGame: false, canSpectate: false }, spectatorCount: 0 });
    client.emit("error", { message: "not available" });
    expect(session.getSnapshot()).toMatchObject({ phase: "error", viewer: null, viewerSeat: null, capabilities: { canMove: false, canLeaveGame: false, canSpectate: false } });
  });

  it("cleans a client and clock after an asynchronous start failure", async () => {
    const client = new FakeClient();
    const callbacks = new Set<() => void>();
    const clearInterval = vi.fn((handle) => callbacks.delete(handle as unknown as () => void));
    client.attachAllocation = vi.fn(async () => { throw new Error("attach failed"); });
    const session = new OnlineSession({
      gateway: { available: true, createRoom: vi.fn(async () => allocation) } as unknown as OnlineLobbyGateway,
      runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) },
      clientFactory: () => client,
      host: "https://play.example",
      setInterval: vi.fn((callback: () => void) => { callbacks.add(callback); return callback as any; }),
      clearInterval,
    });

    await session.start({ mode: "online", intent: "create", playerName: "An" });
    client.emit("state", state(1));
    callbacks.forEach((callback) => callback());

    expect(session.getSnapshot().phase).toBe("error");
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(clearInterval).not.toHaveBeenCalled();
    expect(client.handlers.get("state")?.size).toBe(0);
  });

  it("fails startup when attachAllocation reports that the attach was not sent", async () => {
    const client = new FakeClient();
    client.attachAllocation = vi.fn(async () => false);
    const session = sessionWith(client);

    await session.start({ mode: "online", intent: "create", playerName: "An" });

    expect(session.getSnapshot()).toMatchObject({ phase: "error", connection: "unavailable", error: { code: "connection_failed" } });
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(client.handlers.get("state")?.size).toBe(0);
  });

  it("stops display clock mutation while the connection is reconnecting or errored", async () => {
    let performanceCurrent = 0;
    const callbacks = new Set<() => void>();
    const clearInterval = vi.fn((handle) => callbacks.delete(handle as unknown as () => void));
    const client = new FakeClient();
    const session = new OnlineSession({
      gateway: { available: true, createRoom: vi.fn(async () => allocation) } as unknown as OnlineLobbyGateway,
      runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) },
      clientFactory: () => client,
      host: "https://play.example",
      performanceNow: () => performanceCurrent,
      setInterval: vi.fn((callback: () => void) => { callbacks.add(callback); return callback as any; }),
      clearInterval,
    });

    await session.start({ mode: "online", intent: "create", playerName: "An" });
    client.emit("state", state(1));
    const remaining = session.getSnapshot().players.A?.remainingMs;
    client.emit("reconnecting");
    performanceCurrent = 10_000;
    callbacks.forEach((callback) => callback());

    expect(session.getSnapshot().connection).toBe("reconnecting");
    expect(session.getSnapshot().players.A?.remainingMs).toBe(remaining);
    expect(clearInterval).toHaveBeenCalledTimes(1);
  });

  it("filters stale revisions and duplicate event IDs, and changes the board only from newer state", async () => {
    const client = new FakeClient();
    const session = sessionWith(client);
    await session.start({ mode: "online", intent: "join", playerName: "An", roomId: "room-a" });
    client.emit("state", { ...state(2), events: [{ id: 7, type: "move", pieceId: "a-dam", from: { x: 0, y: 2 }, to: { x: 0, y: 1 } }] });
    const before = session.getSnapshot();
    expect((await session.move({ x: 0, y: 2 }, { x: 0, y: 1 })).accepted).toBe(true);
    expect(session.getSnapshot().board).toEqual(before.board);
    expect(client.move).toHaveBeenCalledWith({ x: 0, y: 2 }, { x: 0, y: 1 });
    client.emit("state", { ...state(1, 4), events: [{ id: 7, type: "move", pieceId: "a-dam", from: { x: 0, y: 2 }, to: { x: 4, y: 2 } }] });
    expect(session.getSnapshot().board[0]?.position).toEqual({ x: 0, y: 2 });
    client.emit("state", { ...state(3, 1), events: [{ id: 7, type: "move", pieceId: "a-dam", from: { x: 0, y: 2 }, to: { x: 1, y: 2 } }, { id: 8, type: "move", pieceId: "a-dam", from: { x: 0, y: 2 }, to: { x: 1, y: 2 } }] });
    expect(session.getSnapshot().board[0]?.position).toEqual({ x: 1, y: 2 });
    expect(session.getSnapshot().events.filter((event) => event.id === 7)).toHaveLength(1);
  });

  it("publishes display-only clock ticks, delegates leave, and disposes listeners and timers", async () => {
    let current = 0;
    let performanceCurrent = 0;
    const callbacks = new Set<() => void>();
    const client = new FakeClient();
    const session = new OnlineSession({
      ...({ gateway: { available: true, createRoom: vi.fn(async () => allocation) }, runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn() }, clientFactory: () => client, host: "https://play.example" } as object),
      now: () => current,
      performanceNow: () => performanceCurrent,
      setInterval: vi.fn((callback: () => void) => { callbacks.add(callback); return callback as unknown as ReturnType<typeof globalThis.setInterval>; }),
      clearInterval: vi.fn((handle) => callbacks.delete(handle as unknown as () => void)),
    });
    await session.start({ mode: "online", intent: "create", playerName: "An" });
    client.emit("state", state(1));
    const revision = session.getSnapshot().boardRevision;
    performanceCurrent = 1_000;
    callbacks.forEach((callback) => callback());
    expect(session.getSnapshot().players.A?.remainingMs).toBe(599_000);
    expect(session.getSnapshot().boardRevision).toBe(revision);
    await session.leave();
    expect(client.leave).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().result).toEqual({ winner: "B", reason: "leave" });
    session.dispose();
    expect(client.close).toHaveBeenCalledTimes(1);
    client.emit("state", state(2, 2));
    expect(session.getSnapshot().board[0]?.position).toEqual({ x: 0, y: 2 });
  });

  it("does not create or attach a client when disposed during allocation", async () => {
    let resolveAllocation!: (value: PlayhtmlAllocation) => void;
    const allocationPromise = new Promise<PlayhtmlAllocation>((resolve) => { resolveAllocation = resolve; });
    const clientFactory = vi.fn(() => new FakeClient());
    const runtime = { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) };
    const gateway = { available: true, createRoom: vi.fn(() => allocationPromise) } as unknown as OnlineLobbyGateway;
    const session = new OnlineSession({ gateway, runtime, clientFactory, host: "https://play.example" });

    const start = session.start({ mode: "online", intent: "create", playerName: "An" });
    await Promise.resolve();
    await session.dispose();
    resolveAllocation(allocation);
    await start;

    expect(clientFactory).not.toHaveBeenCalled();
    expect((session as any).allocation).toBeNull();
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });

  it("does not let an older start overwrite a newer allocation", async () => {
    let resolveFirst!: (value: PlayhtmlAllocation) => void;
    const firstAllocation = { ...allocation, allocationId: "allocation-first", room: "room-first" };
    const secondAllocation = { ...allocation, allocationId: "allocation-second", room: "room-second" };
    const firstRequest = new Promise<PlayhtmlAllocation>((resolve) => { resolveFirst = resolve; });
    const client = new FakeClient();
    const gateway = {
      available: true,
      createRoom: vi.fn(() => firstRequest),
      joinRoom: vi.fn(async () => secondAllocation),
    } as unknown as OnlineLobbyGateway;
    const session = new OnlineSession({
      gateway,
      runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) },
      clientFactory: () => client,
      host: "https://play.example",
    });

    const firstStart = session.start({ mode: "online", intent: "create", playerName: "A" });
    await Promise.resolve();
    const secondStart = session.start({ mode: "online", intent: "join", playerName: "B", roomId: "room-second" });
    await secondStart;
    resolveFirst(firstAllocation);
    await firstStart;
    client.emit("joined", { roomId: "room-second" });

    expect(client.attachAllocation).toHaveBeenCalledTimes(1);
    expect(client.attachAllocation).toHaveBeenCalledWith(secondAllocation);
    expect(session.getSnapshot().roomId).toBe("room-second");
  });

  it("invalidates transport callbacks and state after terminal gameover", async () => {
    const client = new FakeClient();
    const session = sessionWith(client);
    await session.start({ mode: "online", intent: "create", playerName: "An" });
    client.emit("state", state(1));
    const finalBoard = session.getSnapshot().board;
    client.emit("gameover", { winner: "A", reason: "goal" });
    client.emit("state", state(2, 4));
    client.emit("open");
    client.emit("error", { message: "late error" });

    expect(session.getSnapshot().phase).toBe("finished");
    expect(session.getSnapshot().connection).toBe("offline");
    expect(session.getSnapshot().board).toEqual(finalBoard);
    expect(session.getSnapshot().error).toBeNull();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("leaves the shared runtime to its explicit lifecycle owner", async () => {
    const client = new FakeClient();
    const runtime = { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) };
    const session = new OnlineSession({
      gateway: { available: true, createRoom: vi.fn(async () => allocation) } as unknown as OnlineLobbyGateway,
      runtime,
      clientFactory: () => client,
      host: "https://play.example",
      disposeRuntime: false,
    } as any);

    await session.start({ mode: "online", intent: "create", playerName: "An" });
    await session.dispose();

    expect(runtime.dispose).not.toHaveBeenCalled();
  });
});
