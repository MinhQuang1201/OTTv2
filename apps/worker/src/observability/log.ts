// One JSON object per line so Workers Logs can index and filter by field.
export type LogEvent =
  | "authority_unavailable"
  | "transaction-failed"
  | "rate_limited"
  | "allocation_gc"
  | "game_storage_wiped";

export function logEvent(level: "info" | "warn" | "error", event: LogEvent, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}
