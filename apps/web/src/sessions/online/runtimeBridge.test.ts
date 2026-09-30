import { describe, expect, it, vi } from "vitest";
import { createRuntimeBridge } from "./runtimeBridge";

describe("runtimeBridge", () => {
  it("bootstraps one room and rejects rebinding the page to another room", async () => {
    const ready = Promise.resolve({ ready: true });
    const runtime = { configure: vi.fn(), init: vi.fn(() => ({ ready, createCustomMessageChannel: vi.fn() })) };
    const bootstrap = vi.fn(() => vi.fn(async () => ready));
    const connection = { on: vi.fn(), send: vi.fn() };
    const globalObject = { OTT_PLAYHTML_CONNECTION_FACTORY: vi.fn(() => connection) } as unknown as typeof globalThis;
    const bridge = createRuntimeBridge({ runtime, bootstrapFactory: { createBootstrap: bootstrap }, globalObject });

    await expect(bridge.bootstrap({ host: "https://play.example", room: "room-a" })).resolves.toEqual({ ready: true });
    await expect(bridge.bootstrap({ host: "https://play.example", room: "room-a" })).resolves.toEqual({ ready: true });
    await expect(bridge.bootstrap({ host: "https://play.example", room: "room-b" })).rejects.toThrow("already bound");
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(bridge.connectionFactory()).toBe(connection);
  });

  it("does not expose the connection until bootstrap has completed", async () => {
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    const runtime = { configure: vi.fn(), init: vi.fn(() => ({ ready, createCustomMessageChannel: vi.fn() })) };
    const bootstrap = vi.fn(() => vi.fn(async () => ready));
    const connection = { on: vi.fn(), send: vi.fn() };
    const globalObject = { OTT_PLAYHTML_CONNECTION_FACTORY: vi.fn(() => connection) } as unknown as typeof globalThis;
    const bridge = createRuntimeBridge({ runtime, bootstrapFactory: { createBootstrap: bootstrap }, globalObject });

    const pending = bridge.bootstrap({ host: "https://play.example", room: "room-a" });
    expect(bridge.connectionFactory).toThrow("not ready");
    resolveReady();
    await pending;
    expect(bridge.connectionFactory()).toBe(connection);
  });

  it("does not expose a connection factory when the reviewed runtime is unavailable", () => {
    const bridge = createRuntimeBridge({ globalObject: {} as typeof globalThis });
    expect(bridge.connectionFactory).toThrow("connection is not ready");
  });

  it("reuses an injected lifecycle owner without creating another runtime", async () => {
    const owner = {
      bootstrap: vi.fn(async () => undefined),
      connectionFactory: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };

    const bridge = createRuntimeBridge({ lifecycleOwner: owner });

    expect(bridge).toBe(owner);
    await bridge.bootstrap({ host: "https://play.example", room: "ott-lobby-public", party: "lobby" });
    await bridge.dispose();
    expect(owner.bootstrap).toHaveBeenCalledTimes(1);
    expect(owner.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes and allows rebinding to a different room", async () => {
    const ready = Promise.resolve({ ready: true });
    const runtime = { configure: vi.fn(), init: vi.fn(() => ({ ready, createCustomMessageChannel: vi.fn() })), reset: vi.fn() };
    const disposeFn = vi.fn();
    const bootstrapFn = vi.fn(async () => ready);
    const bootstrapInstance = Object.assign(bootstrapFn, { bootstrap: bootstrapFn, dispose: disposeFn });
    const createBootstrap = vi.fn(() => bootstrapInstance);
    const connection = { on: vi.fn(), send: vi.fn() };
    const globalObject = { OTT_PLAYHTML_CONNECTION_FACTORY: vi.fn(() => connection) } as unknown as typeof globalThis;
    const bridge = createRuntimeBridge({ runtime, bootstrapFactory: { createBootstrap }, globalObject });

    await bridge.bootstrap({ host: "https://play.example", room: "room-a" });
    await bridge.dispose();
    expect(disposeFn).toHaveBeenCalledTimes(1);

    await expect(bridge.bootstrap({ host: "https://play.example", room: "room-b" })).resolves.toEqual({ ready: true });
    expect(createBootstrap).toHaveBeenCalledTimes(2);
  });

  it("aborts pending initialization and prevents late readiness when disposed during init", async () => {
    let resolveReady!: () => void;
    const ready = new Promise<{ ready: boolean }>((resolve) => {
      resolveReady = () => resolve({ ready: true });
    });
    const runtime = { configure: vi.fn(), init: vi.fn(() => ({ ready, createCustomMessageChannel: vi.fn() })), reset: vi.fn() };
    const disposeFn = vi.fn();
    const bootstrapFn = vi.fn(async () => ready);
    const bootstrapInstance = Object.assign(bootstrapFn, { bootstrap: bootstrapFn, dispose: disposeFn });
    const createBootstrap = vi.fn(() => bootstrapInstance);
    const connection = { on: vi.fn(), send: vi.fn() };
    const globalObject = { OTT_PLAYHTML_CONNECTION_FACTORY: vi.fn(() => connection) } as unknown as typeof globalThis;
    const bridge = createRuntimeBridge({ runtime, bootstrapFactory: { createBootstrap }, globalObject });

    const pending = bridge.bootstrap({ host: "https://play.example", room: "room-a" });
    expect(bridge.connectionFactory).toThrow("not ready");

    await bridge.dispose();
    expect(disposeFn).toHaveBeenCalledTimes(1);
    expect(bridge.connectionFactory).toThrow("not ready");

    // Late resolution from pending bootstrap must not set ready = true
    resolveReady();
    await expect(pending).rejects.toThrow(/aborted|disposed/i);
    expect(bridge.connectionFactory).toThrow("not ready");

    // Rebinding after disposal should succeed cleanly
    const nextReady = Promise.resolve({ ready: true });
    const nextBootstrapFn = vi.fn(async () => nextReady);
    const nextInstance = Object.assign(nextBootstrapFn, { bootstrap: nextBootstrapFn, dispose: vi.fn() });
    createBootstrap.mockReturnValueOnce(nextInstance);

    await expect(bridge.bootstrap({ host: "https://play.example", room: "room-b" })).resolves.toEqual({ ready: true });
    expect(bridge.connectionFactory()).toBe(connection);
  });

  it("cleans up rejected initialization and allows retry or rebind", async () => {
    const runtime = { configure: vi.fn(), init: vi.fn(() => ({ ready: Promise.resolve(), createCustomMessageChannel: vi.fn() })) };
    const bootstrapFn = vi.fn().mockRejectedValueOnce(new Error("network failure"));
    const bootstrapInstance = Object.assign(bootstrapFn, { bootstrap: bootstrapFn, dispose: vi.fn() });
    const createBootstrap = vi.fn(() => bootstrapInstance);
    const connection = { on: vi.fn(), send: vi.fn() };
    const globalObject = { OTT_PLAYHTML_CONNECTION_FACTORY: vi.fn(() => connection) } as unknown as typeof globalThis;
    const bridge = createRuntimeBridge({ runtime, bootstrapFactory: { createBootstrap }, globalObject });

    await expect(bridge.bootstrap({ host: "https://play.example", room: "room-a" })).rejects.toThrow("network failure");
    expect(bridge.connectionFactory).toThrow("not ready");

    // Subsequent rebind should not be blocked by stale 'already bound' state
    const nextBootstrapFn = vi.fn(async () => ({ ready: true }));
    const nextInstance = Object.assign(nextBootstrapFn, { bootstrap: nextBootstrapFn, dispose: vi.fn() });
    createBootstrap.mockReturnValueOnce(nextInstance);

    await expect(bridge.bootstrap({ host: "https://play.example", room: "room-b" })).resolves.toEqual({ ready: true });
    expect(bridge.connectionFactory()).toBe(connection);
  });

  it("serializes disposal and concurrent rebind while resolving stale bootstrap safely", async () => {
    let resolveFirst!: (val: { ready: boolean }) => void;
    const firstReady = new Promise<{ ready: boolean }>((resolve) => {
      resolveFirst = resolve;
    });
    const runtime = { configure: vi.fn(), init: vi.fn(() => ({ ready: Promise.resolve(), createCustomMessageChannel: vi.fn() })), reset: vi.fn() };
    const firstBootstrapFn = vi.fn(async () => firstReady);
    const firstDisposeFn = vi.fn();
    const firstInstance = Object.assign(firstBootstrapFn, { bootstrap: firstBootstrapFn, dispose: firstDisposeFn });

    const secondReady = Promise.resolve({ ready: true });
    const secondBootstrapFn = vi.fn(async () => secondReady);
    const secondDisposeFn = vi.fn();
    const secondInstance = Object.assign(secondBootstrapFn, { bootstrap: secondBootstrapFn, dispose: secondDisposeFn });

    const createBootstrap = vi.fn()
      .mockReturnValueOnce(firstInstance)
      .mockReturnValueOnce(secondInstance);

    const connection = { on: vi.fn(), send: vi.fn() };
    const globalObject = { OTT_PLAYHTML_CONNECTION_FACTORY: vi.fn(() => connection) } as unknown as typeof globalThis;
    const bridge = createRuntimeBridge({ runtime, bootstrapFactory: { createBootstrap }, globalObject });

    const pendingFirst = bridge.bootstrap({ host: "https://play.example", room: "room-a" });
    const disposePromise = bridge.dispose();
    const pendingSecond = bridge.bootstrap({ host: "https://play.example", room: "room-b" });

    await disposePromise;
    expect(firstDisposeFn).toHaveBeenCalledTimes(1);

    resolveFirst({ ready: true });
    await expect(pendingFirst).rejects.toThrow(/aborted|disposed/i);

    await expect(pendingSecond).resolves.toEqual({ ready: true });
    expect(bridge.connectionFactory()).toBe(connection);
  });

  it("handles concurrent disposal calls during pending initialization without duplicate teardown", async () => {
    let resolveReady!: (val: { ready: boolean }) => void;
    const ready = new Promise<{ ready: boolean }>((resolve) => {
      resolveReady = resolve;
    });
    const runtime = { configure: vi.fn(), init: vi.fn(() => ({ ready: Promise.resolve(), createCustomMessageChannel: vi.fn() })), reset: vi.fn() };
    const disposeFn = vi.fn().mockImplementation(async () => {
      // Simulate async disposal delay
      await new Promise((r) => setTimeout(r, 10));
    });
    const bootstrapFn = vi.fn(async () => ready);
    const bootstrapInstance = Object.assign(bootstrapFn, { bootstrap: bootstrapFn, dispose: disposeFn });
    const createBootstrap = vi.fn(() => bootstrapInstance);
    const connection = { on: vi.fn(), send: vi.fn() };
    const globalObject = { OTT_PLAYHTML_CONNECTION_FACTORY: vi.fn(() => connection) } as unknown as typeof globalThis;
    const bridge = createRuntimeBridge({ runtime, bootstrapFactory: { createBootstrap }, globalObject });

    const pendingBootstrap = bridge.bootstrap({ host: "https://play.example", room: "room-a" });
    expect(bridge.connectionFactory).toThrow("not ready");

    // Invoke multiple concurrent disposals while bootstrap is pending
    const [d1, d2, d3] = [bridge.dispose(), bridge.dispose(), bridge.dispose()];

    await Promise.all([d1, d2, d3]);
    expect(disposeFn).toHaveBeenCalledTimes(1);
    expect(bridge.connectionFactory).toThrow("not ready");

    // Late resolution must not set ready or leak connection
    resolveReady({ ready: true });
    await expect(pendingBootstrap).rejects.toThrow(/aborted|disposed/i);
    expect(bridge.connectionFactory).toThrow("not ready");

    // Subsequent rebind should succeed
    const nextReady = Promise.resolve({ ready: true });
    const nextBootstrapFn = vi.fn(async () => nextReady);
    const nextInstance = Object.assign(nextBootstrapFn, { bootstrap: nextBootstrapFn, dispose: vi.fn() });
    createBootstrap.mockReturnValueOnce(nextInstance);

    await expect(bridge.bootstrap({ host: "https://play.example", room: "room-b" })).resolves.toEqual({ ready: true });
    expect(bridge.connectionFactory()).toBe(connection);
  });

  it("disposes the bootstrap instance on rejected initialization to clean up resources", async () => {
    const runtime = { configure: vi.fn(), init: vi.fn(() => ({ ready: Promise.resolve(), createCustomMessageChannel: vi.fn() })) };
    const disposeFn = vi.fn();
    const bootstrapFn = vi.fn().mockRejectedValueOnce(new Error("connection failed"));
    const bootstrapInstance = Object.assign(bootstrapFn, { bootstrap: bootstrapFn, dispose: disposeFn });
    const createBootstrap = vi.fn(() => bootstrapInstance);
    const connection = { on: vi.fn(), send: vi.fn() };
    const globalObject = { OTT_PLAYHTML_CONNECTION_FACTORY: vi.fn(() => connection) } as unknown as typeof globalThis;
    const bridge = createRuntimeBridge({ runtime, bootstrapFactory: { createBootstrap }, globalObject });

    await expect(bridge.bootstrap({ host: "https://play.example", room: "room-a" })).rejects.toThrow("connection failed");
    expect(disposeFn).toHaveBeenCalledTimes(1);
    expect(bridge.connectionFactory).toThrow("not ready");

    // Can bind cleanly after failed initialization cleanup
    const nextReady = Promise.resolve({ ready: true });
    const nextBootstrapFn = vi.fn(async () => nextReady);
    const nextInstance = Object.assign(nextBootstrapFn, { bootstrap: nextBootstrapFn, dispose: vi.fn() });
    createBootstrap.mockReturnValueOnce(nextInstance);

    await expect(bridge.bootstrap({ host: "https://play.example", room: "room-b" })).resolves.toEqual({ ready: true });
    expect(bridge.connectionFactory()).toBe(connection);
  });
});
