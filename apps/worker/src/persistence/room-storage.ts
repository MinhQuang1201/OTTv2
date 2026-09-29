// The JavaScript Room remains the single source of rule and lifecycle authority.
// This adapter supplies Durable Object persistence and deliberately inert timer hooks.
// @ts-ignore The application modules are CommonJS and are bundled by Wrangler.
import { Room } from "../../../../packages/game-core/src/room.js";
// @ts-ignore See the note above.
import { hydrateRoom, serializeRoom } from "../../../../partykit/room-storage.js";

export const ROOM_KEY = "room";
export const ROOM_UNAVAILABLE = "Phòng không khả dụng";

export type StorageLike = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  list?<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
  delete?(key: string): Promise<void>;
  setAlarm?(deadline: number): Promise<void>;
  deleteAlarm?(): Promise<void>;
};

export type RoomTiming = { initialClockMs?: number; reconnectGraceMs?: number; alarmRetryMs?: number };
export type RoomConnection = { id?: string; send?: (value: string) => void; readyState?: number; open?: boolean };
export type RoomViewer =
  | { readonly role: "player"; readonly seat: "A" | "B" }
  | { readonly role: "spectator" };

export type CommittedRoomOutcome<T = unknown> = {
  result: T;
  payload: Record<string, unknown>;
  terminalReason: string | null | undefined;
};

type ProvisionalAttach = {
  snapshot: unknown;
  previousPayload: Record<string, unknown> | null;
  liveConnections: Map<"A" | "B", RoomConnection>;
};

function projectPlayer(player: any): { name: string; connected: boolean } | null {
  if (!player) return null;
  return { name: String(player.name ?? ""), connected: player.connected === true };
}

/** Build a recipient-specific public room view without serializing Room internals. */
export function projectRoomPayload(payload: any, viewer: RoomViewer, spectatorCount = 0): Record<string, unknown> {
  const projection: Record<string, unknown> = {
    roomId: payload.roomId,
    status: payload.status === "done" ? "finished" : payload.status,
    serverNow: payload.serverNow,
    revision: payload.revision,
    players: {
      A: projectPlayer(payload.players?.A),
      B: projectPlayer(payload.players?.B),
    },
    state: payload.state,
    events: Array.isArray(payload.events) ? payload.events : [],
  };
  if (viewer.role === "spectator") {
    return { ...projection, viewer, spectatorCount };
  }
  return { ...projection, viewer, spectatorCount, you: viewer.seat };
}

export class DurableRoomAdapter {
  readonly roomId: string;
  room: any;
  lastPayload: unknown = null;
  unavailable = false;
  private readonly storage: StorageLike;
  private readonly now: () => number;
  private readonly timing: RoomTiming;
  private readonly connections = new Map<string, RoomConnection>();
  private readonly emittedTerminalReasons = new Set<string>();
  private readonly provisionalAttaches = new Map<RoomConnection, ProvisionalAttach>();

  private constructor(roomId: string, storage: StorageLike, now: () => number, room: any, timing: RoomTiming = {}) {
    this.roomId = roomId;
    this.storage = storage;
    this.now = now;
    this.timing = timing;
    this.room = room;
  }

  static async load(roomId: string, storage: StorageLike, now: () => number, timing: RoomTiming = {}, liveConnections = new Map<"A" | "B", RoomConnection>()): Promise<DurableRoomAdapter | null> {
    const saved = await storage.get<any>(ROOM_KEY);
    if (saved === undefined) return null;
    try {
      const room = hydrateRoom(saved, roomId, roomDependencies(now, timing));
      const adapter = new DurableRoomAdapter(roomId, storage, now, room, timing);
      const preservedSeats: ("A" | "B")[] = [];
      for (const seat of ["A", "B"] as const) {
        if (saved.players?.[seat]?.connected && room.players?.[seat]) {
          // hydrateRoom intentionally drops live socket references. Restore the
          // persisted marker long enough for Room to issue a fresh grace window.
          room.players[seat].connected = true;
          const liveConnection = liveConnections.get(seat);
          if (liveConnection) {
            room.players[seat].connection = liveConnection;
            adapter.remember(liveConnection);
            preservedSeats.push(seat);
          }
        }
      }
      adapter.lastPayload = room.payload();
      if (await storage.get("allocationTerminalReason")) adapter.unavailable = true;
      const reconciliation = room.reconcileHydration(now(), preservedSeats);
      if (reconciliation.seats.length || room.status === "waiting") {
        adapter.lastPayload = room.payload();
        await adapter.persist();
      } else {
        adapter.lastPayload = room.payload();
      }
      await adapter.scheduleAlarm();
      return adapter;
    } catch {
      const adapter = new DurableRoomAdapter(roomId, storage, now, null);
      adapter.unavailable = true;
      return adapter;
    }
  }

  static async create(roomId: string, storage: StorageLike, now: () => number, timing: RoomTiming = {}): Promise<DurableRoomAdapter> {
    const room = new Room(roomId, roomDependencies(now, timing));
    const adapter = new DurableRoomAdapter(roomId, storage, now, room, timing);
    adapter.lastPayload = room.payload();
    await adapter.persist();
    await adapter.scheduleAlarm();
    return adapter;
  }

  remember(connection: RoomConnection): void {
    if (connection.id !== undefined) this.connections.set(connection.id, connection);
  }

  forget(connection: RoomConnection): void {
    if (connection.id !== undefined) this.connections.delete(connection.id);
  }

  connection(id: string): RoomConnection | undefined { return this.connections.get(id); }

  connectionsSnapshot(): RoomConnection[] { return [...this.connections.values()]; }

  restoreLiveConnection(connection: RoomConnection, seat: "A" | "B"): boolean {
    if (this.unavailable || !this.room) return false;
    const player = this.room.players?.[seat];
    if (!player) return false;
    const changed = player.connection !== connection || player.connected !== true || player.reconnectDeadlineMs !== null;
    player.connection = connection;
    player.connected = true;
    player.reconnectDeadlineMs = null;
    this.remember(connection);
    if (this.room.status === "playing" && !this.room.state.winner && !this.room.state.clock.runningSeat) {
      this.room.state.clock.runningSeat = this.room.state.turn;
      this.room.clockAnchorMs = this.now();
    }
    return changed;
  }

  /** Finalize an attach only after the Game authority has persisted connection metadata. */
  commitAttach(connection: RoomConnection): void {
    this.provisionalAttaches.delete(connection);
  }

  /** Restore the exact Room snapshot captured before an unauthenticated attach. */
  async rollbackAttach(connection: RoomConnection): Promise<CommittedRoomOutcome | null> {
    const provisional = this.provisionalAttaches.get(connection);
    if (!provisional || this.unavailable || !this.room) return null;
    const restore = () => {
      this.room = hydrateRoom(provisional.snapshot, this.roomId, roomDependencies(this.now, this.timing));
      this.connections.clear();
      for (const [seat, liveConnection] of provisional.liveConnections) {
        const player = this.room.players[seat];
        if (!player) continue;
        player.connected = true;
        player.connection = liveConnection;
        player.reconnectDeadlineMs = null;
        this.remember(liveConnection);
      }
      return this.room;
    };
    const restoredRoom = restore();
    let payload = provisional.previousPayload;
    if (!payload) {
      payload = restoredRoom.payload() as Record<string, unknown>;
      restore();
    }
    this.lastPayload = payload;
    await this.storage.put(ROOM_KEY, provisional.snapshot);
    await this.scheduleAlarm();
    this.provisionalAttaches.delete(connection);
    return {
      result: { ok: true },
      payload,
      terminalReason: this.room.status === "done" ? this.room.state.reason || null : null,
    };
  }

  async persist(): Promise<void> {
    if (this.unavailable) throw new Error(ROOM_UNAVAILABLE);
    const snapshot = serializeRoom(this.room);
    await this.storage.put(ROOM_KEY, snapshot);
  }

  async scheduleAlarm(storage: StorageLike = this.storage): Promise<void> {
    if (await storage.get("allocationTerminalReason")) {
      await storage.deleteAlarm?.();
      return;
    }
    if (!storage.setAlarm || !this.room) return;
    if (this.room.status === "done") {
      if (this.room.state.reason && !(await storage.get("allocationTerminalReason"))) {
        await storage.setAlarm(this.now() + (this.timing.alarmRetryMs ?? 1_000));
      } else await storage.deleteAlarm?.();
      return;
    }
    const deadlines: number[] = [];
    const state = this.room.state;
    if (this.room.status === "playing" && state.clock?.runningSeat) {
      const seat = state.clock.runningSeat;
      deadlines.push(this.room.clockAnchorMs + state.clock.remainingMs[seat]);
    }
    for (const seat of ["A", "B"] as const) {
      const deadline = this.room.players[seat]?.reconnectDeadlineMs;
      if (typeof deadline === "number") deadlines.push(deadline);
    }
    if (storage.list) {
      for (const prefix of ["spectate-nonce:", "attach-nonce:", "nonce:"]) {
        const entries = await storage.list<number>({ prefix });
        for (const value of entries.values()) {
          if (typeof value === "number" && Number.isFinite(value)) deadlines.push(value);
        }
      }
    }
    const creatorDeadline = await storage.get<number>("creatorAttachDeadlineMs");
    if (this.room.status === "waiting" && !this.room.players.A && !(await storage.get("creatorAttachDeadlineConsumed")) && Number.isFinite(creatorDeadline)) {
      deadlines.push(creatorDeadline!);
    }
    const earliest = deadlines.length ? Math.min(...deadlines) : Number.POSITIVE_INFINITY;
    if (Number.isFinite(earliest)) await storage.setAlarm(Math.max(this.now(), earliest));
    else await storage.deleteAlarm?.();
  }

  async mutate(action: (room: any) => unknown, storage: StorageLike = this.storage, schedule = true): Promise<CommittedRoomOutcome> {
    if (this.unavailable || !this.room) throw new Error(ROOM_UNAVAILABLE);
    const result = action(this.room);
    try {
      // payload() may settle the authoritative clock; capture it before the write.
      this.lastPayload = this.room.payload();
      await storage.put(ROOM_KEY, serializeRoom(this.room));
      if (schedule) {
        const terminalReason = this.room.status === "done" ? this.room.state.reason : null;
        try {
          await this.scheduleAlarm(storage);
        } catch (error) {
          // A terminal Room is already durably committed. The server receives the
          // outcome and owns Lobby cleanup/retry, even when alarm storage is down.
          if (!terminalReason) throw error;
        }
      }
    } catch (error) {
      this.unavailable = true;
      throw error;
    }
    return {
      result,
      payload: this.lastPayload as Record<string, unknown>,
      terminalReason: this.room.status === "done" ? this.room.state.reason || null : null,
    };
  }

  async markTerminalized(reason: string, storage: StorageLike = this.storage): Promise<void> {
    await storage.put("allocationTerminalReason", reason);
    await storage.delete?.("terminalRetryReason");
    this.unavailable = true;
    await storage.deleteAlarm?.();
  }

  async scheduleTerminalRetry(reason: string, storage: StorageLike = this.storage): Promise<void> {
    this.emittedTerminalReasons.delete(reason);
    await storage.put("terminalRetryReason", reason);
    try {
      await this.scheduleAlarm(storage);
    } catch {
      await storage.put("terminalRetryReason", reason);
    }
  }

  async onAlarm(): Promise<CommittedRoomOutcome | null> {
    if (this.unavailable || !this.room) return null;
    const retryReason = await this.storage.get<string>("terminalRetryReason");
    if (retryReason) {
      if (this.emittedTerminalReasons.has(retryReason)) return null;
      const payload = this.room.payload();
      this.lastPayload = payload;
      this.emittedTerminalReasons.add(retryReason);
      return { result: null, payload, terminalReason: retryReason };
    }
    if (this.room.status === "done") {
      const reason = this.room.state.reason;
      if (!reason || await this.storage.get("allocationTerminalReason") || this.emittedTerminalReasons.has(reason)) return null;
      const payload = this.room.payload();
      this.lastPayload = payload;
      await this.scheduleTerminalRetry(reason);
      this.emittedTerminalReasons.add(reason);
      return { result: null, payload, terminalReason: reason };
    }
    const now = this.now();
    const creatorDeadline = await this.storage.get<number>("creatorAttachDeadlineMs");
    const creatorExpired = this.room.status === "waiting" && !this.room.players.A &&
      !(await this.storage.get("creatorAttachDeadlineConsumed")) && typeof creatorDeadline === "number" && creatorDeadline <= now;
    if (creatorExpired) {
      await this.storage.put("creatorAttachDeadlineConsumed", true);
      const payload = this.room.payload();
      this.lastPayload = payload;
      await this.persist();
      await this.scheduleTerminalRetry("creator_attach_timeout");
      this.emittedTerminalReasons.add("creator_attach_timeout");
      return { result: null, payload, terminalReason: "creator_attach_timeout" };
    }
    const clock = this.room.settleClock(now);
    const waiting = this.room.expireWaitingCreator(now);
    const reconnect = this.room.expireReconnect(now);
    const terminalReason = waiting.expired ? "disconnect_timeout" : this.room.status === "done" ? this.room.state.reason : null;
    if (clock.events?.length || waiting.expired || reconnect.events?.length) {
      this.lastPayload = this.room.payload();
      await this.persist();
    }
    if (terminalReason) {
      const payload = this.lastPayload ?? this.room.payload();
      this.lastPayload = payload;
      await this.scheduleTerminalRetry(terminalReason);
      this.emittedTerminalReasons.add(terminalReason);
      return {
        result: { clock, waiting, reconnect },
        payload: payload as Record<string, unknown>,
        terminalReason,
        clock,
        waiting,
        reconnect,
      } as CommittedRoomOutcome & { clock: unknown; waiting: unknown; reconnect: unknown };
    }
    await this.scheduleAlarm();
    return {
      result: { clock, waiting, reconnect },
      payload: (this.lastPayload ?? this.room.payload()) as Record<string, unknown>,
      terminalReason: undefined,
      clock,
      waiting,
      reconnect,
    } as CommittedRoomOutcome & { clock: unknown; waiting: unknown; reconnect: unknown };
  }

  async attach(connection: RoomConnection, seat: "A" | "B", name: string | undefined, storage: StorageLike = this.storage): Promise<any> {
    const trustedName = name ?? await storage.get<string>(seat === "A" ? "creatorName" : `seat-name:${seat}`);
    if (typeof trustedName !== "string" || !trustedName.trim()) return { ok: false, error: "seat_name_unavailable" };
    const snapshot = serializeRoom(this.room);
    const previousPayload = this.lastPayload ? structuredClone(this.lastPayload as Record<string, unknown>) : null;
    const liveConnections = new Map<"A" | "B", RoomConnection>();
    for (const candidate of ["A", "B"] as const) {
      const player = this.room?.players?.[candidate];
      const liveConnection = player?.connection as RoomConnection | undefined;
      if (player?.connected && liveConnection) liveConnections.set(candidate, liveConnection);
    }
    const existing = this.room?.players?.[seat];
    let result: any;
    if (existing && !existing.connected) {
      // The attach capability is issued by the lobby for this seat; Room still owns
      // the seat's opaque resume token and grace deadline.
      result = (await this.mutate((room) => room.resumePlayer(connection, existing.resumeToken), storage, storage === this.storage)).result;
    } else if (!existing) {
      // A B-seat capability must never be allowed to fill the first available
      // Room seat (which would silently turn B's owner into A).
      if (seat === "B" && !this.room?.players?.A) return { ok: false, error: "Ghế A chưa được khởi tạo" };
      result = (await this.mutate((room) => room.addPlayer(connection, trustedName), storage, storage === this.storage)).result;
      if (result?.ok && result.seat !== seat) {
        this.provisionalAttaches.set(connection, { snapshot, previousPayload, liveConnections });
        await this.rollbackAttach(connection);
        return { ok: false, error: "Sai ghế được cấp quyền" };
      }
    } else {
      return { ok: false, error: "Ghế đã được sử dụng" };
    }
    if (result?.ok) {
      this.provisionalAttaches.set(connection, { snapshot, previousPayload, liveConnections });
      this.remember(connection);
    }
    return result;
  }

  async reloadPersisted(): Promise<void> {
    this.provisionalAttaches.clear();
    const saved = await this.storage.get<any>(ROOM_KEY);
    if (saved === undefined) {
      this.room = null;
      this.lastPayload = null;
      this.unavailable = true;
      return;
    }
    const liveConnections = new Map<"A" | "B", RoomConnection>();
    for (const seat of ["A", "B"] as const) {
      const player = this.room?.players?.[seat];
      const connection = player?.connection as RoomConnection | undefined;
      if (player?.connected && connection?.id !== undefined && this.connections.get(connection.id) === connection) {
        liveConnections.set(seat, connection);
      }
    }
    this.room = hydrateRoom(saved, this.roomId, { now: this.now, schedule: () => undefined, cancel: () => undefined });
    for (const [seat, connection] of liveConnections) {
      const player = this.room.players[seat];
      if (!player) continue;
      player.connected = true;
      player.connection = connection;
      player.reconnectDeadlineMs = null;
    }
    this.lastPayload = this.room.payload();
    this.unavailable = false;
  }

  async move(connection: RoomConnection, from: unknown, to: unknown): Promise<any> {
    return this.mutate((room) => room.handleMove(connection, from, to));
  }

  async leave(connection: RoomConnection): Promise<any> {
    const outcome = await this.mutate((room) => room.leavePlayer(connection));
    this.forget(connection);
    const roomResult: any = outcome.result;
    return { ...outcome, result: roomResult?.result ?? roomResult };
  }

  async close(connection: RoomConnection): Promise<any> {
    const outcome = await this.mutate((room) => room.disconnectPlayer(connection));
    this.forget(connection);
    return outcome;
  }
}

function roomDependencies(now: () => number, timing: RoomTiming): Record<string, unknown> {
  return {
    now,
    schedule: () => undefined,
    cancel: () => undefined,
    ...(timing.initialClockMs === undefined ? {} : { initialClockMs: timing.initialClockMs }),
    ...(timing.reconnectGraceMs === undefined ? {} : { reconnectGraceMs: timing.reconnectGraceMs }),
  };
}
