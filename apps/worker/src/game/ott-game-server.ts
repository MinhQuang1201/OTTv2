import { YServer } from "y-partyserver";
import type {
  Connection,
  WSMessage,
} from "../../../../node_modules/playhtml/node_modules/partyserver/dist/index.js";
import {
  MIN_OTT_PACKET_INTERVAL_MS,
  parseOttMessage,
  type OttCommand,
} from "../../../../packages/protocol/src/index.js";
import { applyInitializationReceipt, applySeatUpdateReceipt, attachWithCapabilityRecovery, initializationPayloadHash, verifyCapability, verifyCapabilityTransaction } from "../auth/internal-auth.js";
import { DurableRoomAdapter, projectRoomPayload, ROOM_UNAVAILABLE, type CommittedRoomOutcome, type RoomViewer } from "../persistence/room-storage.js";

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
  delivered?: boolean;
};

type AttachmentMetadata = {
  phase: "pending" | "authenticated";
  role: "player" | "spectator";
  seat?: "A" | "B";
  nonce: string;
};

type RoleReservation = {
  role: "player" | "spectator";
  generation: number;
  completed: Promise<void>;
  resolve: () => void;
};

const ATTACHMENT_PREFIX = "live-attachment:";

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
  private readonly identities = new Map<Connection, RoomViewer>();
  private readonly identityNonces = new Map<Connection, string>();
  private readonly pendingIdentities = new Map<Connection, RoomViewer>();
  private readonly roleReservations = new Map<Connection, RoleReservation>();
  private readonly connectionGenerations = new Map<Connection, number>();
  private readonly closedConnections = new WeakSet<Connection>();
  private readonly authority?: GameAuthority;
  private roomAdapter?: DurableRoomAdapter | null;
  private roomLoad?: Promise<DurableRoomAdapter | null>;
  private roomOperationTail: Promise<void> = Promise.resolve();
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
    await this.enqueueRoomOperation(() => this.processAlarm());
  }

  private async processAlarm(): Promise<void> {
    const adapter = await this.loadRoom();
    if (!adapter || adapter.unavailable) return;
    const result = await adapter.onAlarm();
    if (result) await this.publishCommitted(adapter, result);
  }

  override isReadOnly(_connection: Connection): boolean {
    // YServer still performs protocol sync, but discards client document updates.
    return true;
  }

  override onConnect(connection: Connection, context: Request): void {
    this.closedConnections.delete(connection);
    this.ensureConnectionGeneration(connection);
    super.onConnect(connection, context);
  }

  override onCustomMessage(connection: Connection, message: string): void {
    void this.dispatchOttMessage(connection, message).catch(() => undefined);
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
    const role = command.type === "ott:attach" ? "player" : command.type === "ott:spectate" ? "spectator" : null;
    const reservation = role ? this.reserveRole(connection, role) : null;
    if (role && !reservation) {
      this.sendError(connection, command.roomId, "connection_role_already_fixed");
      return;
    }
    if (!role && this.roleReservations.has(connection)) {
      this.sendError(connection, command.roomId, "connection_role_already_fixed");
      return;
    }
    await this.enqueueRoomOperation(() => this.processOttCommand(connection, command, reservation));
  }

  private async processOttCommand(connection: Connection, command: OttCommand, reservation: RoleReservation | null): Promise<void> {
    try {
      const roomId = await this.ctx.storage.get<string>("roomId");
      if (!roomId || command.roomId !== roomId || (reservation && !this.isCurrentReservation(connection, reservation))) return;
      const existingIdentity = this.identities.get(connection) ?? this.pendingIdentities.get(connection);
      if (command.type === "ott:attach") {
        const seat = await this.validateAttach(connection, command, reservation?.generation);
        if (!seat || !reservation || !this.isCurrentReservation(connection, reservation)) return;
        this.pendingIdentities.set(connection, { role: "player", seat });
      } else if (command.type === "ott:spectate") {
        const spectator = await this.attachSpectator(connection, command, reservation?.generation);
        if (!spectator || !reservation || !this.isCurrentReservation(connection, reservation)) return;
        const result = await this.publishSpectatorInitial(connection, reservation.generation);
        if (result && !result.delivered && this.isCurrentReservation(connection, reservation)) this.sendCustomMessage(connection, JSON.stringify(result));
        return;
      } else if (!existingIdentity) {
        return;
      } else if (existingIdentity.role === "spectator") {
        this.sendError(connection, command.roomId, "spectator_read_only");
        return;
      }

      const result = await this.handleAuthoritativeCommand(connection, command, reservation?.generation);
      if (!result) return;
      if (result.delivered) return;
      this.sendCustomMessage(connection, JSON.stringify({
        __ott: true,
        roomId: command.roomId,
        revision: result.revision,
        type: result.type,
        ...(result.ok === true ? { ok: true } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...("state" in result ? { state: result.state } : {}),
      }));
    } finally {
      if (reservation) this.releaseRole(connection, reservation);
    }
  }

  private enqueueRoomOperation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.roomOperationTail.then(operation, operation);
    this.roomOperationTail = next.then(() => undefined, () => undefined);
    return next;
  }

  private async handleAuthoritativeCommand(connection: Connection, command: OttCommand, generation?: number): Promise<OttHandlerResult | void> {
    const adapter = await this.loadRoom();
    if (!adapter || adapter.unavailable || !adapter.room) {
      return { type: "ott:error", revision: 0, error: ROOM_UNAVAILABLE };
    }
    if (generation !== undefined && !this.isLiveGeneration(connection, generation)) return;
    try {
      let result: any;
      let committed: CommittedRoomOutcome | null = null;
      if (command.type === "ott:attach") {
        const identity = this.pendingIdentities.get(connection);
        const seat = identity?.role === "player" ? identity.seat : undefined;
        if (!seat) return { type: "ott:error", revision: adapter.room.revision, error: "attach_required" };
        const capability = this.attachCapabilities.get(connection);
        if (!capability) return { type: "ott:error", revision: adapter.room.revision, error: "attach_required" };
        const allocationId = await this.ctx.storage.get<string>("allocationId");
        if (!allocationId) return { type: "ott:error", revision: adapter.room.revision, error: "attach_required" };
        if (generation !== undefined && !this.isLiveGeneration(connection, generation)) return;
        const consumed = await attachWithCapabilityRecovery(this.ottEnv.OTT_INTERNAL_SECRET, capability.token, {
          allocationId,
          roomId: adapter.roomId,
          purpose: "attach",
        }, (callback) => this.transaction(callback), adapter, connection);
        result = consumed.ok ? consumed.value : { ok: false, error: consumed.reason === "replay" ? "attach_replayed" : "attach_rejected" };
        if (consumed.ok) {
          if (generation !== undefined && !this.isLiveGeneration(connection, generation)) return;
          if (!this.installIdentity(connection, { role: "player", seat }, capability.nonce, generation)) {
            let compensation: CommittedRoomOutcome | null = null;
            try {
              compensation = await adapter.rollbackAttach(connection);
            } catch {
              // The close lifecycle remains the final compensation path.
            }
            if (generation === undefined || this.isLiveGeneration(connection, generation)) {
              this.attachCapabilities.delete(connection);
              this.pendingIdentities.delete(connection);
            }
            return {
              type: "ott:error",
              revision: (compensation?.payload.revision as number | undefined) ?? adapter.room.revision,
              error: "identity_install_failed",
            };
          }
          adapter.commitAttach(connection);
          this.attachCapabilities.delete(connection);
          this.pendingIdentities.delete(connection);
        } else {
          this.pendingIdentities.delete(connection);
        }
      } else if (command.type === "ott:move") {
        committed = await adapter.move(connection, command.from, command.to);
        result = committed.result;
      } else {
        committed = await adapter.leave(connection);
        result = committed.result;
      }
      if (!result || result.ok === false) {
        if (committed) await this.publishCommitted(adapter, committed);
        if (command.type === "ott:attach") this.pendingIdentities.delete(connection);
        return { type: "ott:error", revision: (committed?.payload.revision as number | undefined) ?? adapter.room.revision, error: result?.error || "invalid_command" };
      }
      if (command.type === "ott:attach") {
        committed = {
          result,
          payload: adapter.lastPayload as Record<string, unknown>,
          terminalReason: adapter.room.status === "done" ? adapter.room.state.reason || null : null,
        };
      }
      if (committed) await this.publishCommitted(adapter, committed);
      const identity = this.identities.get(connection);
      const viewer = identity ?? { role: "player", seat: "A" } as const;
      const payload = (committed?.payload ?? adapter.lastPayload) as Record<string, unknown> | null | undefined;
      if (!payload) return { type: "ott:error", revision: adapter.room.revision, error: ROOM_UNAVAILABLE };
      return {
        type: "ott:state",
        revision: payload.revision as number,
        ok: true,
        state: projectRoomPayload(payload, viewer, await this.spectatorCount()),
        delivered: true,
      };
    } catch {
      this.pendingIdentities.delete(connection);
      return { type: "ott:error", revision: adapter.room.revision, error: ROOM_UNAVAILABLE };
    }
  }

  private async loadRoom(): Promise<DurableRoomAdapter | null> {
    if (!this.roomLoad) {
      this.roomLoad = this.ctx.storage.get<string>("roomId").then((roomId) => roomId
        ? DurableRoomAdapter.load(roomId, this.ctx.storage, () => Date.now(), this.roomTiming())
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

  private ensureConnectionGeneration(connection: Connection): number {
    const existing = this.connectionGenerations.get(connection);
    if (existing !== undefined) return existing;
    this.connectionGenerations.set(connection, 1);
    return 1;
  }

  private isLiveGeneration(connection: Connection, generation: number): boolean {
    return this.connectionGenerations.get(connection) === generation;
  }

  private reserveRole(connection: Connection, role: "player" | "spectator"): RoleReservation | null {
    if (this.closedConnections.has(connection) || this.identities.has(connection) || this.pendingIdentities.has(connection) || this.roleReservations.has(connection)) return null;
    let resolve!: () => void;
    const completed = new Promise<void>((finish) => { resolve = finish; });
    const reservation = { role, generation: this.ensureConnectionGeneration(connection), completed, resolve };
    this.roleReservations.set(connection, reservation);
    if (role === "spectator") this.pendingIdentities.set(connection, { role });
    return reservation;
  }

  private isCurrentReservation(connection: Connection, reservation: RoleReservation): boolean {
    return this.roleReservations.get(connection) === reservation && this.isLiveGeneration(connection, reservation.generation);
  }

  private releasePendingRole(connection: Connection, generation?: number): void {
    if (generation !== undefined && !this.isLiveGeneration(connection, generation)) return;
    this.pendingIdentities.delete(connection);
  }

  private releaseRole(connection: Connection, reservation: RoleReservation): void {
    if (this.roleReservations.get(connection) === reservation) this.roleReservations.delete(connection);
    if (this.isLiveGeneration(connection, reservation.generation)) this.releasePendingRole(connection, reservation.generation);
    reservation.resolve();
  }

  private invalidateConnection(connection: Connection): number {
    const generation = this.ensureConnectionGeneration(connection) + 1;
    this.connectionGenerations.set(connection, generation);
    this.lastOttPacketMs.delete(connection);
    this.identities.delete(connection);
    this.identityNonces.delete(connection);
    this.pendingIdentities.delete(connection);
    this.attachCapabilities.delete(connection);
    this.roleReservations.delete(connection);
    this.closedConnections.add(connection);
    return generation;
  }

  private forgetConnectionGeneration(connection: Connection, generation: number): void {
    if (this.isLiveGeneration(connection, generation)) this.connectionGenerations.delete(connection);
  }

  private async attachSpectator(connection: Connection, command: Extract<OttCommand, { type: "ott:spectate" }>, generation?: number): Promise<boolean> {
    const allocationId = await this.ctx.storage.get<string>("allocationId");
    const roomId = await this.ctx.storage.get<string>("roomId");
    if (generation !== undefined && !this.isLiveGeneration(connection, generation)) return false;
    if (!allocationId || !roomId || command.roomId !== roomId) {
      this.releasePendingRole(connection, generation);
      this.sendError(connection, command.roomId, "spectate_rejected");
      return false;
    }
    const attachmentKey = this.attachmentKey(connection);
    const pending: AttachmentMetadata = { phase: "pending", role: "spectator", nonce: "" };
    const result = await verifyCapabilityTransaction(this.ottEnv.OTT_INTERNAL_SECRET, command.ticket, {
      allocationId,
      roomId,
      purpose: "spectate",
      role: "spectator",
    }, (callback) => this.transaction(callback), async (payload, storage) => {
      pending.nonce = payload.nonce;
      await storage.put(attachmentKey, pending);
      return { accepted: true, value: true };
    }, { noncePrefix: "spectate-nonce" });
    if (generation !== undefined && !this.isLiveGeneration(connection, generation)) return false;
    if (!result.ok) {
      this.releasePendingRole(connection, generation);
      try { await this.ctx.storage.delete?.(attachmentKey); } catch {
        try { connection.close?.(1011, "spectator attachment rollback failed"); } catch { /* fail closed */ }
      }
      this.sendError(connection, command.roomId, result.reason === "replay" ? "spectate_replayed" : "spectate_rejected");
      return false;
    }
    try {
      await this.ctx.storage.put(attachmentKey, {
        phase: "authenticated",
        role: "spectator",
        nonce: result.payload.nonce,
      } satisfies AttachmentMetadata);
      if (generation !== undefined && !this.isLiveGeneration(connection, generation)) return false;
      if (!this.installIdentity(connection, { role: "spectator" }, result.payload.nonce, generation)) throw new Error("identity install failed");
      this.releasePendingRole(connection, generation);
      return true;
    } catch {
      await this.clearAttachment(connection, generation);
      try { connection.close?.(1011, "spectator attachment promotion failed"); } catch { /* fail closed */ }
      return false;
    }
  }

  private sendError(connection: Connection, roomId: string, error: string, revision = 0): void {
    try {
      this.sendCustomMessage(connection, JSON.stringify({ __ott: true, roomId, revision, type: "ott:error", error }));
    } catch {
      // A failed send does not revoke an authenticated live identity.
    }
  }

  private attachmentKey(connection: Connection): string {
    return `${ATTACHMENT_PREFIX}${connection.id}`;
  }

  private installIdentity(connection: Connection, identity: RoomViewer, nonce: string, generation?: number): boolean {
    if (generation !== undefined && !this.isLiveGeneration(connection, generation)) return false;
    try {
      const attachment: AttachmentMetadata = {
        phase: "authenticated",
        role: identity.role,
        ...(identity.role === "player" ? { seat: identity.seat } : {}),
        nonce,
      };
      if (typeof connection.serializeAttachment !== "function") throw new Error("connection attachment serialization unavailable");
      connection.serializeAttachment({ ottViewer: attachment });
      if (generation !== undefined && !this.isLiveGeneration(connection, generation)) return false;
      this.identities.set(connection, identity);
      this.identityNonces.set(connection, nonce);
      return true;
    } catch {
      try { connection.close?.(1011, "identity attachment failed"); } catch { /* fail closed */ }
      this.identities.delete(connection);
      this.identityNonces.delete(connection);
      return false;
    }
  }

  private async clearAttachment(connection: Connection, generation?: number): Promise<void> {
    if (generation !== undefined && !this.isLiveGeneration(connection, generation)) return;
    this.identities.delete(connection);
    this.identityNonces.delete(connection);
    this.pendingIdentities.delete(connection);
    this.attachCapabilities.delete(connection);
    try { await this.ctx.storage.delete?.(this.attachmentKey(connection)); } catch { /* close lifecycle remains authoritative */ }
  }

  private async spectatorCount(): Promise<number> {
    let count = 0;
    for (const [connection, identity] of this.identities) {
      if (identity.role !== "spectator") continue;
      const nonce = this.identityNonces.get(connection);
      if (!nonce) continue;
      if (await this.ctx.storage.get<number>(`spectate-nonce:${nonce}`) !== undefined) count += 1;
    }
    return count;
  }

  private async sendProjection(connection: Connection, adapter: DurableRoomAdapter, payload: Record<string, unknown> | null | undefined, spectatorCount: number): Promise<boolean> {
    const viewer = this.identities.get(connection);
    if (!viewer || !payload) return false;
    try {
      this.sendCustomMessage(connection, JSON.stringify({
        __ott: true,
        roomId: adapter.roomId,
        revision: payload.revision as number,
        type: "ott:state",
        state: projectRoomPayload(payload, viewer, spectatorCount),
      }));
      return true;
    } catch {
      // Keep the authenticated identity until the close lifecycle proves it is gone.
      return false;
    }
  }

  private async broadcastState(adapter: DurableRoomAdapter, payload: Record<string, unknown> | null | undefined = adapter.lastPayload as Record<string, unknown> | null | undefined): Promise<boolean> {
    const count = await this.spectatorCount();
    const delivered = await Promise.all([...this.identities.keys()].map((connection) => this.sendProjection(connection, adapter, payload, count)));
    return delivered.every(Boolean);
  }

  private async publishCommitted(adapter: DurableRoomAdapter, outcome: CommittedRoomOutcome): Promise<void> {
    if (!outcome.terminalReason) {
      await this.broadcastState(adapter, outcome.payload);
      return;
    }
    let projected = false;
    try {
      projected = await this.broadcastState(adapter, outcome.payload);
    } catch {
      projected = false;
    }
    if (!projected) {
      await adapter.scheduleTerminalRetry(outcome.terminalReason);
      return;
    }
    try {
      await this.terminalizeAllocation(outcome.terminalReason);
      await adapter.markTerminalized(outcome.terminalReason);
    } catch {
      // The committed Room and terminal projection remain durable; retry Lobby cleanup by alarm.
      await adapter.scheduleTerminalRetry(outcome.terminalReason);
    }
  }

  private async publishSpectatorInitial(connection: Connection, generation?: number): Promise<OttHandlerResult | void> {
    const adapter = await this.loadRoom();
    if (!adapter || adapter.unavailable || !adapter.room || !adapter.lastPayload) {
      await this.clearAttachment(connection, generation);
      return { type: "ott:error", revision: 0, error: ROOM_UNAVAILABLE };
    }
    const spectatorCount = await this.spectatorCount();
    if (generation !== undefined && !this.isLiveGeneration(connection, generation)) return;
    const payload = adapter.lastPayload as Record<string, unknown>;
    const projected = await this.broadcastState(adapter, payload);
    if (!projected) return;
    if (generation !== undefined && !this.isLiveGeneration(connection, generation)) return;
    if (!this.identities.has(connection)) return;
    return {
      type: "ott:state",
      revision: payload.revision as number,
      ok: true,
      state: projectRoomPayload(payload, { role: "spectator" }, spectatorCount),
      delivered: true,
    };
  }

  private async validateAttach(connection: Connection, command: Extract<OttCommand, { type: "ott:attach" }>, generation?: number): Promise<"A" | "B" | false> {
    if (this.authority) {
      const result = await this.authority.validateAttach(connection, command);
      if (generation !== undefined && !this.isLiveGeneration(connection, generation)) return false;
      return typeof result === "object" ? result.seat : result ? "A" : false;
    }
    const allocationId = await this.ctx.storage.get<string>("allocationId");
    const roomId = await this.ctx.storage.get<string>("roomId");
    if (!allocationId || !roomId || command.roomId !== roomId) return false;
    const capability = await verifyCapability(this.ottEnv.OTT_INTERNAL_SECRET, command.ticket, { allocationId, roomId, purpose: "attach" });
    if (generation !== undefined && !this.isLiveGeneration(connection, generation)) return false;
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
    const identity = this.identities.get(connection) ?? this.pendingIdentities.get(connection);
    const reservation = this.roleReservations.get(connection);
    const generation = this.invalidateConnection(connection);
    void this.enqueueRoomOperation(() => this.handleClose(connection, identity, reservation, generation)).catch(() => undefined);
    super.onClose(connection, code, reason, wasClean);
  }

  private async handleClose(connection: Connection, identity?: RoomViewer, reservation?: RoleReservation, generation = this.ensureConnectionGeneration(connection)): Promise<void> {
    if (!this.isLiveGeneration(connection, generation)) return;
    try {
      if (reservation) await reservation.completed;
      if (!this.isLiveGeneration(connection, generation)) return;
      await this.clearAttachment(connection, generation);
      if (!this.isLiveGeneration(connection, generation)) return;
      if (identity?.role !== "player") {
        const adapter = await this.loadRoom();
        if (!this.isLiveGeneration(connection, generation)) return;
        if (adapter && !adapter.unavailable && adapter.room) await this.broadcastState(adapter);
        return;
      }
      const adapter = await this.loadRoom();
      if (!this.isLiveGeneration(connection, generation)) return;
      if (!adapter || adapter.unavailable || !adapter.room) return;
      try {
        let rollback: CommittedRoomOutcome | null = null;
        try { rollback = await adapter.rollbackAttach(connection); } catch { /* retry through normal close below */ }
        if (rollback) {
          await this.publishCommitted(adapter, rollback);
          return;
        }
        const outcome = await adapter.close(connection);
        if (outcome?.result) await this.publishCommitted(adapter, outcome);
      } catch {
        // A failed write makes the room unavailable; never publish an unpersisted close.
      }
    } finally {
      this.forgetConnectionGeneration(connection, generation);
    }
  }
}
