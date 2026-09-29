import { describe, expect, it, vi } from "vitest";
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
  const allocation = {
    allocationId: "alloc-1",
    room: "ott-alloc-1",
    ticket: "spec-ticket-1",
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

    await session.start({
      mode: "spectator",
      allocationId: "alloc-1",
      roomId: "ott-alloc-1",
    });

    expect(runtime.bootstrap).toHaveBeenCalledWith({
      host: expect.any(String),
      room: "ott-alloc-1",
      party: "main",
    });
    expect(gateway.getSpectatorTicket).toHaveBeenCalledWith("alloc-1");
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

  it("ignores older or duplicate state revisions", async () => {
    const client = new FakeSpectatorClient();
    const session = new SpectatorSession({
      gateway: { available: true, getSpectatorTicket: vi.fn(async () => allocation) } as any,
      runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
      clientFactory: () => client as any,
    });

    await session.start({ mode: "spectator", allocationId: "alloc-1", roomId: "ott-alloc-1" });
    client.emit("state", sampleStateMessage(5));
    expect(session.getSnapshot().spectatorCount).toBe(5);

    // Stale revision 4 should be ignored
    client.emit("state", { ...sampleStateMessage(4), spectatorCount: 10 });
    expect(session.getSnapshot().spectatorCount).toBe(5);
  });

  describe("Finding 3: Provider reconnect and generation tracking", () => {
    it("reattaches with a fresh ticket after provider close -> open and resyncs state", async () => {
      const client = new FakeSpectatorClient();
      let ticketCounter = 1;
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

      await session.start({ mode: "spectator", allocationId: "alloc-1", roomId: "ott-alloc-1" });
      expect(gateway.getSpectatorTicket).toHaveBeenCalledTimes(1);
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
      await Promise.resolve();
      await Promise.resolve();
      expect(gateway.getSpectatorTicket).toHaveBeenCalledTimes(2);
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

      await session.start({ mode: "spectator", allocationId: "alloc-1", roomId: "ott-alloc-1" });
      client.emit("error", { message: "temporary network failure" });
      expect(session.getSnapshot().phase).toBe("error");
      client.emit("close");
      client.emit("open");
      await Promise.resolve();
      await Promise.resolve();

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
          if (ticketCount === 2) {
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

      await session.start({ mode: "spectator", allocationId: "alloc-1", roomId: "ott-alloc-1" });
      expect(client.attached).toEqual({
        allocationId: "alloc-1",
        room: "ott-alloc-1",
        ticket: "spec-ticket-1",
      });

      // Reconnect cycle 1: ticket promise is suspended
      client.emit("close");
      client.emit("open");
      expect(gateway.getSpectatorTicket).toHaveBeenCalledTimes(2);

      // Another disconnect occurs while ticket 2 is still in-flight
      client.emit("close");
      client.emit("open");
      expect(gateway.getSpectatorTicket).toHaveBeenCalledTimes(3);

      // Ticket 3 resolves immediately
      await Promise.resolve();
      expect(client.attached).toEqual({
        allocationId: "alloc-1",
        room: "ott-alloc-1",
        ticket: "spec-ticket-3",
      });

      // Now stale ticket 2 finally resolves
      resolveFirstTicket({
        allocationId: "alloc-1",
        room: "ott-alloc-1",
        ticket: "stale-ticket-2",
      });
      await Promise.resolve();

      // Attached ticket must NOT have been overwritten with stale ticket 2
      expect(client.attached).toEqual({
        allocationId: "alloc-1",
        room: "ott-alloc-1",
        ticket: "spec-ticket-3",
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
          if (ticketCount === 1) {
            return Promise.resolve(allocation);
          }
          return secondTicketPromise;
        }),
      };

      const session = new SpectatorSession({
        gateway: gateway as any,
        runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
        clientFactory: () => client as any,
      });

      await session.start({ mode: "spectator", allocationId: "alloc-1", roomId: "ott-alloc-1" });
      client.emit("open");
      client.emit("state", sampleStateMessage(1));
      expect(session.getSnapshot().spectatorCount).toBe(5);

      // Disconnect
      client.emit("close");
      expect(session.getSnapshot().connection).toBe("reconnecting");

      // Provider reconnects -> triggers connectWithTicket (secondTicketPromise is pending)
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
      await Promise.resolve();
      await Promise.resolve();

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

      await session.start({ mode: "spectator", allocationId: "alloc-1", roomId: "ott-alloc-1" });

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
      await terminalSession.start({ mode: "spectator", allocationId: "alloc-1", roomId: "ott-alloc-1" });
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
      await retryableSession.start({ mode: "spectator", allocationId: "alloc-1", roomId: "ott-alloc-1" });
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
      await rateLimitSession.start({ mode: "spectator", allocationId: "alloc-1", roomId: "ott-alloc-1" });
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

      await session.start({ mode: "spectator", allocationId: "alloc-1", roomId: "ott-alloc-1" });
      expect(gateway.getSpectatorTicket).toHaveBeenCalledTimes(2);
      expect(session.getSnapshot().error).toBeNull();
      expect(session.getSnapshot().connection).toBe("online");
      expect(client.attachCalls).toHaveLength(1);
    });

    it("treats transient worker error events as retryable online_unavailable", async () => {
      const client = new FakeSpectatorClient();
      const session = new SpectatorSession({
        gateway: { available: true, getSpectatorTicket: vi.fn(async () => allocation) } as any,
        runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
        clientFactory: () => client as any,
      });

      await session.start({ mode: "spectator", allocationId: "alloc-1", roomId: "ott-alloc-1" });

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
      await session409.start({ mode: "spectator", allocationId: "alloc-1", roomId: "ott-alloc-1" });
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
      await session410.start({ mode: "spectator", allocationId: "alloc-1", roomId: "ott-alloc-1" });
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

      await session.start({ mode: "spectator", allocationId: "alloc-1", roomId: "ott-alloc-1" });

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

      await session.start({ mode: "spectator", allocationId: "", roomId: "ott-alloc-1" });
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
      await session1.start({ mode: "spectator", allocationId: "alloc-1", roomId: "ott-alloc-1" });
      expect(session1.getSnapshot().phase).toBe("error");
      expect(session1.getSnapshot().error?.code).toBe("room_unavailable");
      expect(client.attached).toBeNull();

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
      await session2.start({ mode: "spectator", allocationId: "alloc-1", roomId: "ott-alloc-1" });
      expect(session2.getSnapshot().phase).toBe("error");
      expect(session2.getSnapshot().error?.code).toBe("room_unavailable");
      expect(client.attached).toBeNull();
    });

    it("rejects incoming state with wrong roomId", async () => {
      const client = new FakeSpectatorClient();
      const session = new SpectatorSession({
        gateway: { available: true, getSpectatorTicket: vi.fn(async () => allocation) } as any,
        runtime: { bootstrap: vi.fn(async () => undefined), connectionFactory: vi.fn(), dispose: vi.fn() } as any,
        clientFactory: () => client as any,
      });

      await session.start({ mode: "spectator", allocationId: "alloc-1", roomId: "ott-alloc-1" });
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

      await session.start({ mode: "spectator", allocationId: "alloc-1", roomId: "ott-alloc-1" });

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
      const startPromise = session.start({ mode: "spectator", allocationId: "alloc-1", roomId: "ott-alloc-1" });

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

      await session.start({ mode: "spectator", allocationId: "alloc-1", roomId: "ott-alloc-1" });

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
      await session.start({ mode: "spectator", allocationId: "alloc-1", roomId: "ott-alloc-1" });
      expect(session.getSnapshot().phase).toBe("error");
      expect(session.getSnapshot().error?.code).toBe("room_unavailable");
      expect(client.attached).toBeNull();
    });
  });
});
