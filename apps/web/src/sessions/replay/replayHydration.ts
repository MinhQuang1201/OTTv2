import type { CoreState, ReplayDocument } from "../contract";
import type { PracticeStart } from "../contract";
import { isSupportedEngineRuleset } from "../../../../../packages/arena/src/contracts/index.mjs";
import { getGameCoreBridge } from "../core/gameCoreBridge";

export const DEFAULT_RULESET_ID = "ottv2-g-default-v1";

export const DEFAULT_COMPATIBLE_RULESET_HASHES: readonly string[] = Object.freeze([
  "sha256:a00ee0cddc9d1dba495babf87bea2184d20feaa964b1741ec06c9bb972fd5e88",
]);

/**
 * Production allowlist strictly contains the actual current Core G engine fingerprint.
 * Fixture or probe revisions must be explicitly injected in tests or use this revision.
 */
export const DEFAULT_COMPATIBLE_ENGINE_REVISIONS: readonly string[] = Object.freeze([
  "sha256:d9cec0298cf11aba83a986223446ad220ec2c390a2b4e63906b4218681a5d164",
]);

export interface HydratePracticeOptions {
  readonly compatibleEngineRevisions?: readonly string[];
  readonly compatibleRulesetHashes?: readonly string[];
}

export type HydratePracticeResult =
  | { readonly ok: true; readonly practice: PracticeStart }
  | { readonly ok: false; readonly reason: string };

export function generatePracticeId(): string {
  if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `practice-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Validates the structural shape of a CoreState (9x9 bounds, unique IDs, single occupancy).
 * Win detection and legal moves are delegated to the core rules bridge rather than manual duplication.
 */
export function validateCoreStateShape(state: unknown): { ok: true; state: CoreState } | { ok: false; reason: string } {
  if (!state || typeof state !== "object") {
    return { ok: false, reason: "Trạng thái bàn cờ không phải là đối tượng hợp lệ." };
  }
  const candidate = state as Partial<CoreState>;

  if (candidate.winner !== null) {
    return { ok: false, reason: "Không thể thử đi khác từ thế cờ đã kết thúc." };
  }
  if (candidate.reason !== null && candidate.reason !== undefined) {
    return { ok: false, reason: "Không thể thử đi khác từ thế cờ có lý do kết thúc." };
  }
  if (candidate.eliminatedPlayer !== null && candidate.eliminatedPlayer !== undefined) {
    return { ok: false, reason: "Không thể thử đi khác từ thế cờ có đấu thủ bị loại." };
  }
  if (candidate.turn !== "A" && candidate.turn !== "B") {
    return { ok: false, reason: "Lượt chơi hiện tại không hợp lệ (phải là A hoặc B)." };
  }

  if (!Array.isArray(candidate.pieces) || candidate.pieces.length === 0 || candidate.pieces.length > 81) {
    return { ok: false, reason: "Số lượng quân cờ không hợp lệ trên bàn 9×9." };
  }

  const seenIds = new Set<string>();
  const seenCells = new Set<string>();

  for (const piece of candidate.pieces) {
    if (!piece || typeof piece !== "object") {
      return { ok: false, reason: "Dữ liệu quân cờ không hợp lệ." };
    }
    if (typeof piece.id !== "string" || !piece.id) {
      return { ok: false, reason: "Quân cờ thiếu định danh hợp lệ." };
    }
    if (seenIds.has(piece.id)) {
      return { ok: false, reason: `Trùng lặp định danh quân cờ: ${piece.id}` };
    }
    seenIds.add(piece.id);

    if (piece.player !== "A" && piece.player !== "B") {
      return { ok: false, reason: `Phe sở hữu quân cờ '${piece.id}' không hợp lệ.` };
    }
    if (piece.type !== "dam" && piece.type !== "la" && piece.type !== "keo") {
      return { ok: false, reason: `Loại quân cờ '${piece.id}' không hợp lệ.` };
    }

    if (!Number.isInteger(piece.x) || !Number.isInteger(piece.y) || piece.x < 0 || piece.x > 8 || piece.y < 0 || piece.y > 8) {
      return { ok: false, reason: `Tọa độ quân cờ '${piece.id}' (${piece.x}, ${piece.y}) nằm ngoài bàn cờ 9×9.` };
    }

    const cellKey = `${piece.x},${piece.y}`;
    if (seenCells.has(cellKey)) {
      return { ok: false, reason: `Nhiều quân cờ cùng đứng tại ô (${piece.x}, ${piece.y}).` };
    }
    seenCells.add(cellKey);
  }

  return { ok: true, state: state as CoreState };
}

/**
 * Validates an arbitrary PracticeStart envelope to prevent callers from bypassing validation
 * or injecting forged game states with winners, duplicates, or incompatible identities.
 */
export function validatePracticeStart(
  practice: unknown,
  options: HydratePracticeOptions = {}
): { ok: true; validated: PracticeStart } | { ok: false; reason: string } {
  if (!practice || typeof practice !== "object") {
    return { ok: false, reason: "PracticeStart không phải là đối tượng hợp lệ." };
  }
  const candidate = practice as Partial<PracticeStart>;

  if (typeof candidate.practiceId !== "string" || !candidate.practiceId) {
    return { ok: false, reason: "Thiếu practiceId hợp lệ." };
  }
  if (typeof candidate.parentMatchId !== "string" || !candidate.parentMatchId) {
    return { ok: false, reason: "Thiếu parentMatchId hợp lệ." };
  }
  if (!Number.isInteger(candidate.parentPly) || candidate.parentPly! < 0) {
    return { ok: false, reason: "parentPly không hợp lệ." };
  }
  if (candidate.rulesetId !== DEFAULT_RULESET_ID) {
    return { ok: false, reason: `Bộ luật '${candidate.rulesetId}' không được hỗ trợ.` };
  }

  const allowedHashes = options.compatibleRulesetHashes ?? DEFAULT_COMPATIBLE_RULESET_HASHES;
  if (typeof candidate.rulesetHash !== "string" || !allowedHashes.includes(candidate.rulesetHash)) {
    return { ok: false, reason: `Hash bộ luật '${candidate.rulesetHash}' không tương thích.` };
  }

  const allowedEngines = options.compatibleEngineRevisions ?? DEFAULT_COMPATIBLE_ENGINE_REVISIONS;
  if (typeof candidate.engineRevision !== "string" || !allowedEngines.includes(candidate.engineRevision)) {
    return { ok: false, reason: `Phiên bản engine '${candidate.engineRevision}' không tương thích.` };
  }

  const shapeVal = validateCoreStateShape(candidate.coreState);
  if (!shapeVal.ok) {
    return shapeVal;
  }
  const coreState = shapeVal.state;

  // Validate core state semantics using actual core rules truth
  const bridge = getGameCoreBridge();
  const detectedWin = bridge.detectWinner(coreState);
  if (detectedWin !== null) {
    return { ok: false, reason: `Thế cờ đã có kết quả kết thúc (${detectedWin.reason}).` };
  }

  const legalMoves = bridge.allMoves(coreState, coreState.turn!);
  if (legalMoves.length === 0) {
    return { ok: false, reason: `Phe ${coreState.turn} không còn nước đi hợp lệ.` };
  }

  return {
    ok: true,
    validated: {
      practiceId: candidate.practiceId,
      parentMatchId: candidate.parentMatchId,
      parentPly: candidate.parentPly!,
      rulesetId: candidate.rulesetId,
      rulesetHash: candidate.rulesetHash,
      engineRevision: candidate.engineRevision,
      coreState: structuredClone(coreState),
    },
  };
}

/**
 * Validates and hydrates a deeply independent practice CoreState from a replay document at cursor ply.
 * Delegates win conditions and legal moves directly to core rules truth rather than manual duplication.
 */
export function hydratePracticeCoreState(
  document: ReplayDocument,
  cursor: number,
  options: HydratePracticeOptions = {}
): HydratePracticeResult {
  if (!document || typeof document !== "object") {
    return { ok: false, reason: "Tài liệu replay không hợp lệ." };
  }

  // 1. Compatibility verification
  if (document.rulesetId !== DEFAULT_RULESET_ID) {
    return { ok: false, reason: `Bộ luật '${document.rulesetId}' không được hỗ trợ để thử đi khác.` };
  }

  const allowedHashes = options.compatibleRulesetHashes ?? DEFAULT_COMPATIBLE_RULESET_HASHES;
  if (!allowedHashes.includes(document.rulesetHash)) {
    return { ok: false, reason: `Hash bộ luật '${document.rulesetHash}' không tương thích.` };
  }

  const allowedEngines = options.compatibleEngineRevisions ?? DEFAULT_COMPATIBLE_ENGINE_REVISIONS;
  if (!allowedEngines.includes(document.engineRevision)) {
    return { ok: false, reason: `Phiên bản engine '${document.engineRevision}' không tương thích để thử đi khác.` };
  }

  if (!isSupportedEngineRuleset(document.rulesetSnapshot)) {
    return { ok: false, reason: "Cấu hình snapshot bộ luật không tương thích chuẩn ottv2-g-default-v1." };
  }

  // 2. Cursor and frames array bounds check
  if (!Array.isArray(document.frames)) {
    return { ok: false, reason: "Danh sách khung hình replay không hợp lệ." };
  }

  if (!Number.isInteger(cursor) || cursor < 0 || cursor >= document.frames.length) {
    return { ok: false, reason: `Nước đi ${cursor} nằm ngoài phạm vi danh sách khung hình replay.` };
  }

  const frame = document.frames[cursor];
  if (!frame || !frame.coreState || typeof frame.coreState !== "object") {
    return { ok: false, reason: `Khung hình tại nước ${cursor} thiếu trạng thái bàn cờ.` };
  }

  // 3. Structural shape validation
  const shapeVal = validateCoreStateShape(frame.coreState);
  if (!shapeVal.ok) {
    return shapeVal;
  }
  const state = shapeVal.state;

  // 4. Core truth validation via single source of truth (game core bridge)
  const bridge = getGameCoreBridge();
  const detectedWin = bridge.detectWinner(state);
  if (detectedWin !== null) {
    return { ok: false, reason: `Thế cờ đã có kết quả kết thúc (${detectedWin.reason}).` };
  }

  const legalMoves = bridge.allMoves(state, state.turn!);
  if (legalMoves.length === 0) {
    return { ok: false, reason: `Phe ${state.turn} không còn nước đi hợp lệ.` };
  }

  // 5. Deep clone and hydrate independent CoreState with fresh clocks
  const freshBudgetMs = 600000;
  const hydratedCoreState: CoreState = {
    turn: state.turn,
    winner: null,
    reason: null,
    eliminatedPlayer: null,
    clock: {
      remainingMs: { A: freshBudgetMs, B: freshBudgetMs },
      runningSeat: state.turn,
    },
    pieces: state.pieces.map((p) => ({
      id: p.id,
      player: p.player,
      type: p.type,
      x: p.x,
      y: p.y,
    })),
  };

  return {
    ok: true,
    practice: {
      practiceId: generatePracticeId(),
      parentMatchId: document.matchId,
      parentPly: cursor,
      rulesetId: document.rulesetId,
      rulesetHash: document.rulesetHash,
      engineRevision: document.engineRevision,
      coreState: hydratedCoreState,
    },
  };
}
