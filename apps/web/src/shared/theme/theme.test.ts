import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyTheme,
  getSafeLocalStorage,
  initialTheme,
  persistTheme,
  THEME_STORAGE_KEY,
} from "./theme";

describe("Theme behavior & management", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
  });

  describe("initialTheme", () => {
    it("uses saved preference before OS fallback", () => {
      const mockStorage = {
        getItem: (key: string) => (key === THEME_STORAGE_KEY ? "dark" : null),
      };
      expect(initialTheme(mockStorage, false)).toBe("dark");

      const lightStorage = {
        getItem: (key: string) => (key === THEME_STORAGE_KEY ? "light" : null),
      };
      expect(initialTheme(lightStorage, true)).toBe("light");
    });

    it("defaults to light when no valid saved preference and OS prefers dark is false", () => {
      expect(initialTheme(null, false)).toBe("light");
      expect(initialTheme({ getItem: () => "invalid" }, false)).toBe("light");
    });

    it("uses prefersDark fallback when storage has no saved theme", () => {
      expect(initialTheme(null, true)).toBe("dark");
      expect(initialTheme({ getItem: () => null }, true)).toBe("dark");
    });

    it("handles restricted/throwing storage without crashing", () => {
      const blockedStorage = {
        getItem() {
          throw new Error("QuotaExceeded / SecurityError");
        },
      };
      expect(() => initialTheme(blockedStorage, false)).not.toThrow();
      expect(initialTheme(blockedStorage, false)).toBe("light");
      expect(initialTheme(blockedStorage, true)).toBe("dark");
    });
  });

  describe("persistTheme", () => {
    it("saves preference to storage under expected key", () => {
      let savedKey: string | null = null;
      let savedValue: string | null = null;
      const mockStorage = {
        setItem(key: string, value: string) {
          savedKey = key;
          savedValue = value;
        },
      };

      persistTheme(mockStorage, "dark");
      expect(savedKey).toBe(THEME_STORAGE_KEY);
      expect(savedValue).toBe("dark");
    });

    it("swallows storage errors gracefully", () => {
      const blockedStorage = {
        setItem() {
          throw new Error("Blocked");
        },
      };
      expect(() => persistTheme(blockedStorage, "dark")).not.toThrow();
    });
  });

  describe("applyTheme", () => {
    it("sets data-theme and colorScheme on the target element", () => {
      const div = document.createElement("div");
      applyTheme("dark", div);
      expect(div.getAttribute("data-theme")).toBe("dark");
      expect(div.style.colorScheme).toBe("dark");

      applyTheme("light", div);
      expect(div.getAttribute("data-theme")).toBe("light");
      expect(div.style.colorScheme).toBe("light");
    });

    it("defaults to document.documentElement when target is omitted", () => {
      applyTheme("dark");
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
      expect(document.documentElement.style.colorScheme).toBe("dark");
    });
  });

  describe("throwing window.localStorage getter resilience", () => {
    let originalProperty: PropertyDescriptor | undefined;

    beforeEach(() => {
      originalProperty = Object.getOwnPropertyDescriptor(window, "localStorage");
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new DOMException("The operation is insecure.", "SecurityError");
        },
        configurable: true,
      });
    });

    afterEach(() => {
      if (originalProperty) {
        Object.defineProperty(window, "localStorage", originalProperty);
      }
    });

    it("getSafeLocalStorage returns null when getter throws SecurityError", () => {
      expect(() => getSafeLocalStorage()).not.toThrow();
      expect(getSafeLocalStorage()).toBeNull();
    });

    it("initialTheme() safely resolves without throwing when getter throws", () => {
      expect(() => initialTheme()).not.toThrow();
      expect(initialTheme()).toBe("light");
      expect(initialTheme(undefined, true)).toBe("dark");
    });

    it("persistTheme() safely handles throwing getter without crashing", () => {
      expect(() => persistTheme(undefined, "dark")).not.toThrow();
    });
  });
});
