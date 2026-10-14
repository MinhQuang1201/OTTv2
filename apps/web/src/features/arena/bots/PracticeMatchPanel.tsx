import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "../../../shared/ui/Button";
import { Panel } from "../../../shared/ui/Panel";
import { Spinner } from "../../../shared/ui/Spinner";
import type { ArenaApiGateway, ArenaBot, ArenaUserRole } from "../ArenaApiGateway";
import styles from "./practiceMatch.module.css";

const MAX_PAGES = 5;
const PAGE_SIZE = 50;

export interface PracticeMatchPanelProps {
  readonly gateway: ArenaApiGateway;
  readonly userId: string;
  readonly userRole: ArenaUserRole;
  readonly onCreated?: (matchId: string) => void;
  readonly className?: string;
}

export interface ReadyBotVersionOption {
  readonly versionId: string;
  readonly botId: string;
  readonly botName: string;
  readonly ownerId?: string;
  readonly versionNo: number;
  readonly profileId: string;
  readonly isOwned: boolean;
}

interface PaginationInfo {
  readonly loadedCount: number;
  readonly totalCount: number;
  readonly hasMore: boolean;
}

export function PracticeMatchPanel({
  gateway,
  userId,
  userRole,
  onCreated,
  className,
}: PracticeMatchPanelProps) {
  const panelId = useId();
  const selectAId = `seat-a-select-${panelId}`;
  const selectBId = `seat-b-select-${panelId}`;

  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdMatchId, setCreatedMatchId] = useState<string | null>(null);
  const [paginationInfo, setPaginationInfo] = useState<PaginationInfo | null>(null);

  const [allReadyVersions, setAllReadyVersions] = useState<readonly ReadyBotVersionOption[]>([]);
  const [selectedVerA, setSelectedVerA] = useState<string>("");
  const [selectedVerB, setSelectedVerB] = useState<string>("");

  const isAdmin = userRole === "admin";
  const isSpectator = userRole === "spectator";
  const isMountedRef = useRef(true);

  // Load active bots via bounded pagination and retrieve READY versions
  const loadReadyVersions = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        let offset = 0;
        let total = Infinity;
        const fetchedBots: ArenaBot[] = [];
        let page = 0;

        // Bounded pagination: up to MAX_PAGES (250 bots)
        while (offset < total && page < MAX_PAGES) {
          if (signal?.aborted || !isMountedRef.current) return;
          const botsRes = await gateway.listBots({ limit: PAGE_SIZE, offset, signal });
          fetchedBots.push(...botsRes.bots);
          total = botsRes.total;
          offset += botsRes.bots.length;
          page += 1;
          if (botsRes.bots.length === 0 || offset >= total) break;
        }

        if (signal?.aborted || !isMountedRef.current) return;

        setPaginationInfo({
          loadedCount: fetchedBots.length,
          totalCount: total,
          hasMore: total > fetchedBots.length,
        });

        // Filter: active bots only
        const activeBots = fetchedBots.filter((bot) => bot.status === "active");

        const readyList: ReadyBotVersionOption[] = [];
        const failedBotErrors: string[] = [];

        for (const bot of activeBots) {
          if (signal?.aborted || !isMountedRef.current) return;
          try {
            const verRes = await gateway.listBotVersions(bot.id, { signal });
            for (const v of verRes.versions) {
              if (v.buildStatus === "ready") {
                readyList.push({
                  versionId: v.id,
                  botId: bot.id,
                  botName: bot.name,
                  ownerId: bot.ownerId,
                  versionNo: v.versionNo,
                  profileId: v.profileId,
                  isOwned: bot.ownerId === userId,
                });
              }
            }
          } catch (err: unknown) {
            if (signal?.aborted || !isMountedRef.current) return;
            const msg = (err as Error)?.message || "Lỗi tải phiên bản";
            failedBotErrors.push(`${bot.name} (${bot.id}): ${msg}`);
          }
        }

        if (isMountedRef.current && !signal?.aborted) {
          setAllReadyVersions(readyList);

          if (failedBotErrors.length > 0) {
            setError(`Không thể tải phiên bản cho ${failedBotErrors.length} bot: ${failedBotErrors.join("; ")}`);
          }

          // Evaluate valid candidate selections
          const validSeatA = isAdmin || isSpectator ? readyList : readyList.filter((v) => v.isOwned);
          const validSeatB = readyList;

          const candidateA = validSeatA[0] || null;
          const candidateB = candidateA
            ? validSeatB.find((v) => v.versionId !== candidateA.versionId) || validSeatB[0]
            : validSeatB[0] || null;

          // Reset stale or invalid selections
          setSelectedVerA((current) => {
            if (current && validSeatA.some((opt) => opt.versionId === current)) {
              return current;
            }
            return candidateA?.versionId || "";
          });

          setSelectedVerB((current) => {
            if (current && validSeatB.some((opt) => opt.versionId === current)) {
              return current;
            }
            return candidateB?.versionId || "";
          });
        }
      } catch (err: unknown) {
        if (signal?.aborted || !isMountedRef.current) return;
        setError((err as Error)?.message || "Không thể tải danh sách bot cho trận đấu tập.");
      } finally {
        if (isMountedRef.current && !signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [gateway, userId, isAdmin, isSpectator]
  );

  useEffect(() => {
    isMountedRef.current = true;
    const controller = new AbortController();
    void loadReadyVersions(controller.signal);

    return () => {
      isMountedRef.current = false;
      controller.abort();
    };
  }, [loadReadyVersions, userId, userRole]);

  // Options for Seat A: Authors MUST own Seat A; Admins and Spectators may view any ready version
  const seatAOptions = useMemo(() => {
    if (isAdmin || isSpectator) return allReadyVersions;
    return allReadyVersions.filter((v) => v.isOwned);
  }, [isAdmin, isSpectator, allReadyVersions]);

  // Options for Seat B: any ready bot version (allows self-play or vs any opponent)
  const seatBOptions = useMemo(() => allReadyVersions, [allReadyVersions]);

  const handleStartPractice = async () => {
    if (isSpectator) {
      setError("Khán giả không có quyền tạo trận đấu tập.");
      return;
    }

    if (!selectedVerA || !selectedVerB || submitting) return;

    setSubmitting(true);
    setError(null);
    setCreatedMatchId(null);

    try {
      const res = await gateway.createPracticeMatch({
        participants: {
          A: { botVersionId: selectedVerA },
          B: { botVersionId: selectedVerB },
        },
      });

      if (isMountedRef.current) {
        setCreatedMatchId(res.match.id);
        onCreated?.(res.match.id);
      }
    } catch (err: unknown) {
      if (isMountedRef.current) {
        setError((err as Error)?.message || "Không thể tạo trận đấu tập.");
      }
    } finally {
      if (isMountedRef.current) {
        setSubmitting(false);
      }
    }
  };

  return (
    <Panel heading="Đấu tập (Practice Match)">
      <div className={[styles.panel, className || ""].join(" ")}>
        <div className={styles.headerRow}>
          <span className={styles.kicker}>TẬP LUYỆN KHÔNG TÍNH ĐIỂM XẾP HẠNG</span>
          <Button
            variant="secondary"
            onClick={() => void loadReadyVersions()}
            disabled={loading || submitting}
          >
            Làm mới danh sách
          </Button>
        </div>

        {paginationInfo && paginationInfo.hasMore && (
          <div className={styles.paginationNote}>
            Đã tải {paginationInfo.loadedCount} / {paginationInfo.totalCount} bot (tối đa {MAX_PAGES} trang).
          </div>
        )}

        {isSpectator && (
          <div className={styles.infoBanner}>
            Vai trò Khán giả (spectator) chỉ có quyền theo dõi, không thể tạo trận đấu tập.
          </div>
        )}

        {error && (
          <div className={styles.errorBanner} role="alert">
            <span>{error}</span>
          </div>
        )}

        {createdMatchId && (
          <div className={styles.successBanner} role="status">
            <span>
              Đã tạo trận đấu tập thành công: <code>{createdMatchId}</code>
            </span>
          </div>
        )}

        {loading ? (
          <Spinner label="Đang tải các phiên bản bot..." />
        ) : allReadyVersions.length === 0 ? (
          <div className={styles.emptyState}>
            Chưa có phiên bản bot nào ở trạng thái READY. Hãy tạo bot và nộp phiên bản trước khi tạo
            trận đấu tập.
          </div>
        ) : !isAdmin && seatAOptions.length === 0 ? (
          <div className={styles.emptyState}>
            Bạn chưa sở hữu phiên bản bot nào ở trạng thái READY để đặt vào Seat A. Vui lòng nộp mã
            nguồn cho bot của bạn trước.
          </div>
        ) : (
          <>
            <div className={styles.formGrid}>
              {/* Seat A */}
              <div className={styles.seatBox}>
                <span className={styles.seatTagA}>
                  <strong>Seat A</strong>
                  <small>{isAdmin ? "(Bất kỳ)" : "(Bot của bạn)"}</small>
                </span>
                <label htmlFor={selectAId} className={styles.fieldLabel}>
                  Chọn phiên bản bot:
                  <select
                    id={selectAId}
                    className={styles.select}
                    value={selectedVerA}
                    onChange={(e) => setSelectedVerA(e.target.value)}
                    disabled={submitting || isSpectator}
                    aria-label="Phiên bản bot Seat A"
                  >
                    {seatAOptions.map((opt) => (
                      <option key={opt.versionId} value={opt.versionId}>
                        {opt.botName} (v{opt.versionNo} · {opt.profileId})
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {/* Seat B */}
              <div className={styles.seatBox}>
                <span className={styles.seatTagB}>
                  <strong>Seat B</strong>
                  <small>(Đối thủ hoặc tự luyện)</small>
                </span>
                <label htmlFor={selectBId} className={styles.fieldLabel}>
                  Chọn phiên bản đối thủ:
                  <select
                    id={selectBId}
                    className={styles.select}
                    value={selectedVerB}
                    onChange={(e) => setSelectedVerB(e.target.value)}
                    disabled={submitting || isSpectator}
                    aria-label="Phiên bản bot Seat B"
                  >
                    {seatBOptions.map((opt) => (
                      <option key={opt.versionId} value={opt.versionId}>
                        {opt.botName} (v{opt.versionNo} · {opt.profileId})
                        {opt.isOwned ? " [Của bạn]" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            <div className={styles.actionsRow}>
              <Button
                variant="primary"
                onClick={handleStartPractice}
                disabled={isSpectator || !selectedVerA || !selectedVerB || submitting}
              >
                {submitting ? "Đang lên lịch..." : "Bắt đầu trận đấu tập"}
              </Button>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
