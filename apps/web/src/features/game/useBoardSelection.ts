import { useCallback, useEffect, useMemo, useState } from "react";
import type { GameSession } from "../../sessions/contract";
import type { GameSnapshot, Position, SessionErrorView } from "../../shared/model/game";
import { blockedTargets, type BlockedTarget } from "./captureFx";

export interface BoardSelection {
  readonly from: Position;
  readonly legalMoves: readonly Position[];
  /** Neighbouring opponent squares the session refused, with a reason to show. */
  readonly blocked: readonly BlockedTarget[];
}

export interface UseBoardSelectionOptions {
  readonly session: GameSession;
  readonly snapshot: GameSnapshot;
  readonly onMove?: (from: Position, to: Position) => void;
  readonly onError?: (error: SessionErrorView) => void;
  readonly onBlocked?: (target: BlockedTarget) => void;
}

const samePosition = (a: Position, b: Position) => a.x === b.x && a.y === b.y;

export function useBoardSelection({ session, snapshot, onMove, onError, onBlocked }: UseBoardSelectionOptions) {
  const [selection, setSelection] = useState<BoardSelection | null>(null);
  const pieceByPosition = useMemo<Map<string, (typeof snapshot.board)[number]>>(() => new Map(snapshot.board.map((piece) => [`${piece.position.x}:${piece.position.y}`, piece] as const)), [snapshot.board]);
  const canInteract = snapshot.capabilities.canMove
    && snapshot.phase === "playing"
    && snapshot.viewer?.role === "player"
    && snapshot.turn === snapshot.viewer.seat
    && !snapshot.pendingMove
    && !snapshot.aiThinking
    && snapshot.connection !== "reconnecting";
  const viewer = snapshot.viewer;
  const viewerRole = viewer?.role;
  const viewerSeat = viewer && viewer.role === "player" ? viewer.seat : null;

  useEffect(() => {
    setSelection(null);
  }, [canInteract, snapshot.turn, snapshot.boardRevision, snapshot.connection, snapshot.pendingMove, snapshot.aiThinking, snapshot.phase, viewerRole, viewerSeat]);

  const select = useCallback(async (position: Position) => {
    if (!canInteract) return;
    const key = `${position.x}:${position.y}`;
    const piece = pieceByPosition.get(key);
    if (selection && selection.legalMoves.some((move) => samePosition(move, position))) {
      const from = selection.from;
      setSelection(null);
      const result = await session.move(from, position);
      if (result.accepted) onMove?.(from, position);
      else onError?.(result.error);
      return;
    }
    const blocked = selection?.blocked.find((target) => samePosition(target.position, position));
    if (blocked) {
      onBlocked?.(blocked);
      return;
    }
    if (!piece || viewerRole !== "player" || piece.seat !== viewerSeat) {
      setSelection(null);
      return;
    }
    const legalMoves = session.getLegalMoves(position).map((move) => ({ ...move }));
    setSelection({ from: { ...position }, legalMoves, blocked: blockedTargets(piece, snapshot.board, legalMoves) });
  }, [canInteract, onBlocked, onError, onMove, pieceByPosition, selection, session, snapshot.board, viewerRole, viewerSeat]);

  return { selection, canInteract, pieceByPosition, select };
}
