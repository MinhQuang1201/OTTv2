import { useMemo, useRef } from "react";
import type { GameSession } from "../../sessions/contract";
import type { GameSnapshot, Position, SessionErrorView } from "../../shared/model/game";
import { BoardCell } from "./BoardCell";
import { captureLabel, type BlockedTarget, type CaptureEffect } from "./captureFx";
import { useBoardSelection } from "./useBoardSelection";
import { usePieceSlide } from "./usePieceSlide";
import styles from "./game.module.css";

export interface BoardProps {
  readonly session: GameSession;
  readonly snapshot: GameSnapshot;
  readonly onMove?: (from: Position, to: Position) => void;
  readonly onError?: (error: SessionErrorView) => void;
  readonly highlightMove?: { readonly from?: Position; readonly to?: Position } | null;
  readonly perspective?: "A" | "B";
  readonly lastCapture?: Position | null;
  /** Capture currently being presented; purely visual. */
  readonly captureEffect?: CaptureEffect | null;
  readonly onBlocked?: (target: BlockedTarget) => void;
}

export function Board({
  session,
  snapshot,
  onMove,
  onError,
  highlightMove,
  perspective = "A",
  lastCapture,
  captureEffect,
  onBlocked,
}: BoardProps) {
  const { selection, canInteract, pieceByPosition, select } = useBoardSelection({ session, snapshot, onMove, onError, onBlocked });
  const gridRef = useRef<HTMLDivElement>(null);
  usePieceSlide(gridRef, snapshot.board, perspective);

  const cells = useMemo(() => {
    return Array.from({ length: 81 }, (_, index) => {
      const col = index % 9;
      const row = Math.floor(index / 9);
      if (perspective === "B") {
        return { x: 8 - col, y: 8 - row };
      }
      return { x: col, y: row };
    });
  }, [perspective]);

  const files = useMemo(() => {
    return Array.from({ length: 9 }, (_, x) => {
      const colIndex = perspective === "B" ? 8 - x : x;
      return String.fromCharCode(65 + colIndex);
    });
  }, [perspective]);

  const ranks = useMemo(() => {
    return Array.from({ length: 9 }, (_, y) => {
      return perspective === "B" ? 9 - y : y + 1;
    });
  }, [perspective]);

  const legal = (position: Position) => Boolean(selection?.legalMoves.some((move) => move.x === position.x && move.y === position.y));

  const isMoveFrom = (pos: Position) =>
    Boolean(highlightMove?.from && highlightMove.from.x === pos.x && highlightMove.from.y === pos.y);

  const isMoveTo = (pos: Position) =>
    Boolean(highlightMove?.to && highlightMove.to.x === pos.x && highlightMove.to.y === pos.y);

  const isCapture = (pos: Position) =>
    Boolean(lastCapture && lastCapture.x === pos.x && lastCapture.y === pos.y);

  const isHighlighted = (pos: Position) => isMoveFrom(pos) || isMoveTo(pos);

  const blockedHint = (pos: Position) =>
    selection?.blocked.find((target) => target.position.x === pos.x && target.position.y === pos.y)?.hint;

  const isEffectCell = (pos: Position) =>
    Boolean(captureEffect && captureEffect.at.x === pos.x && captureEffect.at.y === pos.y);

  const labelStyle = captureEffect
    ? {
        left: `${(((perspective === "B" ? 8 - captureEffect.at.x : captureEffect.at.x) + 0.5) / 9) * 100}%`,
        top: `${((perspective === "B" ? 8 - captureEffect.at.y : captureEffect.at.y) / 9) * 100}%`,
      }
    : undefined;

  return (
    <div className={styles.boardFrame} aria-label="Bàn cờ 9 x 9">
      <div className={styles.boardCoordinatesTop} aria-hidden="true">
        {files.map((file, idx) => (
          <span key={idx}>{file}</span>
        ))}
      </div>
      <div className={styles.boardWithRanks}>
        <div className={styles.boardRanks} aria-hidden="true">
          {ranks.map((rank, idx) => (
            <span key={idx}>{rank}</span>
          ))}
        </div>
        <div className={styles.boardSurface}>
        <div ref={gridRef} className={styles.board} role="grid" aria-label="Bàn cờ 9 x 9">
          {cells.map((position) => {
            const piece = pieceByPosition.get(`${position.x}:${position.y}`);
            const selected = Boolean(selection?.from.x === position.x && selection.from.y === position.y);
            return (
              <BoardCell
                key={`${position.x}:${position.y}`}
                position={position}
                piece={piece}
                selected={selected}
                legal={legal(position)}
                highlighted={isHighlighted(position)}
                isMoveFrom={isMoveFrom(position)}
                isMoveTo={isMoveTo(position)}
                isCapture={isCapture(position)}
                blockedHint={blockedHint(position)}
                captureGhost={isEffectCell(position) ? captureEffect!.captured : undefined}
                captureEffectId={isEffectCell(position) ? captureEffect!.id : undefined}
                goal={position.x === 0 && position.y === 0 ? "A" : position.x === 8 && position.y === 8 ? "B" : undefined}
                disabled={!canInteract}
                onClickPosition={select}
              />
            );
          })}
        </div>
        {captureEffect ? (
          <span key={captureEffect.id} className={styles.captureLabel} style={labelStyle} aria-hidden="true" data-testid="capture-label">
            {captureLabel(captureEffect)}
          </span>
        ) : null}
        </div>
      </div>
      <div className={styles.boardCoordinatesBottom} aria-hidden="true">
        {files.map((file, idx) => (
          <span key={idx}>{file}</span>
        ))}
      </div>
    </div>
  );
}
