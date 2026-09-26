import { internalRequest, issueCapability } from "./internal-auth.js";
export { OttTestGameServer } from "./ott-test-game-server.js";

type TestEnv = Env & { OTT_TEST_PROBE_SECRET: string };

function authorized(request: Request, env: TestEnv): boolean {
  return request.headers.get("x-ott-test-probe-secret") === env.OTT_TEST_PROBE_SECRET;
}

export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    const url = new URL(request.url);
    if (!authorized(request, env)) return new Response("Not found", { status: 404 });
    if (url.pathname === "/__test/ready") return Response.json({ ok: true });
    if (url.pathname === "/__test/inspect" && request.method === "GET") {
      const roomId = url.searchParams.get("roomId");
      const nonce = url.searchParams.get("nonce");
      if (!roomId || !nonce) return new Response("Bad request", { status: 400 });
      return env.Main.get(env.Main.idFromName(roomId)).fetch(new Request(`https://test.invalid/__test/inspect?nonce=${encodeURIComponent(nonce)}`));
    }
    if (url.pathname === "/__test/issue-initialization" && request.method === "POST") {
      let body: { allocationId?: string; roomId?: string; nonce?: string; expiresAt?: number };
      try { body = await request.json(); } catch { return new Response("Bad request", { status: 400 }); }
      if (
        typeof body.allocationId !== "string" ||
        typeof body.roomId !== "string" ||
        typeof body.nonce !== "string" ||
        !/^ott-[0-9a-f-]{36}$/.test(body.roomId)
      ) return new Response("Bad request", { status: 400 });
      const now = Date.now();
      const capability = await issueCapability(env.OTT_INTERNAL_SECRET, {
        allocationId: body.allocationId,
        roomId: body.roomId,
        purpose: "game-init",
        seat: "A",
        nonce: body.nonce,
        now,
        ttlMs: typeof body.expiresAt === "number" ? body.expiresAt - now : undefined,
      });
      return Response.json({ capability });
    }
    if (url.pathname === "/__test/invoke-initialization" && request.method === "POST") {
      let body: { allocationId?: string; roomId?: string; creatorName?: string; creatorAttachDeadlineMs?: number; capability?: string };
      try { body = await request.json(); } catch { return new Response("Bad request", { status: 400 }); }
      if (typeof body.roomId !== "string") return new Response("Bad request", { status: 400 });
      return env.Main.get(env.Main.idFromName(body.roomId)).fetch(internalRequest(env.OTT_INTERNAL_SECRET, "/internal/initialize", body));
    }
    if (url.pathname === "/__test/issue-attach" && request.method === "POST") {
      let body: { allocationId?: string; roomId?: string; nonce?: string };
      try { body = await request.json(); } catch { return new Response("Bad request", { status: 400 }); }
      if (typeof body.allocationId !== "string" || typeof body.roomId !== "string" || typeof body.nonce !== "string") return new Response("Bad request", { status: 400 });
      return Response.json({ capability: await issueCapability(env.OTT_INTERNAL_SECRET, {
        allocationId: body.allocationId,
        roomId: body.roomId,
        purpose: "attach",
        seat: "A",
        nonce: body.nonce,
      }) });
    }
    if (url.pathname === "/__test/consume-attach" && request.method === "POST") {
      let body: { roomId?: string; capability?: string };
      try { body = await request.json(); } catch { return new Response("Bad request", { status: 400 }); }
      if (typeof body.roomId !== "string" || typeof body.capability !== "string") return new Response("Bad request", { status: 400 });
      return env.Main.get(env.Main.idFromName(body.roomId)).fetch(new Request("https://test.invalid/__test/consume-attach", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability: body.capability }),
      }));
    }
    if (url.pathname !== "/__test/initialize" || request.method !== "POST") return new Response("Not found", { status: 404 });

    let body: { roomId?: string };
    try { body = await request.json(); } catch { return new Response("Bad request", { status: 400 }); }
    if (typeof body.roomId !== "string" || !/^ott-[0-9a-f-]{36}$/.test(body.roomId)) return new Response("Bad request", { status: 400 });

    const allocationId = crypto.randomUUID();
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const capability = await issueCapability(env.OTT_INTERNAL_SECRET, {
      allocationId,
      roomId: body.roomId,
      purpose: "game-init",
      seat: "A",
      nonce,
    });
    const response = await env.Main.get(env.Main.idFromName(body.roomId)).fetch(internalRequest(env.OTT_INTERNAL_SECRET, "/internal/initialize", {
      allocationId,
      roomId: body.roomId,
      creatorName: "Test creator",
      creatorAttachDeadlineMs: Date.now() + 60_000,
      capability,
    }));
    if (!response.ok) return new Response("Initialization failed", { status: response.status });
    return Response.json({ roomId: body.roomId, nonce });
  },
};
