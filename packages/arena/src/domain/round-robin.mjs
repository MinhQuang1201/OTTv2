/**
 * domain/round-robin.mjs
 *
 * Pure Double Round-Robin (DRR) tournament pairing generator for OTTv2 Arena.
 *
 * Policy & Invariants:
 *   - Input bot IDs are validated, deduplicated-checked, and lexicographically sorted.
 *   - N < 2 is rejected (minimum 2 distinct participants).
 *   - Match count is exactly N * (N - 1) (e.g. N2=2, N3=6, N4=12).
 *   - Every unordered pair {u, v} appears exactly twice:
 *       once with u as seat A and v as seat B (Leg 1)
 *       once with v as seat A and u as seat B (Leg 2)
 *   - No self-pairing (botAId !== botBId).
 *   - Stable contiguous scheduleIndex: 0, 1, ..., N*(N-1) - 1.
 *   - Deterministic and pure: no random, no Node built-ins, no DB, no clock/time.
 */

/**
 * Validate tournament entries and return lexicographically sorted unique bot IDs.
 * Accepts an array of string IDs or objects with `botId` / `id`.
 *
 * @param {readonly (string | { botId?: string; id?: string })[]} entries
 * @returns {string[]} Sorted unique bot IDs
 */
export function validateTournamentEntries(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError("Tournament entries must be an array");
  }

  const botIds = [];
  const seen = new Set();

  for (let i = 0; i < entries.length; i++) {
    const item = entries[i];
    let id;
    if (typeof item === "string") {
      id = item;
    } else if (item && typeof item === "object") {
      id = item.botId !== undefined ? item.botId : item.id;
    } else {
      throw new TypeError(`Entry at index ${i} must be a string or object with botId/id`);
    }

    if (typeof id !== "string") {
      throw new TypeError(`Entry ID at index ${i} must be a string, got ${typeof id}`);
    }
    if (id.trim().length === 0) {
      throw new TypeError(`Entry ID at index ${i} must be a non-empty string`);
    }
    if (seen.has(id)) {
      throw new Error(`Duplicate tournament entry ID: '${id}'`);
    }
    seen.add(id);
    botIds.push(id);
  }

  if (botIds.length < 2) {
    throw new RangeError(`Tournament requires at least 2 distinct bots, got ${botIds.length}`);
  }

  // Deterministic lexicographical sort
  return botIds.sort();
}

/**
 * Compute the expected number of matches in a Double Round-Robin tournament for N bots.
 * Formula: N * (N - 1)
 *
 * @param {number} botCount
 * @returns {number}
 */
export function calculateDoubleRoundRobinMatchCount(botCount) {
  if (typeof botCount !== "number" || !Number.isInteger(botCount)) {
    throw new TypeError("botCount must be an integer number");
  }
  if (botCount < 2) {
    throw new RangeError(`Tournament requires at least 2 bots, got ${botCount}`);
  }
  return botCount * (botCount - 1);
}

/**
 * Generate a complete, stable, contiguous Double Round-Robin tournament schedule.
 *
 * Uses the Berger circle method for Leg 1, then inverts seats for Leg 2.
 * Output has contiguous scheduleIndex: 0 .. N*(N-1) - 1.
 *
 * @param {readonly (string | { botId?: string; id?: string; botVersionId?: string })[]} entries
 * @param {object} [options]
 * @returns {Array<{
 *   scheduleIndex: number;
 *   round: number;
 *   leg: 1 | 2;
 *   botAId: string;
 *   botBId: string;
 *   seatA: string;
 *   seatB: string;
 *   botAVersionId?: string;
 *   botBVersionId?: string;
 * }>}
 */
export function generateDoubleRoundRobinSchedule(entries, options = {}) {
  const sortedBotIds = validateTournamentEntries(entries);
  const n = sortedBotIds.length;

  // Map metadata if entries were provided as objects
  const entryMap = new Map();
  if (Array.isArray(entries)) {
    for (const item of entries) {
      if (item && typeof item === "object") {
        const id = item.botId !== undefined ? item.botId : item.id;
        if (typeof id === "string") {
          entryMap.set(id, item);
        }
      }
    }
  }

  // Berger circle algorithm
  const BYE = Symbol("BYE");
  const isOdd = n % 2 !== 0;
  const m = isOdd ? n + 1 : n;
  const numRounds = m - 1;

  // Initialize participant circle P
  const P = [...sortedBotIds];
  if (isOdd) {
    P.push(BYE);
  }

  const leg1Matches = [];
  let currentRound = 1;

  for (let r = 0; r < numRounds; r++) {
    const roundMatches = [];
    for (let i = 0; i < m / 2; i++) {
      const p1 = P[i];
      const p2 = P[m - 1 - i];

      if (p1 === BYE || p2 === BYE) {
        continue; // Bye match in odd-sized participant field
      }

      // Alternate home/away seats for fair balance
      let botAId;
      let botBId;
      if ((i + r) % 2 === 0) {
        botAId = p1;
        botBId = p2;
      } else {
        botAId = p2;
        botBId = p1;
      }

      const match = {
        round: currentRound,
        leg: 1,
        botAId,
        botBId,
        seatA: botAId,
        seatB: botBId
      };

      const metaA = entryMap.get(botAId);
      const metaB = entryMap.get(botBId);
      if (metaA?.botVersionId !== undefined) {
        match.botAVersionId = metaA.botVersionId;
      }
      if (metaB?.botVersionId !== undefined) {
        match.botBVersionId = metaB.botVersionId;
      }

      roundMatches.push(match);
    }

    leg1Matches.push(...roundMatches);
    currentRound++;

    // Rotate P: keep P[0] fixed, rotate P[1 .. m-1] cyclically
    const last = P.pop();
    P.splice(1, 0, last);
  }

  // Leg 2: reverse home/away seats for each Leg 1 match
  const leg2Matches = leg1Matches.map((m1) => {
    const match = {
      round: m1.round + numRounds,
      leg: 2,
      botAId: m1.botBId,
      botBId: m1.botAId,
      seatA: m1.botBId,
      seatB: m1.botAId
    };
    if (m1.botBVersionId !== undefined) {
      match.botAVersionId = m1.botBVersionId;
    }
    if (m1.botAVersionId !== undefined) {
      match.botBVersionId = m1.botAVersionId;
    }
    return match;
  });

  const allMatches = [...leg1Matches, ...leg2Matches];

  // Assign stable contiguous scheduleIndex: 0 .. total - 1
  return allMatches.map((match, scheduleIndex) => ({
    scheduleIndex,
    ...match
  }));
}

export const createDoubleRoundRobinSchedule = generateDoubleRoundRobinSchedule;
