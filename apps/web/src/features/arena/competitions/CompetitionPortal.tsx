import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Badge, type BadgeStatus } from "../../../shared/ui/Badge";
import { Button } from "../../../shared/ui/Button";
import { Panel } from "../../../shared/ui/Panel";
import { Spinner } from "../../../shared/ui/Spinner";
import { TextField } from "../../../shared/ui/TextField";
import { PixelSprite } from "../../../shared/icons/PixelSprite";
import type { ArenaApiGateway, ArenaUserProfile } from "../ArenaApiGateway";
import { CompetitionApiClient, CompetitionApiError } from "./CompetitionApiClient";
import type {
  Competition,
  CompetitionDetailResponse,
  CompetitionEntry,
  CompetitionPhase,
  ReadyBotVersionOption,
} from "./types";
import styles from "./competitions.module.css";

export interface CompetitionPortalProps {
  readonly gateway: ArenaApiGateway;
  readonly userProfile: ArenaUserProfile | null;
  readonly onNavigateTournament?: (tournamentId: string) => void;
  readonly client?: CompetitionApiClient;
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

export function CompetitionPortal({
  gateway,
  userProfile,
  onNavigateTournament,
  client: injectedClient,
}: CompetitionPortalProps) {
  const clientRef = useRef<CompetitionApiClient>(injectedClient ?? new CompetitionApiClient(gateway));
  if (injectedClient && clientRef.current !== injectedClient) {
    clientRef.current = injectedClient;
  }

  const [competitions, setCompetitions] = useState<readonly Competition[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CompetitionDetailResponse | null>(null);

  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Admin create event form
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [createCapacity, setCreateCapacity] = useState("");
  const [createRanked, setCreateRanked] = useState(true);

  // Author ready bots for selection
  const [readyBots, setReadyBots] = useState<readonly ReadyBotVersionOption[]>([]);
  const [selectedBotVersionId, setSelectedBotVersionId] = useState<string>("");
  const [loadingReadyBots, setLoadingReadyBots] = useState(false);

  // Accessible IDs
  const createDescId = useId();
  const selectBotId = useId();

  // Cancellation
  const isMountedRef = useRef(true);
  const generationRef = useRef(0);
  const pendingControllersRef = useRef(new Set<AbortController>());

  const abortPending = useCallback(() => {
    for (const c of pendingControllersRef.current) {
      try {
        c.abort();
      } catch {
        // safe
      }
    }
    pendingControllersRef.current.clear();
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      generationRef.current += 1;
      abortPending();
    };
  }, [abortPending]);

  const loadCompetitions = useCallback(async () => {
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    pendingControllersRef.current.add(controller);
    const gen = generationRef.current;
    try {
      const list = await clientRef.current.listCompetitions({ signal: controller.signal });
      if (isMountedRef.current && gen === generationRef.current && !controller.signal.aborted) {
        setCompetitions(list);
        if (list.length > 0) {
          setSelectedId((prev) => prev || list[0].id);
        }
      }
    } catch (err: unknown) {
      if (isMountedRef.current && gen === generationRef.current && !controller.signal.aborted) {
        setError((err as Error)?.message || "Không thể tải danh sách sự kiện.");
      }
    } finally {
      pendingControllersRef.current.delete(controller);
      if (isMountedRef.current && gen === generationRef.current && !controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    setError(null);
    const controller = new AbortController();
    pendingControllersRef.current.add(controller);
    const gen = generationRef.current;
    try {
      const res = await clientRef.current.getCompetition(id, { signal: controller.signal });
      if (isMountedRef.current && gen === generationRef.current && !controller.signal.aborted) {
        setDetail(res);
      }
    } catch (err: unknown) {
      if (isMountedRef.current && gen === generationRef.current && !controller.signal.aborted) {
        setError((err as Error)?.message || "Không thể tải chi tiết sự kiện.");
      }
    } finally {
      pendingControllersRef.current.delete(controller);
      if (isMountedRef.current && gen === generationRef.current && !controller.signal.aborted) {
        setDetailLoading(false);
      }
    }
  }, []);

  // Initial load
  useEffect(() => {
    void loadCompetitions();
  }, [loadCompetitions]);

  // Load detail on select
  useEffect(() => {
    if (selectedId) {
      void loadDetail(selectedId);
    } else {
      setDetail(null);
    }
  }, [selectedId, loadDetail]);

  // Load author's ready bots when competition is in preparation phase
  useEffect(() => {
    if (detail?.competition.phase === "preparation" && userProfile?.user.role === "author") {
      const controller = new AbortController();
      pendingControllersRef.current.add(controller);
      const gen = generationRef.current;
      setLoadingReadyBots(true);

      gateway
        .listBots({ signal: controller.signal })
        .then(async (botsRes) => {
          const readyOptions: ReadyBotVersionOption[] = [];
          for (const bot of botsRes.bots) {
            if (controller.signal.aborted) break;
            try {
              const verRes = await gateway.listBotVersions(bot.id, { signal: controller.signal });
              for (const v of verRes.versions) {
                if (v.buildStatus === "ready") {
                  readyOptions.push({
                    versionId: v.id,
                    botId: bot.id,
                    botName: bot.name,
                    versionNo: v.versionNo,
                    profileId: v.profileId,
                  });
                }
              }
            } catch {
              // Ignore single bot version load failure
            }
          }
          if (isMountedRef.current && gen === generationRef.current && !controller.signal.aborted) {
            setReadyBots(readyOptions);
            setSelectedBotVersionId((prev) => prev || (readyOptions.length > 0 ? readyOptions[0].versionId : ""));
          }
        })
        .catch(() => {
          if (isMountedRef.current && gen === generationRef.current && !controller.signal.aborted) {
            setReadyBots([]);
          }
        })
        .finally(() => {
          pendingControllersRef.current.delete(controller);
          if (isMountedRef.current && gen === generationRef.current && !controller.signal.aborted) {
            setLoadingReadyBots(false);
          }
        });

      return () => {
        controller.abort();
        pendingControllersRef.current.delete(controller);
      };
    } else {
      setReadyBots([]);
    }
  }, [detail?.competition.phase, userProfile?.user.role, gateway]);

  const handleRefresh = () => {
    setError(null);
    setSuccessMsg(null);
    void loadCompetitions();
    if (selectedId) {
      void loadDetail(selectedId);
    }
  };

  const handleCreateSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!createName.trim()) return;
    setActionLoading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const capNum = createCapacity.trim() ? Number.parseInt(createCapacity.trim(), 10) : undefined;
      const created = await clientRef.current.createCompetition({
        name: createName.trim(),
        description: createDesc.trim() || undefined,
        capacity: Number.isInteger(capNum) && capNum && capNum > 0 ? capNum : undefined,
        ranked: createRanked,
      });
      setCreateName("");
      setCreateDesc("");
      setCreateCapacity("");
      setShowCreateForm(false);
      setSuccessMsg(`Tạo sự kiện "${created.name}" thành công.`);
      setSelectedId(created.id);
      await loadCompetitions();
    } catch (err: unknown) {
      setError((err as Error)?.message || "Không thể tạo sự kiện.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleRegister = async () => {
    if (!selectedId) return;
    setActionLoading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      await clientRef.current.registerForCompetition(selectedId);
      setSuccessMsg("Đăng ký tham gia thành công. Đang chờ ban tổ chức duyệt.");
      await loadDetail(selectedId);
    } catch (err: unknown) {
      setError((err as Error)?.message || "Không thể đăng ký tham gia sự kiện.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleReview = async (userId: string, accepted: boolean) => {
    if (!selectedId) return;
    setActionLoading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      await clientRef.current.reviewEntry(selectedId, userId, accepted);
      setSuccessMsg(accepted ? "Đã duyệt người tham gia." : "Đã từ chối người tham gia.");
      await loadDetail(selectedId);
    } catch (err: unknown) {
      setError((err as Error)?.message || "Không thể cập nhật hồ sơ người tham gia.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleSubmitBot = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedId || !selectedBotVersionId) return;
    setActionLoading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      await clientRef.current.submitBotVersion(selectedId, selectedBotVersionId);
      setSuccessMsg("Nộp phiên bản bot thành công.");
      await loadDetail(selectedId);
    } catch (err: unknown) {
      setError((err as Error)?.message || "Không thể nộp phiên bản bot.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleAdvance = async (nextPhase: CompetitionPhase) => {
    if (!selectedId) return;
    setActionLoading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const updated = await clientRef.current.advancePhase(selectedId, nextPhase);
      setSuccessMsg(`Đã chuyển giai đoạn sang "${PHASE_LABEL_MAP[updated.phase]}".`);
      await loadDetail(selectedId);
      await loadCompetitions();
    } catch (err: unknown) {
      setError((err as Error)?.message || "Không thể chuyển giai đoạn sự kiện.");
    } finally {
      setActionLoading(false);
    }
  };

  const currentComp = detail?.competition;
  const currentEntries = detail?.entries ?? [];
  const myEntry: CompetitionEntry | undefined = currentEntries.find(
    (e) => e.userId === userProfile?.user.id
  );

  const isAdmin = userProfile?.user.role === "admin";
  const isAuthor = userProfile?.user.role === "author";
  const nextPhase = currentComp ? NEXT_PHASE_MAP[currentComp.phase] : undefined;

  // Validation metrics for phase advancement
  const acceptedEntries = currentEntries.filter((e) => e.status === "accepted");
  const pendingEntries = currentEntries.filter((e) => e.status === "pending");
  const readySubmittedEntries = acceptedEntries.filter((e) => Boolean(e.botVersionId));

  const canAdvanceToPreparation = acceptedEntries.length >= 2 && pendingEntries.length === 0;
  const canAdvanceToLocked =
    acceptedEntries.length >= 2 && readySubmittedEntries.length === acceptedEntries.length;

  return (
    <div className={styles.container}>
      <header className={styles.headerBar}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <PixelSprite kind="trophy" size={16} decorative />
          <h2 className={styles.headerTitle}>Sự kiện thi đấu AI</h2>
        </div>
        <div className={styles.headerActions}>
          {isAdmin && (
            <Button
              variant={showCreateForm ? "quiet" : "primary"}
              onClick={() => setShowCreateForm((prev) => !prev)}
            >
              {showCreateForm ? "Đóng tạo sự kiện" : "Tạo sự kiện mới"}
            </Button>
          )}
          <Button variant="secondary" onClick={handleRefresh} disabled={loading || detailLoading || actionLoading}>
            Làm mới
          </Button>
        </div>
      </header>

      {error && (
        <div className={styles.errorBanner} role="alert">
          <span>{error}</span>
          <Button variant="secondary" onClick={handleRefresh}>
            Thử lại
          </Button>
        </div>
      )}

      {successMsg && (
        <div className={styles.successBanner} role="status">
          <span>{successMsg}</span>
          <Button variant="quiet" onClick={() => setSuccessMsg(null)}>
            Đóng
          </Button>
        </div>
      )}

      {showCreateForm && isAdmin && (
        <Panel heading="Tạo sự kiện thi đấu mới (Admin)">
          <form className={styles.formBox} onSubmit={handleCreateSubmit} data-testid="create-competition-form">
            <TextField
              label="Tên sự kiện"
              value={createName}
              onChange={(e) => setCreateName(e.currentTarget.value)}
              placeholder="VD: OTT Cup Mùa Xuân 2026"
              required
              disabled={actionLoading}
            />

            <div>
              <label htmlFor={createDescId} style={{ display: "block", marginBottom: "0.25rem", fontWeight: 600 }}>
                Mô tả sự kiện:
              </label>
              <textarea
                id={createDescId}
                className={styles.textarea}
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
                placeholder="Mô tả thể thức thi đấu, giải thưởng..."
                disabled={actionLoading}
              />
            </div>

            <TextField
              label="Số lượng tối đa (Capacity)"
              type="number"
              value={createCapacity}
              onChange={(e) => setCreateCapacity(e.currentTarget.value)}
              placeholder="Mặc định: không giới hạn"
              min="2"
              disabled={actionLoading}
            />

            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={createRanked}
                onChange={(e) => setCreateRanked(e.target.checked)}
                disabled={actionLoading}
              />
              <span>Tính điểm xếp hạng Elo (Ranked)</span>
            </label>

            <div style={{ display: "flex", gap: "0.5rem" }}>
              <Button type="submit" variant="primary" disabled={actionLoading || !createName.trim()}>
                {actionLoading ? "Đang tạo..." : "Xác nhận tạo sự kiện"}
              </Button>
              <Button variant="quiet" onClick={() => setShowCreateForm(false)} disabled={actionLoading}>
                Hủy
              </Button>
            </div>
          </form>
        </Panel>
      )}

      {loading && competitions.length === 0 ? (
        <Panel>
          <Spinner label="Đang tải danh sách sự kiện..." />
        </Panel>
      ) : (
        <div className={styles.gridTwoCols}>
          {/* Left Column: Competition List */}
          <Panel heading="Danh sách sự kiện">
            {competitions.length === 0 ? (
              <div className={styles.emptyState}>Chưa có sự kiện thi đấu nào.</div>
            ) : (
              <div className={styles.listWrap} role="list" aria-label="Danh sách sự kiện">
                {competitions.map((comp) => {
                  const isSelected = comp.id === selectedId;
                  return (
                    <button
                      type="button"
                      key={comp.id}
                      role="listitem"
                      aria-label={`Sự kiện ${comp.name}`}
                      className={[
                        styles.competitionCard,
                        isSelected ? styles.competitionCardSelected : "",
                      ].join(" ")}
                      onClick={() => setSelectedId(comp.id)}
                    >
                      <div className={styles.cardHeader}>
                        <h4 className={styles.cardTitle}>{comp.name}</h4>
                        <Badge status={PHASE_BADGE_STATUS[comp.phase]}>
                          {comp.phase}
                        </Badge>
                      </div>
                      <div className={styles.cardMeta}>
                        <span>{comp.ranked ? "Ranked" : "Unranked"}</span>
                        {comp.capacity ? <span>Tối đa: {comp.capacity}</span> : null}
                        <span>{new Date(comp.createdAt).toLocaleDateString()}</span>
                      </div>
                      {comp.description ? (
                        <p className={styles.cardDescription}>{comp.description}</p>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
          </Panel>

          {/* Right Column: Selected Competition Detail */}
          <Panel heading="Chi tiết sự kiện & Điều phối">
            {detailLoading ? (
              <Spinner label="Đang tải thông tin chi tiết..." />
            ) : currentComp ? (
              <div className={styles.detailPanel} data-testid="competition-detail">
                <div className={styles.detailHeader}>
                  <div className={styles.detailTop}>
                    <h3 className={styles.detailTitle}>{currentComp.name}</h3>
                    <Badge status={PHASE_BADGE_STATUS[currentComp.phase]}>
                      {PHASE_LABEL_MAP[currentComp.phase]}
                    </Badge>
                  </div>
                  {currentComp.description ? (
                    <p className={styles.detailDescription}>{currentComp.description}</p>
                  ) : null}
                  <div className={styles.detailBadges}>
                    <span>Thể thức: <strong>{currentComp.ranked ? "Xếp hạng Elo" : "Giao hữu"}</strong></span>
                    {currentComp.capacity ? (
                      <span>Số lượng: <strong>{acceptedEntries.length}/{currentComp.capacity}</strong></span>
                    ) : (
                      <span>Người tham gia: <strong>{acceptedEntries.length}</strong></span>
                    )}
                    <span>Tạo ngày: <strong>{new Date(currentComp.createdAt).toLocaleDateString()}</strong></span>
                  </div>

                  {currentComp.tournamentId && (
                    <div style={{ marginTop: "0.5rem" }}>
                      <button
                        type="button"
                        className={styles.tournamentLinkBtn}
                        onClick={() => onNavigateTournament?.(currentComp.tournamentId!)}
                        aria-label={`Xem giải đấu liên kết ${currentComp.tournamentId}`}
                      >
                        <PixelSprite kind="trophy" size={14} decorative />
                        <span>Xem giải đấu liên kết: <code>{currentComp.tournamentId}</code></span>
                      </button>
                    </div>
                  )}
                </div>

                {/* Author Section: Registration & Bot Submission */}
                {isAuthor && (
                  <div className={styles.actionBox} data-testid="author-actions">
                    <h3>Khu vực người tham gia (Author)</h3>

                    {/* Step 1: Registration phase */}
                    {currentComp.phase === "registration" && (
                      <div>
                        {!myEntry ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                            <p style={{ margin: 0, fontSize: "0.875rem" }}>
                              Giai đoạn đăng ký đang mở. Đăng ký để ban tổ chức xét duyệt tham gia sự kiện.
                            </p>
                            <Button
                              variant="primary"
                              onClick={handleRegister}
                              disabled={actionLoading}
                            >
                              {actionLoading ? "Đang đăng ký..." : "Đăng ký tham gia"}
                            </Button>
                          </div>
                        ) : (
                          <div className={myEntry.status === "accepted" ? styles.successBanner : myEntry.status === "pending" ? styles.infoBanner : styles.errorBanner}>
                            <span>
                              Trạng thái hồ sơ: <strong>{myEntry.status === "accepted" ? "Đã được duyệt" : myEntry.status === "pending" ? "Đang chờ duyệt" : "Bị từ chối"}</strong>
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Step 2: Preparation phase (select and submit owned READY bot version) */}
                    {currentComp.phase === "preparation" && (
                      <div>
                        {myEntry?.status === "accepted" ? (
                          <form onSubmit={handleSubmitBot} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
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

                            {loadingReadyBots ? (
                              <Spinner label="Đang tải danh sách bot READY của bạn..." />
                            ) : readyBots.length === 0 ? (
                              <div className={styles.infoBanner}>
                                Bạn chưa có phiên bản bot nào ở trạng thái READY. Hãy tạo bot và nộp code thành công tại tab <strong>Quản lý Bot</strong> trước.
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
                                  onChange={(e) => setSelectedBotVersionId(e.target.value)}
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
                                  {actionLoading ? "Đang xử lý..." : myEntry.botVersionId ? "Thay đổi phiên bản nộp" : "Xác nhận nộp bot"}
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

                    {/* Step 3: Locked / Running / Completed phase */}
                    {["locked", "running", "completed"].includes(currentComp.phase) && (
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

                {/* Admin Phase Advancement Controls */}
                {isAdmin && nextPhase && (
                  <div className={styles.actionBox} data-testid="admin-advance-box">
                    <h3>Điều khiển tiến độ sự kiện (Admin)</h3>
                    <div className={styles.advanceControls}>
                      <span>
                        Giai đoạn hiện tại: <strong>{PHASE_LABEL_MAP[currentComp.phase]}</strong>
                      </span>

                      {currentComp.phase === "registration" && (
                        <div className={styles.advanceHint}>
                          Yêu cầu để chuyển sang <code>preparation</code>: Cần ít nhất 2 người tham gia được duyệt (hiện có: {acceptedEntries.length}) và không còn hồ sơ chờ duyệt (hiện còn: {pendingEntries.length}).
                        </div>
                      )}

                      {currentComp.phase === "preparation" && (
                        <div className={styles.advanceHint}>
                          Yêu cầu để chuyển sang <code>locked</code>: Tất cả người tham gia được duyệt phải nộp bot READY (hiện có: {readySubmittedEntries.length}/{acceptedEntries.length}).
                        </div>
                      )}

                      {currentComp.phase === "locked" && (
                        <div className={styles.advanceHint}>
                          Khởi chạy giải đấu: Hành động này sẽ tạo và khởi chạy một giải đấu tự động trong hệ thống với các bot đã khóa.
                        </div>
                      )}

                      {currentComp.phase === "running" && (
                        <div className={styles.advanceHint}>
                          Hoàn tất sự kiện: Chỉ hoàn tất khi toàn bộ các trận đấu của giải đã kết thúc.
                        </div>
                      )}

                      <div style={{ marginTop: "0.5rem" }}>
                        <Button
                          variant="primary"
                          disabled={
                            actionLoading ||
                            (currentComp.phase === "registration" && !canAdvanceToPreparation) ||
                            (currentComp.phase === "preparation" && !canAdvanceToLocked)
                          }
                          onClick={() => handleAdvance(nextPhase)}
                        >
                          {actionLoading ? "Đang xử lý..." : `Chuyển sang: ${PHASE_LABEL_MAP[nextPhase]}`}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Roster & Admission Review Table */}
                <div className={styles.actionBox}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
                    <h3>Danh sách người tham gia ({currentEntries.length})</h3>
                    <div style={{ fontSize: "0.75rem", fontFamily: "var(--ui-font-mono)", color: "var(--ui-text-muted)" }}>
                      Duyệt: {acceptedEntries.length} | Chờ: {pendingEntries.length} | Đã nộp bot: {readySubmittedEntries.length}
                    </div>
                  </div>

                  {currentEntries.length === 0 ? (
                    <div className={styles.emptyState}>Chưa có người chơi nào đăng ký tham gia.</div>
                  ) : (
                    <div className={styles.tableWrap}>
                      <table className={styles.dataTable}>
                        <thead>
                          <tr>
                            <th>Tài khoản</th>
                            <th>Trạng thái</th>
                            <th>Bot đã nộp</th>
                            {isAdmin && currentComp.phase === "registration" ? <th>Xét duyệt</th> : null}
                          </tr>
                        </thead>
                        <tbody>
                          {currentEntries.map((entry) => (
                            <tr key={entry.userId} data-testid={`entry-row-${entry.userId}`}>
                              <td>
                                <strong>{entry.username}</strong>
                                {entry.userId === userProfile?.user.id ? (
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
                              {isAdmin && currentComp.phase === "registration" ? (
                                <td>
                                  {entry.status === "pending" ? (
                                    <div className={styles.entryReviewActions}>
                                      <Button
                                        variant="secondary"
                                        disabled={actionLoading}
                                        onClick={() => handleReview(entry.userId, true)}
                                        aria-label={`Duyệt ${entry.username}`}
                                      >
                                        Duyệt
                                      </Button>
                                      <Button
                                        variant="quiet"
                                        disabled={actionLoading}
                                        onClick={() => handleReview(entry.userId, false)}
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
            ) : (
              <div className={styles.emptyState}>Chọn một sự kiện từ danh sách bên trái để xem chi tiết.</div>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
