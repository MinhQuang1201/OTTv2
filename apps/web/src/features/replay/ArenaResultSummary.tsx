import type { ArenaMatchResult, ReplayParticipant } from "../../../../../packages/arena/src/contracts/index.d.mts";
import type { Seat } from "../../shared/model/game";
import { Button } from "../../shared/ui/Button";
import { Panel } from "../../shared/ui/Panel";
import styles from "./replay.module.css";

export interface ArenaResultSummaryProps {
  readonly result: ArenaMatchResult;
  readonly participants?: Record<Seat, ReplayParticipant>;
  readonly onLobby?: () => void;
  readonly onClose?: () => void;
}

const WIN_REASON_LABELS: Record<string, string> = {
  goal: "Đưa quân vào ô đích đối phương",
  elimination: "Ăn hết toàn bộ quân đối phương",
  no_moves: "Đối thủ không còn nước đi hợp lệ",
};

const FORFEIT_REASON_LABELS: Record<string, string> = {
  turn_timeout: "Xử thua do quá giới hạn thời gian nước đi",
  total_timeout: "Xử thua do hết tổng thời gian trận đấu",
  crash: "Xử thua do bot bị sự cố (crash)",
  protocol_error: "Xử thua do bot vi phạm giao thức liên lạc",
  illegal_move: "Xử thua do thực hiện nước đi phạm quy",
  output_limit: "Xử thua do vượt giới hạn dung lượng phản hồi",
};

export function ArenaResultSummary({
  result,
  participants,
  onLobby,
  onClose,
}: ArenaResultSummaryProps) {
  const getParticipantName = (seat: Seat) => {
    return participants?.[seat]?.name || participants?.[seat]?.botId || `Người chơi ${seat}`;
  };

  let title = "Kết quả trận đấu";
  let statusBadge = "";
  let reasonText = "";
  let winnerText = "";

  if (result.outcome === "win") {
    title = "Chiến thắng chung cuộc";
    statusBadge = `Thắng: ${getParticipantName(result.winner)}`;
    winnerText = getParticipantName(result.winner);
    reasonText = WIN_REASON_LABELS[result.reason] || `Lý do: ${result.reason}`;
  } else if (result.outcome === "draw") {
    title = "Hòa cờ";
    statusBadge = "Kết quả: Hòa";
    reasonText = "Trận đấu đạt giới hạn tối đa 400 nước đi (max_plies)";
  } else if (result.outcome === "forfeit") {
    title = "Xử thua / Bỏ cuộc";
    statusBadge = `Xử thua: ${getParticipantName(result.loser)}`;
    winnerText = `Thắng: ${getParticipantName(result.winner)}`;
    reasonText = FORFEIT_REASON_LABELS[result.reason] || `Lý do xử thua: ${result.reason}`;
  }

  return (
    <div className={styles.resultSummaryOverlay} role="dialog" aria-modal="true" aria-labelledby="arena-result-title">
      <Panel className={styles.resultSummaryPanel} role="region" aria-label="Kết quả trận đấu Arena">
        <header className={styles.resultSummaryHeader}>
          <div className={styles.kicker}>Arena Settlement</div>
          <h2 id="arena-result-title" className={styles.resultTitle}>{title}</h2>
        </header>

        <div className={styles.resultDetails}>
          <div className={styles.resultBadge} data-outcome={result.outcome}>
            {statusBadge}
          </div>

          {winnerText && result.outcome === "forfeit" && (
            <p className={styles.winnerText}>
              Bên thắng: <strong>{winnerText}</strong>
            </p>
          )}

          <p className={styles.resultReason}>{reasonText}</p>

          <dl className={styles.resultMeta}>
            <dt>Số nước hợp lệ</dt>
            <dd>{result.acceptedPlies} nước</dd>
            {participants && (
              <>
                <dt>Đấu thủ A</dt>
                <dd>{getParticipantName("A")}</dd>
                <dt>Đấu thủ B</dt>
                <dd>{getParticipantName("B")}</dd>
              </>
            )}
          </dl>
        </div>

        <footer className={styles.resultSummaryFooter}>
          {onClose && (
            <Button variant="secondary" onClick={onClose} aria-label="Đóng kết quả để xem lại bàn cờ">
              Xem bàn cờ
            </Button>
          )}
          {onLobby && (
            <Button variant="primary" onClick={onLobby} aria-label="Trở về sảnh">
              Về sảnh
            </Button>
          )}
        </footer>
      </Panel>
    </div>
  );
}
