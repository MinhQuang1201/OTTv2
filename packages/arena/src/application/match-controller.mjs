/**
 * Pure HeadlessMatchController implementation for Arena AI protocol v1.
 * Coordinates match lifecycle between EnginePort, BotPorts, ClockPort, and JournalPort.
 * Zero Node.js imports. Pure JS / standard Web API.
 */

import {
  generateTurnRequestId,
  createWinResult,
  createDrawResult,
  createForfeitResult,
  createInfrastructureError,
  validateBotAction,
  isSupportedEngineRuleset
} from "../contracts/index.mjs";

import { DEFAULT_MATCH_POLICY, validateMatchPolicy } from "../domain/match-policy.mjs";

function cloneDeep(val) {
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(cloneDeep);
  const copy = {};
  for (const k of Object.keys(val)) {
    copy[k] = cloneDeep(val[k]);
  }
  return copy;
}

function getBotFault(bot) {
  if (!bot) return null;
  if (typeof bot.consumeFault === "function") {
    const f = bot.consumeFault();
    if (f) return f;
  }
  if (typeof bot.getFault === "function") {
    const f = bot.getFault();
    if (f) return f;
  }
  return null;
}

const VALID_SEATS = new Set(["A", "B"]);
const VALID_PIECE_TYPES = new Set(["dam", "la", "keo"]);

/**
 * Validates initial host state for referee safety.
 * Returns null if valid, or an error code string if invalid.
 */
export function checkInitialState(state, engine) {
  if (!state || typeof state !== "object") return "missing_initial_state";
  if (!VALID_SEATS.has(state.turn)) return "invalid_initial_turn";

  if (
    state.winner !== null ||
    state.reason !== null ||
    (state.eliminatedPlayer !== undefined && state.eliminatedPlayer !== null)
  ) {
    return "initial_state_already_terminal";
  }

  // Clock validation: non-finite or negative banks must be rejected (no silent fresh bank fallback)
  if (!state.clock || typeof state.clock !== "object" || !state.clock.remainingMs) {
    return "invalid_initial_clock";
  }
  const remA = state.clock.remainingMs.A;
  const remB = state.clock.remainingMs.B;
  if (typeof remA !== "number" || !Number.isFinite(remA) || remA < 0) {
    return "invalid_initial_clock";
  }
  if (typeof remB !== "number" || !Number.isFinite(remB) || remB < 0) {
    return "invalid_initial_clock";
  }
  if (
    state.clock.runningSeat !== undefined &&
    state.clock.runningSeat !== null &&
    !VALID_SEATS.has(state.clock.runningSeat)
  ) {
    return "invalid_initial_clock";
  }

  // Pieces validation: bounded shape validation
  if (!Array.isArray(state.pieces)) return "invalid_initial_pieces";

  const seenIds = new Set();
  const seenCells = new Set();

  for (let i = 0; i < state.pieces.length; i++) {
    const p = state.pieces[i];
    if (!p || typeof p !== "object") return "invalid_piece";
    if (typeof p.id !== "string" || p.id.length === 0) return "invalid_piece_id";
    if (seenIds.has(p.id)) return "duplicate_piece_id";
    seenIds.add(p.id);

    if (!VALID_SEATS.has(p.player)) return "invalid_piece_player";
    if (!VALID_PIECE_TYPES.has(p.type)) return "invalid_piece_type";

    if (!Number.isInteger(p.x) || !Number.isInteger(p.y) || p.x < 0 || p.x > 8 || p.y < 0 || p.y > 8) {
      return "invalid_piece_coordinates";
    }

    const cellKey = `${p.x},${p.y}`;
    if (seenCells.has(cellKey)) return "duplicate_cell_occupancy";
    seenCells.add(cellKey);
  }

  // Already-won positions: use actual engine.detectWinner
  try {
    const won = engine.detectWinner(state);
    if (won && won.winner !== null) {
      return "initial_state_already_terminal";
    }
  } catch (_) {
    return "engine_initial_state_evaluation_failed";
  }

  // Check that the opening seat has at least one legal move available
  try {
    const legal = engine.allMoves(state, state.turn);
    if (!Array.isArray(legal) || legal.length === 0) {
      return "initial_state_no_legal_moves";
    }
  } catch (_) {
    return "engine_initial_state_evaluation_failed";
  }

  return null;
}

/**
 * Creates a HeadlessMatchController instance.
 * @param {object} options
 * @returns {{ run: () => Promise<import("../contracts/index.d.mts").ArenaMatchResult | import("../contracts/index.d.mts").RunFailure> }}
 */
export function createHeadlessMatchController(options) {
  if (!options || typeof options !== "object") {
    throw new Error("MatchController options must be an object");
  }

  const {
    matchId,
    engine,
    botA,
    botB,
    clock,
    journal,
    policy = DEFAULT_MATCH_POLICY,
    rulesetSnapshot,
    rulesetHash,
    engineRevision,
    engineGitRevision = null,
    participants,
    initialState,
    supervisorSignal,
    onAcceptedMove
  } = options;

  let executed = false;

  return {
    async run() {
      if (executed) {
        throw new Error("MatchController.run() can only be called once");
      }
      executed = true;

      // Check required ports
      if (!engine || !botA || !botB || !clock || !journal) {
        return createInfrastructureError({
          code: "missing_required_ports",
          retryable: false
        });
      }

      // Check supervisor signal upfront
      if (supervisorSignal?.aborted) {
        return createInfrastructureError({
          code: "interrupted",
          retryable: false
        });
      }

      // Validate match policy
      const policyVal = validateMatchPolicy(policy);
      if (!policyVal.ok) {
        return createInfrastructureError({
          code: "invalid_match_policy",
          retryable: false
        });
      }

      // Validate supplied rulesetSnapshot is structurally supported G
      if (!isSupportedEngineRuleset(rulesetSnapshot)) {
        return createInfrastructureError({
          code: "invalid_ruleset_snapshot",
          retryable: false
        });
      }

      // Default to engine.createInitialState() when initialState is undefined (omitted)
      let resolvedInitialState = initialState;
      if (resolvedInitialState === undefined) {
        try {
          resolvedInitialState = engine.createInitialState();
        } catch (_) {
          return createInfrastructureError({
            code: "engine_initial_state_evaluation_failed",
            retryable: false
          });
        }
      }

      // Validate host initial state
      const initialError = checkInitialState(resolvedInitialState, engine);
      if (initialError) {
        return createInfrastructureError({
          code: initialError,
          retryable: false
        });
      }

      // A policy with a first-move grace (bot-cup-policy-v1) owns the bank: both clocks start at policy.initialTimeMs,
      // and each seat's first move may take up to firstMoveGraceMs without being charged.
      const firstMoveGraceMs = Number.isInteger(policy.firstMoveGraceMs) ? policy.firstMoveGraceMs : 0;
      if (firstMoveGraceMs > 0) {
        resolvedInitialState = engine.cloneState(resolvedInitialState);
        resolvedInitialState.clock.remainingMs = { A: policy.initialTimeMs, B: policy.initialTimeMs };
      }
      const hasMoved = { A: false, B: false };

      // Authoritative clocks tracking
      const remainingMs = {
        A: resolvedInitialState.clock.remainingMs.A,
        B: resolvedInitialState.clock.remainingMs.B
      };

      let currentCoreState = null;
      let acceptedPlies = 0;
      let finalResult = null;
      let activeTimerHandle = null;
      let activeTurnAbort = null;
      let currentSupervisorCleanup = null;

      try {
        const refereeInitialCoreState = engine.cloneState(resolvedInitialState);
        currentCoreState = engine.cloneState(refereeInitialCoreState);

        // Start both bots with cloned context
        const startContextA = {
          matchId,
          seat: "A",
          rulesetId: rulesetSnapshot.rulesetId,
          rulesetHash,
          initialTimeMs: policy.initialTimeMs,
          turnTimeLimitMs: policy.turnTimeLimitMs
        };
        const startContextB = {
          matchId,
          seat: "B",
          rulesetId: rulesetSnapshot.rulesetId,
          rulesetHash,
          initialTimeMs: policy.initialTimeMs,
          turnTimeLimitMs: policy.turnTimeLimitMs
        };

        await botA.start(cloneDeep(startContextA));
        await botB.start(cloneDeep(startContextB));

        // Initialize journal
        journal.init({
          matchId,
          engineRevision,
          engineGitRevision,
          rulesetId: rulesetSnapshot.rulesetId,
          rulesetHash,
          rulesetSnapshot: cloneDeep(rulesetSnapshot),
          matchPolicy: cloneDeep(policy),
          participants: cloneDeep(participants || {
            A: { botId: botA.botId || "bot-a" },
            B: { botId: botB.botId || "bot-b" }
          }),
          initialCoreState: cloneDeep(refereeInitialCoreState)
        });

        journal.technicalEvent({
          type: "start",
          message: "Match started"
        });

        // Run loop
        while (!finalResult) {
          if (supervisorSignal?.aborted) {
            finalResult = createInfrastructureError({
              code: "interrupted",
              retryable: false
            });
            break;
          }

          const seat = currentCoreState.turn;
          if (!seat || (seat !== "A" && seat !== "B")) {
            break;
          }

          const otherSeat = seat === "A" ? "B" : "A";
          const legalMoves = engine.allMoves(currentCoreState, seat);

          if (legalMoves.length === 0) {
            // Non-terminal state with zero legal moves is an inconsistent engine state
            finalResult = createInfrastructureError({
              code: "inconsistent_engine_state_no_legal_moves",
              retryable: false
            });
            journal.technicalEvent({
              type: "infrastructure_error",
              message: `Engine returned zero legal moves for seat ${seat} without terminal winner`
            });
            break;
          }

          const ply = acceptedPlies + 1;
          const requestId = generateTurnRequestId(matchId, seat, ply);
          const graceTurn = firstMoveGraceMs > 0 && !hasMoved[seat];
          const deadlineBudget = graceTurn ? firstMoveGraceMs : Math.min(policy.turnTimeLimitMs, remainingMs[seat]);
          // The bank pays for every move except a grace move.
          const charge = (ms) => {
            if (!graceTurn) remainingMs[seat] = Math.max(0, remainingMs[seat] - ms);
          };

          const wirePieces = currentCoreState.pieces.map((p) => ({
            id: p.id,
            owner: p.player,
            type: p.type,
            x: p.x,
            y: p.y
          }));

          const wireLegalMoves = legalMoves.map((m) => ({
            from: { x: m.from.x, y: m.from.y },
            to: { x: m.to.x, y: m.to.y }
          }));

          const turnPayload = {
            protocolVersion: 1,
            type: "turn",
            requestId,
            matchId,
            rulesetId: rulesetSnapshot.rulesetId,
            rulesetHash,
            boardWidth: rulesetSnapshot.boardWidth,
            boardHeight: rulesetSnapshot.boardHeight,
            ply,
            turn: seat,
            timeRemainingMs: remainingMs[seat],
            turnTimeLimitMs: graceTurn ? firstMoveGraceMs : policy.turnTimeLimitMs,
            board: wirePieces,
            legalMoves: wireLegalMoves
          };

          // Arm deadline and abort controller
          activeTurnAbort = new AbortController();
          const turnSignal = activeTurnAbort.signal;
          let turnSettled = false;
          let timedOut = false;
          let onSupervisorAbort = null;

          const startMs = clock.nowMs();

          const timeoutPromise = new Promise((resolve) => {
            activeTimerHandle = clock.schedule(deadlineBudget, () => {
              if (!turnSettled) {
                timedOut = true;
                activeTurnAbort.abort();
                resolve({ kind: "timeout" });
              }
            });
          });

          const supervisorPromise = new Promise((resolve) => {
            if (supervisorSignal?.aborted) {
              activeTurnAbort.abort();
              resolve({ kind: "supervisor_abort" });
            } else if (supervisorSignal) {
              onSupervisorAbort = () => {
                activeTurnAbort.abort();
                resolve({ kind: "supervisor_abort" });
              };
              supervisorSignal.addEventListener("abort", onSupervisorAbort);
            }
          });

          currentSupervisorCleanup = () => {
            if (supervisorSignal && onSupervisorAbort) {
              supervisorSignal.removeEventListener("abort", onSupervisorAbort);
              onSupervisorAbort = null;
            }
          };

          const currentBot = seat === "A" ? botA : botB;
          const botPromise = Promise.resolve()
            .then(() => currentBot.requestMove(cloneDeep(turnPayload), turnSignal))
            .then((action) => ({ kind: "action", action }))
            .catch((err) => ({ kind: "error", error: err }));

          let raceResult;
          try {
            raceResult = await Promise.race([botPromise, timeoutPromise, supervisorPromise]);
          } finally {
            turnSettled = true;
            if (activeTimerHandle !== null) {
              clock.cancel(activeTimerHandle);
              activeTimerHandle = null;
            }
            if (currentSupervisorCleanup) {
              currentSupervisorCleanup();
              currentSupervisorCleanup = null;
            }
          }

          let receiveMs = null;
          if (raceResult.kind === "action" && typeof currentBot.getReceiptTime === "function") {
            try {
              const candidateMs = currentBot.getReceiptTime(raceResult.action);
              const nowMs = clock.nowMs();
              if (
                typeof candidateMs === "number" &&
                Number.isFinite(candidateMs) &&
                candidateMs >= startMs &&
                candidateMs <= nowMs
              ) {
                receiveMs = candidateMs;
              }
            } catch (_) {
              receiveMs = null;
            }
          }
          if (receiveMs === null) {
            receiveMs = clock.nowMs();
          }
          const elapsedMs = Math.max(0, receiveMs - startMs);

          // Handle supervisor abort
          if (raceResult.kind === "supervisor_abort") {
            finalResult = createInfrastructureError({
              code: "interrupted",
              retryable: false
            });
            break;
          }

          // Check for pending faults on either bot (cross-seat fault detection)
          // If non-acting bot faulted during this turn, non-acting bot forfeits
          const otherBot = seat === "A" ? botB : botA;
          const otherFault = getBotFault(otherBot);
          if (otherFault) {
            charge(elapsedMs);
            const forfeitReason =
              otherFault.code === "output_limit" || otherFault.code === "protocol_error" || otherFault.code === "crash"
                ? otherFault.code
                : "protocol_error";
            finalResult = createForfeitResult({
              winner: seat,
              loser: otherSeat,
              reason: forfeitReason,
              acceptedPlies
            });
            journal.technicalEvent({
              type: "fault",
              message: `Non-acting seat ${otherSeat} faulted: ${otherFault.message || forfeitReason}`
            });
            break;
          }

          const currentFault = getBotFault(currentBot);
          if (currentFault) {
            charge(elapsedMs);
            const forfeitReason =
              currentFault.code === "output_limit" || currentFault.code === "protocol_error" || currentFault.code === "crash"
                ? currentFault.code
                : "protocol_error";
            finalResult = createForfeitResult({
              winner: otherSeat,
              loser: seat,
              reason: forfeitReason,
              acceptedPlies
            });
            journal.technicalEvent({
              type: "fault",
              message: `Acting seat ${seat} faulted: ${currentFault.message || forfeitReason}`
            });
            break;
          }

          // Evaluate timeout conditions
          // Priority: remaining <= turnTimeLimitMs => total_timeout; otherwise turn_timeout
          const isTotalTimeout = !graceTurn && remainingMs[seat] <= policy.turnTimeLimitMs;
          const timeoutReason = isTotalTimeout ? "total_timeout" : "turn_timeout";

          // Clock boundary: elapsed >= deadlineBudget is timeout, response at exact deadline is NOT committed
          if (raceResult.kind === "timeout" || timedOut || elapsedMs >= deadlineBudget) {
            charge(deadlineBudget);
            finalResult = createForfeitResult({
              winner: otherSeat,
              loser: seat,
              reason: timeoutReason,
              acceptedPlies
            });
            journal.technicalEvent({
              type: "fault",
              message: `Seat ${seat} timed out (${timeoutReason})`
            });
            break;
          }

          // Handle bot rejection/crash or structured infrastructure error
          if (raceResult.kind === "error") {
            if (supervisorSignal?.aborted) {
              finalResult = createInfrastructureError({
                code: "interrupted",
                retryable: false
              });
              break;
            }

            const err = raceResult.error;

            // Preserve structured infrastructure error from bot adapter
            if (
              err &&
              typeof err === "object" &&
              (err.kind === "infrastructure_error" || err.code === "infrastructure_error")
            ) {
              finalResult = createInfrastructureError({
                code: err.code || "infrastructure_error",
                retryable: Boolean(err.retryable)
              });
              journal.technicalEvent({
                type: "infrastructure_error",
                message: `Infrastructure failure on seat ${seat}: ${finalResult.code}`
              });
              break;
            }

            charge(elapsedMs);

            let forfeitReason = "crash";
            if (err && typeof err === "object" && typeof err.code === "string") {
              if (err.code === "output_limit" || err.code === "protocol_error") {
                forfeitReason = err.code;
              }
            }

            finalResult = createForfeitResult({
              winner: otherSeat,
              loser: seat,
              reason: forfeitReason,
              acceptedPlies
            });
            journal.technicalEvent({
              type: "fault",
              message: `Seat ${seat} faulted: ${forfeitReason}`
            });
            break;
          }

          // Deduct elapsed time from acting seat
          charge(elapsedMs);

          // Validate bot action format
          const action = raceResult.action;
          const actionValidation = validateBotAction(action, requestId);
          if (!actionValidation.ok) {
            finalResult = createForfeitResult({
              winner: otherSeat,
              loser: seat,
              reason: "protocol_error",
              acceptedPlies
            });
            journal.technicalEvent({
              type: "fault",
              message: `Seat ${seat} protocol error: ${actionValidation.errors.map((e) => e.message).join(", ")}`
            });
            break;
          }

          // Validate and apply move via core engine
          const moveResult = engine.applyMove(currentCoreState, seat, action.move.from, action.move.to);
          if (!moveResult.ok) {
            finalResult = createForfeitResult({
              winner: otherSeat,
              loser: seat,
              reason: "illegal_move",
              acceptedPlies
            });
            journal.technicalEvent({
              type: "fault",
              message: `Seat ${seat} illegal move: ${moveResult.error}`
            });
            break;
          }

          // Move accepted!
          acceptedPlies += 1;
          hasMoved[seat] = true;
          currentCoreState = moveResult.state;
          currentCoreState.clock.remainingMs.A = remainingMs.A;
          currentCoreState.clock.remainingMs.B = remainingMs.B;

          let capturedId = null;
          let capturedType = null;
          let movedPieceId = "";
          for (const ev of moveResult.events) {
            if (ev.type === "capture") {
              capturedId = ev.capturedId;
              capturedType = ev.capturedType;
            }
            if (ev.type === "move" || ev.type === "capture") {
              movedPieceId = ev.pieceId;
            }
          }

          const acceptedInput = {
            seat,
            pieceId: movedPieceId,
            from: { x: action.move.from.x, y: action.move.from.y },
            to: { x: action.move.to.x, y: action.move.to.y },
            capturedPieceId: capturedId,
            capturedPieceType: capturedType,
            elapsedMs,
            remainingMs: remainingMs[seat],
            events: cloneDeep(moveResult.events),
            comment: action.comment,
            coreState: cloneDeep(currentCoreState)
          };

          journal.acceptedMove(acceptedInput);

          if (typeof onAcceptedMove === "function") {
            try {
              onAcceptedMove({
                ply: acceptedPlies,
                seat,
                move: { from: acceptedInput.from, to: acceptedInput.to },
                frame: {
                  ply: acceptedPlies,
                  seat,
                  move: { from: acceptedInput.from, to: acceptedInput.to },
                  capturedPieceId: capturedId,
                  capturedPieceType: capturedType,
                  elapsedMs,
                  remainingMs: remainingMs[seat],
                  clock: cloneDeep(currentCoreState.clock),
                  comment: action.comment,
                  state: cloneDeep(currentCoreState)
                }
              });
            } catch (_) {}
          }

          // Terminal precedence after accepted move: goal -> elimination -> no_moves -> cap
          if (currentCoreState.winner) {
            finalResult = createWinResult({
              winner: currentCoreState.winner,
              loser: currentCoreState.winner === "A" ? "B" : "A",
              reason: currentCoreState.reason,
              acceptedPlies
            });
            break;
          }

          // Cap check
          if (acceptedPlies >= policy.maxPlies) {
            finalResult = createDrawResult({
              acceptedPlies
            });
            break;
          }
        }

        // Finish replay journal if match concluded normally
        if (finalResult && finalResult.kind !== "infrastructure_error" && currentCoreState) {
          const terminalCoreState = engine.cloneState(currentCoreState);
          terminalCoreState.clock.remainingMs.A = remainingMs.A;
          terminalCoreState.clock.remainingMs.B = remainingMs.B;
          terminalCoreState.clock.runningSeat = null;

          // Win result updates winner/reason in terminal state; forfeit/draw do not fabricate core win event
          if (finalResult.outcome === "win") {
            terminalCoreState.winner = finalResult.winner;
            terminalCoreState.reason = finalResult.reason;
          }

          journal.finish(finalResult, terminalCoreState);
        }
      } catch (hostError) {
        let infraCode = "host_failure";
        let retryable = false;
        if (hostError && typeof hostError === "object") {
          if (hostError.kind === "infrastructure_error" && hostError.code) {
            infraCode = hostError.code;
            retryable = Boolean(hostError.retryable);
          } else if (typeof hostError.code === "string" && hostError.code.length > 0) {
            infraCode = hostError.code;
            retryable = Boolean(hostError.retryable);
          }
        }
        finalResult = createInfrastructureError({
          code: infraCode,
          retryable
        });
      } finally {
        if (activeTimerHandle !== null && clock) {
          clock.cancel(activeTimerHandle);
          activeTimerHandle = null;
        }
        if (activeTurnAbort) {
          activeTurnAbort.abort();
        }
        if (typeof currentSupervisorCleanup === "function") {
          currentSupervisorCleanup();
          currentSupervisorCleanup = null;
        }
        const stopBot = (bot) => Promise.resolve().then(() => bot?.stop?.());
        await Promise.allSettled([stopBot(botA), stopBot(botB)]);
      }

      return finalResult;
    }
  };
}
