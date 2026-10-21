import {
  createCapabilityNonce,
  createSeatInvite,
  internalRequest,
  issueCapability,
} from "../auth/internal-auth.js";
import {
  createHumanTournament,
  registerParticipant,
  startTournament,
  assignMatchProvisioning,
  getParticipantMatchAccess,
  recordMatchResult,
  canAdvanceRound,
  advanceRound,
  getStandings,
  verifyOrganizer,
  TOURNAMENT_STATUS,
  MATCH_STATUS,
  MATCH_RESULT,
  type HumanTournamentAggregate,
  type MatchResult,
} from "../../../../packages/arena/src/domain/human-tournaments/human-tournament.mjs";
import type { Allocation } from "./ott-lobby-server.js";
import { cleanDisplayName } from "../../../../packages/game-core/src/names.js";

/** Tournament titles may be longer than player names; both are cleaned the same way. */
const TOURNAMENT_NAME_MAX = 32;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function cleanName(value: unknown, max?: number): string | null {
  return cleanDisplayName(value, max) || null;
}

export class TournamentCoordinator {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly env: Env,
    private readonly transaction: <T>(callback: (storage: DurableObjectTransaction) => Promise<T>) => Promise<T>,
    private readonly allocateAlias: (storage: DurableObjectStorage | DurableObjectTransaction, allocationId: string, roomId: string) => Promise<string>,
  ) {}

  async handleAction(action: string, body: Record<string, unknown>, _now: number): Promise<Response> {
    const normAction = action.replace(":", "-");

    if (normAction === "tournament-create") {
      const name = typeof body.name === "string" ? cleanName(body.name, TOURNAMENT_NAME_MAX) : null;
      const organizerName = typeof body.organizerName === "string" ? cleanName(body.organizerName) : null;
      const formatId = typeof body.formatId === "string" ? body.formatId.trim() : "swiss";
      const mapId = typeof body.mapId === "string" ? body.mapId.trim() : "classic";
      const requestedRounds = typeof body.requestedRounds === "number" && Number.isInteger(body.requestedRounds) && body.requestedRounds > 0 ? body.requestedRounds : undefined;

      if (!name || !organizerName) return json({ error: "invalid_request" }, 400);
      if (!["swiss", "single-round-robin", "double-round-robin"].includes(formatId)) return json({ error: "invalid_format" }, 400);
      if (mapId !== "classic") {
        return json({ error: "unsupported_map", message: "Only 'classic' map is currently supported for human tournaments" }, 400);
      }

      // Avoid UUID truncation to guarantee zero collision probability
      const tournamentId = `tourn-${crypto.randomUUID()}`;
      const organizerId = `org-${crypto.randomUUID()}`;

      const aggregate = await createHumanTournament({
        tournamentId,
        name,
        organizer: { organizerId, name: organizerName },
        formatId,
        mapId,
        requestedRounds,
      });
      const organizerSecret = aggregate._initialOrganizerSecret!;
      delete aggregate._initialOrganizerSecret;

      await this.storage.put(`tournament:${tournamentId}`, aggregate);
      return json({
        ok: true,
        tournamentId,
        organizerSecret,
        name,
        formatId,
      });
    }

    if (normAction === "tournament-register") {
      const tournamentId = typeof body.tournamentId === "string" ? body.tournamentId.trim() : "";
      const participantName = typeof body.name === "string" ? cleanName(body.name) : null;
      if (!tournamentId || !participantName) return json({ error: "invalid_request" }, 400);

      // CAS / Transaction on registration to prevent concurrent registration overwrite
      const casResult = await this.transaction(async (storage) => {
        const tournament = await storage.get<HumanTournamentAggregate>(`tournament:${tournamentId}`);
        if (!tournament) return { status: 404, data: { error: "tournament_not_found" } };
        if (tournament.status !== TOURNAMENT_STATUS.REGISTRATION) return { status: 409, data: { error: "registration_closed" } };
        if (tournament.participants.some((p) => p.name.toLowerCase() === participantName.toLowerCase())) {
          return { status: 409, data: { error: "participant_name_taken" } };
        }

        const participantId = `p_${crypto.randomUUID()}`;
        const registration = await registerParticipant(tournament, { participantId, name: participantName });
        await storage.put(`tournament:${tournamentId}`, tournament);
        return {
          status: 200,
          data: {
            ok: true,
            tournamentId,
            participantId,
            participantSecret: registration.participantSecret,
            name: participantName,
          },
        };
      });

      return json(casResult.data, casResult.status);
    }

    if (normAction === "tournament-start") {
      const tournamentId = typeof body.tournamentId === "string" ? body.tournamentId.trim() : "";
      const organizerSecret = typeof body.organizerSecret === "string" ? body.organizerSecret.trim() : "";
      if (!tournamentId || !organizerSecret) return json({ error: "invalid_request" }, 400);

      // CAS Phase 1: transactional state transition and verification
      const casResult = await this.transaction(async (storage) => {
        const tournament = await storage.get<HumanTournamentAggregate>(`tournament:${tournamentId}`);
        if (!tournament) return { status: 404, data: { error: "tournament_not_found" } };
        if (!(await verifyOrganizer(tournament, organizerSecret))) return { status: 401, data: { error: "unauthorized" } };

        const now = Date.now();
        // Check transactional persisted provisioning fence (lease)
        const fence = await storage.get<{ roundNumber: number; fenceToken: string; expiresAt: number }>(`provisioning-fence:${tournamentId}`);
        if (fence && fence.expiresAt > now) {
          return { status: 409, data: { error: "tournament_already_started" } };
        }

        if (tournament.status === TOURNAMENT_STATUS.IN_PROGRESS) {
          // Check if there are unprovisioned matches from a previous failed attempt (retryable failure)
          const round = tournament.rounds.find((r) => r.roundNumber === tournament.currentRoundNumber);
          const hasUnprovisioned = round?.matches.some((m) => m.status !== MATCH_STATUS.BYE && !!m.participantBId && !m.allocationId);
          if (!hasUnprovisioned) {
            return { status: 409, data: { error: "tournament_already_started" } };
          }
        } else if (tournament.status !== TOURNAMENT_STATUS.REGISTRATION) {
          return { status: 409, data: { error: "tournament_already_started" } };
        } else {
          if (tournament.participants.length < 2) return { status: 400, data: { error: "insufficient_participants" } };
          await startTournament(tournament, { organizerSecret });
          await storage.put(`tournament:${tournamentId}`, tournament);
        }

        const fenceToken = crypto.randomUUID();
        // Establish transactional persisted provisioning fence (30-second TTL prevents permanent deadlock)
        await storage.put(`provisioning-fence:${tournamentId}`, {
          roundNumber: tournament.currentRoundNumber,
          fenceToken,
          expiresAt: now + 30_000,
        });

        return { status: 200, tournament, fenceToken };
      });

      if (casResult.status !== 200) return json(casResult.data, casResult.status);

      // Provisioning Phase: validated game initialization without duplicate provisioning
      try {
        await this.provisionTournamentRoundMatches(casResult.tournament!, casResult.tournament!.currentRoundNumber, casResult.fenceToken);
      } catch (err: any) {
        console.warn("Tournament round provisioning failed:", err?.message || err);
        return json({ error: "authority_unavailable", message: "Failed to initialize tournament match game servers" }, 503);
      }

      return json({
        ok: true,
        tournamentId,
        status: casResult.tournament!.status,
        currentRoundNumber: casResult.tournament!.currentRoundNumber,
        roundCount: casResult.tournament!.roundCount,
      });
    }

    if (normAction === "tournament-get") {
      const tournamentId = typeof body.tournamentId === "string" ? body.tournamentId.trim() : "";
      if (!tournamentId) return json({ error: "invalid_request" }, 400);

      const getResult = await this.transaction(async (storage) => {
        const tournament = await storage.get<HumanTournamentAggregate>(`tournament:${tournamentId}`);
        if (!tournament) return { status: 404, data: { error: "tournament_not_found" } };

        const changed = await this.syncTournamentMatchesInternal(storage, tournament);
        if (changed) {
          await storage.put(`tournament:${tournamentId}`, tournament);
        }

        return { status: 200, tournament };
      });

      if (getResult.status !== 200) return json(getResult.data, getResult.status);
      const tournament = getResult.tournament!;

      const currentRound = tournament.rounds.find((r) => r.roundNumber === tournament.currentRoundNumber);
      const currentRoundMatches = currentRound
        ? currentRound.matches.map((m) => {
            const playerA = tournament.participants.find((p) => p.participantId === m.participantAId);
            const playerB = tournament.participants.find((p) => p.participantId === m.participantBId);
            return {
              matchId: m.matchId,
              roundNumber: m.roundNumber,
              scheduleIndex: m.scheduleIndex,
              participantA: { id: m.participantAId, name: playerA?.name ?? m.participantAId },
              participantB: m.participantBId ? { id: m.participantBId, name: playerB?.name ?? m.participantBId } : null,
              status: m.status,
              result: m.result,
              winnerParticipantId: m.winnerParticipantId,
              alias: m.alias,
              allocationId: m.allocationId,
            };
          })
        : [];

      return json({
        ok: true,
        tournament: {
          tournamentId: tournament.tournamentId,
          name: tournament.name,
          organizer: {
            organizerId: tournament.organizer.organizerId,
            name: tournament.organizer.name,
          },
          formatId: tournament.formatId,
          status: tournament.status,
          currentRoundNumber: tournament.currentRoundNumber,
          roundCount: tournament.roundCount,
          participantCount: tournament.participants.length,
          currentRoundMatches,
          standings: getStandings(tournament),
          completedAt: tournament.completedAt,
        },
      });
    }

    if (normAction === "tournament-access") {
      const tournamentId = typeof body.tournamentId === "string" ? body.tournamentId.trim() : "";
      const matchId = typeof body.matchId === "string" ? body.matchId.trim() : "";
      const participantId = typeof body.participantId === "string" ? body.participantId.trim() : "";
      const participantSecret = typeof body.participantSecret === "string" ? body.participantSecret.trim() : "";

      if (!tournamentId || !matchId || !participantId || !participantSecret) return json({ error: "invalid_request" }, 400);

      const tournament = await this.storage.get<HumanTournamentAggregate>(`tournament:${tournamentId}`);
      if (!tournament) return json({ error: "tournament_not_found" }, 404);

      try {
        const access = await getParticipantMatchAccess(tournament, matchId, participantId, participantSecret);
        const opponent = tournament.participants.find((p) => p.participantId === access.opponentId);
        return json({
          ok: true,
          matchId: access.matchId,
          roundNumber: access.roundNumber,
          seat: access.seat,
          allocationId: access.allocationId,
          alias: access.alias,
          inviteToken: access.inviteToken,
          opponentId: access.opponentId,
          opponentName: opponent?.name ?? null,
        });
      } catch (err: any) {
        return json({ error: err.message || "access_denied" }, 403);
      }
    }

    if (normAction === "tournament-sync-match") {
      const tournamentId = typeof body.tournamentId === "string" ? body.tournamentId.trim() : "";
      const matchId = typeof body.matchId === "string" ? body.matchId.trim() : "";
      if (!tournamentId || !matchId) return json({ error: "invalid_request" }, 400);

      const syncResult = await this.transaction(async (storage) => {
        const tournament = await storage.get<HumanTournamentAggregate>(`tournament:${tournamentId}`);
        if (!tournament) return { status: 404, data: { error: "tournament_not_found" } };

        const currentRound = tournament.rounds.find((r) => r.roundNumber === tournament.currentRoundNumber);
        const match = currentRound?.matches.find((m) => m.matchId === matchId);
        if (!match) return { status: 404, data: { error: "match_not_found" } };

        if (match.status === MATCH_STATUS.COMPLETED || match.status === MATCH_STATUS.BYE) {
          return {
            status: 200,
            data: {
              ok: true,
              match: { matchId: match.matchId, status: match.status, result: match.result, winnerParticipantId: match.winnerParticipantId },
              canAdvance: canAdvanceRound(tournament),
            },
          };
        }

        if (!match.allocationId) return { status: 400, data: { error: "match_not_provisioned" } };

        const outcome = await storage.get<{
          allocationId: string;
          roomId: string;
          reason: string;
          winner: string | null;
          completedAt: number;
        }>(`terminal-outcome:${match.allocationId}`);

        if (!outcome) {
          return { status: 409, data: { error: "match_not_completed" } };
        }

        let result: MatchResult = MATCH_RESULT.DRAW;
        let winnerParticipantId: string | null = null;
        if (outcome.winner === "A") {
          result = MATCH_RESULT.WIN_A;
          winnerParticipantId = match.participantAId;
        } else if (outcome.winner === "B") {
          result = MATCH_RESULT.WIN_B;
          winnerParticipantId = match.participantBId;
        }

        await recordMatchResult(tournament, {
          matchId: match.matchId,
          result,
          winnerParticipantId,
          skipOrganizerVerification: true,
        });

        // Purge single-use seat invites for completed match to prevent persistent unused invites in storage
        if (match.seatAInviteToken) await storage.delete(`seat-invite:${match.seatAInviteToken}`);
        if (match.seatBInviteToken) await storage.delete(`seat-invite:${match.seatBInviteToken}`);

        await storage.put(`tournament:${tournamentId}`, tournament);

        return {
          status: 200,
          data: {
            ok: true,
            match: { matchId: match.matchId, status: match.status, result: match.result, winnerParticipantId: match.winnerParticipantId },
            canAdvance: canAdvanceRound(tournament),
          },
        };
      });

      return json(syncResult.data, syncResult.status);
    }

    if (normAction === "tournament-advance") {
      const tournamentId = typeof body.tournamentId === "string" ? body.tournamentId.trim() : "";
      const organizerSecret = typeof body.organizerSecret === "string" ? body.organizerSecret.trim() : "";
      if (!tournamentId || !organizerSecret) return json({ error: "invalid_request" }, 400);

      // CAS Phase 1: transactional advance check, match sync, and transition
      const casResult = await this.transaction(async (storage) => {
        const tournament = await storage.get<HumanTournamentAggregate>(`tournament:${tournamentId}`);
        if (!tournament) return { status: 404, data: { error: "tournament_not_found" } };
        if (!(await verifyOrganizer(tournament, organizerSecret))) return { status: 401, data: { error: "unauthorized" } };

        if (tournament.status === TOURNAMENT_STATUS.COMPLETED) {
          return { status: 409, data: { error: "tournament_already_completed", message: "Tournament has already completed all rounds" } };
        }
        if (tournament.status !== TOURNAMENT_STATUS.IN_PROGRESS) {
          return { status: 409, data: { error: "tournament_not_in_progress", message: `Cannot advance tournament with status '${tournament.status}'` } };
        }
        const now = Date.now();
        // Check transactional persisted provisioning fence
        const fence = await storage.get<{ roundNumber: number; fenceToken: string; expiresAt: number }>(`provisioning-fence:${tournamentId}`);
        if (fence && fence.expiresAt > now) {
          return { status: 409, data: { error: "tournament_advance_in_progress" } };
        }

        // Always sync matches from transactional storage inside the transaction
        const changed = await this.syncTournamentMatchesInternal(storage, tournament);
        if (changed) {
          await storage.put(`tournament:${tournamentId}`, tournament);
        }

        const currentRound = tournament.rounds.find((r) => r.roundNumber === tournament.currentRoundNumber);
        const hasUnprovisioned = currentRound?.matches.some((m) => m.status !== MATCH_STATUS.BYE && !!m.participantBId && !m.allocationId);

        let advanceResult: { currentRoundNumber: number; tournamentCompleted: boolean };
        if (hasUnprovisioned) {
          // Retry provisioning for the current round matches that failed earlier
          advanceResult = { currentRoundNumber: tournament.currentRoundNumber, tournamentCompleted: false };
        } else {
          if (!canAdvanceRound(tournament)) {
            return { status: 409, data: { error: "round_matches_incomplete" } };
          }
          advanceResult = await advanceRound(tournament, { organizerSecret });
          await storage.put(`tournament:${tournamentId}`, tournament);
        }

        let fenceToken: string | undefined;
        if (!advanceResult.tournamentCompleted) {
          fenceToken = crypto.randomUUID();
          await storage.put(`provisioning-fence:${tournamentId}`, {
            roundNumber: advanceResult.currentRoundNumber,
            fenceToken,
            expiresAt: now + 30_000,
          });
        }

        return { status: 200, tournament, advanceResult, fenceToken };
      });

      if (casResult.status !== 200) return json(casResult.data, casResult.status);

      // Provisioning Phase: validated game init for next round if not completed
      if (!casResult.advanceResult!.tournamentCompleted) {
        try {
          await this.provisionTournamentRoundMatches(casResult.tournament!, casResult.advanceResult!.currentRoundNumber, casResult.fenceToken);
        } catch (err: any) {
          console.warn("Tournament advance provisioning failed:", err?.message || err);
          return json({ error: "authority_unavailable", message: "Failed to initialize next round match game servers" }, 503);
        }
      }

      return json({
        ok: true,
        tournamentId,
        currentRoundNumber: casResult.tournament!.currentRoundNumber,
        roundCount: casResult.tournament!.roundCount,
        tournamentCompleted: casResult.advanceResult!.tournamentCompleted,
      });
    }

    return json({ error: "invalid_request" }, 400);
  }

  async provisionTournamentRoundMatches(tournament: HumanTournamentAggregate, roundNumber: number, fenceToken?: string): Promise<void> {
    try {
      const round = tournament.rounds.find((r) => r.roundNumber === roundNumber);
      if (!round) return;

      for (const match of round.matches) {
        if (match.status === MATCH_STATUS.BYE || !match.participantBId) continue;
        // Idempotency: skip already successfully provisioned match allocations
        if (match.allocationId) continue;

        const playerA = tournament.participants.find((p) => p.participantId === match.participantAId);
        const playerB = tournament.participants.find((p) => p.participantId === match.participantBId);
        const nameA = playerA?.name ?? "Player A";
        const nameB = playerB?.name ?? "Player B";

        const id = crypto.randomUUID();
        const roomId = `ott-${id}`;
        const alias = await this.allocateAlias(this.storage, id, roomId);

        const inviteA = await createSeatInvite(this.storage as any, {
          allocationId: id,
          roomId,
          seat: "A",
          inviteeName: nameA,
        });

        const inviteB = await createSeatInvite(this.storage as any, {
          allocationId: id,
          roomId,
          seat: "B",
          inviteeName: nameB,
        });

        const now = Date.now();
        const allocation: Allocation = {
          id,
          roomId,
          alias,
          names: { A: nameA, B: nameB },
          seats: 2,
          status: "waiting",
          tournamentMatch: true,
          tournamentId: tournament.tournamentId,
          matchId: match.matchId,
          creatorAttachDeadlineMs: now + 3600_000,
        };
        await this.storage.put(`allocation:${id}`, allocation);

        // Validated Game Init: require 2xx from OttGameServer; rollback on failure
        const game = this.env.Main?.get(this.env.Main.idFromName(roomId));
        if (!game || !this.env.OTT_INTERNAL_SECRET) {
          await this.rollbackProvisioning(id, alias, [inviteA.inviteToken, inviteB.inviteToken]);
          throw new Error("authority_unavailable");
        }

        let initOk = false;
        try {
          const init = await issueCapability(this.env.OTT_INTERNAL_SECRET, {
            allocationId: id,
            roomId,
            purpose: "game-init",
            seat: "A",
          });
          const response = await game.fetch(internalRequest(this.env.OTT_INTERNAL_SECRET, "/internal/initialize", {
            allocationId: id,
            roomId,
            creatorName: nameA,
            creatorAttachDeadlineMs: allocation.creatorAttachDeadlineMs,
            capability: init,
          }));
          if (response.ok) {
            initOk = true;
          }
        } catch {
          initOk = false;
        }

        if (!initOk) {
          await this.rollbackProvisioning(id, alias, [inviteA.inviteToken, inviteB.inviteToken]);
          throw new Error("authority_unavailable");
        }

        let alreadyProvisioned = false;
        let leaseLost = false;
        await this.transaction(async (storage) => {
          if (fenceToken) {
            const currentFence = await storage.get<{ roundNumber: number; fenceToken: string; expiresAt: number }>(`provisioning-fence:${tournament.tournamentId}`);
            if (!currentFence || currentFence.fenceToken !== fenceToken || currentFence.expiresAt <= Date.now()) {
              leaseLost = true;
              return;
            }
          }
          const latest = await storage.get<HumanTournamentAggregate>(`tournament:${tournament.tournamentId}`);
          if (!latest) return;
          const currentRound = latest.rounds.find((r) => r.roundNumber === roundNumber);
          const currentMatch = currentRound?.matches.find((m) => m.matchId === match.matchId);
          if (!currentMatch) return;
          if (currentMatch.allocationId) {
            alreadyProvisioned = true;
            return;
          }
          assignMatchProvisioning(latest, match.matchId, {
            allocationId: id,
            alias,
            seatAInviteToken: inviteA.inviteToken,
            seatBInviteToken: inviteB.inviteToken,
          });
          await storage.put(`tournament:${tournament.tournamentId}`, latest);
          Object.assign(tournament, latest);
        });

        if (leaseLost || alreadyProvisioned) {
          await this.rollbackProvisioning(id, alias, [inviteA.inviteToken, inviteB.inviteToken]);
          if (leaseLost) {
            throw new Error("provisioning_lease_lost");
          }
        }
      }
    } finally {
      if (fenceToken) {
        await this.transaction(async (storage) => {
          const currentFence = await storage.get<{ fenceToken: string }>(`provisioning-fence:${tournament.tournamentId}`);
          if (currentFence && currentFence.fenceToken === fenceToken) {
            await storage.delete(`provisioning-fence:${tournament.tournamentId}`);
          }
        });
      } else {
        await this.storage.delete(`provisioning-fence:${tournament.tournamentId}`);
      }
    }
  }

  private async rollbackProvisioning(allocationId: string, alias: string, inviteTokens: string[]): Promise<void> {
    await this.storage.delete(`allocation:${allocationId}`);
    await this.storage.delete(`alias:${alias}`);
    await this.storage.delete(`allocation-alias:${allocationId}`);
    for (const token of inviteTokens) {
      await this.storage.delete(`seat-invite:${token}`);
    }
  }

  async syncTournamentMatchesInternal(
    storage: DurableObjectStorage | DurableObjectTransaction,
    tournament: HumanTournamentAggregate
  ): Promise<boolean> {
    const currentRound = tournament.rounds.find((r) => r.roundNumber === tournament.currentRoundNumber);
    if (!currentRound) return false;
    let changed = false;

    for (const match of currentRound.matches) {
      if (match.status === MATCH_STATUS.COMPLETED || match.status === MATCH_STATUS.BYE) continue;
      if (!match.allocationId) continue;

      const outcome = await storage.get<{
        allocationId: string;
        roomId: string;
        reason: string;
        winner: string | null;
        completedAt: number;
      }>(`terminal-outcome:${match.allocationId}`);

      if (outcome) {
        let result: MatchResult = MATCH_RESULT.DRAW;
        let winnerParticipantId: string | null = null;
        if (outcome.winner === "A") {
          result = MATCH_RESULT.WIN_A;
          winnerParticipantId = match.participantAId;
        } else if (outcome.winner === "B") {
          result = MATCH_RESULT.WIN_B;
          winnerParticipantId = match.participantBId;
        }
        await recordMatchResult(tournament, {
          matchId: match.matchId,
          result,
          winnerParticipantId,
          skipOrganizerVerification: true,
        });
        if (match.seatAInviteToken) await storage.delete(`seat-invite:${match.seatAInviteToken}`);
        if (match.seatBInviteToken) await storage.delete(`seat-invite:${match.seatBInviteToken}`);
        changed = true;
      }
    }
    return changed;
  }
}
