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
  return <Dialog open={open} title="Kết quả" closeLabel="Đóng kết quả" onClose={onClose} className={styles.resultDialog}>
    <p className={styles.resultTitle}>{title}</p>
    <p className={styles.reason}>{resultReason(result)}</p>
    <div className={styles.resultActions}><Button variant="quiet" onClick={onClose}>Xem bàn</Button><Button variant="primary" onClick={onLobby}>Về sảnh</Button></div>
  </Dialog>;
}
