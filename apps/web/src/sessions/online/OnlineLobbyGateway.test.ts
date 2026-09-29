import { describe, expect, it, vi } from "vitest";
import { OnlineLobbyGateway } from "./OnlineLobbyGateway";

describe("OnlineLobbyGateway", () => {
  it("uses control requests for public rooms and allocation commands", async () => {
    const control = vi.fn()
      .mockResolvedValueOnce({ rooms: [{ id: "room-a", names: { A: "An" }, players: 1 }, { roomId: "room-b", hostName: "Bình", playerCount: 2 }] })
      .mockResolvedValueOnce({ allocationId: "allocation-a", room: "room-a", seat: "A", ticket: "ticket", resumeCredential: "resume" })
      .mockResolvedValueOnce({ allocationId: "allocation-b", room: "room-b", seat: "B", ticket: "ticket", resumeCredential: "resume" });
    const gateway = new OnlineLobbyGateway({ control });

    await expect(gateway.listRooms()).resolves.toEqual({ available: true, rooms: [
      { roomId: "room-a", hostName: "An", playerCount: 1, maxPlayers: 2 },
      { roomId: "room-b", hostName: "Bình", playerCount: 2, maxPlayers: 2 },
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

  it("reports unavailable when no HTTPS control endpoint exists", async () => {
    const gateway = new OnlineLobbyGateway();
    expect(gateway.available).toBe(false);
    await expect(gateway.listRooms()).rejects.toMatchObject({ code: "online_unavailable" });
    await expect(gateway.listActiveMatches()).rejects.toMatchObject({ code: "online_unavailable" });
    await expect(gateway.getSpectatorTicket("alloc-1")).rejects.toMatchObject({ code: "online_unavailable" });
  });
});
