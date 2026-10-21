// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSoundEnabled, setSoundEnabled } from "./soundPreferences";

describe("soundPreferences", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("defaults to false when no preference is stored", () => {
    expect(getSoundEnabled()).toBe(false);
  });

  it("persists true when enabled", () => {
    setSoundEnabled(true);
    expect(getSoundEnabled()).toBe(true);
    expect(localStorage.getItem("ott:audio-enabled")).toBe("true");
  });

  it("persists false when disabled", () => {
    setSoundEnabled(true);
    expect(getSoundEnabled()).toBe(true);
    setSoundEnabled(false);
    expect(getSoundEnabled()).toBe(false);
    expect(localStorage.getItem("ott:audio-enabled")).toBe("false");
  });

  it("gracefully falls back when localStorage throws", () => {
    const originalGet = localStorage.getItem;
    localStorage.getItem = () => {
      throw new Error("SecurityError: Access is denied");
    };

    expect(getSoundEnabled()).toBe(false);

    localStorage.getItem = originalGet;
  });
});
