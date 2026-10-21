type PublicRuntimeEnv = {
  [key: string]: unknown;
  VITE_OTT_PLAYHTML_HOST?: string;
  VITE_OTT_PLAYHTML_CONTROL_ENDPOINT?: string;
  VITE_OTT_ARENA_API_ENDPOINT?: string;
  VITE_OTT_ARENA_DISCOVERY_ENDPOINT?: string;
  VITE_OTT_SPECTATOR_ENABLED?: string | boolean;
};

export interface WebRuntimeConfig {
  host: string;
  controlEndpoint: string;
  arenaEndpoint?: string;
  discoveryEndpoint?: string;
  spectatorEnabled?: boolean;
}

function valueOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isSpectatorEnabled(envOrFlag?: boolean | string | PublicRuntimeEnv | null): boolean {
  if (typeof envOrFlag === "boolean") return envOrFlag;
  if (typeof envOrFlag === "string") {
    const normalized = envOrFlag.trim().toLowerCase();
    return normalized === "true" || normalized === "1";
  }
  if (envOrFlag && typeof envOrFlag === "object") {
    const direct = envOrFlag.VITE_OTT_SPECTATOR_ENABLED;
    if (typeof direct === "boolean") return direct;
    if (typeof direct === "string") {
      const normalized = direct.trim().toLowerCase();
      return normalized === "true" || normalized === "1";
    }
    return false;
  }
  const ambientDirect = typeof import.meta !== "undefined" ? (import.meta.env as PublicRuntimeEnv)?.VITE_OTT_SPECTATOR_ENABLED : undefined;
  if (typeof ambientDirect === "boolean") return ambientDirect;
  if (typeof ambientDirect === "string") {
    const normalized = ambientDirect.trim().toLowerCase();
    return normalized === "true" || normalized === "1";
  }
  if (typeof globalThis !== "undefined" && typeof (globalThis as any).OTT_SPECTATOR_ENABLED !== "undefined") {
    const globalVal = (globalThis as any).OTT_SPECTATOR_ENABLED;
    if (typeof globalVal === "boolean") return globalVal;
    if (typeof globalVal === "string") {
      const normalized = globalVal.trim().toLowerCase();
      return normalized === "true" || normalized === "1";
    }
  }
  return false;
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

export function resolveArenaDiscoveryEndpoint(env?: PublicRuntimeEnv): string {
  const sourceEnv = env ?? (typeof import.meta !== "undefined" ? (import.meta.env as PublicRuntimeEnv) : undefined);
  const direct = valueOf(sourceEnv?.VITE_OTT_ARENA_DISCOVERY_ENDPOINT);
  if (direct) return direct;
  if (typeof globalThis !== "undefined" && typeof (globalThis as any).OTT_ARENA_DISCOVERY_ENDPOINT === "string") {
    return valueOf((globalThis as any).OTT_ARENA_DISCOVERY_ENDPOINT);
  }
  return "";
}

export function isArenaAvailable(endpointOrEnv?: string | PublicRuntimeEnv | null): boolean {
  if (typeof endpointOrEnv === "string") {
    return endpointOrEnv.trim().length > 0;
  }
  if (endpointOrEnv && typeof endpointOrEnv === "object") {
    return resolveArenaEndpoint(endpointOrEnv).length > 0 || resolveArenaDiscoveryEndpoint(endpointOrEnv).length > 0;
  }
  return resolveArenaEndpoint().length > 0 || resolveArenaDiscoveryEndpoint().length > 0;
}

export function resolveWebRuntimeConfig(env: PublicRuntimeEnv): WebRuntimeConfig | null {
  const controlEndpoint = valueOf(env.VITE_OTT_PLAYHTML_CONTROL_ENDPOINT);
  const host = valueOf(env.VITE_OTT_PLAYHTML_HOST) || controlEndpoint;
  if (!host || !controlEndpoint) return null;
  const arenaEndpoint = valueOf(env.VITE_OTT_ARENA_API_ENDPOINT);
  const discoveryEndpoint = valueOf(env.VITE_OTT_ARENA_DISCOVERY_ENDPOINT);
  const spectatorEnabled = isSpectatorEnabled(env);
  return {
    host,
    controlEndpoint,
    ...(arenaEndpoint ? { arenaEndpoint } : {}),
    ...(discoveryEndpoint ? { discoveryEndpoint } : {}),
    ...(spectatorEnabled ? { spectatorEnabled: true } : {}),
  };
}

export function applyWebRuntimeConfig(env: PublicRuntimeEnv, target: typeof globalThis = globalThis): WebRuntimeConfig | null {
  const arenaEndpoint = valueOf(env.VITE_OTT_ARENA_API_ENDPOINT);
  if (arenaEndpoint) {
    (target as any).OTT_ARENA_API_ENDPOINT = arenaEndpoint;
  }
  const discoveryEndpoint = valueOf(env.VITE_OTT_ARENA_DISCOVERY_ENDPOINT);
  if (discoveryEndpoint) {
    (target as any).OTT_ARENA_DISCOVERY_ENDPOINT = discoveryEndpoint;
  }
  const spectatorEnabled = isSpectatorEnabled(env);
  (target as any).OTT_SPECTATOR_ENABLED = spectatorEnabled;
  const config = resolveWebRuntimeConfig(env);
  if (!config) return null;
  target.OTT_PLAYHTML_HOST = config.host;
  target.OTT_PLAYHTML_CONTROL_ENDPOINT = config.controlEndpoint;
  if (config.arenaEndpoint) {
    (target as any).OTT_ARENA_API_ENDPOINT = config.arenaEndpoint;
  }
  if (config.discoveryEndpoint) {
    (target as any).OTT_ARENA_DISCOVERY_ENDPOINT = config.discoveryEndpoint;
  }
  return config;
}

applyWebRuntimeConfig(import.meta.env);

