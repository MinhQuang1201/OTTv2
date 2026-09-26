import { describe, expect, it } from "vitest";

import type { GameSession, GameSnapshot } from "./contract";

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
});
