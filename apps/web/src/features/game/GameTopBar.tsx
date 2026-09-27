import { Button } from "../../shared/ui/Button";
import { Badge } from "../../shared/ui/Badge";
import type { ConnectionState } from "../../shared/model/game";
import styles from "./game.module.css";

const connectionLabel: Record<ConnectionState, string> = { offline: "Ngoại tuyến", connecting: "Đang kết nối", online: "Đã kết nối", reconnecting: "Đang kết nối lại", unavailable: "Không khả dụng" };

export function GameTopBar({ roomId, connection, spectatorCount = 0, spectator = false, onLeave }: { readonly roomId: string | null; readonly connection: ConnectionState; readonly spectatorCount?: number; readonly spectator?: boolean; readonly onLeave: () => void }) {
  const status = connection === "online" ? "success" : connection === "reconnecting" || connection === "connecting" ? "warning" : connection === "unavailable" ? "danger" : "neutral";
  return <div className={styles.topBar}><div><span className={styles.kicker}>{spectator ? "Đang xem trực tiếp" : "OTTv2 · Bàn đấu"}</span><strong data-testid="room-label">{roomId ? `Phòng ${roomId}` : "Chơi trên thiết bị"}</strong></div><div className={styles.topBarActions}><Badge status={status}>{connectionLabel[connection]}</Badge>{spectator ? <span className={styles.spectatorCount}>{spectatorCount} đang xem</span> : null}<Button variant="quiet" onClick={onLeave} aria-label={spectator ? "Rời chế độ xem" : "Rời bàn"}>{spectator ? "Rời chế độ xem" : "Rời bàn"}</Button></div></div>;
}
