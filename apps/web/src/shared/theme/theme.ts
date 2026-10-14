import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "ott-theme";

/**
 * Safely accesses window.localStorage without throwing when the property getter
 * itself is restricted (e.g. SecurityError in sandboxed iframe or third-party context).
 */
export function getSafeLocalStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Resolves the initial theme preference.
 * Defaults to "light" in accordance with user requirements ("light default and dark toggle"),
 * but respects saved user preference if valid ("light" | "dark") and system preference when fallback is requested.
 * If storage argument is omitted, uses safe local storage getter that catches SecurityError.
 */
export function initialTheme(
  storage?: Pick<Storage, "getItem"> | null,
  prefersDark = false,
): Theme {
  try {
    const s = storage !== undefined ? storage : getSafeLocalStorage();
    const saved = s?.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* Restricted storage must not prevent the UI from opening */
  }
  return prefersDark ? "dark" : "light";
}

/**
 * Persists theme preference safely to storage.
 * If storage argument is omitted, uses safe local storage getter that catches SecurityError.
 */
export function persistTheme(
  storage?: Pick<Storage, "setItem"> | null,
  theme: Theme = "light",
): void {
  try {
    const s = storage !== undefined ? storage : getSafeLocalStorage();
    s?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* Blocked storage fails silently; session toggle still works */
  }
}

/**
 * Applies the given theme to a DOM element (defaults to document.documentElement).
 */
export function applyTheme(theme: Theme, target?: HTMLElement | null): void {
  const el = target ?? (typeof document !== "undefined" ? document.documentElement : null);
  if (!el) return;
  el.setAttribute("data-theme", theme);
  el.style.colorScheme = theme;
}

/**
 * Helper to check system dark mode preference safely.
 */
export function getSystemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

/**
 * React hook to read and toggle the active theme with safe local storage persistence and DOM attribute synchronization.
 * Never accesses window.localStorage directly, protecting against throwing SecurityError getters.
 */
export function useTheme(initialValue?: Theme) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (initialValue) return initialValue;
    return initialTheme(undefined, getSystemPrefersDark());
  });

  const setTheme = useCallback((nextTheme: Theme) => {
    setThemeState(nextTheme);
    if (typeof window !== "undefined") {
      applyTheme(nextTheme);
      persistTheme(undefined, nextTheme);
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((current) => {
      const nextTheme: Theme = current === "dark" ? "light" : "dark";
      if (typeof window !== "undefined") {
        applyTheme(nextTheme);
        persistTheme(undefined, nextTheme);
      }
      return nextTheme;
    });
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return {
    theme,
    setTheme,
    toggleTheme,
    isDark: theme === "dark",
  };
}
