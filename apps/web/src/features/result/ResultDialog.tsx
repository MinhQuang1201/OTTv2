import type { GameResultView, Seat } from "../../shared/model/game";
import { resultReason } from "../../shared/model/format";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import styles from "./result.module.css";

export interface ResultDialogProps {
  readonly open: boolean;
  readonly result: GameResultView | null;
  readonly viewerSeat: Seat | null;
  readonly playerNames: Partial<Record<Seat, string>>;
  readonly onClose: () => void;
  readonly onLobby: () => void;
}

export function ResultDialog({ open, result, viewerSeat, playerNames, onClose, onLobby }: ResultDialogProps) {
  if (!result) return null;
  const winnerName = result.winner ? playerNames[result.winner] ?? `Người ${result.winner}` : "Không ai";
  const title = result.winner && viewerSeat === result.winner ? "Bạn thắng" : result.winner && viewerSeat ? "Bạn thua" : `${winnerName} thắng`;
  const outcome = result.winner && viewerSeat
    ? result.winner === viewerSeat ? "win" : "loss"
    : "neutral";

  return (
    <Dialog open={open} title="Kết quả" closeLabel="Đóng kết quả" onClose={onClose} className={[styles.resultDialog, styles[`outcome_${outcome}`]].join(" ")}>
      <div className={styles.outcomeContainer} data-testid="result-dialog-outcome" data-outcome={outcome}>
        <div className={styles.emblem} aria-hidden="true">
          {outcome === "win" ? "🏆" : outcome === "loss" ? "💀" : "⚔️"}
        </div>
        <p className={styles.resultTitle}>{title}</p>
        <p className={styles.reason}>{resultReason(result)}</p>
        <div className={styles.participantSummary}>
          <span className={styles.seatTagA}>A: {playerNames.A ?? "Người A"}</span>
          <span className={styles.vsSeparator}>vs</span>
          <span className={styles.seatTagB}>B: {playerNames.B ?? "Người B"}</span>
        </div>
        <div className={styles.resultActions}>
          <Button variant="quiet" onClick={onClose}>Xem bàn</Button>
          <Button variant="primary" onClick={onLobby}>Về sảnh</Button>
        </div>
      </div>
    </Dialog>
  );
}
