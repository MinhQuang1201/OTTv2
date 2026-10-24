/**
 * Runner work (plan §6.2, §8.4, §9.1): job priorities, leases, retries, house bots and the smoke test verdict. Pure.
 */

const MINUTE = 60 * 1000;

/** Higher runs first (plan §9.1): knockout > gate/qualifying > smoke > practice. */
export const JOB_PRIORITY = Object.freeze({
  knockout: 40,
  gate: 30,
  round_robin: 30,
  swiss: 30,
  check: 20,
  smoke: 20,
  practice: 10
});

export const JOB_POLICY = Object.freeze({
  leaseMs: 5 * MINUTE,
  /** Leases per job before it is marked failed (plan §7.2: infrastructure errors are retried, at most 3 runs). */
  maxAttempts: 3,
  maxClaim: 8
});

/** Trusted bots run by the organisers' runner (plan §1). `easy` is the gate opponent (§7.4). */
export const HOUSE_BOTS = Object.freeze(["first-legal", "easy", "medium", "hard", "sentinel", "strategist"]);

export const SMOKE_HOUSE_BOT = "easy";
export const SMOKE_MAP = "classic";

/** Two games against the easy house bot on classic, one in each colour (plan §6.2). */
export function smokeGames(submissionId) {
  return [
    { gameIndex: 0, mapId: SMOKE_MAP, a: { submissionId }, b: { house: SMOKE_HOUSE_BOT } },
    { gameIndex: 1, mapId: SMOKE_MAP, a: { house: SMOKE_HOUSE_BOT }, b: { submissionId } }
  ];
}

const FAULT_TEXT = {
  turn_timeout: "quá thời gian một nước",
  total_timeout: "hết quỹ thời gian",
  crash: "bot dừng hoặc lỗi khi chạy",
  protocol_error: "trả lời sai giao thức (in ra stdout thứ không phải một dòng JSON nước đi?)",
  illegal_move: "đi nước không hợp lệ",
  output_limit: "in quá nhiều ra stdout"
};

/**
 * The smoke test passes when the bot finishes both games without a fault; losing is fine.
 * @param {Array<{ status: string, outcome: string|null, loser: string|null, reason: string|null, seat: "A"|"B", mapId: string }>} games
 *        the two smoke games, with `seat` = where the submission played
 * @returns {null | { status: "ready"|"smoke_failed", log: string }}  null while a game is still pending
 */
export function smokeVerdict(games) {
  if (games.length < 2 || games.some((game) => game.status !== "finished")) return null;
  const faults = games.filter((game) => game.outcome === "forfeit" && game.loser === game.seat);
  if (!faults.length) {
    return { status: "ready", log: "Qua chạy thử: 2 ván với house bot Dễ, không lỗi." };
  }
  const lines = faults.map((game) => `Ván cầm ${game.seat === "A" ? "Đỏ" : "Xanh"} (${game.mapId}): ${FAULT_TEXT[game.reason] ?? game.reason}.`);
  return { status: "smoke_failed", log: `Không qua chạy thử.\n${lines.join("\n")}` };
}

/** What a lease that ran out turns into: back to the queue, or failed once the attempts are used up. */
export function expiredLeaseStatus(attempts) {
  return attempts >= JOB_POLICY.maxAttempts ? "failed" : "queued";
}

/** Keeps the end of a log, which is where errors are, within `maxChars`. */
export function tailText(text, maxChars) {
  const value = typeof text === "string" ? text : "";
  return value.length <= maxChars ? value : `…${value.slice(value.length - maxChars + 1)}`;
}
