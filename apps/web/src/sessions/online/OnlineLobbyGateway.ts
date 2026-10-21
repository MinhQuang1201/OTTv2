import type { PublicMatchView, WaitingRoomView } from "../../shared/model/game";
import type { HumanTournamentSummary } from "../../features/tournaments/types";
import { createControlRequest, type ControlRequestOptions } from "./controlRequest";
import type { PlayhtmlAllocation, PlayhtmlSpectatorAllocation } from "./globals";
import { normalizeRoomCode } from "./roomCode";

export type OnlineGatewayError = Error & { readonly code?: string; readonly status?: number };

export interface ClaimSeatInviteOptions {
  readonly claimId?: string;
  readonly resumeCredential?: string;
}

const MAX_PENDING_CLAIM_PROOFS = 100;
const PENDING_CLAIM_PROOF_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface PendingClaimProof {
  readonly claimId: string;
  readonly createdAt: number;
}

function generateSecureClaimId(): string {
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    throw new Error("Secure random generator is not available");
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

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
  private readonly pendingClaimProofs = new Map<string, PendingClaimProof>();

  constructor(options: OnlineLobbyGatewayOptions = {}) {
    this.control = options.control ?? (options.endpoint || globalThis.OTT_PLAYHTML_CONTROL_ENDPOINT ? createControlRequest(options) : null);
  }

  get available(): boolean { return this.control !== null; }

  private getOrCreateClaimProof(inviteToken: string, now: number = Date.now()): string {
    const existing = this.pendingClaimProofs.get(inviteToken);
    if (existing && (now - existing.createdAt < PENDING_CLAIM_PROOF_TTL_MS)) {
      return existing.claimId;
    }

    if (this.pendingClaimProofs.size >= MAX_PENDING_CLAIM_PROOFS) {
      for (const [key, proof] of this.pendingClaimProofs.entries()) {
        if (now - proof.createdAt >= PENDING_CLAIM_PROOF_TTL_MS) {
          this.pendingClaimProofs.delete(key);
        }
      }
      if (this.pendingClaimProofs.size >= MAX_PENDING_CLAIM_PROOFS) {
        const oldestKey = this.pendingClaimProofs.keys().next().value;
        if (oldestKey !== undefined) {
          this.pendingClaimProofs.delete(oldestKey);
        }
      }
    }

    const claimId = generateSecureClaimId();
    this.pendingClaimProofs.set(inviteToken, { claimId, createdAt: now });
    return claimId;
  }

  private clearClaimProof(inviteToken: string): void {
    this.pendingClaimProofs.delete(inviteToken);
  }

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
    return validateAllocation(await this.control("join", { name: playerName.trim(), allocationId: normalizeRoomCode(roomId) }));
  }

  async resumeRoom(allocationId: string, resumeCredential: string): Promise<PlayhtmlAllocation> {
    if (!this.control) throw unavailableError();
    return validateAllocation(await this.control("resume", {
      allocationId: allocationId.trim(),
      resumeCredential: resumeCredential.trim(),
    }));
  }

  async controlRequest<T = unknown>(action: string, body: unknown = {}): Promise<T> {
    if (!this.control) throw unavailableError();
    return this.control<T>(action, body);
  }

  async resolveAlias(alias: string): Promise<{ allocationId: string; roomId: string; status: string; alias: string }> {
    if (!this.control) throw unavailableError();
    const payload = await this.control<{ allocationId?: string; roomId?: string; status?: string; alias?: string }>("resolve-alias", { alias: alias.trim() });
    if (!payload || typeof payload.allocationId !== "string") throw unavailableError();
    return {
      allocationId: payload.allocationId,
      roomId: payload.roomId ?? `ott-${payload.allocationId}`,
      status: payload.status ?? "open",
      alias: payload.alias ?? alias.trim(),
    };
  }

  async createSeatInvite(
    allocationId: string,
    seat: "A" | "B",
    inviteeName?: string,
    ownerCredential?: string,
  ): Promise<{ inviteToken: string; expiresAt: number; seat: "A" | "B"; allocationId: string }> {
    if (!this.control) throw unavailableError();
    const body: Record<string, string> = {
      allocationId: allocationId.trim(),
      seat,
    };
    if (inviteeName?.trim()) {
      body.inviteeName = inviteeName.trim();
    }
    if (ownerCredential?.trim()) {
      body.ownerCredential = ownerCredential.trim();
    }
    const payload = await this.control<{ inviteToken?: string; expiresAt?: number; seat?: "A" | "B"; allocationId?: string }>("create-invite", body);
    if (!payload || typeof payload.inviteToken !== "string") throw unavailableError();
    return {
      inviteToken: payload.inviteToken,
      expiresAt: payload.expiresAt ?? 0,
      seat: payload.seat ?? seat,
      allocationId: payload.allocationId ?? allocationId.trim(),
    };
  }

  async claimSeatInvite(
    inviteToken: string,
    playerName: string,
    options?: ClaimSeatInviteOptions,
  ): Promise<PlayhtmlAllocation> {
    if (!this.control) throw unavailableError();
    const token = inviteToken.trim();
    const name = playerName.trim();
    const effectiveClaimId = options?.claimId?.trim() || this.getOrCreateClaimProof(token);

    const body: Record<string, string> = {
      inviteToken: token,
      name,
      claimId: effectiveClaimId,
    };
    if (options?.resumeCredential?.trim()) {
      body.resumeCredential = options.resumeCredential.trim();
    }

    try {
      const result = validateAllocation(await this.control("claim-invite", body));
      this.clearClaimProof(token);
      return result;
    } catch (err: unknown) {
      const status = typeof (err as { status?: unknown })?.status === "number"
        ? (err as { status: number }).status
        : undefined;

      // Terminal client failure (4xx): clear proof so future claims can generate a fresh proof
      if (status !== undefined && status >= 400 && status < 500) {
        this.clearClaimProof(token);
      }
      // Transient failure (503 / >=500 / network error with undefined status):
      // Retain pending proof for explicit retry.
      throw err;
    }
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

  async createTournament(options: {
    name: string;
    organizerName: string;
    formatId: string;
    requestedRounds?: number;
    mapId?: string;
  }): Promise<{ tournamentId: string; organizerSecret: string; name: string; formatId: string }> {
    if (!this.control) throw unavailableError();
    const payload = await this.control<{ ok?: boolean; tournamentId?: string; organizerSecret?: string; name?: string; formatId?: string }>("tournament-create", options);
    if (!payload || !payload.tournamentId || !payload.organizerSecret) throw unavailableError();
    return {
      tournamentId: payload.tournamentId,
      organizerSecret: payload.organizerSecret,
      name: payload.name ?? options.name,
      formatId: payload.formatId ?? options.formatId,
    };
  }

  async registerTournamentPlayer(options: {
    tournamentId: string;
    name: string;
  }): Promise<{ tournamentId: string; participantId: string; participantSecret: string; name: string }> {
    if (!this.control) throw unavailableError();
    const payload = await this.control<{ ok?: boolean; tournamentId?: string; participantId?: string; participantSecret?: string; name?: string }>("tournament-register", options);
    if (!payload || !payload.participantId || !payload.participantSecret) throw unavailableError();
    return {
      tournamentId: payload.tournamentId ?? options.tournamentId,
      participantId: payload.participantId,
      participantSecret: payload.participantSecret,
      name: payload.name ?? options.name,
    };
  }

  async startTournament(options: {
    tournamentId: string;
    organizerSecret: string;
  }): Promise<{ tournamentId: string; status: string; currentRoundNumber: number; roundCount: number }> {
    if (!this.control) throw unavailableError();
    const payload = await this.control<{ ok?: boolean; tournamentId?: string; status?: string; currentRoundNumber?: number; roundCount?: number }>("tournament-start", options);
    if (!payload || !payload.tournamentId) throw unavailableError();
    return {
      tournamentId: payload.tournamentId,
      status: payload.status ?? "in_progress",
      currentRoundNumber: payload.currentRoundNumber ?? 1,
      roundCount: payload.roundCount ?? 0,
    };
  }

  async getTournamentDetails(tournamentId: string): Promise<HumanTournamentSummary> {
    if (!this.control) throw unavailableError();
    const payload = await this.control<{ ok?: boolean; tournament?: HumanTournamentSummary }>("tournament-get", { tournamentId: tournamentId.trim() });
    if (!payload || !payload.tournament) throw unavailableError();
    return payload.tournament;
  }

  async getTournamentMatchAccess(options: {
    tournamentId: string;
    matchId: string;
    participantId: string;
    participantSecret: string;
  }): Promise<{
    matchId: string;
    roundNumber: number;
    seat: "A" | "B";
    allocationId: string;
    alias: string | null;
    inviteToken: string;
    opponentId: string | null;
    opponentName: string | null;
  }> {
    if (!this.control) throw unavailableError();
    const payload = await this.control<{
      ok?: boolean;
      matchId?: string;
      roundNumber?: number;
      seat?: "A" | "B";
      allocationId?: string;
      alias?: string | null;
      inviteToken?: string;
      opponentId?: string | null;
      opponentName?: string | null;
    }>("tournament-access", options);
    if (!payload || !payload.inviteToken || !payload.allocationId) throw unavailableError();
    return {
      matchId: payload.matchId ?? options.matchId,
      roundNumber: payload.roundNumber ?? 1,
      seat: payload.seat ?? "A",
      allocationId: payload.allocationId,
      alias: payload.alias ?? null,
      inviteToken: payload.inviteToken,
      opponentId: payload.opponentId ?? null,
      opponentName: payload.opponentName ?? null,
    };
  }

  async syncTournamentMatch(options: {
    tournamentId: string;
    matchId: string;
  }): Promise<{
    match: { matchId: string; status: string; result: string | null; winnerParticipantId: string | null };
    canAdvance: boolean;
  }> {
    if (!this.control) throw unavailableError();
    const payload = await this.control<{
      ok?: boolean;
      match?: { matchId: string; status: string; result: string | null; winnerParticipantId: string | null };
      canAdvance?: boolean;
    }>("tournament-sync-match", options);
    if (!payload || !payload.match) throw unavailableError();
    return {
      match: payload.match,
      canAdvance: Boolean(payload.canAdvance),
    };
  }

  async advanceTournamentRound(options: {
    tournamentId: string;
    organizerSecret: string;
  }): Promise<{
    tournamentId: string;
    currentRoundNumber: number;
    roundCount: number;
    tournamentCompleted: boolean;
  }> {
    if (!this.control) throw unavailableError();
    const payload = await this.control<{
      ok?: boolean;
      tournamentId?: string;
      currentRoundNumber?: number;
      roundCount?: number;
      tournamentCompleted?: boolean;
    }>("tournament-advance", options);
    if (!payload || !payload.tournamentId) throw unavailableError();
    return {
      tournamentId: payload.tournamentId,
      currentRoundNumber: payload.currentRoundNumber ?? 1,
      roundCount: payload.roundCount ?? 0,
      tournamentCompleted: Boolean(payload.tournamentCompleted),
    };
  }
}
