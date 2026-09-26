import { YServer } from "y-partyserver";
import type {
  Connection,
  WSMessage,
} from "../node_modules/playhtml/node_modules/partyserver/dist/index.js";
import {
  MIN_OTT_PACKET_INTERVAL_MS,
  parseOttMessage,
  type OttCommand,
} from "./protocol.js";
import { applyInitializationReceipt, applySeatUpdateReceipt, attachWithCapabilityRecovery, initializationPayloadHash, verifyCapability, verifyCapabilityTransaction } from "./internal-auth.js";
import { DurableRoomAdapter, projectRoomPayload, ROOM_UNAVAILABLE } from "./room-storage.js";

export interface OttCommandHandler {
  handle(connection: Connection, command: OttCommand): OttHandlerResult | void | Promise<OttHandlerResult | void>;
}

export interface GameAuthority {
  validateAttach(connection: Connection, command: Extract<OttCommand, { type: "ott:attach" }>): Promise<boolean | { seat: "A" | "B" }>;
}

function configuredDuration(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

export type OttHandlerResult = {
  type: "ott:ack" | "ott:error" | "ott:state";
  revision: number;
  ok?: true;
  error?: string;
  state?: unknown;
};

const rejectingHandler: OttCommandHandler = {
  handle: () => ({ type: "ott:error", revision: 0, error: "authority_unavailable" }),
};

/**
 * Minimal Yjs room with OTT custom-message dispatch and no application persistence.
 * The public room name is selected by partyserver routing, not authorization.
 */
export class OttGameServer extends YServer {
  static options = { hibernate: true };
  private readonly ottCommandHandler: OttCommandHandler;
  protected readonly ottEnv: Env;
  private readonly lastOttPacketMs = new Map<Connection, number>();
  private readonly attached = new Set<Connection>();
  private readonly authority?: GameAuthority;
  private roomAdapter?: DurableRoomAdapter | null;
  private roomLoad?: Promise<DurableRoomAdapter | null>;
  private readonly attachSeats = new Map<Connection, "A" | "B">();
  private readonly attachCapabilities = new Map<Connection, { seat: "A" | "B"; nonce: string; expiresAt: number; token: string }>();

  constructor(state: DurableObjectState, env: Env, ottCommandHandler: OttCommandHandler = rejectingHandler, authority?: GameAuthority) {
    super(state, env);
    this.ottEnv = env;
    this.ottCommandHandler = ottCommandHandler;
    this.authority = authority;
  }

  override ["fetch"](request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/internal/initialize") return this.initialize(request);
    if (pathname === "/internal/seat-update") return this.updateSeat(request);
    if (pathname === "/ott/create" || pathname === "/ott/list" || pathname === "/internal/attach") {
      return new Response("Not found", { status: 404 });
    }
    return super["fetch"](request);
  }

  private transaction<T>(callback: (storage: DurableObjectTransaction) => Promise<T>): Promise<T> {
    return this.ctx.storage.transaction(callback);
  }

  private async initialize(request: Request): Promise<Response> {
    if (!this.ottEnv.OTT_INTERNAL_SECRET) {
      console.warn("OTT game initialization rejected: missing Game DO secret binding");
      return new Response("Forbidden", { status: 403 });
    }
    if (request.headers.get("x-ott-internal-secret") !== this.ottEnv.OTT_INTERNAL_SECRET) {
      console.warn("OTT game initialization rejected: internal secret mismatch");
      return new Response("Forbidden", { status: 403 });
    }
    let body: { allocationId?: string; roomId?: string; creatorName?: string; creatorAttachDeadlineMs?: number; capability?: string };
    try { body = await request.json(); } catch { return new Response("Bad request", { status: 400 }); }
    if (
      typeof body.allocationId !== "string" ||
      typeof body.roomId !== "string" ||
      typeof body.creatorName !== "string" ||
      !Number.isInteger(body.creatorAttachDeadlineMs) ||
      typeof body.capability !== "string"
    ) return new Response("Bad request", { status: 400 });
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.allocationId) || body.roomId !== `ott-${body.allocationId}`) {
      return new Response("Bad request", { status: 400 });
    }
    const receiptHash = await initializationPayloadHash(body as Required<Omit<typeof body, "capability">>);
    try {
      const result = await verifyCapabilityTransaction(this.ottEnv.OTT_INTERNAL_SECRET, body.capability, {
        allocationId: body.allocationId,
        roomId: body.roomId,
        purpose: "game-init",
        seat: "A",
      }, (callback) => this.transaction(callback), async (_payload, storage) => {
        const result = await applyInitializationReceipt(storage, {
          allocationId: body.allocationId!,
          roomId: body.roomId!,
          payloadHash: receiptHash,
        }, async (transactionalStorage) => {
          await transactionalStorage.put("allocationId", body.allocationId!);
          await transactionalStorage.put("roomId", body.roomId!);
          await transactionalStorage.put("publicRoom", body.roomId!);
          await transactionalStorage.put("creatorName", body.creatorName!);
          await transactionalStorage.put("creatorAttachDeadlineMs", body.creatorAttachDeadlineMs!);
          await DurableRoomAdapter.create(body.roomId!, transactionalStorage, () => Date.now(), this.roomTiming());
        });
        return { accepted: result !== "conflict", value: result };
      });
      if (!result.ok && result.reason === "mutation-rejected" && result.value === "conflict") return new Response("Conflict", { status: 409 });
      if (!result.ok) {
        console.warn(`OTT game initialization rejected: ${result.reason} initialization capability`);
        return new Response("Forbidden", { status: 403 });
      }
      await this.loadRoom();
      return Response.json({ ok: true, room: body.roomId });
    } catch {
      return new Response(ROOM_UNAVAILABLE, { status: 503 });
    }
  }

  private async updateSeat(request: Request): Promise<Response> {
    if (!this.ottEnv.OTT_INTERNAL_SECRET || request.headers.get("x-ott-internal-secret") !== this.ottEnv.OTT_INTERNAL_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
    let body: { allocationId?: string; roomId?: string; name?: string; capability?: string };
    try { body = await request.json(); } catch { return new Response("Bad request", { status: 400 }); }
    if (typeof body.allocationId !== "string" || typeof body.roomId !== "string" ||
        typeof body.name !== "string" || typeof body.capability !== "string") {
      return new Response("Bad request", { status: 400 });
    }
    const name = body.name.replace(/<[^>]*>/g, "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 32);
    if (!name) return new Response("Bad request", { status: 400 });
    const result = await verifyCapabilityTransaction(this.ottEnv.OTT_INTERNAL_SECRET, body.capability, {
      allocationId: body.allocationId,
      roomId: body.roomId,
      purpose: "seat-update",
      seat: "B",
    }, (callback) => this.transaction(callback), async (_payload, storage) => {
      const receipt = await applySeatUpdateReceipt(storage, {
        allocationId: body.allocationId!,
        roomId: body.roomId!,
        seat: "B",
        name,
      });
      return { accepted: receipt !== "conflict", value: receipt };
    });
    if (!result.ok && result.reason === "mutation-rejected" && result.value === "conflict") return new Response("Conflict", { status: 409 });
    if (!result.ok) return new Response("Forbidden", { status: 403 });
    return Response.json({ ok: true });
  }

  override async onLoad(): Promise<void> {
    await this.loadRoom();
  }

  override async onSave(): Promise<void> {
    // Do not persist the unauthenticated PlayHTML document.
  }

  override async onAlarm(): Promise<void> {
    const adapter = await this.loadRoom();
    if (!adapter || adapter.unavailable) return;
    const result = await adapter.onAlarm();
    if (result && adapter.lastPayload) this.broadcastState(adapter);
  }

  override isReadOnly(_connection: Connection): boolean {
    // YServer still performs protocol sync, but discards client document updates.
    return true;
  }

  override onConnect(connection: Connection, context: Request): void {
    super.onConnect(connection, context);
  }

  override onCustomMessage(connection: Connection, message: string): void {
    void this.dispatchOttMessage(connection, message);
  }

  private async dispatchOttMessage(connection: Connection, message: string): Promise<void> {
    const now = Date.now();
    const previous = this.lastOttPacketMs.get(connection);
    this.lastOttPacketMs.set(connection, now);
    if (previous !== undefined && now - previous < MIN_OTT_PACKET_INTERVAL_MS) return;

    const parsed = parseOttMessage(message);
    // Non-OTT custom messages are intentionally isolated from upstream handlers.
    if (!parsed.ok) return;
    const command = parsed.value;
    const roomId = await this.ctx.storage.get<string>("roomId");
    if (!roomId || command.roomId !== roomId) return;
    if (command.type === "ott:attach") {
      if (this.attached.has(connection)) return;
      const seat = await this.validateAttach(connection, command);
      if (!seat) return;
      this.attachSeats.set(connection, seat);
    } else if (!this.attached.has(connection)) {
      return;
    }

    const result = await this.handleAuthoritativeCommand(connection, command);
    if (!result) return;
    if (command.type === "ott:attach" && result.type !== "ott:error") this.attached.add(connection);
    this.sendCustomMessage(connection, JSON.stringify({
      __ott: true,
      roomId: command.roomId,
      revision: result.revision,
      type: result.type,
      ...(result.ok === true ? { ok: true } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...("state" in result ? { state: result.state } : {}),
    }));
  }

  private async handleAuthoritativeCommand(connection: Connection, command: OttCommand): Promise<OttHandlerResult | void> {
    const adapter = await this.loadRoom();
    if (!adapter || adapter.unavailable || !adapter.room) {
      return { type: "ott:error", revision: 0, error: ROOM_UNAVAILABLE };
    }
    try {
      let result: any;
      if (command.type === "ott:attach") {
        const seat = this.attachSeats.get(connection);
        if (!seat) return { type: "ott:error", revision: adapter.room.revision, error: "attach_required" };
        const capability = this.attachCapabilities.get(connection);
        if (!capability) return { type: "ott:error", revision: adapter.room.revision, error: "attach_required" };
        const allocationId = await this.ctx.storage.get<string>("allocationId");
        if (!allocationId) return { type: "ott:error", revision: adapter.room.revision, error: "attach_required" };
        const consumed = await attachWithCapabilityRecovery(this.ottEnv.OTT_INTERNAL_SECRET, capability.token, {
          allocationId,
          roomId: adapter.roomId,
          purpose: "attach",
        }, (callback) => this.transaction(callback), adapter, connection);
        result = consumed.ok ? consumed.value : { ok: false, error: consumed.reason === "replay" ? "attach_replayed" : "attach_rejected" };
        if (consumed.ok) this.attachCapabilities.delete(connection);
      } else if (command.type === "ott:move") {
        result = await adapter.move(connection, command.from, command.to);
      } else {
        result = await adapter.leave(connection);
      }
      if (!result || result.ok === false) {
        return { type: "ott:error", revision: adapter.room.revision, error: result?.error || "invalid_command" };
      }
      this.broadcastState(adapter, connection);
      const seat = this.attachSeats.get(connection);
      return { type: "ott:state", revision: adapter.room.revision, ok: true, state: seat ? projectRoomPayload(adapter.lastPayload, seat) : adapter.lastPayload };
    } catch {
      return { type: "ott:error", revision: adapter.room.revision, error: ROOM_UNAVAILABLE };
    }
  }

  private async loadRoom(): Promise<DurableRoomAdapter | null> {
    if (!this.roomLoad) {
      this.roomLoad = this.ctx.storage.get<string>("roomId").then((roomId) => roomId
        ? DurableRoomAdapter.load(roomId, this.ctx.storage, () => Date.now(), this.roomTiming(), (reason) => this.terminalizeAllocation(reason))
        : null).then((adapter) => {
        this.roomAdapter = adapter;
        return adapter;
      });
    }
    return this.roomLoad;
  }

  private roomTiming() {
    return {
      initialClockMs: configuredDuration(this.ottEnv.OTT_TEST_CLOCK_MS),
      reconnectGraceMs: configuredDuration(this.ottEnv.OTT_TEST_RECONNECT_GRACE_MS),
    };
  }

  private async terminalizeAllocation(reason: string): Promise<void> {
    const allocationId = await this.ctx.storage.get<string>("allocationId");
    const roomId = await this.ctx.storage.get<string>("roomId");
    if (!allocationId || !roomId) throw new Error("allocation identity unavailable for terminalization");
    const lobby = this.ottEnv.OTT_LOBBY.get(this.ottEnv.OTT_LOBBY.idFromName("lobby"));
    const response = await lobby.fetch(new Request("https://internal.invalid/internal/terminalize", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ott-internal-secret": this.ottEnv.OTT_INTERNAL_SECRET },
      body: JSON.stringify({ allocationId, roomId, reason }),
    }));
    if (!response.ok) throw new Error(`Lobby terminalization failed with HTTP ${response.status}`);
  }

  private broadcastState(adapter: DurableRoomAdapter, except?: Connection): void {
    if (!adapter.room) return;
    for (const connection of adapter.connectionsSnapshot()) {
      if (connection === except) continue;
      const seat = this.attachSeats.get(connection as Connection);
      if (!seat) continue;
      this.sendCustomMessage(connection as Connection, JSON.stringify({
        __ott: true,
        roomId: adapter.roomId,
        revision: adapter.room.revision,
        type: "ott:state",
        state: projectRoomPayload(adapter.lastPayload, seat),
      }));
    }
  }

  private async validateAttach(connection: Connection, command: Extract<OttCommand, { type: "ott:attach" }>): Promise<"A" | "B" | false> {
    if (this.authority) {
      const result = await this.authority.validateAttach(connection, command);
      return typeof result === "object" ? result.seat : result ? "A" : false;
    }
    const allocationId = await this.ctx.storage.get<string>("allocationId");
    const roomId = await this.ctx.storage.get<string>("roomId");
    if (!allocationId || !roomId || command.roomId !== roomId) return false;
    const capability = await verifyCapability(this.ottEnv.OTT_INTERNAL_SECRET, command.ticket, { allocationId, roomId, purpose: "attach" });
    if (!capability) return false;
    this.attachCapabilities.set(connection, { ...capability, token: command.ticket });
    return capability.seat;
  }

  protected async consumeAttachCapabilityForTest(ticket: string): Promise<boolean> {
    const allocationId = await this.ctx.storage.get<string>("allocationId");
    const roomId = await this.ctx.storage.get<string>("roomId");
    if (!allocationId || !roomId) return false;
    const result = await verifyCapabilityTransaction(this.ottEnv.OTT_INTERNAL_SECRET, ticket, { allocationId, roomId, purpose: "attach" },
      (callback) => this.transaction(callback), async () => ({ accepted: true, value: true }), { noncePrefix: "attach-nonce" });
    return result.ok;
  }

  override onMessage(connection: Connection, message: WSMessage): void {
    super.onMessage(connection, message);
  }

  override onClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean,
  ): void {
    this.lastOttPacketMs.delete(connection);
    this.attached.delete(connection);
    this.attachSeats.delete(connection);
    this.attachCapabilities.delete(connection);
    void this.handleClose(connection);
    super.onClose(connection, code, reason, wasClean);
  }

  private async handleClose(connection: Connection): Promise<void> {
    const adapter = await this.loadRoom();
    if (!adapter || adapter.unavailable || !adapter.room) return;
    try {
      await adapter.close(connection);
      this.broadcastState(adapter);
    } catch {
      // A failed write makes the room unavailable; never publish an unpersisted close.
    }
  }
}
