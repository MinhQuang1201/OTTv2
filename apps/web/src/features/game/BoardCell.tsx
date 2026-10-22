import type { ButtonHTMLAttributes, CSSProperties } from "react";
import type { PieceView, Position } from "../../shared/model/game";
import { formatSquare } from "../../shared/model/format";
import { PieceIcon } from "../../shared/icons/PieceIcon";
import { PixelSprite } from "../../shared/icons/PixelSprite";
import type { PieceIdentity } from "./captureFx";
import { Piece } from "./Piece";
import styles from "./game.module.css";

/** 3x3 shards of the captured piece, each flying away from the centre. */
const SHARDS = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3);
  const col = index % 3;
  const third = 100 / 3;
  return {
    clipPath: `inset(${row * third}% ${(2 - col) * third}% ${(2 - row) * third}% ${col * third}%)`,
    dx: `${(col - 1) * 14 + (row === 1 && col === 1 ? 2 : 0)}px`,
    dy: `${(row - 1) * 14 + 6}px`,
    spin: `${(col - 1) * 25 + (row - 1) * 10}deg`,
  };
});

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
  /** Short reason the selected piece cannot enter this square, for example "Lá thua Kéo". */
  readonly blockedHint?: string;
  /** Captured piece shattering on this square while its capture effect plays. */
  readonly captureGhost?: PieceIdentity;
  readonly captureEffectId?: number;
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
  blockedHint,
  captureGhost,
  captureEffectId,
  onClickPosition,
  className,
  disabled,
  ...props
}: BoardCellProps) {
  const square = formatSquare(position);
  const typeLabel = piece ? ({ dam: "Đấm", la: "Lá", keo: "Kéo" } as const)[piece.type] : "trống";
  const label = `Ô ${square} · ${typeLabel}${piece ? ` · Người ${piece.seat}` : ""}${selected ? " · đã chọn" : ""}${legal ? " · nước hợp lệ" : ""}${blockedHint ? ` · bị chặn: ${blockedHint}` : ""}${isCapture ? " · vừa ăn quân" : highlighted ? " · nước vừa đi" : ""}`;

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
        blockedHint ? styles.cellBlocked : "",
        captureGhost ? styles.cellImpact : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={label}
      title={blockedHint}
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
      {captureGhost ? (
        <span key={captureEffectId} className={styles.shatter} aria-hidden="true" data-testid="capture-shatter">
          {SHARDS.map((shard, index) => (
            <span
              key={index}
              className={[styles.piece, styles.shard, captureGhost.seat === "A" ? styles.pieceA : styles.pieceB].join(" ")}
              style={{ clipPath: shard.clipPath, "--shard-dx": shard.dx, "--shard-dy": shard.dy, "--shard-spin": shard.spin } as CSSProperties}
            >
              <PieceIcon type={captureGhost.type} seat={captureGhost.seat} decorative width={30} height={30} />
            </span>
          ))}
        </span>
      ) : null}
      {blockedHint ? <span aria-hidden="true" className={styles.blockedLock} data-testid="blocked-lock" /> : null}
    </button>
  );
}
