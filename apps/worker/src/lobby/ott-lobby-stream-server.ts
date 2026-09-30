import { YServer } from "y-partyserver";
import type { Connection } from "partyserver";
import { internalRequest } from "../auth/internal-auth.js";
import { MAX_OTT_PAYLOAD_BYTES, validatePublicMatchCatalog, type PublicMatchView } from "../../../../packages/protocol/src/index.js";

const STREAM_RESEND_KEY = "lobby-stream-resend";
const STREAM_RESEND_CLAIM_PREFIX = "lobby-stream-resend-claim:";
const STREAM_RESEND_EXHAUSTED_KEY = "lobby-stream-resend-exhausted";
const STREAM_RESEND_MAX_ATTEMPTS = 4;
const STREAM_RESEND_BASE_MS = 1_000;
const STREAM_RESEND_MAX_MS = 30_000;
const STREAM_RESEND_CLAIM_LEASE_MS = 60_000;

type StreamResend = {
  catalogRevision: number;
  attempt: number;
  nextAttemptMs: number;
};

type StreamResendClaim = StreamResend & {
  claimToken: string;
  leaseUntilMs: number;
};

function streamResendClaimKey(catalogRevision: number): string {
  return `${STREAM_RESEND_CLAIM_PREFIX}${catalogRevision}`;
}

function streamResendRecord(claim: StreamResendClaim): StreamResend {
  const { claimToken: _claimToken, leaseUntilMs: _leaseUntilMs, ...record } = claim;
  return record;
}

type CachedCatalog = {
  catalogRevision: number;
  matches: PublicMatchView[];
};

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

export class OttLobbyStreamServer extends YServer {
  static options = { hibernate: true };
  protected readonly ottEnv: Env;
  private cachedCatalogRevision = 0;
  private cachedMatches: PublicMatchView[] = [];
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
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
    this.state.waitUntil(this.dispatchCustomMessage(connection, message).catch(() => undefined));
  }

  private catalogMessage(catalog: CachedCatalog): string {
    return JSON.stringify({
      __ott: true,
      type: "ott:active-matches",
      catalogRevision: catalog.catalogRevision,
      matches: catalog.matches,
    });
  }

  private async persistCatalog(catalog: CachedCatalog): Promise<void> {
    await this.state.storage.put("public-catalog-cache", catalog);
  }

  private async scheduleResendAlarm(): Promise<void> {
    if (this.ottEnv.OTT_SPECTATOR_ENABLED !== "true") return;
    let nextDeadline: number | undefined;
    const current = await this.state.storage.get<StreamResend>(STREAM_RESEND_KEY);
    if (current && current.attempt < STREAM_RESEND_MAX_ATTEMPTS && Number.isFinite(current.nextAttemptMs)) {
      nextDeadline = current.nextAttemptMs;
    }
    const claims = await this.state.storage.list<StreamResendClaim>({ prefix: STREAM_RESEND_CLAIM_PREFIX });
    for (const claim of claims.values()) {
      if (!Number.isFinite(claim.leaseUntilMs)) continue;
      nextDeadline = nextDeadline === undefined
        ? claim.leaseUntilMs
        : Math.min(nextDeadline, claim.leaseUntilMs);
    }
    if (nextDeadline !== undefined) await this.state.storage.setAlarm?.(nextDeadline);
  }

  private async scheduleResend(): Promise<void> {
    if (this.ottEnv.OTT_SPECTATOR_ENABLED !== "true") return;
    const now = Date.now();
    const record = await this.state.storage.transaction(async (storage) => {
      const existing = await storage.get<StreamResend>(STREAM_RESEND_KEY);
      const claims = await storage.list<StreamResendClaim>({ prefix: STREAM_RESEND_CLAIM_PREFIX });
      const claimed = [...claims.values()].find((value) => value.catalogRevision >= this.cachedCatalogRevision);
      if (claimed) {
        return { ...claimed, nextAttemptMs: claimed.leaseUntilMs };
      }
      const exhausted = await storage.get<StreamResend>(STREAM_RESEND_EXHAUSTED_KEY);
      if (exhausted && exhausted.catalogRevision >= this.cachedCatalogRevision) return null;
      if (exhausted) await storage.delete(STREAM_RESEND_EXHAUSTED_KEY);
      if (existing && existing.attempt < STREAM_RESEND_MAX_ATTEMPTS) return existing;
      if (existing && existing.catalogRevision >= this.cachedCatalogRevision) return null;
      const next: StreamResend = {
        catalogRevision: this.cachedCatalogRevision,
        attempt: 0,
        nextAttemptMs: now + STREAM_RESEND_BASE_MS,
      };
      await storage.put(STREAM_RESEND_KEY, next);
      return next;
    });
    if (record) await this.scheduleResendAlarm();
  }

  private async sendCatalog(connection: Connection, catalog = {
    catalogRevision: this.cachedCatalogRevision,
    matches: this.cachedMatches,
  }, scheduleFailure = true): Promise<boolean> {
    try {
      const send = (connection as Connection & { send?: (message: string) => void }).send;
      if (typeof send !== "function") throw new TypeError("Connection does not expose send");
      send.call(connection, `__YPS:${this.catalogMessage(catalog)}`);
      return true;
    } catch {
      if (scheduleFailure) await this.scheduleResend();
      return false;
    }
  }

  private async restoreResend(record: StreamResendClaim): Promise<void> {
    const nextAttempt = record.attempt + 1;
    if (nextAttempt >= STREAM_RESEND_MAX_ATTEMPTS) {
      await this.state.storage.transaction(async (storage) => {
        const claim = await storage.get<StreamResendClaim>(streamResendClaimKey(record.catalogRevision));
        if (!claim || claim.attempt !== record.attempt || claim.nextAttemptMs !== record.nextAttemptMs ||
            claim.claimToken !== record.claimToken) return;
        await storage.put(STREAM_RESEND_EXHAUSTED_KEY, {
          ...streamResendRecord(record),
          attempt: nextAttempt,
          nextAttemptMs: Date.now(),
        } satisfies StreamResend);
        await storage.delete(streamResendClaimKey(record.catalogRevision));
      });
      console.warn(`OTT lobby stream resend exhausted at revision ${record.catalogRevision}`);
      return;
    }
    const next: StreamResend = {
      ...streamResendRecord(record),
      attempt: nextAttempt,
      nextAttemptMs: Date.now() + Math.min(STREAM_RESEND_MAX_MS, STREAM_RESEND_BASE_MS * (2 ** record.attempt)),
    };
    const restored = await this.state.storage.transaction(async (storage) => {
      const claim = await storage.get<StreamResendClaim>(streamResendClaimKey(record.catalogRevision));
      if (!claim || claim.attempt !== record.attempt || claim.nextAttemptMs !== record.nextAttemptMs ||
          claim.claimToken !== record.claimToken) return false;
      const current = await storage.get<StreamResend>(STREAM_RESEND_KEY);
      if (current && (
        current.catalogRevision !== record.catalogRevision ||
        current.attempt !== record.attempt ||
        current.nextAttemptMs !== record.nextAttemptMs
      )) {
        await storage.delete(streamResendClaimKey(record.catalogRevision));
        return false;
      }
      await storage.put(STREAM_RESEND_KEY, next);
      await storage.delete(streamResendClaimKey(record.catalogRevision));
      return true;
    });
    if (restored) await this.scheduleResendAlarm();
  }

  private async claimResend(now: number): Promise<StreamResendClaim | null> {
    return this.state.storage.transaction(async (storage) => {
      const current = await storage.get<StreamResend>(STREAM_RESEND_KEY);
      const claims = await storage.list<StreamResendClaim>({ prefix: STREAM_RESEND_CLAIM_PREFIX });
      for (const claim of claims.values()) {
        if (current && current.catalogRevision > claim.catalogRevision) {
          if (claim.leaseUntilMs <= now) await storage.delete(streamResendClaimKey(claim.catalogRevision));
          continue;
        }
        if (claim.leaseUntilMs > now) return null;
        await storage.delete(STREAM_RESEND_KEY);
        const nextAttempt = claim.attempt + 1;
        if (nextAttempt >= STREAM_RESEND_MAX_ATTEMPTS) {
          await storage.put(STREAM_RESEND_EXHAUSTED_KEY, {
            ...streamResendRecord(claim),
            attempt: nextAttempt,
            nextAttemptMs: now,
          } satisfies StreamResend);
          await storage.delete(streamResendClaimKey(claim.catalogRevision));
          return null;
        }
        const recovered: StreamResendClaim = {
          ...claim,
          attempt: nextAttempt,
          claimToken: crypto.randomUUID(),
          nextAttemptMs: now,
          leaseUntilMs: now + STREAM_RESEND_CLAIM_LEASE_MS,
        };
        await storage.put(streamResendClaimKey(claim.catalogRevision), recovered);
        return recovered;
      }
      if (!current || current.nextAttemptMs > now || current.attempt >= STREAM_RESEND_MAX_ATTEMPTS) return null;
      const claim: StreamResendClaim = {
        ...current,
        claimToken: crypto.randomUUID(),
        leaseUntilMs: now + STREAM_RESEND_CLAIM_LEASE_MS,
      };
      await storage.put(streamResendClaimKey(current.catalogRevision), claim);
      await storage.delete(STREAM_RESEND_KEY);
      return claim;
    });
  }

  private async completeResend(record: StreamResendClaim): Promise<void> {
    await this.state.storage.transaction(async (storage) => {
      const claim = await storage.get<StreamResendClaim>(streamResendClaimKey(record.catalogRevision));
      if (!claim || claim.attempt !== record.attempt || claim.nextAttemptMs !== record.nextAttemptMs ||
          claim.claimToken !== record.claimToken) return;
      await storage.delete(streamResendClaimKey(record.catalogRevision));
      const current = await storage.get<StreamResend>(STREAM_RESEND_KEY);
      if (current && current.catalogRevision <= record.catalogRevision) await storage.delete(STREAM_RESEND_KEY);
      const exhausted = await storage.get<StreamResend>(STREAM_RESEND_EXHAUSTED_KEY);
      if (exhausted && exhausted.catalogRevision <= record.catalogRevision) await storage.delete(STREAM_RESEND_EXHAUSTED_KEY);
    });
  }

  private async updateCachedCatalog(catalog: CachedCatalog): Promise<void> {
    await this.persistCatalog(catalog);
    this.cachedCatalogRevision = catalog.catalogRevision;
    this.cachedMatches = catalog.matches;
  }

  private parseCatalog(catalogRevision: unknown, matches: unknown): CachedCatalog | null {
    const result = validatePublicMatchCatalog({
      __ott: true,
      type: "ott:active-matches",
      catalogRevision,
      matches,
    });
    return result.ok ? { catalogRevision: result.value.catalogRevision, matches: [...result.value.matches] } : null;
  }

  private async loadCachedCatalog(): Promise<CachedCatalog> {
    const persisted = await this.state.storage.get<CachedCatalog>("public-catalog-cache");
    const parsed = persisted ? this.parseCatalog(persisted.catalogRevision, persisted.matches) : null;
    if (parsed && parsed.catalogRevision >= this.cachedCatalogRevision) {
      await this.updateCachedCatalog(parsed);
    }
    return { catalogRevision: this.cachedCatalogRevision, matches: this.cachedMatches };
  }

  private isSubscriptionMessage(message: unknown): boolean {
    if (typeof message !== "string" || new TextEncoder().encode(message).byteLength > MAX_OTT_PAYLOAD_BYTES) return false;
    try {
      const parsed: unknown = JSON.parse(message);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      const value = parsed as Record<string, unknown>;
      return Object.keys(value).sort().join(",") === "__ott,type" && value.__ott === true && value.type === "ott:lobby-subscribe";
    } catch {
      return false;
    }
  }

  private async dispatchCustomMessage(connection: Connection, message: string): Promise<void> {
    if (!this.isSubscriptionMessage(message)) return;

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
        const catalog = data && this.parseCatalog(data.catalogRevision, data.matches);
        if (catalog) {
          if (catalog.catalogRevision > this.cachedCatalogRevision) await this.updateCachedCatalog(catalog);
          await this.sendCatalog(connection);
          return;
        }
      }
    } catch {
      // Failed to resync from lobby
    }

    try {
      this.sendCustomMessage(connection, JSON.stringify({
        __ott: true,
        type: "ott:error",
        error: "active_matches_unavailable",
      }));
    } catch {
      // A disconnected subscriber will recover through a later resubscribe.
    }
  }

  override async alarm(): Promise<void> {
    let record: StreamResendClaim | null = null;
    if (this.ottEnv.OTT_SPECTATOR_ENABLED === "true") {
      record = await this.claimResend(Date.now());
      if (record) {
        let failed = false;
        try {
          const catalog = await this.loadCachedCatalog();
          for (const connection of this.getConnections()) {
            if (!await this.sendCatalog(connection, catalog, false)) failed = true;
          }
          if (!failed) await this.completeResend(record);
        } catch {
          failed = true;
        }
        if (failed) {
          try {
            await this.restoreResend(record);
          } catch {
            // The durable claim remains leased and can be recovered by a later alarm.
          }
        }
        try {
          await this.scheduleResendAlarm();
        } catch {
          // A later cold wake can recover the durable claim if alarm persistence fails.
        }
      }
    } else {
      await this.state.storage.delete(STREAM_RESEND_KEY);
      const claims = await this.state.storage.list({ prefix: STREAM_RESEND_CLAIM_PREFIX });
      for (const key of claims.keys()) await this.state.storage.delete(key);
      await this.state.storage.delete(STREAM_RESEND_EXHAUSTED_KEY);
      await this.state.storage.deleteAlarm?.();
    }
    const superAlarm = (YServer.prototype as any)?.alarm;
    if (typeof superAlarm === "function") await superAlarm.call(this);
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
      const text = await readCappedUtf8Body(request, MAX_OTT_PAYLOAD_BYTES);
      if (text === null) return new Response("Bad request", { status: 400 });
      let body: { catalogRevision?: number; matches?: unknown[] };
      try {
        body = JSON.parse(text);
      } catch {
        return new Response("Bad request", { status: 400 });
      }
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== "catalogRevision,matches") {
        return new Response("Bad request", { status: 400 });
      }
      const catalog = this.parseCatalog(body.catalogRevision, body.matches);
      if (!catalog) {
        return new Response("Bad request", { status: 400 });
      }

      await this.loadCachedCatalog();
      if (catalog.catalogRevision > this.cachedCatalogRevision) {
        await this.updateCachedCatalog(catalog);
        const connections = [...this.getConnections()];
        for (const conn of connections) {
          await this.sendCatalog(conn, catalog);
        }
      }
      return Response.json({ ok: true });
    }
    return super.fetch(request);
  }
}
