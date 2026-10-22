import { describe, expect, it } from "vitest";
import { normalizeOnlineEvents } from "./normalizeOnlineState";

describe("normalizeOnlineEvents", () => {
  const base = { id: 4, type: "capture", pieceId: "B-la-2", capturedId: "A-dam-0", from: { x: 3, y: 3 }, to: { x: 3, y: 2 } };

  it("keeps a valid captured piece kind from the server", () => {
    expect(normalizeOnlineEvents([{ ...base, capturedType: "dam" }])).toEqual([{ ...base, capturedType: "dam" }]);
  });

  it("drops an unknown captured kind but keeps the capture", () => {
    expect(normalizeOnlineEvents([{ ...base, capturedType: "<b>" }])).toEqual([base]);
  });

  it("ignores retired strike_loss events", () => {
    expect(normalizeOnlineEvents([{ id: 5, type: "strike_loss", pieceId: "A-la-0", byId: "B-keo-0", from: { x: 0, y: 0 }, to: { x: 0, y: 1 } }])).toEqual([]);
  });
});
