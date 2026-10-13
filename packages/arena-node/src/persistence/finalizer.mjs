/**
 * packages/arena-node/src/persistence/finalizer.mjs
 *
 * Transactional match finalizer for OTTv2 Arena persistence (SQLite adapter).
 * Executes atomic settlement inside a single BEGIN IMMEDIATE transaction:
 * - Idempotency and conflict detection
 * - Fenced lease verification
 * - Pinned participant validation
 * - Match results persistence
 * - Elo rating and stats computation (ranked only)
 * - Tournament standings updates (3-1-0 scheme) and tournament completion
 * - Settlement sequence audit allocation
 * - Match, job, and attempt completion
 */

import { withTransaction } from "./sqlite-database.mjs";
import { computeEloResult } from "../../../arena/src/domain/elo.mjs";
import { canonicalSerialize } from "../../../arena/src/contracts/index.mjs";
import {
  FinalizerConflictError,
  StaleLeaseError,
  MatchValidationError
} from "../../../arena/src/application/finalize-match.mjs";

export { FinalizerConflictError, StaleLeaseError, MatchValidationError };

/**
 * Creates a transactional match finalizer bound to an open SQLite database.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [_options]
 * @returns {{ finalizeMatch: (envelope: import('../../../arena/src/contracts/index.d.mts').MatchCompletionEnvelope) => import('../../../arena/src/contracts/index.d.mts').FinalizedMatch }}
 */
export function createMatchFinalizer(db, _options = {}) {
  if (!db) {
    throw new TypeError("createMatchFinalizer requires a database instance");
  }

  // Prepare SQL statements once for efficiency and reusability
  const selectMatchStmt = db.prepare("SELECT * FROM matches WHERE id = ?");
  const selectMatchResultStmt = db.prepare("SELECT * FROM match_results WHERE match_id = ?");
  const selectParticipantsStmt = db.prepare(
    "SELECT * FROM match_participants WHERE match_id = ? ORDER BY seat ASC"
  );
  const selectJobStmt = db.prepare(`
    SELECT
      id, kind, target_id, status, attempt_no, lease_owner, lease_token, lease_until,
      CASE
        WHEN lease_until IS NOT NULL AND datetime('now') > lease_until THEN 1
        ELSE 0
      END AS is_lease_expired
    FROM jobs
    WHERE kind = 'match' AND target_id = ?
  `);
  const selectAttemptStmt = db.prepare(
    "SELECT * FROM job_attempts WHERE job_id = ? AND attempt_no = ?"
  );
  const selectBotVersionStmt = db.prepare("SELECT * FROM bot_versions WHERE id = ?");
  const insertMatchResultStmt = db.prepare(`
    INSERT INTO match_results (
      match_id,
      result_json,
      replay_json,
      replay_digest,
      completion_digest,
      winning_attempt,
      finalized_at
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const selectNextSettlementSeqStmt = db.prepare(
    "SELECT COALESCE(MAX(settlement_seq), 0) + 1 AS next_seq FROM matches WHERE settlement_seq IS NOT NULL"
  );
  const selectBotRatingStmt = db.prepare(
    "SELECT * FROM bot_ratings WHERE ladder_id = ? AND bot_id = ?"
  );
  const insertRatingChangeStmt = db.prepare(`
    INSERT INTO rating_changes (
      match_id,
      bot_id,
      settlement_seq,
      before_rating,
      after_rating,
      delta,
      k_factor,
      score
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertBotRatingStmt = db.prepare(`
    INSERT INTO bot_ratings (
      ladder_id,
      bot_id,
      rating,
      rated_games,
      wins,
      draws,
      losses,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (ladder_id, bot_id) DO UPDATE SET
      rating = excluded.rating,
      rated_games = excluded.rated_games,
      wins = excluded.wins,
      draws = excluded.draws,
      losses = excluded.losses,
      updated_at = datetime('now')
  `);
  const upsertTournamentStandingsStmt = db.prepare(`
    INSERT INTO tournament_standings (
      tournament_id,
      bot_id,
      played,
      wins,
      draws,
      losses,
      points,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (tournament_id, bot_id) DO UPDATE SET
      played = tournament_standings.played + excluded.played,
      wins = tournament_standings.wins + excluded.wins,
      draws = tournament_standings.draws + excluded.draws,
      losses = tournament_standings.losses + excluded.losses,
      points = tournament_standings.points + excluded.points,
      updated_at = datetime('now')
  `);
  const countTournamentMatchesStmt = db.prepare(`
    SELECT
      COUNT(*) AS total_matches,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_matches
    FROM matches
    WHERE tournament_id = ?
  `);
  const completeTournamentStmt = db.prepare(
    "UPDATE tournaments SET status = 'completed' WHERE id = ?"
  );
  const completeMatchStmt = db.prepare(`
    UPDATE matches
    SET status = 'completed',
        settled_at = datetime('now'),
        settlement_seq = ?
    WHERE id = ?
  `);
  const completeJobStmt = db.prepare("UPDATE jobs SET status = 'completed' WHERE id = ?");
  const completeAttemptStmt = db.prepare(`
    UPDATE job_attempts
    SET status = 'completed',
        finished_at = datetime('now')
    WHERE job_id = ? AND attempt_no = ?
  `);

  function finalizeMatch(envelope) {
    if (!envelope || !envelope.matchId) {
      throw new MatchValidationError("Invalid envelope: missing matchId", "INVALID_ENVELOPE");
    }

    return withTransaction(db, () => {
      // 1. Load match
      const match = selectMatchStmt.get(envelope.matchId);
      if (!match) {
        throw new MatchValidationError(
          `Match not found: ${envelope.matchId}`,
          "MATCH_NOT_FOUND"
        );
      }

      // 2. Check existing result (Idempotency / Conflict)
      const existingResult = selectMatchResultStmt.get(envelope.matchId);
      if (existingResult) {
        if (existingResult.completion_digest === envelope.completionDigest) {
          // Idempotent retry: return canonical result without writing again
          return {
            matchId: match.id,
            settlementSeq: match.settlement_seq,
            settledAt: match.settled_at,
            result: JSON.parse(existingResult.result_json),
            replayDigest: existingResult.replay_digest,
            completionDigest: existingResult.completion_digest
          };
        } else {
          throw new FinalizerConflictError(
            `Match ${envelope.matchId} already settled with conflicting completion: ${existingResult.completion_digest} vs ${envelope.completionDigest}`
          );
        }
      }

      // 3. Fenced Lease verification
      const job = selectJobStmt.get(envelope.matchId);
      if (!job) {
        throw new StaleLeaseError(`No match job found for match ${envelope.matchId}`, {
          matchId: envelope.matchId
        });
      }

      if (job.status !== "claimed") {
        throw new StaleLeaseError(`Job is not claimed (status: ${job.status})`, {
          status: job.status,
          matchId: envelope.matchId
        });
      }

      if (job.attempt_no !== envelope.attemptNo) {
        throw new StaleLeaseError(
          `Job attempt number mismatch: expected ${job.attempt_no}, got ${envelope.attemptNo}`,
          { expectedAttempt: job.attempt_no, attemptNo: envelope.attemptNo }
        );
      }

      if (job.lease_token !== envelope.leaseToken) {
        throw new StaleLeaseError("Job lease token mismatch", {
          expectedToken: job.lease_token,
          leaseToken: envelope.leaseToken
        });
      }

      if (job.is_lease_expired === 1) {
        throw new StaleLeaseError(`Job lease has expired for match ${envelope.matchId}`, {
          leaseUntil: job.lease_until
        });
      }

      const attempt = selectAttemptStmt.get(job.id, envelope.attemptNo);
      if (!attempt) {
        throw new StaleLeaseError(
          `Job attempt ${envelope.attemptNo} not found for job ${job.id}`,
          {
            jobId: job.id,
            attemptNo: envelope.attemptNo
          }
        );
      }

      if (attempt.lease_token !== envelope.leaseToken) {
        throw new StaleLeaseError("Job attempt lease token mismatch", {
          attemptToken: attempt.lease_token,
          leaseToken: envelope.leaseToken
        });
      }

      if (attempt.status !== "active") {
        throw new StaleLeaseError(`Job attempt is not active (status: ${attempt.status})`, {
          status: attempt.status
        });
      }

      // 4. Validate pinning between match and replay document (ruleset, policy, state, profile, participants)
      // 4a. DB Ruleset Snapshot vs replay.rulesetSnapshot (canonical JSON comparison)
      let dbRuleset;
      try {
        dbRuleset = JSON.parse(match.ruleset_json);
      } catch (err) {
        throw new MatchValidationError(`Corrupt match ruleset_json in database: ${err.message}`, "CORRUPT_DB_RULESET");
      }
      if (canonicalSerialize(dbRuleset) !== canonicalSerialize(envelope.replay?.rulesetSnapshot)) {
        throw new MatchValidationError(
          "Replay ruleset snapshot mismatch with pinned match ruleset",
          "PINNING_RULESET_MISMATCH"
        );
      }

      // 4b. DB Match Policy vs replay.matchPolicy (canonical JSON comparison)
      let dbPolicy;
      try {
        dbPolicy = JSON.parse(match.policy_json);
      } catch (err) {
        throw new MatchValidationError(`Corrupt match policy_json in database: ${err.message}`, "CORRUPT_DB_POLICY");
      }
      if (canonicalSerialize(dbPolicy) !== canonicalSerialize(envelope.replay?.matchPolicy)) {
        throw new MatchValidationError(
          "Replay match policy mismatch with pinned match policy",
          "PINNING_POLICY_MISMATCH"
        );
      }

      // 4c. DB Initial Core State vs replay.initialCoreState (canonical JSON comparison)
      let dbInitialState;
      try {
        dbInitialState = JSON.parse(match.initial_state_json);
      } catch (err) {
        throw new MatchValidationError(`Corrupt match initial_state_json in database: ${err.message}`, "CORRUPT_DB_INITIAL_STATE");
      }
      if (canonicalSerialize(dbInitialState) !== canonicalSerialize(envelope.replay?.initialCoreState)) {
        throw new MatchValidationError(
          "Replay initial core state mismatch with pinned match initial state",
          "PINNING_INITIAL_STATE_MISMATCH"
        );
      }

      // 4d. Pinned engineRevision (where pinned in profile)
      let dbProfile = null;
      if (match.profile_json) {
        try {
          dbProfile = JSON.parse(match.profile_json);
        } catch (_) {}
      }
      if (
        dbProfile &&
        dbProfile.engineRevision &&
        envelope.replay?.engineRevision &&
        dbProfile.engineRevision !== envelope.replay.engineRevision
      ) {
        throw new MatchValidationError(
          `Replay engineRevision mismatch with pinned profile (${envelope.replay.engineRevision} !== ${dbProfile.engineRevision})`,
          "PINNING_ENGINE_REVISION_MISMATCH"
        );
      }

      // 4e. Validate participant pinning across bot, version, artifact, profile, sourceDigest, executor
      const participants = selectParticipantsStmt.all(envelope.matchId);
      const partMap = {};
      for (const p of participants) {
        partMap[p.seat] = p;
      }

      if (!partMap.A || !partMap.B) {
        throw new MatchValidationError(
          `Match ${envelope.matchId} missing participants in database`,
          "MISSING_PARTICIPANTS"
        );
      }

      const replayParticipants = envelope.replay?.participants;
      if (!replayParticipants || !replayParticipants.A || !replayParticipants.B) {
        throw new MatchValidationError(
          `Replay missing participant definitions for match ${envelope.matchId}`,
          "INVALID_REPLAY_PARTICIPANTS"
        );
      }

      for (const seat of ["A", "B"]) {
        const pinned = partMap[seat];
        const replayP = replayParticipants[seat];

        if (replayP.botId !== pinned.bot_id) {
          throw new MatchValidationError(
            `Replay seat ${seat} botId mismatch with pinned match participant (${replayP.botId} !== ${pinned.bot_id})`,
            "PINNING_PARTICIPANT_BOT_MISMATCH"
          );
        }

        if (replayP.botVersionId && replayP.botVersionId !== pinned.bot_version_id) {
          throw new MatchValidationError(
            `Replay seat ${seat} botVersionId mismatch with pinned match participant (${replayP.botVersionId} !== ${pinned.bot_version_id})`,
            "PINNING_PARTICIPANT_VERSION_MISMATCH"
          );
        }

        if (replayP.artifactDigest && pinned.artifact_digest && replayP.artifactDigest !== pinned.artifact_digest) {
          throw new MatchValidationError(
            `Replay seat ${seat} artifactDigest mismatch with pinned match participant (${replayP.artifactDigest} !== ${pinned.artifact_digest})`,
            "PINNING_PARTICIPANT_ARTIFACT_MISMATCH"
          );
        }

        if (replayP.profileId && pinned.profile_id && replayP.profileId !== pinned.profile_id) {
          throw new MatchValidationError(
            `Replay seat ${seat} profileId mismatch with pinned match participant (${replayP.profileId} !== ${pinned.profile_id})`,
            "PINNING_PARTICIPANT_PROFILE_MISMATCH"
          );
        }

        if (replayP.profileRevision && pinned.profile_revision && replayP.profileRevision !== pinned.profile_revision) {
          throw new MatchValidationError(
            `Replay seat ${seat} profileRevision mismatch with pinned match participant (${replayP.profileRevision} !== ${pinned.profile_revision})`,
            "PINNING_PARTICIPANT_PROFILE_REVISION_MISMATCH"
          );
        }

        if (replayP.sourceDigest) {
          const bv = selectBotVersionStmt.get(pinned.bot_version_id);
          if (bv && bv.source_digest && replayP.sourceDigest !== bv.source_digest) {
            throw new MatchValidationError(
              `Replay seat ${seat} sourceDigest mismatch with pinned bot version (${replayP.sourceDigest} !== ${bv.source_digest})`,
              "PINNING_PARTICIPANT_SOURCE_MISMATCH"
            );
          }
        }

        if (replayP.executor && dbProfile) {
          const expectedExecutor = dbProfile.executor || (dbProfile.executors && dbProfile.executors[seat]);
          if (expectedExecutor && replayP.executor !== expectedExecutor) {
            throw new MatchValidationError(
              `Replay seat ${seat} executor mismatch with pinned profile (${replayP.executor} !== ${expectedExecutor})`,
              "PINNING_PARTICIPANT_EXECUTOR_MISMATCH"
            );
          }
        }
      }

      // 5. Allocate monotonic settlement sequence
      const nextSeqRow = selectNextSettlementSeqStmt.get();
      const settlementSeq = nextSeqRow ? nextSeqRow.next_seq : 1;

      // 6. Persist match_results
      insertMatchResultStmt.run(
        envelope.matchId,
        canonicalSerialize(envelope.result),
        canonicalSerialize(envelope.replay),
        envelope.replayDigest,
        envelope.completionDigest,
        envelope.attemptNo
      );

      // 7. Rated match vs Practice match
      if (match.kind === "ranked") {
        const rowRatingA = selectBotRatingStmt.get(match.ladder_id, partMap.A.bot_id);
        const rowRatingB = selectBotRatingStmt.get(match.ladder_id, partMap.B.bot_id);

        const currentA = {
          rating: rowRatingA ? rowRatingA.rating : 1200.0,
          rated_games: rowRatingA ? rowRatingA.rated_games : 0,
          wins: rowRatingA ? rowRatingA.wins : 0,
          draws: rowRatingA ? rowRatingA.draws : 0,
          losses: rowRatingA ? rowRatingA.losses : 0
        };

        const currentB = {
          rating: rowRatingB ? rowRatingB.rating : 1200.0,
          rated_games: rowRatingB ? rowRatingB.rated_games : 0,
          wins: rowRatingB ? rowRatingB.wins : 0,
          draws: rowRatingB ? rowRatingB.draws : 0,
          losses: rowRatingB ? rowRatingB.losses : 0
        };

        const eloResult = computeEloResult({
          ratingA: currentA.rating,
          ratingB: currentB.rating,
          ratedGamesA: currentA.rated_games,
          ratedGamesB: currentB.rated_games,
          result: envelope.result
        });

        // Insert rating_changes
        insertRatingChangeStmt.run(
          match.id,
          partMap.A.bot_id,
          settlementSeq,
          eloResult.A.before,
          eloResult.A.after,
          eloResult.A.delta,
          eloResult.A.K,
          eloResult.A.score
        );

        insertRatingChangeStmt.run(
          match.id,
          partMap.B.bot_id,
          settlementSeq,
          eloResult.B.before,
          eloResult.B.after,
          eloResult.B.delta,
          eloResult.B.K,
          eloResult.B.score
        );

        // Update bot_ratings
        let dWinsA = 0;
        let dDrawsA = 0;
        let dLossesA = 0;
        let dWinsB = 0;
        let dDrawsB = 0;
        let dLossesB = 0;

        if (envelope.result.outcome === "draw") {
          dDrawsA = 1;
          dDrawsB = 1;
        } else if (envelope.result.winner === "A") {
          dWinsA = 1;
          dLossesB = 1;
        } else {
          dLossesA = 1;
          dWinsB = 1;
        }

        upsertBotRatingStmt.run(
          match.ladder_id,
          partMap.A.bot_id,
          eloResult.A.after,
          currentA.rated_games + 1,
          currentA.wins + dWinsA,
          currentA.draws + dDrawsA,
          currentA.losses + dLossesA
        );

        upsertBotRatingStmt.run(
          match.ladder_id,
          partMap.B.bot_id,
          eloResult.B.after,
          currentB.rated_games + 1,
          currentB.wins + dWinsB,
          currentB.draws + dDrawsB,
          currentB.losses + dLossesB
        );
      }
      // If practice: NO rating_changes, NO bot_ratings updates!

      // 8. Tournament standings and status
      if (match.tournament_id) {
        let tPlayedA = 1;
        let tWinsA = 0;
        let tDrawsA = 0;
        let tLossesA = 0;
        let tPointsA = 0;
        let tPlayedB = 1;
        let tWinsB = 0;
        let tDrawsB = 0;
        let tLossesB = 0;
        let tPointsB = 0;

        if (envelope.result.outcome === "draw") {
          tDrawsA = 1;
          tPointsA = 1;
          tDrawsB = 1;
          tPointsB = 1;
        } else if (envelope.result.winner === "A") {
          tWinsA = 1;
          tPointsA = 3;
          tLossesB = 1;
          tPointsB = 0;
        } else {
          tLossesA = 1;
          tPointsA = 0;
          tWinsB = 1;
          tPointsB = 3;
        }

        upsertTournamentStandingsStmt.run(
          match.tournament_id,
          partMap.A.bot_id,
          tPlayedA,
          tWinsA,
          tDrawsA,
          tLossesA,
          tPointsA
        );

        upsertTournamentStandingsStmt.run(
          match.tournament_id,
          partMap.B.bot_id,
          tPlayedB,
          tWinsB,
          tDrawsB,
          tLossesB,
          tPointsB
        );
      }

      // 9. Complete match
      completeMatchStmt.run(settlementSeq, match.id);

      // Check if tournament all matches completed
      if (match.tournament_id) {
        const tCounts = countTournamentMatchesStmt.get(match.tournament_id);
        if (
          tCounts &&
          tCounts.total_matches > 0 &&
          tCounts.completed_matches === tCounts.total_matches
        ) {
          completeTournamentStmt.run(match.tournament_id);
        }
      }

      // 10. Complete job & job attempt
      completeJobStmt.run(job.id);
      completeAttemptStmt.run(job.id, envelope.attemptNo);

      // Query settled_at from updated match record
      const updatedMatch = selectMatchStmt.get(match.id);

      return {
        matchId: match.id,
        settlementSeq,
        settledAt: updatedMatch.settled_at,
        result: envelope.result,
        replayDigest: envelope.replayDigest,
        completionDigest: envelope.completionDigest
      };
    });
  }

  return {
    finalizeMatch
  };
}
