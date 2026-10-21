import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ArenaApiGateway,
  type ArenaApiError,
  type LiveFrameRecord,
  type LiveFramesQueryResult,
} from "../ArenaApiGateway";
import { validateLiveFrame } from "./liveMatchHydration";

export const DEFAULT_POLL_INTERVAL_MS = 1500;
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
export const MAX_BUFFERED_FRAMES = 400;
export const MAX_CONSECUTIVE_ERRORS = 5;

function validateLiveFramesResult(
  result: LiveFramesQueryResult,
  matchId: string,
  afterPly: number,
  previousAttemptNo: number | null
): void {
  if (result.matchId !== matchId) throw new Error("Khung hình trực tiếp sai mã trận đấu.");
  if (!Number.isInteger(result.attemptNo) || result.attemptNo < 0) {
    throw new Error("Khung hình trực tiếp có attempt không hợp lệ.");
  }
  if (!result.terminal && result.attemptNo < 1) {
    throw new Error("Khung hình trực tiếp đang chạy thiếu attempt hợp lệ.");
  }
  if (!Array.isArray(result.frames)) throw new Error("Khung hình trực tiếp có danh sách không hợp lệ.");
  if (result.reset && previousAttemptNo !== null && result.attemptNo <= previousAttemptNo) {
    throw new Error("Khung hình trực tiếp có reset attempt không tăng.");
  }
  if (
    !result.reset &&
    result.attemptNo !== 0 &&
    previousAttemptNo !== null &&
    result.attemptNo !== previousAttemptNo
  ) {
    throw new Error("Khung hình trực tiếp có attempt thay đổi mà không reset.");
  }

  let previousPly = result.reset ? -1 : afterPly;
  for (const frame of result.frames) {
    validateLiveFrame(frame);
    if (frame.ply <= previousPly) {
      throw new Error("Khung hình trực tiếp có thứ tự ply hoặc cursor không tăng.");
    }
    previousPly = frame.ply;
  }

  const lastReturnedPly = (result as LiveFramesQueryResult & { lastReturnedPly?: unknown }).lastReturnedPly;
  if (lastReturnedPly !== undefined && lastReturnedPly !== null) {
    const cursorFloor = result.reset ? -1 : afterPly;
    if (
      typeof lastReturnedPly !== "number" ||
      !Number.isInteger(lastReturnedPly) ||
      lastReturnedPly < -1 ||
      lastReturnedPly < cursorFloor
    ) {
      throw new Error("Khung hình trực tiếp có cursor không hợp lệ.");
    }
    if (result.frames.length > 0 && lastReturnedPly !== result.frames[result.frames.length - 1].ply) {
      throw new Error("Khung hình trực tiếp có cursor không khớp frame cuối.");
    }
  }
}

export interface UseLiveMatchControllerOptions {
  readonly gateway: ArenaApiGateway;
  readonly matchId: string;
  readonly pollIntervalMs?: number;
  readonly requestTimeoutMs?: number;
}

export interface LiveMatchControllerState {
  readonly frames: readonly LiveFrameRecord[];
  readonly activeIndex: number;
  readonly activeFrame: LiveFrameRecord | null;
  readonly followLatest: boolean;
  readonly status: string;
  readonly isTerminal: boolean;
  readonly replayUrl: string | null;
  readonly resetOccurred: boolean;
  readonly errorMessage: string | null;
  readonly isPollingStopped: boolean;
  readonly handleSeek: (index: number) => void;
  readonly handleFollowLatest: () => void;
  readonly handleRetry: () => void;
}

export function useLiveMatchController({
  gateway,
  matchId,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}: UseLiveMatchControllerOptions): LiveMatchControllerState {
  const [frames, setFrames] = useState<readonly LiveFrameRecord[]>([]);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [followLatest, setFollowLatest] = useState<boolean>(true);
  const [status, setStatus] = useState<string>("running");
  const [isTerminal, setIsTerminal] = useState<boolean>(false);
  const [replayUrl, setReplayUrl] = useState<string | null>(null);
  const [resetOccurred, setResetOccurred] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPollingStopped, setIsPollingStopped] = useState<boolean>(false);

  // Controller refs
  const generationRef = useRef<number>(0);
  const afterPlyRef = useRef<number>(-1);
  const attemptNoRef = useRef<number | null>(null);
  const selectedPlyRef = useRef<number | null>(null);
  const consecutiveErrorsRef = useRef<number>(0);
  const framesRef = useRef<readonly LiveFrameRecord[]>([]);
  const followLatestRef = useRef<boolean>(true);

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isFetchingRef = useRef<boolean>(false);
  const isMountedRef = useRef<boolean>(true);
  const isTerminalRef = useRef<boolean>(false);
  const isPollingStoppedRef = useRef<boolean>(false);

  const cleanupTimersAndAbort = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (requestTimerRef.current) {
      clearTimeout(requestTimerRef.current);
      requestTimerRef.current = null;
    }
    if (abortControllerRef.current) {
      try {
        abortControllerRef.current.abort();
      } catch {}
      abortControllerRef.current = null;
    }
  }, []);

  const pollFrames = useCallback(async () => {
    const currentGeneration = generationRef.current;

    if (
      !isMountedRef.current ||
      currentGeneration !== generationRef.current ||
      isTerminalRef.current ||
      isPollingStoppedRef.current ||
      isFetchingRef.current
    ) {
      return;
    }

    // Visible-only guard
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }

    cleanupTimersAndAbort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    isFetchingRef.current = true;

    // Bounded request timeout per-request
    let isTimedOut = false;
    let localRequestTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      isTimedOut = true;
      try {
        controller.abort();
      } catch {}
    }, requestTimeoutMs);
    requestTimerRef.current = localRequestTimer;

    try {
      const result: LiveFramesQueryResult = await gateway.getLiveFrames(
        matchId,
        {
          afterPly: afterPlyRef.current,
          attemptNo: attemptNoRef.current,
          limit: 100,
        },
        { signal: controller.signal }
      );

      validateLiveFramesResult(result, matchId, afterPlyRef.current, attemptNoRef.current);

      if (
        !isMountedRef.current ||
        currentGeneration !== generationRef.current ||
        controller.signal.aborted
      ) {
        return;
      }

      // Success: clear errors and error counters
      consecutiveErrorsRef.current = 0;
      setErrorMessage(null);
      setStatus(result.status);
      if (result.replayUrl) {
        setReplayUrl(result.replayUrl);
      }

      // Always maintain attemptNo from server even if empty frames
      attemptNoRef.current = result.attemptNo;

      if (result.reset) {
        setResetOccurred(true);
        // Advance cursor ONLY by last returned frame's ply (or -1 if empty)
        if (result.frames.length > 0) {
          afterPlyRef.current = result.frames[result.frames.length - 1].ply;
        } else {
          afterPlyRef.current = -1;
        }

        const nextFrames = result.frames.slice(-MAX_BUFFERED_FRAMES);
        framesRef.current = nextFrames;
        setFrames(nextFrames);
        selectedPlyRef.current = nextFrames.length > 0 ? nextFrames[nextFrames.length - 1].ply : null;
        setActiveIndex(Math.max(0, nextFrames.length - 1));
      } else if (result.frames.length > 0) {
        // Advance cursor to LAST RETURNED frame's ply only (fixes pagination bug!)
        const lastReturned = result.frames[result.frames.length - 1];
        afterPlyRef.current = lastReturned.ply;

        const combined = [...framesRef.current, ...result.frames];
        const trimmed =
          combined.length > MAX_BUFFERED_FRAMES
            ? combined.slice(combined.length - MAX_BUFFERED_FRAMES)
            : combined;
        framesRef.current = trimmed;
        setFrames(trimmed);

        // Preserve selected ply when buffer trims
        if (!followLatestRef.current && selectedPlyRef.current !== null) {
          const plyIndex = trimmed.findIndex((f) => f.ply === selectedPlyRef.current);
          setActiveIndex(plyIndex >= 0 ? plyIndex : 0);
        } else {
          setActiveIndex(Math.max(0, trimmed.length - 1));
          selectedPlyRef.current = trimmed.length > 0 ? trimmed[trimmed.length - 1].ply : null;
        }
      }

      if (result.terminal) {
        setIsTerminal(true);
        isTerminalRef.current = true;
        // Do not schedule further polls
        return;
      }
    } catch (err: unknown) {
      if (
        !isMountedRef.current ||
        currentGeneration !== generationRef.current ||
        (controller.signal.aborted && !isTimedOut)
      ) {
        return;
      }

      consecutiveErrorsRef.current += 1;
      const apiErr = err as (Partial<ArenaApiError> & { status?: number });
      const statusCode = apiErr?.statusCode ?? apiErr?.status;
      const is429 = statusCode === 429 || apiErr?.code === "CONCURRENCY_LIMIT_EXCEEDED";
      const isTooMany = consecutiveErrorsRef.current >= MAX_CONSECUTIVE_ERRORS;

      if (is429 || isTooMany) {
        // Stop polling and require explicit user retry
        isPollingStoppedRef.current = true;
        setIsPollingStopped(true);
        let reason: string;
        if (is429) {
          reason = "Máy chủ đang quá tải (429). Đã tạm dừng theo dõi.";
        } else if (isTimedOut) {
          reason = `Yêu cầu quá hạn sau ${consecutiveErrorsRef.current} lần thử.`;
        } else {
          reason = `Không thể kết nối sau ${consecutiveErrorsRef.current} lần thử.`;
        }
        setErrorMessage(`${reason} Vui lòng bấm 'Thử lại' để tiếp tục.`);
        return;
      } else {
        setErrorMessage(
          isTimedOut
            ? "Yêu cầu khung hình trực tiếp quá hạn (timeout)."
            : apiErr?.message || "Lỗi cập nhật khung hình trực tiếp."
        );
      }
    } finally {
      const requestTimerOwner = localRequestTimer;
      if (localRequestTimer !== null) {
        clearTimeout(localRequestTimer);
        localRequestTimer = null;
      }
      if (requestTimerRef.current === requestTimerOwner) {
        requestTimerRef.current = null;
      }

      const isCurrentOwner =
        abortControllerRef.current === controller &&
        generationRef.current === currentGeneration;

      if (isCurrentOwner) {
        abortControllerRef.current = null;
        isFetchingRef.current = false;
      }

      const isExternalAbort = controller.signal.aborted && !isTimedOut;
      const isVisible =
        typeof document === "undefined" || document.visibilityState !== "hidden";

      // Schedule next poll only if visible, generation matches, not terminal/stopped, and not externally aborted
      if (
        isMountedRef.current &&
        currentGeneration === generationRef.current &&
        !isTerminalRef.current &&
        !isPollingStoppedRef.current &&
        !isExternalAbort &&
        isVisible &&
        isCurrentOwner
      ) {
        pollTimerRef.current = setTimeout(() => {
          void pollFrames();
        }, pollIntervalMs);
      }
    }
  }, [cleanupTimersAndAbort, gateway, matchId, pollIntervalMs, requestTimeoutMs]);

  // Handle visibility changes: abort in-flight on hidden, resume on visible
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        cleanupTimersAndAbort();
        isFetchingRef.current = false;
      } else if (
        document.visibilityState === "visible" &&
        !isTerminalRef.current &&
        !isPollingStoppedRef.current
      ) {
        cleanupTimersAndAbort();
        void pollFrames();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [cleanupTimersAndAbort, pollFrames]);

  // State initialization and generation bump on matchId or gateway change
  useEffect(() => {
    generationRef.current += 1;
    cleanupTimersAndAbort();

    isFetchingRef.current = false;
    isTerminalRef.current = false;
    isPollingStoppedRef.current = false;
    afterPlyRef.current = -1;
    attemptNoRef.current = null;
    selectedPlyRef.current = null;
    consecutiveErrorsRef.current = 0;
    framesRef.current = [];
    followLatestRef.current = true;

    setFrames([]);
    setActiveIndex(0);
    setFollowLatest(true);
    setStatus("running");
    setIsTerminal(false);
    setReplayUrl(null);
    setResetOccurred(false);
    setErrorMessage(null);
    setIsPollingStopped(false);

    void pollFrames();

    return () => {
      cleanupTimersAndAbort();
    };
  }, [cleanupTimersAndAbort, gateway, matchId, pollFrames]);

  // Unmount cleanup
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      generationRef.current += 1;
      cleanupTimersAndAbort();
    };
  }, [cleanupTimersAndAbort]);

  const handleSeek = useCallback((index: number) => {
    const currentFrames = framesRef.current;
    if (currentFrames.length === 0) return;
    const nextIndex = Math.max(0, Math.min(currentFrames.length - 1, index));
    setActiveIndex(nextIndex);
    const targetFrame = currentFrames[nextIndex];
    selectedPlyRef.current = targetFrame ? targetFrame.ply : null;

    if (nextIndex === currentFrames.length - 1) {
      followLatestRef.current = true;
      setFollowLatest(true);
    } else {
      followLatestRef.current = false;
      setFollowLatest(false);
    }
  }, []);

  const handleFollowLatest = useCallback(() => {
    followLatestRef.current = true;
    setFollowLatest(true);
    const currentFrames = framesRef.current;
    if (currentFrames.length > 0) {
      const lastIndex = currentFrames.length - 1;
      setActiveIndex(lastIndex);
      selectedPlyRef.current = currentFrames[lastIndex].ply;
    }
  }, []);

  const handleRetry = useCallback(() => {
    consecutiveErrorsRef.current = 0;
    isPollingStoppedRef.current = false;
    setIsPollingStopped(false);
    setErrorMessage(null);
    cleanupTimersAndAbort();
    void pollFrames();
  }, [cleanupTimersAndAbort, pollFrames]);

  const activeFrame = useMemo(() => {
    if (frames.length === 0) return null;
    const clamped = Math.max(0, Math.min(frames.length - 1, activeIndex));
    return frames[clamped];
  }, [frames, activeIndex]);

  return {
    frames,
    activeIndex,
    activeFrame,
    followLatest,
    status,
    isTerminal,
    replayUrl,
    resetOccurred,
    errorMessage,
    isPollingStopped,
    handleSeek,
    handleFollowLatest,
    handleRetry,
  };
}
