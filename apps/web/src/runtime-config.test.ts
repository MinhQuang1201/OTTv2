import { describe, expect, it } from "vitest";
import { applyWebRuntimeConfig, resolveWebRuntimeConfig } from "./runtime-config";

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
});
