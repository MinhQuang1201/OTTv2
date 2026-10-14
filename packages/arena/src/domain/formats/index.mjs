/**
 * packages/arena/src/domain/formats/index.mjs
 *
 * Tournament format strategies and registry for OTTv2 Arena.
 *
 * Supported formats:
 * - single-round-robin
 * - double-round-robin
 * - swiss
 *
 * Strict invariants:
 * - Pure, deterministic functions: no I/O, no DB, no clock/time.
 * - Exact contracts per ARENA_ROUNDS_MAPS_MODES_PLAN.local.md:
 *   listFormats(), getRoundCount(formatId, participantCount, requestedRounds?),
 *   pairRound({ formatId, entries, roundNumber, roundCount, standings, history }).
 */

import { pairSwissRound, normalizeSwissEntries } from "./swiss.mjs";

export const FORMAT_IDS = Object.freeze({
  SINGLE_ROUND_ROBIN: "single-round-robin",
  DOUBLE_ROUND_ROBIN: "double-round-robin",
  SWISS: "swiss"
});

export const FORMAT_DESCRIPTORS = Object.freeze([
  Object.freeze({
    id: FORMAT_IDS.SINGLE_ROUND_ROBIN,
    name: "Single Round-Robin",
    description: "Every participant plays every other participant once."
  }),
  Object.freeze({
    id: FORMAT_IDS.DOUBLE_ROUND_ROBIN,
    name: "Double Round-Robin",
    description: "Every participant plays every other participant twice, alternating seats."
  }),
  Object.freeze({
    id: FORMAT_IDS.SWISS,
    name: "Swiss System",
    description:
      "Score-grouped pairing with rematch minimization, fair byes for odd participant counts, and side balance."
  })
]);

const FORMAT_MAP = new Map(FORMAT_DESCRIPTORS.map((d) => [d.id, d]));

/**
 * Returns available tournament format descriptors.
 *
 * @returns {Array<{ id: string; name: string; description: string }>}
 */
export function listFormats() {
  return FORMAT_DESCRIPTORS.map((d) => ({ ...d }));
}

/**
 * Retrieves a format descriptor by ID.
 *
 * @param {string} formatId
 * @returns {{ id: string; name: string; description: string } | undefined}
 */
export function getFormat(formatId) {
  const descriptor = FORMAT_MAP.get(formatId);
  return descriptor ? { ...descriptor } : undefined;
}

/**
 * Computes the total round count for a tournament format given participant count.
 *
 * @param {string} formatId
 * @param {number} participantCount
 * @param {number} [requestedRounds]
 * @returns {number} Total expected rounds
 */
export function getRoundCount(formatId, participantCount, requestedRounds) {
  if (typeof formatId !== "string" || !FORMAT_MAP.has(formatId)) {
    throw new TypeError(
      `Unknown tournament format: '${formatId}'. Supported formats: ${Array.from(FORMAT_MAP.keys()).join(", ")}`
    );
  }

  if (typeof participantCount !== "number" || !Number.isInteger(participantCount)) {
    throw new TypeError("participantCount must be an integer");
  }

  if (participantCount < 2) {
    throw new RangeError(`Tournament requires at least 2 participants, got ${participantCount}`);
  }

  const isOdd = participantCount % 2 !== 0;
  const m = isOdd ? participantCount + 1 : participantCount;
  const singleRounds = m - 1;

  switch (formatId) {
    case FORMAT_IDS.SINGLE_ROUND_ROBIN:
      return singleRounds;

    case FORMAT_IDS.DOUBLE_ROUND_ROBIN:
      return singleRounds * 2;

    case FORMAT_IDS.SWISS: {
      if (participantCount === 2) {
        return 1;
      }

      const maxAllowed = Math.min(32, participantCount - 1);

      if (requestedRounds !== undefined) {
        if (typeof requestedRounds !== "number" || !Number.isInteger(requestedRounds)) {
          throw new TypeError("requestedRounds must be an integer");
        }
        if (requestedRounds < 1 || requestedRounds > maxAllowed) {
          throw new RangeError(
            `Swiss requestedRounds must be between 1 and ${maxAllowed} for ${participantCount} participants, got ${requestedRounds}`
          );
        }
        return requestedRounds;
      }

      // Default Swiss rounds: ceil(log2(N)), bounded by maxAllowed
      const defaultRounds = Math.ceil(Math.log2(participantCount));
      return Math.min(maxAllowed, Math.max(1, defaultRounds));
    }

    default:
      throw new TypeError(`Unhandled format ID: '${formatId}'`);
  }
}

/**
 * Pairs a single round for Round-Robin (single or double).
 *
 * @param {object} options
 */
function pairRoundRobinRound(options) {
  const { formatId, entries, roundNumber } = options;

  const normalizedEntries = normalizeSwissEntries(entries);
  const n = normalizedEntries.length;
  const botIds = normalizedEntries.map((e) => e.botId);

  const entryVersionMap = new Map();
  for (const e of normalizedEntries) {
    if (e.botVersionId) entryVersionMap.set(e.botId, e.botVersionId);
  }

  const isOdd = n % 2 !== 0;
  const m = isOdd ? n + 1 : n;
  const singleRounds = m - 1;

  const isDouble = formatId === FORMAT_IDS.DOUBLE_ROUND_ROBIN;
  const isLeg2 = isDouble && roundNumber > singleRounds;
  const r = isLeg2 ? roundNumber - singleRounds - 1 : roundNumber - 1;

  const BYE = Symbol("BYE");
  const P = [...botIds];
  if (isOdd) {
    P.push(BYE);
  }

  // Berger circle rotation by r steps
  for (let step = 0; step < r; step++) {
    const last = P.pop();
    P.splice(1, 0, last);
  }

  const pairings = [];
  const byes = [];
  let scheduleIndex = 0;

  for (let i = 0; i < m / 2; i++) {
    const p1 = P[i];
    const p2 = P[m - 1 - i];

    if (p1 === BYE) {
      byes.push(p2);
      continue;
    }
    if (p2 === BYE) {
      byes.push(p1);
      continue;
    }

    // Home / away seat balance
    let botAId;
    let botBId;
    if ((i + r) % 2 === 0) {
      botAId = p1;
      botBId = p2;
    } else {
      botAId = p2;
      botBId = p1;
    }

    // In Leg 2, swap seats
    if (isLeg2) {
      const temp = botAId;
      botAId = botBId;
      botBId = temp;
    }

    const match = {
      scheduleIndex: scheduleIndex++,
      botAId,
      botBId
    };

    const verA = entryVersionMap.get(botAId);
    const verB = entryVersionMap.get(botBId);
    if (verA) match.botAVersionId = verA;
    if (verB) match.botBVersionId = verB;

    pairings.push(match);
  }

  return {
    pairings,
    byes,
    warnings: []
  };
}

/**
 * Universal round pairing entrypoint for all supported formats.
 *
 * @param {object} options
 * @param {string} options.formatId
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
export function pairRound(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("options must be a non-null object");
  }

  const { formatId, roundNumber, roundCount } = options;
  if (typeof formatId !== "string" || !FORMAT_MAP.has(formatId)) {
    throw new TypeError(
      `Unknown tournament format: '${formatId}'. Supported formats: ${Array.from(FORMAT_MAP.keys()).join(", ")}`
    );
  }

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

  if (formatId === FORMAT_IDS.SWISS) {
    return pairSwissRound(options);
  }

  return pairRoundRobinRound(options);
}
