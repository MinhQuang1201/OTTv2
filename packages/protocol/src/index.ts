export const MAX_OTT_PAYLOAD_BYTES = 8 * 1024;
export const MIN_OTT_PACKET_INTERVAL_MS = 40;
export const MAX_PUBLIC_MATCH_NAME_LENGTH = 32;
export const MAX_PUBLIC_MATCH_SPECTATOR_COUNT = 100_000;
export const MAX_PUBLIC_MATCH_CLOCK_MS = 10 * 60 * 1000;
export const MAX_PUBLIC_MATCHES = 100;

const COMMAND_KEYS = {
  "ott:attach": ["__ott", "roomId", "type", "ticket"],
  "ott:spectate": ["__ott", "roomId", "type", "ticket"],
  "ott:move": ["__ott", "roomId", "type", "from", "to"],
  "ott:leave": ["__ott", "roomId", "type"],
} as const;

const RESPONSE_KEYS = {
  "ott:ack": ["__ott", "roomId", "revision", "type", "ok"],
  "ott:error": ["__ott", "roomId", "revision", "type", "error"],
  "ott:state": ["__ott", "roomId", "revision", "type", "state"],
} as const;

export type OttCommand =
  | { __ott: true; roomId: string; type: "ott:attach"; ticket: string }
  | { __ott: true; roomId: string; type: "ott:spectate"; ticket: string }
  | { __ott: true; roomId: string; type: "ott:move"; from: Coordinate; to: Coordinate }
  | { __ott: true; roomId: string; type: "ott:leave" };

export type Coordinate = { x: number; y: number };
export type Seat = "A" | "B";

export type PublicPlayerView = {
  readonly name: string;
  readonly connected: boolean;
  readonly remainingMs?: number;
};

export type PublicPlayers = Readonly<Record<Seat, PublicPlayerView | null>>;

export type PublicMatchPlayer = {
  readonly seat: Seat;
  readonly name: string;
  readonly connected: boolean;
  readonly remainingMs: number;
};

export type PublicMatchView = {
  readonly allocationId: string;
  readonly roomId: string;
  readonly status: "playing";
  readonly players: Readonly<Record<Seat, PublicMatchPlayer>>;
  readonly spectatorCount: number;
  readonly serverNow: number;
  readonly runningSeat: Seat | null;
};

export type PublicMatchCatalog = {
  readonly catalogRevision: number;
  readonly matches: readonly PublicMatchView[];
};

export type PublicMatchCatalogMessage = PublicMatchCatalog & {
  readonly __ott: true;
  readonly type: "ott:active-matches";
};

// Game-core owns the evolving state/event schema; protocol validation keeps these payloads opaque.
export type OpaqueGameState = Readonly<Record<string, unknown>>;
export type OpaqueGameEvent = Readonly<Record<string, unknown>>;
export type OttStatePayload = OpaqueGameState | SpectatorProjection;

export type ViewerIdentity =
  | { readonly role: "player"; readonly seat: Seat }
  | { readonly role: "spectator" };

export type SpectatorProjection = {
  readonly roomId: string;
  readonly status: "playing" | "finished";
  readonly revision: number;
  readonly serverNow: number;
  readonly players: PublicPlayers;
  readonly state: OpaqueGameState;
  readonly events: readonly OpaqueGameEvent[];
  readonly viewer: { readonly role: "spectator" };
  readonly spectatorCount: number;
};

export type OttResponse =
  | { __ott: true; roomId: string; revision: number; type: "ott:ack"; ok: true }
  | { __ott: true; roomId: string; revision: number; type: "ott:error"; error: string }
  | { __ott: true; roomId: string; revision: number; type: "ott:state"; state: OttStatePayload };

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function isCoordinate(value: unknown): value is Coordinate {
  return isRecord(value) && hasExactKeys(value, ["x", "y"]) &&
    Number.isInteger(value.x) && Number.isInteger(value.y);
}

const PUBLIC_MATCH_MESSAGE_KEYS = ["__ott", "catalogRevision", "matches", "type"] as const;
const PUBLIC_MATCH_KEYS = ["allocationId", "players", "roomId", "runningSeat", "serverNow", "spectatorCount", "status"] as const;
const PUBLIC_MATCH_PLAYER_KEYS = ["connected", "name", "remainingMs", "seat"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isSafeNonNegativeInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function isPublicMatchPlayer(value: unknown, seat: Seat): value is PublicMatchPlayer {
  if (!isRecord(value) || !hasExactKeys(value, PUBLIC_MATCH_PLAYER_KEYS)) return false;
  return value.seat === seat &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    value.name.length <= MAX_PUBLIC_MATCH_NAME_LENGTH &&
    typeof value.connected === "boolean" &&
    isSafeNonNegativeInteger(value.remainingMs, MAX_PUBLIC_MATCH_CLOCK_MS);
}

function isPublicMatch(value: unknown): value is PublicMatchView {
  if (!isRecord(value) || !hasExactKeys(value, PUBLIC_MATCH_KEYS)) return false;
  if (typeof value.allocationId !== "string" || !UUID_PATTERN.test(value.allocationId)) return false;
  if (value.roomId !== `ott-${value.allocationId}` || value.status !== "playing") return false;
  if (!isRecord(value.players) || !hasExactKeys(value.players, ["A", "B"])) return false;
  return isPublicMatchPlayer(value.players.A, "A") &&
    isPublicMatchPlayer(value.players.B, "B") &&
    isSafeNonNegativeInteger(value.spectatorCount, MAX_PUBLIC_MATCH_SPECTATOR_COUNT) &&
    isSafeNonNegativeInteger(value.serverNow, Number.MAX_SAFE_INTEGER) &&
    (value.runningSeat === null || value.runningSeat === "A" || value.runningSeat === "B");
}

export function validatePublicMatchSummary(value: unknown): ParseResult<PublicMatchView> {
  if (!isPublicMatch(value)) return { ok: false, error: "invalid_public_match_summary" };
  return { ok: true, value };
}

export function validatePublicMatchCatalog(value: unknown): ParseResult<PublicMatchCatalogMessage> {
  if (!isRecord(value) || !hasExactKeys(value, PUBLIC_MATCH_MESSAGE_KEYS) ||
      value.__ott !== true || value.type !== "ott:active-matches" ||
      !isSafeNonNegativeInteger(value.catalogRevision, Number.MAX_SAFE_INTEGER) ||
      !Array.isArray(value.matches) || value.matches.length > MAX_PUBLIC_MATCHES) {
    return { ok: false, error: "invalid_public_match_catalog" };
  }

  const allocationIds = new Set<string>();
  const roomIds = new Set<string>();
  for (const match of value.matches) {
    if (!isPublicMatch(match) || allocationIds.has(match.allocationId) || roomIds.has(match.roomId)) {
      return { ok: false, error: "invalid_public_match_catalog" };
    }
    allocationIds.add(match.allocationId);
    roomIds.add(match.roomId);
  }

  try {
    if (byteLength(JSON.stringify(value)) > MAX_OTT_PAYLOAD_BYTES) {
      return { ok: false, error: "invalid_payload" };
    }
  } catch {
    return { ok: false, error: "invalid_public_match_catalog" };
  }
  return { ok: true, value: value as PublicMatchCatalogMessage };
}

function parseJson(value: string): ParseResult<Record<string, unknown>> {
  if (typeof value !== "string" || byteLength(value) > MAX_OTT_PAYLOAD_BYTES) {
    return { ok: false, error: "invalid_payload" };
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? { ok: true, value: parsed } : { ok: false, error: "invalid_envelope" };
  } catch {
    return { ok: false, error: "invalid_json" };
  }
}

export function parseOttMessage(value: string): ParseResult<OttCommand> {
  const parsed = parseJson(value);
  if (!parsed.ok) return parsed;
  const object = parsed.value;
  if (object.__ott !== true || typeof object.roomId !== "string" || object.roomId.length === 0 || typeof object.type !== "string") {
    return { ok: false, error: "invalid_envelope" };
  }
  const keys = COMMAND_KEYS[object.type as keyof typeof COMMAND_KEYS];
  if (!keys || !hasExactKeys(object, keys)) return { ok: false, error: "unknown_command" };
  if ((object.type === "ott:attach" || object.type === "ott:spectate") &&
      typeof object.ticket === "string" && object.ticket.length > 0) {
    return { ok: true, value: object as OttCommand };
  }
  if (object.type === "ott:move" && isCoordinate(object.from) && isCoordinate(object.to)) {
    return { ok: true, value: object as OttCommand };
  }
  if (object.type === "ott:leave") return { ok: true, value: object as OttCommand };
  return { ok: false, error: "invalid_command" };
}

export function parseOttResponse(value: string): ParseResult<OttResponse> {
  const parsed = parseJson(value);
  if (!parsed.ok) return parsed;
  const object = parsed.value;
  const revision = object.revision as number;
  if (object.__ott !== true || typeof object.roomId !== "string" || object.roomId.length === 0 ||
      !Number.isInteger(revision) || revision < 0 || typeof object.type !== "string") {
    return { ok: false, error: "invalid_response" };
  }
  const keys = RESPONSE_KEYS[object.type as keyof typeof RESPONSE_KEYS];
  if (!keys || !hasExactKeys(object, keys)) return { ok: false, error: "invalid_response" };
  if (object.type === "ott:ack" && object.ok === true) return { ok: true, value: object as OttResponse };
  if (object.type === "ott:error" && typeof object.error === "string") return { ok: true, value: object as OttResponse };
  if (object.type === "ott:state" && isRecord(object.state)) return { ok: true, value: object as OttResponse };
  return { ok: false, error: "invalid_response" };
}

export function parsePublicMatchCatalog(value: string): ParseResult<PublicMatchCatalogMessage> {
  const parsed = parseJson(value);
  if (!parsed.ok) return parsed;
  return validatePublicMatchCatalog(parsed.value);
}
