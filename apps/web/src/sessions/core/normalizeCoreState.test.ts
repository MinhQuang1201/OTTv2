import "../../../../../packages/game-core/src/config.js";
import "../../../../../packages/game-core/src/rules.js";
import "../../../../../packages/game-core/src/ai.js";

import { describe, expect, it } from "vitest";
import { getGameCoreBridge } from "./gameCoreBridge";
import { normalizeCoreEvents, normalizeCoreState } from "./normalizeCoreState";

describe("normalizeCoreState", () => {
  it("keeps the captured piece kind reported by the rules engine", () => {
    const [event] = normalizeCoreEvents([{ type: "capture", pieceId: "A-dam-1", capturedId: "B-keo-0", capturedType: "keo", from: { x: 1, y: 1 }, to: { x: 1, y: 0 } }]);
    expect(event).toEqual({ id: 1, type: "capture", pieceId: "A-dam-1", capturedId: "B-keo-0", capturedType: "keo", from: { x: 1, y: 1 }, to: { x: 1, y: 0 } });
  });

  it("maps the canonical initial state without reimplementing setup", () => {
    const bridge = getGameCoreBridge();
    const state = bridge.createInitialState();
    const snapshot = normalizeCoreState(state, { mode: "local", viewerSeat: "A", phase: "playing", playerNames: { A: "An", B: "Bình" } });

    expect(snapshot.board).toHaveLength(20);
    expect(snapshot.turn).toBe("A");
    expect(snapshot.players.A?.counts).toEqual({ dam: 3, la: 4, keo: 3 });
    expect(snapshot.players.B?.counts).toEqual({ dam: 3, la: 4, keo: 3 });
    expect(snapshot.players.A?.remainingMs).toBe(10 * 60 * 1000);
    expect(snapshot.players.B?.remainingMs).toBe(10 * 60 * 1000);
    expect(snapshot.board.find((piece) => piece.seat === "A" && piece.position.x === 4 && piece.position.y === 7)).toBeTruthy();
    expect(snapshot.board.find((piece) => piece.seat === "B" && piece.position.x === 4 && piece.position.y === 1)).toBeTruthy();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.board)).toBe(true);
  });

  it("uses an explicit player contract only when a viewer seat is supplied", () => {
    const bridge = getGameCoreBridge();
    const state = bridge.createInitialState();
    const idle = normalizeCoreState(state, { mode: "local", phase: "idle" });
    const player = normalizeCoreState(state, { mode: "local", phase: "playing", viewerSeat: "A" });

    expect(idle).toMatchObject({ viewer: null, viewerSeat: null, capabilities: { canMove: false, canLeaveGame: false, canSpectate: false }, spectatorCount: 0 });
    expect(player).toMatchObject({ viewer: { role: "player", seat: "A" }, viewerSeat: "A", capabilities: { canMove: true, canLeaveGame: false, canSpectate: false }, spectatorCount: 0 });
  });
});
