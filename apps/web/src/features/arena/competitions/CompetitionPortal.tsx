import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Badge, type BadgeStatus } from "../../../shared/ui/Badge";
import { Button } from "../../../shared/ui/Button";
import { Panel } from "../../../shared/ui/Panel";
import { Spinner } from "../../../shared/ui/Spinner";
import { TextField } from "../../../shared/ui/TextField";
import { PixelSprite } from "../../../shared/icons/PixelSprite";
import type { ArenaApiGateway, ArenaUserProfile, ArenaBot } from "../ArenaApiGateway";
import type { ReplayDocument } from "../../../../../../packages/arena/src/contracts/index.d.mts";
import { CompetitionApiClient } from "./CompetitionApiClient";
import { CompetitionDetail } from "./CompetitionDetail";
import { CompetitionConfiguration } from "./CompetitionConfiguration";
import type {
  Competition,
  CompetitionCatalogResponse,
  CompetitionDetailResponse,
  CompetitionMode,
  CompetitionPhase,
  ReadyBotVersionOption,
} from "./types";
import styles from "./competitions.module.css";

export interface CompetitionPortalProps {
  readonly gateway: ArenaApiGateway;
  readonly userProfile: ArenaUserProfile | null;
  readonly onNavigateTournament?: (tournamentId: string) => void;
  readonly onStartReplay?: (replayDoc: ReplayDocument) => void;
  readonly client?: CompetitionApiClient;
}

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
  onStartReplay,
  client: injectedClient,
}: CompetitionPortalProps) {
  const clientRef = useRef<CompetitionApiClient>(injectedClient ?? new CompetitionApiClient(gateway));
  useEffect(() => {
    clientRef.current = injectedClient ?? new CompetitionApiClient(gateway);
  }, [injectedClient, gateway]);

  const [competitions, setCompetitions] = useState<readonly Competition[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CompetitionDetailResponse | null>(null);
  const [readyBots, setReadyBots] = useState<readonly ReadyBotVersionOption[]>([]);
  const [selectedBotVersionId, setSelectedBotVersionId] = useState<string>("");
  const [loadingReadyBots, setLoadingReadyBots] = useState(false);
  const [botVersionsError, setBotVersionsError] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Filter state
  const [filterPhase, setFilterPhase] = useState<string>("ALL");

  // Create form state (admin)
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [createCapacity, setCreateCapacity] = useState("");
  const [createRanked, setCreateRanked] = useState(true);

  // Extended catalog & configuration state
  const [catalog, setCatalog] = useState<CompetitionCatalogResponse | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [createFormatId, setCreateFormatId] = useState("");
  const [createMapId, setCreateMapId] = useState("");
  const [createMode, setCreateMode] = useState<CompetitionMode>("ranked");
  const [createRoundCount, setCreateRoundCount] = useState<number | "">("");

  const createDescId = useId();

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const cat = await clientRef.current.getCatalog();
      if (isMountedRef.current) {
        setCatalog(cat);
        if (cat) {
          const defaultFormat = cat.defaults?.formatId || cat.formats[0]?.id || "";
          const defaultMap = cat.defaults?.mapId || cat.maps[0]?.id || "";
          const defaultMode = cat.defaults?.mode || (cat.modes[0]?.id as CompetitionMode) || "ranked";
          setCreateFormatId(defaultFormat);
          setCreateMapId(defaultMap);
          setCreateMode(defaultMode);
          setCreateRanked(defaultMode === "ranked");
        }
      }
    } catch (err: unknown) {
      if (isMountedRef.current) {
        setCatalog(null);
        setCatalogError((err as Error)?.message || "Không thể tải danh mục cấu hình giải đấu từ máy chủ.");
      }
    } finally {
      if (isMountedRef.current) {
        setCatalogLoading(false);
      }
    }
  }, []);

  // Load catalog on mount
  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  // Async tracking and race-condition prevention
  const isMountedRef = useRef(true);
  const detailReqSeqRef = useRef(0);
  const detailAbortControllerRef = useRef<AbortController | null>(null);
  const listAbortControllerRef = useRef<AbortController | null>(null);
  const botAbortControllerRef = useRef<AbortController | null>(null);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      detailAbortControllerRef.current?.abort();
      listAbortControllerRef.current?.abort();
      botAbortControllerRef.current?.abort();
    };
  }, []);

  // Reset state when identity or gateway changes
  const prevUserIdRef = useRef<string | undefined>(userProfile?.user.id);
  const prevGatewayRef = useRef<ArenaApiGateway>(gateway);
  useEffect(() => {
    if (prevUserIdRef.current !== userProfile?.user.id || prevGatewayRef.current !== gateway) {
      prevUserIdRef.current = userProfile?.user.id;
      prevGatewayRef.current = gateway;
      detailAbortControllerRef.current?.abort();
      botAbortControllerRef.current?.abort();
      setDetail(null);
      setReadyBots([]);
      setSelectedBotVersionId("");
      setError(null);
      setSuccessMsg(null);
      setBotVersionsError(null);
    }
  }, [userProfile?.user.id, gateway]);

  const loadCompetitions = useCallback(async () => {
    listAbortControllerRef.current?.abort();
    const controller = new AbortController();
    listAbortControllerRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const list = await clientRef.current.listCompetitions({ signal: controller.signal });
      if (isMountedRef.current && !controller.signal.aborted) {
        setCompetitions(list);
        setSelectedId((prev) => prev || (list.length > 0 ? list[0].id : null));
      }
    } catch (err: unknown) {
      if (isMountedRef.current && !controller.signal.aborted) {
        setError((err as Error)?.message || "Không thể tải danh sách sự kiện.");
      }
    } finally {
      if (isMountedRef.current && !controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    detailAbortControllerRef.current?.abort();
    const controller = new AbortController();
    detailAbortControllerRef.current = controller;
    const reqSeq = ++detailReqSeqRef.current;

    setDetailLoading(true);
    setError(null);
    try {
      const res = await clientRef.current.getCompetition(id, { signal: controller.signal });
      if (isMountedRef.current && reqSeq === detailReqSeqRef.current && !controller.signal.aborted) {
        setDetail(res);
      }
    } catch (err: unknown) {
      if (isMountedRef.current && reqSeq === detailReqSeqRef.current && !controller.signal.aborted) {
        setError((err as Error)?.message || "Không thể tải chi tiết sự kiện.");
      }
    } finally {
      if (isMountedRef.current && reqSeq === detailReqSeqRef.current && !controller.signal.aborted) {
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
      botAbortControllerRef.current?.abort();
      const controller = new AbortController();
      botAbortControllerRef.current = controller;

      setLoadingReadyBots(true);
      setBotVersionsError(null);

      const userId = userProfile.user.id;

      // Paged bot fetch helper to avoid hiding bots beyond page 1 and filter opponents' bots
      const fetchOwnedReadyVersions = async () => {
        const ownedActiveBots: ArenaBot[] = [];
        let offset = 0;
        const limit = 50;
        let total = Number.POSITIVE_INFINITY;
        let botFetchError = false;

        while (offset < total && offset < 500) {
          if (controller.signal.aborted) return;
          try {
            const botsRes = await gateway.listBots({ limit, offset, signal: controller.signal });
            total = typeof botsRes.total === "number" ? botsRes.total : botsRes.bots.length;
            for (const bot of botsRes.bots) {
              const isActive = bot.status === "active" || (bot.status as string) === "ACTIVE";
              if (bot.ownerId === userId && isActive) {
                ownedActiveBots.push(bot);
              }
            }
            if (botsRes.bots.length === 0 || offset + botsRes.bots.length >= total) {
              break;
            }
            offset += botsRes.bots.length;
          } catch (err: unknown) {
            if ((err as Error)?.name === "AbortError" || controller.signal.aborted) return;
            botFetchError = true;
            break;
          }
        }

        const readyOptions: ReadyBotVersionOption[] = [];
        let versionErrors = 0;

        for (const bot of ownedActiveBots) {
          if (controller.signal.aborted) return;
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
          } catch (err: unknown) {
            if ((err as Error)?.name === "AbortError" || controller.signal.aborted) return;
            versionErrors++;
          }
        }

        if (isMountedRef.current && !controller.signal.aborted) {
          setReadyBots(readyOptions);
          setSelectedBotVersionId((prev) => prev || (readyOptions.length > 0 ? readyOptions[0].versionId : ""));
          if (botFetchError) {
            setBotVersionsError("Không thể tải đầy đủ danh sách bot từ máy chủ.");
          } else if (versionErrors > 0 && readyOptions.length === 0) {
            setBotVersionsError(`Không thể tải phiên bản cho ${versionErrors} bot.`);
          }
        }
      };

      fetchOwnedReadyVersions().finally(() => {
        if (isMountedRef.current && !controller.signal.aborted) {
          setLoadingReadyBots(false);
        }
      });

      return () => {
        controller.abort();
      };
    } else {
      setReadyBots([]);
      setBotVersionsError(null);
    }
  }, [detail?.competition.phase, userProfile?.user.role, userProfile?.user.id, gateway]);

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

    let capNum: number | undefined;
    if (createCapacity.trim()) {
      capNum = Number.parseInt(createCapacity.trim(), 10);
      if (!Number.isInteger(capNum) || capNum < 2 || capNum > 128) {
        setError("Sức chứa giải đấu phải là số nguyên từ 2 đến 128 bot.");
        return;
      }
    }

    setActionLoading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const created = await clientRef.current.createCompetition({
        name: createName.trim(),
        description: createDesc.trim() || undefined,
        capacity: capNum,
        ranked: createRanked && createMode === "ranked",
        formatId: createFormatId,
        mapId: createMapId,
        roundCount: typeof createRoundCount === "number" ? createRoundCount : undefined,
        mode: createMode,
      });
      setCreateName("");
      setCreateDesc("");
      setCreateFormatId(catalog?.defaults?.formatId || catalog?.formats[0]?.id || "");
      setCreateMapId(catalog?.defaults?.mapId || catalog?.maps[0]?.id || "");
      setCreateMode(catalog?.defaults?.mode || (catalog?.modes[0]?.id as CompetitionMode) || "ranked");
      setCreateRoundCount("");
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

  const handleNextRound = async (expectedRound: number) => {
    if (!selectedId) return;
    setActionLoading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      await clientRef.current.nextRound(selectedId, expectedRound);
      setSuccessMsg(`Đã khởi chạy thành công Vòng ${expectedRound}.`);
      await loadDetail(selectedId);
    } catch (err: unknown) {
      setError((err as Error)?.message || `Không thể bắt đầu Vòng ${expectedRound}.`);
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

  const handleAdvance = async (expectedPhase: CompetitionPhase) => {
    if (!selectedId) return;
    setActionLoading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const updated = await clientRef.current.advancePhase(selectedId, expectedPhase);
      setSuccessMsg(`Đã chuyển giai đoạn sang "${updated.phase}".`);
      await loadDetail(selectedId);
      await loadCompetitions();
    } catch (err: unknown) {
      setError((err as Error)?.message || "Không thể chuyển giai đoạn sự kiện.");
    } finally {
      setActionLoading(false);
    }
  };

  const isAdmin = userProfile?.user.role === "admin";

  const filteredCompetitions = competitions.filter((comp) => {
    if (filterPhase === "ALL") return true;
    return comp.phase === filterPhase.toLowerCase();
  });

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

      {/* Admin Event Creation Modal/Panel */}
      {showCreateForm && isAdmin && (
        <Panel heading="Tạo sự kiện thi đấu mới (Admin)">
          <form className={styles.formBox} onSubmit={handleCreateSubmit} noValidate data-testid="create-competition-form">
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
              label="Số lượng tối đa (Capacity: 2 - 128)"
              type="number"
              value={createCapacity}
              onChange={(e) => setCreateCapacity(e.currentTarget.value)}
              placeholder="Để trống nếu không giới hạn"
              min="2"
              max="128"
              disabled={actionLoading}
            />

            {/* Extended Format, Map, Mode & Preview Configuration */}
            {catalogLoading && (
              <div className={styles.loadingBox} data-testid="catalog-loading">
                Đang tải danh mục cấu hình giải đấu từ máy chủ...
              </div>
            )}

            {catalogError && (
              <div
                className={styles.errorBanner}
                role="alert"
                data-testid="catalog-error-alert"
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}
              >
                <span>Không thể tải cấu hình giải đấu: {catalogError}</span>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void loadCatalog()}
                  disabled={catalogLoading}
                  data-testid="retry-catalog-btn"
                >
                  Thử lại
                </Button>
              </div>
            )}

            {catalog ? (
              <CompetitionConfiguration
                mode="edit"
                catalog={catalog}
                formatId={createFormatId}
                onFormatChange={setCreateFormatId}
                mapId={createMapId}
                onMapChange={setCreateMapId}
                competitionMode={createMode}
                onModeChange={(m) => {
                  setCreateMode(m);
                  setCreateRanked(m === "ranked");
                }}
                roundCount={createRoundCount}
                onRoundCountChange={setCreateRoundCount}
                disabled={actionLoading}
              />
            ) : null}

            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
              <Button
                type="submit"
                variant="primary"
                disabled={actionLoading || !createName.trim() || catalogLoading || !catalog}
                data-testid="submit-create-competition-btn"
              >
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
            <div style={{ marginBottom: "0.75rem", display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
              {["ALL", "REGISTRATION", "PREPARATION", "RUNNING", "COMPLETED"].map((p) => (
                <Button
                  key={p}
                  variant={filterPhase === p ? "primary" : "quiet"}
                  onClick={() => setFilterPhase(p)}
                >
                  {p}
                </Button>
              ))}
            </div>

            {filteredCompetitions.length === 0 ? (
              <div className={styles.emptyState}>Chưa có sự kiện thi đấu nào.</div>
            ) : (
              <div className={styles.listWrap} role="list" aria-label="Danh sách sự kiện">
                {filteredCompetitions.map((comp) => {
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
            ) : detail ? (
              <CompetitionDetail
                detail={detail}
                userProfile={userProfile}
                gateway={gateway}
                competitionClient={clientRef.current}
                actionLoading={actionLoading}
                readyBots={readyBots}
                loadingReadyBots={loadingReadyBots}
                botVersionsError={botVersionsError}
                selectedBotVersionId={selectedBotVersionId}
                onSelectBotVersionId={setSelectedBotVersionId}
                onRegister={handleRegister}
                onSubmitBot={handleSubmitBot}
                onReview={handleReview}
                onAdvance={handleAdvance}
                onNextRound={handleNextRound}
                onRefresh={handleRefresh}
                onNavigateTournament={onNavigateTournament}
                onStartReplay={onStartReplay}
                catalog={catalog ?? undefined}
              />
            ) : (
              <div className={styles.emptyState}>Chọn một sự kiện từ danh sách bên trái để xem chi tiết.</div>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
