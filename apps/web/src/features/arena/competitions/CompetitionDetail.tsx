import type { FormEvent } from "react";
import { Badge, type BadgeStatus } from "../../../shared/ui/Badge";
import { Button } from "../../../shared/ui/Button";
import { PixelSprite } from "../../../shared/icons/PixelSprite";
import type { ArenaApiGateway, ArenaUserProfile } from "../ArenaApiGateway";
import type { ReplayDocument } from "../../../../../../packages/arena/src/contracts/index.d.mts";
import type { CompetitionApiClient } from "./CompetitionApiClient";
import { CompetitionRoster } from "./CompetitionRoster";
import { CompetitionLinkedTournament } from "./CompetitionLinkedTournament";
import type {
  CompetitionDetailResponse,
  CompetitionPhase,
  ReadyBotVersionOption,
} from "./types";
import styles from "./competitions.module.css";

export interface CompetitionDetailProps {
  readonly detail: CompetitionDetailResponse;
  readonly userProfile: ArenaUserProfile | null;
  readonly gateway: ArenaApiGateway;
  readonly competitionClient: CompetitionApiClient;
  readonly actionLoading: boolean;
  readonly readyBots: readonly ReadyBotVersionOption[];
  readonly loadingReadyBots: boolean;
  readonly botVersionsError?: string | null;
  readonly selectedBotVersionId: string;
  readonly onSelectBotVersionId: (id: string) => void;
  readonly onRegister: () => void;
  readonly onSubmitBot: (e: FormEvent) => void;
  readonly onReview: (userId: string, accepted: boolean) => void;
  readonly onAdvance: (nextPhase: CompetitionPhase) => void;
  readonly onNavigateTournament?: (tournamentId: string) => void;
  readonly onStartReplay?: (replayDoc: ReplayDocument) => void;
}

const NEXT_PHASE_MAP: Partial<Record<CompetitionPhase, CompetitionPhase>> = {
  registration: "preparation",
  preparation: "locked",
  locked: "running",
  running: "completed",
};

const PHASE_LABEL_MAP: Record<CompetitionPhase, string> = {
  registration: "Đăng ký (registration)",
  preparation: "Chuẩn bị bot (preparation)",
  locked: "Đã khóa (locked)",
  running: "Đang thi đấu (running)",
  completed: "Hoàn tất (completed)",
};

const PHASE_BADGE_STATUS: Record<CompetitionPhase, BadgeStatus> = {
  registration: "info",
  preparation: "warning",
  locked: "neutral",
  running: "info",
  completed: "success",
};

export function CompetitionDetail({
  detail,
  userProfile,
  gateway,
  competitionClient,
  actionLoading,
  readyBots,
  loadingReadyBots,
  botVersionsError,
  selectedBotVersionId,
  onSelectBotVersionId,
  onRegister,
  onSubmitBot,
  onReview,
  onAdvance,
  onNavigateTournament,
  onStartReplay,
}: CompetitionDetailProps) {
  const comp = detail.competition;
  const entries = detail.entries;
  const isAdmin = userProfile?.user.role === "admin";
  const isAuthor = userProfile?.user.role === "author";
  const myEntry = entries.find((e) => e.userId === userProfile?.user.id);

  const acceptedEntries = entries.filter((e) => e.status === "accepted");
  const pendingEntries = entries.filter((e) => e.status === "pending");
  const readySubmittedEntries = acceptedEntries.filter((e) => Boolean(e.botVersionId));

  const nextPhase = NEXT_PHASE_MAP[comp.phase];
  const canAdvanceToPreparation = acceptedEntries.length >= 2 && pendingEntries.length === 0;
  const canAdvanceToLocked =
    acceptedEntries.length >= 2 && readySubmittedEntries.length === acceptedEntries.length;

  return (
    <div className={styles.detailPanel} data-testid="competition-detail">
      {/* Header Info */}
      <div className={styles.detailHeader}>
        <div className={styles.detailTop}>
          <h3 className={styles.detailTitle}>{comp.name}</h3>
          <Badge status={PHASE_BADGE_STATUS[comp.phase]}>
            {PHASE_LABEL_MAP[comp.phase]}
          </Badge>
        </div>
        {comp.description ? (
          <p className={styles.detailDescription}>{comp.description}</p>
        ) : null}
        <div className={styles.detailBadges}>
          <span>
            Thể thức: <strong>{comp.ranked ? "Xếp hạng Elo" : "Giao hữu"}</strong>
          </span>
          {comp.capacity ? (
            <span>
              Số lượng: <strong>{acceptedEntries.length}/{comp.capacity}</strong>
            </span>
          ) : (
            <span>
              Người tham gia: <strong>{acceptedEntries.length}</strong>
            </span>
          )}
          <span>
            Tạo ngày: <strong>{new Date(comp.createdAt).toLocaleDateString()}</strong>
          </span>
        </div>

        {comp.tournamentId && (
          <div style={{ marginTop: "0.5rem" }}>
            <button
              type="button"
              className={styles.tournamentLinkBtn}
              onClick={() => onNavigateTournament?.(comp.tournamentId!)}
              aria-label={`Xem giải đấu liên kết ${comp.tournamentId}`}
            >
              <PixelSprite kind="trophy" size={14} decorative />
              <span>Xem giải đấu liên kết: <code>{comp.tournamentId}</code></span>
            </button>
          </div>
        )}
      </div>

      {/* Admin Phase Advancement Controls */}
      {isAdmin && nextPhase && (
        <div className={styles.actionBox} data-testid="admin-advance-box">
          <h3>Điều khiển tiến độ sự kiện (Admin)</h3>
          <div className={styles.advanceControls}>
            <span>
              Giai đoạn hiện tại: <strong>{PHASE_LABEL_MAP[comp.phase]}</strong>
            </span>

            {comp.phase === "registration" && (
              <div className={styles.advanceHint}>
                Yêu cầu để chuyển sang <code>preparation</code>: Cần ít nhất 2 người tham gia được duyệt (hiện có: {acceptedEntries.length}) và không còn hồ sơ chờ duyệt (hiện còn: {pendingEntries.length}).
              </div>
            )}

            {comp.phase === "preparation" && (
              <div className={styles.advanceHint}>
                Yêu cầu để chuyển sang <code>locked</code>: Tất cả người tham gia được duyệt phải nộp bot READY (hiện có: {readySubmittedEntries.length}/{acceptedEntries.length}).
              </div>
            )}

            {comp.phase === "locked" && (
              <div className={styles.advanceHint}>
                Khởi chạy giải đấu: Hành động này sẽ tạo và khởi chạy một giải đấu tự động trong hệ thống với các bot đã khóa.
              </div>
            )}

            {comp.phase === "running" && (
              <div className={styles.advanceHint}>
                Hoàn tất sự kiện: Chỉ hoàn tất khi toàn bộ các trận đấu của giải đã kết thúc (trận lỗi cần được thử lại trước khi hoàn tất).
              </div>
            )}

            <div style={{ marginTop: "0.5rem" }}>
              <Button
                variant="primary"
                disabled={
                  actionLoading ||
                  (comp.phase === "registration" && !canAdvanceToPreparation) ||
                  (comp.phase === "preparation" && !canAdvanceToLocked)
                }
                onClick={() => onAdvance(nextPhase)}
              >
                {actionLoading ? "Đang xử lý..." : `Chuyển sang: ${PHASE_LABEL_MAP[nextPhase]}`}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Linked Tournament Section (if tournament exists) */}
      {comp.tournamentId && (
        <CompetitionLinkedTournament
          competitionId={comp.id}
          competitionPhase={comp.phase}
          tournamentId={comp.tournamentId}
          isAdmin={isAdmin}
          gateway={gateway}
          competitionClient={competitionClient}
          onNavigateTournament={onNavigateTournament}
          onStartReplay={onStartReplay}
        />
      )}

      {/* Participants Roster & Author Actions */}
      <CompetitionRoster
        entries={entries}
        phase={comp.phase}
        isAdmin={isAdmin}
        isAuthor={isAuthor}
        currentUserId={userProfile?.user.id}
        actionLoading={actionLoading}
        myEntry={myEntry}
        readyBots={readyBots}
        loadingReadyBots={loadingReadyBots}
        botVersionsError={botVersionsError}
        selectedBotVersionId={selectedBotVersionId}
        onSelectBotVersionId={onSelectBotVersionId}
        onRegister={onRegister}
        onSubmitBot={onSubmitBot}
        onReview={onReview}
      />
    </div>
  );
}
