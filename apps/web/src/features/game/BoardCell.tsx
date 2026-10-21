import type { ButtonHTMLAttributes } from "react";
import type { PieceView, Position } from "../../shared/model/game";
import { formatSquare } from "../../shared/model/format";
import { PixelSprite } from "../../shared/icons/PixelSprite";
import { Piece } from "./Piece";
import styles from "./game.module.css";

export interface BoardCellProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  readonly position: Position;
  readonly piece?: PieceView;
  readonly selected?: boolean;
  readonly legal?: boolean;
  readonly goal?: "A" | "B";
  readonly highlighted?: boolean;
  readonly isMoveFrom?: boolean;
  readonly isMoveTo?: boolean;
  readonly isCapture?: boolean;
  readonly onClickPosition?: (position: Position) => void;
}

export function BoardCell({
  position,
  piece,
  selected = false,
  legal = false,
  goal,
  highlighted = false,
  isMoveFrom = false,
  isMoveTo = false,
  isCapture = false,
  onClickPosition,
  className,
  disabled,
  ...props
}: BoardCellProps) {
  const square = formatSquare(position);
  const typeLabel = piece ? ({ dam: "Đấm", la: "Lá", keo: "Kéo" } as const)[piece.type] : "trống";
  const label = `Ô ${square} · ${typeLabel}${piece ? ` · Người ${piece.seat}` : ""}${selected ? " · đã chọn" : ""}${legal ? " · nước hợp lệ" : ""}${isCapture ? " · vừa ăn quân" : highlighted ? " · nước vừa đi" : ""}`;

  return (
    <button
      {...props}
      type="button"
      className={[
        styles.boardCell,
        (position.x + position.y) % 2 === 0 ? styles.boardLight : styles.boardDark,
        goal === "A" ? styles.goalA : goal === "B" ? styles.goalB : "",
        selected ? (piece?.seat === "B" ? styles.cellSelectedSeatB : styles.cellSelectedSeatA) : "",
        legal ? styles.cellLegal : "",
        highlighted ? styles.cellHighlighted : "",
        isMoveFrom ? styles.cellMoveFrom : "",
        isMoveTo ? styles.cellMoveTo : "",
        isCapture ? styles.cellCapture : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={label}
      aria-pressed={selected}
      data-x={position.x}
      data-y={position.y}
      data-selected-seat={selected ? (piece?.seat ?? "A") : undefined}
      data-last-move-from={isMoveFrom ? "true" : undefined}
      data-last-move-to={isMoveTo ? "true" : undefined}
      data-last-capture={isCapture ? "true" : undefined}
      data-testid={`board-cell-${square}`}
      disabled={disabled}
      onClick={() => onClickPosition?.(position)}
    >
      {goal && !piece ? (
        <PixelSprite kind="flag" seat={goal} size={20} decorative className={styles.cellGoalFlag} />
      ) : null}
      {legal && !piece ? <span aria-hidden="true" className={styles.legalDot} /> : null}
      {piece ? <Piece piece={piece} /> : null}
    </button>
  );
}
