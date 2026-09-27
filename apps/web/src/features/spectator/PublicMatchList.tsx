import type { PublicMatchView } from "../../shared/model/game";
import { Badge } from "../../shared/ui/Badge";
import { Button } from "../../shared/ui/Button";
import { Spinner } from "../../shared/ui/Spinner";
import styles from "../lobby/lobby.module.css";

export type PublicMatchListState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable"; readonly message?: string }
  | { readonly status: "error"; readonly message: string; readonly onRetry?: () => void }
  | { readonly status: "ready"; readonly matches: readonly PublicMatchView[] };

export type PublicMatchIdentity = Pick<PublicMatchView, "allocationId" | "roomId">;

export interface PublicMatchListProps {
  readonly state: PublicMatchListState;
  readonly onWatch: (identity: PublicMatchIdentity) => void;
  readonly disabled?: boolean;
}

function formatClock(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function connectionLabel(connected: boolean): string {
  return connected ? "Đã kết nối" : "Mất kết nối";
}

export function PublicMatchList({ state, onWatch, disabled = false }: PublicMatchListProps) {
  return (
    <section className={[styles.roomList, styles.matchList].filter(Boolean).join(" ")} aria-labelledby="public-matches-title" data-testid="public-match-list">
      <div className={styles.sectionHeading}>
        <h3 id="public-matches-title">Trận đang diễn ra</h3>
        {state.status === "ready" && state.matches.length > 0 ? <Badge status="info">{state.matches.length} trận</Badge> : null}
      </div>
      {state.status === "loading" ? (
        <div className={styles.roomState} role="status"><Spinner label="Đang tải trận đang diễn ra" /><span>Đang tải trận đang diễn ra…</span></div>
      ) : null}
      {state.status === "unavailable" ? <p className={styles.roomState}>{state.message ?? "Danh sách trận đang diễn ra hiện không khả dụng."}</p> : null}
      {state.status === "error" ? (
        <div className={styles.roomState} role="alert">
          <p>{state.message}</p>
          {state.onRetry ? <button className={styles.inlineButton} type="button" onClick={state.onRetry}>Thử lại</button> : null}
        </div>
      ) : null}
      {state.status === "ready" && state.matches.length === 0 ? <p className={styles.roomState}>Chưa có trận đang diễn ra.</p> : null}
      {state.status === "ready" && state.matches.length > 0 ? (
        <ul className={styles.matchItems}>
          {state.matches.filter((match) => match.status === "playing").map((match) => {
            const playerA = match.players.A;
            const playerB = match.players.B;
            return (
              <li key={match.allocationId} className={styles.matchItem}>
                <div className={styles.matchPlayers}>
                  <div className={styles.matchPlayer}>
                    <span className={styles.matchSeat} aria-label="Ghế A">A</span>
                    <div className={styles.matchPlayerIdentity}>
                      <strong>{playerA.name}</strong>
                      <span>{connectionLabel(playerA.connected)}</span>
                    </div>
                    <time className={styles.matchClock} dateTime={`PT${Math.max(0, Math.floor(playerA.remainingMs / 1000))}S`} aria-label={`Thời gian còn lại của ${playerA.name}: ${formatClock(playerA.remainingMs)}`}>
                      {formatClock(playerA.remainingMs)}
                    </time>
                  </div>
                  <span className={styles.matchVersus} aria-hidden="true">vs</span>
                  <div className={styles.matchPlayer}>
                    <span className={styles.matchSeat} aria-label="Ghế B">B</span>
                    <div className={styles.matchPlayerIdentity}>
                      <strong>{playerB.name}</strong>
                      <span>{connectionLabel(playerB.connected)}</span>
                    </div>
                    <time className={styles.matchClock} dateTime={`PT${Math.max(0, Math.floor(playerB.remainingMs / 1000))}S`} aria-label={`Thời gian còn lại của ${playerB.name}: ${formatClock(playerB.remainingMs)}`}>
                      {formatClock(playerB.remainingMs)}
                    </time>
                  </div>
                </div>
                <div className={styles.matchFooter}>
                  <span className={styles.roomItemMeta}>{match.spectatorCount} người xem</span>
                  <Button variant="secondary" disabled={disabled} onClick={() => onWatch({ allocationId: match.allocationId, roomId: match.roomId })} aria-label={`Xem trận ${playerA.name} và ${playerB.name}`}>
                    Xem trận
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
