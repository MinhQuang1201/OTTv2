import type { GameEventView } from "../../shared/model/game";
import { formatSquare } from "../../shared/model/format";
import styles from "./game.module.css";

export function MoveHistory({ events }: { readonly events: readonly GameEventView[] }) {
  const moves = events.filter((event) => event.type !== "win");
  return <aside className={styles.sideRail} aria-label="Lịch sử nước đi"><h2>Lịch sử nước đi</h2>{moves.length === 0 ? <p className={styles.emptyRail}>Các nước đi sẽ xuất hiện ở đây.</p> : <ol className={styles.history}>{moves.map((event) => <li key={event.id}><span>#{event.id}</span>{event.type === "strike_loss" ? "Mất quân" : event.type === "capture" ? "Ăn quân" : "Di chuyển"} · {formatSquare(event.to)}</li>)}</ol>}</aside>;
}
