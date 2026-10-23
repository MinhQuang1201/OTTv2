/**
 * Bot Cup replays (plan §8.4): the runner sends a compact list of moves, and the API replays it with the real rules
 * (`packages/game-core/src/rules.js`) before accepting the result. A runner that reports an illegal move, a different
 * winner, an impossible clock or a game that went on after it ended is refused.
 *
 * Format "ott-bot-cup-replay-1":
 *   { format, mapId, policy: { matchPolicyVersion, maxPlies, initialTimeMs, turnTimeLimitMs, firstMoveGraceMs },
 *     moves: [{ seat, from: {x, y}, to: {x, y}, elapsedMs }],
 *     result: { outcome: "win"|"draw"|"forfeit", winner, loser, reason, acceptedPlies } }
 */
import rules from "../../game-core/src/rules.js";
import gameConfig from "../../game-core/src/config.js";
import { createReplayJournal } from "../../arena/src/application/replay-journal.mjs";
import { createCurrentRulesetSnapshot } from "../../arena/src/contracts/index.mjs";
import { createMapState } from "../../arena/src/domain/maps/index.mjs";
import { BOT_CUP_MATCH_POLICY } from "../../arena/src/domain/match-policy.mjs";
import { canonicalRulesetJson } from "../../arena/src/domain/ruleset.mjs";

export const REPLAY_FORMAT = "ott-bot-cup-replay-1";
export const BOT_CUP_POLICY = BOT_CUP_MATCH_POLICY;
export const MAPS = Object.freeze(["classic", "flanks", "center"]);

const WIN_REASONS = new Set(["goal", "elimination", "no_moves"]);
// Faults the referee detects while the faulting seat is the one asked to move.
const TURN_FAULTS = new Set(["turn_timeout", "total_timeout", "illegal_move", "protocol_error"]);
// A process can die or flood stdout while it is waiting, so either seat may be the one at fault.
const ANY_SEAT_FAULTS = new Set(["crash", "output_limit"]);
const other = (seat) => (seat === "A" ? "B" : "A");
const isCell = (point) => point && Number.isInteger(point.x) && Number.isInteger(point.y);

function fail(error, ply = null) {
  return { ok: false, error, ply };
}

/**
 * @param {unknown} replay
 * @param {{ mapId: string }} expected  what the API scheduled; the replay must match it
 * @returns {{ ok: true, result: object, plies: number } | { ok: false, error: string, ply: number|null }}
 */
export function verifyReplay(replay, expected) {
  if (!replay || typeof replay !== "object" || replay.format !== REPLAY_FORMAT) return fail("replay_format");
  if (replay.mapId !== expected.mapId || !MAPS.includes(replay.mapId)) return fail("replay_map");
  const policy = BOT_CUP_POLICY;
  const claimed = replay.policy ?? {};
  for (const key of ["matchPolicyVersion", "maxPlies", "initialTimeMs", "turnTimeLimitMs", "firstMoveGraceMs"]) {
    if (claimed[key] !== policy[key]) return fail("replay_policy");
  }
  if (!Array.isArray(replay.moves) || replay.moves.length > policy.maxPlies) return fail("replay_moves");
  const result = replay.result;
  if (!result || typeof result !== "object" || result.acceptedPlies !== replay.moves.length) return fail("replay_result");

  let state = createMapState(replay.mapId);
  const bank = { A: policy.initialTimeMs, B: policy.initialTimeMs };
  const moved = { A: false, B: false };
  for (let index = 0; index < replay.moves.length; index++) {
    const move = replay.moves[index];
    const ply = index + 1;
    if (state.winner) return fail("replay_after_end", ply);
    if (!move || move.seat !== state.turn || !isCell(move.from) || !isCell(move.to)) return fail("replay_turn", ply);
    const elapsed = move.elapsedMs;
    if (!Number.isFinite(elapsed) || elapsed < 0) return fail("replay_clock", ply);
    const grace = !moved[move.seat];
    const budget = grace ? policy.firstMoveGraceMs : Math.min(policy.turnTimeLimitMs, bank[move.seat]);
    if (elapsed >= budget) return fail("replay_clock", ply);
    const applied = rules.applyMove(state, move.seat, move.from, move.to);
    if (!applied.ok) return fail("replay_illegal_move", ply);
    if (!grace) bank[move.seat] -= elapsed;
    moved[move.seat] = true;
    state = applied.state;
  }

  const plies = replay.moves.length;
  if (result.outcome === "win") {
    if (!WIN_REASONS.has(result.reason) || state.winner !== result.winner || state.reason !== result.reason) return fail("replay_winner");
    if (result.loser !== other(result.winner)) return fail("replay_winner");
  } else if (state.winner) {
    // The rules ended the game; any other outcome is made up.
    return fail("replay_winner");
  } else if (result.outcome === "draw") {
    if (result.reason !== "max_plies" || plies !== policy.maxPlies || result.winner !== null || result.loser !== null) return fail("replay_draw");
  } else if (result.outcome === "forfeit") {
    if (plies >= policy.maxPlies) return fail("replay_forfeit");
    if (result.winner !== other(result.loser) || !["A", "B"].includes(result.loser)) return fail("replay_forfeit");
    if (TURN_FAULTS.has(result.reason)) {
      if (result.loser !== state.turn) return fail("replay_forfeit");
      const graceTurn = !moved[result.loser];
      if (result.reason === "total_timeout" && (graceTurn || bank[result.loser] > policy.turnTimeLimitMs)) return fail("replay_forfeit");
      if (result.reason === "turn_timeout" && !graceTurn && bank[result.loser] <= policy.turnTimeLimitMs) return fail("replay_forfeit");
    } else if (!ANY_SEAT_FAULTS.has(result.reason)) {
      return fail("replay_forfeit");
    }
  } else {
    return fail("replay_result");
  }
  return {
    ok: true,
    plies,
    result: { outcome: result.outcome, winner: result.winner ?? null, loser: result.loser ?? null, reason: result.reason, acceptedPlies: plies },
    finalState: state
  };
}

/** Builds the compact replay from an Arena controller run (moves collected through onAcceptedMove). */
export function compactReplay({ mapId, moves, result }) {
  return {
    format: REPLAY_FORMAT,
    mapId,
    policy: {
      matchPolicyVersion: BOT_CUP_POLICY.matchPolicyVersion,
      maxPlies: BOT_CUP_POLICY.maxPlies,
      initialTimeMs: BOT_CUP_POLICY.initialTimeMs,
      turnTimeLimitMs: BOT_CUP_POLICY.turnTimeLimitMs,
      firstMoveGraceMs: BOT_CUP_POLICY.firstMoveGraceMs
    },
    moves,
    result: {
      outcome: result.outcome,
      winner: result.winner ?? null,
      loser: result.loser ?? null,
      reason: result.reason,
      acceptedPlies: result.acceptedPlies
    }
  };
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

/**
 * Rebuilds the full Arena replay document (frames with board states) from a verified compact replay, for the web replay
 * viewer. Moves are applied with rules.js again, so the frames are the rules' own states.
 * @param {object} replay a compact replay that passed verifyReplay
 * @param {{ matchId: string, participants: { A: { botId: string, name: string }, B: { botId: string, name: string } } }} meta
 */
export async function expandReplay(replay, meta) {
  const snapshot = createCurrentRulesetSnapshot(gameConfig);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalRulesetJson(snapshot)));
  const rulesetHash = `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const policy = { ...BOT_CUP_POLICY };
  const bank = { A: policy.initialTimeMs, B: policy.initialTimeMs };
  let state = createMapState(replay.mapId);
  state.clock.remainingMs = { ...bank };

  const journal = createReplayJournal();
  journal.init({
    matchId: meta.matchId,
    engineRevision: "bot-cup",
    rulesetId: snapshot.rulesetId,
    rulesetHash,
    rulesetSnapshot: snapshot,
    matchPolicy: policy,
    participants: meta.participants,
    initialCoreState: cloneState(state)
  });
  const moved = { A: false, B: false };
  for (const move of replay.moves) {
    const applied = rules.applyMove(state, move.seat, move.from, move.to);
    if (!applied.ok) throw new Error(`replay does not follow the rules: ${applied.error}`);
    if (moved[move.seat]) bank[move.seat] = Math.max(0, bank[move.seat] - move.elapsedMs);
    moved[move.seat] = true;
    state = applied.state;
    state.clock.remainingMs = { ...bank };
    let pieceId = "";
    let capturedPieceId = null;
    let capturedPieceType = null;
    for (const event of applied.events) {
      if (event.type === "capture") {
        capturedPieceId = event.capturedId;
        capturedPieceType = event.capturedType;
      }
      if (event.type === "move" || event.type === "capture") pieceId = event.pieceId;
    }
    journal.acceptedMove({
      seat: move.seat,
      pieceId,
      from: move.from,
      to: move.to,
      capturedPieceId,
      capturedPieceType,
      elapsedMs: move.elapsedMs,
      remainingMs: bank[move.seat],
      events: applied.events,
      coreState: cloneState(state)
    });
  }
  const terminal = cloneState(state);
  terminal.clock.runningSeat = null;
  if (replay.result.outcome === "win") {
    terminal.winner = replay.result.winner;
    terminal.reason = replay.result.reason;
  }
  return journal.finish(
    { outcome: replay.result.outcome, winner: replay.result.winner, loser: replay.result.loser, reason: replay.result.reason, acceptedPlies: replay.moves.length },
    terminal
  );
}

/** Points per game (plan §7.2): a win or the opponent's fault is 1, a draw 0.5. */
export function gamePoints(result, seat) {
  if (result.outcome === "draw") return 0.5;
  return result.winner === seat ? 1 : 0;
}
