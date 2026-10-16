import { describe, expect, it } from "vitest";
import { applyWebRuntimeConfig, isArenaAvailable, isSpectatorEnabled, resolveArenaDiscoveryEndpoint, resolveArenaEndpoint, resolveWebRuntimeConfig } from "./runtime-config";

describe("web runtime configuration", () => {
  it("maps public Vite endpoint settings to the online globals", () => {
    const target = {} as typeof globalThis;
    applyWebRuntimeConfig({
      VITE_OTT_PLAYHTML_HOST: "https://worker.example.com",
      VITE_OTT_PLAYHTML_CONTROL_ENDPOINT: "https://worker.example.com",
    }, target);
    expect(target.OTT_PLAYHTML_HOST).toBe("https://worker.example.com");
    expect(target.OTT_PLAYHTML_CONTROL_ENDPOINT).toBe("https://worker.example.com");
  });

  it("does not register an incomplete public configuration", () => {
    const target = {} as typeof globalThis;
    applyWebRuntimeConfig({ VITE_OTT_PLAYHTML_HOST: "" }, target);
    expect(target.OTT_PLAYHTML_HOST).toBeUndefined();
    expect(target.OTT_PLAYHTML_CONTROL_ENDPOINT).toBeUndefined();
  });

  it("uses the control endpoint as the host when host is omitted", () => {
    expect(resolveWebRuntimeConfig({
      VITE_OTT_PLAYHTML_CONTROL_ENDPOINT: "http://127.0.0.1:8900",
    })).toEqual({
      host: "http://127.0.0.1:8900",
      controlEndpoint: "http://127.0.0.1:8900",
    });
  });

  it("resolves and applies VITE_OTT_ARENA_API_ENDPOINT", () => {
    const target = {} as typeof globalThis;
    const config = applyWebRuntimeConfig({
      VITE_OTT_PLAYHTML_HOST: "https://worker.example.com",
      VITE_OTT_PLAYHTML_CONTROL_ENDPOINT: "https://worker.example.com",
      VITE_OTT_ARENA_API_ENDPOINT: "https://arena.example.com/api/arena/v1",
    }, target);
    expect(config?.arenaEndpoint).toBe("https://arena.example.com/api/arena/v1");
    expect((target as any).OTT_ARENA_API_ENDPOINT).toBe("https://arena.example.com/api/arena/v1");
    expect(resolveArenaEndpoint({ VITE_OTT_ARENA_API_ENDPOINT: "  http://127.0.0.1:8787 " })).toBe("http://127.0.0.1:8787");
    expect(isArenaAvailable("http://127.0.0.1:8787")).toBe(true);
    expect(isArenaAvailable({ VITE_OTT_ARENA_API_ENDPOINT: "http://127.0.0.1:8787" })).toBe(true);
    expect(isArenaAvailable("")).toBe(false);
    expect(isArenaAvailable({ VITE_OTT_ARENA_API_ENDPOINT: "" })).toBe(false);
  });

  it("resolves and applies VITE_OTT_ARENA_DISCOVERY_ENDPOINT", () => {
    const target = {} as typeof globalThis;
    const config = applyWebRuntimeConfig({
      VITE_OTT_PLAYHTML_HOST: "https://worker.example.com",
      VITE_OTT_PLAYHTML_CONTROL_ENDPOINT: "https://worker.example.com",
      VITE_OTT_ARENA_DISCOVERY_ENDPOINT: "https://discovery.example.com/endpoint",
    }, target);
    expect(config?.discoveryEndpoint).toBe("https://discovery.example.com/endpoint");
    expect((target as any).OTT_ARENA_DISCOVERY_ENDPOINT).toBe("https://discovery.example.com/endpoint");
    expect(resolveArenaDiscoveryEndpoint({ VITE_OTT_ARENA_DISCOVERY_ENDPOINT: "  https://discovery.example.com/endpoint " })).toBe("https://discovery.example.com/endpoint");
    expect(isArenaAvailable({ VITE_OTT_ARENA_DISCOVERY_ENDPOINT: "https://discovery.example.com/endpoint" })).toBe(true);
    expect(isArenaAvailable({ VITE_OTT_ARENA_DISCOVERY_ENDPOINT: "" })).toBe(false);
    expect(isArenaAvailable({ VITE_OTT_ARENA_API_ENDPOINT: "", VITE_OTT_ARENA_DISCOVERY_ENDPOINT: "" })).toBe(false);
  });

  it("keeps online host, control endpoint, and connection factory untouched when arena endpoint is set", () => {
    const target = {} as typeof globalThis;
    applyWebRuntimeConfig({
      VITE_OTT_PLAYHTML_HOST: "https://worker.example.com",
      VITE_OTT_PLAYHTML_CONTROL_ENDPOINT: "https://worker.example.com",
      VITE_OTT_ARENA_API_ENDPOINT: "http://127.0.0.1:8787/api/arena/v1",
    }, target);
    expect(target.OTT_PLAYHTML_HOST).toBe("https://worker.example.com");
    expect(target.OTT_PLAYHTML_CONTROL_ENDPOINT).toBe("https://worker.example.com");
    expect((target as any).OTT_PLAYHTML_CONNECTION_FACTORY).toBeUndefined();
    expect((target as any).OTT_ARENA_API_ENDPOINT).toBe("http://127.0.0.1:8787/api/arena/v1");
  });

  it("defaults spectator capability to false and parses boolean and string values", () => {
    expect(isSpectatorEnabled()).toBe(false);
    expect(isSpectatorEnabled({})).toBe(false);
    expect(isSpectatorEnabled({ VITE_OTT_SPECTATOR_ENABLED: "" })).toBe(false);
    expect(isSpectatorEnabled({ VITE_OTT_SPECTATOR_ENABLED: "false" })).toBe(false);
    expect(isSpectatorEnabled({ VITE_OTT_SPECTATOR_ENABLED: "0" })).toBe(false);
    expect(isSpectatorEnabled({ VITE_OTT_SPECTATOR_ENABLED: false })).toBe(false);
    expect(isSpectatorEnabled({ VITE_OTT_SPECTATOR_ENABLED: "off" })).toBe(false);

    expect(isSpectatorEnabled({ VITE_OTT_SPECTATOR_ENABLED: "true" })).toBe(true);
    expect(isSpectatorEnabled({ VITE_OTT_SPECTATOR_ENABLED: "1" })).toBe(true);
    expect(isSpectatorEnabled({ VITE_OTT_SPECTATOR_ENABLED: true })).toBe(true);
    expect(isSpectatorEnabled(true)).toBe(true);
    expect(isSpectatorEnabled(false)).toBe(false);
    expect(isSpectatorEnabled("true")).toBe(true);
    expect(isSpectatorEnabled("false")).toBe(false);
  });

  it("applies spectator flag to WebRuntimeConfig and globalThis target", () => {
    const target = {} as typeof globalThis;
    const configOff = applyWebRuntimeConfig({
      VITE_OTT_PLAYHTML_HOST: "https://worker.example.com",
      VITE_OTT_PLAYHTML_CONTROL_ENDPOINT: "https://worker.example.com",
      VITE_OTT_SPECTATOR_ENABLED: "false",
    }, target);
    expect(configOff?.spectatorEnabled).toBeUndefined();
    expect((target as any).OTT_SPECTATOR_ENABLED).toBe(false);

    const configOn = applyWebRuntimeConfig({
      VITE_OTT_PLAYHTML_HOST: "https://worker.example.com",
      VITE_OTT_PLAYHTML_CONTROL_ENDPOINT: "https://worker.example.com",
      VITE_OTT_SPECTATOR_ENABLED: "true",
    }, target);
    expect(configOn?.spectatorEnabled).toBe(true);
    expect((target as any).OTT_SPECTATOR_ENABLED).toBe(true);
  });

  it("enforces explicit object authority over stale globals and prevents re-enabling", () => {
    const originalGlobal = (globalThis as any).OTT_SPECTATOR_ENABLED;
    try {
      (globalThis as any).OTT_SPECTATOR_ENABLED = true;

      // Explicit object authority: explicit false or missing must NOT fall through to stale global true
      expect(isSpectatorEnabled({})).toBe(false);
      expect(isSpectatorEnabled({ VITE_OTT_SPECTATOR_ENABLED: "false" })).toBe(false);
      expect(isSpectatorEnabled({ VITE_OTT_SPECTATOR_ENABLED: false })).toBe(false);
      expect(isSpectatorEnabled({ VITE_OTT_SPECTATOR_ENABLED: "" })).toBe(false);
      expect(isSpectatorEnabled({ VITE_OTT_SPECTATOR_ENABLED: "0" })).toBe(false);

      // Explicit true still evaluates to true
      expect(isSpectatorEnabled({ VITE_OTT_SPECTATOR_ENABLED: "true" })).toBe(true);
      expect(isSpectatorEnabled({ VITE_OTT_SPECTATOR_ENABLED: true })).toBe(true);

      // Sequential application: applying a config with spectator disabled resets target even if previously true
      const target = { OTT_SPECTATOR_ENABLED: true } as unknown as typeof globalThis;
      const config1 = applyWebRuntimeConfig({
        VITE_OTT_PLAYHTML_HOST: "https://worker.example.com",
        VITE_OTT_PLAYHTML_CONTROL_ENDPOINT: "https://worker.example.com",
        VITE_OTT_SPECTATOR_ENABLED: "false",
      }, target);
      expect(config1?.spectatorEnabled).toBeUndefined();
      expect((target as any).OTT_SPECTATOR_ENABLED).toBe(false);

      // Sequential application: missing flag in config also disables and does not re-enable from stale global
      (target as any).OTT_SPECTATOR_ENABLED = true;
      const config2 = applyWebRuntimeConfig({
        VITE_OTT_PLAYHTML_HOST: "https://worker.example.com",
        VITE_OTT_PLAYHTML_CONTROL_ENDPOINT: "https://worker.example.com",
      }, target);
      expect(config2?.spectatorEnabled).toBeUndefined();
      expect((target as any).OTT_SPECTATOR_ENABLED).toBe(false);
    } finally {
      if (typeof originalGlobal === "undefined") {
        delete (globalThis as any).OTT_SPECTATOR_ENABLED;
      } else {
        (globalThis as any).OTT_SPECTATOR_ENABLED = originalGlobal;
      }
    }
  });
});
