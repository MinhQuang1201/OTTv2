/**
 * Pure ReplayJournal implementation conforming to JournalPort.
 * Captures initial state, referee-accepted moves, technical events, and terminal outcomes.
 * Owns sequence (seq) and ply mapping. Enforces strict deep clone isolation.
 * Zero Node.js imports. Standard Web API / Pure JS.
 */

function cloneDeep(val) {
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(cloneDeep);
  const copy = {};
  for (const k of Object.keys(val)) {
    copy[k] = cloneDeep(val[k]);
  }
  return copy;
}

/**
 * Creates an instance of ReplayJournal conforming to JournalPort.
 * @returns {ReplayJournal}
 */
export function createReplayJournal() {
  return new ReplayJournal();
}

export class ReplayJournal {
  constructor() {
    this._initialized = false;
    this._finished = false;
    this._meta = null;
    this._frames = [];
    this._events = [];
    this._seqCounter = 0;
    this._currentPly = 0;
    this._finalizedDocument = null;
  }

  /**
   * Initializes the replay journal with match configuration and opening state.
   * Emits the initial event at seq 0, ply 0 and establishes frame 0.
   * @param {import("../contracts/index.d.mts").ReplayInit} input
   */
  init(input) {
    if (this._initialized) {
      throw new Error("ReplayJournal already initialized");
    }
    if (!input || typeof input !== "object") {
      throw new Error("ReplayJournal.init requires non-null input object");
    }

    this._initialized = true;
    this._meta = {
      matchId: input.matchId,
      engineRevision: input.engineRevision,
      engineGitRevision: input.engineGitRevision !== undefined ? input.engineGitRevision : null,
      rulesetId: input.rulesetId,
      rulesetHash: input.rulesetHash,
      rulesetSnapshot: cloneDeep(input.rulesetSnapshot),
      matchPolicy: cloneDeep(input.matchPolicy),
      participants: cloneDeep(input.participants),
      initialCoreState: cloneDeep(input.initialCoreState)
    };

    this._currentPly = 0;
    this._seqCounter = 0;

    // Frame 0: opening position strictly prior to moves
    this._frames = [
      {
        ply: 0,
        coreState: cloneDeep(input.initialCoreState),
        lastMove: null
      }
    ];

    // Initial event at seq 0, ply 0
    this._events = [
      {
        seq: this._seqCounter++,
        ply: 0,
        type: "init",
        payload: {}
      }
    ];
  }

  /**
   * Records a referee-accepted move. Excludes coreState from persisted lastMove.
   * Emits 'move' event and optional 'capture' event with monotonic seq and current ply.
   * @param {import("../contracts/index.d.mts").AcceptedMoveInput} input
   */
  acceptedMove(input) {
    if (!this._initialized) {
      throw new Error("ReplayJournal not initialized");
    }
    if (this._finished) {
      throw new Error("ReplayJournal already finished");
    }
    if (!input || typeof input !== "object") {
      throw new Error("AcceptedMoveInput must be an object");
    }

    this._currentPly += 1;
    const ply = this._currentPly;

    // Strictly exclude coreState from persisted lastMove in ReplayFrame
    const lastMove = {
      seat: input.seat,
      pieceId: input.pieceId,
      from: cloneDeep(input.from),
      to: cloneDeep(input.to),
      capturedPieceId: input.capturedPieceId !== undefined ? input.capturedPieceId : null,
      capturedPieceType: input.capturedPieceType !== undefined ? input.capturedPieceType : null,
      elapsedMs: input.elapsedMs,
      remainingMs: input.remainingMs,
      events: cloneDeep(input.events || []),
      ...(input.comment !== undefined ? { comment: input.comment } : {})
    };

    this._frames.push({
      ply,
      coreState: cloneDeep(input.coreState),
      lastMove
    });

    // 1. Emit move event
    this._events.push({
      seq: this._seqCounter++,
      ply,
      type: "move",
      payload: {
        seat: input.seat,
        pieceId: input.pieceId,
        from: cloneDeep(input.from),
        to: cloneDeep(input.to),
        elapsedMs: input.elapsedMs,
        remainingMs: input.remainingMs,
        ...(input.comment !== undefined ? { comment: input.comment } : {})
      }
    });

    // 2. Emit capture event if a piece was captured
    if (input.capturedPieceId) {
      this._events.push({
        seq: this._seqCounter++,
        ply,
        type: "capture",
        payload: {
          pieceId: input.pieceId,
          capturedPieceId: input.capturedPieceId,
          capturedPieceType: input.capturedPieceType !== undefined ? input.capturedPieceType : null,
          from: cloneDeep(input.from),
          to: cloneDeep(input.to)
        }
      });
    }
  }

  /**
   * Records a technical or referee event. Assigns sequential seq and maps current ply.
   * Input does not require seq or ply.
   * @param {import("../contracts/index.d.mts").TechnicalEventInput} input
   */
  technicalEvent(input) {
    if (!this._initialized) {
      throw new Error("ReplayJournal not initialized");
    }
    if (this._finished) {
      throw new Error("ReplayJournal already finished");
    }
    if (!input || typeof input !== "object") {
      throw new Error("TechnicalEventInput must be an object");
    }

    this._events.push({
      seq: this._seqCounter++,
      ply: this._currentPly,
      type: "technical",
      payload: {
        type: input.type,
        message: input.message,
        ...(input.detail !== undefined ? { detail: cloneDeep(input.detail) } : {})
      }
    });
  }

  /**
   * Finalizes match replay. Idempotent: repeated finish calls return finalized clone
   * without adding extra terminal events.
   * @param {import("../contracts/index.d.mts").ArenaMatchResult} result
   * @param {import("../contracts/index.d.mts").CoreState} terminalState
   * @returns {import("../contracts/index.d.mts").ReplayDocument}
   */
  finish(result, terminalState) {
    if (!this._initialized) {
      throw new Error("ReplayJournal not initialized");
    }

    if (this._finished && this._finalizedDocument) {
      return cloneDeep(this._finalizedDocument);
    }

    if (!result || typeof result !== "object") {
      throw new Error("ReplayJournal.finish requires result object");
    }
    if (!terminalState || typeof terminalState !== "object") {
      throw new Error("ReplayJournal.finish requires terminalState object");
    }

    this._finished = true;

    const clonedTerminal = cloneDeep(terminalState);
    if (clonedTerminal.clock) {
      clonedTerminal.clock.runningSeat = null;
    }
    if (result.outcome === "draw" || result.outcome === "forfeit") {
      clonedTerminal.winner = null;
      clonedTerminal.reason = null;
      clonedTerminal.eliminatedPlayer = null;
    } else if (result.outcome === "win") {
      clonedTerminal.winner = result.winner;
      clonedTerminal.reason = result.reason;
      if (result.reason === "elimination") {
        clonedTerminal.eliminatedPlayer = result.loser;
      }
    }

    // Terminal event
    this._events.push({
      seq: this._seqCounter++,
      ply: this._currentPly,
      type: "terminal",
      payload: cloneDeep(result)
    });

    this._finalizedDocument = {
      schemaVersion: 1,
      matchId: this._meta.matchId,
      engineRevision: this._meta.engineRevision,
      engineGitRevision: this._meta.engineGitRevision,
      rulesetId: this._meta.rulesetId,
      rulesetHash: this._meta.rulesetHash,
      rulesetSnapshot: cloneDeep(this._meta.rulesetSnapshot),
      matchPolicy: cloneDeep(this._meta.matchPolicy),
      participants: cloneDeep(this._meta.participants),
      initialCoreState: cloneDeep(this._meta.initialCoreState),
      frames: cloneDeep(this._frames),
      events: cloneDeep(this._events),
      result: cloneDeep(result),
      terminalCoreState: clonedTerminal
    };

    return cloneDeep(this._finalizedDocument);
  }

  /**
   * Returns a deep clone of the finalized ReplayDocument, or null if match is still in progress.
   * @returns {import("../contracts/index.d.mts").ReplayDocument | null}
   */
  getDocument() {
    if (!this._finished || !this._finalizedDocument) {
      return null;
    }
    return cloneDeep(this._finalizedDocument);
  }
}
