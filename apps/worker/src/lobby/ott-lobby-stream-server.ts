import { YServer } from "y-partyserver";
import type { Connection } from "../../../../node_modules/playhtml/node_modules/partyserver/dist/index.js";
import { internalRequest } from "../auth/internal-auth.js";

export class OttLobbyStreamServer extends YServer {
  static options = { hibernate: true };
  protected readonly ottEnv: Env;
  private cachedCatalogRevision = 0;
  private cachedMatches: unknown[] = [];

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.ottEnv = env;
  }

  override isReadOnly(_connection: Connection): boolean {
    return true;
  }

  override onConnect(connection: Connection, ctx: unknown): void {
    if (this.ottEnv.OTT_SPECTATOR_ENABLED !== "true") {
      try {
        connection.close?.(1008, "spectator_disabled");
      } catch {
        // fail closed
      }
      return;
    }
    super.onConnect(connection, ctx as any);
  }

  override onCustomMessage(connection: Connection, message: string): void {
    void this.dispatchCustomMessage(connection, message).catch(() => undefined);
  }

  private async dispatchCustomMessage(connection: Connection, message: string): Promise<void> {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (!parsed || parsed.__ott !== true || parsed.type !== "ott:lobby-subscribe") {
      return;
    }

    if (this.ottEnv.OTT_SPECTATOR_ENABLED !== "true") {
      this.sendCustomMessage(connection, JSON.stringify({
        __ott: true,
        type: "ott:error",
        error: "spectator_disabled",
      }));
      try {
        connection.close?.(1008, "spectator_disabled");
      } catch {
        // fail closed
      }
      return;
    }

    try {
      const lobby = this.ottEnv.OTT_LOBBY.get(this.ottEnv.OTT_LOBBY.idFromName("lobby"));
      const response = await lobby.fetch(internalRequest(this.ottEnv.OTT_INTERNAL_SECRET, "/internal/public-active-snapshot", {}));
      if (response.ok) {
        const data = await response.json() as { catalogRevision: number; matches: unknown[] };
        if (data && typeof data.catalogRevision === "number" && Array.isArray(data.matches)) {
          if (data.catalogRevision > this.cachedCatalogRevision) {
            this.cachedCatalogRevision = data.catalogRevision;
            this.cachedMatches = data.matches;
          }
          this.sendCustomMessage(connection, JSON.stringify({
            __ott: true,
            type: "ott:active-matches",
            catalogRevision: this.cachedCatalogRevision,
            matches: this.cachedMatches,
          }));
          return;
        }
      }
    } catch {
      // Failed to resync from lobby
    }

    this.sendCustomMessage(connection, JSON.stringify({
      __ott: true,
      type: "ott:error",
      error: "active_matches_unavailable",
    }));
  }

  override async fetch(request: Request): Promise<Response> {
    if (this.ottEnv.OTT_SPECTATOR_ENABLED !== "true") {
      return new Response("Not found", { status: 404 });
    }
    const pathname = new URL(request.url).pathname;
    if (pathname === "/internal/active-update" && request.method === "POST") {
      if (!this.ottEnv.OTT_INTERNAL_SECRET || request.headers.get("x-ott-internal-secret") !== this.ottEnv.OTT_INTERNAL_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      let body: { catalogRevision?: number; matches?: unknown[] };
      try {
        body = await request.json();
      } catch {
        return new Response("Bad request", { status: 400 });
      }
      if (typeof body.catalogRevision !== "number" || !Array.isArray(body.matches)) {
        return new Response("Bad request", { status: 400 });
      }

      if (body.catalogRevision > this.cachedCatalogRevision) {
        this.cachedCatalogRevision = body.catalogRevision;
        this.cachedMatches = body.matches;
        const payload = JSON.stringify({
          __ott: true,
          type: "ott:active-matches",
          catalogRevision: this.cachedCatalogRevision,
          matches: this.cachedMatches,
        });
        for (const conn of this.getConnections()) {
          try {
            this.sendCustomMessage(conn, payload);
          } catch {
            // ignore connection delivery errors
          }
        }
      }
      return Response.json({ ok: true });
    }
    return super.fetch(request);
  }
}
