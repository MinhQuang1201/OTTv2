import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { ReplayDocument } from "../../../../../packages/arena/src/contracts/index.d.mts";
import { validateReplayDocument } from "../../../../../packages/arena/src/contracts/index.mjs";
import { downloadReplayDocument } from "../replay/replayImport";
import { Badge, type BadgeStatus } from "../../shared/ui/Badge";
import { Button } from "../../shared/ui/Button";
import { Panel } from "../../shared/ui/Panel";
import { Spinner } from "../../shared/ui/Spinner";
import { TextField } from "../../shared/ui/TextField";
import { PixelSprite } from "../../shared/icons/PixelSprite";
import {
  ArenaApiGateway,
  ArenaApiError,
  type ArenaBot,
  type ArenaBotVersion,
  type ArenaLeaderboardRating,
  type ArenaMatchDetails,
  type ArenaMatchParticipant,
  type ArenaMatchStatus,
  type ArenaMatchSummary,
  type ArenaTournamentDetailsResponse,
  type ArenaUserProfile,
} from "./ArenaApiGateway";
import styles from "./arena.module.css";
import { BotSourceEditor, PracticeMatchPanel } from "./bots";

export type ArenaTab = "leaderboard" | "bots" | "matches" | "tournaments";

export interface ArenaScreenProps {
  readonly gateway: ArenaApiGateway;
  readonly onLobby: () => void;
  readonly onStartReplay?: (document: ReplayDocument) => void;
}

interface ReadyBotVersionOption {
  readonly versionId: string;
  readonly botId: string;
  readonly botName: string;
  readonly versionNo: number;
  readonly profileId: string;
}

export function ArenaScreen({ gateway, onLobby, onStartReplay }: ArenaScreenProps) {
  const [activeTab, setActiveTab] = useState<ArenaTab>("leaderboard");
  const [userProfile, setUserProfile] = useState<ArenaUserProfile | null>(null);
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  // Data states
  const [leaderboard, setLeaderboard] = useState<readonly ArenaLeaderboardRating[]>([]);
  const [bots, setBots] = useState<readonly ArenaBot[]>([]);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [botVersions, setBotVersions] = useState<readonly ArenaBotVersion[]>([]);
  const [matches, setMatches] = useState<readonly (ArenaMatchSummary | ArenaMatchDetails)[]>([]);
  const [matchDetailsMap, setMatchDetailsMap] = useState<Record<string, ArenaMatchDetails>>({});
  const [matchKindFilter, setMatchKindFilter] = useState<string>("");
  const [matchStatusFilter, setMatchStatusFilter] = useState<string>("");
  const [tournamentId, setTournamentId] = useState("tourn-main");
  const [tournamentDetails, setTournamentDetails] = useState<ArenaTournamentDetailsResponse | null>(null);
  const [readyVersionsForTourney, setReadyVersionsForTourney] = useState<readonly ReadyBotVersionOption[]>([]);
  const [selectedTournamentVersions, setSelectedTournamentVersions] = useState<readonly string[]>([]);

  // Forms
  const [newBotName, setNewBotName] = useState("");
  const [newSourceCode, setNewSourceCode] = useState("");
  const [newProfileId, setNewProfileId] = useState("controlled-node");
  const [newTournName, setNewTournName] = useState("");

  // Loading & error
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshIndex, setRefreshIndex] = useState(0);

  // Lifecycle & cancellation guards
  const isMountedRef = useRef(true);
  const screenGenerationRef = useRef(0);
  const pendingControllersRef = useRef(new Set<AbortController>());

  const abortAllPending = useCallback(() => {
    for (const controller of pendingControllersRef.current) {
      try {
        controller.abort();
      } catch {
        // Safe abort
      }
    }
    pendingControllersRef.current.clear();
  }, []);

  const handleLobby = useCallback(() => {
    screenGenerationRef.current += 1;
    abortAllPending();
    onLobby();
  }, [abortAllPending, onLobby]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      screenGenerationRef.current += 1;
      abortAllPending();
    };
  }, [abortAllPending]);

  // Load user profile on mount if token is already present
  useEffect(() => {
    if (gateway.isAuthenticated()) {
      const controller = new AbortController();
      pendingControllersRef.current.add(controller);
      const generation = screenGenerationRef.current;
      gateway
        .getMe({ signal: controller.signal })
        .then((profile) => {
          if (isMountedRef.current && generation === screenGenerationRef.current) {
            setUserProfile(profile);
          }
        })
        .catch(() => {
          if (isMountedRef.current && generation === screenGenerationRef.current) {
            gateway.setToken(null);
            setUserProfile(null);
          }
        })
        .finally(() => {
          pendingControllersRef.current.delete(controller);
        });
    }
  }, [gateway]);

  const loadTabData = useCallback(
    async (signal: AbortSignal, currentGeneration: number) => {
      setLoading(true);
      setError(null);
      try {
        if (activeTab === "leaderboard") {
          const res = await gateway.getLeaderboard("ladder-main", { signal });
          if (isMountedRef.current && currentGeneration === screenGenerationRef.current && !signal.aborted) {
            setLeaderboard(res.ratings);
          }
        } else if (activeTab === "bots") {
          const res = await gateway.listBots({ signal });
          if (isMountedRef.current && currentGeneration === screenGenerationRef.current && !signal.aborted) {
            setBots(res.bots);
            if (res.bots.length > 0 && !selectedBotId) {
              setSelectedBotId(res.bots[0].id);
            }
          }
        } else if (activeTab === "matches") {
          const res = await gateway.listMatches({
            kind: matchKindFilter || undefined,
            status: matchStatusFilter || undefined,
            signal,
          });
          if (isMountedRef.current && currentGeneration === screenGenerationRef.current && !signal.aborted) {
            setMatches(res.matches);
          }
        } else if (activeTab === "tournaments") {
          // 1. Load tournament details if ID supplied
          if (tournamentId) {
            try {
              const res = await gateway.getTournament(tournamentId, { signal });
              if (isMountedRef.current && currentGeneration === screenGenerationRef.current && !signal.aborted) {
                setTournamentDetails(res);
              }
            } catch (err: unknown) {
              if ((err as ArenaApiError)?.code === "NOT_FOUND") {
                if (isMountedRef.current && currentGeneration === screenGenerationRef.current && !signal.aborted) {
                  setTournamentDetails(null);
                }
              } else {
                throw err;
              }
            }
          }
          // 2. Load ready bot versions for tournament entry selection
          try {
            const botsRes = await gateway.listBots({ signal });
            const readyOptions: ReadyBotVersionOption[] = [];
            for (const bot of botsRes.bots) {
              if (signal.aborted) break;
              try {
                const verRes = await gateway.listBotVersions(bot.id, { signal });
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
                // Ignore per-bot version load error
              }
            }
            if (isMountedRef.current && currentGeneration === screenGenerationRef.current && !signal.aborted) {
              setReadyVersionsForTourney(readyOptions);
            }
          } catch {
            // Ignore bots listing failure for tourney
          }
        }
      } catch (err: unknown) {
        if (signal.aborted || !isMountedRef.current || currentGeneration !== screenGenerationRef.current) return;
        const msg = (err as Error)?.message || "Không thể tải dữ liệu.";
        setError(msg);
      } finally {
        if (isMountedRef.current && currentGeneration === screenGenerationRef.current && !signal.aborted) {
          setLoading(false);
        }
      }
    },
    [activeTab, gateway, selectedBotId, matchKindFilter, matchStatusFilter, tournamentId]
  );

  // Load versions when selectedBotId changes
  useEffect(() => {
    if (activeTab === "bots" && selectedBotId) {
      const controller = new AbortController();
      pendingControllersRef.current.add(controller);
      const generation = screenGenerationRef.current;
      gateway
        .listBotVersions(selectedBotId, { signal: controller.signal })
        .then((res) => {
          if (isMountedRef.current && generation === screenGenerationRef.current && !controller.signal.aborted) {
            setBotVersions(res.versions);
          }
        })
        .catch((err) => {
          if (isMountedRef.current && generation === screenGenerationRef.current && !controller.signal.aborted && err?.code !== "abort_error") {
            setBotVersions([]);
          }
        })
        .finally(() => {
          pendingControllersRef.current.delete(controller);
        });
      return () => {
        controller.abort();
        pendingControllersRef.current.delete(controller);
      };
    }
  }, [activeTab, selectedBotId, gateway]);

  // Main tab data loading effect with cancellation
  useEffect(() => {
    const controller = new AbortController();
    pendingControllersRef.current.add(controller);
    const generation = screenGenerationRef.current;

    void loadTabData(controller.signal, generation).finally(() => {
      pendingControllersRef.current.delete(controller);
    });

    return () => {
      controller.abort();
      pendingControllersRef.current.delete(controller);
    };
  }, [loadTabData, refreshIndex]);

  const handleRefresh = () => {
    setRefreshIndex((prev) => prev + 1);
  };

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    if (!loginUsername.trim() || !loginPassword) return;
    setIsLoggingIn(true);
    setLoginError(null);
    const controller = new AbortController();
    pendingControllersRef.current.add(controller);
    const generation = screenGenerationRef.current;
    try {
      await gateway.login(
        {
          username: loginUsername.trim(),
          password: loginPassword,
        },
        { signal: controller.signal }
      );
      if (!isMountedRef.current || generation !== screenGenerationRef.current) {
        gateway.setToken(null);
        return;
      }
      const me = await gateway.getMe({ signal: controller.signal });
      if (!isMountedRef.current || generation !== screenGenerationRef.current) {
        gateway.setToken(null);
        return;
      }
      setUserProfile(me);
      setLoginPassword("");
      handleRefresh();
    } catch (err: unknown) {
      if (!isMountedRef.current || generation !== screenGenerationRef.current) return;
      const msg = (err as Error)?.message || "Đăng nhập thất bại.";
      setLoginError(msg);
    } finally {
      pendingControllersRef.current.delete(controller);
      if (isMountedRef.current && generation === screenGenerationRef.current) {
        setIsLoggingIn(false);
      }
    }
  };

  const handleLogout = async () => {
    const controller = new AbortController();
    pendingControllersRef.current.add(controller);
    const generation = screenGenerationRef.current;
    try {
      await gateway.logout({ signal: controller.signal });
    } catch {
      // Token cleared regardless
    } finally {
      pendingControllersRef.current.delete(controller);
      if (isMountedRef.current && generation === screenGenerationRef.current) {
        setUserProfile(null);
        handleRefresh();
      }
    }
  };

  const handleCreateBot = async (e: FormEvent) => {
    e.preventDefault();
    if (!newBotName.trim()) return;
    const controller = new AbortController();
    pendingControllersRef.current.add(controller);
    const generation = screenGenerationRef.current;
    try {
      const bot = await gateway.createBot({ name: newBotName.trim() }, { signal: controller.signal });
      if (!isMountedRef.current || generation !== screenGenerationRef.current) return;
      setNewBotName("");
      setSelectedBotId(bot.id);
      handleRefresh();
    } catch (err: unknown) {
      if (!isMountedRef.current || generation !== screenGenerationRef.current) return;
      setError((err as Error)?.message || "Không thể tạo bot.");
    } finally {
      pendingControllersRef.current.delete(controller);
    }
  };

  const handleUploadVersion = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedBotId || !newSourceCode.trim()) return;
    const controller = new AbortController();
    pendingControllersRef.current.add(controller);
    const generation = screenGenerationRef.current;
    try {
      await gateway.uploadBotVersion(
        selectedBotId,
        {
          source: newSourceCode,
          profileId: newProfileId,
        },
        { signal: controller.signal }
      );
      if (!isMountedRef.current || generation !== screenGenerationRef.current) return;
      setNewSourceCode("");
      handleRefresh();
    } catch (err: unknown) {
      if (!isMountedRef.current || generation !== screenGenerationRef.current) return;
      setError((err as Error)?.message || "Không thể nộp phiên bản.");
    } finally {
      pendingControllersRef.current.delete(controller);
    }
  };

  const handleCreateTournament = async (e: FormEvent) => {
    e.preventDefault();
    if (!newTournName.trim() || selectedTournamentVersions.length < 2) return;
    const entries = selectedTournamentVersions.map((verId) => ({ botVersionId: verId }));
    const controller = new AbortController();
    pendingControllersRef.current.add(controller);
    const generation = screenGenerationRef.current;
    try {
      const res = await gateway.createTournament(
        {
          name: newTournName.trim(),
          entries,
        },
        { signal: controller.signal }
      );
      if (!isMountedRef.current || generation !== screenGenerationRef.current) return;
      setNewTournName("");
      setSelectedTournamentVersions([]);
      setTournamentId(res.tournament.id);
      handleRefresh();
    } catch (err: unknown) {
      if (!isMountedRef.current || generation !== screenGenerationRef.current) return;
      setError((err as Error)?.message || "Không thể tạo giải đấu.");
    } finally {
      pendingControllersRef.current.delete(controller);
    }
  };

  const handleLoadMatchDetails = async (matchId: string) => {
    if (matchDetailsMap[matchId]) return;
    const controller = new AbortController();
    pendingControllersRef.current.add(controller);
    const generation = screenGenerationRef.current;
    try {
      const details = await gateway.getMatch(matchId, { signal: controller.signal });
      if (isMountedRef.current && generation === screenGenerationRef.current) {
        setMatchDetailsMap((prev) => ({ ...prev, [matchId]: details }));
      }
    } catch {
      // Ignore details load error
    } finally {
      pendingControllersRef.current.delete(controller);
    }
  };

  const handleViewReplay = async (matchId: string) => {
    const controller = new AbortController();
    pendingControllersRef.current.add(controller);
    const generation = screenGenerationRef.current;
    try {
      const res = await gateway.getMatchReplay(matchId, { signal: controller.signal });
      if (!isMountedRef.current || generation !== screenGenerationRef.current || controller.signal.aborted) {
        return;
      }
      const validation = validateReplayDocument(res?.replay);
      if (!validation.ok) {
        const errorMsg = `Dữ liệu replay không hợp lệ: ${validation.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`;
        setError(errorMsg);
        return;
      }
      if (onStartReplay) {
        onStartReplay(res.replay);
      }
    } catch (err: unknown) {
      if (!isMountedRef.current || generation !== screenGenerationRef.current || controller.signal.aborted) {
        return;
      }
      setError((err as Error)?.message || "Không thể tải replay của trận đấu.");
    } finally {
      pendingControllersRef.current.delete(controller);
    }
  };

  const handleDownloadReplay = async (matchId: string) => {
    const controller = new AbortController();
    pendingControllersRef.current.add(controller);
    const generation = screenGenerationRef.current;
    try {
      const res = await gateway.getMatchReplay(matchId, { signal: controller.signal });
      if (!isMountedRef.current || generation !== screenGenerationRef.current || controller.signal.aborted) {
        return;
      }
      const validation = validateReplayDocument(res?.replay);
      if (!validation.ok) {
        const errorMsg = `Dữ liệu replay không hợp lệ: ${validation.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`;
        setError(errorMsg);
        return;
      }
      downloadReplayDocument(res.replay, `match-${matchId}-replay.json`);
    } catch (err: unknown) {
      if (!isMountedRef.current || generation !== screenGenerationRef.current || controller.signal.aborted) {
        return;
      }
      setError((err as Error)?.message || "Không thể tải tập tin replay.");
    } finally {
      pendingControllersRef.current.delete(controller);
    }
  };

  const renderStatusBadge = (status: string) => {
    let badgeStatus: BadgeStatus = "neutral";
    if (status === "ready" || status === "completed" || status === "active" && activeTab === "bots") {
      badgeStatus = "success";
    } else if (status === "building" || status === "active") {
      badgeStatus = "info";
    } else if (status === "pending") {
      badgeStatus = "warning";
    } else if (status === "failed" || status === "cancelled" || status === "error") {
      badgeStatus = "danger";
    }
    return <Badge status={badgeStatus}>{status}</Badge>;
  };

  const renderParticipants = (participants?: Record<string, ArenaMatchParticipant> | readonly ArenaMatchParticipant[]) => {
    if (!participants) return null;
    let seatA: ArenaMatchParticipant | undefined;
    let seatB: ArenaMatchParticipant | undefined;
    if (Array.isArray(participants)) {
      const list = participants as readonly ArenaMatchParticipant[];
      seatA = list.find((p) => p.seat === "A");
      seatB = list.find((p) => p.seat === "B");
    } else {
      const record = participants as Record<string, ArenaMatchParticipant>;
      seatA = record["A"];
      seatB = record["B"];
    }
    const nameA = seatA ? `${seatA.botId || seatA.bot_id || "Bot"} (v${seatA.botVersionId || seatA.bot_version_id || "?"})` : "N/A";
    const nameB = seatB ? `${seatB.botId || seatB.bot_id || "Bot"} (v${seatB.botVersionId || seatB.bot_version_id || "?"})` : "N/A";
    return (
      <div className={styles.matchParticipants}>
        <span className={styles.seatTagA}>Seat A: <strong>{nameA}</strong></span> <span className={styles.vsTag}>vs</span> <span className={styles.seatTagB}>Seat B: <strong>{nameB}</strong></span>
      </div>
    );
  };

  const renderMatchResult = (match: ArenaMatchSummary | ArenaMatchDetails) => {
    const details = matchDetailsMap[match.id] || (("result" in match) ? (match as ArenaMatchDetails) : null);
    const result = details?.result;
    if (!result) return null;

    return (
      <div className={styles.matchResultInfo} data-testid={`match-result-${match.id}`}>
        {result.outcome === "win" && (
          <span>
            Thắng: <strong>Seat {result.winner}</strong> (Lý do: <code>{result.reason}</code>, {result.acceptedPlies} plies)
          </span>
        )}
        {result.outcome === "draw" && (
          <span>
            Hòa (Lý do: <code>{result.reason}</code>, {result.acceptedPlies} plies)
          </span>
        )}
        {result.outcome === "forfeit" && (
          <span>
            Xử thua: Thắng: <strong>Seat {result.winner}</strong>, Thua: <strong>Seat {result.loser}</strong> (Lý do: <code>{result.reason}</code>, {result.acceptedPlies} plies)
          </span>
        )}
      </div>
    );
  };

  return (
    <div className={styles.arenaContainer}>
      <header className={styles.topBar}>
        <div className={styles.topBarLeft}>
          <Button variant="quiet" onClick={handleLobby}>
            Về sảnh
          </Button>
          <div className={styles.titleGroup}>
            <span className={styles.kicker}>ARENA · GIẢI ĐẤU BOT</span>
            <h1 className={styles.title}>Đấu trường AI</h1>
          </div>
          <Button variant="secondary" onClick={handleRefresh}>
            Làm mới
          </Button>
        </div>
        <div className={styles.topBarRight}>
          {userProfile ? (
            <div className={styles.userInfo}>
              <PixelSprite kind="bot" size={16} decorative />
              <span>
                Xin chào, <strong>{userProfile.user.username}</strong>
              </span>
              <Badge status={userProfile.user.role === "admin" ? "warning" : "info"}>
                {userProfile.user.role}
              </Badge>
              <span className={styles.permissionBadge}>
                Nộp code: {userProfile.canSubmitSource ? "Được phép" : "Khóa"}
              </span>
              <Button variant="quiet" onClick={handleLogout}>
                Đăng xuất
              </Button>
            </div>
          ) : (
            <form className={styles.inlineLoginForm} onSubmit={handleLogin}>
              <TextField
                label="Tên đăng nhập"
                value={loginUsername}
                onChange={(e) => setLoginUsername(e.currentTarget.value)}
                placeholder="username"
                disabled={isLoggingIn}
              />
              <TextField
                label="Mật khẩu"
                type="password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.currentTarget.value)}
                placeholder="password"
                disabled={isLoggingIn}
              />
              <Button type="submit" variant="primary" disabled={isLoggingIn}>
                {isLoggingIn ? "Đang xử lý..." : "Đăng nhập"}
              </Button>
              {loginError && <span className={styles.errorBanner}>{loginError}</span>}
            </form>
          )}
        </div>
      </header>

      <nav className={styles.tabsNav} role="tablist">
        <button
          role="tab"
          aria-selected={activeTab === "leaderboard"}
          className={[styles.tabBtn, activeTab === "leaderboard" ? styles.tabBtnActive : ""].join(" ")}
          onClick={() => setActiveTab("leaderboard")}
        >
          <PixelSprite kind="trophy" size={14} decorative />
          <span>Bảng xếp hạng</span>
        </button>
        <button
          role="tab"
          aria-selected={activeTab === "bots"}
          className={[styles.tabBtn, activeTab === "bots" ? styles.tabBtnActive : ""].join(" ")}
          onClick={() => setActiveTab("bots")}
        >
          <PixelSprite kind="bot" size={14} decorative />
          <span>Quản lý Bot</span>
        </button>
        <button
          role="tab"
          aria-selected={activeTab === "matches"}
          className={[styles.tabBtn, activeTab === "matches" ? styles.tabBtnActive : ""].join(" ")}
          onClick={() => setActiveTab("matches")}
        >
          <PixelSprite kind="flag" size={14} decorative />
          <span>Trận đấu</span>
        </button>
        <button
          role="tab"
          aria-selected={activeTab === "tournaments"}
          className={[styles.tabBtn, activeTab === "tournaments" ? styles.tabBtnActive : ""].join(" ")}
          onClick={() => setActiveTab("tournaments")}
        >
          <PixelSprite kind="dam" size={14} decorative />
          <span>Giải đấu</span>
        </button>
      </nav>

      {error && (
        <div className={styles.errorBanner} role="alert">
          <span>{error}</span>
          <Button variant="secondary" onClick={handleRefresh}>
            Thử lại
          </Button>
        </div>
      )}

      {loading ? (
        <Panel>
          <Spinner label="Đang tải dữ liệu..." />
        </Panel>
      ) : (
        <main className={styles.tabContent}>
          {activeTab === "leaderboard" && (
            <Panel heading="Bảng xếp hạng Elo (ladder-main)">
              {leaderboard.length === 0 ? (
                <div className={styles.emptyState}>Chưa có dữ liệu bảng xếp hạng.</div>
              ) : (
                <div className={styles.tableWrap}>
                  <table className={styles.dataTable}>
                    <thead>
                      <tr>
                        <th>Hạng</th>
                        <th>Tên Bot</th>
                        <th>Bot ID</th>
                        <th>Rating</th>
                        <th>Số trận</th>
                        <th>Thắng</th>
                        <th>Hòa</th>
                        <th>Thua</th>
                      </tr>
                    </thead>
                    <tbody>
                      {leaderboard.map((r) => (
                        <tr key={r.botId}>
                          <td className={styles.rankCell}>#{r.rank}</td>
                          <td>
                            <strong>{r.botName}</strong>
                          </td>
                          <td><code>{r.botId}</code></td>
                          <td className={styles.ratingCell}>{r.rating}</td>
                          <td>{r.ratedGames}</td>
                          <td className={styles.winCell}>{r.wins}</td>
                          <td className={styles.drawCell}>{r.draws}</td>
                          <td className={styles.lossCell}>{r.losses}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          )}

          {activeTab === "bots" && (
            <div className={styles.gridTwoCols}>
              <Panel heading="Danh sách Bot">
                {userProfile && (
                  <form className={styles.formBox} onSubmit={handleCreateBot}>
                    <TextField
                      label="Tên Bot mới"
                      value={newBotName}
                      onChange={(e) => setNewBotName(e.currentTarget.value)}
                      placeholder="Nhập tên bot"
                    />
                    <Button type="submit" variant="primary">
                      Tạo Bot
                    </Button>
                  </form>
                )}
                {bots.length === 0 ? (
                  <div className={styles.emptyState}>Chưa có bot nào được đăng ký.</div>
                ) : (
                  <div className={styles.tableWrap}>
                    <table className={styles.dataTable}>
                      <thead>
                        <tr>
                          <th>Tên Bot</th>
                          <th>Trạng thái</th>
                          <th>Ngày tạo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bots.map((b) => (
                          <tr key={b.id}>
                            <td>
                              <button
                                type="button"
                                className={[
                                  styles.botSelectBtn,
                                  b.id === selectedBotId ? styles.botSelectBtnActive : "",
                                ].join(" ")}
                                onClick={() => setSelectedBotId(b.id)}
                                aria-label={`Chọn bot ${b.name}`}
                              >
                                <strong>{b.name}</strong>
                                <div><small><code>{b.id}</code></small></div>
                              </button>
                            </td>
                            <td>{renderStatusBadge(b.status)}</td>
                            <td><small>{new Date(b.createdAt).toLocaleDateString()}</small></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>

              <Panel heading={`Phiên bản của Bot: ${selectedBotId || "Chưa chọn"}`}>
                <div className={styles.formBox}>
                  <h3>Nộp phiên bản mới</h3>
                  {!userProfile?.canSubmitSource ? (
                    <div className={styles.infoBanner}>
                      Chế độ Trusted chỉ cho phép quản trị viên nộp mã nguồn bot (cho đến Task 19).
                    </div>
                  ) : null}
                  <form onSubmit={handleUploadVersion}>
                    <div style={{ marginBottom: "0.5rem" }}>
                      <label htmlFor="profile-select" style={{ display: "block", marginBottom: "0.25rem" }}>
                        Môi trường thực thi:
                      </label>
                      <select
                        id="profile-select"
                        className={styles.filterSelect}
                        value={newProfileId}
                        onChange={(e) => setNewProfileId(e.target.value)}
                        disabled={!userProfile?.canSubmitSource}
                      >
                        <option value="controlled-node">controlled-node (Node.js)</option>
                        <option value="python-v1">python-v1 (Python)</option>
                      </select>
                    </div>
                    <div style={{ marginBottom: "0.5rem" }}>
                      <BotSourceEditor
                        value={newSourceCode}
                        onChange={setNewSourceCode}
                        profileId={newProfileId}
                        disabled={!userProfile?.canSubmitSource}
                      />
                    </div>
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={!userProfile?.canSubmitSource || !newSourceCode.trim()}
                    >
                      Nộp phiên bản
                    </Button>
                  </form>
                </div>

                {userProfile && userProfile.user.role !== "spectator" && (
                  <PracticeMatchPanel
                    gateway={gateway}
                    userId={userProfile.user.id}
                    userRole={userProfile.user.role}
                    onCreated={() => {
                      setMatchKindFilter("practice");
                      setMatchStatusFilter("");
                      setActiveTab("matches");
                      setRefreshIndex((previous) => previous + 1);
                    }}
                  />
                )}

                {botVersions.length === 0 ? (
                  <div className={styles.emptyState}>Chưa có phiên bản nào cho bot này.</div>
                ) : (
                  <div>
                    <div className={styles.tableWrap}>
                      <table className={styles.dataTable}>
                        <thead>
                          <tr>
                            <th>Version</th>
                            <th>Profile</th>
                            <th>Build Status</th>
                            <th>Source Digest</th>
                          </tr>
                        </thead>
                        <tbody>
                          {botVersions.map((v) => (
                            <tr key={v.id}>
                              <td className={styles.versionCell}>v{v.versionNo}</td>
                              <td><code>{v.profileId}</code></td>
                              <td>{renderStatusBadge(v.buildStatus)}</td>
                              <td><code>{v.sourceDigest.slice(0, 14)}...</code></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {botVersions.some((v) => v.buildStatus === "failed") && (
                      <div className={styles.failedBuildDetails}>
                        {botVersions
                          .filter((v) => v.buildStatus === "failed")
                          .map((v) => (
                            <div key={v.id} style={{ marginTop: "0.5rem" }} data-testid={`build-log-${v.id}`}>
                              <strong>Nhật ký lỗi build (v{v.versionNo}):</strong>
                              <pre className={styles.boundedBuildLog}>{v.buildLog || "Không có thông tin log."}</pre>
                            </div>
                          ))}
                      </div>
                    )}
                  </div>
                )}
              </Panel>
            </div>
          )}

          {activeTab === "matches" && (
            <Panel heading="Lịch sử trận đấu Arena">
              <div className={styles.filterBar}>
                <div>
                  <label htmlFor="filter-kind" style={{ marginRight: "0.5rem" }}>Loại trận:</label>
                  <select
                    id="filter-kind"
                    className={styles.filterSelect}
                    value={matchKindFilter}
                    onChange={(e) => setMatchKindFilter(e.target.value)}
                  >
                    <option value="">Tất cả</option>
                    <option value="ranked">Ranked</option>
                    <option value="practice">Practice</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="filter-status" style={{ marginRight: "0.5rem" }}>Trạng thái:</label>
                  <select
                    id="filter-status"
                    className={styles.filterSelect}
                    value={matchStatusFilter}
                    onChange={(e) => setMatchStatusFilter(e.target.value)}
                  >
                    <option value="">Tất cả</option>
                    <option value="pending">pending (Chờ xử lý)</option>
                    <option value="active">active (Đang diễn ra)</option>
                    <option value="completed">completed (Hoàn thành)</option>
                    <option value="cancelled">cancelled (Đã hủy)</option>
                    <option value="error">error (Lỗi)</option>
                  </select>
                </div>
              </div>

              {matches.length === 0 ? (
                <div className={styles.emptyState}>Không tìm thấy trận đấu nào.</div>
              ) : (
                <div className={styles.matchList}>
                  {matches.map((m) => {
                    const details = matchDetailsMap[m.id] || (("participants" in m) ? (m as ArenaMatchDetails) : null);
                    return (
                      <div key={m.id} className={styles.matchCard}>
                        <div className={styles.matchHeader}>
                          <div>
                            <strong>{m.id}</strong>{" "}
                            <Badge status={m.kind === "ranked" ? "info" : "neutral"}>{m.kind}</Badge>{" "}
                            {renderStatusBadge(m.status)}
                          </div>
                          {renderParticipants(details?.participants)}
                          {renderMatchResult(m)}
                          <small style={{ color: "#aaa" }}>
                            Tạo lúc: {new Date(m.createdAt).toLocaleString()}
                          </small>
                        </div>
                        <div className={styles.matchActions}>
                          {!details && (
                            <Button variant="quiet" onClick={() => handleLoadMatchDetails(m.id)}>
                              Chi tiết
                            </Button>
                          )}
                          {m.status === "completed" && (
                            <>
                              <Button variant="primary" onClick={() => handleViewReplay(m.id)}>
                                Xem Replay
                              </Button>
                              <Button variant="secondary" onClick={() => handleDownloadReplay(m.id)}>
                                Tải Replay
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Panel>
          )}

          {activeTab === "tournaments" && (
            <div className={styles.gridTwoCols}>
              <Panel heading="Thông tin giải đấu">
                <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
                  <TextField
                    label="Mã giải đấu"
                    value={tournamentId}
                    onChange={(e) => setTournamentId(e.currentTarget.value)}
                  />
                  <div style={{ display: "flex", alignItems: "flex-end" }}>
                    <Button variant="secondary" onClick={handleRefresh}>
                      Xem giải đấu
                    </Button>
                  </div>
                </div>

                {tournamentDetails ? (
                  <div>
                    <h3>{tournamentDetails.tournament.name}</h3>
                    <p>
                      Trạng thái: {renderStatusBadge(tournamentDetails.tournament.status)} | Điểm:{" "}
                      {tournamentDetails.tournament.pointScheme}
                    </p>
                    <h4>Bảng điểm</h4>
                    {tournamentDetails.standings.length === 0 ? (
                      <div className={styles.emptyState}>Chưa có trận đấu nào được tính điểm.</div>
                    ) : (
                      <div className={styles.tableWrap}>
                        <table className={styles.dataTable}>
                          <thead>
                            <tr>
                              <th>Hạng</th>
                              <th>Bot ID</th>
                              <th>Điểm</th>
                              <th>Trận</th>
                              <th>Thắng</th>
                              <th>Hòa</th>
                              <th>Thua</th>
                            </tr>
                          </thead>
                          <tbody>
                            {tournamentDetails.standings.map((s, idx) => (
                              <tr key={s.botId}>
                                <td className={styles.rankCell}>#{s.rank ?? idx + 1}</td>
                                <td><code>{s.botId}</code></td>
                                <td className={styles.pointsCell}><strong>{s.points}</strong></td>
                                <td>{s.matchesPlayed}</td>
                                <td className={styles.winCell}>{s.wins}</td>
                                <td className={styles.drawCell}>{s.draws}</td>
                                <td className={styles.lossCell}>{s.losses}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className={styles.emptyState}>Không tìm thấy thông tin giải đấu.</div>
                )}
              </Panel>

              {userProfile?.user.role === "admin" && (
                <Panel heading="Tạo giải đấu mới (Admin)">
                  <form className={styles.formBox} onSubmit={handleCreateTournament}>
                    <TextField
                      label="Tên giải đấu"
                      value={newTournName}
                      onChange={(e) => setNewTournName(e.currentTarget.value)}
                      placeholder="VD: Spring Championship 2026"
                    />

                    <div>
                      <label style={{ display: "block", marginBottom: "0.25rem", fontWeight: 600 }}>
                        Chọn bot versions READY tham gia (ít nhất 2):
                      </label>
                      <div className={styles.versionChecklist} data-testid="tournament-ready-versions">
                        {readyVersionsForTourney.length === 0 ? (
                          <div className={styles.emptyState}>Không có phiên bản bot READY nào.</div>
                        ) : (
                          readyVersionsForTourney.map((v) => (
                            <label key={v.versionId} className={styles.checkboxLabel}>
                              <input
                                type="checkbox"
                                checked={selectedTournamentVersions.includes(v.versionId)}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setSelectedTournamentVersions((prev) => [...prev, v.versionId]);
                                  } else {
                                    setSelectedTournamentVersions((prev) =>
                                      prev.filter((id) => id !== v.versionId)
                                    );
                                  }
                                }}
                              />
                              <span>
                                <strong>{v.botName}</strong> (v{v.versionNo} - <code>{v.versionId}</code> [{v.profileId}])
                              </span>
                            </label>
                          ))
                        )}
                      </div>
                    </div>

                    <Button
                      type="submit"
                      variant="primary"
                      disabled={selectedTournamentVersions.length < 2 || !newTournName.trim()}
                    >
                      Tạo giải đấu ({selectedTournamentVersions.length} bots đã chọn)
                    </Button>
                  </form>
                </Panel>
              )}
            </div>
          )}
        </main>
      )}
    </div>
  );
}
