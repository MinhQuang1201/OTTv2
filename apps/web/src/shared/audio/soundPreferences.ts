const SOUND_STORAGE_KEY = "ott:audio-enabled";

/**
 * Safely reads the sound preference from localStorage.
 * Defaults to false (opt-in) and handles restricted environments (sandboxed iframes, disabled cookies).
 */
export function getSoundEnabled(): boolean {
  if (typeof window === "undefined" || !window.localStorage) {
    return false;
  }
  try {
    return window.localStorage.getItem(SOUND_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/**
 * Safely writes the sound preference to localStorage.
 */
export function setSoundEnabled(enabled: boolean): void {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(SOUND_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Ignore storage quota or access errors
  }
}
