import { useState, useEffect, useRef } from "react";
import { Button } from "../../shared/ui/Button";
import { TextField } from "../../shared/ui/TextField";
import { PixelSprite } from "../../shared/icons/PixelSprite";
import { TournamentStandingsTable } from "./TournamentStandingsTable";
import { TournamentMatchCard } from "./TournamentMatchCard";
import type { HumanTournamentSummary } from "./types";
import type { OnlineLobbyGateway } from "../../sessions/online/OnlineLobbyGateway";
import styles from "./tournaments.module.css";

export interface HumanTournamentDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly playerName?: string;
  readonly onlineAvailable?: boolean;
  readonly gateway?: OnlineLobbyGateway | null;
  readonly onJoinMatch: (aliasOrToken: string) => void;
  readonly tournament?: HumanTournamentSummary | null;
}

export function HumanTournamentDialog({
  isOpen,
  onClose,
  playerName = "",
  onlineAvailable = true,
  gateway = null,
  onJoinMatch,
  tournament: initialTournament = null,
}: HumanTournamentDialogProps) {
  const [activeTab, setActiveTab] = useState<"join" | "view" | "register" | "organize">("join");
  const [currentTournament, setCurrentTournament] = useState<HumanTournamentSummary | null>(initialTournament);
  const [isLoading, setIsLoading] = useState(false);
  const [generalMessage, setGeneralMessage] = useState<string | null>(null);
  const lifecycleGeneration = useRef(0);

  // Tab: Join
  const [inputCode, setInputCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);

  // Tab: View
  const [lookupTournId, setLookupTournId] = useState("");
  const [myParticipantId, setMyParticipantId] = useState("");
  const [myParticipantSecret, setMyParticipantSecret] = useState("");

  // Tab: Register
  const [regTournId, setRegTournId] = useState("");
  const [regPlayerName, setRegPlayerName] = useState(playerName);
  const [regResult, setRegResult] = useState<{ participantId: string; participantSecret: string; name: string } | null>(null);
  const [regError, setRegError] = useState<string | null>(null);

  // Tab: Organize - Create
  const [tournName, setTournName] = useState("");
  const [organizerName, setOrganizerName] = useState(playerName);
  const [formatId, setFormatId] = useState("swiss");
  const [createdInfo, setCreatedInfo] = useState<{ id: string; secret: string; name: string } | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  // Tab: Organize - Manage
  const [manageTournId, setManageTournId] = useState("");
  const [manageSecret, setManageSecret] = useState("");
  const [manageMessage, setManageMessage] = useState<string | null>(null);
  const [manageError, setManageError] = useState<string | null>(null);

  useEffect(() => {
    if (initialTournament) {
      setCurrentTournament(initialTournament);
      setLookupTournId(initialTournament.tournamentId);
    }
  }, [initialTournament]);

  useEffect(() => {
    lifecycleGeneration.current += 1;
    setIsLoading(false);
  }, [isOpen, gateway, initialTournament?.tournamentId]);

  useEffect(() => {
    if (playerName && !regPlayerName) {
      setRegPlayerName(playerName);
    }
    if (playerName && !organizerName) {
      setOrganizerName(playerName);
    }
  }, [playerName, regPlayerName, organizerName]);

  // Focus usually stays on the lobby button that opened the dialog, so listen on the document.
  useEffect(() => {
    if (!isOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleJoin = async () => {
    const trimmed = inputCode.trim();
    if (!trimmed) {
      setCodeError("Vui lòng nhập mã phòng (như K7N-M4P) hoặc mã lời mời (inv_...).");
      return;
    }
    setCodeError(null);

    // If user enters a tournament ID, switch to view tab and fetch details
    if (trimmed.startsWith("tourn-") && gateway) {
      const generation = lifecycleGeneration.current;
      setIsLoading(true);
      try {
        const details = await gateway.getTournamentDetails(trimmed);
        if (generation !== lifecycleGeneration.current) return;
        setCurrentTournament(details);
        setLookupTournId(trimmed);
        setActiveTab("view");
      } catch (err: any) {
        if (generation !== lifecycleGeneration.current) return;
        setCodeError(err.message || "Không thể tải dữ liệu giải đấu.");
      } finally {
        if (generation === lifecycleGeneration.current) setIsLoading(false);
      }
      return;
    }

    onJoinMatch(trimmed);
  };

  const handleFetchTournament = async (idToFetch: string) => {
    const id = idToFetch.trim();
    if (!id || !gateway) return;
    const generation = lifecycleGeneration.current;
    setIsLoading(true);
    setGeneralMessage(null);
    try {
      const details = await gateway.getTournamentDetails(id);
      if (generation !== lifecycleGeneration.current) return;
      setCurrentTournament(details);
      setLookupTournId(id);
    } catch (err: any) {
      if (generation !== lifecycleGeneration.current) return;
      setGeneralMessage(`Lỗi: ${err.message || "Không tìm thấy giải đấu."}`);
    } finally {
      if (generation === lifecycleGeneration.current) setIsLoading(false);
    }
  };

  const handleRegisterPlayer = async () => {
    const tid = regTournId.trim();
    const name = regPlayerName.trim();
    if (!tid || !name) {
      setRegError("Vui lòng nhập mã giải đấu và tên người chơi.");
      return;
    }
    if (!gateway) {
      setRegError("Kết nối online hiện không khả dụng.");
      return;
    }
    setIsLoading(true);
    setRegError(null);
    const generation = lifecycleGeneration.current;
    try {
      const result = await gateway.registerTournamentPlayer({ tournamentId: tid, name });
      if (generation !== lifecycleGeneration.current) return;
      setRegResult({
        participantId: result.participantId,
        participantSecret: result.participantSecret,
        name: result.name,
      });
      setMyParticipantId(result.participantId);
      setMyParticipantSecret(result.participantSecret);
      setLookupTournId(tid);
    } catch (err: any) {
      if (generation !== lifecycleGeneration.current) return;
      setRegError(err.message || "Không thể đăng ký tham gia giải đấu.");
    } finally {
      if (generation === lifecycleGeneration.current) setIsLoading(false);
    }
  };

  const handleCreateTournament = async () => {
    const name = tournName.trim();
    const orgName = organizerName.trim() || playerName.trim() || "Trọng tài";
    if (!name) {
      setCreateError("Vui lòng nhập tên giải đấu.");
      return;
    }
    if (!gateway) {
      setCreateError("Kết nối online hiện không khả dụng.");
      return;
    }
    setIsLoading(true);
    setCreateError(null);
    const generation = lifecycleGeneration.current;
    try {
      const created = await gateway.createTournament({
        name,
        organizerName: orgName,
        formatId,
      });
      if (generation !== lifecycleGeneration.current) return;
      setCreatedInfo({
        id: created.tournamentId,
        secret: created.organizerSecret,
        name: created.name,
      });
      setManageTournId(created.tournamentId);
      setManageSecret(created.organizerSecret);
      setLookupTournId(created.tournamentId);
    } catch (err: any) {
      if (generation !== lifecycleGeneration.current) return;
      setCreateError(err.message || "Không thể tạo giải đấu.");
    } finally {
      if (generation === lifecycleGeneration.current) setIsLoading(false);
    }
  };

  const handleStartTournament = async () => {
    const tid = manageTournId.trim();
    const sec = manageSecret.trim();
    if (!tid || !sec) {
      setManageError("Vui lòng nhập mã giải đấu và mã bí mật trọng tài.");
      return;
    }
    if (!gateway) {
      setManageError("Kết nối online hiện không khả dụng.");
      return;
    }
    setIsLoading(true);
    setManageError(null);
    setManageMessage(null);
    const generation = lifecycleGeneration.current;
    try {
      const result = await gateway.startTournament({ tournamentId: tid, organizerSecret: sec });
      if (generation !== lifecycleGeneration.current) return;
      setManageMessage(`Giải đấu đã bắt đầu! Đang ở vòng ${result.currentRoundNumber}/${result.roundCount}.`);
      await handleFetchTournament(tid);
    } catch (err: any) {
      if (generation !== lifecycleGeneration.current) return;
      setManageError(err.message || "Không thể bắt đầu giải đấu.");
    } finally {
      if (generation === lifecycleGeneration.current) setIsLoading(false);
    }
  };

  const handleAdvanceRound = async () => {
    const tid = manageTournId.trim();
    const sec = manageSecret.trim();
    if (!tid || !sec) {
      setManageError("Vui lòng nhập mã giải đấu và mã bí mật trọng tài.");
      return;
    }
    if (!gateway) {
      setManageError("Kết nối online hiện không khả dụng.");
      return;
    }
    setIsLoading(true);
    setManageError(null);
    setManageMessage(null);
    const generation = lifecycleGeneration.current;
    try {
      const result = await gateway.advanceTournamentRound({ tournamentId: tid, organizerSecret: sec });
      if (generation !== lifecycleGeneration.current) return;
      if (result.tournamentCompleted) {
        setManageMessage("Giải đấu đã hoàn thành tất cả các vòng đấu!");
      } else {
        setManageMessage(`Đã tiến sang vòng ${result.currentRoundNumber}/${result.roundCount}.`);
      }
      await handleFetchTournament(tid);
    } catch (err: any) {
      if (generation !== lifecycleGeneration.current) return;
      setManageError(err.message || "Chưa thể sang vòng mới: Các trận đấu chưa kết thúc trên máy chủ.");
    } finally {
      if (generation === lifecycleGeneration.current) setIsLoading(false);
    }
  };

  const handleAccessMatch = async (matchId: string) => {
    if (!currentTournament || !gateway) return;
    const currentRound = currentTournament.currentRoundMatches;
    const match = currentRound.find((m) => m.matchId === matchId);
    if (!match) return;

    // Check if we have registered participant secret
    const sec = myParticipantSecret.trim();
    if (!sec) {
      setGeneralMessage("Vui lòng nhập mã bí mật người chơi (Participant Secret) để lấy vé vào trận.");
      return;
    }

    // Determine participant ID
    const pid = myParticipantId.trim() || regResult?.participantId || currentTournament.standings.find((s) => s.name === playerName.trim())?.participantId;
    if (!pid) {
      setGeneralMessage("Vui lòng nhập mã người chơi (Participant ID) đã nhận khi đăng ký để vào đúng trận.");
      return;
    }

    setIsLoading(true);
    setGeneralMessage(null);
    const generation = lifecycleGeneration.current;
    try {
      const access = await gateway.getTournamentMatchAccess({
        tournamentId: currentTournament.tournamentId,
        matchId,
        participantId: pid,
        participantSecret: sec,
      });
      if (generation !== lifecycleGeneration.current) return;
      if (access.inviteToken) {
        onJoinMatch(access.inviteToken);
      }
    } catch (err: any) {
      if (generation !== lifecycleGeneration.current) return;
      setGeneralMessage(`Lỗi vào trận: ${err.message || "Mã bí mật người chơi không đúng hoặc không thuộc trận này."}`);
    } finally {
      if (generation === lifecycleGeneration.current) setIsLoading(false);
    }
  };

  const handleSyncMatch = async (matchId: string) => {
    if (!currentTournament || !gateway) return;
    setIsLoading(true);
    setGeneralMessage(null);
    const generation = lifecycleGeneration.current;
    try {
      const result = await gateway.syncTournamentMatch({
        tournamentId: currentTournament.tournamentId,
        matchId,
      });
      if (generation !== lifecycleGeneration.current) return;
      if (result.match.status === "completed") {
        try {
          const details = await gateway.getTournamentDetails(currentTournament.tournamentId);
          if (generation !== lifecycleGeneration.current) return;
          setCurrentTournament(details);
        } catch {
          // ignore reload error
        }
        setGeneralMessage(`Trận ${matchId} đã đồng bộ kết quả thành công từ máy chủ.`);
      } else {
        setGeneralMessage(`Trận ${matchId} vẫn đang diễn ra.`);
      }
    } catch (err: any) {
      if (generation !== lifecycleGeneration.current) return;
      setGeneralMessage(`Chưa thể đồng bộ: ${err.message || "Trận đấu chưa kết thúc trên máy chủ."}`);
    } finally {
      if (generation === lifecycleGeneration.current) setIsLoading(false);
    }
  };

  return (
    <div className={styles.dialogBackdrop} role="dialog" aria-modal="true" aria-labelledby="tournament-dialog-title">
      <div className={styles.dialogContainer}>
        <div className={styles.dialogHeader}>
          <h2 id="tournament-dialog-title" className={styles.dialogTitle}>
            <PixelSprite kind="trophy" size={18} decorative />
            <span>Giải đấu người chơi</span>
          </h2>
          <Button variant="quiet" onClick={onClose} aria-label="Đóng">✕</Button>
        </div>

        <div className={styles.tabBar} role="tablist">
          <button
            role="tab"
            aria-selected={activeTab === "join"}
            className={[styles.tabButton, activeTab === "join" ? styles.tabActive : ""].join(" ")}
            onClick={() => setActiveTab("join")}
          >
            Tham gia trận
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "view"}
            className={[styles.tabButton, activeTab === "view" ? styles.tabActive : ""].join(" ")}
            onClick={() => setActiveTab("view")}
          >
            Bảng xếp hạng
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "register"}
            className={[styles.tabButton, activeTab === "register" ? styles.tabActive : ""].join(" ")}
            onClick={() => setActiveTab("register")}
          >
            Đăng ký thi đấu
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "organize"}
            className={[styles.tabButton, activeTab === "organize" ? styles.tabActive : ""].join(" ")}
            onClick={() => setActiveTab("organize")}
          >
            Tổ chức & Điều hành
          </button>
        </div>

        <div className={styles.dialogBody}>
          {generalMessage && (
            <div role="status" style={{ padding: "8px 12px", background: "var(--ui-surface-2)", border: "1px solid var(--ui-line)", fontSize: "12px" }}>
              {generalMessage}
            </div>
          )}

          {activeTab === "join" && (
            <div className={styles.joinSection}>
              <p className={styles.helperText}>
                Dán mã bí danh phòng 6 ký tự (như K7N-M4P), mã lời mời bí mật của bạn (inv_...), hoặc mã giải đấu (tourn-...).
              </p>
              <TextField
                label="Mã lời mời hoặc bí danh phòng"
                value={inputCode}
                error={codeError ?? undefined}
                onChange={(e) => {
                  setInputCode(e.currentTarget.value);
                  if (codeError) setCodeError(null);
                }}
                placeholder="Ví dụ: K7N-M4P, inv_abc123 hoặc tourn-1234"
                autoComplete="off"
              />
              <Button
                variant="primary"
                disabled={!onlineAvailable || !inputCode.trim() || isLoading}
                onClick={handleJoin}
              >
                {isLoading ? "Đang xử lý…" : "Vào trận đấu"}
              </Button>
            </div>
          )}

          {activeTab === "view" && (
            <div className={styles.joinSection}>
              <div style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
                <div style={{ flex: 1 }}>
                  <TextField
                    label="Mã giải đấu cần xem"
                    value={lookupTournId}
                    onChange={(e) => setLookupTournId(e.currentTarget.value)}
                    placeholder="Ví dụ: tourn-a1b2c3d4"
                  />
                </div>
                <Button
                  variant="secondary"
                  disabled={!lookupTournId.trim() || isLoading}
                  onClick={() => handleFetchTournament(lookupTournId)}
                >
                  Tải dữ liệu
                </Button>
              </div>

              {currentTournament ? (
                <>
                  <div style={{ marginTop: "8px", padding: "10px", background: "var(--ui-surface-0)", border: "1px solid var(--ui-line)" }}>
                    <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 700 }}>
                      {currentTournament.name}
                    </h3>
                    <div style={{ display: "flex", gap: "16px", marginTop: "4px", fontSize: "12px", color: "var(--ui-text-muted)" }}>
                      <span>Trạng thái: <strong>{currentTournament.status === "registration" ? "Đang mở đăng ký" : currentTournament.status === "in_progress" ? "Đang thi đấu" : "Đã hoàn thành"}</strong></span>
                      <span>Thể thức: <strong>{currentTournament.formatId}</strong></span>
                      <span>Vòng: <strong>{currentTournament.currentRoundNumber}/{currentTournament.roundCount}</strong></span>
                      <span>Số người: <strong>{currentTournament.participantCount}</strong></span>
                    </div>
                  </div>

                  <h4 style={{ margin: "12px 0 4px", fontSize: "13px", fontWeight: 700 }}>Bảng xếp hạng</h4>
                  <TournamentStandingsTable standings={currentTournament.standings ?? []} />

                  <h4 style={{ margin: "12px 0 4px", fontSize: "13px", fontWeight: 700 }}>Các cặp đấu vòng hiện tại</h4>
                   <div style={{ marginBottom: "8px" }}>
                     <TextField
                       label="Mã người chơi của bạn"
                       value={myParticipantId}
                       onChange={(e) => setMyParticipantId(e.currentTarget.value)}
                       placeholder="p_... (đã nhận khi đăng ký)"
                       autoComplete="off"
                     />
                     <TextField
                      label="Mã bí mật người chơi của bạn (để vào phòng đấu chỉ định)"
                      value={myParticipantSecret}
                      onChange={(e) => setMyParticipantSecret(e.currentTarget.value)}
                      placeholder="p_sec_... (đã nhận khi đăng ký)"
                      autoComplete="off"
                    />
                  </div>

                  <div className={styles.matchList}>
                    {currentTournament.currentRoundMatches.length === 0 ? (
                      <p className={styles.helperText}>Chưa có trận đấu nào được xếp cặp.</p>
                    ) : (
                      currentTournament.currentRoundMatches.map((m) => (
                        <TournamentMatchCard
                          key={m.matchId}
                          match={m}
                          canJoin={onlineAvailable}
                          onJoin={onJoinMatch}
                          onAccessMatch={myParticipantSecret ? handleAccessMatch : undefined}
                          onSyncMatch={handleSyncMatch}
                        />
                      ))
                    )}
                  </div>
                </>
              ) : (
                <p className={styles.helperText}>Nhập mã giải đấu và bấm Tải dữ liệu để xem thông tin.</p>
              )}
            </div>
          )}

          {activeTab === "register" && (
            <div className={styles.joinSection}>
              <p className={styles.helperText}>
                Đăng ký tên của bạn vào danh sách thi đấu của giải. Bạn sẽ nhận được mã bí mật người chơi (Participant Secret) dùng để truy cập các trận đấu cá nhân.
              </p>
              <TextField
                label="Mã giải đấu"
                value={regTournId}
                onChange={(e) => setRegTournId(e.currentTarget.value)}
                placeholder="Ví dụ: tourn-a1b2c3d4"
              />
              <TextField
                label="Tên của bạn trong giải"
                value={regPlayerName}
                onChange={(e) => setRegPlayerName(e.currentTarget.value)}
                placeholder="Nhập tên người chơi"
              />
              {regError && <p style={{ color: "var(--ui-ruby, #ff4d4f)", fontSize: "12px", margin: 0 }}>{regError}</p>}
              <Button
                variant="primary"
                disabled={!regTournId.trim() || !regPlayerName.trim() || isLoading}
                onClick={handleRegisterPlayer}
              >
                {isLoading ? "Đang đăng ký…" : "Xác nhận đăng ký"}
              </Button>

              {regResult && (
                <div style={{ marginTop: "12px", padding: "10px", background: "var(--ui-surface-2)", border: "1px solid var(--ui-line)" }}>
                  <p style={{ margin: 0, fontWeight: 700, fontSize: "13px", color: "var(--ui-emerald, #52c41a)" }}>
                    Đăng ký thi đấu thành công!
                  </p>
                  <p style={{ margin: "4px 0", fontSize: "12px" }}>Người chơi: <strong>{regResult.name}</strong> (<code>{regResult.participantId}</code>)</p>
                  <p style={{ margin: "4px 0", fontSize: "12px", color: "var(--ui-amber, #faad14)" }}>
                    Mã bí mật của bạn (LƯU LẠI để vào các trận đấu): <code>{regResult.participantSecret}</code>
                  </p>
                  <Button
                    variant="secondary"
                    style={{ marginTop: "8px" }}
                    onClick={() => {
                      handleFetchTournament(regTournId);
                      setActiveTab("view");
                    }}
                  >
                    Xem lịch thi đấu giải này
                  </Button>
                </div>
              )}
            </div>
          )}

          {activeTab === "organize" && (
            <div className={styles.joinSection}>
              <h3 style={{ margin: 0, fontSize: "14px", fontWeight: 700 }}>1. Tạo giải đấu mới</h3>
              <p className={styles.helperText}>
                Hệ thống máy chủ sẽ cấp mã giải đấu và mã bí mật quản trị (Organizer Secret) dùng để khóa danh sách, ghép cặp và tiến vòng.
              </p>
              <TextField
                label="Tên giải đấu"
                value={tournName}
                onChange={(e) => setTournName(e.currentTarget.value)}
                placeholder="Ví dụ: Cúp Oẳn Tù Tì Mùa Thu"
              />
              <TextField
                label="Tên người tổ chức / trọng tài"
                value={organizerName}
                onChange={(e) => setOrganizerName(e.currentTarget.value)}
                placeholder="Nhập tên trọng tài"
              />
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px" }}>
                  Thể thức thi đấu
                </label>
                <select
                  value={formatId}
                  onChange={(e) => setFormatId(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px",
                    background: "var(--ui-surface-0)",
                    border: "1px solid var(--ui-line)",
                    fontFamily: "var(--ui-font-body)",
                  }}
                >
                  <option value="swiss">Hệ Thụy Sĩ (Swiss System)</option>
                  <option value="single-round-robin">Vòng tròn đơn (Single Round-Robin)</option>
                  <option value="double-round-robin">Vòng tròn kép (Double Round-Robin)</option>
                </select>
              </div>

              {createError && <p style={{ color: "var(--ui-ruby, #ff4d4f)", fontSize: "12px", margin: 0 }}>{createError}</p>}

              <Button
                variant="primary"
                disabled={!tournName.trim() || isLoading}
                onClick={handleCreateTournament}
              >
                {isLoading ? "Đang tạo giải…" : "Tạo giải đấu"}
              </Button>

              {createdInfo && (
                <div style={{ marginTop: "8px", padding: "10px", background: "var(--ui-surface-2)", border: "1px solid var(--ui-line)" }}>
                  <p style={{ margin: 0, fontWeight: 700, fontSize: "13px", color: "var(--ui-emerald, #52c41a)" }}>
                    Giải đấu đã tạo thành công trên máy chủ!
                  </p>
                  <p style={{ margin: "4px 0", fontSize: "12px" }}>Mã giải đấu: <code>{createdInfo.id}</code></p>
                  <p style={{ margin: "4px 0", fontSize: "12px", color: "var(--ui-amber, #faad14)" }}>
                    Mã bí mật trọng tài (LƯU LẠI để điều hành): <code>{createdInfo.secret}</code>
                  </p>
                </div>
              )}

              <hr style={{ margin: "16px 0 8px", borderColor: "var(--ui-line)" }} />

              <h3 style={{ margin: 0, fontSize: "14px", fontWeight: 700 }}>2. Điều hành giải đấu</h3>
              <p className={styles.helperText}>
                Nhập mã giải đấu và mã bí mật trọng tài để điều hành (bắt đầu giải hoặc chuyển sang vòng kế tiếp).
              </p>
              <TextField
                label="Mã giải đấu điều hành"
                value={manageTournId}
                onChange={(e) => setManageTournId(e.currentTarget.value)}
                placeholder="Ví dụ: tourn-a1b2c3d4"
              />
              <TextField
                label="Mã bí mật trọng tài (Organizer Secret)"
                value={manageSecret}
                onChange={(e) => setManageSecret(e.currentTarget.value)}
                placeholder="org_sec_..."
                autoComplete="off"
              />

              {manageError && <p style={{ color: "var(--ui-ruby, #ff4d4f)", fontSize: "12px", margin: 0 }}>{manageError}</p>}
              {manageMessage && <p style={{ color: "var(--ui-emerald, #52c41a)", fontSize: "12px", margin: 0 }}>{manageMessage}</p>}

              <div style={{ display: "flex", gap: "8px" }}>
                <Button
                  variant="primary"
                  disabled={!manageTournId.trim() || !manageSecret.trim() || isLoading}
                  onClick={handleStartTournament}
                >
                  Bắt đầu giải (Vòng 1)
                </Button>
                <Button
                  variant="secondary"
                  disabled={!manageTournId.trim() || !manageSecret.trim() || isLoading}
                  onClick={handleAdvanceRound}
                >
                  Tiến sang vòng tiếp theo
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
