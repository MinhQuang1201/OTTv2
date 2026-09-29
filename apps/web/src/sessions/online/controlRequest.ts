export interface ControlRequestError extends Error {
  readonly status?: number;
  readonly code?: string;
}

export interface ControlRequestOptions {
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
}

function endpointFrom(options: ControlRequestOptions): string {
  const endpoint = options.endpoint ?? globalThis.OTT_PLAYHTML_CONTROL_ENDPOINT;
  if (typeof endpoint !== "string" || !endpoint.trim()) throw new Error("Online control endpoint is unavailable");
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new Error("HTTPS required for control requests"); }
  if (parsed.protocol !== "https:") throw new Error("HTTPS required for control requests");
  return endpoint.replace(/\/$/, "");
}

export function createControlRequest(options: ControlRequestOptions = {}) {
  return async function controlRequest<T = unknown>(action: string, body: unknown = {}): Promise<T> {
    const endpoint = endpointFrom(options);
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") throw new Error("Online control endpoint is unavailable");
    const response = await fetchImpl(`${endpoint}/control/${encodeURIComponent(action)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let payload: any = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) {
      const error: ControlRequestError = Object.assign(new Error(typeof payload?.error === "string" ? payload.error : `Online request failed (${response.status})`), {
        status: response.status,
        code: typeof payload?.error === "string" ? payload.error : undefined,
      });
      throw error;
    }
    return payload as T;
  };
}

export const controlRequest = createControlRequest();
