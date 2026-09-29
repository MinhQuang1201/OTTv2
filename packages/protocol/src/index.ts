export const MAX_OTT_PAYLOAD_BYTES = 8 * 1024;
export const MIN_OTT_PACKET_INTERVAL_MS = 40;

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
  if (object.__ott !== true || typeof object.roomId !== "string" || object.roomId.length === 0 ||
      !Number.isInteger(object.revision) || object.revision < 0 || typeof object.type !== "string") {
    return { ok: false, error: "invalid_response" };
  }
  const keys = RESPONSE_KEYS[object.type as keyof typeof RESPONSE_KEYS];
  if (!keys || !hasExactKeys(object, keys)) return { ok: false, error: "invalid_response" };
  if (object.type === "ott:ack" && object.ok === true) return { ok: true, value: object as OttResponse };
  if (object.type === "ott:error" && typeof object.error === "string") return { ok: true, value: object as OttResponse };
  if (object.type === "ott:state" && isRecord(object.state)) return { ok: true, value: object as OttResponse };
  return { ok: false, error: "invalid_response" };
}
