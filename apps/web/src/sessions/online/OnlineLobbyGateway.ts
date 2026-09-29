import type { PublicMatchView, WaitingRoomView } from "../../shared/model/game";
import { createControlRequest, type ControlRequestOptions } from "./controlRequest";
import type { PlayhtmlAllocation, PlayhtmlSpectatorAllocation } from "./globals";

export type OnlineGatewayError = Error & { readonly code?: string; readonly status?: number };

export interface OnlineLobbyGatewayOptions extends ControlRequestOptions {
  readonly control?: ReturnType<typeof createControlRequest>;
}

export interface OnlineLobbyResult {
  readonly available: boolean;
  readonly rooms: readonly WaitingRoomView[];
}

function unavailableError(): OnlineGatewayError {
  return Object.assign(new Error("Online hiện không khả dụng."), { code: "online_unavailable" });
}

function normalizeRoom(value: unknown): WaitingRoomView | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const roomId = typeof item.id === "string" ? item.id : typeof item.roomId === "string" ? item.roomId : "";
  const names = item.names && typeof item.names === "object" ? item.names as Record<string, unknown> : {};
  const playerCount = Number.isInteger(item.players) ? item.players as number : Number.isInteger(item.playerCount) ? item.playerCount as number : 0;
  if (!roomId || playerCount < 0) return null;
  return Object.freeze({
    roomId,
    hostName: typeof names.A === "string" ? names.A : typeof item.hostName === "string" ? item.hostName : "Người chơi",
    playerCount,
    maxPlayers: 2,
  });
}

function validateAllocation(value: unknown): PlayhtmlAllocation {
  if (!value || typeof value !== "object") throw unavailableError();
  const allocation = value as Record<string, unknown>;
  if (typeof allocation.allocationId !== "string" || typeof allocation.room !== "string" || typeof allocation.ticket !== "string" || typeof allocation.resumeCredential !== "string" || (allocation.seat !== "A" && allocation.seat !== "B")) throw unavailableError();
  return allocation as unknown as PlayhtmlAllocation;
}

function validateSpectatorAllocation(value: unknown): PlayhtmlSpectatorAllocation {
  if (!value || typeof value !== "object") throw unavailableError();
  const allocation = value as Record<string, unknown>;
  if (typeof allocation.allocationId !== "string" || typeof allocation.room !== "string" || typeof allocation.ticket !== "string") throw unavailableError();
  return allocation as unknown as PlayhtmlSpectatorAllocation;
}

export class OnlineLobbyGateway {
  private readonly control: ReturnType<typeof createControlRequest> | null;

  constructor(options: OnlineLobbyGatewayOptions = {}) {
    this.control = options.control ?? (options.endpoint || globalThis.OTT_PLAYHTML_CONTROL_ENDPOINT ? createControlRequest(options) : null);
  }

  get available(): boolean { return this.control !== null; }

  async listRooms(): Promise<OnlineLobbyResult> {
    if (!this.control) throw unavailableError();
    const payload = await this.control<{ rooms?: unknown[] }>("list", {});
    const rooms = Array.isArray(payload?.rooms) ? payload.rooms.map(normalizeRoom).filter((room): room is WaitingRoomView => room !== null) : [];
    return { available: true, rooms };
  }

  async createRoom(playerName: string): Promise<PlayhtmlAllocation> {
    if (!this.control) throw unavailableError();
    return validateAllocation(await this.control("create", { name: playerName.trim() }));
  }

  async joinRoom(playerName: string, roomId: string): Promise<PlayhtmlAllocation> {
    if (!this.control) throw unavailableError();
    return validateAllocation(await this.control("join", { name: playerName.trim(), allocationId: roomId.trim() }));
  }

  /**
   * Diagnostic / test control endpoint for querying active matches.
   *
   * Note on production architecture:
   * Production active-match discovery is designed to use a single-provider stream connection
   * (OttLobbyStreamServer). It is NOT integrated into the App lobby because the Task 7 upstream
   * runtime gate remains BLOCKED.
   *
   * This control endpoint must NOT be polled by the App shell or UI components, as doing so
   * would violate the single-provider lifecycle and state authority rules.
   */
  async listActiveMatches(): Promise<readonly PublicMatchView[]> {
    if (!this.control) throw unavailableError();
    const payload = await this.control<{ matches?: unknown[] }>("active", {});
    return Array.isArray(payload?.matches) ? (payload.matches as PublicMatchView[]) : [];
  }

  async getSpectatorTicket(allocationId: string): Promise<PlayhtmlSpectatorAllocation> {
    if (!this.control) throw unavailableError();
    return validateSpectatorAllocation(await this.control("spectate", { allocationId: allocationId.trim() }));
  }
}
