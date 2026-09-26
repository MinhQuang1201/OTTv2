import type { PieceView } from "../../shared/model/game";
import { PieceIcon } from "../../shared/icons/PieceIcon";
import styles from "./game.module.css";

const labels = { dam: "Đấm", la: "Lá", keo: "Kéo" } as const;

export function Piece({ piece, compact = false }: { readonly piece: PieceView; readonly compact?: boolean }) {
  return (
    <span className={[styles.piece, piece.seat === "A" ? styles.pieceA : styles.pieceB, compact ? styles.pieceCompact : ""].filter(Boolean).join(" ")} data-piece-id={piece.id}>
      <PieceIcon type={piece.type} decorative width={compact ? 22 : 30} height={compact ? 22 : 30} />
      <span className={styles.pieceLabel}>{labels[piece.type]}</span>
    </span>
  );
}
