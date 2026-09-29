type PublicRuntimeEnv = {
  [key: string]: unknown;
  VITE_OTT_PLAYHTML_HOST?: string;
  VITE_OTT_PLAYHTML_CONTROL_ENDPOINT?: string;
};

export interface WebRuntimeConfig {
  host: string;
  controlEndpoint: string;
}

function valueOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function resolveWebRuntimeConfig(env: PublicRuntimeEnv): WebRuntimeConfig | null {
  const controlEndpoint = valueOf(env.VITE_OTT_PLAYHTML_CONTROL_ENDPOINT);
  const host = valueOf(env.VITE_OTT_PLAYHTML_HOST) || controlEndpoint;
  if (!host || !controlEndpoint) return null;
  return { host, controlEndpoint };
}

export function applyWebRuntimeConfig(env: PublicRuntimeEnv, target: typeof globalThis = globalThis): WebRuntimeConfig | null {
  const config = resolveWebRuntimeConfig(env);
  if (!config) return null;
  target.OTT_PLAYHTML_HOST = config.host;
  target.OTT_PLAYHTML_CONTROL_ENDPOINT = config.controlEndpoint;
  return config;
}

applyWebRuntimeConfig(import.meta.env);
