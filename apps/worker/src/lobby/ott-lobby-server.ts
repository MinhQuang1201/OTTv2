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
} from "../auth/internal-auth.js";
import {
  normalizePublicMatchSummary,
} from "./public-match.js";
import {
  validatePublicMatchCatalog,
  MAX_OTT_PAYLOAD_BYTES,
  type PublicMatchView,
} from "../../../../packages/protocol/src/index.js";

type Allocation = {
  id: string;
  roomId: string;
  names: Partial<Record<"A" | "B", string>>;
  seats: number;
  status: "initializing" | "waiting" | "joining" | "playing" | "terminal";
  creatorAttachDeadlineMs: number;
  summary?: unknown;
  summaryVersion?: { roomRevision: number; summarySequence: number };
};
const MAX_BODY = 4096;
const DEFAULT_CREATOR_ATTACH_TTL_MS = 60_000;
const RATE_LIMIT_RETENTION_MS = 60_000;
const PUBLIC_CATALOG_NOTIFY_KEY = "public-catalog-notify";
const PUBLIC_CATALOG_NOTIFY_CLAIM_PREFIX = "public-catalog-notify-claim:";
const PUBLIC_CATALOG_EXHAUSTED_KEY = "public-catalog-notify-exhausted";
const PUBLIC_CATALOG_LEGACY_EXHAUSTED_PREFIX = "public-catalog-notify-exhausted:";
const PUBLIC_CATALOG_DELIVERED_KEY = "public-catalog-delivered-revision";
const PUBLIC_CATALOG_MAX_ATTEMPTS = 4;
const PUBLIC_CATALOG_RETRY_BASE_MS = 1_000;
const PUBLIC_CATALOG_RETRY_MAX_MS = 30_000;
const PUBLIC_CATALOG_CLAIM_LEASE_MS = 60_000;

type CatalogNotification = {
  catalogRevision: number;
  attempt: number;
  nextAttemptMs: number;
  terminalRemovalPending: boolean;
};

type CatalogNotificationClaim = CatalogNotification & {
  claimToken: string;
  leaseUntilMs: number;
};

function catalogClaimKey(catalogRevision: number): string {
  return `${PUBLIC_CATALOG_NOTIFY_CLAIM_PREFIX}${catalogRevision}`;
}

function catalogNotificationRecord(claim: CatalogNotificationClaim): CatalogNotification {
  const { claimToken: _claimToken, leaseUntilMs: _leaseUntilMs, ...record } = claim;
  return record;
}

async function readCappedUtf8Body(request: Request, maxBytes: number): Promise<string | null> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) return null;
  }
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch {
    return null;
  }
}

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
function clientIdentity(request: Request): string {
  const cfConnectingIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cfConnectingIp) return cfConnectingIp.replace(/[^a-zA-Z0-9.:_-]/g, "_");
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first.replace(/[^a-zA-Z0-9.:_-]/g, "_");
  }
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp.replace(/[^a-zA-Z0-9.:_-]/g, "_");
  return "anonymous";
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

  private alarmScheduleTail?: Promise<void>;

  private async scheduleAlarm(): Promise<void> {
    const previous = this.alarmScheduleTail ?? Promise.resolve();
    let release!: () => void;
    this.alarmScheduleTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const now = Date.now();
      let nextDeadline: number | undefined;
      const legacyExhausted = await this.ctx.storage.list({ prefix: PUBLIC_CATALOG_LEGACY_EXHAUSTED_PREFIX });
      for (const key of legacyExhausted.keys()) await this.ctx.storage.delete(key);
      const rateEntries = await this.ctx.storage.list<number>({ prefix: "rate:last:" });
      for (const value of rateEntries.values()) {
        const deadline = typeof value === "number" && Number.isFinite(value)
          ? value + RATE_LIMIT_RETENTION_MS
          : now;
        nextDeadline = nextDeadline === undefined ? deadline : Math.min(nextDeadline, deadline);
      }
      const notification = this.env.OTT_SPECTATOR_ENABLED === "true"
        ? await this.ctx.storage.get<CatalogNotification>(PUBLIC_CATALOG_NOTIFY_KEY)
        : undefined;
      const claims = this.env.OTT_SPECTATOR_ENABLED === "true"
        ? await this.ctx.storage.list<CatalogNotificationClaim>({ prefix: PUBLIC_CATALOG_NOTIFY_CLAIM_PREFIX })
        : undefined;
      if (notification && notification.attempt < PUBLIC_CATALOG_MAX_ATTEMPTS && Number.isFinite(notification.nextAttemptMs)) {
        nextDeadline = nextDeadline === undefined
          ? notification.nextAttemptMs
          : Math.min(nextDeadline, notification.nextAttemptMs);
      }
      for (const claim of claims?.values() ?? []) {
        if (Number.isFinite(claim.leaseUntilMs)) {
          nextDeadline = nextDeadline === undefined
            ? claim.leaseUntilMs
            : Math.min(nextDeadline, claim.leaseUntilMs);
        }
      }
      if (nextDeadline === undefined) await this.ctx.storage.deleteAlarm?.();
      else await this.ctx.storage.setAlarm?.(nextDeadline);
    } catch {
      // Alarm scheduling must not turn a valid control request into an error.
    } finally {
      release();
    }
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const entries = await this.ctx.storage.list<number>({ prefix: "rate:last:" });
    for (const [key, value] of entries) {
      if (typeof value !== "number" || now - value >= RATE_LIMIT_RETENTION_MS) {
        await this.ctx.storage.delete(key);
      }
    }
    if (this.env.OTT_SPECTATOR_ENABLED !== "true") {
      await this.ctx.storage.delete(PUBLIC_CATALOG_NOTIFY_KEY);
      const claims = await this.ctx.storage.list({ prefix: PUBLIC_CATALOG_NOTIFY_CLAIM_PREFIX });
      for (const key of claims.keys()) await this.ctx.storage.delete(key);
      await this.ctx.storage.delete(PUBLIC_CATALOG_EXHAUSTED_KEY);
    }
    await this.deliverCatalogNotification(now);
    await this.scheduleAlarm();
  }

  private async enqueueCatalogNotification(
    storage: DurableObjectStorage | DurableObjectTransaction,
    catalogRevision: number,
    terminalRemovalPending: boolean,
    now = Date.now(),
  ): Promise<void> {
    const existing = await storage.get<CatalogNotification>(PUBLIC_CATALOG_NOTIFY_KEY);
    const claimed = await storage.get<CatalogNotificationClaim>(catalogClaimKey(catalogRevision));
    if (existing && existing.catalogRevision > catalogRevision) return;
    if (claimed && claimed.catalogRevision >= catalogRevision) return;
    const exhausted = await storage.get<CatalogNotification>(PUBLIC_CATALOG_EXHAUSTED_KEY);
    if (exhausted && exhausted.catalogRevision <= catalogRevision) await storage.delete(PUBLIC_CATALOG_EXHAUSTED_KEY);
    await storage.put(PUBLIC_CATALOG_NOTIFY_KEY, {
      catalogRevision,
      attempt: 0,
      nextAttemptMs: now,
      terminalRemovalPending: Boolean(existing?.terminalRemovalPending || terminalRemovalPending),
    } satisfies CatalogNotification);
  }

  private async currentPublicCatalog(): Promise<{ catalogRevision: number; matches: PublicMatchView[] } | null> {
    const materialized = await this.transaction(async (storage) => {
      const catalogRevision = (await storage.get<number>("public-catalog-revision")) ?? 0;
      const values = await storage.list<Allocation>({ prefix: "allocation:" });
      return { catalogRevision, list: [...values.values()] };
    });
    const { catalogRevision, list } = materialized;
    const matches: PublicMatchView[] = [];
    for (const item of list) {
      if (item.status !== "playing" || item.summary === undefined) continue;
      const normalized = normalizePublicMatchSummary(item.summary);
      if (!normalized.ok) return null;
      matches.push(normalized.value);
    }
    const catalog = validatePublicMatchCatalog({
      __ott: true,
      type: "ott:active-matches",
      catalogRevision,
      matches,
    });
    return catalog.ok ? { catalogRevision, matches: [...catalog.value.matches] } : null;
  }

  private async claimCatalogNotification(now: number): Promise<CatalogNotificationClaim | null> {
    return this.transaction(async (storage) => {
      const notification = await storage.get<CatalogNotification>(PUBLIC_CATALOG_NOTIFY_KEY);
      const claims = await storage.list<CatalogNotificationClaim>({ prefix: PUBLIC_CATALOG_NOTIFY_CLAIM_PREFIX });
      for (const claim of claims.values()) {
        if (notification && notification.catalogRevision > claim.catalogRevision) {
          if (claim.leaseUntilMs <= now) await storage.delete(catalogClaimKey(claim.catalogRevision));
          continue;
        }
        if (claim.leaseUntilMs > now) return null;
        await storage.delete(PUBLIC_CATALOG_NOTIFY_KEY);
        const nextAttempt = claim.attempt + 1;
        if (nextAttempt >= PUBLIC_CATALOG_MAX_ATTEMPTS) {
          await storage.put(PUBLIC_CATALOG_EXHAUSTED_KEY, {
            ...catalogNotificationRecord(claim),
            attempt: nextAttempt,
            nextAttemptMs: now,
          } satisfies CatalogNotification);
          await storage.delete(catalogClaimKey(claim.catalogRevision));
          return null;
        }
        const recovered: CatalogNotificationClaim = {
          ...claim,
          attempt: nextAttempt,
          claimToken: crypto.randomUUID(),
          nextAttemptMs: now,
          leaseUntilMs: now + PUBLIC_CATALOG_CLAIM_LEASE_MS,
        };
        await storage.put(catalogClaimKey(claim.catalogRevision), recovered);
        return recovered;
      }
      const record = await storage.get<CatalogNotification>(PUBLIC_CATALOG_NOTIFY_KEY);
      if (!record || record.nextAttemptMs > now || record.attempt >= PUBLIC_CATALOG_MAX_ATTEMPTS) return null;
      const claim: CatalogNotificationClaim = {
        ...record,
        claimToken: crypto.randomUUID(),
        leaseUntilMs: now + PUBLIC_CATALOG_CLAIM_LEASE_MS,
      };
      await storage.put(catalogClaimKey(record.catalogRevision), claim);
      await storage.delete(PUBLIC_CATALOG_NOTIFY_KEY);
      return claim;
    });
  }

  private async restoreCatalogNotification(record: CatalogNotificationClaim, now: number): Promise<void> {
    const nextAttempt = record.attempt + 1;
    let exhausted = false;
    await this.transaction(async (storage) => {
      const claim = await storage.get<CatalogNotificationClaim>(catalogClaimKey(record.catalogRevision));
      if (!claim || claim.catalogRevision !== record.catalogRevision || claim.attempt !== record.attempt ||
          claim.nextAttemptMs !== record.nextAttemptMs || claim.terminalRemovalPending !== record.terminalRemovalPending ||
          claim.claimToken !== record.claimToken) return;
      const deliveredRevision = await storage.get<number>(PUBLIC_CATALOG_DELIVERED_KEY);
      if (deliveredRevision !== undefined && deliveredRevision >= record.catalogRevision) {
        await storage.delete(catalogClaimKey(record.catalogRevision));
        return;
      }
      const current = await storage.get<CatalogNotification>(PUBLIC_CATALOG_NOTIFY_KEY);
      if (current && (
        current.catalogRevision !== record.catalogRevision ||
        current.attempt !== record.attempt ||
        current.nextAttemptMs !== record.nextAttemptMs ||
        current.terminalRemovalPending !== record.terminalRemovalPending
      )) {
        await storage.delete(catalogClaimKey(record.catalogRevision));
        return;
      }
      if (nextAttempt >= PUBLIC_CATALOG_MAX_ATTEMPTS) {
        await storage.put(PUBLIC_CATALOG_EXHAUSTED_KEY, {
          ...catalogNotificationRecord(record),
          attempt: nextAttempt,
          nextAttemptMs: now,
        } satisfies CatalogNotification);
        await storage.delete(catalogClaimKey(record.catalogRevision));
        exhausted = true;
        return;
      }
      await storage.put(PUBLIC_CATALOG_NOTIFY_KEY, {
        ...catalogNotificationRecord(record),
        attempt: nextAttempt,
        nextAttemptMs: now + Math.min(PUBLIC_CATALOG_RETRY_MAX_MS, PUBLIC_CATALOG_RETRY_BASE_MS * (2 ** record.attempt)),
      } satisfies CatalogNotification);
      await storage.delete(catalogClaimKey(record.catalogRevision));
    });
    if (exhausted) {
      console.warn(`OTT public catalog notification exhausted at revision ${record.catalogRevision}`);
    }
  }

  private async completeCatalogNotification(record: CatalogNotificationClaim, deliveredRevision: number): Promise<void> {
    await this.transaction(async (storage) => {
      const claim = await storage.get<CatalogNotificationClaim>(catalogClaimKey(record.catalogRevision));
      if (!claim || claim.catalogRevision !== record.catalogRevision || claim.attempt !== record.attempt ||
          claim.nextAttemptMs !== record.nextAttemptMs || claim.terminalRemovalPending !== record.terminalRemovalPending ||
          claim.claimToken !== record.claimToken) return;
      await storage.delete(catalogClaimKey(record.catalogRevision));
      const previousDelivered = await storage.get<number>(PUBLIC_CATALOG_DELIVERED_KEY);
      if (previousDelivered === undefined || deliveredRevision > previousDelivered) {
        await storage.put(PUBLIC_CATALOG_DELIVERED_KEY, deliveredRevision);
      }
      const current = await storage.get<CatalogNotification>(PUBLIC_CATALOG_NOTIFY_KEY);
      if (!current || current.catalogRevision <= record.catalogRevision) {
        if (current) await storage.delete(PUBLIC_CATALOG_NOTIFY_KEY);
      }
      const exhausted = await storage.get<CatalogNotification>(PUBLIC_CATALOG_EXHAUSTED_KEY);
      if (exhausted && exhausted.catalogRevision <= deliveredRevision) {
        await storage.delete(PUBLIC_CATALOG_EXHAUSTED_KEY);
      }
    });
  }

  private async deliverCatalogNotification(now = Date.now()): Promise<void> {
    if (this.env.OTT_SPECTATOR_ENABLED !== "true") return;
    const claimed = await this.claimCatalogNotification(now);
    if (!claimed) return;
    const restore = async (): Promise<void> => {
      try {
        await this.restoreCatalogNotification(claimed, now);
      } catch {
        // The durable claim remains leased and can be recovered by a later alarm.
      }
    };
    let catalog: { catalogRevision: number; matches: PublicMatchView[] } | null;
    try {
      catalog = await this.currentPublicCatalog();
    } catch {
      await restore();
      return;
    }
    if (!catalog) {
      await restore();
      return;
    }
    if (catalog.catalogRevision < claimed.catalogRevision) {
      await restore();
      return;
    }
    try {
      const stream = this.env.Lobby?.get(this.env.Lobby.idFromName("ott-lobby-public"));
      if (!stream || !this.env.OTT_INTERNAL_SECRET) {
        await restore();
        return;
      }
      const response = await stream.fetch(internalRequest(this.env.OTT_INTERNAL_SECRET, "/internal/active-update", {
        catalogRevision: catalog.catalogRevision,
        matches: catalog.matches,
      }));
      if (!response.ok) throw new Error(`Lobby stream update failed with HTTP ${response.status}`);
      await this.completeCatalogNotification(claimed, catalog.catalogRevision);
    } catch {
      await restore();
    }
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
    if (request.method !== "POST") return null;
    const text = await readCappedUtf8Body(request, MAX_BODY);
    if (text === null) return null;
    try { const value = JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value) ? value : null; } catch { return null; }
  }

  override async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/internal/terminalize" && request.method === "POST") {
      return this.terminalize(request);
    }
    if (pathname === "/internal/active-update" && request.method === "POST") {
      return this.handleActiveUpdate(request);
    }
    if (pathname === "/internal/public-active-snapshot") {
      return this.handlePublicActiveSnapshot(request);
    }
    const action = pathname.split("/").filter(Boolean).at(-1);
    const body = await this.read(request);
    if (!body || !["create", "list", "join", "resume", "active", "spectate"].includes(action ?? "")) return json({ error: "invalid_request" }, 400);
    const now = Date.now();
    const clientKey = clientIdentity(request);
    const rateKey = `rate:last:${action}:${clientKey}`;
    const last = await this.ctx.storage.get<number>(rateKey);
    if (last !== undefined && now - last < 40) return json({ error: "rate_limited" }, 429);
    await this.ctx.storage.put(rateKey, now);
    await this.scheduleAlarm();
    const list = await this.allocations();
    if (action === "list") return json({ rooms: list.filter((item) => item.status === "waiting").map(publicAllocation) });
    if (action === "active") {
      if (this.env.OTT_SPECTATOR_ENABLED !== "true") return json({ error: "not_found" }, 404);
      const catalog = await this.currentPublicCatalog();
      if (!catalog) return json({ error: "catalog_unavailable" }, 503);
      return json({ matches: catalog.matches });
    }

    if (!this.env.OTT_INTERNAL_SECRET) {
      console.warn("OTT lobby control request rejected: missing secret binding");
      return json({ error: "authority_unavailable" }, 503);
    }

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
    if (action === "spectate") {
      if (this.env.OTT_SPECTATOR_ENABLED !== "true") return json({ error: "not_found" }, 404);
      if (!id) return json({ error: "invalid_request" }, 400);
      const allocation = await this.ctx.storage.get<Allocation>(`allocation:${id}`);
      if (!allocation || allocation.status !== "playing") return json({ error: "not_available" }, 409);
      const ticketNonce = createCapabilityNonce();
      const ticket = await issueCapability(this.env.OTT_INTERNAL_SECRET, {
        allocationId: id,
        roomId: allocation.roomId,
        purpose: "spectate",
        role: "spectator",
        now,
        nonce: ticketNonce,
      });
      return json({ allocationId: id, room: allocation.roomId, ticket });
    }
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

  private async handleActiveUpdate(request: Request): Promise<Response> {
    if (!this.env.OTT_INTERNAL_SECRET || request.headers.get("x-ott-internal-secret") !== this.env.OTT_INTERNAL_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
    const text = await readCappedUtf8Body(request, MAX_OTT_PAYLOAD_BYTES);
    if (text === null) return new Response("Bad request", { status: 400 });
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Response("Bad request", { status: 400 });
      body = parsed as Record<string, unknown>;
    } catch { return new Response("Bad request", { status: 400 }); }
    const version = body.version;
    const summary = normalizePublicMatchSummary(body.summary);
    if (Object.keys(body).sort().join(",") !== "allocationId,roomId,summary,version" ||
        typeof body.allocationId !== "string" || typeof body.roomId !== "string" ||
        !version || typeof version !== "object" || Array.isArray(version) ||
        Object.keys(version).sort().join(",") !== "roomRevision,summarySequence" ||
        !Number.isSafeInteger((version as Record<string, unknown>).roomRevision) ||
        !Number.isSafeInteger((version as Record<string, unknown>).summarySequence) ||
        (version as Record<string, unknown>).roomRevision < 0 ||
        (version as Record<string, unknown>).summarySequence < 0 || !summary.ok ||
        summary.value.allocationId !== body.allocationId || summary.value.roomId !== body.roomId) {
      return new Response("Bad request", { status: 400 });
    }

    const result = await this.transaction(async (storage) => {
      const key = `allocation:${body.allocationId as string}`;
      const allocation = await storage.get<Allocation>(key);
      if (!allocation || allocation.roomId !== body.roomId || allocation.status !== "playing") return "not_available" as const;
      const existing = allocation.summaryVersion;
      if (existing) {
        const isNewer =
          (version as { roomRevision: number; summarySequence: number }).roomRevision > existing.roomRevision ||
          ((version as { roomRevision: number; summarySequence: number }).roomRevision === existing.roomRevision &&
            (version as { roomRevision: number; summarySequence: number }).summarySequence > existing.summarySequence);
        if (!isNewer) return "stale" as const;
      }
      allocation.summary = summary.value;
      allocation.summaryVersion = version as { roomRevision: number; summarySequence: number };
      await storage.put(key, allocation);

      const catalogRevision = ((await storage.get<number>("public-catalog-revision")) ?? 0) + 1;
      await storage.put("public-catalog-revision", catalogRevision);
      if (this.env.OTT_SPECTATOR_ENABLED === "true") {
        await this.enqueueCatalogNotification(storage, catalogRevision, false);
      }
      return catalogRevision;
    });

    if (result === "not_available") return new Response("Not found", { status: 404 });
    if (result === "stale") return new Response("Stale update", { status: 409 });
    await this.scheduleAlarm();
    await this.deliverCatalogNotification();
    await this.scheduleAlarm();
    return Response.json({ ok: true });
  }

  private async handlePublicActiveSnapshot(request: Request): Promise<Response> {
    if (!this.env.OTT_INTERNAL_SECRET || request.headers.get("x-ott-internal-secret") !== this.env.OTT_INTERNAL_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
    if (await readCappedUtf8Body(request, MAX_OTT_PAYLOAD_BYTES) === null) return new Response("Bad request", { status: 400 });
    const catalog = await this.currentPublicCatalog();
    if (!catalog) return new Response("Catalog unavailable", { status: 503 });
    return Response.json(catalog);
  }

  private async terminalize(request: Request): Promise<Response> {
    if (!this.env.OTT_INTERNAL_SECRET || request.headers.get("x-ott-internal-secret") !== this.env.OTT_INTERNAL_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
    const text = await readCappedUtf8Body(request, MAX_OTT_PAYLOAD_BYTES);
    if (text === null) return new Response("Bad request", { status: 400 });
    let body: { allocationId?: string; roomId?: string; reason?: string };
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Response("Bad request", { status: 400 });
      body = parsed as { allocationId?: string; roomId?: string; reason?: string };
    } catch { return new Response("Bad request", { status: 400 }); }
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
      delete allocation.summary;
      delete allocation.summaryVersion;
      await storage.put(key, allocation);
      await deleteOwnerCredentials(storage, body.allocationId!);
      const catalogRevision = ((await storage.get<number>("public-catalog-revision")) ?? 0) + 1;
      await storage.put("public-catalog-revision", catalogRevision);
      if (this.env.OTT_SPECTATOR_ENABLED === "true") {
        await this.enqueueCatalogNotification(storage, catalogRevision, true);
      }
      return { status: "terminalized", catalogRevision };
    });
    if (result === "not_found") return new Response("Not found", { status: 404 });
    if (typeof result === "object" && result.status === "terminalized") {
      await this.scheduleAlarm();
      await this.deliverCatalogNotification();
      await this.scheduleAlarm();
      return Response.json({ ok: true, result: result.status });
    }
    return Response.json({ ok: true, result });
  }
}
