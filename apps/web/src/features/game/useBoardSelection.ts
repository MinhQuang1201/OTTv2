import { useCallback, useEffect, useMemo, useState } from "react";
import type { GameSession } from "../../sessions/contract";
import type { GameSnapshot, Position, SessionErrorView } from "../../shared/model/game";

export interface BoardSelection {
  readonly from: Position;
  readonly legalMoves: readonly Position[];
}

export interface UseBoardSelectionOptions {
  readonly session: GameSession;
  readonly snapshot: GameSnapshot;
  readonly onMove?: (from: Position, to: Position) => void;
  readonly onError?: (error: SessionErrorView) => void;
}

const samePosition = (a: Position, b: Position) => a.x === b.x && a.y === b.y;

export function useBoardSelection({ session, snapshot, onMove, onError }: UseBoardSelectionOptions) {
  const [selection, setSelection] = useState<BoardSelection | null>(null);
  const pieceByPosition = useMemo<Map<string, (typeof snapshot.board)[number]>>(() => new Map(snapshot.board.map((piece) => [`${piece.position.x}:${piece.position.y}`, piece] as const)), [snapshot.board]);
  const canInteract = snapshot.phase === "playing"
    && snapshot.viewerSeat !== null
    && snapshot.turn === snapshot.viewerSeat
    && !snapshot.pendingMove
    && !snapshot.aiThinking
    && snapshot.connection !== "reconnecting";

  useEffect(() => {
    setSelection(null);
  }, [snapshot.turn, snapshot.boardRevision, snapshot.connection, snapshot.pendingMove, snapshot.aiThinking, snapshot.phase]);

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
    if (!piece || piece.seat !== snapshot.viewerSeat) {
      setSelection(null);
      return;
    }
    const legalMoves = session.getLegalMoves(position);
    setSelection({ from: { ...position }, legalMoves: legalMoves.map((move) => ({ ...move })) });
  }, [canInteract, onError, onMove, pieceByPosition, selection, session, snapshot.viewerSeat]);

  return { selection, canInteract, pieceByPosition, select };
}
