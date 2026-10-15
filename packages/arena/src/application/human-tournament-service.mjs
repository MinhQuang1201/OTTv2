/**
 * packages/arena/src/application/human-tournament-service.mjs
 *
 * Application service orchestrating human tournaments:
 * - Tournament lifecycle (registration, starting, round advancement, completion)
 * - Cryptographic bearer secrets for organizers and participants (identity cannot be client-claimed strings)
 * - Integration with Lobby DO / Gateway to provision online rooms with aliases and seat-specific cryptographic invite tokens
 * - Privacy: invitations and hash tokens strictly kept out of public snapshots and logs
 * - Authoritative match reporting and tie-break standings progression
 */

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
  TOURNAMENT_STATUS,
  MATCH_STATUS,
} from "../domain/human-tournaments/human-tournament.mjs";

export class HumanTournamentService {
  /**
   * @param {object} options
   * @param {Map<string, object>} [options.store] - Store for persisting tournament aggregates
   * @param {object} [options.lobbyGateway] - Optional lobby gateway for provisioning rooms and seat invites
   */
  constructor(options = {}) {
    this.store = options.store ?? new Map();
    this.lobbyGateway = options.lobbyGateway ?? null;
  }

  async createTournament(options) {
    const tournament = await createHumanTournament(options);
    const organizerSecret = tournament._initialOrganizerSecret;
    // Don't retain raw secret in stored aggregate
    delete tournament._initialOrganizerSecret;
    await this.store.set(tournament.tournamentId, tournament);
    return {
      tournament,
      organizerSecret,
    };
  }

  async getTournament(tournamentId) {
    const tournament = await this.store.get(tournamentId);
    if (!tournament) {
      throw new Error(`Tournament '${tournamentId}' not found`);
    }
    return tournament;
  }

  async registerPlayer(tournamentId, participant) {
    const tournament = await this.getTournament(tournamentId);
    const result = await registerParticipant(tournament, participant);
    await this.store.set(tournamentId, tournament);
    return {
      participant: result.participant,
      participantSecret: result.participantSecret,
    };
  }

  async startTournament(tournamentId, options = {}) {
    const tournament = await this.getTournament(tournamentId);
    await startTournament(tournament, options);

    // Provision rooms and cryptographic seat invites for Round 1 matches
    if (this.lobbyGateway) {
      await this.provisionRoundMatches(tournament, 1);
    }

    await this.store.set(tournamentId, tournament);
    return tournament;
  }

  async provisionRoundMatches(tournament, roundNumber) {
    const round = tournament.rounds.find((r) => r.roundNumber === roundNumber);
    if (!round || !this.lobbyGateway) return;

    for (const match of round.matches) {
      // Skip byes
      if (match.status === MATCH_STATUS.BYE || !match.participantBId) continue;

      const playerA = tournament.participants.find((p) => p.participantId === match.participantAId);
      const playerB = tournament.participants.find((p) => p.participantId === match.participantBId);

      try {
        const hostName = playerA?.name ?? "Player A";
        const allocation = await this.lobbyGateway.createRoom(hostName);
        const allocationId = allocation.allocationId;
        const alias = allocation.alias ?? null;

        const inviteB = await this.lobbyGateway.createSeatInvite(
          allocationId,
          "B",
          playerB?.name ?? "Player B"
        );

        const inviteA = await this.lobbyGateway.createSeatInvite(
          allocationId,
          "A",
          playerA?.name ?? "Player A"
        );

        assignMatchProvisioning(tournament, match.matchId, {
          allocationId,
          alias,
          seatAInviteToken: inviteA.inviteToken,
          seatBInviteToken: inviteB.inviteToken,
        });
      } catch (err) {
        console.warn(`Failed to provision room for match ${match.matchId}:`, err);
      }
    }
  }

  async getPlayerMatchAccess(tournamentId, matchId, participantId, participantSecret) {
    const tournament = await this.getTournament(tournamentId);
    const access = await getParticipantMatchAccess(tournament, matchId, participantId, participantSecret);
    const opponent = tournament.participants.find((p) => p.participantId === access.opponentId);

    return {
      ...access,
      opponentName: opponent?.name ?? null,
    };
  }

  async recordResult(tournamentId, options) {
    const tournament = await this.getTournament(tournamentId);
    const match = await recordMatchResult(tournament, options);
    await this.store.set(tournamentId, tournament);
    return {
      match,
      canAdvance: canAdvanceRound(tournament),
    };
  }

  async advanceRound(tournamentId, options = {}) {
    const tournament = await this.getTournament(tournamentId);
    const result = await advanceRound(tournament, options);

    if (!result.tournamentCompleted && this.lobbyGateway) {
      await this.provisionRoundMatches(tournament, result.currentRoundNumber);
    }

    await this.store.set(tournamentId, tournament);
    return result;
  }

  async getTournamentDetails(tournamentId) {
    const tournament = await this.getTournament(tournamentId);
    const currentRound = tournament.rounds.find((r) => r.roundNumber === tournament.currentRoundNumber);

    // Public sanitized matches: NEVER leaks invite tokens or secrets
    const publicMatches = currentRound
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

    return {
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
      currentRoundMatches: publicMatches,
      standings: getStandings(tournament),
      completedAt: tournament.completedAt,
    };
  }
}
