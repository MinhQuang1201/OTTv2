import { Button } from "../../shared/ui/Button";
import { Badge } from "../../shared/ui/Badge";
import type { ConnectionState, SessionMode } from "../../shared/model/game";
import styles from "./game.module.css";

// "offline" is a game played entirely on this device (two players or AI), not a lost network.
const connectionLabel: Record<ConnectionState, string> = { offline: "Chơi trên thiết bị", connecting: "Đang kết nối", online: "Đã kết nối", reconnecting: "Đang kết nối lại", unavailable: "Không khả dụng" };

function tableLabel(roomId: string | null, mode: SessionMode | undefined): string {
  if (roomId) return `Phòng ${roomId}`;
  if (mode === "local") return "Hai người cùng máy";
  if (mode === "ai") return "Đấu với AI";
  return "Chơi trên thiết bị";
}

export interface GameTopBarProps {
  readonly roomId: string | null;
  /** Short code players share; preferred over the internal room id when known. */
  readonly roomAlias?: string | null;
  readonly mode?: SessionMode;
  readonly connection: ConnectionState;
  readonly spectatorCount?: number;
  readonly spectator?: boolean;
  readonly onLeave: () => void;
  readonly perspective?: "A" | "B";
  readonly onFlipPerspective?: () => void;
  readonly soundEnabled?: boolean;
  readonly onToggleSound?: () => void;
}

export function GameTopBar({
  roomId,
  roomAlias,
  mode,
  connection,
  spectatorCount = 0,
  spectator = false,
  onLeave,
  perspective = "A",
  onFlipPerspective,
  soundEnabled = false,
  onToggleSound,
}: GameTopBarProps) {
  const status =
    connection === "online"
      ? "success"
      : connection === "reconnecting" || connection === "connecting"
      ? "warning"
      : connection === "unavailable"
      ? "danger"
      : "neutral";

  return (
    <div className={styles.topBar}>
      <div>
        <span className={styles.kicker}>
          {spectator ? "Đang xem trực tiếp" : "OTTv2 · Bàn đấu"}
        </span>
        <strong data-testid="room-label" data-room-id={roomId ?? undefined}>
          {tableLabel(roomAlias || roomId, mode)}
        </strong>
      </div>
      <div className={styles.topBarActions}>
        <Badge status={status} className={connection === "offline" ? styles.badgeOnDevice : undefined}>{connectionLabel[connection]}</Badge>
        {spectator ? <span className={styles.spectatorCount}>{spectatorCount} đang xem</span> : null}
        {onFlipPerspective && (
          <Button
            variant={perspective === "B" ? "primary" : "secondary"}
            onClick={onFlipPerspective}
            aria-label={`Đổi góc nhìn bàn cờ (hiện tại bên ${perspective}) (phím F)`}
            aria-pressed={perspective === "B"}
            data-testid="game-flip-btn"
          >
            <span aria-hidden="true" className={styles.actionIcon}>↻</span>
            <span className={styles.actionText}>Xoay bàn cờ</span>
          </Button>
        )}
        {onToggleSound && (
          <Button
            variant={soundEnabled ? "primary" : "quiet"}
            onClick={onToggleSound}
            aria-label={soundEnabled ? "Tắt âm thanh (phím M)" : "Bật âm thanh (phím M)"}
            aria-pressed={soundEnabled}
            data-testid="game-sound-toggle-btn"
          >
            <span aria-hidden="true" className={styles.actionIcon}>{soundEnabled ? "🔊" : "🔇"}</span>
            <span className={styles.actionText}>Âm thanh</span>
          </Button>
        )}
        <Button
          variant="quiet"
          onClick={onLeave}
          aria-label={spectator ? "Rời chế độ xem" : "Rời bàn"}
        >
          <span aria-hidden="true" className={styles.actionIcon}>✕</span>
          <span className={styles.actionText}>{spectator ? "Rời chế độ xem" : "Rời bàn"}</span>
        </Button>
      </div>
    </div>
  );
}
