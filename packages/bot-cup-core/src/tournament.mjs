/**
 * Tournament rules (plan §7): sealing at code freeze, the gate, choosing the qualifying format, round robin, Swiss,
 * standings with their tie-breaks, the knockout bracket with tie-break games, the Top 4 interview, appeals. Pure: callers
 * pass results and, where a draw is needed, a random source.
 */
import { generateDoubleRoundRobinSchedule } from "../../arena/src/domain/round-robin.mjs";
import { pairSwissRound } from "../../arena/src/domain/formats/swiss.mjs";
import { MAPS } from "./replay.mjs";
import { SUBMISSION_STATUS, effectiveFinalSubmission } from "./submission.mjs";

const HOUR = 60 * 60 * 1000;

export const GATE_POLICY = Object.freeze({ opponent: "easy", passPoints: 4, games: 6 });
export const ROUND_ROBIN_MAX_TEAMS = 10;
export const KNOCKOUT_SIZE = Object.freeze({ demo: 4, production: 16 });
export const KNOCKOUT_MAX_TIEBREAKS = 2;
export const SWISS_BYE_POINTS = 2;
export const APPEAL_POLICY = Object.freeze({ maxPerStage: 3, windowMs: { demo: 12 * HOUR, production: 24 * HOUR }, bodyMax: 2000 });

/** Event phases in order; the organisers move the event forward one step at a time. */
export const PHASES = Object.freeze(["registration", "frozen", "gate", "qualifying", "verification", "knockout", "finished"]);

// ---------- code freeze and gate ----------

/**
 * The submission sealed at code freeze (plan §6.2, §8.2): the team's choice if it passed its checks, else its newest
 * `ready` version. A version still being checked is not sealed.
 */
export function sealedSubmission(submissions, chosenId) {
  return effectiveFinalSubmission(submissions.filter((submission) => submission.status === SUBMISSION_STATUS.READY), chosenId);
}

/** Six games against the easy house bot: three maps, each colour once (plan §7.4). */
export function gateGames(submissionId) {
  return MAPS.flatMap((mapId, index) => [
    { gameIndex: index * 2, mapId, a: { submissionId }, b: { house: GATE_POLICY.opponent } },
    { gameIndex: index * 2 + 1, mapId, a: { house: GATE_POLICY.opponent }, b: { submissionId } }
  ]);
}

/**
 * @param {Array<{ status: string, points: number }>} games the team's points in each gate game
 * @returns {null | { status: "qualified"|"not_qualified", points: number }} null while games are unfinished
 */
export function gateVerdict(games) {
  if (games.length < GATE_POLICY.games || games.some((game) => game.status !== "finished")) return null;
  const points = games.reduce((sum, game) => sum + game.points, 0);
  return { status: points >= GATE_POLICY.passPoints ? "qualified" : "not_qualified", points };
}

// ---------- qualifying format ----------

/** Plan §0: round robin up to 10 teams, Swiss above; nothing to play with fewer than 2. */
export function chooseFormat(qualifiedCount) {
  if (qualifiedCount < 2) return "none";
  return qualifiedCount <= ROUND_ROBIN_MAX_TEAMS ? "round_robin" : "swiss";
}

/** Each pair plays every map in both colours: 6 games, team `a` is Red in the even games (plan §7.5a, §7.6). */
export function pairingGames(stage, round = 1) {
  if (stage === "swiss") {
    const mapId = swissMap(round);
    return [{ gameIndex: 0, mapId, red: "a" }, { gameIndex: 1, mapId, red: "b" }];
  }
  return MAPS.flatMap((mapId, index) => [{ gameIndex: index * 2, mapId, red: "a" }, { gameIndex: index * 2 + 1, mapId, red: "b" }]);
}

/** Single round robin by the Berger circle (each pair meets once); an odd count rests one team per round. */
export function roundRobinPairings(teamIds) {
  if (teamIds.length < 2) return [];
  const schedule = generateDoubleRoundRobinSchedule([...teamIds].sort());
  return schedule.filter((match) => match.leg === 1).map((match) => ({ round: match.round, a: match.botAId, b: match.botBId }));
}

// ---------- results of a pairing ----------

/**
 * Points of both sides from a pairing's finished games.
 * @param {Array<{ status: string, outcome: string|null, winner: "A"|"B"|null, red: "a"|"b" }>} games
 */
export function pairingScore(games) {
  const score = { a: 0, b: 0, winsA: 0, winsB: 0, played: 0, complete: games.length > 0 && games.every((game) => game.status === "finished") };
  for (const game of games) {
    if (game.status !== "finished") continue;
    score.played += 1;
    if (game.outcome === "draw") {
      score.a += 0.5;
      score.b += 0.5;
      continue;
    }
    const winnerSide = (game.winner === "A") === (game.red === "a") ? "a" : "b";
    score[winnerSide] += 1;
    if (winnerSide === "a") score.winsA += 1;
    else score.winsB += 1;
  }
  return score;
}

// ---------- standings ----------

function headToHead(team, tied, pairings) {
  let points = 0;
  for (const pairing of pairings) {
    if (pairing.a === team && tied.has(pairing.b)) points += pairing.pointsA;
    else if (pairing.b === team && tied.has(pairing.a)) points += pairing.pointsB;
  }
  return points;
}

function baseTable(teams, pairings) {
  const rows = new Map(teams.map((team) => [team.teamId, { teamId: team.teamId, sealedAt: team.sealedAt, points: 0, wins: 0, games: 0, byes: 0, opponents: [] }]));
  for (const pairing of pairings) {
    if (pairing.bye) {
      const row = rows.get(pairing.bye);
      if (row) {
        row.points += SWISS_BYE_POINTS;
        row.byes += 1;
      }
      continue;
    }
    const a = rows.get(pairing.a);
    const b = rows.get(pairing.b);
    if (a) {
      a.points += pairing.pointsA;
      a.wins += pairing.winsA;
      a.games += pairing.games;
      a.opponents.push({ id: pairing.b, points: pairing.pointsA, games: pairing.games });
    }
    if (b) {
      b.points += pairing.pointsB;
      b.wins += pairing.winsB;
      b.games += pairing.games;
      b.opponents.push({ id: pairing.a, points: pairing.pointsB, games: pairing.games });
    }
  }
  return rows;
}

/** Sonneborn-Berger over pairings: each opponent's total weighted by the share of points taken from them. */
function sonnebornBerger(row, rows) {
  return row.opponents.reduce((sum, opponent) => sum + (opponent.games ? (opponent.points / opponent.games) * (rows.get(opponent.id)?.points ?? 0) : 0), 0);
}

function rank(rows, keys) {
  const sorted = [...rows].sort((x, y) => {
    for (const key of keys) {
      const difference = key(y, x);
      if (difference) return difference;
    }
    return 0;
  });
  return sorted.map((row, index) => ({ ...row, rank: index + 1 }));
}

/**
 * Round robin table (plan §7.5a): points, then head-to-head among the teams level on points, Sonneborn-Berger, wins, and
 * the earlier sealed submission. Deterministic for the same input.
 * @param {Array<{ teamId: string, sealedAt: number }>} teams
 * @param {Array<{ a: string, b: string, pointsA: number, pointsB: number, winsA: number, winsB: number, games: number }>} pairings
 */
export function roundRobinStandings(teams, pairings) {
  const rows = baseTable(teams, pairings);
  const list = [...rows.values()].map((row) => ({ ...row, sb: sonnebornBerger(row, rows) }));
  const byPoints = new Map();
  for (const row of list) byPoints.set(row.points, [...(byPoints.get(row.points) ?? []), row.teamId]);
  for (const row of list) {
    const tied = new Set(byPoints.get(row.points));
    row.h2h = tied.size > 1 ? headToHead(row.teamId, tied, pairings) : 0;
  }
  return rank(list, [
    (x, y) => x.points - y.points,
    (x, y) => x.h2h - y.h2h,
    (x, y) => x.sb - y.sb,
    (x, y) => x.wins - y.wins,
    (x, y) => y.sealedAt - x.sealedAt,
    (x, y) => (x.teamId < y.teamId ? 1 : -1)
  ]).map(({ opponents, ...row }) => row);
}

/**
 * Swiss table (plan §7.5): points (a bye is 2), Buchholz cut 1, Sonneborn-Berger, wins, head-to-head, earlier sealed
 * submission.
 */
export function swissStandings(teams, pairings) {
  const rows = baseTable(teams, pairings);
  const list = [...rows.values()].map((row) => {
    const opponentTotals = row.opponents.map((opponent) => rows.get(opponent.id)?.points ?? 0).sort((x, y) => x - y);
    const buchholzCut1 = opponentTotals.slice(1).reduce((sum, value) => sum + value, 0);
    return { ...row, buchholzCut1, sb: sonnebornBerger(row, rows) };
  });
  const byPoints = new Map();
  for (const row of list) byPoints.set(row.points, [...(byPoints.get(row.points) ?? []), row.teamId]);
  for (const row of list) row.h2h = headToHead(row.teamId, new Set(byPoints.get(row.points)), pairings.filter((pairing) => !pairing.bye));
  return rank(list, [
    (x, y) => x.points - y.points,
    (x, y) => x.buchholzCut1 - y.buchholzCut1,
    (x, y) => x.sb - y.sb,
    (x, y) => x.wins - y.wins,
    (x, y) => x.h2h - y.h2h,
    (x, y) => y.sealedAt - x.sealedAt,
    (x, y) => (x.teamId < y.teamId ? 1 : -1)
  ]).map(({ opponents, ...row }) => row);
}

// ---------- Swiss rounds ----------

/** R = clamp(ceil(log2 N), 7, 10) (plan §7.5). */
export function swissRoundCount(teamCount) {
  return Math.min(10, Math.max(7, Math.ceil(Math.log2(Math.max(2, teamCount)))));
}

/** Every pair in round r plays the same map: classic, flanks, center, classic, … */
export function swissMap(round) {
  return MAPS[(round - 1) % MAPS.length];
}

/**
 * Pairs one Swiss round with the Arena pairing (score groups, no rematches, seat balance). Teams eliminated mid-way are
 * simply left out of `active`; their past games still count for their opponents.
 * @returns {{ pairings: Array<{ a: string, b: string }>, bye: string|null, warnings: string[] }}
 */
export function pairSwiss({ active, round, roundCount, standings, history }) {
  const standingInputs = standings
    .filter((row) => active.includes(row.teamId))
    .map((row) => ({ botId: row.teamId, points: row.points, wins: row.wins, played: row.games, byeCount: row.byes }));
  const result = pairSwissRound({
    entries: [...active].sort(),
    roundNumber: round,
    roundCount,
    standings: standingInputs,
    history: history.map((pairing) => ({ roundNumber: pairing.round, botAId: pairing.a, botBId: pairing.b }))
  });
  return { pairings: result.pairings.map((pairing) => ({ a: pairing.botAId, b: pairing.botBId })), bye: result.byes[0] ?? null, warnings: result.warnings };
}

// ---------- knockout ----------

const BRACKETS = Object.freeze({
  4: [[1, 4], [2, 3]],
  16: [[1, 16], [8, 9], [5, 12], [4, 13], [3, 14], [6, 11], [7, 10], [2, 15]]
});

/**
 * First knockout round by seed (plan §7.6). Fewer than 4 qualified teams: no knockout.
 * @param {string[]} seeded team ids, seed 1 first
 * @returns {Array<{ slot: string, high: string, low: string, highSeed: number, lowSeed: number }>}
 */
export function knockoutFirstRound(seeded, size) {
  if (seeded.length < 4) return [];
  const bracketSize = size >= 16 && seeded.length >= 16 ? 16 : 4;
  return BRACKETS[bracketSize].map(([high, low], index) => ({
    slot: bracketSize === 4 ? `SF${index + 1}` : `R16-${index + 1}`,
    high: seeded[high - 1],
    low: seeded[low - 1],
    highSeed: high,
    lowSeed: low
  }));
}

/**
 * Who goes through a knockout pairing (plan §7.6): more points wins; level after the 6 games, play 2 tie-break games on a
 * drawn map, at most twice; still level, the higher seed.
 * @param {{ highPoints: number, lowPoints: number, tiebreaksPlayed: number }} state  points include tie-break games
 * @returns {{ decided: true, winner: "high"|"low", bySeed: boolean } | { decided: false }}
 */
export function knockoutDecision({ highPoints, lowPoints, tiebreaksPlayed }) {
  if (highPoints !== lowPoints) return { decided: true, winner: highPoints > lowPoints ? "high" : "low", bySeed: false };
  if (tiebreaksPlayed < KNOCKOUT_MAX_TIEBREAKS) return { decided: false };
  return { decided: true, winner: "high", bySeed: true };
}

/** A map for a tie-break, drawn with the caller's random source (plan §7.6). */
export function drawTiebreakMap(random) {
  return MAPS[Math.min(MAPS.length - 1, Math.floor(random() * MAPS.length))];
}

/** The rounds after a knockout round: quarter-finals feed semi-finals, semi-finals feed the final and the third place match. */
export function nextKnockoutPairings(results) {
  const bySlot = new Map(results.map((result) => [result.slot, result]));
  const pairsOf = (prefix, count) => Array.from({ length: count }, (_, index) => bySlot.get(`${prefix}${index + 1}`));
  const seedOrder = (x, y) => (x.seed <= y.seed ? [x, y] : [y, x]);
  const pairUp = (entries, prefix) => {
    const out = [];
    for (let index = 0; index < entries.length; index += 2) {
      const [high, low] = seedOrder(entries[index], entries[index + 1]);
      out.push({ slot: `${prefix}${index / 2 + 1}`, high: high.team, low: low.team, highSeed: high.seed, lowSeed: low.seed });
    }
    return out;
  };
  if (results.some((result) => result.slot.startsWith("R16-"))) {
    return pairUp(pairsOf("R16-", 8).map((result) => result.winnerEntry), "QF");
  }
  if (results.some((result) => result.slot.startsWith("QF"))) {
    return pairUp(pairsOf("QF", 4).map((result) => result.winnerEntry), "SF");
  }
  if (results.some((result) => result.slot.startsWith("SF"))) {
    const semis = pairsOf("SF", 2);
    const [finalHigh, finalLow] = seedOrder(semis[0].winnerEntry, semis[1].winnerEntry);
    const [thirdHigh, thirdLow] = seedOrder(semis[0].loserEntry, semis[1].loserEntry);
    return [
      { slot: "F", high: finalHigh.team, low: finalLow.team, highSeed: finalHigh.seed, lowSeed: finalLow.seed },
      { slot: "3RD", high: thirdHigh.team, low: thirdLow.team, highSeed: thirdHigh.seed, lowSeed: thirdLow.seed }
    ];
  }
  return [];
}

/**
 * Top 4 after the code interview (plan §8.6, Demo): a team that fails is out and the next team in the qualifying
 * ranking who has not failed takes its place; seeds follow the qualifying ranking.
 * @param {string[]} ranking team ids, first place first
 * @param {Record<string, "pass"|"fail"|"pending">} interviews
 * @returns {{ ready: boolean, seeded: string[], waitingFor: string[] }}
 */
export function topFourAfterInterviews(ranking, interviews) {
  const seeded = [];
  const waitingFor = [];
  for (const teamId of ranking) {
    if (seeded.length + waitingFor.length >= 4) break;
    const result = interviews[teamId] ?? "pending";
    if (result === "fail") continue;
    if (result === "pass") seeded.push(teamId);
    else waitingFor.push(teamId);
  }
  return { ready: waitingFor.length === 0 && seeded.length === Math.min(4, ranking.filter((id) => interviews[id] !== "fail").length), seeded, waitingFor };
}

// ---------- appeals ----------

/**
 * @returns {null | "appeal_window_closed" | "appeal_limit"}
 */
export function appealAllowed({ mode, resultsPublishedAt, now, appealsInStage }) {
  if (resultsPublishedAt == null || now < resultsPublishedAt || now >= resultsPublishedAt + APPEAL_POLICY.windowMs[mode]) return "appeal_window_closed";
  if (appealsInStage >= APPEAL_POLICY.maxPerStage) return "appeal_limit";
  return null;
}
