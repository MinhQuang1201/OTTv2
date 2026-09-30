import { describe, expect, it, vi } from "vitest";

import type { PublicMatchCatalogMessage, PublicMatchView } from "../../../../../packages/protocol/src/index";
import type { OnlineConnection } from "./globals";
import { OnlineLobbyStream, type OnlineLobbyStreamSnapshot } from "./OnlineLobbyStream";
import type { RuntimeBridge, RuntimeConfig } from "./runtimeBridge";

const allocationId = "123e4567-e89b-12d3-a456-426614174000";

function match(overrides: Partial<PublicMatchView> = {}): PublicMatchView {
  return {
    allocationId,
    roomId: `ott-${allocationId}`,
    status: "playing",
    players: {
      A: { seat: "A", name: "Alice", connected: true, remainingMs: 600_000 },
      B: { seat: "B", name: "Bob", connected: true, remainingMs: 600_000 },
    },
    spectatorCount: 0,
    serverNow: 1_700_000_000_000,
    runningSeat: "A",
    ...overrides,
  };
}

function catalog(catalogRevision: number, matches: readonly PublicMatchView[] = [match()]): PublicMatchCatalogMessage {
  return { __ott: true, type: "ott:active-matches", catalogRevision, matches };
}

class FakeConnection implements OnlineConnection {
  readonly handlers = new Map<string, Set<(payload?: unknown) => void>>();
  readonly send = vi.fn();
  readonly connect = vi.fn<() => Promise<void>>(async () => undefined);
  readonly close = vi.fn<() => Promise<void>>(async () => undefined);

  on(event: string, listener: (payload?: unknown) => void): void {
    const listeners = this.handlers.get(event) ?? new Set();
    listeners.add(listener);
    this.handlers.set(event, listeners);
  }

  emit(event: string, payload?: unknown): void {
    this.handlers.get(event)?.forEach((listener) => listener(payload));
  }
}

function runtimeFor(
  connection: FakeConnection,
  bootstrap: RuntimeBridge["bootstrap"] = vi.fn(async () => undefined),
  connections: readonly FakeConnection[] = [connection],
): RuntimeBridge {
  let nextConnection = 0;
  return {
    bootstrap,
    connectionFactory: vi.fn(() => connections[Math.min(nextConnection++, connections.length - 1)] ?? connection),
    dispose: vi.fn(async () => undefined),
  };
}

function createStream(connection = new FakeConnection(), runtime = runtimeFor(connection), options: Partial<ConstructorParameters<typeof OnlineLobbyStream>[0]> = {}) {
  return {
    connection,
    runtime,
    stream: new OnlineLobbyStream({
      runtime,
      host: "https://play.example",
      reconnectDelayMs: 0,
      ...options,
    }),
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function startWithOpen(stream: OnlineLobbyStream, connection: FakeConnection): Promise<void> {
  const start = stream.start();
  await settle();
  connection.emit("open");
  await start;
}

describe("OnlineLobbyStream", () => {
  it("maps a disabled pre-open bootstrap failure, including HTTP 404, to unavailable", async () => {
    const failure = Object.assign(new Error("Not found"), { status: 404 });
    const connection = new FakeConnection();
    const bootstrap = vi.fn<RuntimeBridge["bootstrap"]>().mockRejectedValue(failure);
    const { stream } = createStream(connection, runtimeFor(connection, bootstrap));

    await stream.start();

    expect(stream.getSnapshot()).toMatchObject<Partial<OnlineLobbyStreamSnapshot>>({ status: "unavailable", matches: [] });
  });

  it("opens and subscribes when connect resolves without an open event", async () => {
    const connection = new FakeConnection();
    const runtime = runtimeFor(connection);
    const { stream } = createStream(connection, runtime);

    const start = stream.start();
    await settle();

    expect(runtime.bootstrap).toHaveBeenCalledWith({ host: "https://play.example", room: "ott-lobby-public", party: "lobby" } satisfies RuntimeConfig);
    expect(connection.connect).toHaveBeenCalledTimes(1);
    await start;

    expect(connection.send).toHaveBeenCalledTimes(1);
    expect(connection.send).toHaveBeenCalledWith({ __ott: true, type: "ott:lobby-subscribe" });
    expect(stream.getSnapshot().status).toBe("ready");
  });

  it("waits for an open event when the connection is not ready yet", async () => {
    const connection = new FakeConnection();
    let resolveConnect!: () => void;
    connection.connect.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveConnect = resolve; }));
    const { stream } = createStream(connection);

    const start = stream.start();
    await settle();
    expect(connection.send).not.toHaveBeenCalled();
    expect(stream.getSnapshot().status).toBe("loading");

    connection.emit("open");
    resolveConnect();
    await start;

    expect(connection.send).toHaveBeenCalledTimes(1);
    expect(stream.getSnapshot().status).toBe("ready");
  });

  it("sends exactly one subscribe per connection generation and resubscribes after reconnect", async () => {
    const first = new FakeConnection();
    const second = new FakeConnection();
    const runtime = runtimeFor(first, undefined, [first, second]);
    const { stream } = createStream(first, runtime);
    await startWithOpen(stream, first);
    first.emit("open");
    first.emit("open");
    expect(first.send).toHaveBeenCalledTimes(1);

    first.emit("close");
    expect(stream.getSnapshot().status).toBe("reconnecting");
    second.connect.mockImplementationOnce(async () => { second.emit("open"); });
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settle();
    expect(second.send).toHaveBeenCalledTimes(1);
  });

  it("closes every superseded connection and all owned sources on disposal", async () => {
    vi.useFakeTimers();
    try {
      const first = new FakeConnection();
      const second = new FakeConnection();
      const third = new FakeConnection();
      const runtime = runtimeFor(first, undefined, [first, second, third]);
      const { stream } = createStream(first, runtime, { reconnectDelayMs: 0, maxReconnectAttempts: 2 });

      await startWithOpen(stream, first);
      first.emit("close");
      await vi.advanceTimersByTimeAsync(0);
      await settle();
      expect(first.close).toHaveBeenCalledTimes(1);

      second.emit("close");
      await vi.advanceTimersByTimeAsync(0);
      await settle();
      expect(second.close).toHaveBeenCalledTimes(1);

      await stream.dispose();
      expect(third.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("awaits a reconnect source created while disposal is already starting", async () => {
    vi.useFakeTimers();
    try {
      const first = new FakeConnection();
      const second = new FakeConnection();
      let resolveFirstClose!: () => void;
      let resolveSecondClose!: () => void;
      first.close.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirstClose = resolve; }));
      second.close.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveSecondClose = resolve; }));
      let stream!: OnlineLobbyStream;
      let connectionCalls = 0;
      let disposal: Promise<void> | undefined;
      const runtime: RuntimeBridge = {
        bootstrap: vi.fn(async () => undefined),
        connectionFactory: vi.fn(() => {
          if (connectionCalls++ === 0) return first;
          disposal = stream.dispose();
          return second;
        }),
        dispose: vi.fn(async () => undefined),
      };
      stream = new OnlineLobbyStream({ runtime, host: "https://play.example", reconnectDelayMs: 0 });

      await startWithOpen(stream, first);
      first.emit("close");
      vi.advanceTimersByTime(0);
      await Promise.resolve();

      expect(disposal).toBeDefined();
      let disposalSettled = false;
      void disposal!.then(() => { disposalSettled = true; });
      resolveFirstClose();
      for (let index = 0; index < 10; index++) await Promise.resolve();
      expect(second.close).toHaveBeenCalledTimes(1);
      expect(disposalSettled).toBe(false);
      resolveSecondClose();
      await disposal;
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps pre-open reconnecting and connect failures to unavailable", async () => {
    const reconnecting = createStream();
    let resolveConnect!: () => void;
    reconnecting.connection.connect.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveConnect = resolve; }));
    const reconnectingStart = reconnecting.stream.start();
    await settle();
    reconnecting.connection.emit("reconnecting");
    resolveConnect();
    await reconnectingStart;
    expect(reconnecting.stream.getSnapshot().status).toBe("unavailable");

    const connection = new FakeConnection();
    const failure = new Error("startup failed");
    connection.connect.mockRejectedValue(failure);
    const { stream } = createStream(connection);
    await stream.start();
    expect(stream.getSnapshot()).toMatchObject({ status: "unavailable", message: "startup failed" });
  });

  it("marks subscribe only after send succeeds and retries a rejected subscribe", async () => {
    const first = new FakeConnection();
    const second = new FakeConnection();
    const third = new FakeConnection();
    const runtime = runtimeFor(first, undefined, [first, second, third]);
    const { stream } = createStream(first, runtime, { maxReconnectAttempts: 2 });
    await startWithOpen(stream, first);
    const failure = new Error("subscribe failed");
    let rejectSubscribe!: (error: unknown) => void;
    second.send.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSubscribe = reject; }));

    first.emit("close");
    second.connect.mockImplementationOnce(async () => { second.emit("open"); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settle();
    expect(second.send).toHaveBeenCalledTimes(1);
    expect(stream.getSnapshot().status).not.toBe("ready");

    rejectSubscribe(failure);
    await settle();
    expect(stream.getSnapshot()).toMatchObject({ status: "reconnecting", message: "subscribe failed" });

    third.connect.mockImplementationOnce(async () => { third.emit("open"); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settle();
    expect(third.send).toHaveBeenCalledTimes(1);
    expect(stream.getSnapshot().status).toBe("ready");
  });

  it("does not wait for another open event after subscribe is rejected", async () => {
    const connection = new FakeConnection();
    connection.send.mockRejectedValueOnce(new Error("subscribe failed"));
    const { stream } = createStream(connection, undefined, { maxReconnectAttempts: 1, reconnectDelayMs: 1000 });

    const start = stream.start();
    await start;

    expect(stream.getSnapshot()).toMatchObject({ status: "reconnecting", message: "subscribe failed" });
    await stream.dispose();
  });

  it("bounds retries when every opened connection rejects its subscribe", async () => {
    vi.useFakeTimers();
    let stream: OnlineLobbyStream | undefined;
    try {
      const first = new FakeConnection();
      const second = new FakeConnection();
      const failure = new Error("subscribe failed");
      first.send.mockRejectedValue(failure);
      second.send.mockRejectedValue(failure);
      const runtime = runtimeFor(first, undefined, [first, second]);
      ({ stream } = createStream(first, runtime, { maxReconnectAttempts: 1, reconnectDelayMs: 0 }));

      await stream.start();
      await vi.advanceTimersByTimeAsync(0);
      await settle();

      expect(second.send).toHaveBeenCalledTimes(1);
      expect(runtime.connectionFactory).toHaveBeenCalledTimes(2);
      expect(first.send).toHaveBeenCalledTimes(1);
      expect(stream.getSnapshot()).toMatchObject({ status: "error", message: "Không thể kết nối lại lobby stream." });
    } finally {
      await stream?.dispose();
      vi.useRealTimers();
    }
  });

  it("preserves the retry when the initial connection closes before subscribe resolves", async () => {
    const connection = new FakeConnection();
    const retry = new FakeConnection();
    let resolveSubscribe!: () => void;
    connection.send.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveSubscribe = resolve; }));
    const runtime = runtimeFor(connection, undefined, [connection, retry]);
    const { stream } = createStream(connection, runtime, { maxReconnectAttempts: 1, reconnectDelayMs: 10 });

    const start = stream.start();
    await settle();
    connection.emit("open");
    await settle();
    expect(connection.send).toHaveBeenCalledTimes(1);

    connection.emit("close");
    await start;
    await new Promise((resolve) => setTimeout(resolve, 25));
    await settle();

    expect(retry.connect).toHaveBeenCalledTimes(1);
    resolveSubscribe();
    await stream.dispose();
  });

  it("does not let a delayed connect attempt clear the retry attempt", async () => {
    vi.useFakeTimers();
    try {
      const first = new FakeConnection();
      const second = new FakeConnection();
      let resolveFirstConnect!: () => void;
      let resolveSecondConnect!: () => void;
      first.connect.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirstConnect = resolve; }));
      second.connect.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveSecondConnect = resolve; }));
      first.send.mockImplementationOnce(() => new Promise<void>(() => undefined));
      const runtime = runtimeFor(first, undefined, [first, second]);
      const { stream } = createStream(first, runtime, { maxReconnectAttempts: 1, reconnectDelayMs: 0 });

      const start = stream.start();
      await settle();
      first.emit("open");
      await settle();
      first.emit("close");
      await vi.advanceTimersByTimeAsync(0);

      expect(second.connect).toHaveBeenCalledTimes(1);
      resolveFirstConnect();
      await settle();
      resolveSecondConnect();
      await settle();
      await settle();

      expect(second.send).toHaveBeenCalledTimes(1);
      expect(stream.getSnapshot().status).toBe("ready");
      await start;
      await stream.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores delayed messages from the old connection after resubscribe", async () => {
    vi.useFakeTimers();
    try {
      const first = new FakeConnection();
      const second = new FakeConnection();
      const runtime = runtimeFor(first, undefined, [first, second]);
      const { stream } = createStream(first, runtime, { reconnectDelayMs: 0 });

      await startWithOpen(stream, first);
      first.emit("message", catalog(1));
      first.emit("close");
      await vi.advanceTimersByTimeAsync(0);
      await settle();

      expect(second.send).toHaveBeenCalledTimes(1);
      first.emit("message", catalog(99));
      expect(stream.getSnapshot().catalogRevision).toBe(1);

      second.emit("message", catalog(2));
      expect(stream.getSnapshot().catalogRevision).toBe(2);
      await stream.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores catalog messages until the active connection generation is subscribed", async () => {
    const connection = new FakeConnection();
    let resolveSubscribe!: () => void;
    connection.send.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveSubscribe = resolve; }));
    const { stream } = createStream(connection);

    const start = stream.start();
    await settle();
    connection.emit("open");
    await settle();

    connection.emit("message", catalog(1));
    expect(stream.getSnapshot().catalogRevision).toBe(-1);

    resolveSubscribe();
    await start;
    connection.emit("message", catalog(1));
    expect(stream.getSnapshot().catalogRevision).toBe(1);
  });

  it("ignores messages from a closed generation", async () => {
    const { stream, connection } = createStream();
    await startWithOpen(stream, connection);
    connection.emit("message", catalog(1));
    const beforeClose = stream.getSnapshot();

    connection.emit("close");
    connection.emit("message", catalog(2));

    expect(stream.getSnapshot()).toMatchObject({
      status: "reconnecting",
      catalogRevision: beforeClose.catalogRevision,
      matches: beforeClose.matches,
    });
  });

  it("exposes valid lobby error envelopes instead of retaining ready state", async () => {
    const { stream, connection } = createStream();
    await startWithOpen(stream, connection);

    connection.emit("message", { __ott: true, type: "ott:error", error: "active_matches_unavailable" });
    expect(stream.getSnapshot()).toMatchObject({ status: "unavailable", message: "active_matches_unavailable" });

    connection.emit("message", { __ott: true, type: "ott:error", error: "resync_failed" });
    expect(stream.getSnapshot()).toMatchObject({ status: "error", message: "resync_failed" });
  });

  it("publishes immutable newer catalogs and ignores stale or malformed messages", async () => {
    const { stream, connection } = createStream();
    await startWithOpen(stream, connection);

    connection.emit("message", catalog(4));
    const first = stream.getSnapshot();
    expect(first).toMatchObject({ status: "ready", catalogRevision: 4, matches: [match()] });
    expect(Object.isFrozen(first.matches)).toBe(true);
    expect(Object.isFrozen(first.matches[0])).toBe(true);
    expect(Object.isFrozen(first.matches[0]?.players)).toBe(true);

    connection.emit("message", catalog(3, []));
    connection.emit("message", { __ott: true, type: "ott:foreign", catalogRevision: 9, matches: [] });
    connection.emit("message", "not-json");
    expect(stream.getSnapshot()).toBe(first);

    connection.emit("message", catalog(5, []));
    expect(stream.getSnapshot()).toMatchObject({ status: "ready", catalogRevision: 5, matches: [] });
  });

  it("bounds reconnect attempts and reports a post-open failure as error", async () => {
    const first = new FakeConnection();
    const second = new FakeConnection();
    const third = new FakeConnection();
    const runtime = runtimeFor(first, undefined, [first, second, third]);
    const { stream } = createStream(first, runtime, { maxReconnectAttempts: 2 });
    await startWithOpen(stream, first);
    second.connect.mockRejectedValue(new Error("reconnect failed"));
    third.connect.mockRejectedValue(new Error("reconnect failed"));

    first.emit("close");
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settle();

    expect(first.connect).toHaveBeenCalledTimes(1);
    expect(second.connect).toHaveBeenCalledTimes(1);
    expect(third.connect).toHaveBeenCalledTimes(1);
    expect(stream.getSnapshot().status).toBe("error");
  });

  it("shares concurrent disposal and ignores stale callbacks until disposal completes", async () => {
    const connection = new FakeConnection();
    let resolveClose!: () => void;
    connection.close.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveClose = resolve; }));
    const runtime = runtimeFor(connection);
    const { stream } = createStream(connection, runtime);
    const listener = vi.fn();
    stream.subscribe(listener);
    await startWithOpen(stream, connection);
    const beforeDispose = stream.getSnapshot();

    const dispose = stream.dispose();
    const concurrentDispose = stream.dispose();
    expect(concurrentDispose).toBe(dispose);
    await settle();
    expect(runtime.dispose).not.toHaveBeenCalled();
    expect(stream.getSnapshot().status).toBe("unavailable");
    connection.emit("message", catalog(8));
    expect(stream.getSnapshot().matches).toEqual([]);
    expect(stream.getSnapshot()).not.toBe(beforeDispose);

    resolveClose();
    await dispose;
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });

  it("shares the disposal promise when a listener disposes during notification", async () => {
    const { stream, connection } = createStream();
    await startWithOpen(stream, connection);
    let disposing = false;
    let reentrantDispose: Promise<void> | undefined;
    stream.subscribe(() => {
      if (stream.getSnapshot().status === "unavailable" && !disposing) {
        disposing = true;
        reentrantDispose = stream.dispose();
      }
    });

    const dispose = stream.dispose();

    expect(reentrantDispose).toBe(dispose);
    await dispose;
  });

  it("disposes safely while connect is pending", async () => {
    const connection = new FakeConnection();
    let resolveConnect!: () => void;
    connection.connect.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveConnect = resolve; }));
    const runtime = runtimeFor(connection);
    const { stream } = createStream(connection, runtime);
    const start = stream.start();
    await settle();
    connection.emit("open");
    await settle();

    const dispose = stream.dispose();
    resolveConnect();

    await expect(start).resolves.toBeUndefined();
    await dispose;
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes safely while subscribe send is pending", async () => {
    const connection = new FakeConnection();
    let resolveSend!: () => void;
    connection.send.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveSend = resolve; }));
    const runtime = runtimeFor(connection);
    const { stream } = createStream(connection, runtime);
    const start = stream.start();
    await settle();
    connection.emit("open");
    await settle();

    const dispose = stream.dispose();
    resolveSend();

    await expect(start).resolves.toBeUndefined();
    await dispose;
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });

  it("preserves runtime disposal rejection while clearing its listeners", async () => {
    const connection = new FakeConnection();
    const runtime = runtimeFor(connection);
    const failure = new Error("runtime dispose failed");
    vi.spyOn(runtime, "dispose").mockRejectedValue(failure);
    const { stream } = createStream(connection, runtime);
    await startWithOpen(stream, connection);

    await expect(stream.dispose()).rejects.toBe(failure);
    await expect(stream.dispose()).rejects.toBe(failure);
  });

  it("settles disposal when a listener throws during disposal notification", async () => {
    const connection = new FakeConnection();
    const runtime = runtimeFor(connection);
    const listenerError = new Error("listener failed");
    const { stream } = createStream(connection, runtime);
    await startWithOpen(stream, connection);
    stream.subscribe(() => {
      if (stream.getSnapshot().status === "unavailable") throw listenerError;
    });

    expect(() => stream.dispose()).not.toThrow();
    const dispose = stream.dispose();
    expect(stream.dispose()).toBe(dispose);
    await expect(dispose).rejects.toBe(listenerError);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });
});
