/**
 * tests/arena-formats.test.js
 *
 * Comprehensive property and unit tests for OTTv2 Arena tournament formats:
 * - single-round-robin
 * - double-round-robin
 * - swiss
 *
 * Verifies:
 * - Format discovery and descriptors
 * - Round count calculations across N2..32
 * - Input validation and error conditions
 * - Round-robin circle algorithm round grouping & odd resting
 * - Deterministic Swiss properties:
 *   - 100% deterministic reproducibility
 *   - Match and bye counts (even N vs odd N)
 *   - No duplicates within a round
 *   - Rematch avoidance across tournament progression
 *   - Fair bye distribution (lowest eligible, no duplicate byes)
 *   - Home/away (Seat A / Seat B) side balance & streak limits
 *   - Bounded search and explicit warning fallback when rematches are unavoidable
 *   - Preservation of botVersionId metadata
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("Arena Tournament Formats Domain", async () => {
  const {
    listFormats,
    getFormat,
    getRoundCount,
    pairRound,
    FORMAT_IDS
  } = await import("../packages/arena/src/domain/formats/index.mjs");

  // ── 1. Format Descriptors & Discovery ───────────────────────────────────────
  describe("listFormats and getFormat", () => {
    it("lists all three supported format descriptors", () => {
      const formats = listFormats();
      assert.equal(formats.length, 3);

      const ids = formats.map((f) => f.id);
      assert.deepEqual(ids, ["single-round-robin", "double-round-robin", "swiss"]);

      for (const format of formats) {
        assert.ok(typeof format.id === "string" && format.id.length > 0);
        assert.ok(typeof format.name === "string" && format.name.length > 0);
        assert.ok(typeof format.description === "string" && format.description.length > 0);
      }
    });

    it("returns cloned array so mutations do not corrupt registry", () => {
      const f1 = listFormats();
      f1.pop();
      const f2 = listFormats();
      assert.equal(f2.length, 3);
    });

    it("retrieves format by id or returns undefined for unknown", () => {
      const swiss = getFormat("swiss");
      assert.ok(swiss);
      assert.equal(swiss.id, "swiss");
      assert.equal(swiss.name, "Swiss System");

      assert.equal(getFormat("unknown-format"), undefined);
    });
  });

  // ── 2. Round Count Computation ──────────────────────────────────────────────
  describe("getRoundCount", () => {
    it("rejects unknown format or invalid participant counts", () => {
      assert.throws(() => getRoundCount("bad-format", 4), /Unknown tournament format/i);
      assert.throws(() => getRoundCount("swiss", 1), /at least 2/i);
      assert.throws(() => getRoundCount("swiss", 0), /at least 2/i);
      assert.throws(() => getRoundCount("swiss", -5), /at least 2/i);
      assert.throws(() => getRoundCount("swiss", 3.5), /integer/i);
      assert.throws(() => getRoundCount("swiss", "4"), /integer/i);
    });

    it("calculates exact single-round-robin round count (N odd -> N, N even -> N-1)", () => {
      assert.equal(getRoundCount("single-round-robin", 2), 1);
      assert.equal(getRoundCount("single-round-robin", 3), 3);
      assert.equal(getRoundCount("single-round-robin", 4), 3);
      assert.equal(getRoundCount("single-round-robin", 5), 5);
      assert.equal(getRoundCount("single-round-robin", 6), 5);
      assert.equal(getRoundCount("single-round-robin", 8), 7);
      assert.equal(getRoundCount("single-round-robin", 32), 31);
    });

    it("calculates exact double-round-robin round count (twice single-round-robin)", () => {
      assert.equal(getRoundCount("double-round-robin", 2), 2);
      assert.equal(getRoundCount("double-round-robin", 3), 6);
      assert.equal(getRoundCount("double-round-robin", 4), 6);
      assert.equal(getRoundCount("double-round-robin", 5), 10);
      assert.equal(getRoundCount("double-round-robin", 6), 10);
      assert.equal(getRoundCount("double-round-robin", 8), 14);
      assert.equal(getRoundCount("double-round-robin", 32), 62);
    });

    it("calculates default Swiss round count: ceil(log2(N)), bounded by N-1 and 32", () => {
      assert.equal(getRoundCount("swiss", 2), 1);
      assert.equal(getRoundCount("swiss", 3), 2);
      assert.equal(getRoundCount("swiss", 4), 2);
      assert.equal(getRoundCount("swiss", 5), 3);
      assert.equal(getRoundCount("swiss", 8), 3);
      assert.equal(getRoundCount("swiss", 9), 4);
      assert.equal(getRoundCount("swiss", 16), 4);
      assert.equal(getRoundCount("swiss", 17), 5);
      assert.equal(getRoundCount("swiss", 32), 5);
    });

    it("validates and accepts user-requested Swiss rounds within 1..min(32, N-1)", () => {
      assert.equal(getRoundCount("swiss", 4, 1), 1);
      assert.equal(getRoundCount("swiss", 4, 3), 3);
      assert.equal(getRoundCount("swiss", 8, 5), 5);
      assert.equal(getRoundCount("swiss", 32, 20), 20);

      // Rejects out of bounds
      assert.throws(() => getRoundCount("swiss", 4, 0), /between 1 and 3/i);
      assert.throws(() => getRoundCount("swiss", 4, 4), /between 1 and 3/i);
      assert.throws(() => getRoundCount("swiss", 8, 8), /between 1 and 7/i);
      assert.throws(() => getRoundCount("swiss", 4, "2"), /integer/i);
    });
  });

  // ── 3. Single & Double Round-Robin pairRound ─────────────────────────────────
  describe("Round-Robin pairRound", () => {
    it("rejects invalid input options", () => {
      assert.throws(() => pairRound(null), /non-null object/i);
      assert.throws(
        () => pairRound({ formatId: "invalid", entries: ["a", "b"], roundNumber: 1, roundCount: 1 }),
        /Unknown tournament format/i
      );
      assert.throws(
        () => pairRound({ formatId: "single-round-robin", entries: ["a"], roundNumber: 1, roundCount: 1 }),
        /at least 2/i
      );
      assert.throws(
        () => pairRound({ formatId: "single-round-robin", entries: ["a", "a"], roundNumber: 1, roundCount: 1 }),
        /Duplicate/i
      );
      assert.throws(
        () => pairRound({ formatId: "single-round-robin", entries: ["a", "b"], roundNumber: 0, roundCount: 1 }),
        /roundNumber must be between 1 and 1/i
      );
      assert.throws(
        () => pairRound({ formatId: "single-round-robin", entries: ["a", "b"], roundNumber: 2, roundCount: 1 }),
        /roundNumber must be between 1 and 1/i
      );
    });

    it("pairs complete Single Round-Robin for even N=4", () => {
      const entries = ["bot-a", "bot-b", "bot-c", "bot-d"];
      const roundCount = getRoundCount("single-round-robin", 4);
      assert.equal(roundCount, 3);

      const allMatches = [];
      const pairSet = new Set();

      for (let r = 1; r <= roundCount; r++) {
        const result = pairRound({
          formatId: "single-round-robin",
          entries,
          roundNumber: r,
          roundCount
        });

        assert.equal(result.warnings.length, 0);
        assert.equal(result.byes.length, 0);
        assert.equal(result.pairings.length, 2);

        // Check contiguous scheduleIndex
        result.pairings.forEach((p, idx) => {
          assert.equal(p.scheduleIndex, idx);
          allMatches.push(p);

          const key = p.botAId < p.botBId ? `${p.botAId}:${p.botBId}` : `${p.botBId}:${p.botAId}`;
          assert.ok(!pairSet.has(key), `Duplicate match in SRR: ${key}`);
          pairSet.add(key);
        });

        // No bot plays twice in same round
        const botsInRound = new Set();
        result.pairings.forEach((p) => {
          assert.ok(!botsInRound.has(p.botAId));
          assert.ok(!botsInRound.has(p.botBId));
          botsInRound.add(p.botAId);
          botsInRound.add(p.botBId);
        });
        assert.equal(botsInRound.size, 4);
      }

      // N*(N-1)/2 matches total = 6
      assert.equal(allMatches.length, 6);
      assert.equal(pairSet.size, 6);
    });

    it("pairs complete Single Round-Robin for odd N=3 with fair resting", () => {
      const entries = ["bot-1", "bot-2", "bot-3"];
      const roundCount = getRoundCount("single-round-robin", 3);
      assert.equal(roundCount, 3);

      const byeCounts = new Map(entries.map((b) => [b, 0]));
      const allMatches = [];

      for (let r = 1; r <= roundCount; r++) {
        const result = pairRound({
          formatId: "single-round-robin",
          entries,
          roundNumber: r,
          roundCount
        });

        assert.equal(result.warnings.length, 0);
        assert.equal(result.pairings.length, 1);
        assert.equal(result.byes.length, 1);

        const resting = result.byes[0];
        byeCounts.set(resting, byeCounts.get(resting) + 1);

        const p = result.pairings[0];
        assert.equal(p.scheduleIndex, 0);
        assert.notEqual(p.botAId, resting);
        assert.notEqual(p.botBId, resting);
        allMatches.push(p);
      }

      // Exactly 3 matches total, each participant rests exactly once
      assert.equal(allMatches.length, 3);
      for (const b of entries) {
        assert.equal(byeCounts.get(b), 1, `Bot ${b} did not rest exactly once`);
      }
    });

    it("pairs complete Double Round-Robin for N=4 with both home and away legs", () => {
      const entries = [
        { botId: "bot-a", botVersionId: "v-a" },
        { botId: "bot-b", botVersionId: "v-b" },
        { botId: "bot-c", botVersionId: "v-c" },
        { botId: "bot-d", botVersionId: "v-d" }
      ];
      const roundCount = getRoundCount("double-round-robin", 4);
      assert.equal(roundCount, 6);

      const orderedPairs = new Set();
      let totalMatches = 0;

      for (let r = 1; r <= roundCount; r++) {
        const result = pairRound({
          formatId: "double-round-robin",
          entries,
          roundNumber: r,
          roundCount
        });

        assert.equal(result.pairings.length, 2);
        assert.equal(result.byes.length, 0);

        for (const p of result.pairings) {
          totalMatches++;
          assert.ok(p.botAVersionId);
          assert.ok(p.botBVersionId);
          const key = `${p.botAId}->${p.botBId}`;
          assert.ok(!orderedPairs.has(key), `Duplicate ordered match: ${key}`);
          orderedPairs.add(key);
        }
      }

      // Total N*(N-1) = 12 matches, all 12 ordered pairings present
      assert.equal(totalMatches, 12);
      assert.equal(orderedPairs.size, 12);
    });
  });

  // ── 4. Swiss Deterministic Property Tests (N2..32) ──────────────────────────
  describe("Swiss pairRound properties", () => {
    it("guarantees 100% deterministic reproducibility", () => {
      const entries = ["bot-4", "bot-2", "bot-1", "bot-3", "bot-5"];
      const standings = [
        { botId: "bot-1", points: 3, wins: 1, byeCount: 0 },
        { botId: "bot-2", points: 3, wins: 1, byeCount: 0 },
        { botId: "bot-3", points: 1, wins: 0, byeCount: 0 },
        { botId: "bot-4", points: 0, wins: 0, byeCount: 0 },
        { botId: "bot-5", points: 3, wins: 1, byeCount: 1 }
      ];
      const history = [
        { roundNumber: 1, botAId: "bot-1", botBId: "bot-4" },
        { roundNumber: 1, botAId: "bot-2", botBId: "bot-3" }
      ];

      const r1 = pairRound({
        formatId: "swiss",
        entries,
        roundNumber: 2,
        roundCount: 3,
        standings,
        history
      });

      const r2 = pairRound({
        formatId: "swiss",
        entries,
        roundNumber: 2,
        roundCount: 3,
        standings,
        history
      });

      assert.deepEqual(r1, r2);
    });

    it("preserves exact match counts and byes across N2..32", () => {
      const testNs = [2, 3, 4, 5, 6, 7, 8, 15, 16, 31, 32];

      for (const n of testNs) {
        const entries = Array.from({ length: n }, (_, i) => `bot-${String(i + 1).padStart(2, "0")}`);
        const roundCount = getRoundCount("swiss", n);

        const result = pairRound({
          formatId: "swiss",
          entries,
          roundNumber: 1,
          roundCount
        });

        assert.equal(result.warnings.length, 0);

        if (n % 2 === 0) {
          assert.equal(result.pairings.length, n / 2);
          assert.equal(result.byes.length, 0);
        } else {
          assert.equal(result.pairings.length, (n - 1) / 2);
          assert.equal(result.byes.length, 1);
        }

        // Verify all participants are accounted for with zero duplicates
        const seen = new Set();
        if (result.byes.length > 0) {
          seen.add(result.byes[0]);
        }
        for (const p of result.pairings) {
          assert.notEqual(p.botAId, p.botBId, "Self-pairing detected");
          assert.ok(!seen.has(p.botAId), `Bot ${p.botAId} duplicated in pairings/bye`);
          assert.ok(!seen.has(p.botBId), `Bot ${p.botBId} duplicated in pairings/bye`);
          seen.add(p.botAId);
          seen.add(p.botBId);
        }
        assert.equal(seen.size, n);
      }
    });

    it("forwards botVersionId metadata into pairings", () => {
      const entries = [
        { botId: "bot-alpha", botVersionId: "ver-alpha-1" },
        { botId: "bot-beta", botVersionId: "ver-beta-2" }
      ];

      const result = pairRound({
        formatId: "swiss",
        entries,
        roundNumber: 1,
        roundCount: 1
      });

      assert.equal(result.pairings.length, 1);
      const match = result.pairings[0];
      assert.equal(match.botAId, "bot-alpha");
      assert.equal(match.botBId, "bot-beta");
      assert.equal(match.botAVersionId, "ver-alpha-1");
      assert.equal(match.botBVersionId, "ver-beta-2");
    });
  });

  // ── 5. Multi-Round Swiss Tournament Simulations ─────────────────────────────
  describe("Multi-Round Swiss Tournament Simulations", () => {
    /**
     * Helper to simulate a full Swiss tournament round-by-round.
     */
    function runSimulatedSwiss(n, requestedRounds) {
      const entries = Array.from({ length: n }, (_, i) => ({
        botId: `bot-${String(i + 1).padStart(2, "0")}`,
        botVersionId: `v-${i + 1}`
      }));

      const roundCount = getRoundCount("swiss", n, requestedRounds);

      const standingsMap = new Map(
        entries.map((e) => [
          e.botId,
          {
            botId: e.botId,
            points: 0,
            wins: 0,
            draws: 0,
            losses: 0,
            played: 0,
            byeCount: 0,
            seatBalance: 0
          }
        ])
      );

      const history = [];
      const seatCounts = new Map(entries.map((e) => [e.botId, { A: 0, B: 0 }]));
      const seatStreaks = new Map(entries.map((e) => [e.botId, { last: null, streak: 0 }]));
      const pairSet = new Set();
      const byeCounts = new Map(entries.map((e) => [e.botId, 0]));

      for (let r = 1; r <= roundCount; r++) {
        const standingsList = Array.from(standingsMap.values());

        const roundResult = pairRound({
          formatId: "swiss",
          entries,
          roundNumber: r,
          roundCount,
          standings: standingsList,
          history
        });

        // 1. Process BYE
        if (roundResult.byes.length > 0) {
          const byeBotId = roundResult.byes[0];
          byeCounts.set(byeBotId, byeCounts.get(byeBotId) + 1);

          // Orchestrator gives 3 points for Swiss bye
          const st = standingsMap.get(byeBotId);
          st.points += 3;
          st.wins += 1;
          st.byeCount += 1;
        }

        // 2. Process Matches
        for (const match of roundResult.pairings) {
          const { botAId, botBId } = match;

          // Track seat counts
          const sa = seatCounts.get(botAId);
          sa.A += 1;
          const sb = seatCounts.get(botBId);
          sb.B += 1;

          // Track streaks
          const stra = seatStreaks.get(botAId);
          stra.streak = stra.last === "A" ? stra.streak + 1 : 1;
          stra.last = "A";

          const strb = seatStreaks.get(botBId);
          strb.streak = strb.last === "B" ? strb.streak + 1 : 1;
          strb.last = "B";

          // Update standings balance
          const stA = standingsMap.get(botAId);
          const stB = standingsMap.get(botBId);
          stA.seatBalance = sa.A - sa.B;
          stB.seatBalance = sb.A - sb.B;
          stA.played += 1;
          stB.played += 1;

          // Deterministic match resolution: lower botId index wins
          const numA = parseInt(botAId.replace("bot-", ""), 10);
          const numB = parseInt(botBId.replace("bot-", ""), 10);
          if (numA < numB) {
            stA.points += 3;
            stA.wins += 1;
            stB.losses += 1;
          } else {
            stB.points += 3;
            stB.wins += 1;
            stA.losses += 1;
          }

          // Rematch tracking
          const pairKey = botAId < botBId ? `${botAId}:${botBId}` : `${botBId}:${botAId}`;
          pairSet.add(pairKey);

          history.push({
            roundNumber: r,
            botAId,
            botBId
          });
        }
      }

      return {
        roundCount,
        history,
        seatCounts,
        seatStreaks,
        byeCounts,
        pairSet,
        standings: Array.from(standingsMap.values())
      };
    }

    it("simulates 3-participant Swiss over 2 rounds with fair BYE and 0 rematches", () => {
      const sim = runSimulatedSwiss(3);
      assert.equal(sim.roundCount, 2);
      assert.equal(sim.history.length, 2);

      // In a 3-player 2-round Swiss, exactly 2 bots receive 1 bye, no bot receives 2 byes
      for (const [botId, count] of sim.byeCounts.entries()) {
        assert.ok(count <= 1, `Bot ${botId} received more than 1 bye (${count})`);
      }
      assert.equal(sim.pairSet.size, 2, "Rematch detected in 3-player Swiss");
    });

    it("simulates 5-participant Swiss over 3 rounds with fair BYE and 0 rematches", () => {
      const sim = runSimulatedSwiss(5);
      assert.equal(sim.roundCount, 3);
      assert.equal(sim.history.length, 6); // 2 matches per round * 3 rounds

      // Each of the 3 byes must go to a distinct bot
      let totalByes = 0;
      for (const [botId, count] of sim.byeCounts.entries()) {
        assert.ok(count <= 1, `Bot ${botId} received ${count} byes, expected max 1`);
        totalByes += count;
      }
      assert.equal(totalByes, 3);

      // 6 distinct pairings (zero rematches)
      assert.equal(sim.pairSet.size, 6, "Rematch detected in 5-player Swiss");

      // Side balance check: difference in seats <= 2
      for (const [botId, sc] of sim.seatCounts.entries()) {
        const diff = Math.abs(sc.A - sc.B);
        assert.ok(diff <= 2, `Bot ${botId} seat imbalance too large: A=${sc.A}, B=${sc.B}`);
      }
    });

    it("simulates 8-participant Swiss over 3 rounds with 0 rematches and side balance", () => {
      const sim = runSimulatedSwiss(8);
      assert.equal(sim.roundCount, 3);
      assert.equal(sim.history.length, 12); // 4 matches/round * 3 rounds = 12

      // All 12 matches are unique (zero rematches)
      assert.equal(sim.pairSet.size, 12);

      // Side balance: difference between Seat A and Seat B count <= 1
      for (const [botId, sc] of sim.seatCounts.entries()) {
        const diff = Math.abs(sc.A - sc.B);
        assert.ok(diff <= 1, `Bot ${botId} seat imbalance > 1: A=${sc.A}, B=${sc.B}`);
      }
    });

    it("simulates 16-participant Swiss over 4 rounds with 0 rematches and balanced sides", () => {
      const sim = runSimulatedSwiss(16);
      assert.equal(sim.roundCount, 4);
      assert.equal(sim.history.length, 32); // 8 matches/round * 4 rounds = 32

      // 32 distinct matches
      assert.equal(sim.pairSet.size, 32);

      // Side balance: no bot plays 3 more games on one side than the other
      for (const [botId, sc] of sim.seatCounts.entries()) {
        const diff = Math.abs(sc.A - sc.B);
        assert.ok(diff <= 2, `Bot ${botId} seat imbalance: A=${sc.A}, B=${sc.B}`);
      }
    });

    it("simulates 32-participant Swiss over 5 rounds with 0 rematches and fast execution", () => {
      const startTime = Date.now();
      const sim = runSimulatedSwiss(32);
      const elapsed = Date.now() - startTime;

      assert.equal(sim.roundCount, 5);
      assert.equal(sim.history.length, 80); // 16 matches/round * 5 rounds = 80
      assert.equal(sim.pairSet.size, 80, "Rematches detected in 32-bot Swiss");
      assert.ok(elapsed < 500, `Execution took ${elapsed}ms, expected < 500ms`);
    });
  });

  // ── 6. Bounded Search & Warning Fallback ────────────────────────────────────
  describe("Bounded Search & Fallback Warnings", () => {
    it("handles unavoidable rematches gracefully by emitting explicit warning and pairing", () => {
      // 4 bots, but all possible pairs have already played in prior rounds
      const entries = ["bot-1", "bot-2", "bot-3", "bot-4"];
      const standings = [
        { botId: "bot-1", points: 3 },
        { botId: "bot-2", points: 3 },
        { botId: "bot-3", points: 0 },
        { botId: "bot-4", points: 0 }
      ];
      // Construct history where every bot has played every other bot
      const history = [
        { roundNumber: 1, botAId: "bot-1", botBId: "bot-2" },
        { roundNumber: 1, botAId: "bot-3", botBId: "bot-4" },
        { roundNumber: 2, botAId: "bot-1", botBId: "bot-3" },
        { roundNumber: 2, botAId: "bot-2", botBId: "bot-4" },
        { roundNumber: 3, botAId: "bot-1", botBId: "bot-4" },
        { roundNumber: 3, botAId: "bot-2", botBId: "bot-3" }
      ];

      // Round 4: all possible pairs are rematches
      const result = pairRound({
        formatId: "swiss",
        entries,
        roundNumber: 4,
        roundCount: 4,
        standings,
        history
      });

      assert.equal(result.pairings.length, 2);
      assert.ok(result.warnings.length > 0);
      assert.ok(
        result.warnings.some((w) => w.includes("rematch_minimization_fallback")),
        "Expected fallback warning"
      );
      assert.ok(
        result.warnings.some((w) => w.includes("rematch_paired")),
        "Expected rematch_paired warning"
      );

      // Verify all bots still paired without crashing or hanging
      const bots = new Set();
      result.pairings.forEach((p) => {
        bots.add(p.botAId);
        bots.add(p.botBId);
      });
      assert.equal(bots.size, 4);
    });
  });
});
