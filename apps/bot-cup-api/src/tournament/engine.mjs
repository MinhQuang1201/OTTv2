/**
 * Tournament control on D1 (plan §7): code freeze, gate, qualifying (round robin or Swiss), Top 4 interviews, knockout,
 * published result documents. The admin site calls the `plan*` steps, each of which returns the D1 statements to run
 * together with its audit row; the player API reads `publicView`. Results are always worked out from the games
 * themselves (`matches`), so a rerun or an approved result change is picked up everywhere.
 *
 * Error codes here are for organisers only and live outside src/*.mjs (the web message test covers player codes).
 */
import {
  GATE_POLICY,
  KNOCKOUT_SIZE,
  JOB_PRIORITY,
  chooseFormat,
  drawTiebreakMap,
  gamePoints,
  gateGames,
  gateVerdict,
  knockoutDecision,
  knockoutFirstRound,
  nextKnockoutPairings,
  pairSwiss,
  pairingGames,
  pairingScore,
  roundRobinPairings,
  roundRobinStandings,
  sealedSubmission,
  swissMap,
  swissRoundCount,
  swissStandings,
  topFourAfterInterviews
} from "../../../../packages/bot-cup-core/src/index.mjs";
import { HttpError } from "../http.mjs";
import { bulkInsert, enqueueMatches } from "../queue.mjs";
import { sha256Hex } from "../security.mjs";

const defaultRandom = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

export function createTournament({ store, now, eventId, random = defaultRandom }) {
  const first = (sql, ...args) => store.statement(sql, ...args).first();
  const all = async (sql, ...args) => (await store.statement(sql, ...args).all()).results;

  async function event() {
    const row = await store.getEvent(eventId);
    if (!row) throw new HttpError(503, "event_unavailable");
    return row;
  }

  function requirePhase(current, ...allowed) {
    if (!allowed.includes(current)) throw new HttpError(409, "phase_mismatch", { phase: current, expected: allowed });
  }

  const setPhase = (phase) => store.statement("UPDATE events SET phase = ? WHERE id = ?", phase, eventId);

  async function entrants() {
    return all(
      `SELECT e.*, t.display_name, t.handle, t.disqualified_at, s.language, s.seq
       FROM entrants e JOIN teams t ON t.id = e.team_id JOIN submissions s ON s.id = e.submission_id
       WHERE e.event_id = ? ORDER BY e.submitted_at, e.team_id`,
      eventId
    );
  }

  async function publishedDoc(stage) {
    return first("SELECT stage, json, sha256, published_at FROM stage_results WHERE event_id = ? AND stage = ?", eventId, stage);
  }

  /** The exact text that is published and hashed; key order is fixed by the object literal. */
  async function publishStatement(stage, document) {
    const text = JSON.stringify(document, null, 2);
    const sha256 = await sha256Hex(text);
    return { sha256, statement: store.statement("INSERT INTO stage_results (event_id, stage, json, sha256, published_at) VALUES (?, ?, ?, ?, ?)", eventId, stage, text, sha256, now()) };
  }

  // ---------- games ----------

  async function stageGames(stage) {
    return all(
      `SELECT id, stage, round, pairing_id, game_index, map_id, a_submission_id, b_submission_id, a_house, b_house, status, outcome, winner,
              reason, plies, replay_sha256
       FROM matches WHERE event_id = ? AND stage = ? AND status <> 'cancelled' ORDER BY created_at, game_index`,
      eventId, stage
    );
  }

  function pendingCount(games) {
    return games.filter((game) => game.status !== "finished").length;
  }

  /** Every game of every pairing of `stage`, scored for the pairing's two teams. */
  async function scoredPairings(stage) {
    const [pairings, games, sealed] = await Promise.all([
      all("SELECT * FROM pairings WHERE event_id = ? AND stage = ? ORDER BY round, slot, created_at", eventId, stage),
      stageGames(stage),
      entrants()
    ]);
    const submissionOf = new Map(sealed.map((entrant) => [entrant.team_id, entrant.submission_id]));
    const byPairing = new Map();
    for (const game of games) byPairing.set(game.pairing_id, [...(byPairing.get(game.pairing_id) ?? []), game]);
    return pairings.map((pairing) => {
      const list = (byPairing.get(pairing.id) ?? []).map((game) => ({ ...game, red: game.a_submission_id === submissionOf.get(pairing.team_a) ? "a" : "b" }));
      const score = pairingScore(list);
      return { ...pairing, games: list, score };
    });
  }

  function asStandingPairing(pairing) {
    if (pairing.bye_team) return { bye: pairing.bye_team, round: pairing.round };
    return { round: pairing.round, a: pairing.team_a, b: pairing.team_b, pointsA: pairing.score.a, pointsB: pairing.score.b, winsA: pairing.score.winsA, winsB: pairing.score.winsB, games: pairing.score.played };
  }

  async function qualifyingFormat() {
    const row = await first("SELECT stage FROM pairings WHERE event_id = ? AND stage IN ('round_robin', 'swiss') LIMIT 1", eventId);
    return row?.stage ?? null;
  }

  /** Live qualifying table; disqualified teams are left out of the ranking but their games still count for opponents. */
  async function qualifyingStandings() {
    const format = await qualifyingFormat();
    if (!format) return { format: null, rows: [] };
    const sealed = (await entrants()).filter((entrant) => entrant.gate_status === "qualified");
    const pairings = (await scoredPairings(format)).map(asStandingPairing);
    const teams = sealed.map((entrant) => ({ teamId: entrant.team_id, sealedAt: entrant.submitted_at }));
    const table = format === "round_robin" ? roundRobinStandings(teams, pairings) : swissStandings(teams, pairings);
    const info = new Map(sealed.map((entrant) => [entrant.team_id, entrant]));
    const rows = table
      .filter((row) => !info.get(row.teamId)?.disqualified_at)
      .map((row, index) => ({ ...row, rank: index + 1, displayName: info.get(row.teamId)?.display_name }));
    return { format, rows };
  }

  // ---------- steps (each returns statements + an audit summary) ----------

  /** Code freeze (plan §6.2, §8.2): seal each active team's ready final submission and publish the list of SHA-256. */
  async function planFreeze() {
    const ev = await event();
    requirePhase(ev.phase, "registration", "practice");
    if (ev.codeFreezeAt == null || now() < ev.codeFreezeAt) throw new HttpError(409, "freeze_too_early", { codeFreezeAt: ev.codeFreezeAt });
    const teams = await all("SELECT id, display_name, final_submission_id FROM teams WHERE event_id = ? AND status = 'active' AND disqualified_at IS NULL ORDER BY created_at", eventId);
    const statements = [];
    const sealedList = [];
    const notSealed = [];
    for (const team of teams) {
      const submission = sealedSubmission(await store.listSubmissions(team.id), team.final_submission_id);
      if (!submission) {
        notSealed.push(team.display_name);
        continue;
      }
      sealedList.push({ team: team.display_name, version: submission.seq, language: submission.language, sha256: submission.sha256 });
      statements.push(store.statement(
        "INSERT INTO entrants (event_id, team_id, submission_id, sha256, submitted_at, sealed_at) VALUES (?, ?, ?, ?, ?, ?)",
        eventId, team.id, submission.id, submission.sha256, submission.created_at, now()
      ));
    }
    const published = await publishStatement("sealed", { event: ev.name, stage: "sealed", sealedAt: new Date(now()).toISOString(), entries: sealedList, notSealed });
    statements.push(published.statement, setPhase("frozen"));
    return { statements, summary: { sealed: sealedList.length, notSealed: notSealed.length, sha256: published.sha256 } };
  }

  /** Gate (plan §7.4): 6 games per sealed bot against the easy house bot. */
  async function planGateStart() {
    const ev = await event();
    requirePhase(ev.phase, "frozen");
    const list = await entrants();
    const statements = [setPhase("gate")];
    for (const entrant of list) {
      for (const game of gateGames(entrant.submission_id)) {
        statements.push({ bulkGame: { stage: "gate", mapId: game.mapId, gameIndex: game.gameIndex, a: game.a, b: game.b } });
      }
    }
    return { statements, summary: { entrants: list.length, games: list.length * GATE_POLICY.games } };
  }

  async function gateResults() {
    const [list, games] = await Promise.all([entrants(), stageGames("gate")]);
    return list.map((entrant) => {
      const own = games
        .filter((game) => game.a_submission_id === entrant.submission_id || game.b_submission_id === entrant.submission_id)
        .map((game) => ({ status: game.status, points: game.status === "finished" ? gamePoints(game, game.a_submission_id === entrant.submission_id ? "A" : "B") : 0 }));
      return { entrant, verdict: gateVerdict(own), played: own.filter((game) => game.status === "finished").length };
    });
  }

  async function planGateClose() {
    const ev = await event();
    requirePhase(ev.phase, "gate");
    const games = await stageGames("gate");
    if (pendingCount(games)) throw new HttpError(409, "games_pending", { pending: pendingCount(games) });
    const results = await gateResults();
    const statements = results.map(({ entrant, verdict }) => store.statement(
      "UPDATE entrants SET gate_points = ?, gate_status = ? WHERE event_id = ? AND team_id = ?", verdict.points, verdict.status, eventId, entrant.team_id
    ));
    const qualified = results.filter((result) => result.verdict.status === "qualified").length;
    const published = await publishStatement("gate", {
      event: ev.name,
      stage: "gate",
      rule: `${GATE_POLICY.games} ván với house bot ${GATE_POLICY.opponent}, cần ≥ ${GATE_POLICY.passPoints} điểm`,
      results: results.map(({ entrant, verdict }) => ({ team: entrant.display_name, sha256: entrant.sha256, points: verdict.points, qualified: verdict.status === "qualified" })),
      games: games.map((game) => ({ match: game.id, map: game.map_id, outcome: game.outcome, winner: game.winner, reason: game.reason, replaySha256: game.replay_sha256 }))
    });
    statements.push(published.statement, setPhase("qualifying"));
    return { statements, summary: { qualified, format: chooseFormat(qualified), sha256: published.sha256 } };
  }

  /** A pairing and its games, as descriptors that `finalize` turns into a few bulk INSERTs. */
  function pairingWithGames(stage, round, a, b, { slot = null, seedA = null, seedB = null, games }) {
    const id = crypto.randomUUID();
    const items = [{ bulkPairing: [id, eventId, stage, round, slot, a.team_id, b.team_id, seedA, seedB, null, now()] }];
    for (const game of games) {
      const red = game.red === "a" ? a : b;
      const blue = game.red === "a" ? b : a;
      items.push({ bulkGame: { stage, round, pairingId: id, gameIndex: game.gameIndex, mapId: game.mapId, a: { submissionId: red.submission_id }, b: { submissionId: blue.submission_id }, priority: JOB_PRIORITY[stage] } });
    }
    return items;
  }

  /** Turns pairing and game descriptors into bulk INSERTs; other statements keep their order and come first. */
  function finalize(plan) {
    const plain = plan.statements.filter((item) => !item.bulkPairing && !item.bulkGame);
    const pairings = plan.statements.filter((item) => item.bulkPairing).map((item) => item.bulkPairing);
    const games = plan.statements.filter((item) => item.bulkGame).map((item) => item.bulkGame);
    const statements = [
      ...plain,
      ...bulkInsert(store, "pairings", ["id", "event_id", "stage", "round", "slot", "team_a", "team_b", "seed_a", "seed_b", "bye_team", "created_at"], pairings),
      ...(games.length ? enqueueMatches(store, { eventId, games, now: now() }).statements : [])
    ];
    return { ...plan, statements };
  }

  /** Qualifying (plan §7.5, §7.5a): round robin up to 10 teams (all rounds at once), Swiss above (round 1). */
  async function planQualifyingStart() {
    const ev = await event();
    requirePhase(ev.phase, "qualifying");
    if (await qualifyingFormat()) throw new HttpError(409, "already_started");
    const qualified = (await entrants()).filter((entrant) => entrant.gate_status === "qualified" && !entrant.disqualified_at);
    const format = chooseFormat(qualified.length);
    if (format === "none") throw new HttpError(409, "not_enough_teams", { qualified: qualified.length });
    const byTeam = new Map(qualified.map((entrant) => [entrant.team_id, entrant]));
    const statements = [];
    if (format === "round_robin") {
      for (const pairing of roundRobinPairings(qualified.map((entrant) => entrant.team_id))) {
        statements.push(...pairingWithGames("round_robin", pairing.round, byTeam.get(pairing.a), byTeam.get(pairing.b), { games: pairingGames("round_robin") }));
      }
      return { statements, summary: { format, teams: qualified.length, pairings: statements.length ? (qualified.length * (qualified.length - 1)) / 2 : 0 } };
    }
    statements.push(...(await swissRoundStatements(qualified, 1)));
    return { statements, summary: { format, teams: qualified.length, round: 1, rounds: swissRoundCount(qualified.length) } };
  }

  async function swissRoundStatements(active, round) {
    const qualified = (await entrants()).filter((entrant) => entrant.gate_status === "qualified");
    const history = (await scoredPairings("swiss")).filter((pairing) => !pairing.bye_team);
    const standings = swissStandings(qualified.map((entrant) => ({ teamId: entrant.team_id, sealedAt: entrant.submitted_at })), (await scoredPairings("swiss")).map(asStandingPairing));
    const byTeam = new Map(active.map((entrant) => [entrant.team_id, entrant]));
    const result = pairSwiss({
      active: active.map((entrant) => entrant.team_id),
      round,
      roundCount: swissRoundCount(qualified.length),
      standings,
      history: history.map((pairing) => ({ round: pairing.round, a: pairing.team_a, b: pairing.team_b }))
    });
    const statements = [];
    if (result.bye) {
      statements.push({ bulkPairing: [crypto.randomUUID(), eventId, "swiss", round, null, null, null, null, null, result.bye, now()] });
    }
    for (const pairing of result.pairings) {
      statements.push(...pairingWithGames("swiss", round, byTeam.get(pairing.a), byTeam.get(pairing.b), { games: pairingGames("swiss", round) }));
    }
    return statements;
  }

  /** Next Swiss round once the current one is complete; teams disqualified meanwhile are left out (plan §7.5). */
  async function planSwissNextRound() {
    const ev = await event();
    requirePhase(ev.phase, "qualifying");
    if ((await qualifyingFormat()) !== "swiss") throw new HttpError(409, "not_swiss");
    const games = await stageGames("swiss");
    if (pendingCount(games)) throw new HttpError(409, "games_pending", { pending: pendingCount(games) });
    const qualified = (await entrants()).filter((entrant) => entrant.gate_status === "qualified");
    const current = (await first("SELECT MAX(round) AS round FROM pairings WHERE event_id = ? AND stage = 'swiss'", eventId)).round;
    if (current >= swissRoundCount(qualified.length)) throw new HttpError(409, "swiss_complete");
    const active = qualified.filter((entrant) => !entrant.disqualified_at && !entrant.eliminated_at);
    return { statements: await swissRoundStatements(active, current + 1), summary: { round: current + 1, map: swissMap(current + 1) } };
  }

  /** Closes qualifying and publishes its table with every game and replay hash (plan §7.5, §8.8). */
  async function planQualifyingClose() {
    const ev = await event();
    requirePhase(ev.phase, "qualifying");
    const format = await qualifyingFormat();
    if (!format) throw new HttpError(409, "not_started");
    const games = await stageGames(format);
    if (pendingCount(games)) throw new HttpError(409, "games_pending", { pending: pendingCount(games) });
    if (format === "swiss") {
      const qualified = (await entrants()).filter((entrant) => entrant.gate_status === "qualified");
      const current = (await first("SELECT MAX(round) AS round FROM pairings WHERE event_id = ? AND stage = 'swiss'", eventId)).round;
      if (current < swissRoundCount(qualified.length)) throw new HttpError(409, "swiss_unfinished", { round: current });
    }
    const standings = await qualifyingStandings();
    const pairings = await scoredPairings(format);
    const entrantInfo = new Map((await entrants()).map((entrant) => [entrant.team_id, entrant]));
    const name = (teamId) => entrantInfo.get(teamId)?.display_name ?? null;
    const published = await publishStatement("qualifying", {
      event: ev.name,
      stage: "qualifying",
      format,
      standings: standings.rows.map((row) => ({ rank: row.rank, team: row.displayName, points: row.points, wins: row.wins, sb: row.sb, h2h: row.h2h ?? null, buchholzCut1: row.buchholzCut1 ?? null })),
      pairings: pairings.map((pairing) => ({
        round: pairing.round,
        red: name(pairing.team_a),
        blue: name(pairing.team_b),
        bye: name(pairing.bye_team),
        points: pairing.bye_team ? null : [pairing.score.a, pairing.score.b],
        games: pairing.games.map((game) => ({ match: game.id, map: game.map_id, redTeam: name(game.red === "a" ? pairing.team_a : pairing.team_b), outcome: game.outcome, winner: game.winner, reason: game.reason, replaySha256: game.replay_sha256 }))
      }))
    });
    return { statements: [published.statement, setPhase("verification")], summary: { format, teams: standings.rows.length, sha256: published.sha256 } };
  }

  async function planInterview(teamId, result) {
    const ev = await event();
    requirePhase(ev.phase, "verification");
    if (!["pass", "fail", "pending"].includes(result)) throw new HttpError(400, "invalid_request", { field: "result" });
    const entrant = await first("SELECT * FROM entrants WHERE event_id = ? AND team_id = ?", eventId, teamId);
    if (!entrant || entrant.gate_status !== "qualified") throw new HttpError(404, "not_found");
    return { statements: [store.statement("UPDATE entrants SET interview = ? WHERE event_id = ? AND team_id = ?", result, eventId, teamId)], summary: { teamId, result } };
  }

  async function interviewState() {
    const standings = await qualifyingStandings();
    const interviews = Object.fromEntries((await entrants()).map((entrant) => [entrant.team_id, entrant.interview]));
    return { standings, ...topFourAfterInterviews(standings.rows.map((row) => row.teamId), interviews) };
  }

  /** Knockout Top 4 (plan §7.6, Demo): seeds from the qualifying table after the code interviews. */
  async function planKnockoutStart() {
    const ev = await event();
    requirePhase(ev.phase, "verification");
    const state = await interviewState();
    if (state.standings.rows.length < 4) throw new HttpError(409, "knockout_not_possible", { teams: state.standings.rows.length });
    if (!state.ready) throw new HttpError(409, "interviews_pending", { waitingFor: state.waitingFor });
    const byTeam = new Map((await entrants()).map((entrant) => [entrant.team_id, entrant]));
    const statements = [setPhase("knockout")];
    state.seeded.forEach((teamId, index) => statements.push(store.statement("UPDATE entrants SET seed = ? WHERE event_id = ? AND team_id = ?", index + 1, eventId, teamId)));
    const opening = knockoutFirstRound(state.seeded, KNOCKOUT_SIZE[ev.mode] ?? 4);
    for (const pairing of opening) {
      statements.push(...pairingWithGames("knockout", 1, byTeam.get(pairing.high), byTeam.get(pairing.low), { slot: pairing.slot, seedA: pairing.highSeed, seedB: pairing.lowSeed, games: pairingGames("knockout") }));
    }
    return { statements, summary: { seeds: state.seeded, pairings: opening.map((pairing) => pairing.slot) } };
  }

  /**
   * Settles the current knockout round: decided pairings get their winner, level ones get two tie-break games on a drawn
   * map; when every pairing is decided the next round is created, and after the final the final results are published.
   */
  async function planKnockoutAdvance() {
    const ev = await event();
    requirePhase(ev.phase, "knockout");
    const games = await stageGames("knockout");
    if (pendingCount(games)) throw new HttpError(409, "games_pending", { pending: pendingCount(games) });
    const pairings = await scoredPairings("knockout");
    const round = Math.max(...pairings.map((pairing) => pairing.round));
    const current = pairings.filter((pairing) => pairing.round === round);
    const byTeam = new Map((await entrants()).map((entrant) => [entrant.team_id, entrant]));
    const statements = [];
    const results = [];
    const tiebreaks = [];
    for (const pairing of current) {
      let winner = pairing.winner_team;
      let bySeed = Boolean(pairing.decided_by_seed);
      if (!winner) {
        const decision = knockoutDecision({ highPoints: pairing.score.a, lowPoints: pairing.score.b, tiebreaksPlayed: pairing.tiebreaks });
        if (!decision.decided) {
          const mapId = drawTiebreakMap(random);
          const base = 6 + pairing.tiebreaks * 2;
          for (const [offset, redSide] of [[0, "a"], [1, "b"]]) {
            const red = redSide === "a" ? byTeam.get(pairing.team_a) : byTeam.get(pairing.team_b);
            const blue = redSide === "a" ? byTeam.get(pairing.team_b) : byTeam.get(pairing.team_a);
            statements.push({ bulkGame: { stage: "knockout", round, pairingId: pairing.id, gameIndex: base + offset, mapId, a: { submissionId: red.submission_id }, b: { submissionId: blue.submission_id }, priority: JOB_PRIORITY.knockout } });
          }
          statements.push(store.statement("UPDATE pairings SET tiebreaks = tiebreaks + 1 WHERE id = ?", pairing.id));
          tiebreaks.push({ slot: pairing.slot, mapId });
          continue;
        }
        winner = decision.winner === "high" ? pairing.team_a : pairing.team_b;
        bySeed = decision.bySeed;
        statements.push(store.statement("UPDATE pairings SET winner_team = ?, decided_by_seed = ? WHERE id = ?", winner, bySeed ? 1 : 0, pairing.id));
      }
      const highWon = winner === pairing.team_a;
      results.push({
        slot: pairing.slot,
        winnerEntry: { team: winner, seed: highWon ? pairing.seed_a : pairing.seed_b },
        loserEntry: { team: highWon ? pairing.team_b : pairing.team_a, seed: highWon ? pairing.seed_b : pairing.seed_a }
      });
    }
    if (tiebreaks.length) return { statements, summary: { round, tiebreaks } };

    const next = nextKnockoutPairings(results);
    if (next.length) {
      for (const pairing of next) {
        statements.push(...pairingWithGames("knockout", round + 1, byTeam.get(pairing.high), byTeam.get(pairing.low), { slot: pairing.slot, seedA: pairing.highSeed, seedB: pairing.lowSeed, games: pairingGames("knockout") }));
      }
      return { statements, summary: { round: round + 1, pairings: next.map((pairing) => pairing.slot) } };
    }
    const final = await finalDocument(ev, results, pairings);
    statements.push(final.statement, setPhase("finished"));
    return { statements, summary: { finished: true, sha256: final.sha256 } };
  }

  async function finalDocument(ev, lastResults, knockoutPairings = []) {
    const info = new Map((await entrants()).map((entrant) => [entrant.team_id, entrant]));
    const name = (teamId) => info.get(teamId)?.display_name ?? null;
    const standings = await qualifyingStandings();
    const placed = [];
    const bySlot = new Map(lastResults.map((result) => [result.slot, result]));
    if (bySlot.has("F")) {
      placed.push(bySlot.get("F").winnerEntry.team, bySlot.get("F").loserEntry.team);
      if (bySlot.has("3RD")) placed.push(bySlot.get("3RD").winnerEntry.team, bySlot.get("3RD").loserEntry.team);
    }
    const rest = standings.rows.map((row) => row.teamId).filter((teamId) => !placed.includes(teamId));
    return publishStatement("final", {
      event: ev.name,
      stage: "final",
      ranking: [...placed, ...rest].map((teamId, index) => ({ place: index + 1, team: name(teamId), sha256: info.get(teamId)?.sha256 ?? null })),
      knockout: knockoutPairings.map((pairing) => ({
        slot: pairing.slot,
        red: name(pairing.team_a),
        blue: name(pairing.team_b),
        seeds: [pairing.seed_a, pairing.seed_b],
        points: [pairing.score.a, pairing.score.b],
        tiebreaks: pairing.tiebreaks,
        games: pairing.games.map((game) => ({ match: game.id, map: game.map_id, outcome: game.outcome, winner: game.winner, reason: game.reason, replaySha256: game.replay_sha256 }))
      }))
    });
  }

  /** No knockout (fewer than 4 qualified teams, plan §7.5a): the qualifying table is the final ranking. */
  async function planFinishWithoutKnockout() {
    const ev = await event();
    requirePhase(ev.phase, "verification");
    const standings = await qualifyingStandings();
    if (standings.rows.length >= 4) throw new HttpError(409, "knockout_expected");
    const final = await finalDocument(ev, []);
    return { statements: [final.statement, setPhase("finished")], summary: { finished: true, sha256: final.sha256 } };
  }

  // ---------- views ----------

  async function adminView() {
    const ev = await event();
    const list = await entrants();
    const gate = ev.phase === "frozen" ? [] : await gateResults();
    const docs = await all("SELECT stage, sha256, published_at FROM stage_results WHERE event_id = ? ORDER BY published_at", eventId);
    const appeals = await all(
      `SELECT a.*, t.display_name FROM appeals a JOIN teams t ON t.id = a.team_id WHERE a.event_id = ? ORDER BY a.status = 'open' DESC, a.created_at DESC`,
      eventId
    );
    return {
      phase: ev.phase,
      codeFreezeAt: ev.codeFreezeAt,
      mode: ev.mode,
      entrants: list.map((entrant) => ({
        teamId: entrant.team_id, team: entrant.display_name, version: entrant.seq, language: entrant.language, sha256: entrant.sha256,
        gatePoints: entrant.gate_points, gateStatus: entrant.gate_status, seed: entrant.seed, interview: entrant.interview, disqualified: Boolean(entrant.disqualified_at)
      })),
      gateProgress: gate.map((result) => ({ team: result.entrant.display_name, played: result.played, verdict: result.verdict })),
      standings: await qualifyingStandings(),
      knockout: await knockoutView(),
      interviews: ev.phase === "verification" ? await interviewState() : null,
      documents: docs,
      appeals
    };
  }

  async function knockoutView() {
    const info = new Map((await entrants()).map((entrant) => [entrant.team_id, entrant.display_name]));
    return (await scoredPairings("knockout")).map((pairing) => ({
      id: pairing.id, round: pairing.round, slot: pairing.slot, red: info.get(pairing.team_a), blue: info.get(pairing.team_b),
      seeds: [pairing.seed_a, pairing.seed_b], points: [pairing.score.a, pairing.score.b], tiebreaks: pairing.tiebreaks,
      winner: pairing.winner_team ? info.get(pairing.winner_team) : null, decidedBySeed: Boolean(pairing.decided_by_seed),
      games: pairing.games.map((game) => ({ id: game.id, mapId: game.map_id, gameIndex: game.game_index, status: game.status, outcome: game.outcome, winner: game.winner, reason: game.reason, red: game.red }))
    }));
  }

  /** What players and guests see (plan §8.8): no MSSV, emails or ids beyond public match ids. */
  async function publicView() {
    const ev = await event();
    const docs = await all("SELECT stage, sha256, published_at FROM stage_results WHERE event_id = ? ORDER BY published_at", eventId);
    const standings = await qualifyingStandings();
    return {
      phase: ev.phase,
      documents: docs.map((doc) => ({ stage: doc.stage, sha256: doc.sha256, publishedAt: doc.published_at })),
      standings: { format: standings.format, rows: standings.rows.map(({ teamId, sealedAt, ...row }) => row) },
      knockout: (await knockoutView()).map(({ id, ...pairing }) => pairing)
    };
  }

  const finalized = (step) => async (...args) => finalize(await step(...args));

  return {
    event,
    entrants,
    publishedDoc,
    planFreeze: finalized(planFreeze),
    planGateStart: finalized(planGateStart),
    planGateClose: finalized(planGateClose),
    planQualifyingStart: finalized(planQualifyingStart),
    planSwissNextRound: finalized(planSwissNextRound),
    planQualifyingClose: finalized(planQualifyingClose),
    planInterview: finalized(planInterview),
    planKnockoutStart: finalized(planKnockoutStart),
    planKnockoutAdvance: finalized(planKnockoutAdvance),
    planFinishWithoutKnockout: finalized(planFinishWithoutKnockout),
    adminView,
    publicView,
    qualifyingStandings
  };
}

