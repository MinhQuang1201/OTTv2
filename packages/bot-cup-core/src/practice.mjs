/**
 * Practice (plan §7.1 stage 1, P5): a team plays its bot against a house bot, two games in swapped colours, at most
 * `gamesPerDay` games a Vietnamese day; and the public practice leaderboard. Pure.
 */
import { MAPS } from "./replay.mjs";

export const PRACTICE_POLICY = Object.freeze({ gamesPerDay: 20, gamesPerRequest: 2 });

/** House bots a team may challenge, weakest first (the order of the leaderboard columns). */
export const PRACTICE_OPPONENTS = Object.freeze(["easy", "medium", "hard", "sentinel", "strategist"]);

export const HOUSE_BOT_LABELS = Object.freeze({
  "first-legal": "Nước đầu tiên",
  easy: "AI Dễ",
  medium: "AI Trung bình",
  hard: "AI Khó",
  sentinel: "Sentinel",
  strategist: "Strategist"
});

/** Stages whose games and replays everyone may see (plan §8.8); smoke and practice stay with the team. */
export const PUBLIC_STAGES = Object.freeze(["gate", "round_robin", "swiss", "knockout"]);

/**
 * @returns {{ ok: true, opponent: string, mapId: string } | { ok: false, error: "practice_opponent_invalid"|"practice_map_invalid" }}
 */
export function validatePracticeRequest(body) {
  const opponent = body?.opponent;
  if (!PRACTICE_OPPONENTS.includes(opponent)) return { ok: false, error: "practice_opponent_invalid" };
  const mapId = body?.mapId ?? "classic";
  if (!MAPS.includes(mapId)) return { ok: false, error: "practice_map_invalid" };
  return { ok: true, opponent, mapId };
}

/** The two games of a practice request: the team as Red, then as Blue. */
export function practiceGames(submissionId, opponent, mapId) {
  return [
    { gameIndex: 0, mapId, a: { submissionId }, b: { house: opponent } },
    { gameIndex: 1, mapId, a: { house: opponent }, b: { submissionId } }
  ];
}

/**
 * Practice leaderboard (plan §11.2): for each team, points against each house bot from its finished practice games.
 * Sorted by the score ratio against the strongest opponent first (strategist, sentinel, hard, …), then games played.
 * @param {Array<{ teamId: string, displayName: string, opponent: string, points: number }>} games
 */
export function practiceLeaderboard(games) {
  const teams = new Map();
  for (const game of games) {
    if (!PRACTICE_OPPONENTS.includes(game.opponent)) continue;
    const row = teams.get(game.teamId) ?? {
      teamId: game.teamId,
      displayName: game.displayName,
      games: 0,
      points: 0,
      opponents: Object.fromEntries(PRACTICE_OPPONENTS.map((name) => [name, { played: 0, points: 0 }]))
    };
    row.games += 1;
    row.points += game.points;
    row.opponents[game.opponent].played += 1;
    row.opponents[game.opponent].points += game.points;
    teams.set(game.teamId, row);
  }
  const ratio = (row, name) => (row.opponents[name].played ? row.opponents[name].points / row.opponents[name].played : -1);
  const strongestFirst = [...PRACTICE_OPPONENTS].reverse();
  return [...teams.values()].sort((x, y) => {
    for (const name of strongestFirst) {
      const difference = ratio(y, name) - ratio(x, name);
      if (difference) return difference;
    }
    return y.games - x.games || x.displayName.localeCompare(y.displayName, "vi");
  });
}
