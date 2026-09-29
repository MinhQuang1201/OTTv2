import { OttGameServer } from "./ott-game-server.js";

export class OttTestGameServer extends OttGameServer {
  override async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/__test/consume-attach" && request.method === "POST") {
      let body: { capability?: string };
      try { body = await request.json(); } catch { return new Response("Bad request", { status: 400 }); }
      if (typeof body.capability !== "string") return new Response("Bad request", { status: 400 });
      return new Response(null, { status: (await this.consumeAttachCapabilityForTest(body.capability)) ? 200 : 403 });
    }
    if (pathname !== "/__test/inspect") return super.fetch(request);

    const nonce = new URL(request.url).searchParams.get("nonce");
    const [roomId, receipt, consumedNonce, consumedAttachNonce] = await Promise.all([
      this.ctx.storage.get<string>("roomId"),
      this.ctx.storage.get("initialization-receipt"),
      nonce ? this.ctx.storage.get<number>(`nonce:${nonce}`) : undefined,
      nonce ? this.ctx.storage.get<number>(`attach-nonce:${nonce}`) : undefined,
    ]);
    return Response.json({ room: Boolean(roomId), receipt: Boolean(receipt), nonce: consumedNonce !== undefined, attachNonce: consumedAttachNonce !== undefined });
  }
}
