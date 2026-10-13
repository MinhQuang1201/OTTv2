import { describe, expect, it } from "vitest";
import { applyWebRuntimeConfig, isArenaAvailable, resolveArenaEndpoint, resolveWebRuntimeConfig } from "./runtime-config";

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
});
