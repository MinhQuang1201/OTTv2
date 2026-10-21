import { useId, type FormEvent } from "react";
import { Badge } from "../../../shared/ui/Badge";
import { Button } from "../../../shared/ui/Button";
import { Spinner } from "../../../shared/ui/Spinner";
import type { CompetitionEntry, CompetitionPhase, ReadyBotVersionOption } from "./types";
import styles from "./competitions.module.css";

export interface CompetitionRosterProps {
  readonly entries: readonly CompetitionEntry[];
  readonly phase: CompetitionPhase;
  readonly isAdmin: boolean;
  readonly isAuthor: boolean;
  readonly currentUserId?: string;
  readonly actionLoading: boolean;
  readonly myEntry?: CompetitionEntry;
  readonly readyBots: readonly ReadyBotVersionOption[];
  readonly loadingReadyBots: boolean;
  readonly botVersionsError?: string | null;
  readonly selectedBotVersionId: string;
  readonly onSelectBotVersionId: (id: string) => void;
  readonly onRegister: () => void;
  readonly onSubmitBot: (e: FormEvent) => void;
  readonly onReview: (userId: string, accepted: boolean) => void;
}

export function CompetitionRoster({
  entries,
  phase,
  isAdmin,
  isAuthor,
  currentUserId,
  actionLoading,
  myEntry,
  readyBots,
  loadingReadyBots,
  botVersionsError,
  selectedBotVersionId,
  onSelectBotVersionId,
  onRegister,
  onSubmitBot,
  onReview,
}: CompetitionRosterProps) {
  const selectBotId = useId();

  const acceptedEntries = entries.filter((e) => e.status === "accepted");
  const pendingEntries = entries.filter((e) => e.status === "pending");
  const readySubmittedEntries = acceptedEntries.filter((e) => Boolean(e.botVersionId));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--ui-space-4)" }}>
      {/* Author Section: Registration & Bot Submission */}
      {isAuthor && (
        <div className={styles.actionBox} data-testid="author-actions">
          <h3>Khu vực người tham gia (Author)</h3>

          {/* Registration phase */}
          {phase === "registration" && (
            <div>
              {!myEntry ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  <p style={{ margin: 0, fontSize: "0.875rem" }}>
                    Giai đoạn đăng ký đang mở. Đăng ký để ban tổ chức xét duyệt tham gia sự kiện.
                  </p>
                  <Button
                    variant="primary"
                    onClick={onRegister}
                    disabled={actionLoading}
                  >
                    {actionLoading ? "Đang đăng ký..." : "Đăng ký tham gia"}
                  </Button>
                </div>
              ) : (
                <div
                  className={
                    myEntry.status === "accepted"
                      ? styles.successBanner
                      : myEntry.status === "pending"
                      ? styles.infoBanner
                      : styles.errorBanner
                  }
                >
                  <span>
                    Trạng thái hồ sơ:{" "}
                    <strong>
                      {myEntry.status === "accepted"
                        ? "Đã được duyệt"
                        : myEntry.status === "pending"
                        ? "Đang chờ duyệt"
                        : "Bị từ chối"}
                    </strong>
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Preparation phase (select and submit owned READY bot version) */}
          {phase === "preparation" && (
            <div>
              {myEntry?.status === "accepted" ? (
                <form onSubmit={onSubmitBot} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                  <p style={{ margin: 0, fontSize: "0.875rem" }}>
                    Giai đoạn chuẩn bị: Hãy chọn một phiên bản bot đã <strong>READY</strong> của bạn để nộp vào sự kiện. Phiên bản này sẽ được khóa bất biến khi bước vào giải đấu.
                  </p>

                  {myEntry.botVersionId ? (
                    <div className={styles.successBanner}>
                      <span>
                        Bot đã nộp hiện tại: <strong>{myEntry.botName}</strong> (v{myEntry.versionNo} - <code>{myEntry.botVersionId}</code>)
                      </span>
                    </div>
                  ) : null}

                  {botVersionsError && (
                    <div className={styles.errorBanner} role="alert">
                      <span>{botVersionsError}</span>
                    </div>
                  )}

                  {loadingReadyBots ? (
                    <Spinner label="Đang tải danh sách bot READY của bạn..." />
                  ) : readyBots.length === 0 ? (
                    <div className={styles.infoBanner}>
                      Bạn chưa có phiên bản bot nào ở trạng thái READY của chính mình. Hãy tạo bot và nộp code thành công tại tab <strong>Quản lý Bot</strong> trước.
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                      <label htmlFor={selectBotId} style={{ fontWeight: 600, fontSize: "0.875rem" }}>
                        Chọn phiên bản bot READY của bạn:
                      </label>
                      <select
                        id={selectBotId}
                        className={styles.selectInput}
                        value={selectedBotVersionId}
                        onChange={(e) => onSelectBotVersionId(e.target.value)}
                        disabled={actionLoading}
                      >
                        {readyBots.map((b) => (
                          <option key={b.versionId} value={b.versionId}>
                            {b.botName} (v{b.versionNo} - {b.versionId} [{b.profileId}])
                          </option>
                        ))}
                      </select>
                      <Button
                        type="submit"
                        variant="primary"
                        disabled={actionLoading || !selectedBotVersionId}
                      >
                        {actionLoading
                          ? "Đang xử lý..."
                          : myEntry.botVersionId
                          ? "Thay đổi phiên bản nộp"
                          : "Xác nhận nộp bot"}
                      </Button>
                    </div>
                  )}
                </form>
              ) : myEntry ? (
                <div className={styles.errorBanner}>
                  Hồ sơ của bạn không ở trạng thái được duyệt ({myEntry.status}).
                </div>
              ) : (
                <div className={styles.infoBanner}>
                  Sự kiện đã kết thúc giai đoạn đăng ký và bạn chưa tham gia sự kiện này.
                </div>
              )}
            </div>
          )}

          {/* Locked / Running / Completed phase */}
          {["locked", "running", "completed"].includes(phase) && (
            <div>
              {myEntry ? (
                <div className={styles.infoBanner}>
                  <span>
                    Phiên bản bot thi đấu của bạn: <strong>{myEntry.botName || "Chưa nộp"}</strong> (v{myEntry.versionNo ?? "?"} - <code>{myEntry.botVersionId || "N/A"}</code>) [Đã khóa bất biến].
                  </span>
                </div>
              ) : (
                <div className={styles.infoBanner}>
                  Bạn không tham gia sự kiện này (chế độ khán giả).
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Roster & Admission Review Table */}
      <div className={styles.actionBox}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
          <h3>Danh sách người tham gia ({entries.length})</h3>
          <div style={{ fontSize: "0.75rem", fontFamily: "var(--ui-font-mono)", color: "var(--ui-text-muted)" }}>
            Duyệt: {acceptedEntries.length} | Chờ: {pendingEntries.length} | Đã nộp bot: {readySubmittedEntries.length}
          </div>
        </div>

        {entries.length === 0 ? (
          <div className={styles.emptyState}>Chưa có người chơi nào đăng ký tham gia.</div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.dataTable}>
              <thead>
                <tr>
                  <th>Tài khoản</th>
                  <th>Trạng thái</th>
                  <th>Bot đã nộp</th>
                  {isAdmin && phase === "registration" ? <th>Xét duyệt</th> : null}
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.userId} data-testid={`entry-row-${entry.userId}`}>
                    <td>
                      <strong>{entry.username}</strong>
                      {entry.userId === currentUserId ? (
                        <span style={{ marginLeft: "6px", color: "var(--ui-seat-b)", fontSize: "0.75rem" }}>(Bạn)</span>
                      ) : null}
                    </td>
                    <td>
                      <Badge status={entry.status === "accepted" ? "success" : entry.status === "pending" ? "warning" : "danger"}>
                        {entry.status}
                      </Badge>
                    </td>
                    <td>
                      {entry.botVersionId ? (
                        <span>
                          <strong>{entry.botName}</strong> <small>(v{entry.versionNo} - <code>{entry.botVersionId}</code>)</small>
                        </span>
                      ) : (
                        <span style={{ color: "var(--ui-text-subtle)", fontStyle: "italic" }}>Chưa nộp</span>
                      )}
                    </td>
                    {isAdmin && phase === "registration" ? (
                      <td>
                        {entry.status === "pending" ? (
                          <div className={styles.entryReviewActions}>
                            <Button
                              variant="secondary"
                              disabled={actionLoading}
                              onClick={() => onReview(entry.userId, true)}
                              aria-label={`Duyệt ${entry.username}`}
                            >
                              Duyệt
                            </Button>
                            <Button
                              variant="quiet"
                              disabled={actionLoading}
                              onClick={() => onReview(entry.userId, false)}
                              aria-label={`Từ chối ${entry.username}`}
                            >
                              Từ chối
                            </Button>
                          </div>
                        ) : (
                          <span style={{ color: "var(--ui-text-muted)", fontSize: "0.75rem" }}>Đã xử lý</span>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
