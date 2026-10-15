import { Button } from "../../shared/ui/Button";
import type { TournamentMatchView } from "./types";
import styles from "./tournaments.module.css";

export interface TournamentMatchCardProps {
  readonly match: TournamentMatchView;
  readonly onJoin?: (aliasOrToken: string) => void;
  readonly onSyncMatch?: (matchId: string) => void;
  readonly onAccessMatch?: (matchId: string) => void;
  readonly canJoin?: boolean;
}

export function TournamentMatchCard({ match, onJoin, onSyncMatch, onAccessMatch, canJoin = false }: TournamentMatchCardProps) {
  const isBye = match.status === "bye" || !match.participantB;
  const isCompleted = match.status === "completed" || match.status === "bye";

  const resultLabel = match.result === "win_a"
    ? `${match.participantA.name} thắng`
    : match.result === "win_b"
      ? `${match.participantB?.name} thắng`
      : match.result === "draw"
        ? "Hòa"
        : match.result === "bye"
          ? "Thắng do miễn đấu (Bye)"
          : match.status === "in_progress"
            ? "Đang thi đấu"
            : "Chờ thi đấu";

  return (
    <div className={styles.matchCard} data-testid={`match-card-${match.matchId}`}>
      <div>
        <div className={styles.matchVersus}>
          <span>{match.participantA.name}</span>
          <span>{isBye ? "—" : "vs"}</span>
          <span>{isBye ? "(Miễn đấu)" : match.participantB?.name}</span>
          {match.alias ? <span className={styles.tagAlias}>Phòng: {match.alias}</span> : null}
        </div>
        <p className={styles.helperText}>
          {isCompleted ? `Kết quả: ${resultLabel}` : `Trạng thái: ${resultLabel}`}
        </p>
      </div>

      <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
        {!isCompleted && match.allocationId && onSyncMatch && (
          <Button
            variant="quiet"
            onClick={() => onSyncMatch(match.matchId)}
            title="Đồng bộ kết quả từ máy chủ Worker"
          >
            Đồng bộ
          </Button>
        )}
        {!isCompleted && onAccessMatch && (
          <Button
            variant="secondary"
            onClick={() => onAccessMatch(match.matchId)}
            disabled={!canJoin}
          >
            Vào trận
          </Button>
        )}
        {!isCompleted && !onAccessMatch && match.alias && onJoin && (
          <Button
            variant="secondary"
            onClick={() => onJoin(match.alias!)}
            disabled={!canJoin}
          >
            Vào phòng ({match.alias})
          </Button>
        )}
      </div>
    </div>
  );
}
