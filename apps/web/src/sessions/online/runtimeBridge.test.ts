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
});
