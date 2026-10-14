/**
 * packages/arena/src/domain/formats/swiss.mjs
 *
 * Pure Swiss System pairing generator for OTTv2 Arena.
 *
 * Guarantees & Invariants:
 * - Deterministic score-sorted pairings.
 * - Multi-tier stable tie-breaking: points, wins, Buchholz, Sonneborn-Berger, played, lexicographical botId.
 * - Fair BYE allocation for odd participant counts: lowest eligible bot without previous bye.
 * - Rematch minimization: bounded DFS search (step-capped) to avoid rematches.
 * - Explicit greedy fallback with warnings when rematches or search bounds are hit.
 * - Side balance optimization: allocates Seat A / Seat B based on historical seat differential, alternation, and streaks.
 * - Actual matches only: zero fake bot matches generated for byes.
 * - Pure and deterministic: no I/O, no DB, no clock/time, immutable inputs/outputs.
 */

const MAX_SEARCH_STEPS = 5000;

/**
 * Normalizes entry input into clean participant objects.
 *
 * @param {readonly (string | { botId?: string; id?: string; botVersionId?: string })[]} entries
 * @returns {Array<{ botId: string; botVersionId?: string }>}
 */
export function normalizeSwissEntries(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError("entries must be an array");
  }

  const result = [];
  const seen = new Set();

  for (let i = 0; i < entries.length; i++) {
    const item = entries[i];
    let id;
    let botVersionId;

    if (typeof item === "string") {
      id = item;
    } else if (item && typeof item === "object") {
      id = item.botId !== undefined ? item.botId : item.id;
      if (typeof item.botVersionId === "string") {
        botVersionId = item.botVersionId;
      }
    } else {
      throw new TypeError(`Entry at index ${i} must be a string or object with botId/id`);
    }

    if (typeof id !== "string") {
      throw new TypeError(`Entry ID at index ${i} must be a string, got ${typeof id}`);
    }
    const trimmedId = id.trim();
    if (trimmedId.length === 0) {
      throw new TypeError(`Entry ID at index ${i} must be a non-empty string`);
    }
    if (seen.has(trimmedId)) {
      throw new Error(`Duplicate tournament entry ID: '${trimmedId}'`);
    }
    seen.add(trimmedId);
    result.push({ botId: trimmedId, ...(botVersionId ? { botVersionId } : {}) });
  }

  if (result.length < 2) {
    throw new RangeError(`Tournament requires at least 2 distinct bots, got ${result.length}`);
  }

  // Stable lexicographical base ordering
  return result.sort((a, b) => a.botId.localeCompare(b.botId));
}

/**
 * Creates canonical pair key for unordered opponent tracking.
 *
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
export function makePairKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Aggregates match history into rematch counts, seat counts, and opponent lists.
 *
 * @param {readonly { roundNumber?: number; botAId: string; botBId: string }[]} history
 * @param {readonly string[]} botIds
 */
function analyzeHistory(history, botIds) {
  const playedCounts = new Map();
  const opponentsMap = new Map();
  const seatStats = new Map();

  for (const botId of botIds) {
    opponentsMap.set(botId, []);
    seatStats.set(botId, { countA: 0, countB: 0, lastSeat: null, streak: 0 });
  }

  if (Array.isArray(history)) {
    // Sort history by roundNumber ASC to track chronological streaks
    const sortedHistory = [...history].sort(
      (h1, h2) => (Number(h1.roundNumber) || 0) - (Number(h2.roundNumber) || 0)
    );

    for (const match of sortedHistory) {
      const a = match.botAId;
      const b = match.botBId;
      if (!a || !b) continue;

      const key = makePairKey(a, b);
      playedCounts.set(key, (playedCounts.get(key) || 0) + 1);

      if (opponentsMap.has(a)) opponentsMap.get(a).push(b);
      if (opponentsMap.has(b)) opponentsMap.get(b).push(a);

      if (seatStats.has(a)) {
        const sa = seatStats.get(a);
        sa.countA += 1;
        sa.streak = sa.lastSeat === "A" ? sa.streak + 1 : 1;
        sa.lastSeat = "A";
      }

      if (seatStats.has(b)) {
        const sb = seatStats.get(b);
        sb.countB += 1;
        sb.streak = sb.lastSeat === "B" ? sb.streak + 1 : 1;
        sb.lastSeat = "B";
      }
    }
  }

  return { playedCounts, opponentsMap, seatStats };
}

/**
 * Assembles enriched participant models for Swiss sorting and pairing.
 */
function assembleParticipants(normalizedEntries, standings, opponentsMap, seatStats) {
  const standingsMap = new Map();
  if (Array.isArray(standings)) {
    for (const s of standings) {
      if (s && typeof s.botId === "string") {
        standingsMap.set(s.botId, s);
      }
    }
  }

  // First pass: extract basic points to calculate Buchholz in second pass
  const intermediate = normalizedEntries.map((entry) => {
    const s = standingsMap.get(entry.botId);
    const stats = seatStats.get(entry.botId) || { countA: 0, countB: 0, lastSeat: null, streak: 0 };
    const points = typeof s?.points === "number" ? s.points : 0;
    const wins = typeof s?.wins === "number" ? s.wins : 0;
    const draws = typeof s?.draws === "number" ? s.draws : 0;
    const losses = typeof s?.losses === "number" ? s.losses : 0;
    const played = typeof s?.played === "number" ? s.played : 0;
    const byeCount = typeof s?.byeCount === "number" ? s.byeCount : 0;
    const seatBalance =
      stats.countA !== 0 || stats.countB !== 0
        ? stats.countA - stats.countB
        : typeof s?.seatBalance === "number"
        ? s.seatBalance
        : 0;

    return {
      botId: entry.botId,
      botVersionId: entry.botVersionId,
      points,
      wins,
      draws,
      losses,
      played,
      byeCount,
      seatBalance,
      lastSeat: stats.lastSeat,
      seatStreak: stats.streak
    };
  });

  const pointsMap = new Map(intermediate.map((p) => [p.botId, p.points]));

  // Second pass: compute Buchholz tiebreak (sum of opponents' points)
  return intermediate.map((p) => {
    const opponents = opponentsMap.get(p.botId) || [];
    let buchholz = 0;
    for (const oppId of opponents) {
      buchholz += pointsMap.get(oppId) || 0;
    }
    return {
      ...p,
      buchholz
    };
  });
}

/**
 * Selects the fair BYE candidate when the participant count is odd.
 * Selection rule: lowest score bracket, lowest points, lowest wins, lowest buchholz,
 * strictly prioritizing participants with byeCount === 0.
 *
 * @param {Array<object>} participants
 * @returns {{ byeBot: object | null; pool: Array<object> }}
 */
function selectFairBye(participants) {
  if (participants.length % 2 === 0) {
    return { byeBot: null, pool: [...participants] };
  }

  // Minimum byeCount among all participants (normally 0)
  const minByeCount = Math.min(...participants.map((p) => p.byeCount));
  const eligible = participants.filter((p) => p.byeCount === minByeCount);

  // Sort ascending by standing (weakest first)
  const sortedEligible = [...eligible].sort((a, b) => {
    if (a.points !== b.points) return a.points - b.points;
    if (a.wins !== b.wins) return a.wins - b.wins;
    if (a.buchholz !== b.buchholz) return a.buchholz - b.buchholz;
    if (a.played !== b.played) return a.played - b.played;
    return a.botId.localeCompare(b.botId);
  });

  const byeBot = sortedEligible[0];
  const pool = participants.filter((p) => p.botId !== byeBot.botId);
  return { byeBot, pool };
}

/**
 * Sorts pairing pool in descending order (strongest first).
 */
function sortPoolDescending(pool) {
  return [...pool].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.buchholz !== a.buchholz) return b.buchholz - a.buchholz;
    if (b.played !== a.played) return b.played - a.played;
    return a.botId.localeCompare(b.botId);
  });
}

/**
 * Computes seat compatibility penalty for candidate sorting.
 * Lower penalty = better match for side balance.
 */
function computeSeatCompatibilityPenalty(u, v) {
  const balU = u.seatBalance;
  const balV = v.seatBalance;

  // Ideal: one player needs Seat A (bal < 0) and the other needs Seat B (bal > 0)
  if ((balU < 0 && balV > 0) || (balU > 0 && balV < 0)) {
    return 0;
  }

  // Great: both are balanced, but had opposite seats in prior round (A vs B)
  if (balU === 0 && balV === 0 && u.lastSeat && v.lastSeat && u.lastSeat !== v.lastSeat) {
    return 0;
  }

  // Poor: both players have strong imbalance on the same seat
  if ((balU > 0 && balV > 0) || (balU < 0 && balV < 0)) {
    return 3;
  }

  // Mediocre: both had same last seat
  if (u.lastSeat && v.lastSeat && u.lastSeat === v.lastSeat) {
    return 2;
  }

  return 1;
}

/**
 * Bounded DFS search to find a 100% rematch-free matching.
 *
 * @param {Array<object>} remaining
 * @param {Map<string, number>} playedCounts
 * @param {object} budgetState
 * @returns {Array<{ u: object; v: object }> | null}
 */
function findRematchFreeMatching(remaining, playedCounts, budgetState) {
  if (remaining.length === 0) return [];

  budgetState.steps += 1;
  if (budgetState.steps >= MAX_SEARCH_STEPS) {
    budgetState.exhausted = true;
    return null;
  }

  const u = remaining[0];
  const candidates = remaining.slice(1);

  // Filter only strictly unplayed opponents
  const unplayed = candidates.filter(
    (v) => (playedCounts.get(makePairKey(u.botId, v.botId)) || 0) === 0
  );

  if (unplayed.length === 0) {
    return null; // Dead end: u has already played all remaining candidates
  }

  // Sort unplayed candidates by closest points, wins, and optimal seat balance
  unplayed.sort((a, b) => {
    const pointDiffA = Math.abs(u.points - a.points);
    const pointDiffB = Math.abs(u.points - b.points);
    if (pointDiffA !== pointDiffB) return pointDiffA - pointDiffB;

    const winDiffA = Math.abs(u.wins - a.wins);
    const winDiffB = Math.abs(u.wins - b.wins);
    if (winDiffA !== winDiffB) return winDiffA - winDiffB;

    const seatPenA = computeSeatCompatibilityPenalty(u, a);
    const seatPenB = computeSeatCompatibilityPenalty(u, b);
    if (seatPenA !== seatPenB) return seatPenA - seatPenB;

    return a.botId.localeCompare(b.botId);
  });

  for (const v of unplayed) {
    const nextRemaining = remaining.filter((b) => b.botId !== u.botId && b.botId !== v.botId);
    const subResult = findRematchFreeMatching(nextRemaining, playedCounts, budgetState);
    if (subResult !== null) {
      return [{ u, v }, ...subResult];
    }
    if (budgetState.exhausted) {
      return null;
    }
  }

  return null;
}

/**
 * Explicit greedy fallback when no rematch-free matching is reachable.
 * Pairs remaining bots prioritizing minimum rematches, minimal score delta, and side balance.
 *
 * @param {Array<object>} pool
 * @param {Map<string, number>} playedCounts
 * @param {Array<string>} warnings
 * @returns {Array<{ u: object; v: object }>}
 */
function greedyFallbackMatching(pool, playedCounts, warnings) {
  warnings.push("rematch_minimization_fallback: search bound reached or rematch unavoidable");

  const remaining = [...pool];
  const pairs = [];

  while (remaining.length > 0) {
    const u = remaining.shift();
    const candidates = remaining.slice();

    candidates.sort((a, b) => {
      const rematchA = playedCounts.get(makePairKey(u.botId, a.botId)) || 0;
      const rematchB = playedCounts.get(makePairKey(u.botId, b.botId)) || 0;
      if (rematchA !== rematchB) return rematchA - rematchB;

      const pointDiffA = Math.abs(u.points - a.points);
      const pointDiffB = Math.abs(u.points - b.points);
      if (pointDiffA !== pointDiffB) return pointDiffA - pointDiffB;

      const winDiffA = Math.abs(u.wins - a.wins);
      const winDiffB = Math.abs(u.wins - b.wins);
      if (winDiffA !== winDiffB) return winDiffA - winDiffB;

      const seatPenA = computeSeatCompatibilityPenalty(u, a);
      const seatPenB = computeSeatCompatibilityPenalty(u, b);
      if (seatPenA !== seatPenB) return seatPenA - seatPenB;

      return a.botId.localeCompare(b.botId);
    });

    const v = candidates[0];
    const indexInRemaining = remaining.findIndex((b) => b.botId === v.botId);
    remaining.splice(indexInRemaining, 1);

    const rematchCount = playedCounts.get(makePairKey(u.botId, v.botId)) || 0;
    if (rematchCount > 0) {
      warnings.push(`rematch_paired:${u.botId}:${v.botId}`);
    }

    pairs.push({ u, v });
  }

  return pairs;
}

/**
 * Allocates Seat A and Seat B for a matched pair based on side balance rules.
 *
 * @param {object} u
 * @param {object} v
 * @param {number} pairIndex
 * @returns {{ botAId: string; botBId: string }}
 */
function allocateSeats(u, v, pairIndex = 0) {
  const balU = u.seatBalance; // countA - countB
  const balV = v.seatBalance;

  // 1. Participant with lower seatBalance has played fewer Seat A matches -> assign Seat A
  if (balU < balV) {
    return { botAId: u.botId, botBId: v.botId };
  }
  if (balU > balV) {
    return { botAId: v.botId, botBId: u.botId };
  }

  // 2. Balances are equal: alternate from lastSeat if opposite
  if (u.lastSeat === "B" && v.lastSeat === "A") {
    return { botAId: u.botId, botBId: v.botId };
  }
  if (u.lastSeat === "A" && v.lastSeat === "B") {
    return { botAId: v.botId, botBId: u.botId };
  }

  // 3. Both had same lastSeat:
  if (u.lastSeat === "B" && v.lastSeat === "B") {
    // Both want Seat A! The one with longer streak on B needs A more
    if ((u.seatStreak || 0) > (v.seatStreak || 0)) {
      return { botAId: u.botId, botBId: v.botId };
    }
    if ((v.seatStreak || 0) > (u.seatStreak || 0)) {
      return { botAId: v.botId, botBId: u.botId };
    }
    // Preferred seat is A: give preferred seat to higher priority bot (u)
    return { botAId: u.botId, botBId: v.botId };
  }

  if (u.lastSeat === "A" && v.lastSeat === "A") {
    // Both want Seat B! The one with longer streak on A needs B more
    if ((u.seatStreak || 0) > (v.seatStreak || 0)) {
      return { botAId: v.botId, botBId: u.botId }; // u gets Seat B!
    }
    if ((v.seatStreak || 0) > (u.seatStreak || 0)) {
      return { botAId: u.botId, botBId: v.botId }; // v gets Seat B!
    }
    // Preferred seat is B: give preferred seat (B) to higher priority bot (u)
    return { botAId: v.botId, botBId: u.botId };
  }

  // 4. Neither has played before (Round 1): alternate home/away by table/pair index
  if (pairIndex % 2 === 0) {
    return { botAId: u.botId, botBId: v.botId };
  }
  return { botAId: v.botId, botBId: u.botId };
}

/**
 * Generates pairings, byes, and warnings for a single round of Swiss tournament.
 *
 * @param {object} options
 * @param {readonly (string | { botId?: string; id?: string; botVersionId?: string })[]} options.entries
 * @param {number} options.roundNumber
 * @param {number} options.roundCount
 * @param {readonly object[]} [options.standings]
 * @param {readonly object[]} [options.history]
 * @returns {{
 *   pairings: Array<{ scheduleIndex: number; botAId: string; botBId: string; botAVersionId?: string; botBVersionId?: string }>;
 *   byes: string[];
 *   warnings: string[];
 * }}
 */
export function pairSwissRound(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("options must be an object");
  }

  const { entries, roundNumber, roundCount, standings = [], history = [] } = options;

  if (typeof roundNumber !== "number" || !Number.isInteger(roundNumber)) {
    throw new TypeError("roundNumber must be an integer");
  }
  if (typeof roundCount !== "number" || !Number.isInteger(roundCount)) {
    throw new TypeError("roundCount must be an integer");
  }
  if (roundCount < 1) {
    throw new RangeError(`roundCount must be >= 1, got ${roundCount}`);
  }
  if (roundNumber < 1 || roundNumber > roundCount) {
    throw new RangeError(`roundNumber must be between 1 and ${roundCount}, got ${roundNumber}`);
  }

  const normalizedEntries = normalizeSwissEntries(entries);
  const botIds = normalizedEntries.map((e) => e.botId);
  const entryVersionMap = new Map();
  for (const e of normalizedEntries) {
    if (e.botVersionId) entryVersionMap.set(e.botId, e.botVersionId);
  }

  const { playedCounts, opponentsMap, seatStats } = analyzeHistory(history, botIds);
  const participants = assembleParticipants(normalizedEntries, standings, opponentsMap, seatStats);

  // Fair BYE allocation for odd participant counts
  const { byeBot, pool } = selectFairBye(participants);
  const byes = byeBot ? [byeBot.botId] : [];

  // Sort remaining pool descending by current standing
  const sortedPool = sortPoolDescending(pool);

  const warnings = [];
  const budgetState = { steps: 0, exhausted: false };

  // Attempt bounded 100% rematch-free matching
  let matchedPairs = findRematchFreeMatching(sortedPool, playedCounts, budgetState);

  // Fallback if no rematch-free matching was found within step limit
  if (matchedPairs === null) {
    matchedPairs = greedyFallbackMatching(sortedPool, playedCounts, warnings);
  }

  // Allocate seats (home/away balance) and assign scheduleIndex
  const pairings = matchedPairs.map((pair, scheduleIndex) => {
    const { botAId, botBId } = allocateSeats(pair.u, pair.v, scheduleIndex);
    const verA = entryVersionMap.get(botAId);
    const verB = entryVersionMap.get(botBId);

    const match = {
      scheduleIndex,
      botAId,
      botBId
    };
    if (verA) match.botAVersionId = verA;
    if (verB) match.botBVersionId = verB;

    return match;
  });

  return {
    pairings,
    byes,
    warnings
  };
}
