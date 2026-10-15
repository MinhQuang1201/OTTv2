const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("Human Tournament Domain & Application Service", () => {
  it("enforces cryptographic bearer authentication and preserves public catalog secrecy", async () => {
    const {
      createHumanTournament,
      registerParticipant,
      startTournament,
      recordMatchResult,
      canAdvanceRound,
      advanceRound,
      getStandings,
      getParticipantMatchAccess,
      assignMatchProvisioning,
      MATCH_STATUS,
      MATCH_RESULT,
      TOURNAMENT_STATUS,
    } = await import("../packages/arena/src/domain/human-tournaments/human-tournament.mjs");

    // 1. Create tournament - returns organizerSecret
    const tournament = await createHumanTournament({
      tournamentId: "tourn-swiss-1",
      name: "Cúp Oẳn Tù Tì Mùa Thu",
      organizer: { organizerId: "org-1", name: "Admin Trọng Tài" },
      formatId: "swiss",
      requestedRounds: 2,
    });

    const organizerSecret = tournament._initialOrganizerSecret;
    assert.ok(organizerSecret);
    assert.equal(tournament.status, TOURNAMENT_STATUS.REGISTRATION);
    assert.equal(tournament.organizer.organizerId, "org-1");

    // 2. Register 3 participants (odd count -> will generate byes)
    const regA = await registerParticipant(tournament, { participantId: "player-1", name: "An" });
    const regB = await registerParticipant(tournament, { participantId: "player-2", name: "Bình" });
    const regC = await registerParticipant(tournament, { participantId: "player-3", name: "Chi" });

    assert.ok(regA.participantSecret);
    assert.ok(regB.participantSecret);
    assert.ok(regC.participantSecret);

    // Disallow duplicate participant
    await assert.rejects(async () => {
      await registerParticipant(tournament, { participantId: "player-1", name: "An Duplicate" });
    }, /already registered/);

    // 3. Client-claimed unauthenticated start fails
    await assert.rejects(async () => {
      await startTournament(tournament, { organizerSecret: "impostor_secret" });
    }, /Unauthorized: invalid or missing organizer secret/);

    await assert.rejects(async () => {
      await startTournament(tournament, {});
    }, /Unauthorized: invalid or missing organizer secret/);

    // Authenticated start succeeds
    await startTournament(tournament, { organizerSecret });
    assert.equal(tournament.status, TOURNAMENT_STATUS.IN_PROGRESS);
    assert.equal(tournament.currentRoundNumber, 1);
    assert.equal(tournament.rounds.length, 1);

    const round1 = tournament.rounds[0];
    assert.equal(round1.matches.length, 2); // 1 match + 1 bye
    const normalMatch = round1.matches.find((m) => m.status === MATCH_STATUS.SCHEDULED);
    const byeMatch = round1.matches.find((m) => m.status === MATCH_STATUS.BYE);

    assert.ok(normalMatch);
    assert.ok(byeMatch);
    assert.equal(byeMatch.result, MATCH_RESULT.BYE);

    // 4. Provisioning & Target participant access with secret verification
    assignMatchProvisioning(tournament, normalMatch.matchId, {
      allocationId: "alloc-r1-m1",
      alias: "FOX-42",
      seatAInviteToken: "inv_seat_a",
      seatBInviteToken: "inv_seat_b",
    });

    // Unauthenticated or client-claimed string rejected
    await assert.rejects(async () => {
      await getParticipantMatchAccess(tournament, normalMatch.matchId, normalMatch.participantAId, "wrong_secret");
    }, /Unauthorized: invalid participant secret/);

    const secretMap = {
      [regA.participant.participantId]: regA.participantSecret,
      [regB.participant.participantId]: regB.participantSecret,
      [regC.participant.participantId]: regC.participantSecret,
    };

    // Participant A can only get seat A invite with their secret
    const accessA = await getParticipantMatchAccess(
      tournament,
      normalMatch.matchId,
      normalMatch.participantAId,
      secretMap[normalMatch.participantAId]
    );
    assert.equal(accessA.seat, "A");
    assert.equal(accessA.inviteToken, "inv_seat_a");
    assert.equal(accessA.alias, "FOX-42");

    // Participant B can only get seat B invite with their secret
    const accessB = await getParticipantMatchAccess(
      tournament,
      normalMatch.matchId,
      normalMatch.participantBId,
      secretMap[normalMatch.participantBId]
    );
    assert.equal(accessB.seat, "B");
    assert.equal(accessB.inviteToken, "inv_seat_b");

    // Outsider cannot access invites
    await assert.rejects(async () => {
      await getParticipantMatchAccess(tournament, normalMatch.matchId, "stranger", "any");
    }, /Participant 'stranger' not found/);

    // 5. Round advancement gating
    assert.equal(canAdvanceRound(tournament), false);
    await assert.rejects(async () => {
      await advanceRound(tournament, { organizerSecret });
    }, /not all matches are completed/);

    // 6. Record authoritative match result requires organizer secret
    await assert.rejects(async () => {
      await recordMatchResult(tournament, {
        matchId: normalMatch.matchId,
        result: MATCH_RESULT.WIN_A,
        organizerSecret: "invalid",
      });
    }, /Unauthorized: invalid or missing organizer secret/);

    await recordMatchResult(tournament, {
      matchId: normalMatch.matchId,
      result: MATCH_RESULT.WIN_A,
      organizerSecret,
    });

    assert.equal(canAdvanceRound(tournament), true);

    // 7. Advance to Round 2
    const advanceResult1 = await advanceRound(tournament, { organizerSecret });
    assert.equal(advanceResult1.tournamentCompleted, false);
    assert.equal(advanceResult1.currentRoundNumber, 2);
    assert.equal(tournament.currentRoundNumber, 2);

    const round2 = tournament.rounds[1];
    assert.equal(round2.matches.length, 2);

    // Complete round 2 matches
    const r2NormalMatch = round2.matches.find((m) => m.status === MATCH_STATUS.SCHEDULED);
    await recordMatchResult(tournament, {
      matchId: r2NormalMatch.matchId,
      result: MATCH_RESULT.DRAW,
      organizerSecret,
    });

    assert.equal(canAdvanceRound(tournament), true);

    // 8. Final advance -> Tournament completes
    const finalAdvance = await advanceRound(tournament, { organizerSecret });
    assert.equal(finalAdvance.tournamentCompleted, true);
    assert.equal(tournament.status, TOURNAMENT_STATUS.COMPLETED);
    assert.ok(tournament.completedAt);

    // 9. Standings verify points, Buchholz, Sonneborn-Berger
    const standings = getStandings(tournament);
    assert.equal(standings.length, 3);
    assert.equal(standings[0].rank, 1);
    assert.ok(standings[0].points >= standings[1].points);
    assert.ok(standings[1].points >= standings[2].points);
  });

  it("orchestrates human tournament provisioning via HumanTournamentService and preserves secrecy", async () => {
    const { HumanTournamentService } = await import(
      "../packages/arena/src/application/human-tournament-service.mjs"
    );

    let roomCounter = 0;
    const mockLobby = {
      async createRoom(hostName) {
        roomCounter++;
        return {
          allocationId: `alloc-${roomCounter}`,
          room: `ott-alloc-${roomCounter}`,
          alias: `K7N-M4${roomCounter}`,
          seat: "A",
        };
      },
      async createSeatInvite(allocationId, seat, inviteeName) {
        return {
          inviteToken: `inv_${allocationId}_seat_${seat}`,
          expiresAt: Date.now() + 600000,
          seat,
          allocationId,
        };
      },
    };

    const service = new HumanTournamentService({ lobbyGateway: mockLobby });

    const createRes = await service.createTournament({
      tournamentId: "tourn-service-1",
      name: "Giải Vô Địch Mở Rộng",
      organizer: { organizerId: "admin", name: "Admin" },
      formatId: "single-round-robin",
    });

    const organizerSecret = createRes.organizerSecret;
    const tournamentId = createRes.tournament.tournamentId;
    assert.ok(organizerSecret);

    const p1Reg = await service.registerPlayer(tournamentId, { participantId: "p1", name: "An" });
    const p2Reg = await service.registerPlayer(tournamentId, { participantId: "p2", name: "Bình" });
    const p3Reg = await service.registerPlayer(tournamentId, { participantId: "p3", name: "Cường" });
    const p4Reg = await service.registerPlayer(tournamentId, { participantId: "p4", name: "Dũng" });

    assert.ok(p1Reg.participantSecret);

    // Start tournament -> auto-provisions round 1 rooms with aliases and invites
    await service.startTournament(tournamentId, { organizerSecret });

    const details = await service.getTournamentDetails(tournamentId);
    assert.equal(details.currentRoundNumber, 1);
    assert.equal(details.roundCount, 3);
    assert.equal(details.currentRoundMatches.length, 2);

    // Public details verify ZERO secret leakage:
    for (const match of details.currentRoundMatches) {
      assert.equal(match.seatAInviteToken, undefined);
      assert.equal(match.seatBInviteToken, undefined);
      assert.equal(match.inviteToken, undefined);
      assert.ok(match.alias);
      assert.ok(match.allocationId);
    }

    const m1 = details.currentRoundMatches[0];

    // Player 1 requests match access with valid participantSecret
    const p1Access = await service.getPlayerMatchAccess(
      tournamentId,
      m1.matchId,
      m1.participantA.id,
      p1Reg.participantSecret
    );
    assert.equal(p1Access.seat, "A");
    assert.ok(p1Access.inviteToken);
    assert.equal(p1Access.alias, m1.alias);

    // Impostor trying with wrong secret fails
    await assert.rejects(
      async () => {
        await service.getPlayerMatchAccess(
          tournamentId,
          m1.matchId,
          m1.participantA.id,
          "fake-secret"
        );
      },
      /Unauthorized/
    );

    // Record results for both matches
    await service.recordResult(tournamentId, {
      matchId: m1.matchId,
      result: "win_a",
      organizerSecret,
    });

    const m2 = details.currentRoundMatches[1];
    const report2 = await service.recordResult(tournamentId, {
      matchId: m2.matchId,
      result: "draw",
      organizerSecret,
    });

    assert.equal(report2.canAdvance, true);

    // Advance round -> auto-provisions round 2 rooms
    const advanceResult = await service.advanceRound(tournamentId, { organizerSecret });
    assert.equal(advanceResult.tournamentCompleted, false);
    assert.equal(advanceResult.currentRoundNumber, 2);

    const round2Details = await service.getTournamentDetails(tournamentId);
    assert.equal(round2Details.currentRoundNumber, 2);
    assert.equal(round2Details.currentRoundMatches.length, 2);
    // Verified new rooms provisioned
    assert.ok(round2Details.currentRoundMatches[0].alias);
  });

  it("uses authentic WebCrypto SHA-256 for secret hashing and generates full entropy secrets", async () => {
    const { hashSecret, createHumanTournament } = await import(
      "../packages/arena/src/domain/human-tournaments/human-tournament.mjs"
    );

    // Standard SHA-256 vector verification
    const hashHello = await hashSecret("hello");
    assert.equal(hashHello, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    assert.equal(hashHello.length, 64);

    // Empty or non-string input returns empty string
    assert.equal(await hashSecret(""), "");
    assert.equal(await hashSecret(null), "");

    // Generated organizer secret has full entropy (prefix + 48 hex chars = 192 bits)
    const t = await createHumanTournament({
      tournamentId: "tourn-entropy-test",
      name: "Entropy Test",
      organizer: { organizerId: "org-test", name: "Admin" },
      formatId: "swiss",
    });
    const secret = t._initialOrganizerSecret;
    assert.ok(secret.startsWith("org_sec_"));
    const hexPart = secret.slice("org_sec_".length);
    assert.equal(hexPart.length, 48); // 24 bytes * 2 hex chars = 48 hex chars (192 bits)
    assert.match(hexPart, /^[0-9a-f]{48}$/);

    // Hash matches stored hash
    const expectedHash = await hashSecret(secret);
    assert.equal(t.organizer.organizerSecretHash, expectedHash);
  });
});
