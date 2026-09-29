import { describe, expect, it } from "vitest";
import { makeSnapshot } from "./fixtureBuilders";

describe("makeSnapshot viewer defaults", () => {
  it("derives capabilities from player, spectator, and null viewer identities", () => {
    expect(makeSnapshot({ viewer: { role: "player", seat: "A" } }).capabilities).toEqual({ canMove: true, canLeaveGame: false, canSpectate: false });
    expect(makeSnapshot({ viewer: { role: "spectator" }, viewerSeat: null }).capabilities).toEqual({ canMove: false, canLeaveGame: false, canSpectate: true });
    expect(makeSnapshot({ viewer: null, viewerSeat: null }).capabilities).toEqual({ canMove: false, canLeaveGame: false, canSpectate: false });
  });
});
