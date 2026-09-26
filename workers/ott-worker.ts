import { routePartykitRequest } from "partyserver";
export { OttGameServer } from "./ott-game-server.js";
export { OttLobbyServer } from "./ott-lobby-server.js";

const PUBLIC_ROOM_PATH = /^\/parties\/main\/(ott-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    const controlPath = /^\/control\/(create|list|join|resume)\/?$/.test(pathname);
    const origin = request.headers.get("origin");
    const browserOriginAllowed = typeof env.OTT_BROWSER_ORIGIN === "string" && origin === env.OTT_BROWSER_ORIGIN;
    if (request.method === "OPTIONS" && controlPath && browserOriginAllowed) {
      return new Response(null, { status: 204, headers: corsHeaders(origin!) });
    }
    if (controlPath) {
      const response = await env.OTT_LOBBY.get(env.OTT_LOBBY.idFromName("lobby")).fetch(request);
      return browserOriginAllowed ? withCors(response, origin!) : response;
    }
    if (!PUBLIC_ROOM_PATH.test(pathname)) {
      return new Response("Not found", { status: 404 });
    }

    return (
      (await routePartykitRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  },
};

function corsHeaders(origin: string): Headers {
  return new Headers({
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    "vary": "Origin",
  });
}

function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of corsHeaders(origin)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
