const PLAYER_NAME_KEY = "ottv2.playerName";

export function readPlayerName(): string {
  try {
    return window.localStorage.getItem(PLAYER_NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writePlayerName(value: string): void {
  try {
    if (value.trim()) window.localStorage.setItem(PLAYER_NAME_KEY, value.trim());
    else window.localStorage.removeItem(PLAYER_NAME_KEY);
  } catch {
    // Storage is an optional convenience. Private browsing and blocked storage
    // must not make the lobby unusable.
  }
}

