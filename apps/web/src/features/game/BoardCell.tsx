import type { ButtonHTMLAttributes } from "react";
import type { PieceView, Position } from "../../shared/model/game";
import { formatSquare } from "../../shared/model/format";
import { Piece } from "./Piece";
import styles from "./game.module.css";

export interface BoardCellProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  readonly position: Position;
  readonly piece?: PieceView;
  readonly selected?: boolean;
  readonly legal?: boolean;
  readonly goal?: "A" | "B";
  readonly onClickPosition?: (position: Position) => void;
}

export function BoardCell({ position, piece, selected = false, legal = false, goal, onClickPosition, className, disabled, ...props }: BoardCellProps) {
  const square = formatSquare(position);
  const typeLabel = piece ? ({ dam: "Đấm", la: "Lá", keo: "Kéo" } as const)[piece.type] : "trống";
  const label = `Ô ${square} · ${typeLabel}${piece ? ` · Người ${piece.seat}` : ""}${selected ? " · đã chọn" : ""}${legal ? " · nước hợp lệ" : ""}`;
  return (
    <button
      {...props}
      type="button"
      className={[styles.boardCell, (position.x + position.y) % 2 === 0 ? styles.boardLight : styles.boardDark, goal === "A" ? styles.goalA : goal === "B" ? styles.goalB : "", selected ? styles.cellSelected : "", legal ? styles.cellLegal : "", className].filter(Boolean).join(" ")}
      aria-label={label}
      aria-pressed={selected}
      data-x={position.x}
      data-y={position.y}
      data-testid={`board-cell-${square}`}
      disabled={disabled}
      onClick={() => onClickPosition?.(position)}
    >
      {legal && !piece ? <span aria-hidden="true" className={styles.legalDot} /> : null}
      {piece ? <Piece piece={piece} /> : null}
    </button>
  );
}
