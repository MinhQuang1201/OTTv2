import "../../../../../packages/game-core/src/config.js";
import "../../../../../packages/game-core/src/rules.js";
import "../../../../../packages/game-core/src/ai.js";

import { describe, expect, it, vi } from "vitest";
import { OnlineSession } from "./OnlineSession";
import { normalizeOnlineState } from "./normalizeOnlineState";
import type { OnlineLobbyGateway } from "./OnlineLobbyGateway";
import type { PlayhtmlAllocation, PlayhtmlGameClientLike } from "./globals";
import type { PendingOnlineGame, ResumeStore } from "./resumeStore";

function state(revision: number, status: "waiting" | "playing" | "done" = "playing", players: Record<string, unknown> = { A: { name: "An", connected: true }, B: { name: "Bình", connected: true } }) {
  return { roomId: "ott-alloc-1", revision, you: "A" as const, status, players, state: {
    turn: "A" as const, winner: status === "done" ? "A" as const : null, reason: status === "done" ? "goal" as const : null,
    clock: { remainingMs: { A: 600_000, B: 600_000 }, runningSeat: "A" as const },
    pieces: [{ id: "a-dam", player: "A" as const, type: "dam" as const, x: 0, y: 2 }],
  } };
}

class FakeClient implements PlayhtmlGameClientLike {
  readonly handlers = new Map<string, Set<(payload?: unknown) => void>>();
  readonly move = vi.fn(() => true);
  readonly leave = vi.fn(() => true);
  readonly close = vi.fn();
  attachAllocation = vi.fn(async (_allocation: PlayhtmlAllocation) => true);
  on = (event: string, listener: (payload?: unknown) => void) => {
    const listeners = this.handlers.get(event) ?? new Set();
    listeners.add(listener);
    this.handlers.set(event, listeners);
    return () => listeners.delete(listener);
  };
  emit(event: string, payload?: unknown) { this.handlers.get(event)?.forEach((listener) => listener(payload)); }
}

function memoryStore(initial: PendingOnlineGame | null = null): ResumeStore & { value: PendingOnlineGame | null } {
  return {
    value: initial,
    read() { return this.value; },
    write(game) { this.value = game; },
    clear() { this.value = null; },
  };
}

const allocation = (overrides: Partial<PlayhtmlAllocation> = {}): PlayhtmlAllocation => ({
  allocationId: "alloc-1", room: "ott-alloc-1", seat: "A", ticket: "ticket-1", resumeCredential: "cred-1", alias: "K7N-M4P", ...overrides,
});

function harness(options: { store?: ReturnType<typeof memoryStore>; resumeRoom?: ReturnType<typeof vi.fn> } = {}) {
  const clients: FakeClient[] = [];
  const timers: Array<{ handler: () => void; ms: number; cleared: boolean }> = [];
  const store = options.store ?? memoryStore();
  let credential = 1;
  const resumeRoom = options.resumeRoom ?? vi.fn(async () => allocation({ ticket: `ticket-${++credential}`, resumeCredential: `cred-${credential}`, alias: undefined }));
  const gateway = {
    available: true,
    createRoom: vi.fn(async () => allocation()),
    joinRoom: vi.fn(async () => allocation({ seat: "B" })),
    resumeRoom,
  } as unknown as OnlineLobbyGateway;
  const runtime = { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) };
  const session = new OnlineSession({
    gateway,
    runtime,
    clientFactory: () => { const client = new FakeClient(); clients.push(client); return client; },
    host: "https://play.example",
    resumeStore: store,
    attachTimeoutMs: 8_000,
    maxAttachRetries: 2,
    setTimeout: ((handler: () => void, ms: number) => { timers.push({ handler, ms, cleared: false }); return timers.length - 1; }) as never,
    clearTimeout: ((handle: number) => { if (timers[handle]) timers[handle]!.cleared = true; }) as never,
  });
  const fireLatestTimer = async () => {
    const timer = [...timers].reverse().find((item) => !item.cleared);
    if (!timer) throw new Error("no pending timer");
    timer.cleared = true;
    timer.handler();
    await vi.waitFor(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { session, clients, timers, store, gateway, resumeRoom, fireLatestTimer };
}

describe("OnlineSession recovery", () => {
  it("saves the game for a later reload, including the alias, and forgets it when the game ends", async () => {
    const { session, clients, store } = harness();
    await session.start({ mode: "online", intent: "create", playerName: "An" });
    expect(store.value).toMatchObject({ allocationId: "alloc-1", seat: "A", resumeCredential: "cred-1", alias: "K7N-M4P", playerName: "An" });

    clients[0]!.emit("state", state(1, "waiting", { A: { name: "An", connected: true }, B: null }));
    expect(session.getSnapshot().roomAlias).toBe("K7N-M4P");
    clients[0]!.emit("state", state(2, "done"));
    expect(session.getSnapshot().phase).toBe("finished");
    expect(store.value).toBeNull();
  });

  it("forgets the saved game when the player leaves", async () => {
    const { session, clients, store } = harness();
    await session.start({ mode: "online", intent: "create", playerName: "An" });
    clients[0]!.emit("state", state(1));
    await session.leave();
    expect(store.value).toBeNull();
  });

  it("re-enters a saved game with intent resume and keeps the rotated credential and earlier alias", async () => {
    const saved: PendingOnlineGame = { allocationId: "alloc-1", room: "ott-alloc-1", seat: "A", resumeCredential: "cred-old", alias: "K7N-M4P", playerName: "An", savedAt: 0 };
    const store = memoryStore(saved);
    const resumeRoom = vi.fn(async () => allocation({ ticket: "ticket-new", resumeCredential: "cred-new", alias: undefined }));
    const { session, clients } = harness({ store, resumeRoom });
    await session.start({ mode: "online", intent: "resume", playerName: "An", allocationId: "alloc-1", resumeCredential: "cred-old" });

    expect(resumeRoom).toHaveBeenCalledWith("alloc-1", "cred-old");
    expect(clients[0]!.attachAllocation).toHaveBeenCalledWith(expect.objectContaining({ ticket: "ticket-new" }));
    expect(store.value).toMatchObject({ resumeCredential: "cred-new", alias: "K7N-M4P" });
    clients[0]!.emit("state", state(5));
    expect(session.getSnapshot()).toMatchObject({ phase: "playing", viewerSeat: "A", roomAlias: "K7N-M4P" });
  });

  it("clears a saved game the server will never resume and shows a readable error", async () => {
    const store = memoryStore({ allocationId: "alloc-1", room: "ott-alloc-1", seat: "A", resumeCredential: "cred-old", alias: null, playerName: "An", savedAt: 0 });
    const rejected = Object.assign(new Error("resume_rejected"), { code: "resume_rejected", status: 401 });
    const { session } = harness({ store, resumeRoom: vi.fn(async () => { throw rejected; }) });
    await session.start({ mode: "online", intent: "resume", playerName: "An", allocationId: "alloc-1", resumeCredential: "cred-old" });

    expect(store.value).toBeNull();
    expect(session.getSnapshot()).toMatchObject({ phase: "error", error: { message: "Không thể vào lại ván này. Có thể ván đã kết thúc.", retryable: true } });
  });

  it("retries an unanswered attach with a fresh ticket, then fails visibly instead of hanging", async () => {
    const { session, clients, resumeRoom, fireLatestTimer } = harness();
    await session.start({ mode: "online", intent: "create", playerName: "An" });
    expect(session.getSnapshot().phase).toBe("preparing");

    await fireLatestTimer();
    expect(resumeRoom).toHaveBeenCalledTimes(1);
    expect(clients).toHaveLength(2);
    expect(clients[0]!.close).toHaveBeenCalled();
    expect(clients[1]!.attachAllocation).toHaveBeenCalledWith(expect.objectContaining({ ticket: "ticket-2" }));

    await fireLatestTimer();
    expect(resumeRoom).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot().phase).toBe("preparing");

    await fireLatestTimer();
    expect(resumeRoom).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot()).toMatchObject({ phase: "error", error: { code: "connection_failed", message: "Không kết nối được vào phòng. Hãy thử lại.", retryable: true } });
  });

  it("stops the attach watchdog as soon as the first snapshot arrives", async () => {
    const { session, clients, timers, resumeRoom } = harness();
    await session.start({ mode: "online", intent: "create", playerName: "An" });
    clients[0]!.emit("state", state(1, "waiting", { A: { name: "An", connected: true }, B: null }));
    expect(timers.every((timer) => timer.cleared)).toBe(true);
    expect(resumeRoom).not.toHaveBeenCalled();
    expect(session.getSnapshot().phase).toBe("waiting");
  });

  it("keeps the saved credential in step when the client resumes by itself after a network drop", async () => {
    const clientOptions: Array<Record<string, unknown>> = [];
    const store = memoryStore();
    const resumeRoom = vi.fn(async () => allocation({ ticket: "ticket-auto", resumeCredential: "cred-auto", alias: undefined }));
    const session = new OnlineSession({
      gateway: { available: true, createRoom: vi.fn(async () => allocation()), resumeRoom } as unknown as OnlineLobbyGateway,
      runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) },
      clientFactory: (options) => { clientOptions.push(options); return new FakeClient(); },
      host: "https://play.example",
      resumeStore: store,
      setTimeout: (() => 0) as never,
      clearTimeout: (() => undefined) as never,
    });
    await session.start({ mode: "online", intent: "create", playerName: "An" });
    const controlRequest = clientOptions[0]!.controlRequest as (action: string, body?: unknown) => Promise<unknown>;
    await controlRequest("resume", { allocationId: "alloc-1", resumeCredential: "cred-1" });
    expect(store.value).toMatchObject({ resumeCredential: "cred-auto", alias: "K7N-M4P" });
  });
});

describe("normalizeOnlineState while waiting for the second player", () => {
  it("leaves the empty seat out and gives nobody the turn", () => {
    const normalized = normalizeOnlineState(state(1, "waiting", { A: { name: "An", connected: true }, B: null }));
    expect(normalized?.snapshot.phase).toBe("waiting");
    expect(normalized?.snapshot.players.B).toBeUndefined();
    expect(normalized?.snapshot.players.A?.name).toBe("An");
    expect(normalized?.snapshot.turn).toBeNull();
  });
});
