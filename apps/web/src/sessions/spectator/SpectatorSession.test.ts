import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpectatorSession } from "./SpectatorSession";

class FakeSpectatorClient {
  readonly handlers: Record<string, Array<(payload?: unknown) => void>> = {};
  readonly sent: unknown[] = [];
  readonly attachCalls: unknown[] = [];
  attached: unknown = null;
  closed = false;

  on(event: string, handler: (payload?: unknown) => void) {
    (this.handlers[event] || (this.handlers[event] = [])).push(handler);
    return () => {
      this.handlers[event] = (this.handlers[event] || []).filter((h) => h !== handler);
    };
  }

  emit(event: string, payload?: unknown) {
    for (const handler of this.handlers[event] || []) handler(payload);
  }

  attachSpectator(allocation: unknown) {
    this.attached = allocation;
    this.attachCalls.push(allocation);
    return Promise.resolve(true);
  }

  send(type: string, payload?: unknown) {
    this.sent.push({ type, payload });
    return true;
  }

  close() {
    this.closed = true;
  }
}

describe("SpectatorSession", () => {
  beforeEach(() => {
    globalThis.OTT_PLAYHTML_HOST = "https://play.example";
  });

  afterEach(() => {
    delete globalThis.OTT_PLAYHTML_HOST;
  });

  const allocation = {
    allocationId: "alloc-1",
    room: "ott-alloc-1",
    ticket: "spec-ticket-1",
  };
  const spectatorOptions = () => ({ mode: "spectator" as const, allocation });
  const reconnect = async (client: FakeSpectatorClient) => {
    client.emit("close");
    client.emit("open");
    await new Promise((resolve) => setTimeout(resolve, 220));
  };
  const flush = async () => {
    for (let index = 0; index < 6; index++) await Promise.resolve();
  };

  const sampleStateMessage = (revision: number) => ({
    revision,
    roomId: "ott-alloc-1",
    status: "playing" as const,
    viewer: { role: "spectator" as const },
    spectatorCount: 5,
    players: {
      A: { name: "Đỏ", connected: true },
      B: { name: "Xanh", connected: true },
    },
    state: {
      turn: "A",
      winner: null,
      reason: null,
      clock: { remainingMs: { A: 600000, B: 600000 }, runningSeat: "A" },
      pieces: [
        { id: "p1", player: "A", type: "dam", x: 0, y: 2 },
        { id: "p2", player: "B", type: "la", x: 8, y: 6 },
      ],
    },
  });

  it("starts in spectator mode and configures read-only capabilities", async () => {
    const client = new FakeSpectatorClient();
    const gateway = {
      available: true,
      getSpectatorTicket: vi.fn(async () => allocation),
    };
    const runtime = {
      bootstrap: vi.fn(async () => undefined),
      connectionFactory: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };

    const session = new SpectatorSession({
      gateway: gateway as any,
      runtime: runtime as any,
      clientFactory: () => client as any,
    });

    await session.start(spectatorOptions());

    expect(runtime.bootstrap).toHaveBeenCalledWith({
      host: expect.any(String),
      room: "ott-alloc-1",
      party: "main",
    });
    expect(gateway.getSpectatorTicket).not.toHaveBeenCalled();
    expect(client.attached).toEqual(allocation);

    client.emit("open");
    expect(session.getSnapshot().connection).toBe("online");

    client.emit("state", sampleStateMessage(1));
    const snapshot = session.getSnapshot();
    expect(snapshot.mode).toBe("spectator");
    expect(snapshot.viewer).toEqual({ role: "spectator" });
    expect(snapshot.viewerSeat).toBeNull();
    expect(snapshot.capabilities).toEqual({
      canMove: false,
      canLeaveGame: false,
      canSpectate: true,
    });
    expect(snapshot.spectatorCount).toBe(5);
    expect(snapshot.board).toHaveLength(2);

    // Read only verification
    expect(session.getLegalMoves({ x: 0, y: 2 })).toEqual([]);
    const moveResult = await session.move({ x: 0, y: 2 }, { x: 0, y: 3 });
    expect(moveResult.accepted).toBe(false);

    // Leave does not send leave command
    await session.leave();
    expect(client.sent).toHaveLength(0);
    expect(session.getSnapshot().phase).toBe("finished");

    // Dispose
    await session.dispose();
    expect(client.closed).toBe(true);
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });

  it("fails closed without an explicit PlayHTML host", async () => {
    const bootstrap = vi.fn(async () => undefined);
    const clientFactory = vi.fn(() => new FakeSpectatorClient());
    const session = new SpectatorSession({
      gateway: { available: true } as any,
      runtime: { bootstrap, connectionFactory: vi.fn(), dispose: vi.fn() } as any,
      clientFactory: clientFactory as any,
      host: "",
    });

    await session.start(spectatorOptions());

    expect(session.getSnapshot().error?.code).toBe("online_unavailable");
    expect(bootstrap).not.toHaveBeenCalled();
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("cleans bindings when spectator startup attach rejects", async () => {
    const client = new FakeSpectatorClient();
    client.attachSpectator = vi.fn(async () => { throw new Error("attach failed"); });
    const session = new SpectatorSession({
      gateway: { available: true } as any,
      runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
      clientFactory: () => client as any,
      host: "https://play.example",
    });

    await session.start(spectatorOptions());

    expect(session.getSnapshot().error?.code).toBe("online_unavailable");
    expect(client.closed).toBe(true);
    expect(Object.values(client.handlers).every((handlers) => handlers.length === 0)).toBe(true);
  });

  it("tears down transport and clock state after a retryable attach failure", async () => {
    const client = new FakeSpectatorClient();
    const callbacks = new Set<() => void>();
    const clearInterval = vi.fn((handle) => callbacks.delete(handle as unknown as () => void));
    const session = new SpectatorSession({
      gateway: { available: true } as any,
      runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
      clientFactory: () => client as any,
      host: "https://play.example",
      setInterval: vi.fn((callback: () => void) => { callbacks.add(callback); return callback as any; }),
      clearInterval,
    });

    await session.start(spectatorOptions());
    client.emit("state", sampleStateMessage(1));
    client.emit("error", { status: 503, code: "overloaded" });
    const board = session.getSnapshot().board;
    callbacks.forEach((callback) => callback());

    expect(session.getSnapshot().error?.code).toBe("online_unavailable");
    expect(session.getSnapshot().board).toEqual(board);
    expect(client.closed).toBe(true);
    expect(clearInterval).toHaveBeenCalledTimes(1);
    expect(Object.values(client.handlers).every((handlers) => handlers.length === 0)).toBe(true);
  });

  it("stops the display clock while reconnecting", async () => {
    let performanceCurrent = 0;
    const callbacks = new Set<() => void>();
    const clearInterval = vi.fn((handle) => callbacks.delete(handle as unknown as () => void));
    const client = new FakeSpectatorClient();
    const session = new SpectatorSession({
      gateway: { available: true } as any,
      runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
      clientFactory: () => client as any,
      performanceNow: () => performanceCurrent,
      setInterval: vi.fn((callback: () => void) => { callbacks.add(callback); return callback as any; }),
      clearInterval,
    });

    await session.start(spectatorOptions());
    client.emit("state", sampleStateMessage(1));
    const remaining = session.getSnapshot().players.A?.remainingMs;
    client.emit("close");
    performanceCurrent = 10_000;
    callbacks.forEach((callback) => callback());

    expect(session.getSnapshot().connection).toBe("reconnecting");
    expect(session.getSnapshot().players.A?.remainingMs).toBe(remaining);
    expect(clearInterval).toHaveBeenCalledTimes(1);
  });

  it("invalidates the attached generation on leave and ignores late state", async () => {
    const client = new FakeSpectatorClient();
    const session = new SpectatorSession({
      gateway: { available: true } as any,
      runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
      clientFactory: () => client as any,
    });

    await session.start({ mode: "spectator", allocation });
    client.emit("state", sampleStateMessage(1));
    const boardBeforeLeave = session.getSnapshot().board;
    await session.leave();
    client.emit("state", { ...sampleStateMessage(2), spectatorCount: 99 });

    expect(session.getSnapshot().phase).toBe("finished");
    expect(session.getSnapshot().board).toEqual(boardBeforeLeave);
    expect(session.getSnapshot().spectatorCount).toBe(5);
  });

  it("cleans up transport handlers and clock state after terminal spectator failure", async () => {
    const client = new FakeSpectatorClient();
    const clearInterval = vi.fn();
    const session = new SpectatorSession({
      gateway: { available: true } as any,
      runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
      clientFactory: () => client as any,
      setInterval: vi.fn(() => 1 as any),
      clearInterval,
    });

    await session.start({ mode: "spectator", allocation });
    client.emit("state", sampleStateMessage(1));
    client.emit("error", { code: "spectate_rejected" });
    client.emit("state", { ...sampleStateMessage(2), spectatorCount: 99 });

    expect(session.getSnapshot().error?.code).toBe("room_unavailable");
    expect(client.closed).toBe(true);
    expect(clearInterval).toHaveBeenCalledTimes(1);
    expect(Object.values(client.handlers).every((handlers) => handlers.length === 0)).toBe(true);
    expect(session.getSnapshot().spectatorCount).toBe(5);
  });

  it("ignores a cancelled bootstrap and lets a second start own the client", async () => {
    let resolveFirstBootstrap!: () => void;
    const firstBootstrap = new Promise<void>((resolve) => { resolveFirstBootstrap = resolve; });
    const client = new FakeSpectatorClient();
    const runtime = {
      bootstrap: vi.fn()
        .mockImplementationOnce(() => firstBootstrap)
        .mockResolvedValueOnce(undefined),
      connectionFactory: vi.fn(),
      dispose: vi.fn(),
    };
    const session = new SpectatorSession({
      gateway: { available: true } as any,
      runtime: runtime as any,
      clientFactory: () => client as any,
    });

    const firstStart = session.start({ mode: "spectator", allocation });
    await Promise.resolve();
    const secondAllocation = { allocationId: "alloc-2", room: "ott-alloc-2", ticket: "ticket-2" };
    const secondStart = session.start({ mode: "spectator", allocation: secondAllocation });
    resolveFirstBootstrap();
    await Promise.all([firstStart, secondStart]);

    expect(client.attachCalls).toHaveLength(1);
    expect(client.attached).toEqual(secondAllocation);
    expect(session.getSnapshot().roomId).toBe("ott-alloc-2");
  });

    it("serializes bootstrap across repeated starts for different rooms", async () => {
    let resolveFirstBootstrap!: () => void;
    let activeBootstraps = 0;
    let maxActiveBootstraps = 0;
    const firstBootstrap = new Promise<void>((resolve) => { resolveFirstBootstrap = resolve; });
    const runtime = {
      bootstrap: vi.fn()
        .mockImplementationOnce(async () => {
          activeBootstraps++;
          maxActiveBootstraps = Math.max(maxActiveBootstraps, activeBootstraps);
          await firstBootstrap;
          activeBootstraps--;
        })
        .mockImplementation(async () => {
          activeBootstraps++;
          maxActiveBootstraps = Math.max(maxActiveBootstraps, activeBootstraps);
          activeBootstraps--;
        }),
      connectionFactory: vi.fn(),
      dispose: vi.fn(),
    };
    const client = new FakeSpectatorClient();
    const secondAllocation = { allocationId: "alloc-2", room: "ott-alloc-2", ticket: "ticket-2" };
    const session = new SpectatorSession({
      gateway: { available: true } as any,
      runtime: runtime as any,
      clientFactory: () => client as any,
      host: "https://play.example",
    });

    const firstStart = session.start({ mode: "spectator", allocation });
    await Promise.resolve();
    const secondStart = session.start({ mode: "spectator", allocation: secondAllocation });
    await Promise.resolve();
    expect(runtime.bootstrap).toHaveBeenCalledTimes(1);
    resolveFirstBootstrap();
    await Promise.all([firstStart, secondStart]);

    expect(maxActiveBootstraps).toBe(1);
      expect(client.attached).toEqual(secondAllocation);
      expect(session.getSnapshot().roomId).toBe("ott-alloc-2");
    });

    it("retires an owned runtime before rebinding a repeated start to another room", async () => {
      const client = new FakeSpectatorClient();
      let boundRoom: string | null = null;
      const runtime = {
        bootstrap: vi.fn(async ({ room }: { room: string }) => {
          if (boundRoom && boundRoom !== room) throw new Error("runtime is still bound");
          boundRoom = room;
        }),
        connectionFactory: vi.fn(),
        dispose: vi.fn(async () => { boundRoom = null; }),
      };
      const session = new SpectatorSession({
        gateway: { available: true } as any,
        runtime: runtime as any,
        clientFactory: () => client as any,
        host: "https://play.example",
      });
      const secondAllocation = { allocationId: "alloc-2", room: "ott-alloc-2", ticket: "ticket-2" };

      await session.start({ mode: "spectator", allocation });
      await session.start({ mode: "spectator", allocation: secondAllocation });

      expect(runtime.dispose).toHaveBeenCalledTimes(1);
      expect(runtime.bootstrap).toHaveBeenLastCalledWith({ host: "https://play.example", room: "ott-alloc-2", party: "main" });
      expect(session.getSnapshot().roomId).toBe("ott-alloc-2");
      expect(session.getSnapshot().error).toBeNull();
    });

    it("rejects callbacks from a replaced client binding", async () => {
    const firstClient = new FakeSpectatorClient();
    const secondClient = new FakeSpectatorClient();
    let clientCount = 0;
    const session = new SpectatorSession({
      gateway: { available: true } as any,
      runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
      clientFactory: () => clientCount++ === 0 ? firstClient as any : secondClient as any,
    });

    await session.start({ mode: "spectator", allocation });
    await session.start({ mode: "spectator", allocation: { allocationId: "alloc-2", room: "ott-alloc-2", ticket: "ticket-2" } });
    firstClient.emit("state", { ...sampleStateMessage(9), roomId: "ott-alloc-2", spectatorCount: 99 });
    firstClient.emit("error", { code: "room_unavailable" });

    expect(session.getSnapshot().roomId).toBe("ott-alloc-2");
    expect(session.getSnapshot().error).toBeNull();
    expect(session.getSnapshot().spectatorCount).toBe(0);
  });

  it("cleans transport after the authoritative finished state", async () => {
    const client = new FakeSpectatorClient();
    const clearInterval = vi.fn();
    const session = new SpectatorSession({
      gateway: { available: true } as any,
      runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
      clientFactory: () => client as any,
      setInterval: vi.fn(() => 1 as any),
      clearInterval,
    });

    await session.start({ mode: "spectator", allocation });
    client.emit("state", sampleStateMessage(1));
    client.emit("state", { ...sampleStateMessage(2), status: "done", state: { ...sampleStateMessage(2).state, winner: "A", reason: "goal", turn: null, clock: { remainingMs: { A: 0, B: 600000 }, runningSeat: null } } });
    const finalBoard = session.getSnapshot().board;
    client.emit("state", { ...sampleStateMessage(3), spectatorCount: 99 });

    expect(session.getSnapshot().phase).toBe("finished");
    expect(session.getSnapshot().board).toEqual(finalBoard);
    expect(client.closed).toBe(true);
    expect(clearInterval).toHaveBeenCalledTimes(1);
    expect(Object.values(client.handlers).every((handlers) => handlers.length === 0)).toBe(true);
  });

  it("boots only after receiving the exact validated allocation and does not request an initial ticket", async () => {
    const client = new FakeSpectatorClient();
    const validatedAllocation = Object.freeze({
      allocationId: "alloc-validated",
      room: "ott-validated",
      ticket: "validated-ticket",
    });
    const gateway = {
      available: true,
      getSpectatorTicket: vi.fn(),
    };
    const order: string[] = [];
    const runtime = {
      bootstrap: vi.fn(async () => { order.push("bootstrap"); }),
      connectionFactory: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    client.attachSpectator = vi.fn(async (value) => {
      order.push("attach");
      expect(value).toBe(validatedAllocation);
      return true;
    });

    const session = new SpectatorSession({
      gateway: gateway as any,
      runtime: runtime as any,
      clientFactory: () => client as any,
      disposeRuntime: false,
    } as any);

    await session.start({ mode: "spectator", allocation: validatedAllocation } as any);

    expect(gateway.getSpectatorTicket).not.toHaveBeenCalled();
    expect(runtime.bootstrap).toHaveBeenCalledWith({
      host: expect.any(String),
      room: "ott-validated",
      party: "main",
    });
    expect(order).toEqual(["bootstrap", "attach"]);
    expect(client.attachSpectator).toHaveBeenCalledWith(validatedAllocation);
    await session.dispose();
    expect(runtime.dispose).not.toHaveBeenCalled();
  });

  it("fails closed for the removed legacy spectator start shape without bootstrapping or requesting a ticket", async () => {
    const client = new FakeSpectatorClient();
    const gateway = { available: true, getSpectatorTicket: vi.fn() };
    const runtime = { bootstrap: vi.fn(), connectionFactory: vi.fn(), dispose: vi.fn() };
    const session = new SpectatorSession({ gateway: gateway as any, runtime: runtime as any, clientFactory: () => client as any });

    await session.start({ mode: "spectator", allocationId: "alloc-1", roomId: "ott-alloc-1" } as any);

    expect(runtime.bootstrap).not.toHaveBeenCalled();
    expect(gateway.getSpectatorTicket).not.toHaveBeenCalled();
    expect(session.getSnapshot().error?.code).toBe("room_unavailable");
  });

  it.each([
    ["missing spectator API", () => ({
      on: () => () => undefined,
      close: () => undefined,
    })],
    ["attach returning false", () => ({
      on: () => () => undefined,
      close: () => undefined,
      attachSpectator: vi.fn(async () => false),
    })],
  ] as const)("does not become online after %s", async (_label, makeClient) => {
    const client = new FakeSpectatorClient();
    const runtime = { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() };
    const session = new SpectatorSession({
      gateway: { available: true } as any,
      runtime: runtime as any,
      clientFactory: () => makeClient() as any,
    });

    await session.start({ mode: "spectator", allocation });

    expect(session.getSnapshot().connection).toBe("offline");
    expect(session.getSnapshot().error?.code).toBe("online_unavailable");
  });

  it("invalidates the connection generation after terminal rejection", async () => {
    const client = new FakeSpectatorClient();
    const gateway = { available: true, getSpectatorTicket: vi.fn() };
    const session = new SpectatorSession({
      gateway: gateway as any,
      runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
      clientFactory: () => client as any,
    });

    await session.start({ mode: "spectator", allocation });
    client.emit("error", { code: "room_unavailable" });
    client.emit("close");
    client.emit("open");

    expect(gateway.getSpectatorTicket).not.toHaveBeenCalled();
    expect(session.getSnapshot().connection).toBe("offline");
    expect(session.getSnapshot().phase).toBe("error");
  });

  it("shares one in-flight reconnect ticket across rapid close/open generations", async () => {
    const client = new FakeSpectatorClient();
    let resolveTicket!: (value: unknown) => void;
    const ticket = new Promise((resolve) => { resolveTicket = resolve; });
    const gateway = { available: true, getSpectatorTicket: vi.fn(() => ticket) };
    const session = new SpectatorSession({
      gateway: gateway as any,
      runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
      clientFactory: () => client as any,
    });

    await session.start({ mode: "spectator", allocation });
    client.emit("close");
    client.emit("open");
    client.emit("close");
    client.emit("open");
    expect(gateway.getSpectatorTicket).toHaveBeenCalledTimes(1);

    resolveTicket(allocation);
    await flush();
    expect(client.attachCalls).toHaveLength(2);
  });

    it("cancels reconnect backoff after dispose without issuing another ticket request", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeSpectatorClient();
      const gateway = {
        available: true,
        getSpectatorTicket: vi.fn(async () => { throw Object.assign(new Error("overloaded"), { status: 503 }); }),
      };
      const session = new SpectatorSession({
        gateway: gateway as any,
        runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
        clientFactory: () => client as any,
        host: "https://play.example",
      });

      await session.start(spectatorOptions());
      client.emit("close");
      client.emit("open");
      await vi.advanceTimersByTimeAsync(0);
      await session.dispose();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(gateway.getSpectatorTicket).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a pending reconnect ticket after disposal", async () => {
    const client = new FakeSpectatorClient();
    let resolveTicket!: (value: unknown) => void;
    const pendingTicket = new Promise((resolve) => { resolveTicket = resolve; });
    const gateway = {
      available: true,
      getSpectatorTicket: vi.fn(() => pendingTicket),
    };
    const runtime = {
      bootstrap: vi.fn(async () => undefined),
      connectionFactory: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    const session = new SpectatorSession({
      gateway: gateway as any,
      runtime: runtime as any,
      clientFactory: () => client as any,
    });

    await session.start(spectatorOptions());
    client.emit("close");
    client.emit("open");
    await flush();
    expect(gateway.getSpectatorTicket).toHaveBeenCalledTimes(1);

    const snapshotBeforeDispose = session.getSnapshot();
    await session.dispose();
    resolveTicket({ allocationId: "alloc-1", room: "ott-alloc-1", ticket: "late-ticket" });
    await flush();

    expect(client.attachCalls).toHaveLength(1);
    expect(session.getSnapshot()).toBe(snapshotBeforeDispose);
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });

  it("ignores older or duplicate state revisions", async () => {
    const client = new FakeSpectatorClient();
    const session = new SpectatorSession({
      gateway: { available: true, getSpectatorTicket: vi.fn(async () => allocation) } as any,
      runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
      clientFactory: () => client as any,
    });

    await session.start(spectatorOptions());
    client.emit("state", sampleStateMessage(5));
    expect(session.getSnapshot().spectatorCount).toBe(5);

    // Stale revision 4 should be ignored
    client.emit("state", { ...sampleStateMessage(4), spectatorCount: 10 });
    expect(session.getSnapshot().spectatorCount).toBe(5);
  });

  describe("Finding 3: Provider reconnect and generation tracking", () => {
    it("reattaches with a fresh ticket after provider close -> open and resyncs state", async () => {
      const client = new FakeSpectatorClient();
      let ticketCounter = 2;
      const gateway = {
        available: true,
        getSpectatorTicket: vi.fn(async () => ({
          allocationId: "alloc-1",
          room: "ott-alloc-1",
          ticket: `spec-ticket-${ticketCounter++}`,
        })),
      };
      const runtime = {
        bootstrap: vi.fn(async () => undefined),
        connectionFactory: vi.fn(),
        dispose: vi.fn(async () => undefined),
      };

      const session = new SpectatorSession({
        gateway: gateway as any,
        runtime: runtime as any,
        clientFactory: () => client as any,
      });

      await session.start(spectatorOptions());
      expect(gateway.getSpectatorTicket).not.toHaveBeenCalled();
      expect(client.attachCalls).toHaveLength(1);
      expect(client.attached).toEqual({
        allocationId: "alloc-1",
        room: "ott-alloc-1",
        ticket: "spec-ticket-1",
      });
      expect(session.getSnapshot().connection).toBe("online");

      client.emit("state", sampleStateMessage(3));
      expect(session.getSnapshot().spectatorCount).toBe(5);

      // Connection closes
      client.emit("close");
      expect(session.getSnapshot().connection).toBe("reconnecting");

      // Connection re-opens -> must request fresh ticket and reattach
      client.emit("open");
      await flush();
      expect(gateway.getSpectatorTicket).toHaveBeenCalledTimes(1);
      expect(client.attachCalls).toHaveLength(2);
      expect(client.attached).toEqual({
        allocationId: "alloc-1",
        room: "ott-alloc-1",
        ticket: "spec-ticket-2",
      });
      expect(session.getSnapshot().connection).toBe("online");

      // Resync state even at same revision 3 is accepted after reattach
      client.emit("state", { ...sampleStateMessage(3), spectatorCount: 7 });
      expect(session.getSnapshot().spectatorCount).toBe(7);
    });

    it("clears a transient error after a successful reconnect attach", async () => {
      const client = new FakeSpectatorClient();
      const session = new SpectatorSession({
        gateway: { available: true, getSpectatorTicket: vi.fn(async () => allocation) } as any,
        runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
        clientFactory: () => client as any,
      });

      await session.start(spectatorOptions());
      client.emit("error", { message: "temporary network failure" });
      expect(session.getSnapshot().phase).toBe("error");
      await session.start(spectatorOptions());

      expect(session.getSnapshot().phase).toBe("playing");
      expect(session.getSnapshot().error).toBeNull();
    });

    it("ignores stale async ticket results from earlier generations", async () => {
      const client = new FakeSpectatorClient();
      let resolveFirstTicket!: (val: unknown) => void;
      const firstTicketPromise = new Promise((res) => {
        resolveFirstTicket = res;
      });

      let ticketCount = 0;
      const gateway = {
        available: true,
        getSpectatorTicket: vi.fn(() => {
          ticketCount++;
          if (ticketCount === 1) {
            return firstTicketPromise;
          }
          return Promise.resolve({
            allocationId: "alloc-1",
            room: "ott-alloc-1",
            ticket: `spec-ticket-${ticketCount}`,
          });
        }),
      };

      const session = new SpectatorSession({
        gateway: gateway as any,
        runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
        clientFactory: () => client as any,
      });

      await session.start(spectatorOptions());
      expect(client.attached).toEqual({
        allocationId: "alloc-1",
        room: "ott-alloc-1",
        ticket: "spec-ticket-1",
      });

      // Reconnect cycle 1: ticket promise is suspended
      client.emit("close");
      client.emit("open");
      expect(gateway.getSpectatorTicket).toHaveBeenCalledTimes(1);

      // Another disconnect occurs while ticket 2 is still in-flight
      client.emit("close");
      client.emit("open");
      expect(gateway.getSpectatorTicket).toHaveBeenCalledTimes(1);

      // The shared ticket resolves for the latest connection generation.
      resolveFirstTicket({
        allocationId: "alloc-1",
        room: "ott-alloc-1",
        ticket: "spec-ticket-2",
      });
      await flush();

      // Older close/open generations must not create another ticket request.
      expect(client.attached).toEqual({
        allocationId: "alloc-1",
        room: "ott-alloc-1",
        ticket: "spec-ticket-2",
      });
    });

    it("rejects state arriving during reconnect before fresh attach completes", async () => {
      const client = new FakeSpectatorClient();
      let resolveSecondTicket!: (val: unknown) => void;
      const secondTicketPromise = new Promise((res) => {
        resolveSecondTicket = res;
      });

      let ticketCount = 0;
      const gateway = {
        available: true,
        getSpectatorTicket: vi.fn(() => {
          ticketCount++;
          return secondTicketPromise;
        }),
      };

      const session = new SpectatorSession({
        gateway: gateway as any,
        runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
        clientFactory: () => client as any,
      });

      await session.start(spectatorOptions());
      client.emit("open");
      client.emit("state", sampleStateMessage(1));
      expect(session.getSnapshot().spectatorCount).toBe(5);

      // Disconnect
      client.emit("close");
      expect(session.getSnapshot().connection).toBe("reconnecting");

      // Provider reconnects -> triggers connectWithTicket (ticket request is pending)
      client.emit("open");

      // State arrives BEFORE ticket 2 resolves -> must be rejected
      client.emit("state", { ...sampleStateMessage(2), spectatorCount: 99 });
      expect(session.getSnapshot().spectatorCount).toBe(5);

      // Now ticket 2 resolves and attach completes
      resolveSecondTicket({
        allocationId: "alloc-1",
        room: "ott-alloc-1",
        ticket: "spec-ticket-2",
      });
      await flush();

      // State arriving after attach completes -> accepted
      client.emit("state", { ...sampleStateMessage(2), spectatorCount: 99 });
      expect(session.getSnapshot().spectatorCount).toBe(99);
    });
  });

  describe("Finding 11: Error envelope decoding and failure classification", () => {
    it("decodes worker error envelope with error and code fields as terminal room_unavailable", async () => {
      const client = new FakeSpectatorClient();
      const session = new SpectatorSession({
        gateway: { available: true, getSpectatorTicket: vi.fn(async () => allocation) } as any,
        runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
        clientFactory: () => client as any,
      });

      await session.start(spectatorOptions());

      // Worker sends error envelope using payload.error
      client.emit("error", { __ott: true, roomId: "ott-alloc-1", revision: 0, type: "ott:error", error: "room_unavailable" });
      let snapshot = session.getSnapshot();
      expect(snapshot.phase).toBe("error");
      expect(snapshot.error).toEqual({
        code: "room_unavailable",
        message: "Trận đấu không còn khả dụng.",
        retryable: false,
      });

      // Also decodes payload.code
      client.emit("error", { code: "not_found" });
      snapshot = session.getSnapshot();
      expect(snapshot.phase).toBe("error");
      expect(snapshot.error?.code).toBe("room_unavailable");
      expect(snapshot.error?.retryable).toBe(false);
    });

    it("differentiates terminal 404 from retryable 503/429 failures during ticket request", async () => {
      const client = new FakeSpectatorClient();
      const createGateway = (err: any) => ({
        available: true,
        getSpectatorTicket: vi.fn(async () => { throw err; }),
      });

      // 404 / room_unavailable -> terminal
      const terminalError = Object.assign(new Error("Not found"), { status: 404, code: "room_unavailable" });
      const terminalSession = new SpectatorSession({
        gateway: createGateway(terminalError) as any,
        runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
        clientFactory: () => client as any,
      });
      await terminalSession.start(spectatorOptions());
      await reconnect(client);
      expect(terminalSession.getSnapshot().error).toEqual({
        code: "room_unavailable",
        message: "Trận đấu không còn khả dụng.",
        retryable: false,
      });

      // 503 / overload -> retryable after bounded backoff attempts
      const retryableError = Object.assign(new Error("Service Unavailable"), { status: 503, code: "overloaded" });
      const retryableGateway = createGateway(retryableError);
      const retryableSession = new SpectatorSession({
        gateway: retryableGateway as any,
        runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
        clientFactory: () => client as any,
      });
      await retryableSession.start(spectatorOptions());
      await reconnect(client);
      expect(retryableGateway.getSpectatorTicket).toHaveBeenCalledTimes(3);
      expect(retryableSession.getSnapshot().error).toEqual({
        code: "online_unavailable",
        message: "Không thể kết nối phòng xem trận.",
        retryable: true,
      });

      // 429 / rate_limited -> retryable after bounded backoff attempts
      const rateLimitError = Object.assign(new Error("Too Many Requests"), { status: 429, code: "rate_limited" });
      const rateLimitGateway = createGateway(rateLimitError);
      const rateLimitSession = new SpectatorSession({
        gateway: rateLimitGateway as any,
        runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
        clientFactory: () => client as any,
      });
      await rateLimitSession.start(spectatorOptions());
      await reconnect(client);
      expect(rateLimitGateway.getSpectatorTicket).toHaveBeenCalledTimes(3);
      expect(rateLimitSession.getSnapshot().error).toEqual({
        code: "online_unavailable",
        message: "Không thể kết nối phòng xem trận.",
        retryable: true,
      });
    });

    it("retries transient ticket failures with backoff and succeeds on subsequent attempt", async () => {
      const client = new FakeSpectatorClient();
      const transientError = Object.assign(new Error("Service Unavailable"), { status: 503, code: "overloaded" });
      const gateway = {
        available: true,
        getSpectatorTicket: vi.fn()
          .mockRejectedValueOnce(transientError)
          .mockResolvedValueOnce(allocation),
      };

      const session = new SpectatorSession({
        gateway: gateway as any,
        runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
        clientFactory: () => client as any,
      });

      await session.start(spectatorOptions());
      await reconnect(client);
      expect(gateway.getSpectatorTicket).toHaveBeenCalledTimes(2);
      expect(session.getSnapshot().error).toBeNull();
      expect(session.getSnapshot().connection).toBe("online");
      expect(client.attachCalls).toHaveLength(2);
    });

    it("treats transient worker error events as retryable online_unavailable", async () => {
      const client = new FakeSpectatorClient();
      const session = new SpectatorSession({
        gateway: { available: true, getSpectatorTicket: vi.fn(async () => allocation) } as any,
        runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
        clientFactory: () => client as any,
      });

      await session.start(spectatorOptions());

      client.emit("error", { error: "overloaded", code: "overloaded", status: 503 });
      const snapshot = session.getSnapshot();
      expect(snapshot.phase).toBe("error");
      expect(snapshot.error).toEqual({
        code: "online_unavailable",
        message: "Lỗi kết nối phòng xem trận.",
        retryable: true,
      });
    });

    it("differentiates terminal 409 not_available and 410 gone as room_unavailable", async () => {
      const client = new FakeSpectatorClient();
      const createGateway = (err: any) => ({
        available: true,
        getSpectatorTicket: vi.fn(async () => { throw err; }),
      });

      // 409 not_available -> terminal
      const err409 = Object.assign(new Error("Conflict"), { status: 409, code: "not_available" });
      const session409 = new SpectatorSession({
        gateway: createGateway(err409) as any,
        runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
        clientFactory: () => client as any,
      });
      await session409.start(spectatorOptions());
      await reconnect(client);
      expect(session409.getSnapshot().error).toEqual({
        code: "room_unavailable",
        message: "Trận đấu không còn khả dụng.",
        retryable: false,
      });

      // 410 gone -> terminal
      const err410 = Object.assign(new Error("Gone"), { status: 410, code: "room_closed" });
      const session410 = new SpectatorSession({
        gateway: createGateway(err410) as any,
        runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
        clientFactory: () => client as any,
      });
      await session410.start(spectatorOptions());
      await reconnect(client);
      expect(session410.getSnapshot().error).toEqual({
        code: "room_unavailable",
        message: "Trận đấu không còn khả dụng.",
        retryable: false,
      });
    });

    it("decodes worker error event with Vietnamese ROOM_UNAVAILABLE message as terminal", async () => {
      const client = new FakeSpectatorClient();
      const session = new SpectatorSession({
        gateway: { available: true, getSpectatorTicket: vi.fn(async () => allocation) } as any,
        runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
        clientFactory: () => client as any,
      });

      await session.start(spectatorOptions());

      client.emit("error", { error: "Phòng không khả dụng" });
      const snapshot = session.getSnapshot();
      expect(snapshot.phase).toBe("error");
      expect(snapshot.error).toEqual({
        code: "room_unavailable",
        message: "Trận đấu không còn khả dụng.",
        retryable: false,
      });
    });
  });

  describe("Finding 12: Watch intent and projection validation", () => {
    it("fails closed when start options lack roomId or allocationId", async () => {
      const client = new FakeSpectatorClient();
      const gateway = { available: true, getSpectatorTicket: vi.fn() };
      const session = new SpectatorSession({
        gateway: gateway as any,
        runtime: { bootstrap: vi.fn(), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
        clientFactory: () => client as any,
      });

      await session.start({ mode: "spectator" } as any);
      expect(session.getSnapshot().phase).toBe("error");
      expect(session.getSnapshot().error?.code).toBe("room_unavailable");
      expect(gateway.getSpectatorTicket).not.toHaveBeenCalled();
    });

    it("fails closed when ticket response does not match requested roomId or allocationId", async () => {
      const client = new FakeSpectatorClient();
      // Mismatched allocationId
      const badAllocGateway = {
        available: true,
        getSpectatorTicket: vi.fn(async () => ({
          allocationId: "wrong-alloc",
          room: "ott-alloc-1",
          ticket: "ticket-1",
        })),
      };
      const session1 = new SpectatorSession({
        gateway: badAllocGateway as any,
        runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
        clientFactory: () => client as any,
      });
      await session1.start(spectatorOptions());
      await reconnect(client);
      expect(session1.getSnapshot().phase).toBe("error");
      expect(session1.getSnapshot().error?.code).toBe("room_unavailable");
      expect(client.attachCalls).toHaveLength(1);

      // Mismatched room
      const badRoomGateway = {
        available: true,
        getSpectatorTicket: vi.fn(async () => ({
          allocationId: "alloc-1",
          room: "wrong-room",
          ticket: "ticket-1",
        })),
      };
      const session2 = new SpectatorSession({
        gateway: badRoomGateway as any,
        runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
        clientFactory: () => client as any,
      });
      await session2.start(spectatorOptions());
      await reconnect(client);
      expect(session2.getSnapshot().phase).toBe("error");
      expect(session2.getSnapshot().error?.code).toBe("room_unavailable");
      expect(client.attachCalls).toHaveLength(2);
    });

    it("rejects incoming state with wrong roomId", async () => {
      const client = new FakeSpectatorClient();
      const session = new SpectatorSession({
        gateway: { available: true, getSpectatorTicket: vi.fn(async () => allocation) } as any,
        runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
        clientFactory: () => client as any,
      });

      await session.start(spectatorOptions());
      client.emit("state", { ...sampleStateMessage(1), roomId: "wrong-room" });
      expect(session.getSnapshot().board).toHaveLength(0);
    });

    it("rejects player projections and projections without viewer", async () => {
      const client = new FakeSpectatorClient();
      const session = new SpectatorSession({
        gateway: { available: true, getSpectatorTicket: vi.fn(async () => allocation) } as any,
        runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
        clientFactory: () => client as any,
      });

      await session.start(spectatorOptions());

      // Player projection with seat
      client.emit("state", {
        ...sampleStateMessage(1),
        viewer: { role: "player", seat: "A" },
        you: "A",
      });
      expect(session.getSnapshot().board).toHaveLength(0);

      // Projection without viewer
      client.emit("state", {
        ...sampleStateMessage(1),
        viewer: undefined,
      });
      expect(session.getSnapshot().board).toHaveLength(0);
    });

    it("rejects state before attach completes", async () => {
      let clientRef: FakeSpectatorClient | null = null;
      let resolveAttach!: (val: boolean) => void;
      const attachPromise = new Promise<boolean>((res) => {
        resolveAttach = res;
      });

      const gateway = {
        available: true,
        getSpectatorTicket: vi.fn(async () => allocation),
      };

      const session = new SpectatorSession({
        gateway: gateway as any,
        runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
        clientFactory: () => {
          clientRef = new FakeSpectatorClient();
          clientRef.attachSpectator = vi.fn(() => attachPromise);
          return clientRef as any;
        },
      });

      // Start the session; attachSpectator is pending
      const startPromise = session.start(spectatorOptions());

      // Yield microtasks so client is initialized and attachSpectator is invoked
      await Promise.resolve();
      await Promise.resolve();
      expect(clientRef).not.toBeNull();

      // Emit state while attach is STILL pending
      clientRef!.emit("state", sampleStateMessage(1));

      // State arriving before attach completion must not be applied
      expect(session.getSnapshot().board).toHaveLength(0);

      // Now complete attach
      resolveAttach(true);
      await startPromise;

      // After attach completes, state is accepted
      clientRef!.emit("state", sampleStateMessage(1));
      expect(session.getSnapshot().board).toHaveLength(2);
    });

    it("rejects projections with spectator role but containing player credentials or seat", async () => {
      const client = new FakeSpectatorClient();
      const session = new SpectatorSession({
        gateway: { available: true, getSpectatorTicket: vi.fn(async () => allocation) } as any,
        runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
        clientFactory: () => client as any,
      });

      await session.start(spectatorOptions());

      // Spectator role with seat property
      client.emit("state", {
        ...sampleStateMessage(1),
        viewer: { role: "spectator", seat: "A" },
      });
      expect(session.getSnapshot().board).toHaveLength(0);

      // Spectator role but you is defined
      client.emit("state", {
        ...sampleStateMessage(1),
        viewer: { role: "spectator" },
        you: "A",
      });
      expect(session.getSnapshot().board).toHaveLength(0);
    });

    it("fails closed when ticket response contains empty or whitespace-only ticket", async () => {
      const client = new FakeSpectatorClient();
      const badTicketGateway = {
        available: true,
        getSpectatorTicket: vi.fn(async () => ({
          allocationId: "alloc-1",
          room: "ott-alloc-1",
          ticket: "   ",
        })),
      };
      const session = new SpectatorSession({
        gateway: badTicketGateway as any,
        runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
        clientFactory: () => client as any,
      });
      await session.start(spectatorOptions());
      await reconnect(client);
      expect(session.getSnapshot().phase).toBe("error");
      expect(session.getSnapshot().error?.code).toBe("room_unavailable");
      expect(client.attachCalls).toHaveLength(1);
    });
  });
});
