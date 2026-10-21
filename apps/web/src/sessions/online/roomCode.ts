const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROOM_ID = /^ott-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Normalizes what a player types or pastes into the room-code field: an invite link
 * (`…?join=K7N-M4P`), a short alias, a canonical room id (`ott-<uuid>`), a bare allocation id
 * or a tournament invite (`inv_…`). Returns the value the control API accepts.
 */
export function normalizeRoomCode(input: string): string {
  let value = input.trim();
  const fromLink = joinCodeFromUrl(value);
  if (fromLink) value = fromLink;
  if (value.startsWith("inv_")) return value;
  const roomId = ROOM_ID.exec(value);
  if (roomId) return roomId[1]!.toLowerCase();
  if (UUID.test(value)) return value.toLowerCase();
  // Aliases are case-insensitive on the server; only strip spaces a player may have typed.
  return value.replace(/\s+/g, "");
}

/** Reads `?join=` from a URL or search string; returns null when absent or not a URL. */
export function joinCodeFromUrl(value: string): string | null {
  if (!value.includes("join=")) return null;
  try {
    const search = value.startsWith("?") ? value : new URL(value, "https://ottv2.invalid").search;
    const code = new URLSearchParams(search).get("join");
    return code && code.trim() ? code.trim() : null;
  } catch {
    return null;
  }
}

/** Builds the shareable invite link for the current page. */
export function inviteLink(code: string, location: Pick<Location, "origin" | "pathname"> = window.location): string {
  return `${location.origin}${location.pathname}?join=${encodeURIComponent(code)}`;
}
