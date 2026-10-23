import { describe, expect, it, vi } from "vitest";
import { OnlineLobbyGateway } from "./OnlineLobbyGateway";

describe("OnlineLobbyGateway", () => {
  it("uses control requests for public rooms and allocation commands", async () => {
    const control = vi.fn()
      .mockResolvedValueOnce({ rooms: [{ id: "room-a", alias: "K7N-M4P", names: { A: "An" }, players: 1 }, { roomId: "room-b", hostName: "Bình", playerCount: 2 }] })
      .mockResolvedValueOnce({ allocationId: "allocation-a", room: "room-a", seat: "A", ticket: "ticket", resumeCredential: "resume" })
      .mockResolvedValueOnce({ allocationId: "allocation-b", room: "room-b", seat: "B", ticket: "ticket", resumeCredential: "resume" });
    const gateway = new OnlineLobbyGateway({ control });

    await expect(gateway.listRooms()).resolves.toEqual({ available: true, rooms: [
      { roomId: "room-a", alias: "K7N-M4P", hostName: "An", playerCount: 1, maxPlayers: 2 },
      { roomId: "room-b", alias: null, hostName: "Bình", playerCount: 2, maxPlayers: 2 },
    ] });
    await expect(gateway.createRoom(" An ")).resolves.toMatchObject({ room: "room-a", seat: "A" });
    await expect(gateway.joinRoom(" Bình ", " room-b ")).resolves.toMatchObject({ room: "room-b", seat: "B" });
    expect(control.mock.calls).toEqual([
      ["list", {}],
      ["create", { name: "An" }],
      ["join", { name: "Bình", allocationId: "room-b" }],
    ]);
  });

  it("lists active matches and requests spectator tickets", async () => {
    const sampleMatch = {
      allocationId: "alloc-1",
      roomId: "ott-alloc-1",
      status: "playing",
      players: {
        A: { seat: "A", name: "An", connected: true, remainingMs: 60000 },
        B: { seat: "B", name: "Bình", connected: true, remainingMs: 60000 },
      },
      spectatorCount: 2,
      serverNow: 1000,
      runningSeat: "A",
    };
    const control = vi.fn()
      .mockResolvedValueOnce({ matches: [sampleMatch] })
      .mockResolvedValueOnce({ allocationId: "alloc-1", room: "ott-alloc-1", ticket: "spec-ticket" });
    const gateway = new OnlineLobbyGateway({ control });

    await expect(gateway.listActiveMatches()).resolves.toEqual([sampleMatch]);
    await expect(gateway.getSpectatorTicket(" alloc-1 ")).resolves.toEqual({
      allocationId: "alloc-1",
      room: "ott-alloc-1",
      ticket: "spec-ticket",
    });
    expect(control.mock.calls).toEqual([
      ["active", {}],
      ["spectate", { allocationId: "alloc-1" }],
    ]);
  });

  it("resolves short aliases and creates/claims seat-specific invites with claim proof", async () => {
    const control = vi.fn()
      .mockResolvedValueOnce({ allocationId: "alloc-42", roomId: "ott-alloc-42", status: "waiting", alias: "K7N-M4P" })
      .mockResolvedValueOnce({ inviteToken: "inv_12345", expiresAt: 1800000000000, seat: "B", allocationId: "alloc-42" })
      .mockResolvedValueOnce({ allocationId: "alloc-42", room: "ott-alloc-42", seat: "B", ticket: "claimed-ticket", resumeCredential: "resume-cred" });
    const gateway = new OnlineLobbyGateway({ control });

    await expect(gateway.resolveAlias(" k7n-m4p ")).resolves.toEqual({
      allocationId: "alloc-42",
      roomId: "ott-alloc-42",
      status: "waiting",
      alias: "K7N-M4P",
    });

    await expect(gateway.createSeatInvite(" alloc-42 ", "B", " Chi ", " owner-cred-123 ")).resolves.toEqual({
      inviteToken: "inv_12345",
      expiresAt: 1800000000000,
      seat: "B",
      allocationId: "alloc-42",
    });

    await expect(gateway.claimSeatInvite(" inv_12345 ", " Chi ")).resolves.toEqual({
      allocationId: "alloc-42",
      room: "ott-alloc-42",
      seat: "B",
      ticket: "claimed-ticket",
      resumeCredential: "resume-cred",
    });

    expect(control.mock.calls[0]).toEqual(["resolve-alias", { alias: "k7n-m4p" }]);
    expect(control.mock.calls[1]).toEqual(["create-invite", { allocationId: "alloc-42", seat: "B", inviteeName: "Chi", ownerCredential: "owner-cred-123" }]);
    expect(control.mock.calls[2][0]).toBe("claim-invite");
    expect(control.mock.calls[2][1]).toMatchObject({
      inviteToken: "inv_12345",
      name: "Chi",
    });
    expect((control.mock.calls[2][1] as any).claimId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("reuses claimId proof across explicit 503/network retry and purges upon success", async () => {
    const error503 = Object.assign(new Error("authority_unavailable"), { status: 503 });
    const control = vi.fn()
      .mockRejectedValueOnce(error503)
      .mockResolvedValueOnce({ allocationId: "alloc-retry", room: "ott-alloc-retry", seat: "B", ticket: "t1", resumeCredential: "r1" })
      .mockResolvedValueOnce({ allocationId: "alloc-retry", room: "ott-alloc-retry", seat: "B", ticket: "t2", resumeCredential: "r2" });

    const gateway = new OnlineLobbyGateway({ control });

    // Attempt 1: Fails with 503
    await expect(gateway.claimSeatInvite("inv-retry", "Bob")).rejects.toMatchObject({ status: 503 });

    // Attempt 2: Explicit retry succeeds
    await expect(gateway.claimSeatInvite("inv-retry", "Bob")).resolves.toMatchObject({ ticket: "t1" });

    const firstCallClaimId = (control.mock.calls[0][1] as any).claimId;
    const retryCallClaimId = (control.mock.calls[1][1] as any).claimId;
    expect(firstCallClaimId).toMatch(/^[0-9a-f]{32}$/);
    expect(retryCallClaimId).toBe(firstCallClaimId);

    // Attempt 3: After success, the pending proof must be purged and generate a fresh claimId
    await expect(gateway.claimSeatInvite("inv-retry", "Bob")).resolves.toMatchObject({ ticket: "t2" });
    const thirdCallClaimId = (control.mock.calls[2][1] as any).claimId;
    expect(thirdCallClaimId).not.toBe(firstCallClaimId);
  });

  it("clears pending claimId proof on terminal 4xx client errors", async () => {
    const error409 = Object.assign(new Error("seat_already_occupied"), { status: 409 });
    const control = vi.fn()
      .mockRejectedValueOnce(error409)
      .mockResolvedValueOnce({ allocationId: "alloc-409", room: "ott-alloc-409", seat: "B", ticket: "t-ok", resumeCredential: "r-ok" });

    const gateway = new OnlineLobbyGateway({ control });

    // Attempt 1: Terminal 409 error
    await expect(gateway.claimSeatInvite("inv-409", "Charlie")).rejects.toMatchObject({ status: 409 });

    // Attempt 2: Fresh claim after terminal error generates a fresh claimId
    await expect(gateway.claimSeatInvite("inv-409", "Charlie")).resolves.toMatchObject({ ticket: "t-ok" });

    const firstClaimId = (control.mock.calls[0][1] as any).claimId;
    const secondClaimId = (control.mock.calls[1][1] as any).claimId;
    expect(firstClaimId).toMatch(/^[0-9a-f]{32}$/);
    expect(secondClaimId).toMatch(/^[0-9a-f]{32}$/);
    expect(secondClaimId).not.toBe(firstClaimId);
  });

  it("reports unavailable when no HTTPS control endpoint exists", async () => {
    const gateway = new OnlineLobbyGateway();
    expect(gateway.available).toBe(false);
    await expect(gateway.listRooms()).rejects.toMatchObject({ code: "online_unavailable" });
    await expect(gateway.listActiveMatches()).rejects.toMatchObject({ code: "online_unavailable" });
    await expect(gateway.getSpectatorTicket("alloc-1")).rejects.toMatchObject({ code: "online_unavailable" });
    await expect(gateway.resolveAlias("K7N-M4P")).rejects.toMatchObject({ code: "online_unavailable" });
    await expect(gateway.createSeatInvite("alloc-1", "B")).rejects.toMatchObject({ code: "online_unavailable" });
    await expect(gateway.claimSeatInvite("inv_1", "User")).rejects.toMatchObject({ code: "online_unavailable" });
    await expect(gateway.createTournament({ name: "T", organizerName: "O", formatId: "swiss" })).rejects.toMatchObject({ code: "online_unavailable" });
    await expect(gateway.registerTournamentPlayer({ tournamentId: "T", name: "P" })).rejects.toMatchObject({ code: "online_unavailable" });
    await expect(gateway.startTournament({ tournamentId: "T", organizerSecret: "sec" })).rejects.toMatchObject({ code: "online_unavailable" });
    await expect(gateway.getTournamentDetails("T")).rejects.toMatchObject({ code: "online_unavailable" });
    await expect(gateway.getTournamentMatchAccess({ tournamentId: "T", matchId: "m1", participantId: "p1", participantSecret: "sec" })).rejects.toMatchObject({ code: "online_unavailable" });
    await expect(gateway.syncTournamentMatch({ tournamentId: "T", matchId: "m1" })).rejects.toMatchObject({ code: "online_unavailable" });
    await expect(gateway.advanceTournamentRound({ tournamentId: "T", organizerSecret: "sec" })).rejects.toMatchObject({ code: "online_unavailable" });
  });

  it("coordinates tournaments and authoritative match outcomes", async () => {
    const control = vi.fn()
      .mockResolvedValueOnce({ ok: true, tournamentId: "tourn-1", organizerSecret: "org_sec_1", name: "Autumn Cup", formatId: "swiss" })
      .mockResolvedValueOnce({ ok: true, tournamentId: "tourn-1", participantId: "p_1", participantSecret: "p_sec_1", name: "Alice" })
      .mockResolvedValueOnce({ ok: true, tournamentId: "tourn-1", status: "in_progress", currentRoundNumber: 1, roundCount: 3 })
      .mockResolvedValueOnce({
        ok: true,
        tournament: {
          tournamentId: "tourn-1",
          name: "Autumn Cup",
          organizer: { organizerId: "org-1", name: "Organizer" },
          formatId: "swiss",
          status: "in_progress",
          currentRoundNumber: 1,
          roundCount: 3,
          participantCount: 2,
          currentRoundMatches: [],
          standings: [],
          completedAt: null,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        matchId: "m-1",
        roundNumber: 1,
        seat: "A",
        allocationId: "alloc-1",
        alias: "K7N-M4P",
        inviteToken: "inv_seat_a",
        opponentId: "p_2",
        opponentName: "Bob",
      })
      .mockResolvedValueOnce({
        ok: true,
        match: { matchId: "m-1", status: "completed", result: "win_a", winnerParticipantId: "p_1" },
        canAdvance: true,
      })
      .mockResolvedValueOnce({
        ok: true,
        tournamentId: "tourn-1",
        currentRoundNumber: 2,
        roundCount: 3,
        tournamentCompleted: false,
      });

    const gateway = new OnlineLobbyGateway({ control });

    const created = await gateway.createTournament({ name: "Autumn Cup", organizerName: "Organizer", formatId: "swiss" });
    expect(created.tournamentId).toBe("tourn-1");
    expect(created.organizerSecret).toBe("org_sec_1");

    const registered = await gateway.registerTournamentPlayer({ tournamentId: "tourn-1", name: "Alice" });
    expect(registered.participantId).toBe("p_1");
    expect(registered.participantSecret).toBe("p_sec_1");

    const started = await gateway.startTournament({ tournamentId: "tourn-1", organizerSecret: "org_sec_1" });
    expect(started.status).toBe("in_progress");

    const details = await gateway.getTournamentDetails("tourn-1");
    expect(details.name).toBe("Autumn Cup");

    const access = await gateway.getTournamentMatchAccess({
      tournamentId: "tourn-1",
      matchId: "m-1",
      participantId: "p_1",
      participantSecret: "p_sec_1",
    });
    expect(access.inviteToken).toBe("inv_seat_a");
    expect(access.seat).toBe("A");

    const sync = await gateway.syncTournamentMatch({ tournamentId: "tourn-1", matchId: "m-1" });
    expect(sync.match.result).toBe("win_a");
    expect(sync.canAdvance).toBe(true);

    const advanced = await gateway.advanceTournamentRound({ tournamentId: "tourn-1", organizerSecret: "org_sec_1" });
    expect(advanced.currentRoundNumber).toBe(2);
    expect(advanced.tournamentCompleted).toBe(false);

    expect(control.mock.calls).toEqual([
      ["tournament-create", { name: "Autumn Cup", organizerName: "Organizer", formatId: "swiss" }],
      ["tournament-register", { tournamentId: "tourn-1", name: "Alice" }],
      ["tournament-start", { tournamentId: "tourn-1", organizerSecret: "org_sec_1" }],
      ["tournament-get", { tournamentId: "tourn-1" }],
      ["tournament-access", { tournamentId: "tourn-1", matchId: "m-1", participantId: "p_1", participantSecret: "p_sec_1" }],
      ["tournament-sync-match", { tournamentId: "tourn-1", matchId: "m-1" }],
      ["tournament-advance", { tournamentId: "tourn-1", organizerSecret: "org_sec_1" }],
    ]);
  });

  it("exposes controlRequest and resumeRoom for reconnect ticket rotation", async () => {
    const control = vi.fn()
      .mockResolvedValueOnce({ allocationId: "alloc-r", room: "ott-alloc-r", seat: "B", ticket: "resumed-ticket", resumeCredential: "rotated-cred" })
      .mockResolvedValueOnce({ custom: "data" });
    const gateway = new OnlineLobbyGateway({ control });

    const resumed = await gateway.resumeRoom("alloc-r", "old-cred");
    expect(resumed).toEqual({ allocationId: "alloc-r", room: "ott-alloc-r", seat: "B", ticket: "resumed-ticket", resumeCredential: "rotated-cred" });
    expect(control).toHaveBeenCalledWith("resume", { allocationId: "alloc-r", resumeCredential: "old-cred" });

    const generic = await gateway.controlRequest("custom-action", { foo: "bar" });
    expect(generic).toEqual({ custom: "data" });
    expect(control).toHaveBeenCalledWith("custom-action", { foo: "bar" });
  });
});
