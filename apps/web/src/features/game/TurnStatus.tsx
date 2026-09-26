import type { GameSnapshot } from "../../shared/model/game";
import styles from "./game.module.css";

export function TurnStatus({ snapshot }: { readonly snapshot: GameSnapshot }) {
  let message = "Sẵn sàng";
  if (snapshot.phase === "waiting") message = "Đang chờ người chơi thứ hai";
  else if (snapshot.connection === "reconnecting") message = "Đang kết nối lại…";
  else if (snapshot.aiThinking) message = "AI đang suy nghĩ…";
  else if (snapshot.pendingMove) message = "Đang xử lý nước đi…";
  else if (snapshot.turn) message = snapshot.turn === snapshot.viewerSeat ? "Đến lượt bạn" : "Đối thủ đang đi";
  return <p className={styles.turnStatus} aria-live="polite" data-status={snapshot.connection}>{message}</p>;
}
