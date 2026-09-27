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
  attachAllocation = vi.fn(async () => undefined);
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
  const runtime = { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn() };
  return new OnlineSession({ gateway, runtime, clientFactory: () => client, host: "https://play.example", now, tickMs: 100 });
}

describe("OnlineSession", () => {
  it("rejects an online snapshot with an invalid viewer seat", () => {
    const normalized = normalizeOnlineState({ ...state(1), you: "invalid" as never });
    expect(normalized).toBeNull();
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
});
