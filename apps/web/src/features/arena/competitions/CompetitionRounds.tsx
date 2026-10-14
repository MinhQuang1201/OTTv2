import { useEffect, useState } from "react";
import { Badge, type BadgeStatus } from "../../../shared/ui/Badge";
import { Button } from "../../../shared/ui/Button";
import { PixelSprite } from "../../../shared/icons/PixelSprite";
import type { ReplayDocument } from "../../../../../../packages/arena/src/contracts/index.d.mts";
import type {
  CompetitionAggregateStanding,
  CompetitionConfig,
  CompetitionPhase,
  CompetitionRoundItem,
} from "./types";
import styles from "./competitions.module.css";

export interface CompetitionRoundsProps {
  readonly competitionId: string;
  readonly phase: CompetitionPhase;
  readonly configuration?: CompetitionConfig | null;
  readonly rounds?: readonly CompetitionRoundItem[];
  readonly standings?: readonly CompetitionAggregateStanding[];
  readonly isAdmin: boolean;
  readonly actionLoading: boolean;
  readonly onNextRound: (expectedRound: number) => Promise<void>;
  readonly onRefresh: () => void;
  readonly onNavigateTournament?: (tournamentId: string) => void;
  readonly onStartReplay?: (replayDoc: ReplayDocument) => void;
  readonly onRetryMatch?: (scheduleIndex: number) => Promise<void>;
}

const ROUND_STATUS_BADGE: Record<string, BadgeStatus> = {
  pending: "neutral",
  active: "info",
  running: "info",
  completed: "success",
  error: "danger",
  failed: "danger",
};

export function CompetitionRounds({
  competitionId,
  phase,
  configuration,
  rounds = [],
  standings = [],
  isAdmin,
  actionLoading,
  onNextRound,
  onRefresh,
  onNavigateTournament,
}: CompetitionRoundsProps) {
  const currentRoundNo = configuration?.currentRound || (rounds.length > 0 ? rounds[rounds.length - 1].roundNumber : 1);
  const totalRounds = configuration?.roundCount;

  const [selectedRoundNo, setSelectedRoundNo] = useState<number>(currentRoundNo);
  const [nextLoading, setNextLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (configuration?.currentRound) {
      setSelectedRoundNo(configuration.currentRound);
    } else if (rounds.length > 0) {
      setSelectedRoundNo(rounds[rounds.length - 1].roundNumber);
    }
  }, [configuration?.currentRound, rounds.length]);

  const selectedRound = rounds.find((r) => r.roundNumber === selectedRoundNo) || rounds[rounds.length - 1] || null;

  // Determine if next round can be launched
  const activeRound = rounds.find((r) => r.roundNumber === currentRoundNo);
  const isCurrentRoundCompleted = activeRound?.status === "completed";
  const hasRemainingRounds = !totalRounds || currentRoundNo < totalRounds;
  const nextRoundNumber = currentRoundNo + 1;
  const canLaunchNextRound =
    isAdmin &&
    phase === "running" &&
    hasRemainingRounds &&
    isCurrentRoundCompleted &&
    !actionLoading &&
    !nextLoading;

  const handleNextRoundClick = async () => {
    if (!canLaunchNextRound) return;
    setNextLoading(true);
    setError(null);
    try {
      await onNextRound(nextRoundNumber);
    } catch (err: unknown) {
      setError((err as Error)?.message || `Không thể bắt đầu Vòng ${nextRoundNumber}.`);
    } finally {
      setNextLoading(false);
    }
  };

  return (
    <div className={styles.roundsContainer} data-testid="competition-rounds-panel">
      {/* Header bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <PixelSprite kind="trophy" size={16} decorative />
          <h3 style={{ margin: 0, fontFamily: "var(--ui-font-display)", fontSize: "var(--ui-text-sm)", textTransform: "uppercase" }}>
            Tiến độ vòng đấu: {totalRounds ? `Vòng ${currentRoundNo} / ${totalRounds}` : `Vòng ${currentRoundNo}`}
          </h3>
          <Badge status={phase === "running" ? "info" : phase === "completed" ? "success" : "neutral"}>
            {phase}
          </Badge>
        </div>
        <Button
          variant="secondary"
          onClick={onRefresh}
          disabled={actionLoading || nextLoading}
          aria-label="Làm mới tiến độ vòng đấu"
        >
          Làm mới tiến độ
        </Button>
      </div>

      {error && (
        <div className={styles.errorBanner} role="alert">
          <span>{error}</span>
        </div>
      )}

      {/* Rounds Navigation Tabs */}
      {rounds.length > 0 ? (
        <div className={styles.roundTabs} role="tablist" aria-label="Danh sách các vòng đấu">
          {rounds.map((r) => {
            const isSelected = r.roundNumber === selectedRoundNo;
            return (
              <button
                key={r.roundNumber}
                type="button"
                role="tab"
                aria-selected={isSelected}
                aria-controls={`round-tabpanel-${r.roundNumber}`}
                id={`round-tab-${r.roundNumber}`}
                className={[styles.roundTabBtn, isSelected ? styles.roundTabBtnActive : ""].join(" ")}
                onClick={() => setSelectedRoundNo(r.roundNumber)}
              >
                <span>Vòng {r.roundNumber}</span>
                <Badge status={ROUND_STATUS_BADGE[r.status] || "neutral"}>
                  {r.status}
                </Badge>
              </button>
            );
          })}
        </div>
      ) : (
        <div className={styles.emptyState}>
          Chưa có vòng thi đấu nào được khởi chạy. Vòng 1 sẽ tự động được tạo và khởi chạy khi Ban tổ chức chuyển sự kiện sang trạng thái Đang thi đấu (Running).
        </div>
      )}

      {/* Selected Round Detail */}
      {selectedRound && (
        <div
          id={`round-tabpanel-${selectedRound.roundNumber}`}
          role="tabpanel"
          aria-labelledby={`round-tab-${selectedRound.roundNumber}`}
          className={styles.roundDetailBox}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
            <h4 style={{ margin: 0, fontSize: "var(--ui-text-xs)", textTransform: "uppercase", color: "var(--ui-text-muted)" }}>
              Chi tiết Vòng {selectedRound.roundNumber} — Giải đấu: <code>{selectedRound.tournamentId}</code>
            </h4>
            {onNavigateTournament && (
              <button
                type="button"
                className={styles.tournamentLinkBtn}
                onClick={() => onNavigateTournament(selectedRound.tournamentId)}
                aria-label={`Mở trang giải đấu cho vòng ${selectedRound.roundNumber}`}
              >
                <span>Mở trang giải đấu vòng này</span>
              </button>
            )}
          </div>

          {/* Byes notification */}
          {selectedRound.byes && selectedRound.byes.length > 0 && (
            <div className={styles.byeList} role="status" aria-label="Danh sách bot nhận điểm miễn đấu">
              <strong>Miễn đấu (Byes):</strong>
              {selectedRound.byes.map((b) => (
                <span key={b} className={styles.erroredMatchWarning} style={{ color: "#856404" }}>
                  Bot <code>{b}</code> (+3 điểm)
                </span>
              ))}
            </div>
          )}

          {/* Warnings */}
          {selectedRound.warnings && selectedRound.warnings.length > 0 && (
            <div className={styles.errorBanner} role="alert" style={{ background: "rgba(255, 193, 7, 0.15)", borderColor: "#ffc107" }}>
              <span>
                <strong>Cảnh báo ghép cặp:</strong> {selectedRound.warnings.join("; ")}
              </span>
            </div>
          )}

          {/* Pairings Table */}
          {selectedRound.pairings && selectedRound.pairings.length > 0 ? (
            <div className={styles.tableWrap}>
              <table className={styles.dataTable} aria-label={`Danh sách cặp đấu Vòng ${selectedRound.roundNumber}`}>
                <thead>
                  <tr>
                    <th>Trận (#)</th>
                    <th>Ghế A (Đỏ)</th>
                    <th style={{ textAlign: "center" }}>VS</th>
                    <th>Ghế B (Xanh)</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedRound.pairings.map((p) => (
                    <tr key={p.scheduleIndex} data-testid={`pairing-row-${p.scheduleIndex}`}>
                      <td><strong>#{p.scheduleIndex}</strong></td>
                      <td><span style={{ color: "var(--ui-seat-a, #e63946)", fontWeight: 600 }}>{p.botAId}</span></td>
                      <td style={{ textAlign: "center", color: "var(--ui-text-muted)" }}>⚔️</td>
                      <td><span style={{ color: "var(--ui-seat-b, #457b9d)", fontWeight: 600 }}>{p.botBId}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className={styles.emptyState}>Chưa có thông tin cặp đấu chi tiết cho vòng này.</div>
          )}
        </div>
      )}

      {/* Aggregate Standings Table */}
      {standings.length > 0 && (
        <div style={{ marginTop: "0.5rem" }}>
          <h4 style={{ margin: "0 0 0.5rem 0", fontSize: "var(--ui-text-xs)", textTransform: "uppercase", color: "var(--ui-text-muted)" }}>
            Bảng xếp hạng tổng hợp ({standings.length} bot)
          </h4>
          <div className={styles.tableWrap}>
            <table className={styles.dataTable} aria-label="Bảng xếp hạng tổng hợp đa vòng">
              <thead>
                <tr>
                  <th>Hạng</th>
                  <th>Bot</th>
                  <th>Tổng điểm</th>
                  <th>Đã đấu</th>
                  <th>Thắng</th>
                  <th>Hòa</th>
                  <th>Thua</th>
                  <th>Miễn đấu</th>
                </tr>
              </thead>
              <tbody>
                {standings.map((st, idx) => (
                  <tr key={st.botId}>
                    <td><strong>#{st.rank ?? idx + 1}</strong></td>
                    <td><strong>{st.botName || st.botId}</strong></td>
                    <td><strong style={{ color: "var(--ui-primary, #2b6cb0)" }}>{st.points}</strong></td>
                    <td>{st.matchesPlayed}</td>
                    <td>{st.wins}</td>
                    <td>{st.draws}</td>
                    <td>{st.losses}</td>
                    <td>{st.byes ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Admin Next Round Controls */}
      {isAdmin && phase === "running" && (
        <div className={styles.adminNextRoundBox} data-testid="admin-next-round-box">
          <div>
            <strong>Điều khiển vòng đấu tiếp theo (Admin)</strong>
            <p style={{ margin: "2px 0 0 0", fontSize: "var(--ui-text-xs)", color: "var(--ui-text-muted)" }}>
              {hasRemainingRounds
                ? isCurrentRoundCompleted
                  ? `Vòng ${currentRoundNo} đã hoàn tất. Bạn có thể bắt đầu ghép cặp và khởi chạy Vòng ${nextRoundNumber}.`
                  : `Vòng ${currentRoundNo} đang diễn ra hoặc chưa hoàn tất tất cả các trận đấu. Cần hoàn tất vòng hiện tại trước khi tiếp tục.`
                : `Đã hoàn tất tất cả ${totalRounds} vòng đấu theo cấu hình.`}
            </p>
          </div>
          {hasRemainingRounds ? (
            <Button
              variant="primary"
              disabled={!canLaunchNextRound}
              onClick={handleNextRoundClick}
              data-testid="next-round-button"
            >
              {nextLoading ? "Đang khởi chạy..." : `Bắt đầu Vòng ${nextRoundNumber}`}
            </Button>
          ) : (
            <Badge status="success">Đã hoàn tất các vòng</Badge>
          )}
        </div>
      )}
    </div>
  );
}
