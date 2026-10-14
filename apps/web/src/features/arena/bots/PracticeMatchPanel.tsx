import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "../../../shared/ui/Button";
import { Panel } from "../../../shared/ui/Panel";
import { Spinner } from "../../../shared/ui/Spinner";
import type { ArenaApiGateway, ArenaBot, ArenaBotVersion } from "../ArenaApiGateway";
import styles from "./practiceMatch.module.css";

export interface PracticeMatchPanelProps {
  readonly gateway: ArenaApiGateway;
  readonly userId: string;
  readonly userRole?: "admin" | "author" | "user" | string;
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

export function PracticeMatchPanel({
  gateway,
  userId,
  userRole = "author",
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

  const [allReadyVersions, setAllReadyVersions] = useState<readonly ReadyBotVersionOption[]>([]);
  const [selectedVerA, setSelectedVerA] = useState<string>("");
  const [selectedVerB, setSelectedVerB] = useState<string>("");

  const isAdmin = userRole === "admin";
  const isMountedRef = useRef(true);

  // Load active bots and their READY versions
  const loadReadyVersions = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const botsRes = await gateway.listBots({ limit: 50, signal });
        if (signal?.aborted || !isMountedRef.current) return;

        const readyList: ReadyBotVersionOption[] = [];
        for (const bot of botsRes.bots) {
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
          } catch {
            // Ignore individual bot version listing errors
          }
        }

        if (isMountedRef.current && !signal?.aborted) {
          setAllReadyVersions(readyList);

          // Seed default selections if not already chosen
          const candidateA = isAdmin
            ? readyList[0]
            : readyList.find((v) => v.isOwned) || null;
          const candidateB = candidateA
            ? readyList.find((v) => v.versionId !== candidateA.versionId) || candidateA
            : readyList[0] || null;

          if (candidateA) {
            setSelectedVerA((prev) => prev || candidateA.versionId);
          }
          if (candidateB) {
            setSelectedVerB((prev) => prev || candidateB.versionId);
          }
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
    [gateway, userId, isAdmin]
  );

  useEffect(() => {
    isMountedRef.current = true;
    const controller = new AbortController();
    void loadReadyVersions(controller.signal);

    return () => {
      isMountedRef.current = false;
      controller.abort();
    };
  }, [loadReadyVersions]);

  // Options for Seat A: Authors MUST own Seat A; Admins may choose any ready version
  const seatAOptions = useMemo(() => {
    if (isAdmin) return allReadyVersions;
    return allReadyVersions.filter((v) => v.isOwned);
  }, [isAdmin, allReadyVersions]);

  // Options for Seat B: any ready bot version (allows self-play or vs any opponent)
  const seatBOptions = useMemo(() => allReadyVersions, [allReadyVersions]);

  const handleStartPractice = async () => {
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
                    disabled={submitting}
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
                    disabled={submitting}
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
                disabled={!selectedVerA || !selectedVerB || submitting}
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
