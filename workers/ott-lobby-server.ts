import { DurableObject } from "cloudflare:workers";
import {
  createCapabilityNonce,
  createOwnerCredential,
  deleteOwnerCredentials,
  internalRequest,
  issueCapability,
  retryRecoverableInitialization,
  rotateOwnerCredential,
  withJoinReservationRollback,
  withInitializationRollback,
  retrySeatUpdateRequest,
} from "./internal-auth.js";

type Allocation = {
  id: string;
  roomId: string;
  names: Partial<Record<"A" | "B", string>>;
  seats: number;
  status: "initializing" | "waiting" | "joining" | "playing" | "terminal";
  creatorAttachDeadlineMs: number;
};
const MAX_BODY = 4096;
const DEFAULT_CREATOR_ATTACH_TTL_MS = 60_000;

function configuredDuration(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function json(value: unknown, status = 200): Response { return Response.json(value, { status }); }
function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/<[^>]*>/g, "").trim().slice(0, 32);
  return name || null;
}
function publicAllocation(item: Allocation): unknown {
  return { id: item.id, roomId: item.roomId, players: item.seats, names: item.names };
}

export class OttLobbyServer extends DurableObject<Env> {
  private transaction<T>(callback: (storage: DurableObjectTransaction) => Promise<T>): Promise<T> {
    return this.ctx.storage.transaction(callback);
  }
  private async allocations(): Promise<Allocation[]> {
    const values = await this.ctx.storage.list<Allocation>({ prefix: "allocation:" });
    return [...values.values()];
  }

  private async rollbackJoinReservation(id: string): Promise<void> {
    await this.transaction(async (storage) => {
      const current = await storage.get<Allocation>(`allocation:${id}`);
      if (current?.status !== "joining" || current.seats !== 1) return;
      current.status = "waiting";
      await storage.put(`allocation:${id}`, current);
      await storage.delete(`owner-credential:${id}:B`);
      await storage.delete(`owner-ticket:${id}:B`);
    });
  }

  private async read(request: Request): Promise<Record<string, unknown> | null> {
    if (request.method !== "POST" || Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return null;
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY) return null;
    try { const value = JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value) ? value : null; } catch { return null; }
  }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/internal/terminalize" && request.method === "POST") {
      return this.terminalize(request);
    }
    const action = new URL(request.url).pathname.split("/").filter(Boolean).at(-1);
    const body = await this.read(request);
    if (!body || !["create", "list", "join", "resume"].includes(action ?? "")) return json({ error: "invalid_request" }, 400);
    const now = Date.now();
    const last = await this.ctx.storage.get<number>("rate:last");
    if (last !== undefined && now - last < 40) return json({ error: "rate_limited" }, 429);
    await this.ctx.storage.put("rate:last", now);
    const list = await this.allocations();
    if (action === "list") return json({ rooms: list.filter((item) => item.status === "waiting").map(publicAllocation) });

    const name = cleanName(body.name);
    if (action === "create") {
      if (!name) return json({ error: "invalid_name" }, 400);
      const id = crypto.randomUUID();
      const allocation: Allocation = {
        id,
        roomId: `ott-${id}`,
        names: { A: name },
        seats: 1,
        status: "initializing",
        creatorAttachDeadlineMs: now + configuredDuration(this.env.OTT_TEST_CREATOR_ATTACH_TTL_MS, DEFAULT_CREATOR_ATTACH_TTL_MS),
      };
      const owner = await createOwnerCredential();
      const ticketNonce = createCapabilityNonce();
      const ticket = await issueCapability(this.env.OTT_INTERNAL_SECRET, {
        allocationId: id, roomId: allocation.roomId, purpose: "attach", seat: "A", now, nonce: ticketNonce,
      });
      await this.transaction(async (storage) => {
        await storage.put(`allocation:${id}`, allocation);
        await storage.put(`owner-credential:${id}:A`, { salt: owner.salt, hash: owner.hash });
        await storage.put(`owner-ticket:${id}:A`, { nonce: ticketNonce, expiresAt: now + 60_000 });
      });
      const initialized = await withInitializationRollback(async () => {
        const game = this.env.Main.get(this.env.Main.idFromName(allocation.roomId));
        const transientFetchFailure = new Error("Transient Game initialization fetch failure");
        const response = await retryRecoverableInitialization(async () => {
          const init = await issueCapability(this.env.OTT_INTERNAL_SECRET, { allocationId: id, roomId: allocation.roomId, purpose: "game-init", seat: "A" });
          try {
            return await game.fetch(internalRequest(this.env.OTT_INTERNAL_SECRET, "/internal/initialize", {
              allocationId: id,
              roomId: allocation.roomId,
              creatorName: name,
              creatorAttachDeadlineMs: allocation.creatorAttachDeadlineMs,
              capability: init,
            }));
          } catch {
            throw transientFetchFailure;
          }
        }, (result) => result.status >= 500, (error) => error === transientFetchFailure);
        if (!response.ok) {
          console.warn(`OTT game initialization failed with HTTP ${response.status}`);
          throw new Error("Game initialization rejected");
        }
        await this.transaction(async (storage) => {
          const pending = await storage.get<Allocation>(`allocation:${id}`);
          if (pending?.status === "initializing") {
            pending.status = "waiting";
            await storage.put(`allocation:${id}`, pending);
          }
        });
        return json({ allocationId: id, room: allocation.roomId, seat: "A", ticket, resumeCredential: owner.credential });
      }, async () => {
        await this.transaction(async (storage) => {
          await storage.delete(`allocation:${id}`);
          await deleteOwnerCredentials(storage, id);
        });
      });
      if (!initialized.ok) return json({ error: "authority_unavailable" }, 503);
      return initialized.value;
    }

    const id = typeof body.allocationId === "string" ? body.allocationId : "";
    if (action === "resume") {
      if (!id || typeof body.resumeCredential !== "string") return json({ error: "resume_rejected" }, 401);
      const resumed = await this.transaction(async (storage) => {
        const allocation = await storage.get<Allocation>(`allocation:${id}`);
        if (!allocation || (allocation.status !== "waiting" && allocation.status !== "playing")) return null;
        for (const seat of ["A", "B"] as const) {
          const rotated = await rotateOwnerCredential(storage, this.env.OTT_INTERNAL_SECRET, {
            allocationId: allocation.id,
            roomId: allocation.roomId,
            seat,
            resumeCredential: body.resumeCredential as string,
          });
          if (rotated) return { allocation, ...rotated };
        }
        return null;
      });
      if (!resumed) return json({ error: "resume_rejected" }, 401);
      return json({
        allocationId: resumed.allocation.id,
        room: resumed.allocation.roomId,
        seat: resumed.seat,
        ticket: resumed.ticket,
        resumeCredential: resumed.resumeCredential,
      });
    }
    const allocation = await this.ctx.storage.get<Allocation>(`allocation:${id}`);
    if (!allocation) return json({ error: "not_found" }, 404);
    if (action === "join") {
      if (allocation.status !== "waiting" || allocation.seats !== 1 || !name) return json({ error: "not_available" }, 409);
      const reserved = await this.transaction(async (storage) => {
        const current = await storage.get<Allocation>(`allocation:${id}`);
        if (!current || current.status !== "waiting" || current.seats !== 1) return null;
        const owner = await createOwnerCredential();
        const ticketNonce = createCapabilityNonce();
        const issuedAt = Date.now();
        const ticket = await issueCapability(this.env.OTT_INTERNAL_SECRET, {
          allocationId: id, roomId: current.roomId, purpose: "attach", seat: "B", now: issuedAt, nonce: ticketNonce,
        });
        const seatUpdate = await issueCapability(this.env.OTT_INTERNAL_SECRET, {
          allocationId: id, roomId: current.roomId, purpose: "seat-update", seat: "B", now: issuedAt,
        });
        current.status = "joining";
        await storage.put(`allocation:${id}`, current);
        await storage.put(`owner-credential:${id}:B`, { salt: owner.salt, hash: owner.hash });
        await storage.put(`owner-ticket:${id}:B`, { nonce: ticketNonce, expiresAt: issuedAt + 60_000 });
        return { allocation: current, owner, ticket, seatUpdate };
      });
      if (!reserved) return json({ error: "not_available" }, 409);
      const game = this.env.Main.get(this.env.Main.idFromName(reserved.allocation.roomId));
      let response: Response | null = null;
      try {
        response = await retrySeatUpdateRequest(async (attempt) => {
          const capability = attempt === 0 ? reserved.seatUpdate : await issueCapability(this.env.OTT_INTERNAL_SECRET, {
            allocationId: id,
            roomId: reserved.allocation.roomId,
            purpose: "seat-update",
            seat: "B",
          });
          return game.fetch(internalRequest(this.env.OTT_INTERNAL_SECRET, "/internal/seat-update", {
            allocationId: id,
            roomId: reserved.allocation.roomId,
            name,
            capability,
          }));
        }, (result) => result.status >= 500);
      } catch {
        response = null;
      }
      if (!response?.ok) {
        await this.rollbackJoinReservation(id);
        return json({ error: "authority_unavailable" }, 503);
      }
      const finalized = await withJoinReservationRollback(async () => this.transaction(async (storage) => {
        const current = await storage.get<Allocation>(`allocation:${id}`);
        if (!current || current.status !== "joining" || current.seats !== 1) throw new Error("Join reservation changed before finalization");
        current.names.B = name;
        current.seats = 2;
        current.status = "playing";
        await storage.put(`allocation:${id}`, current);
        return current;
      }), () => this.rollbackJoinReservation(id));
      if (!finalized.ok) return json({ error: "authority_unavailable" }, 503);
      const joined = finalized.value;
      return json({ allocationId: id, room: joined.roomId, seat: "B", ticket: reserved.ticket, resumeCredential: reserved.owner.credential });
    }
    return json({ error: "invalid_request" }, 400);
  }

  private async terminalize(request: Request): Promise<Response> {
    if (!this.env.OTT_INTERNAL_SECRET || request.headers.get("x-ott-internal-secret") !== this.env.OTT_INTERNAL_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
    let body: { allocationId?: string; roomId?: string; reason?: string };
    try { body = await request.json(); } catch { return new Response("Bad request", { status: 400 }); }
    if (typeof body.allocationId !== "string" || typeof body.roomId !== "string" ||
        !["creator_attach_timeout", "disconnect_timeout", "timeout", "leave", "goal", "elimination", "no_moves"].includes(body.reason ?? "")) {
      return new Response("Bad request", { status: 400 });
    }
    const result = await this.transaction(async (storage) => {
      const key = `allocation:${body.allocationId}`;
      const allocation = await storage.get<Allocation>(key);
      if (!allocation || allocation.roomId !== body.roomId) return "not_found";
      if (allocation.status === "terminal") return "already_terminal";
      allocation.status = "terminal";
      await storage.put(key, allocation);
      await deleteOwnerCredentials(storage, body.allocationId!);
      return "terminalized";
    });
    if (result === "not_found") return new Response("Not found", { status: 404 });
    return Response.json({ ok: true, result });
  }
}
