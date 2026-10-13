type PublicRuntimeEnv = {
  [key: string]: unknown;
  VITE_OTT_PLAYHTML_HOST?: string;
  VITE_OTT_PLAYHTML_CONTROL_ENDPOINT?: string;
  VITE_OTT_ARENA_API_ENDPOINT?: string;
};

export interface WebRuntimeConfig {
  host: string;
  controlEndpoint: string;
  arenaEndpoint?: string;
}

function valueOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function resolveArenaEndpoint(env?: PublicRuntimeEnv): string {
  const sourceEnv = env ?? (typeof import.meta !== "undefined" ? (import.meta.env as PublicRuntimeEnv) : undefined);
  const direct = valueOf(sourceEnv?.VITE_OTT_ARENA_API_ENDPOINT);
  if (direct) return direct;
  if (typeof globalThis !== "undefined" && typeof (globalThis as any).OTT_ARENA_API_ENDPOINT === "string") {
    return valueOf((globalThis as any).OTT_ARENA_API_ENDPOINT);
  }
  return "";
}

export function isArenaAvailable(endpointOrEnv?: string | PublicRuntimeEnv | null): boolean {
  if (typeof endpointOrEnv === "string") {
    return endpointOrEnv.trim().length > 0;
  }
  if (endpointOrEnv && typeof endpointOrEnv === "object") {
    return resolveArenaEndpoint(endpointOrEnv).length > 0;
  }
  return resolveArenaEndpoint().length > 0;
}

export function resolveWebRuntimeConfig(env: PublicRuntimeEnv): WebRuntimeConfig | null {
  const controlEndpoint = valueOf(env.VITE_OTT_PLAYHTML_CONTROL_ENDPOINT);
  const host = valueOf(env.VITE_OTT_PLAYHTML_HOST) || controlEndpoint;
  if (!host || !controlEndpoint) return null;
  const arenaEndpoint = valueOf(env.VITE_OTT_ARENA_API_ENDPOINT);
  return arenaEndpoint ? { host, controlEndpoint, arenaEndpoint } : { host, controlEndpoint };
}

export function applyWebRuntimeConfig(env: PublicRuntimeEnv, target: typeof globalThis = globalThis): WebRuntimeConfig | null {
  const arenaEndpoint = valueOf(env.VITE_OTT_ARENA_API_ENDPOINT);
  if (arenaEndpoint) {
    (target as any).OTT_ARENA_API_ENDPOINT = arenaEndpoint;
  }
  const config = resolveWebRuntimeConfig(env);
  if (!config) return null;
  target.OTT_PLAYHTML_HOST = config.host;
  target.OTT_PLAYHTML_CONTROL_ENDPOINT = config.controlEndpoint;
  if (config.arenaEndpoint) {
    (target as any).OTT_ARENA_API_ENDPOINT = config.arenaEndpoint;
  }
  return config;
}

applyWebRuntimeConfig(import.meta.env);

