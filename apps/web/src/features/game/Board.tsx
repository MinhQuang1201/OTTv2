import { useMemo } from "react";
import type { GameSession } from "../../sessions/contract";
import type { GameSnapshot, Position, SessionErrorView } from "../../shared/model/game";
import { BoardCell } from "./BoardCell";
import { useBoardSelection } from "./useBoardSelection";
import styles from "./game.module.css";

export interface BoardProps {
  readonly session: GameSession;
  readonly snapshot: GameSnapshot;
  readonly onMove?: (from: Position, to: Position) => void;
  readonly onError?: (error: SessionErrorView) => void;
}

export function Board({ session, snapshot, onMove, onError }: BoardProps) {
  const { selection, canInteract, pieceByPosition, select } = useBoardSelection({ session, snapshot, onMove, onError });
  const cells = useMemo(() => Array.from({ length: 81 }, (_, index) => ({ x: index % 9, y: Math.floor(index / 9) })), []);
  const legal = (position: Position) => Boolean(selection?.legalMoves.some((move) => move.x === position.x && move.y === position.y));
  return (
    <div className={styles.boardFrame} aria-label="Bàn cờ 9 x 9">
      <div className={styles.boardCoordinatesTop} aria-hidden="true">{Array.from({ length: 9 }, (_, x) => <span key={x}>{String.fromCharCode(65 + x)}</span>)}</div>
      <div className={styles.boardWithRanks}>
        <div className={styles.boardRanks} aria-hidden="true">{Array.from({ length: 9 }, (_, y) => <span key={y}>{y + 1}</span>)}</div>
        <div className={styles.board} role="grid" aria-label="Bàn cờ 9 x 9">
          {cells.map((position) => {
            const piece = pieceByPosition.get(`${position.x}:${position.y}`);
            const selected = Boolean(selection?.from.x === position.x && selection.from.y === position.y);
            return <BoardCell key={`${position.x}:${position.y}`} position={position} piece={piece} selected={selected} legal={legal(position)} goal={position.x === 0 && position.y === 8 ? "A" : position.x === 8 && position.y === 0 ? "B" : undefined} disabled={!canInteract} onClickPosition={select} />;
          })}
        </div>
      </div>
      <div className={styles.boardCoordinatesBottom} aria-hidden="true">{Array.from({ length: 9 }, (_, x) => <span key={x}>{String.fromCharCode(65 + x)}</span>)}</div>
    </div>
  );
}
