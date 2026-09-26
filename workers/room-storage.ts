// The JavaScript Room remains the single source of rule and lifecycle authority.
// This adapter supplies Durable Object persistence and deliberately inert timer hooks.
// @ts-ignore The application modules are CommonJS and are bundled by Wrangler.
import { Room } from "../room.js";
// @ts-ignore See the note above.
import { hydrateRoom, serializeRoom } from "../partykit/room-storage.js";

export const ROOM_KEY = "room";
export const ROOM_UNAVAILABLE = "Phòng không khả dụng";

export type StorageLike = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm?(deadline: number): Promise<void>;
  deleteAlarm?(): Promise<void>;
};

export type RoomTiming = { initialClockMs?: number; reconnectGraceMs?: number; alarmRetryMs?: number };
export type TerminalizeAllocation = (reason: string) => Promise<void>;

export type RoomConnection = { id?: string; send?: (value: string) => void; readyState?: number; open?: boolean };

function projectPlayer(player: any): { name: string; connected: boolean } | null {
  if (!player) return null;
  return { name: String(player.name ?? ""), connected: player.connected === true };
}

/** Build a recipient-specific public room view without serializing Room internals. */
export function projectRoomPayload(payload: any, seat: "A" | "B"): Record<string, unknown> {
  return {
    roomId: payload.roomId,
    status: payload.status,
    serverNow: payload.serverNow,
    revision: payload.revision,
    players: {
      A: projectPlayer(payload.players?.A),
      B: projectPlayer(payload.players?.B),
    },
    state: payload.state,
    events: Array.isArray(payload.events) ? payload.events : [],
    you: seat,
  };
}

export class DurableRoomAdapter {
  readonly roomId: string;
  room: any;
  lastPayload: unknown = null;
  unavailable = false;
  private readonly storage: StorageLike;
  private readonly now: () => number;
  private readonly timing: RoomTiming;
  private readonly terminalizeAllocation?: TerminalizeAllocation;
  private readonly connections = new Map<string, RoomConnection>();

  private constructor(roomId: string, storage: StorageLike, now: () => number, room: any, timing: RoomTiming = {}, terminalizeAllocation?: TerminalizeAllocation) {
    this.roomId = roomId;
    this.storage = storage;
    this.now = now;
    this.timing = timing;
    this.terminalizeAllocation = terminalizeAllocation;
    this.room = room;
  }

  static async load(roomId: string, storage: StorageLike, now: () => number, timing: RoomTiming = {}, terminalizeAllocation?: TerminalizeAllocation): Promise<DurableRoomAdapter | null> {
    const saved = await storage.get<any>(ROOM_KEY);
    if (saved === undefined) return null;
    try {
      const room = hydrateRoom(saved, roomId, roomDependencies(now, timing));
      const adapter = new DurableRoomAdapter(roomId, storage, now, room, timing, terminalizeAllocation);
      if (await storage.get("allocationTerminalReason")) adapter.unavailable = true;
      const reconciliation = room.reconcileHydration(now());
      if (reconciliation.seats.length || room.status === "waiting") await adapter.persist();
      await adapter.scheduleAlarm();
      return adapter;
    } catch {
      const adapter = new DurableRoomAdapter(roomId, storage, now, null);
      adapter.unavailable = true;
      return adapter;
    }
  }

  static async create(roomId: string, storage: StorageLike, now: () => number, timing: RoomTiming = {}, terminalizeAllocation?: TerminalizeAllocation): Promise<DurableRoomAdapter> {
    const room = new Room(roomId, roomDependencies(now, timing));
    const adapter = new DurableRoomAdapter(roomId, storage, now, room, timing, terminalizeAllocation);
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
    const creatorDeadline = await storage.get<number>("creatorAttachDeadlineMs");
    if (this.room.status === "waiting" && !this.room.players.A && !(await storage.get("creatorAttachDeadlineConsumed")) && Number.isFinite(creatorDeadline)) {
      deadlines.push(creatorDeadline!);
    }
    const earliest = deadlines.length ? Math.min(...deadlines) : Number.POSITIVE_INFINITY;
    if (Number.isFinite(earliest)) await storage.setAlarm(Math.max(this.now(), earliest));
    else await storage.deleteAlarm?.();
  }

  async mutate(action: (room: any) => unknown, storage: StorageLike = this.storage, schedule = true): Promise<unknown> {
    if (this.unavailable || !this.room) throw new Error(ROOM_UNAVAILABLE);
    const result = action(this.room);
    try {
      // payload() may settle the authoritative clock; capture it before the write.
      this.lastPayload = this.room.payload();
      await storage.put(ROOM_KEY, serializeRoom(this.room));
      if (schedule) {
        const terminalReason = this.room.status === "done" ? this.room.state.reason : null;
        if (terminalReason && this.terminalizeAllocation && !(await storage.get("allocationTerminalReason"))) {
          // A terminal mutation may remove the only outstanding alarm (for example,
          // when the creator leaves). Notify Lobby synchronously after the durable
          // Room write so an alarm-storage failure cannot strand the allocation.
          try {
            await this.terminalizeAllocation(terminalReason);
            await storage.put("allocationTerminalReason", terminalReason);
            await storage.deleteAlarm?.();
            this.unavailable = true;
          } catch {
            // If Lobby is temporarily unavailable, retain the durable terminal Room
            // and arm the normal terminal retry instead of losing the allocation
            // cleanup after the previous alarm has been cleared.
            await this.scheduleAlarm(storage);
          }
        } else {
          await this.scheduleAlarm(storage);
        }
      }
    } catch (error) {
      this.unavailable = true;
      throw error;
    }
    return result;
  }

  async onAlarm(): Promise<unknown> {
    if (this.unavailable || !this.room) return null;
    if (this.room.status === "done") {
      const reason = this.room.state.reason;
      if (!reason || await this.storage.get("allocationTerminalReason")) return null;
      if (this.terminalizeAllocation) await this.terminalizeAllocation(reason);
      await this.storage.put("allocationTerminalReason", reason);
      this.unavailable = true;
      await this.storage.deleteAlarm?.();
      return { terminalReason: reason };
    }
    const now = this.now();
    const creatorDeadline = await this.storage.get<number>("creatorAttachDeadlineMs");
    const creatorExpired = this.room.status === "waiting" && !this.room.players.A &&
      !(await this.storage.get("creatorAttachDeadlineConsumed")) && typeof creatorDeadline === "number" && creatorDeadline <= now;
    if (creatorExpired) {
      if (this.terminalizeAllocation) await this.terminalizeAllocation("creator_attach_timeout");
      await this.storage.put("creatorAttachDeadlineConsumed", true);
      await this.storage.put("allocationTerminalReason", "creator_attach_timeout");
      this.unavailable = true;
      await this.storage.deleteAlarm?.();
      return { terminalReason: "creator_attach_timeout" };
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
      if (this.terminalizeAllocation) await this.terminalizeAllocation(terminalReason);
      await this.storage.put("allocationTerminalReason", terminalReason);
      this.unavailable = true;
      await this.storage.deleteAlarm?.();
      return { clock, waiting, reconnect, terminalReason };
    }
    await this.scheduleAlarm();
    return { clock, waiting, reconnect };
  }

  async attach(connection: RoomConnection, seat: "A" | "B", name: string | undefined, storage: StorageLike = this.storage): Promise<any> {
    const trustedName = name ?? await storage.get<string>(seat === "A" ? "creatorName" : `seat-name:${seat}`);
    if (typeof trustedName !== "string" || !trustedName.trim()) return { ok: false, error: "seat_name_unavailable" };
    const existing = this.room?.players?.[seat];
    let result: any;
    if (existing && !existing.connected) {
      // The attach capability is issued by the lobby for this seat; Room still owns
      // the seat's opaque resume token and grace deadline.
      result = await this.mutate((room) => room.resumePlayer(connection, existing.resumeToken), storage, storage === this.storage);
    } else if (!existing) {
      // A B-seat capability must never be allowed to fill the first available
      // Room seat (which would silently turn B's owner into A).
      if (seat === "B" && !this.room?.players?.A) return { ok: false, error: "Ghế A chưa được khởi tạo" };
      result = await this.mutate((room) => room.addPlayer(connection, trustedName), storage, storage === this.storage);
      if (result?.ok && result.seat !== seat) return { ok: false, error: "Sai ghế được cấp quyền" };
    } else {
      return { ok: false, error: "Ghế đã được sử dụng" };
    }
    if (result?.ok) this.remember(connection);
    return result;
  }

  async reloadPersisted(): Promise<void> {
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
    const result = await this.mutate((room) => room.leavePlayer(connection));
    this.forget(connection);
    return result;
  }

  async close(connection: RoomConnection): Promise<any> {
    const result = await this.mutate((room) => room.disconnectPlayer(connection));
    this.forget(connection);
    return result;
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
