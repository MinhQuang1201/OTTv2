import { useEffect, useMemo, useRef, useState } from "react";
import type { ReplayDocument } from "../../../../../../packages/arena/src/contracts/index.d.mts";
import type { GameSession } from "../../../sessions/contract";
import { downloadReplayDocument } from "../../replay/replayImport";
import { Board } from "../../game/Board";
import { Badge } from "../../../shared/ui/Badge";
import { Button } from "../../../shared/ui/Button";
import { Spinner } from "../../../shared/ui/Spinner";
import type { ArenaApiGateway } from "../ArenaApiGateway";
import {
  useLiveMatchController,
  DEFAULT_POLL_INTERVAL_MS,
  MAX_BUFFERED_FRAMES,
} from "./useLiveMatchController";
import {
  extractHighlightMove,
  extractLiveClock,
  formatLiveClock,
  hydrateLiveFrameSnapshot,
} from "./liveMatchHydration";
import styles from "./liveMatch.module.css";

export { DEFAULT_POLL_INTERVAL_MS, MAX_BUFFERED_FRAMES };

export interface LiveMatchPanelProps {
  readonly gateway: ArenaApiGateway;
  readonly matchId: string;
  readonly onClose: () => void;
  readonly onStartReplay?: (document: ReplayDocument) => void;
  readonly pollIntervalMs?: number;
  readonly requestTimeoutMs?: number;
}

export function LiveMatchPanel({
  gateway,
  matchId,
  onClose,
  onStartReplay,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  requestTimeoutMs,
}: LiveMatchPanelProps) {
  const [perspective, setPerspective] = useState<"A" | "B">("A");
  const [loadingReplay, setLoadingReplay] = useState<boolean>(false);
  const [replayError, setReplayError] = useState<string | null>(null);
  const replayLifecycleRef = useRef<{ generation: number; controller: AbortController | null }>({
    generation: 0,
    controller: null,
  });

  useEffect(() => {
    return () => {
      replayLifecycleRef.current.generation += 1;
      replayLifecycleRef.current.controller?.abort();
      replayLifecycleRef.current.controller = null;
    };
  }, [matchId]);

  const {
    frames,
    activeIndex,
    activeFrame,
    followLatest,
    status,
    isTerminal,
    resetOccurred,
    errorMessage,
    isPollingStopped,
    handleSeek,
    handleFollowLatest,
    handleRetry,
  } = useLiveMatchController({
    gateway,
    matchId,
    pollIntervalMs,
    requestTimeoutMs,
  });

  // Authoritative snapshot hydration: accepts state or coreState without client rules
  const hydratedSnapshot = useMemo(() => {
    return hydrateLiveFrameSnapshot(activeFrame, isTerminal);
  }, [activeFrame, isTerminal]);

  // Read-only spectator session for Board
  const spectatorSession = useMemo<GameSession>(() => {
    return {
      getSnapshot: () => hydratedSnapshot,
      subscribe: () => () => {},
      start: async () => {},
      leave: async () => {},
      dispose: () => {},
      move: async () => ({
        accepted: false,
        error: { code: "invalid_input", message: "Spectator view", retryable: false },
      }),
      getLegalMoves: () => [],
    };
  }, [hydratedSnapshot]);

  const highlightMove = useMemo(() => {
    return extractHighlightMove(activeFrame);
  }, [activeFrame]);

  const handleViewReplay = async () => {
    if (!onStartReplay) return;
    const controller = new AbortController();
    replayLifecycleRef.current.controller?.abort();
    const generation = ++replayLifecycleRef.current.generation;
    replayLifecycleRef.current.controller = controller;
    setLoadingReplay(true);
    setReplayError(null);
    try {
      const res = await gateway.getMatchReplay(matchId, { signal: controller.signal });
      if (res?.replay && generation === replayLifecycleRef.current.generation && !controller.signal.aborted) {
        onStartReplay(res.replay);
      }
    } catch (err: unknown) {
      if (generation === replayLifecycleRef.current.generation && !controller.signal.aborted) {
        setReplayError((err as Error)?.message || "Không thể tải tài liệu replay.");
      }
    } finally {
      if (generation === replayLifecycleRef.current.generation) {
        replayLifecycleRef.current.controller = null;
        setLoadingReplay(false);
      }
    }
  };

  const handleDownloadReplay = async () => {
    const controller = new AbortController();
    replayLifecycleRef.current.controller?.abort();
    const generation = ++replayLifecycleRef.current.generation;
    replayLifecycleRef.current.controller = controller;
    setLoadingReplay(true);
    setReplayError(null);
    try {
      const res = await gateway.getMatchReplay(matchId, { signal: controller.signal });
      if (res?.replay && generation === replayLifecycleRef.current.generation && !controller.signal.aborted) {
        downloadReplayDocument(res.replay, `match-${matchId}-live-replay.json`);
      }
    } catch (err: unknown) {
      if (generation === replayLifecycleRef.current.generation && !controller.signal.aborted) {
        setReplayError((err as Error)?.message || "Không thể tải tập tin replay.");
      }
    } finally {
      if (generation === replayLifecycleRef.current.generation) {
        replayLifecycleRef.current.controller = null;
        setLoadingReplay(false);
      }
    }
  };

  const clockA = extractLiveClock(activeFrame, "A");
  const clockB = extractLiveClock(activeFrame, "B");

  return (
    <div
      className={styles.livePanel}
      role="region"
      aria-label="Bảng theo dõi trực tiếp trận đấu"
      data-testid="live-match-panel"
    >
      <div className={styles.header}>
        <div className={styles.titleArea}>
          {!isTerminal && <span className={styles.pulseIndicator} title="Trận đấu đang diễn ra" />}
          <h2 className={styles.title}>Theo dõi trực tiếp: {matchId}</h2>
          <Badge status={isTerminal ? "info" : status === "running" ? "success" : "neutral"}>
            {isTerminal ? "completed" : status}
          </Badge>
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <Button
            variant="secondary"
            onClick={() => setPerspective((p) => (p === "A" ? "B" : "A"))}
            data-testid="btn-flip-perspective"
          >
            Đổi góc nhìn ({perspective === "A" ? "Phe A" : "Phe B"})
          </Button>
          <Button variant="quiet" onClick={onClose} data-testid="btn-close-live">
            Đóng
          </Button>
        </div>
      </div>

      {resetOccurred && (
        <div className={styles.resetBanner} role="status" data-testid="reset-notice">
          Công nhân đã khởi động lại trận đấu. Bảng cờ và các nước đi đã được đồng bộ lại từ đầu.
        </div>
      )}

      {isTerminal && (
        <div className={styles.terminalBanner} data-testid="live-terminal-banner">
          <div>
            <strong>Trận đấu đã kết thúc.</strong> Khung hình trực tiếp đã hoàn tất.
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            {onStartReplay && (
              <Button
                variant="primary"
                onClick={handleViewReplay}
                disabled={loadingReplay}
                data-testid="btn-live-view-replay"
              >
                {loadingReplay ? <Spinner label="Đang tải..." /> : "Xem Replay đầy đủ"}
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={handleDownloadReplay}
              disabled={loadingReplay}
              data-testid="btn-live-download-replay"
            >
              Tải Replay
            </Button>
          </div>
        </div>
      )}

      {(errorMessage || replayError) && (
        <div
          className={styles.resetBanner}
          style={{
            color: "#fca5a5",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
          role="alert"
          data-testid="live-error-banner"
        >
          <span>{replayError || errorMessage}</span>
          {isPollingStopped && (
            <Button variant="secondary" onClick={handleRetry} data-testid="btn-live-retry">
              Thử lại
            </Button>
          )}
        </div>
      )}

      <div className={styles.contentGrid}>
        <div className={styles.boardColumn}>
          <Board
            session={spectatorSession}
            snapshot={hydratedSnapshot}
            perspective={perspective}
            highlightMove={highlightMove}
          />

          <div className={styles.controlsRow}>
            <div style={{ display: "flex", gap: "0.25rem" }}>
              <Button
                variant="quiet"
                onClick={() => handleSeek(0)}
                disabled={frames.length === 0 || activeIndex === 0}
                data-testid="btn-live-start"
              >
                |◀
              </Button>
              <Button
                variant="quiet"
                onClick={() => handleSeek(activeIndex - 1)}
                disabled={frames.length === 0 || activeIndex === 0}
                data-testid="btn-live-prev"
              >
                ◀ Trước
              </Button>
              <Button
                variant="quiet"
                onClick={() => handleSeek(activeIndex + 1)}
                disabled={frames.length === 0 || activeIndex >= frames.length - 1}
                data-testid="btn-live-next"
              >
                Sau ▶
              </Button>
              <Button
                variant="quiet"
                onClick={() => handleSeek(frames.length - 1)}
                disabled={frames.length === 0 || activeIndex >= frames.length - 1}
                data-testid="btn-live-end"
              >
                ▶|
              </Button>
            </div>

            <Button
              variant={followLatest ? "primary" : "secondary"}
              onClick={handleFollowLatest}
              disabled={followLatest}
              data-testid="btn-follow-latest"
            >
              {followLatest ? "Đang theo dõi trực tiếp" : "Theo dõi mới nhất"}
            </Button>
          </div>

          <div className={styles.scrubBar}>
            <span style={{ fontSize: "0.8rem", color: "#aaa" }}>
              {`Nước ${activeFrame ? activeFrame.ply : 0} / ${frames.length > 0 ? frames[frames.length - 1].ply : 0}`}
            </span>
            <input
              type="range"
              className={styles.scrubSlider}
              min={0}
              max={Math.max(0, frames.length - 1)}
              value={activeIndex}
              onChange={(e) => handleSeek(parseInt(e.target.value, 10))}
              disabled={frames.length <= 1}
              data-testid="live-scrub-slider"
            />
            <span style={{ fontSize: "0.75rem", color: "#888" }}>
              ({frames.length} plies)
            </span>
          </div>
        </div>

        <div className={styles.sidebarColumn}>
          <div className={styles.infoCard}>
            <h4>Đồng hồ trọng tài</h4>
            <div className={styles.clockRow}>
              <div className={styles.clockSeat}>
                <div>Seat A</div>
                <div
                  className={[
                    styles.clockTime,
                    activeFrame?.seat === "A" ? styles.activeClock : "",
                  ].join(" ")}
                >
                  {formatLiveClock(clockA)}
                </div>
              </div>
              <div className={styles.clockSeat}>
                <div>Seat B</div>
                <div
                  className={[
                    styles.clockTime,
                    activeFrame?.seat === "B" ? styles.activeClock : "",
                  ].join(" ")}
                >
                  {formatLiveClock(clockB)}
                </div>
              </div>
            </div>
          </div>

          <div className={styles.infoCard}>
            <h4>Chi tiết nước đi</h4>
            {activeFrame ? (
              <div>
                <div className={styles.metaRow}>
                  <span>Lượt (Ply):</span>
                  <strong>{activeFrame.ply}</strong>
                </div>
                {activeFrame.seat && (
                  <div className={styles.metaRow}>
                    <span>Phe thực hiện:</span>
                    <strong>Seat {activeFrame.seat}</strong>
                  </div>
                )}
                {highlightMove && (
                  <div className={styles.metaRow}>
                    <span>Tọa độ:</span>
                    <strong>
                      ({highlightMove.from.x}, {highlightMove.from.y}) → (
                      {highlightMove.to.x}, {highlightMove.to.y})
                    </strong>
                  </div>
                )}
                {activeFrame.elapsedMs !== undefined && (
                  <div className={styles.metaRow}>
                    <span>Thời gian suy nghĩ:</span>
                    <span>{activeFrame.elapsedMs} ms</span>
                  </div>
                )}
                {activeFrame.comment && (
                  <div className={styles.frameComment}>
                    Bình luận: "{activeFrame.comment}"
                  </div>
                )}
              </div>
            ) : (
              <div style={{ fontSize: "0.85rem", color: "#888" }}>
                Đang chờ nước đi đầu tiên...
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
