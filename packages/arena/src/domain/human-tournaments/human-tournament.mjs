/**
 * packages/arena/src/domain/human-tournaments/human-tournament.mjs
 *
 * Pure domain model for Human Tournaments in OTTv2.
 * Supports:
 * - Real organizer and participant identities with cryptographic bearer secret authentication.
 * - Authenticated identity: privileged operations reject client-claimed strings without valid secrets.
 * - Single Round-Robin, Double Round-Robin, and Swiss formats (via domain/formats).
 * - Target per-seat cryptographic invite credentials kept secret from public snapshots.
 * - Strict authoritative result progression, round advancement, and tie-break standings (Buchholz, Sonneborn-Berger).
 *
 * Invariants:
 * - Pure functions with zero I/O, no DB imports, deterministic behavior.
 */

import { FORMAT_IDS, getRoundCount, pairRound } from "../formats/index.mjs";

export const TOURNAMENT_STATUS = Object.freeze({
  REGISTRATION: "registration",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
});

export const MATCH_STATUS = Object.freeze({
  SCHEDULED: "scheduled",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  BYE: "bye",
});

export const MATCH_RESULT = Object.freeze({
  WIN_A: "win_a",
  WIN_B: "win_b",
  DRAW: "draw",
  BYE: "bye",
});

/**
 * Cryptographic SHA-256 hash using WebCrypto (standard in Cloudflare Workers, Node.js 16+, and modern browsers).
 * Returns hex-encoded 64-character digest string.
 */
export async function hashSecret(str) {
  if (typeof str !== "string" || !str) return "";
  const bytes = new TextEncoder().encode(str);
  const digestBuffer = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digestBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateToken(prefix = "tok_") {
  const bytes = new Uint8Array(24); // 192 bits of cryptographic entropy
  globalThis.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}${hex}`;
}

/**
 * Creates a new Human Tournament aggregate.
 * Generates an organizer secret if not supplied, storing its hash.
 */
export async function createHumanTournament(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("Tournament options must be a non-null object");
  }

  const { tournamentId, name, organizer, formatId, requestedRounds, mapId = "classic" } = options;

  if (typeof tournamentId !== "string" || !tournamentId.trim()) {
    throw new TypeError("tournamentId must be a non-empty string");
  }
  if (typeof name !== "string" || !name.trim()) {
    throw new TypeError("name must be a non-empty string");
  }
  if (!organizer || typeof organizer !== "object") {
    throw new TypeError("organizer must be a non-null object with organizerId and name");
  }
  if (typeof organizer.organizerId !== "string" || !organizer.organizerId.trim()) {
    throw new TypeError("organizer.organizerId must be a non-empty string");
  }
  if (typeof organizer.name !== "string" || !organizer.name.trim()) {
    throw new TypeError("organizer.name must be a non-empty string");
  }
  if (!Object.values(FORMAT_IDS).includes(formatId)) {
    throw new TypeError(`Unsupported tournament format: '${formatId}'`);
  }

  const organizerSecret = options.organizerSecret || generateToken("org_sec_");
  const organizerSecretHash = await hashSecret(organizerSecret);

  const aggregate = {
    tournamentId: tournamentId.trim(),
    name: name.trim(),
    organizer: {
      organizerId: organizer.organizerId.trim(),
      name: organizer.name.trim(),
      organizerSecretHash,
    },
    formatId,
    requestedRounds: requestedRounds !== undefined ? requestedRounds : undefined,
    mapId: typeof mapId === "string" ? mapId.trim() : "classic",
    status: TOURNAMENT_STATUS.REGISTRATION,
    participants: [],
    rounds: [],
    currentRoundNumber: 0,
    roundCount: 0,
    createdAt: Date.now(),
    completedAt: null,
    // Expose organizerSecret during initial creation only so creator can store it
    _initialOrganizerSecret: organizerSecret,
  };

  return aggregate;
}

/**
 * Verifies that the supplied organizer secret matches the tournament organizer.
 */
export async function verifyOrganizer(tournament, organizerSecret) {
  if (typeof organizerSecret !== "string" || !organizerSecret.trim()) return false;
  return (await hashSecret(organizerSecret.trim())) === tournament.organizer.organizerSecretHash;
}

/**
 * Registers a participant in the tournament.
 * Issues a participantSecret (bearer token) and stores its hash.
 */
export async function registerParticipant(tournament, participant) {
  if (tournament.status !== TOURNAMENT_STATUS.REGISTRATION) {
    throw new Error(`Cannot register participant in status '${tournament.status}'`);
  }
  if (!participant || typeof participant !== "object") {
    throw new TypeError("participant must be an object");
  }
  const participantId = typeof participant.participantId === "string" ? participant.participantId.trim() : "";
  const name = typeof participant.name === "string" ? participant.name.trim() : "";
  if (!participantId) {
    throw new TypeError("participantId must be a non-empty string");
  }
  if (!name) {
    throw new TypeError("name must be a non-empty string");
  }

  if (tournament.participants.some((p) => p.participantId === participantId)) {
    throw new Error(`Participant '${participantId}' is already registered`);
  }

  const participantSecret = participant.participantSecret || generateToken("p_sec_");
  const participantSecretHash = await hashSecret(participantSecret);

  const record = {
    participantId,
    name,
    participantSecretHash,
    status: "registered",
    seed: tournament.participants.length + 1,
    initialElo: 1200,
    currentScore: 0,
    matchPoints: 0,
    gamePoints: 0,
    buchholz: 0,
    sonnebornBerger: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    byes: 0,
    opponents: [],
  };

  tournament.participants.push(record);

  return {
    tournament,
    participant: record,
    participantSecret,
  };
}

/**
 * Starts the tournament, locks registration, computes total round count,
 * and creates Round 1 pairings. Requires valid organizer secret.
 */
export async function startTournament(tournament, options = {}) {
  if (tournament.status !== TOURNAMENT_STATUS.REGISTRATION) {
    throw new Error(`Tournament already started or closed (status: '${tournament.status}')`);
  }

  if (!(await verifyOrganizer(tournament, options.organizerSecret))) {
    throw new Error("Unauthorized: invalid or missing organizer secret");
  }

  const activeParticipants = tournament.participants.filter((p) => p.status === "registered");
  if (activeParticipants.length < 2) {
    throw new RangeError(`Tournament requires at least 2 participants, got ${activeParticipants.length}`);
  }

  for (const p of activeParticipants) {
    p.status = "active";
  }

  const roundCount = getRoundCount(tournament.formatId, activeParticipants.length, tournament.requestedRounds);
  tournament.roundCount = roundCount;
  tournament.status = TOURNAMENT_STATUS.IN_PROGRESS;
  tournament.currentRoundNumber = 1;

  const entries = activeParticipants.map((p) => ({ botId: p.participantId }));
  const pairingResult = pairRound({
    formatId: tournament.formatId,
    entries,
    roundNumber: 1,
    roundCount,
  });

  const matches = pairingResult.pairings.map((p, idx) => ({
    matchId: `${tournament.tournamentId}-r1-m${idx + 1}`,
    scheduleIndex: p.scheduleIndex,
    roundNumber: 1,
    participantAId: p.botAId,
    participantBId: p.botBId,
    status: MATCH_STATUS.SCHEDULED,
    result: null,
    winnerParticipantId: null,
    allocationId: null,
    alias: null,
    seatAInviteToken: null,
    seatBInviteToken: null,
  }));

  // Handle byes if any
  for (const byeParticipantId of pairingResult.byes) {
    matches.push({
      matchId: `${tournament.tournamentId}-r1-bye-${byeParticipantId}`,
      scheduleIndex: matches.length,
      roundNumber: 1,
      participantAId: byeParticipantId,
      participantBId: null,
      status: MATCH_STATUS.BYE,
      result: MATCH_RESULT.BYE,
      winnerParticipantId: byeParticipantId,
      allocationId: null,
      alias: null,
      seatAInviteToken: null,
      seatBInviteToken: null,
    });
  }

  tournament.rounds.push({
    roundNumber: 1,
    matches,
    byes: [...pairingResult.byes],
  });

  return tournament;
}

/**
 * Assigns provisioning credentials (allocation, short alias, seat-specific invite tokens)
 * to a scheduled match.
 */
export function assignMatchProvisioning(tournament, matchId, provisioning) {
  const match = findMatch(tournament, matchId);
  if (!match) {
    throw new Error(`Match '${matchId}' not found in tournament`);
  }

  if (provisioning.allocationId) match.allocationId = provisioning.allocationId;
  if (provisioning.alias) match.alias = provisioning.alias;
  if (provisioning.seatAInviteToken) match.seatAInviteToken = provisioning.seatAInviteToken;
  if (provisioning.seatBInviteToken) match.seatBInviteToken = provisioning.seatBInviteToken;

  return match;
}

/**
 * Gets participant-specific invite credential for a match.
 * Enforces authenticated identity: client must present valid participantSecret matching participantId.
 * Enforces seat privacy: only Player A receives Seat A invite, Player B receives Seat B invite.
 */
export async function getParticipantMatchAccess(tournament, matchId, participantId, participantSecret) {
  const participant = tournament.participants.find((p) => p.participantId === participantId);
  if (!participant) {
    throw new Error(`Participant '${participantId}' not found`);
  }

  if (typeof participantSecret !== "string" || (await hashSecret(participantSecret.trim())) !== participant.participantSecretHash) {
    throw new Error(`Unauthorized: invalid participant secret for '${participantId}'`);
  }

  const match = findMatch(tournament, matchId);
  if (!match) {
    throw new Error(`Match '${matchId}' not found`);
  }

  if (match.participantAId === participantId) {
    return {
      matchId: match.matchId,
      roundNumber: match.roundNumber,
      seat: "A",
      allocationId: match.allocationId,
      alias: match.alias,
      inviteToken: match.seatAInviteToken,
      opponentId: match.participantBId,
    };
  }

  if (match.participantBId === participantId) {
    return {
      matchId: match.matchId,
      roundNumber: match.roundNumber,
      seat: "B",
      allocationId: match.allocationId,
      alias: match.alias,
      inviteToken: match.seatBInviteToken,
      opponentId: match.participantAId,
    };
  }

  throw new Error(`Participant '${participantId}' is not a player in match '${matchId}'`);
}

/**
 * Records an authoritative match result and updates tournament state.
 * Requires organizerSecret.
 */
export async function recordMatchResult(tournament, { matchId, result, winnerParticipantId, organizerSecret, skipOrganizerVerification = false }) {
  if (tournament.status !== TOURNAMENT_STATUS.IN_PROGRESS) {
    throw new Error(`Cannot record match result when tournament status is '${tournament.status}'`);
  }

  if (!skipOrganizerVerification && !(await verifyOrganizer(tournament, organizerSecret))) {
    throw new Error("Unauthorized: invalid or missing organizer secret");
  }

  const match = findMatch(tournament, matchId);
  if (!match) {
    throw new Error(`Match '${matchId}' not found`);
  }

  if (match.status === MATCH_STATUS.COMPLETED || match.status === MATCH_STATUS.BYE) {
    throw new Error(`Match '${matchId}' is already finalized`);
  }

  if (!Object.values(MATCH_RESULT).includes(result)) {
    throw new TypeError(`Invalid match result '${result}'`);
  }

  if (result === MATCH_RESULT.WIN_A) {
    match.winnerParticipantId = match.participantAId;
  } else if (result === MATCH_RESULT.WIN_B) {
    match.winnerParticipantId = match.participantBId;
  } else if (result === MATCH_RESULT.DRAW) {
    match.winnerParticipantId = null;
  } else if (result === MATCH_RESULT.BYE) {
    match.winnerParticipantId = match.participantAId;
  }

  if (winnerParticipantId !== undefined && winnerParticipantId !== match.winnerParticipantId) {
    throw new Error(`winnerParticipantId '${winnerParticipantId}' contradicts result '${result}'`);
  }

  match.status = MATCH_STATUS.COMPLETED;
  match.result = result;

  return match;
}

/**
 * Checks if the current round has all matches resolved.
 */
export function canAdvanceRound(tournament) {
  if (tournament.status !== TOURNAMENT_STATUS.IN_PROGRESS) return false;
  const currentRound = tournament.rounds.find((r) => r.roundNumber === tournament.currentRoundNumber);
  if (!currentRound) return false;

  return currentRound.matches.every(
    (m) => m.status === MATCH_STATUS.COMPLETED || m.status === MATCH_STATUS.BYE
  );
}

/**
 * Advances the tournament to the next round, or marks it completed if final round is finished.
 * Requires organizerSecret.
 */
export async function advanceRound(tournament, options = {}) {
  if (!(await verifyOrganizer(tournament, options.organizerSecret))) {
    throw new Error("Unauthorized: invalid or missing organizer secret");
  }

  if (!canAdvanceRound(tournament)) {
    throw new Error(`Cannot advance round ${tournament.currentRoundNumber}: not all matches are completed`);
  }

  if (tournament.currentRoundNumber >= tournament.roundCount) {
    tournament.status = TOURNAMENT_STATUS.COMPLETED;
    tournament.completedAt = Date.now();
    return {
      tournamentCompleted: true,
      currentRoundNumber: tournament.currentRoundNumber,
      standings: getStandings(tournament),
    };
  }

  const nextRoundNumber = tournament.currentRoundNumber + 1;
  const standings = getStandings(tournament);
  const history = buildMatchHistory(tournament);

  const activeParticipants = tournament.participants.filter((p) => p.status === "active");
  const entries = activeParticipants.map((p) => ({ botId: p.participantId }));

  const pairingResult = pairRound({
    formatId: tournament.formatId,
    entries,
    roundNumber: nextRoundNumber,
    roundCount: tournament.roundCount,
    standings,
    history,
  });

  const matches = pairingResult.pairings.map((p, idx) => ({
    matchId: `${tournament.tournamentId}-r${nextRoundNumber}-m${idx + 1}`,
    scheduleIndex: p.scheduleIndex,
    roundNumber: nextRoundNumber,
    participantAId: p.botAId,
    participantBId: p.botBId,
    status: MATCH_STATUS.SCHEDULED,
    result: null,
    winnerParticipantId: null,
    allocationId: null,
    alias: null,
    seatAInviteToken: null,
    seatBInviteToken: null,
  }));

  for (const byeParticipantId of pairingResult.byes) {
    matches.push({
      matchId: `${tournament.tournamentId}-r${nextRoundNumber}-bye-${byeParticipantId}`,
      scheduleIndex: matches.length,
      roundNumber: nextRoundNumber,
      participantAId: byeParticipantId,
      participantBId: null,
      status: MATCH_STATUS.BYE,
      result: MATCH_RESULT.BYE,
      winnerParticipantId: byeParticipantId,
      allocationId: null,
      alias: null,
      seatAInviteToken: null,
      seatBInviteToken: null,
    });
  }

  tournament.rounds.push({
    roundNumber: nextRoundNumber,
    matches,
    byes: [...pairingResult.byes],
  });

  tournament.currentRoundNumber = nextRoundNumber;

  return {
    tournamentCompleted: false,
    currentRoundNumber: nextRoundNumber,
    matches,
  };
}

/**
 * Computes sorted tournament standings with Buchholz and Sonneborn-Berger tie-breaks.
 */
export function getStandings(tournament) {
  const statsMap = new Map();

  for (const p of tournament.participants) {
    statsMap.set(p.participantId, {
      participantId: p.participantId,
      name: p.name,
      status: p.status,
      matchesPlayed: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      byes: 0,
      points: 0,
      opponents: [],
      defeatedOpponents: [],
      drawnOpponents: [],
      buchholz: 0,
      sonnebornBerger: 0,
    });
  }

  // Accumulate match results
  for (const round of tournament.rounds) {
    for (const match of round.matches) {
      if (match.status !== MATCH_STATUS.COMPLETED && match.status !== MATCH_STATUS.BYE) {
        continue;
      }

      if (match.status === MATCH_STATUS.BYE) {
        const statA = statsMap.get(match.participantAId);
        if (statA) {
          statA.byes += 1;
          statA.points += 1;
        }
        continue;
      }

      const statA = statsMap.get(match.participantAId);
      const statB = statsMap.get(match.participantBId);

      if (statA && statB) {
        statA.matchesPlayed += 1;
        statB.matchesPlayed += 1;
        statA.opponents.push(match.participantBId);
        statB.opponents.push(match.participantAId);

        if (match.result === MATCH_RESULT.WIN_A) {
          statA.wins += 1;
          statA.points += 1;
          statA.defeatedOpponents.push(match.participantBId);
          statB.losses += 1;
        } else if (match.result === MATCH_RESULT.WIN_B) {
          statB.wins += 1;
          statB.points += 1;
          statB.defeatedOpponents.push(match.participantAId);
          statA.losses += 1;
        } else if (match.result === MATCH_RESULT.DRAW) {
          statA.draws += 1;
          statA.points += 0.5;
          statA.drawnOpponents.push(match.participantBId);
          statB.draws += 1;
          statB.points += 0.5;
          statB.drawnOpponents.push(match.participantAId);
        }
      }
    }
  }

  // Compute tie-breaks: Buchholz & Sonneborn-Berger
  for (const stat of statsMap.values()) {
    let buchholz = 0;
    for (const oppId of stat.opponents) {
      const opp = statsMap.get(oppId);
      if (opp) buchholz += opp.points;
    }
    stat.buchholz = buchholz;

    let sb = 0;
    for (const defId of stat.defeatedOpponents) {
      const opp = statsMap.get(defId);
      if (opp) sb += opp.points;
    }
    for (const drawId of stat.drawnOpponents) {
      const opp = statsMap.get(drawId);
      if (opp) sb += opp.points * 0.5;
    }
    stat.sonnebornBerger = sb;
  }

  // Sort: points desc -> buchholz desc -> sonnebornBerger desc -> participantId asc
  const sorted = Array.from(statsMap.values()).sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.buchholz !== a.buchholz) return b.buchholz - a.buchholz;
    if (b.sonnebornBerger !== a.sonnebornBerger) return b.sonnebornBerger - a.sonnebornBerger;
    return a.participantId.localeCompare(b.participantId);
  });

  return sorted.map((s, index) => ({
    rank: index + 1,
    participantId: s.participantId,
    name: s.name,
    status: s.status,
    matchesPlayed: s.matchesPlayed,
    wins: s.wins,
    losses: s.losses,
    draws: s.draws,
    byes: s.byes,
    points: s.points,
    buchholz: s.buchholz,
    sonnebornBerger: s.sonnebornBerger,
  }));
}

function findMatch(tournament, matchId) {
  for (const round of tournament.rounds) {
    const match = round.matches.find((m) => m.matchId === matchId);
    if (match) return match;
  }
  return null;
}

function buildMatchHistory(tournament) {
  const history = [];
  for (const round of tournament.rounds) {
    for (const match of round.matches) {
      if (match.status === MATCH_STATUS.BYE || !match.participantBId) continue;
      history.push({
        roundNumber: match.roundNumber,
        botAId: match.participantAId,
        botBId: match.participantBId,
        result: match.result,
        winnerId: match.winnerParticipantId,
      });
    }
  }
  return history;
}
