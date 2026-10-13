/**
 * arena-round-robin.test.js
 *
 * TDD tests for domain/round-robin.mjs — pure Double Round-Robin pairing subtask.
 * Invariants:
 *   - Sorted unique stable bot IDs
 *   - N=0 and N=1 rejected
 *   - N=2 -> 2 matches, N=3 -> 6 matches, N=4 -> 12 matches (N*(N-1))
 *   - Every unordered pair appears both A/B and B/A
 *   - No self-pairing (botAId !== botBId)
 *   - Stable contiguous scheduleIndex (0 .. N*(N-1)-1)
 *   - Duplicate / non-string entry IDs rejected
 *   - Pure module: no random, no Node built-ins, no DB, no clock/time
 */

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

let generateDoubleRoundRobinSchedule;
let calculateDoubleRoundRobinMatchCount;
let validateTournamentEntries;

before(async () => {
  const mod = await import("../packages/arena/src/domain/round-robin.mjs");
  generateDoubleRoundRobinSchedule = mod.generateDoubleRoundRobinSchedule;
  calculateDoubleRoundRobinMatchCount = mod.calculateDoubleRoundRobinMatchCount;
  validateTournamentEntries = mod.validateTournamentEntries;
});

// ---------------------------------------------------------------------------
// 1. Input Validation & Entry Sanitization
// ---------------------------------------------------------------------------
describe("Tournament entries validation and rejection", () => {
  it("rejects non-array input", () => {
    assert.throws(() => generateDoubleRoundRobinSchedule(null), /array/i);
    assert.throws(() => generateDoubleRoundRobinSchedule(undefined), /array/i);
    assert.throws(() => generateDoubleRoundRobinSchedule("bot-1,bot-2"), /array/i);
    assert.throws(() => generateDoubleRoundRobinSchedule(123), /array/i);
    assert.throws(() => generateDoubleRoundRobinSchedule({}), /array/i);
  });

  it("rejects N=0 (empty array)", () => {
    assert.throws(() => generateDoubleRoundRobinSchedule([]), /at least 2/i);
  });

  it("rejects N=1 (single entry)", () => {
    assert.throws(() => generateDoubleRoundRobinSchedule(["bot-1"]), /at least 2/i);
    assert.throws(() => generateDoubleRoundRobinSchedule([{ botId: "bot-1" }]), /at least 2/i);
  });

  it("rejects non-string entry IDs", () => {
    assert.throws(() => generateDoubleRoundRobinSchedule([123, 456]), /string/i);
    assert.throws(() => generateDoubleRoundRobinSchedule(["bot-1", null]), /string/i);
    assert.throws(() => generateDoubleRoundRobinSchedule(["bot-1", undefined]), /string/i);
    assert.throws(() => generateDoubleRoundRobinSchedule(["bot-1", {}]), /string/i);
    assert.throws(() => generateDoubleRoundRobinSchedule([{ botId: 123 }, { botId: "b" }]), /string/i);
  });

  it("rejects empty string entry IDs", () => {
    assert.throws(() => generateDoubleRoundRobinSchedule(["", "bot-1"]), /non-empty/i);
    assert.throws(() => generateDoubleRoundRobinSchedule(["   ", "bot-1"]), /non-empty/i);
    assert.throws(() => generateDoubleRoundRobinSchedule([{ botId: "" }, { botId: "bot-1" }]), /non-empty/i);
  });

  it("rejects duplicate entry IDs", () => {
    assert.throws(() => generateDoubleRoundRobinSchedule(["bot-1", "bot-1"]), /duplicate/i);
    assert.throws(() => generateDoubleRoundRobinSchedule(["bot-2", "bot-1", "bot-2"]), /duplicate/i);
    assert.throws(
      () => generateDoubleRoundRobinSchedule([{ botId: "bot-a" }, { botId: "bot-a" }]),
      /duplicate/i
    );
  });

  it("validateTournamentEntries returns lexicographically sorted bot IDs", () => {
    const raw = ["bot-charlie", "bot-alpha", "bot-bravo"];
    const validated = validateTournamentEntries(raw);
    assert.deepEqual(validated, ["bot-alpha", "bot-bravo", "bot-charlie"]);
  });

  it("validateTournamentEntries extracts IDs from objects with botId or id property", () => {
    const raw = [{ botId: "bot-z" }, { botId: "bot-a" }];
    assert.deepEqual(validateTournamentEntries(raw), ["bot-a", "bot-z"]);

    const rawId = [{ id: "bot-2" }, { id: "bot-1" }];
    assert.deepEqual(validateTournamentEntries(rawId), ["bot-1", "bot-2"]);
  });
});

// ---------------------------------------------------------------------------
// 2. calculateDoubleRoundRobinMatchCount
// ---------------------------------------------------------------------------
describe("calculateDoubleRoundRobinMatchCount", () => {
  it("calculates N*(N-1) correctly for valid counts", () => {
    assert.equal(calculateDoubleRoundRobinMatchCount(2), 2);
    assert.equal(calculateDoubleRoundRobinMatchCount(3), 6);
    assert.equal(calculateDoubleRoundRobinMatchCount(4), 12);
    assert.equal(calculateDoubleRoundRobinMatchCount(5), 20);
    assert.equal(calculateDoubleRoundRobinMatchCount(6), 30);
  });

  it("throws on count < 2 or non-integer", () => {
    assert.throws(() => calculateDoubleRoundRobinMatchCount(0), /at least 2/i);
    assert.throws(() => calculateDoubleRoundRobinMatchCount(1), /at least 2/i);
    assert.throws(() => calculateDoubleRoundRobinMatchCount(2.5), /integer/i);
    assert.throws(() => calculateDoubleRoundRobinMatchCount("3"), /number/i);
  });
});

// ---------------------------------------------------------------------------
// 3. Match Counts and Double Round-Robin Invariants (N2=2, N3=6, N4=12)
// ---------------------------------------------------------------------------
describe("Double Round-Robin Schedule invariants", () => {
  it("N2=2: exactly 2 matches, each unordered pair plays both A/B and B/A", () => {
    const schedule = generateDoubleRoundRobinSchedule(["bot-1", "bot-2"]);
    assert.equal(schedule.length, 2);

    // Verify scheduleIndex is contiguous 0..1
    assert.equal(schedule[0].scheduleIndex, 0);
    assert.equal(schedule[1].scheduleIndex, 1);

    // No self pairing
    assert.notEqual(schedule[0].botAId, schedule[0].botBId);
    assert.notEqual(schedule[1].botAId, schedule[1].botBId);

    // Pairings cover both (bot-1, bot-2) and (bot-2, bot-1)
    const pairs = schedule.map((m) => `${m.botAId}->${m.botBId}`);
    assert.ok(pairs.includes("bot-1->bot-2"));
    assert.ok(pairs.includes("bot-2->bot-1"));
  });

  it("N3=6: exactly 6 matches, every unordered pair appears both A/B and B/A", () => {
    const bots = ["bot-1", "bot-2", "bot-3"];
    const schedule = generateDoubleRoundRobinSchedule(bots);
    assert.equal(schedule.length, 6);

    // Verify contiguous scheduleIndex 0..5
    for (let i = 0; i < schedule.length; i++) {
      assert.equal(schedule[i].scheduleIndex, i);
      assert.notEqual(schedule[i].botAId, schedule[i].botBId, `Match ${i} has self-pairing`);
    }

    // Check all 6 directed pairs exist exactly once
    const expectedDirectedPairs = [
      "bot-1->bot-2", "bot-2->bot-1",
      "bot-1->bot-3", "bot-3->bot-1",
      "bot-2->bot-3", "bot-3->bot-2"
    ];
    const actualDirectedPairs = schedule.map((m) => `${m.botAId}->${m.botBId}`);
    assert.equal(new Set(actualDirectedPairs).size, 6, "All directed pairs must be unique");
    for (const pair of expectedDirectedPairs) {
      assert.ok(actualDirectedPairs.includes(pair), `Missing expected directed pair: ${pair}`);
    }
  });

  it("N4=12: exactly 12 matches, every unordered pair appears both A/B and B/A", () => {
    const bots = ["bot-1", "bot-2", "bot-3", "bot-4"];
    const schedule = generateDoubleRoundRobinSchedule(bots);
    assert.equal(schedule.length, 12);

    // Verify contiguous scheduleIndex 0..11
    for (let i = 0; i < schedule.length; i++) {
      assert.equal(schedule[i].scheduleIndex, i);
      assert.notEqual(schedule[i].botAId, schedule[i].botBId, `Match ${i} has self-pairing`);
    }

    // Every unordered pair {u, v} must appear as (u, v) and (v, u)
    const unorderedPairCounts = new Map();
    for (let i = 0; i < bots.length; i++) {
      for (let j = i + 1; j < bots.length; j++) {
        const key = [bots[i], bots[j]].sort().join(" vs ");
        unorderedPairCounts.set(key, { ab: 0, ba: 0 });
      }
    }

    for (const match of schedule) {
      const u = match.botAId;
      const v = match.botBId;
      const key = [u, v].sort().join(" vs ");
      const counts = unorderedPairCounts.get(key);
      assert.ok(counts, `Unexpected pair: ${key}`);
      if (u < v) {
        counts.ab++;
      } else {
        counts.ba++;
      }
    }

    for (const [key, counts] of unorderedPairCounts.entries()) {
      assert.equal(counts.ab, 1, `Pair ${key} must have exactly 1 match with first as A`);
      assert.equal(counts.ba, 1, `Pair ${key} must have exactly 1 match with second as A`);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Stable Schedule Index and Determinism
// ---------------------------------------------------------------------------
describe("Schedule index stability and determinism", () => {
  it("shuffled input order yields the EXACT same schedule due to sorting", () => {
    const order1 = ["bot-delta", "bot-alpha", "bot-charlie", "bot-bravo"];
    const order2 = ["bot-alpha", "bot-bravo", "bot-charlie", "bot-delta"];
    const order3 = ["bot-bravo", "bot-delta", "bot-alpha", "bot-charlie"];

    const schedule1 = generateDoubleRoundRobinSchedule(order1);
    const schedule2 = generateDoubleRoundRobinSchedule(order2);
    const schedule3 = generateDoubleRoundRobinSchedule(order3);

    assert.deepEqual(schedule1, schedule2);
    assert.deepEqual(schedule1, schedule3);
  });

  it("contiguous scheduleIndex is strictly sequential starting at 0", () => {
    const bots = ["bot-a", "bot-b", "bot-c", "bot-d", "bot-e"];
    const schedule = generateDoubleRoundRobinSchedule(bots);
    assert.equal(schedule.length, 20); // 5 * 4 = 20
    for (let i = 0; i < schedule.length; i++) {
      assert.equal(schedule[i].scheduleIndex, i);
    }
  });

  it("includes ergonomic seat aliases (seatA, seatB)", () => {
    const schedule = generateDoubleRoundRobinSchedule(["bot-1", "bot-2"]);
    assert.equal(schedule[0].seatA, schedule[0].botAId);
    assert.equal(schedule[0].seatB, schedule[0].botBId);
  });
});

// ---------------------------------------------------------------------------
// 5. Entry Objects with Pinned Metadata (botVersionId)
// ---------------------------------------------------------------------------
describe("Object entries with metadata preservation", () => {
  it("preserves botVersionId when entries are provided as objects", () => {
    const entries = [
      { botId: "bot-1", botVersionId: "ver-1" },
      { botId: "bot-2", botVersionId: "ver-2" }
    ];
    const schedule = generateDoubleRoundRobinSchedule(entries);
    assert.equal(schedule.length, 2);

    const m0 = schedule[0];
    if (m0.botAId === "bot-1") {
      assert.equal(m0.botAVersionId, "ver-1");
      assert.equal(m0.botBVersionId, "ver-2");
    } else {
      assert.equal(m0.botAVersionId, "ver-2");
      assert.equal(m0.botBVersionId, "ver-1");
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Pure Module Isolation & No Side Effects
// ---------------------------------------------------------------------------
describe("Pure module isolation and determinism", () => {
  it("pure function does not mutate input arrays or objects", () => {
    const input = Object.freeze([
      Object.freeze({ botId: "bot-b" }),
      Object.freeze({ botId: "bot-a" })
    ]);
    const schedule = generateDoubleRoundRobinSchedule(input);
    assert.equal(schedule.length, 2);
    assert.equal(input[0].botId, "bot-b");
    assert.equal(input[1].botId, "bot-a");
  });

  it("is completely deterministic with zero randomness", () => {
    const bots = ["b1", "b2", "b3"];
    const run1 = generateDoubleRoundRobinSchedule(bots);
    const run2 = generateDoubleRoundRobinSchedule(bots);
    assert.deepEqual(run1, run2);
  });
});
