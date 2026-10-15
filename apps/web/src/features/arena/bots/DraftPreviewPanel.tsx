import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ArenaApiError,
  type ArenaApiGateway,
  type ArenaBotVersion,
  type ArenaCapabilities,
  type DraftRunResult,
} from "../ArenaApiGateway";
import { Badge } from "../../../shared/ui/Badge";
import { Button } from "../../../shared/ui/Button";
import { Spinner } from "../../../shared/ui/Spinner";
import { MAX_SOURCE_BYTES } from "./BotSourceEditor";
import styles from "./draftPreview.module.css";

export interface DraftPreviewPanelProps {
  readonly gateway: ArenaApiGateway;
  readonly botId: string | null;
  readonly currentSource: string;
  readonly currentProfileId: string;
  readonly savedVersions: readonly ArenaBotVersion[];
  readonly availableProfiles: readonly string[];
  readonly capabilities?: ArenaCapabilities | null;
  readonly disabled?: boolean;
  readonly onRegisterRunDraft?: (runner: () => Promise<void>) => void;
}

export type DraftPanelMode = "ephemeral" | "saved";

function computeUtf8ByteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).length;
  }
  return new Blob([text]).size;
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function DraftPreviewPanel({
  gateway,
  botId,
  currentSource,
  currentProfileId,
  savedVersions,
  availableProfiles,
  capabilities,
  disabled = false,
  onRegisterRunDraft,
}: DraftPreviewPanelProps) {
  const [mode, setMode] = useState<DraftPanelMode>("ephemeral");
  const [selectedMapId, setSelectedMapId] = useState<string>("classic");
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [runResult, setRunResult] = useState<DraftRunResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isCapabilityUnavailable, setIsCapabilityUnavailable] = useState<boolean>(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef<boolean>(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, []);

  // Cancel any running draft when botId changes
  useEffect(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setRunResult(null);
    setErrorMessage(null);
    setIsCapabilityUnavailable(false);
  }, [botId]);

  const byteLength = computeUtf8ByteLength(currentSource);
  const isByteOverLimit = byteLength > MAX_SOURCE_BYTES;
  const isSourceEmpty = !currentSource.trim() || byteLength === 0;

  const handleRunDraft = useCallback(async () => {
    if (disabled || isRunning || !botId || isSourceEmpty || isByteOverLimit) {
      return;
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsRunning(true);
    setErrorMessage(null);
    setIsCapabilityUnavailable(false);

    try {
      const result = await gateway.runDraft(
        botId,
        {
          source: currentSource,
          profileId: currentProfileId,
          mapId: selectedMapId,
        },
        { signal: controller.signal }
      );

      if (!isMountedRef.current || controller.signal.aborted) return;

      if (result.status === "unavailable") {
        setIsCapabilityUnavailable(true);
        setErrorMessage(
          result.error ||
            "Môi trường cách ly OCI container không khả dụng trên máy chủ. Yêu cầu chạy thử nháp bị từ chối an toàn (Fail-closed: 503)."
        );
      }
      setRunResult(result);
    } catch (err: unknown) {
      if (!isMountedRef.current || controller.signal.aborted) return;
      const apiError = err as ArenaApiError;

      if (
        apiError.statusCode === 503 ||
        apiError.code === "ISOLATION_UNAVAILABLE" ||
        apiError.code === "SERVICE_UNAVAILABLE"
      ) {
        setIsCapabilityUnavailable(true);
        setErrorMessage(
          apiError.message ||
            "Dịch vụ chạy thử nghiệm nháp chưa khả dụng hoặc máy chủ thiếu môi trường cách ly container an toàn (503)."
        );
      } else if (apiError.statusCode === 429 || apiError.code === "CONCURRENCY_LIMIT_EXCEEDED") {
        setErrorMessage("Máy chủ đang quá tải yêu cầu chạy thử. Vui lòng thử lại sau giây lát (429).");
      } else if (apiError.statusCode === 403 || apiError.code === "OWNERSHIP_MISMATCH") {
        setErrorMessage("Bạn không phải chủ sở hữu của bot này hoặc không có quyền chạy thử nghiệm (403).");
      } else {
        setErrorMessage(apiError.message || "Không thể thực hiện chạy thử nghiệm.");
      }
      setRunResult(null);
    } finally {
      if (isMountedRef.current && !controller.signal.aborted) {
        setIsRunning(false);
      }
    }
  }, [disabled, isRunning, botId, isSourceEmpty, isByteOverLimit, gateway, currentSource, currentProfileId, selectedMapId]);

  useEffect(() => {
    if (onRegisterRunDraft) {
      onRegisterRunDraft(handleRunDraft);
    }
  }, [onRegisterRunDraft, handleRunDraft]);

  // Keyboard shortcut listener: Ctrl+Enter or Cmd+Enter to run draft
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void handleRunDraft();
      }
    },
    [handleRunDraft]
  );

  return (
    <div
      className={styles.draftPanel}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="region"
      aria-label="Khung chạy thử nghiệm nháp bot"
      data-testid="draft-preview-panel"
    >
      <div className={styles.header}>
        <div className={styles.titleArea}>
          <h3 className={styles.title}>Thử nghiệm Bot (Draft Workbench)</h3>
          {botId && <code>{botId}</code>}
        </div>
        <div className={styles.modeToggle} role="radiogroup" aria-label="Chế độ xem">
          <button
            type="button"
            role="radio"
            aria-checked={mode === "ephemeral"}
            className={[styles.modeBtn, mode === "ephemeral" ? styles.modeBtnActive : ""].join(" ")}
            onClick={() => setMode("ephemeral")}
            data-testid="toggle-mode-ephemeral"
          >
            Bản nháp tạm thời (Sandbox)
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === "saved"}
            className={[styles.modeBtn, mode === "saved" ? styles.modeBtnActive : ""].join(" ")}
            onClick={() => setMode("saved")}
            data-testid="toggle-mode-saved"
          >
            Phiên bản đã lưu ({savedVersions.length})
          </button>
        </div>
      </div>

      {mode === "ephemeral" ? (
        <div>
          <div className={styles.modeNotice}>
            Chế độ Sandbox: Mã nguồn hiện tại được gửi đến trọng tài để chạy nước đi khai cuộc đầu tiên.
            Không tạo phiên bản mới, không ghi vào cơ sở dữ liệu và không ảnh hưởng điểm Elo.
          </div>

          <div className={styles.controlsBar}>
            <label htmlFor="draft-map-select" style={{ fontSize: "0.85rem" }}>
              Bản đồ trọng tài:
            </label>
            <select
              id="draft-map-select"
              className={styles.mapSelect}
              value={selectedMapId}
              onChange={(e) => setSelectedMapId(e.target.value)}
              disabled={disabled || isRunning}
              data-testid="draft-map-select"
            >
              <option value="classic">Cổ điển (classic)</option>
              <option value="flanks">Cánh hiểm (flanks)</option>
              <option value="center">Giao tranh trung tâm (center)</option>
            </select>

            <Button
              variant="primary"
              onClick={handleRunDraft}
              disabled={disabled || isRunning || !botId || isSourceEmpty || isByteOverLimit}
              data-testid="btn-run-draft"
            >
              {isRunning ? <Spinner label="Đang kiểm tra..." /> : "Chạy thử nước đi (Ctrl+Enter)"}
            </Button>

            <span className={styles.kbdHint}>
              Phím tắt: <kbd>Ctrl</kbd> + <kbd>Enter</kbd>
            </span>
          </div>

          {capabilities && !capabilities.untrusted && (
            <div
              className={[styles.alertBanner, styles.alertWarning].join(" ")}
              role="status"
              data-testid="trusted-mode-notice"
            >
              <strong>Thông báo bảo mật:</strong> Máy chủ đang chạy ở chế độ kiểm thử cục bộ (Trusted Process); môi trường cách ly OCI container chưa kích hoạt. Các lần chạy nháp sẽ được đánh dấu rõ là <em>Tiến trình nội bộ</em>.
            </div>
          )}

          {isByteOverLimit && (
            <div className={[styles.alertBanner, styles.alertDanger].join(" ")} role="alert">
              Kích thước mã nguồn ({formatByteSize(byteLength)}) vượt quá giới hạn tối đa cho phép (
              {formatByteSize(MAX_SOURCE_BYTES)}).
            </div>
          )}

          {errorMessage && (
            <div
              className={[
                styles.alertBanner,
                isCapabilityUnavailable ? styles.alertDanger : styles.alertWarning,
              ].join(" ")}
              role="alert"
              data-testid="draft-error-banner"
            >
              <strong>{isCapabilityUnavailable ? "Lỗi năng lực máy chủ:" : "Lỗi thực thi:"}</strong>{" "}
              {errorMessage}
            </div>
          )}

          {runResult && (
            <div className={styles.diagnosticsCard} data-testid="draft-diagnostics-card">
              <div className={styles.diagnosticsHeader}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <span>Kết quả:</span>
                  <Badge
                    status={
                      runResult.status === "success"
                        ? "success"
                        : runResult.status === "compile_error"
                          ? "danger"
                          : runResult.status === "execution_error"
                            ? "warning"
                            : "neutral"
                    }
                  >
                    {runResult.status === "success"
                      ? "Nước đi hợp lệ"
                      : runResult.status === "compile_error"
                        ? "Lỗi biên dịch / Cú pháp"
                        : runResult.status === "execution_error"
                          ? "Lỗi thực thi / Bất hợp lệ"
                          : runResult.status === "unavailable"
                            ? "Cách ly không khả dụng"
                            : runResult.status}
                  </Badge>
                </div>
                {runResult.isolation && (
                  <Badge status={runResult.isolation === "container" ? "success" : "warning"}>
                    {runResult.isolation === "container"
                      ? "Cách ly: OCI Container"
                      : "Tiến trình nội bộ (Trusted Process — không phải container OCI)"}
                  </Badge>
                )}
              </div>

              {runResult.compile?.logs && (
                <div className={styles.diagLogsBox} data-testid="draft-compile-logs">
                  <div style={{ fontSize: "0.8rem", fontWeight: 600, marginBottom: "0.25rem" }}>
                    Nhật ký biên dịch (Compiler / Syntax Logs):
                  </div>
                  <pre className={styles.diagLogsPre}>{runResult.compile.logs}</pre>
                </div>
              )}

              {runResult.execution && (
                <div style={{ marginTop: "0.5rem" }}>
                  <div className={styles.diagMetaGrid}>
                    <div className={styles.diagMetaItem}>
                      Hợp lệ theo luật:
                      <strong>{runResult.execution.legal ? "Có (Chấp nhận)" : "Không (Bị từ chối)"}</strong>
                    </div>
                    {runResult.execution.move && (
                      <div className={styles.diagMetaItem}>
                        Nước đi đề xuất:
                        <strong>
                          ({runResult.execution.move.from.x}, {runResult.execution.move.from.y}) → (
                          {runResult.execution.move.to.x}, {runResult.execution.move.to.y})
                        </strong>
                      </div>
                    )}
                    {runResult.execution.elapsedMs !== undefined && (
                      <div className={styles.diagMetaItem}>
                        Thời gian phản hồi:
                        <strong>{runResult.execution.elapsedMs} ms</strong>
                      </div>
                    )}
                  </div>

                  {runResult.execution.comment && (
                    <div style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                      Bình luận bot: <em>"{runResult.execution.comment}"</em>
                    </div>
                  )}

                  {runResult.execution.error && (
                    <div
                      className={[styles.alertBanner, styles.alertDanger].join(" ")}
                      style={{ marginTop: "0.5rem", marginBottom: 0 }}
                      data-testid="draft-execution-error"
                    >
                      <strong>Lý do từ chối:</strong> <code>{runResult.execution.error}</code>
                    </div>
                  )}
                </div>
              )}

              {runResult.nextState && (
                <div
                  style={{
                    marginTop: "0.5rem",
                    paddingTop: "0.5rem",
                    borderTop: "1px solid var(--border-color, #222)",
                    fontSize: "0.8rem",
                    color: "var(--text-secondary, #aaa)",
                  }}
                  data-testid="draft-next-state-summary"
                >
                  Trạng thái sau nước đi: Đã cập nhật thành công bởi engine trọng tài.
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div data-testid="saved-versions-view">
          <div className={styles.modeNotice}>
            Các phiên bản đã lưu là bản build chính thức, bất biến và có thể dùng để thi đấu hoặc đấu tập.
          </div>
          {savedVersions.length === 0 ? (
            <div style={{ fontSize: "0.85rem", color: "#aaa", padding: "1rem 0" }}>
              Bot này chưa có phiên bản nào được lưu.
            </div>
          ) : (
            <div className={styles.savedVersionsList}>
              {savedVersions.map((ver) => (
                <div key={ver.id} className={styles.savedVersionItem}>
                  <div className={styles.savedVersionMeta}>
                    <strong>v{ver.versionNo}</strong>
                    <code>{ver.profileId}</code>
                    <Badge
                      status={
                        ver.buildStatus === "ready"
                          ? "success"
                          : ver.buildStatus === "building"
                            ? "info"
                            : ver.buildStatus === "failed"
                              ? "danger"
                              : "neutral"
                      }
                    >
                      {ver.buildStatus}
                    </Badge>
                  </div>
                  <div>
                    <code style={{ fontSize: "0.75rem", color: "#888" }}>
                      {ver.sourceDigest.slice(0, 16)}...
                    </code>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
