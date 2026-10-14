import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, type BadgeStatus } from "../../../shared/ui/Badge";
import { Button } from "../../../shared/ui/Button";
import { Spinner } from "../../../shared/ui/Spinner";
import { PixelSprite } from "../../../shared/icons/PixelSprite";
import type {
  ArenaApiGateway,
  ArenaTournamentDetailsResponse,
  ArenaMatchStatus,
  ArenaTournamentStatus,
} from "../ArenaApiGateway";
import type { ReplayDocument } from "../../../../../../packages/arena/src/contracts/index.d.mts";
import type { CompetitionApiClient } from "./CompetitionApiClient";
import type { CompetitionPhase } from "./types";
import styles from "./competitions.module.css";

export interface CompetitionLinkedTournamentProps {
  readonly competitionId: string;
  readonly competitionPhase: CompetitionPhase;
  readonly tournamentId: string;
  readonly isAdmin: boolean;
  readonly gateway: ArenaApiGateway;
  readonly competitionClient: CompetitionApiClient;
  readonly onNavigateTournament?: (tournamentId: string) => void;
  readonly onStartReplay?: (replayDoc: ReplayDocument) => void;
}

const TOURNAMENT_STATUS_BADGE: Record<ArenaTournamentStatus | string, BadgeStatus> = {
  pending: "neutral",
  active: "info",
  completed: "success",
  cancelled: "danger",
};

const MATCH_STATUS_BADGE: Record<ArenaMatchStatus | string, BadgeStatus> = {
  pending: "neutral",
  active: "info",
  completed: "success",
  cancelled: "neutral",
  error: "danger",
  failed: "danger",
};

export function CompetitionLinkedTournament({
  competitionId,
  competitionPhase,
  tournamentId,
  isAdmin,
  gateway,
  competitionClient,
  onNavigateTournament,
  onStartReplay,
}: CompetitionLinkedTournamentProps) {
  const [data, setData] = useState<ArenaTournamentDetailsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryMsg, setRetryMsg] = useState<string | null>(null);
  const [retryingIndex, setRetryingIndex] = useState<number | null>(null);
  const [replayLoadingId, setReplayLoadingId] = useState<string | null>(null);

  const activeControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      activeControllerRef.current?.abort();
    };
  }, []);

  const loadTournament = useCallback(async () => {
    activeControllerRef.current?.abort();
    const controller = new AbortController();
    activeControllerRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const res = await gateway.getTournament(tournamentId, { signal: controller.signal });
      if (isMountedRef.current && !controller.signal.aborted) {
        setData(res);
      }
    } catch (err: unknown) {
      if (isMountedRef.current && !controller.signal.aborted) {
        setError((err as Error)?.message || "Không thể tải dữ liệu giải đấu liên kết.");
      }
    } finally {
      if (isMountedRef.current && !controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [gateway, tournamentId]);

  useEffect(() => {
    void loadTournament();
  }, [loadTournament]);

  const handleRetryMatch = async (scheduleIndex: number) => {
    setRetryingIndex(scheduleIndex);
    setRetryMsg(null);
    setError(null);
    try {
      await competitionClient.retryMatch(competitionId, scheduleIndex);
      if (isMountedRef.current) {
        setRetryMsg(`Đã yêu cầu chạy lại trận đấu #${scheduleIndex}. Dữ liệu đang được cập nhật.`);
        await loadTournament();
      }
    } catch (err: unknown) {
      if (isMountedRef.current) {
        setError((err as Error)?.message || `Không thể thử lại trận đấu #${scheduleIndex}.`);
      }
    } finally {
      if (isMountedRef.current) {
        setRetryingIndex(null);
      }
    }
  };

  const handleWatchReplay = async (matchId: string) => {
    if (!onStartReplay) return;
    setReplayLoadingId(matchId);
    setError(null);
    try {
      const res = await gateway.getMatchReplay(matchId);
      if (isMountedRef.current && res.replay) {
        onStartReplay(res.replay);
      }
    } catch (err: unknown) {
      if (isMountedRef.current) {
        setError((err as Error)?.message || "Không thể tải replay trận đấu.");
      }
    } finally {
      if (isMountedRef.current) {
        setReplayLoadingId(null);
      }
    }
  };

  const tournament = data?.tournament;
  const standings = data?.standings ?? [];
  const matches = data?.matches ?? [];
  const erroredMatches = matches.filter((m) => m.status === "error" || m.status === "failed");

  return (
    <div className={styles.linkedTournamentBox} data-testid="linked-tournament-panel">
      <div className={styles.tournamentBar}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <PixelSprite kind="trophy" size={16} decorative />
          <h3 style={{ margin: 0, fontFamily: "var(--ui-font-display)", fontSize: "var(--ui-text-sm)", textTransform: "uppercase" }}>
            Giải đấu liên kết: <code>{tournamentId}</code>
          </h3>
          {tournament && (
            <Badge status={TOURNAMENT_STATUS_BADGE[tournament.status] || "neutral"}>
              {tournament.status}
            </Badge>
          )}
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <Button
            variant="secondary"
            onClick={loadTournament}
            disabled={loading || retryingIndex !== null}
            aria-label="Làm mới kết quả giải đấu"
          >
            {loading ? "Đang tải..." : "Làm mới giải đấu"}
          </Button>
          {onNavigateTournament && (
            <button
              type="button"
              className={styles.tournamentLinkBtn}
              onClick={() => onNavigateTournament(tournamentId)}
              aria-label={`Mở màn hình giải đấu ${tournamentId}`}
            >
              <span>Mở trang giải đấu</span>
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className={styles.errorBanner} role="alert">
          <span>{error}</span>
          <Button variant="secondary" onClick={loadTournament}>
            Thử lại
          </Button>
        </div>
      )}

      {retryMsg && (
        <div className={styles.successBanner} role="status">
          <span>{retryMsg}</span>
          <Button variant="quiet" onClick={() => setRetryMsg(null)}>
            Đóng
          </Button>
        </div>
      )}

      {erroredMatches.length > 0 && (
        <div className={styles.errorBanner} role="alert" data-testid="errored-matches-alert">
          <span>
            Phát hiện <strong>{erroredMatches.length}</strong> trận đấu gặp lỗi trong giải đấu.
            {isAdmin && competitionPhase === "running" ? " Ban tổ chức có thể thử lại các trận đấu này bên dưới." : ""}
          </span>
        </div>
      )}

      {loading && !data ? (
        <Spinner label="Đang tải dữ liệu giải đấu..." />
      ) : data ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--ui-space-3)" }}>
          {/* Standings Table */}
          {standings.length > 0 && (
            <div>
              <h4 style={{ margin: "0 0 0.5rem 0", fontSize: "var(--ui-text-xs)", textTransform: "uppercase", color: "var(--ui-text-muted)" }}>
                Bảng xếp hạng (Standings)
              </h4>
              <div className={styles.tableWrap}>
                <table className={styles.dataTable} aria-label="Bảng xếp hạng giải đấu">
                  <thead>
                    <tr>
                      <th>Hạng</th>
                      <th>Bot</th>
                      <th>Điểm</th>
                      <th>Số trận</th>
                      <th>Thắng</th>
                      <th>Hòa</th>
                      <th>Thua</th>
                    </tr>
                  </thead>
                  <tbody>
                    {standings.map((st, idx) => (
                      <tr key={st.botId}>
                        <td><strong>#{st.rank ?? idx + 1}</strong></td>
                        <td><strong>{st.botName || st.botId}</strong></td>
                        <td>{st.points}</td>
                        <td>{st.matchesPlayed}</td>
                        <td>{st.wins}</td>
                        <td>{st.draws}</td>
                        <td>{st.losses}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Matches Table */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
              <h4 style={{ margin: 0, fontSize: "var(--ui-text-xs)", textTransform: "uppercase", color: "var(--ui-text-muted)" }}>
                Lịch thi đấu & Kết quả ({matches.length} trận)
              </h4>
              {erroredMatches.length > 0 && (
                <span className={styles.erroredMatchWarning}>
                  ⚠️ {erroredMatches.length} trận lỗi
                </span>
              )}
            </div>

            {matches.length === 0 ? (
              <div className={styles.emptyState}>Chưa có lịch thi đấu được tạo.</div>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.dataTable} aria-label="Danh sách trận đấu giải">
                  <thead>
                    <tr>
                      <th>Lịch (#)</th>
                      <th>Loại</th>
                      <th>Trạng thái</th>
                      <th>Thời gian</th>
                      <th>Thao tác</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matches.map((m) => {
                      const isMatchError = m.status === "error" || m.status === "failed";
                      const isRetrying = retryingIndex === m.scheduleIndex;
                      const canAdminRetry = isAdmin && competitionPhase === "running" && isMatchError;
                      const canReplay = Boolean(onStartReplay && m.status === "completed");

                      return (
                        <tr
                          key={m.id || String(m.scheduleIndex)}
                          className={isMatchError ? styles.matchErrorRow : undefined}
                          data-testid={`match-row-${m.scheduleIndex}`}
                        >
                          <td>
                            <strong>#{m.scheduleIndex}</strong>
                          </td>
                          <td>
                            <span>{m.kind}</span>
                          </td>
                          <td>
                            <Badge status={MATCH_STATUS_BADGE[m.status] || "neutral"}>
                              {m.status}
                            </Badge>
                          </td>
                          <td>
                            {m.settledAt ? (
                              <span style={{ fontSize: "0.75rem", fontFamily: "var(--ui-font-mono)" }}>
                                {new Date(m.settledAt).toLocaleTimeString()}
                              </span>
                            ) : (
                              <span style={{ color: "var(--ui-text-muted)", fontSize: "0.75rem" }}>-</span>
                            )}
                          </td>
                          <td>
                            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                              {canAdminRetry && (
                                <Button
                                  variant="secondary"
                                  disabled={isRetrying || loading}
                                  onClick={() => handleRetryMatch(m.scheduleIndex)}
                                  aria-label={`Thử lại trận #${m.scheduleIndex}`}
                                  data-testid={`retry-match-btn-${m.scheduleIndex}`}
                                >
                                  {isRetrying ? "Đang thử lại..." : "Thử lại trận lỗi"}
                                </Button>
                              )}

                              {canReplay && (
                                <Button
                                  variant="quiet"
                                  disabled={replayLoadingId === m.id}
                                  onClick={() => handleWatchReplay(m.id)}
                                  aria-label={`Xem replay trận #${m.scheduleIndex}`}
                                >
                                  {replayLoadingId === m.id ? "Đang tải..." : "Xem Replay"}
                                </Button>
                              )}

                              {!canAdminRetry && !canReplay && (
                                <span style={{ color: "var(--ui-text-muted)", fontSize: "0.75rem" }}>-</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
