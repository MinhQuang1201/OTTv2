import "../../../../../packages/game-core/src/config.js";
import "../../../../../packages/game-core/src/rules.js";
import "../../../../../packages/game-core/src/ai.js";

import { describe, expect, it } from "vitest";
import { getGameCoreBridge } from "./gameCoreBridge";
import { normalizeCoreState } from "./normalizeCoreState";

describe("normalizeCoreState", () => {
  it("maps the canonical initial state without reimplementing setup", () => {
    const bridge = getGameCoreBridge();
    const state = bridge.createInitialState();
    const snapshot = normalizeCoreState(state, { mode: "local", viewerSeat: "A", phase: "playing", playerNames: { A: "An", B: "Bình" } });

    expect(snapshot.board).toHaveLength(18);
    expect(snapshot.turn).toBe("A");
    expect(snapshot.players.A?.counts).toEqual({ dam: 3, la: 3, keo: 3 });
    expect(snapshot.players.B?.counts).toEqual({ dam: 3, la: 3, keo: 3 });
    expect(snapshot.players.A?.remainingMs).toBe(10 * 60 * 1000);
    expect(snapshot.players.B?.remainingMs).toBe(10 * 60 * 1000);
    expect(snapshot.board.find((piece) => piece.seat === "A" && piece.position.x === 0 && piece.position.y === 2)).toBeTruthy();
    expect(snapshot.board.find((piece) => piece.seat === "B" && piece.position.x === 8 && piece.position.y === 6)).toBeTruthy();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.board)).toBe(true);
  });
});
