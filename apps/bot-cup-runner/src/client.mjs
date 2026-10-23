/**
 * HTTP client for the runner API (/runner/*, plan §10.3). Outbound only; the token goes in the Authorization header.
 * Reports (complete/fail) are retried on network errors: the API accepts a repeated report of the same attempt once.
 */

export class RunnerApiError extends Error {
  constructor(status, code, body) {
    super(`${status} ${code}`);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export function createRunnerClient({ baseUrl, token, fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const origin = baseUrl.replace(/\/$/, "");

  async function request(method, path, body) {
    const response = await fetchImpl(`${origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!response.ok) {
      let payload = {};
      try {
        payload = await response.json();
      } catch {
        payload = {};
      }
      throw new RunnerApiError(response.status, payload.error || "http_error", payload);
    }
    return response;
  }

  async function report(path, body) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await (await request("POST", path, body)).json();
      } catch (error) {
        // Only network failures and 5xx are worth repeating; 4xx answers are final (lease lost, rejected replay).
        const retryable = !(error instanceof RunnerApiError) || error.status >= 500;
        if (!retryable || attempt >= 5) throw error;
        await sleep(1000 * 2 ** (attempt - 1));
      }
    }
  }

  return {
    async heartbeat(info) {
      return (await request("POST", "/runner/heartbeat", info)).json();
    },
    async claim(slots) {
      return (await (await request("POST", "/runner/claim", { slots })).json()).jobs;
    },
    async source(sha256) {
      return new Uint8Array(await (await request("GET", `/runner/source/${sha256}`)).arrayBuffer());
    },
    complete(body) {
      return report("/runner/complete", body);
    },
    fail(body) {
      return report("/runner/fail", body);
    }
  };
}
