import { describe, expect, it } from "vitest";

import { formatClock, formatSquare, resultReason } from "./format";

describe("game display formatting", () => {
  it("formats zero-based board positions as human coordinates", () => {
    expect(formatSquare({ x: 0, y: 0 })).toBe("A1");
    expect(formatSquare({ x: 8, y: 8 })).toBe("I9");
  });

  it("rounds remaining milliseconds up to a displayed second", () => {
    expect(formatClock(599_001)).toBe("10:00");
    expect(formatClock(0)).toBe("00:00");
  });

  it("describes a goal result using the winner's canonical goal square", () => {
    expect(resultReason({ winner: "A", reason: "goal" })).toMatch(/A9/);
  });
});
