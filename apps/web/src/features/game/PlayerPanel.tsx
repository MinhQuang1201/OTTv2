import type { PieceType, PlayerView, Seat, SessionMode } from "../../shared/model/game";
import { formatClock } from "../../shared/model/format";
import { Badge } from "../../shared/ui/Badge";
import { PixelSprite } from "../../shared/icons/PixelSprite";
import { PIECE_NAME, PIECE_TYPES, SEAT_NAME, capturedCounts } from "./captureFx";
import styles from "./game.module.css";

export interface RecentCapture {
  readonly id: number;
  readonly type: PieceType;
}

export interface PlayerPanelProps {
  readonly player?: PlayerView;
  readonly active: boolean;
  readonly viewer: boolean;
  readonly spectator?: boolean;
  /** The other seat; its remaining counts give this player's captured pieces. */
  readonly opponent?: PlayerView;
  /** Latest piece this player took, so the tray can make it blink. */
  readonly recentCapture?: RecentCapture | null;
  /** Local, AI and replay tables have no network, so connection state is not shown. */
  readonly mode?: SessionMode;
}

function CapturedTray({ opponent, recentCapture }: { readonly opponent: PlayerView; readonly recentCapture?: RecentCapture | null }) {
  const counts = capturedCounts(opponent.counts);
  const items = PIECE_TYPES.flatMap((type) => Array.from({ length: counts[type] }, () => type));
  const summary = PIECE_TYPES.filter((type) => counts[type] > 0).map((type) => `${counts[type]} ${PIECE_NAME[type]}`).join(", ");
  const newestIndex = recentCapture ? items.lastIndexOf(recentCapture.type) : -1;
  return <div className={styles.capturedTrayRow} data-testid={`captured-tray-${opponent.seat === "A" ? "B" : "A"}`}>
    <span className={styles.capturedTrayLabel}>Đã ăn</span>
    <ul className={styles.capturedTray} aria-label={summary ? `Quân đã ăn: ${summary}` : "Chưa ăn quân nào"}>
      {items.map((type, index) => <li key={index === newestIndex ? `new-${recentCapture!.id}` : `${type}-${index}`} className={index === newestIndex ? styles.trayNew : undefined} data-newest={index === newestIndex ? "true" : undefined}>
        <PixelSprite kind={type} seat={opponent.seat} size={14} decorative />
      </li>)}
    </ul>
  </div>;
}

function roleLabel(seat: Seat, mode: SessionMode | undefined, viewer: boolean, spectator: boolean): string {
  if (mode === "local") return `Quân ${SEAT_NAME[seat]}`;
  if (spectator) return "Người chơi";
  return viewer ? "Bạn" : "Đối thủ";
}

export function PlayerPanel({ player, active, viewer, spectator = false, opponent, recentCapture, mode }: PlayerPanelProps) {
  if (!player) return <section className={styles.playerPanel} aria-label="Người chơi đang chờ"><span className={styles.playerName}>Đang chờ người chơi…</span></section>;
  const seatClass = player.seat === "A" ? styles.seatA : styles.seatB;
  const onDevice = mode === "local" || mode === "ai" || mode === "replay";
  const meta = onDevice
    ? roleLabel(player.seat, mode, viewer, spectator)
    : `${roleLabel(player.seat, mode, viewer, spectator)} · ${player.connected ? "Đã kết nối" : "Mất kết nối"}`;
  return <section className={[styles.playerPanel, seatClass, active ? styles.playerActive : ""].filter(Boolean).join(" ")} aria-label={`Người chơi ${player.name}`} data-seat={player.seat} data-connected={onDevice || player.connected ? "true" : "false"}>
     <div className={styles.playerIdentity}><span className={styles.seatMark} aria-hidden="true">{player.seat}</span><div><strong className={styles.playerName}>{player.name}</strong><span className={styles.playerMeta}>{meta}</span></div></div>
    <div className={[styles.clock, player.remainingMs <= 60_000 ? styles.clockWarning : ""].filter(Boolean).join(" ")} aria-label={`Thời gian còn lại ${formatClock(player.remainingMs)}`}>{formatClock(player.remainingMs)}</div>
    <div className={styles.counts} aria-label={`Số quân của ${player.name}`}>{(["dam", "la", "keo"] as const).map((type) => <span key={type} title={type} className={styles.countBadge}><PixelSprite kind={type} seat={player.seat} size={14} decorative /> {player.counts[type]}</span>)}</div>
    {opponent ? <CapturedTray opponent={opponent} recentCapture={recentCapture} /> : null}
    {active ? <Badge status="info" className={styles.activeBadge}>Đang đi</Badge> : null}
  </section>;
}

export function seatPlayer(players: Partial<Record<Seat, PlayerView>>, seat: Seat) { return players[seat]; }
