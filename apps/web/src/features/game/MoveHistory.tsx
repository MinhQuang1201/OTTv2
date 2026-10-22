import type { GameEventView, PieceView } from "../../shared/model/game";
import { formatSquare } from "../../shared/model/format";
import { PixelSprite } from "../../shared/icons/PixelSprite";
import { PIECE_NAME, SEAT_NAME, historyEntries, type HistoryEntry } from "./captureFx";
import styles from "./game.module.css";

/** Plain-text form, for example "#6 Xanh · Kéo F4→F3 ăn Lá (Đỏ)". */
export function historyText(entry: HistoryEntry): string {
  const path = `${formatSquare(entry.from)}→${formatSquare(entry.to)}`;
  const head = entry.mover ? `${SEAT_NAME[entry.mover.seat]} · ${PIECE_NAME[entry.mover.type]} ${path}` : `${entry.captured ? "Ăn quân" : "Di chuyển"} ${path}`;
  const tail = entry.captured ? ` ăn ${PIECE_NAME[entry.captured.type]} (${SEAT_NAME[entry.captured.seat]})` : "";
  return `#${entry.id} ${head}${tail}`;
}

function Icon({ seat, type }: NonNullable<HistoryEntry["mover"]>) {
  return <span className={styles.historyIcon}><PixelSprite kind={type} seat={seat} size={12} decorative /></span>;
}

export function MoveHistory({ events, board = [] }: { readonly events: readonly GameEventView[]; readonly board?: readonly PieceView[] }) {
  const entries = historyEntries(events, board);
  return <aside className={styles.sideRail} aria-label="Lịch sử nước đi"><h2>Lịch sử nước đi</h2>{entries.length === 0 ? <p className={styles.emptyRail}>Các nước đi sẽ xuất hiện ở đây.</p> : <ol className={styles.history}>{entries.map((entry) => {
    const path = `${formatSquare(entry.from)}→${formatSquare(entry.to)}`;
    return <li key={entry.id} aria-label={historyText(entry)}>
      <span>#{entry.id}</span>
      <span className={styles.historyText}>
        {entry.mover
          ? <>{SEAT_NAME[entry.mover.seat]} · <Icon {...entry.mover} />{PIECE_NAME[entry.mover.type]} {path}</>
          : <>{entry.captured ? "Ăn quân" : "Di chuyển"} {path}</>}
        {entry.captured ? <> ăn <Icon {...entry.captured} />{PIECE_NAME[entry.captured.type]} ({SEAT_NAME[entry.captured.seat]})</> : null}
      </span>
    </li>;
  })}</ol>}</aside>;
}
