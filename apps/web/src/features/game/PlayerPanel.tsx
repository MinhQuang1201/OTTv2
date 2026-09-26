import type { PlayerView, Seat } from "../../shared/model/game";
import { formatClock } from "../../shared/model/format";
import { Badge } from "../../shared/ui/Badge";
import styles from "./game.module.css";

export function PlayerPanel({ player, active, viewer }: { readonly player?: PlayerView; readonly active: boolean; readonly viewer: boolean }) {
  if (!player) return <section className={styles.playerPanel} aria-label="Người chơi đang chờ"><span className={styles.playerName}>Đang chờ người chơi…</span></section>;
  const seatClass = player.seat === "A" ? styles.seatA : styles.seatB;
  return <section className={[styles.playerPanel, seatClass, active ? styles.playerActive : ""].filter(Boolean).join(" ")} aria-label={`Người chơi ${player.name}`}>
    <div className={styles.playerIdentity}><span className={styles.seatMark} aria-hidden="true">{player.seat}</span><div><strong className={styles.playerName}>{player.name}</strong><span className={styles.playerMeta}>{viewer ? "Bạn" : "Đối thủ"} · {player.connected ? "Đã kết nối" : "Mất kết nối"}</span></div></div>
    <div className={[styles.clock, player.remainingMs <= 60_000 ? styles.clockWarning : ""].filter(Boolean).join(" ")} aria-label={`Thời gian còn lại ${formatClock(player.remainingMs)}`}>{formatClock(player.remainingMs)}</div>
    <div className={styles.counts} aria-label={`Số quân của ${player.name}`}>{(["dam", "la", "keo"] as const).map((type) => <span key={type} title={type}>{player.counts[type]}</span>)}</div>
    {active ? <Badge status="info">Đang đi</Badge> : null}
  </section>;
}

export function seatPlayer(players: Partial<Record<Seat, PlayerView>>, seat: Seat) { return players[seat]; }
