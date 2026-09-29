import { describe, expect, it } from "vitest";

import type { GameSession, GameSnapshot, PlayerView, PublicMatchView, StartGameOptions } from "./contract";

const emptySnapshot = null as unknown as GameSnapshot;

// This fixture is intentionally assigned to GameSession: removing any method
// from the public contract must make this file fail to typecheck.
const sessionFixture: GameSession = {
  getSnapshot: () => emptySnapshot,
  subscribe: () => () => undefined,
  start: async () => undefined,
  getLegalMoves: () => [],
  move: async () => ({ accepted: true }),
  leave: async () => undefined,
  dispose: () => undefined,
};

const spectatorStart: StartGameOptions = {
  mode: "spectator",
  allocationId: "allocation-a",
  roomId: "room-a",
};

const publicMatchFixture: PublicMatchView = {
  allocationId: "allocation-a",
  roomId: "room-a",
  status: "playing",
  players: {
    A: { seat: "A", name: "An", connected: true, remainingMs: 600_000 },
    B: { seat: "B", name: "Bình", connected: true, remainingMs: 600_000 },
  } satisfies Readonly<Record<"A" | "B", Pick<PlayerView, "seat" | "name" | "connected" | "remainingMs">>>,
  spectatorCount: 3,
  serverNow: 1_000,
  runningSeat: "A",
};

describe("GameSession contract", () => {
  it("exposes the complete external-store and command surface", () => {
    expect(Object.keys(sessionFixture)).toEqual([
      "getSnapshot",
      "subscribe",
      "start",
      "getLegalMoves",
      "move",
      "leave",
      "dispose",
    ]);
  });

  it("defines explicit viewer contracts for player and spectator snapshots", () => {
    const player: GameSnapshot["viewer"] = { role: "player", seat: "A" };
    const spectator: GameSnapshot["viewer"] = { role: "spectator" };

    expect(player).toEqual({ role: "player", seat: "A" });
    expect(spectator).toEqual({ role: "spectator" });
    expect(spectatorStart.mode).toBe("spectator");
    expect(publicMatchFixture.players.A.name).toBe("An");
  });
});
