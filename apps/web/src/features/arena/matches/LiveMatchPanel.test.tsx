import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { ArenaApiError, ArenaApiGateway } from "../ArenaApiGateway";
import { LiveMatchPanel, MAX_BUFFERED_FRAMES } from "./LiveMatchPanel";

describe("LiveMatchPanel & Controller", () => {
  let gateway: ArenaApiGateway;
  let getLiveFramesSpy: MockInstance;
  let getMatchReplaySpy: MockInstance;
  const onClose = vi.fn();
  const onStartReplay = vi.fn();

  const sampleStateA = {
    turn: "A",
    winner: null,
    reason: null,
    pieces: [
      { id: "p-1", player: "A", type: "dam", x: 4, y: 7 },
      { id: "p-2", player: "B", type: "dam", x: 4, y: 1 },
    ],
    clock: { remainingMs: { A: 60000, B: 60000 }, runningSeat: "A" },
  };

  const sampleStateB = {
    turn: "B",
    winner: null,
    reason: null,
    pieces: [
      { id: "p-1", player: "A", type: "dam", x: 4, y: 8 },
      { id: "p-2", player: "B", type: "dam", x: 4, y: 1 },
    ],
    clock: { remainingMs: { A: 59000, B: 60000 }, runningSeat: "B" },
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    gateway = new ArenaApiGateway({ baseUrl: "http://127.0.0.1:8787/api/arena/v1" });
    getLiveFramesSpy = vi.spyOn(gateway, "getLiveFrames");
    getMatchReplaySpy = vi.spyOn(gateway, "getMatchReplay");
    onClose.mockReset();
    onStartReplay.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("polls live frames on mount with initial cursor -1 and renders active frame", async () => {
    getLiveFramesSpy.mockResolvedValueOnce({
      matchId: "m-live-1",
      status: "running",
      terminal: false,
      attemptNo: 1,
      currentPly: 1,
      reset: false,
      frames: [
        {
          ply: 0,
          seat: null,
          move: null,
          state: sampleStateA,
          clock: { remainingMs: { A: 60000, B: 60000 } },
        },
        {
          ply: 1,
          seat: "A",
          move: { from: { x: 4, y: 7 }, to: { x: 4, y: 8 } },
          state: sampleStateB,
          clock: { remainingMs: { A: 59000, B: 60000 } },
          elapsedMs: 1000,
          comment: "first opening move",
        },
      ],
    });

    render(
      <LiveMatchPanel
        gateway={gateway}
        matchId="m-live-1"
        onClose={onClose}
        onStartReplay={onStartReplay}
        pollIntervalMs={1500}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(getLiveFramesSpy).toHaveBeenCalledWith(
      "m-live-1",
      { afterPly: -1, attemptNo: null, limit: 100 },
      expect.any(Object)
    );

    expect(screen.getByRole("region", { name: /Bảng theo dõi trực tiếp/i })).toBeInTheDocument();
    expect(screen.getByText(/Nước 1 \/ 1/)).toBeInTheDocument();
    expect(screen.getByText(/first opening move/)).toBeInTheDocument();
  });

  it("advances afterPly cursor strictly by LAST RETURNED frame ply without skipping unreturned pages", async () => {
    // Page 1: currentPly is 250, but batch only returns plies 0..99
    const batch1Frames = Array.from({ length: 100 }, (_, i) => ({
      ply: i,
      seat: "A" as const,
      state: sampleStateA,
    }));

    getLiveFramesSpy.mockResolvedValueOnce({
      matchId: "m-paged",
      status: "running",
      terminal: false,
      attemptNo: 1,
      currentPly: 250, // latest on server
      reset: false,
      frames: batch1Frames,
    });

    render(
      <LiveMatchPanel
        gateway={gateway}
        matchId="m-paged"
        onClose={onClose}
        pollIntervalMs={1500}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    // Page 2 response mock
    const batch2Frames = Array.from({ length: 100 }, (_, i) => ({
      ply: 100 + i,
      seat: "B" as const,
      state: sampleStateB,
    }));

    getLiveFramesSpy.mockResolvedValueOnce({
      matchId: "m-paged",
      status: "running",
      terminal: false,
      attemptNo: 1,
      currentPly: 250,
      reset: false,
      frames: batch2Frames,
    });

    await act(async () => {
      vi.advanceTimersByTime(1500);
      await Promise.resolve();
    });

    // Invariant: afterPly MUST be 99 (the last returned ply from batch 1), NOT 250
    expect(getLiveFramesSpy).toHaveBeenNthCalledWith(
      2,
      "m-paged",
      { afterPly: 99, attemptNo: 1, limit: 100 },
      expect.any(Object)
    );
  });

  it("preserves attemptNo on empty frame responses", async () => {
    getLiveFramesSpy.mockResolvedValueOnce({
      matchId: "m-empty-attempt",
      status: "running",
      terminal: false,
      attemptNo: 3,
      currentPly: 0,
      reset: false,
      frames: [],
    });

    render(
      <LiveMatchPanel
        gateway={gateway}
        matchId="m-empty-attempt"
        onClose={onClose}
        pollIntervalMs={1500}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    getLiveFramesSpy.mockResolvedValueOnce({
      matchId: "m-empty-attempt",
      status: "running",
      terminal: false,
      attemptNo: 3,
      currentPly: 0,
      reset: false,
      frames: [],
    });

    await act(async () => {
      vi.advanceTimersByTime(1500);
      await Promise.resolve();
    });

    // Invariant: attemptNo 3 is sent on next poll even though previous frames array was empty
    expect(getLiveFramesSpy).toHaveBeenNthCalledWith(
      2,
      "m-empty-attempt",
      { afterPly: -1, attemptNo: 3, limit: 100 },
      expect.any(Object)
    );
  });

  it("guards against stale match responses with generation check and resets state on match change", async () => {
    let resolveFirstMatch: (value: any) => void;
    const firstMatchPromise = new Promise((resolve) => {
      resolveFirstMatch = resolve;
    });
    getLiveFramesSpy.mockReturnValueOnce(firstMatchPromise);

    const { rerender } = render(
      <LiveMatchPanel
        gateway={gateway}
        matchId="match-A"
        onClose={onClose}
        pollIntervalMs={1500}
      />
    );

    // Change matchId while first match request is still in-flight
    getLiveFramesSpy.mockResolvedValueOnce({
      matchId: "match-B",
      status: "running",
      terminal: false,
      attemptNo: 1,
      currentPly: 0,
      reset: false,
      frames: [{ ply: 0, seat: null, state: sampleStateA, comment: "match B frame" }],
    });

    rerender(
      <LiveMatchPanel
        gateway={gateway}
        matchId="match-B"
        onClose={onClose}
        pollIntervalMs={1500}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText(/Theo dõi trực tiếp: match-B/i)).toBeInTheDocument();
    expect(screen.getByText(/match B frame/i)).toBeInTheDocument();

    // Now resolve the late first match request
    await act(async () => {
      resolveFirstMatch!({
        matchId: "match-A",
        status: "completed",
        terminal: true,
        replayUrl: "/api/arena/v1/matches/match-A/replay",
        attemptNo: 1,
        currentPly: 10,
        reset: false,
        frames: [{ ply: 10, seat: "A", state: sampleStateB, comment: "stale match A frame" }],
      });
      await Promise.resolve();
    });

    // Invariant: match-B state must NOT be contaminated by match-A's late response
    expect(screen.queryByText(/stale match A frame/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("live-terminal-banner")).not.toBeInTheDocument();
    expect(screen.getByText(/Theo dõi trực tiếp: match-B/i)).toBeInTheDocument();
  });

  it("cancels in-flight poll on hidden tab and resumes when visible", async () => {
    getLiveFramesSpy.mockResolvedValueOnce({
      matchId: "m-vis",
      status: "running",
      terminal: false,
      attemptNo: 1,
      currentPly: 0,
      reset: false,
      frames: [{ ply: 0, seat: null, state: sampleStateA }],
    });

    render(
      <LiveMatchPanel
        gateway={gateway}
        matchId="m-vis"
        onClose={onClose}
        pollIntervalMs={1500}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(getLiveFramesSpy).toHaveBeenCalledTimes(1);

    // Simulate tab hiding
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      writable: true,
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // Advance time while hidden: no poll should be dispatched
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    expect(getLiveFramesSpy).toHaveBeenCalledTimes(1);

    // Simulate tab becoming visible again: polling resumes immediately
    getLiveFramesSpy.mockResolvedValueOnce({
      matchId: "m-vis",
      status: "running",
      terminal: false,
      attemptNo: 1,
      currentPly: 1,
      reset: false,
      frames: [{ ply: 1, seat: "A", state: sampleStateB }],
    });

    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });

    expect(getLiveFramesSpy).toHaveBeenCalledTimes(2);
  });

  it("stops polling on HTTP 429 and provides retry button", async () => {
    getLiveFramesSpy.mockRejectedValueOnce(
      new ArenaApiError("Too many requests", {
        code: "CONCURRENCY_LIMIT_EXCEEDED",
        statusCode: 429,
      })
    );

    render(
      <LiveMatchPanel
        gateway={gateway}
        matchId="m-429"
        onClose={onClose}
        pollIntervalMs={1500}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("live-error-banner")).toHaveTextContent(/429/);
    expect(screen.getByTestId("btn-live-retry")).toBeInTheDocument();

    // Invariant: does not continue polling in loop
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    expect(getLiveFramesSpy).toHaveBeenCalledTimes(1);

    // Click retry resumes polling
    getLiveFramesSpy.mockResolvedValueOnce({
      matchId: "m-429",
      status: "running",
      terminal: false,
      attemptNo: 1,
      currentPly: 0,
      reset: false,
      frames: [{ ply: 0, seat: null, state: sampleStateA }],
    });

    fireEvent.click(screen.getByTestId("btn-live-retry"));

    await act(async () => {
      await Promise.resolve();
    });

    expect(getLiveFramesSpy).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("live-error-banner")).not.toBeInTheDocument();
  });

  it("hydrates frame with coreState fallback when state field is named coreState", async () => {
    getLiveFramesSpy.mockResolvedValueOnce({
      matchId: "m-corestate-shape",
      status: "running",
      terminal: false,
      attemptNo: 1,
      currentPly: 0,
      reset: false,
      frames: [
        {
          ply: 0,
          seat: null,
          coreState: sampleStateA, // testing coreState fallback
        } as any,
      ],
    });

    render(
      <LiveMatchPanel
        gateway={gateway}
        matchId="m-corestate-shape"
        onClose={onClose}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    // Board cell should render pieces from sampleStateA
    expect(screen.getByRole("region", { name: /Bảng theo dõi trực tiếp/i })).toBeInTheDocument();
    expect(screen.getByRole("grid", { name: /Bàn cờ 9 x 9/i })).toBeInTheDocument();
  });

  it("handles worker attempt reset by replacing frames and displaying notice", async () => {
    getLiveFramesSpy.mockResolvedValueOnce({
      matchId: "m-live-reset",
      status: "running",
      terminal: false,
      attemptNo: 1,
      currentPly: 1,
      reset: false,
      frames: [
        { ply: 0, seat: null, state: sampleStateA },
        { ply: 1, seat: "A", state: sampleStateB },
      ],
    });

    render(
      <LiveMatchPanel
        gateway={gateway}
        matchId="m-live-reset"
        onClose={onClose}
        pollIntervalMs={1500}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText(/Nước 1 \/ 1/)).toBeInTheDocument();

    // Worker retry with attempt 2
    getLiveFramesSpy.mockResolvedValueOnce({
      matchId: "m-live-reset",
      status: "running",
      terminal: false,
      attemptNo: 2,
      currentPly: 0,
      reset: true,
      frames: [
        { ply: 0, seat: null, state: sampleStateA, comment: "restart opening" },
      ],
    });

    await act(async () => {
      vi.advanceTimersByTime(1500);
      await Promise.resolve();
    });

    expect(screen.getByTestId("reset-notice")).toBeInTheDocument();
    expect(screen.getByText(/restart opening/)).toBeInTheDocument();
  });

  it("bounds buffered frames up to MAX_BUFFERED_FRAMES and preserves selected ply when scrubbing", async () => {
    const initialFrames = Array.from({ length: 390 }, (_, i) => ({
      ply: i,
      seat: "A" as const,
      state: sampleStateA,
    }));

    getLiveFramesSpy.mockResolvedValueOnce({
      matchId: "m-trim",
      status: "running",
      terminal: false,
      attemptNo: 1,
      currentPly: 389,
      reset: false,
      frames: initialFrames,
    });

    render(
      <LiveMatchPanel
        gateway={gateway}
        matchId="m-trim"
        onClose={onClose}
        pollIntervalMs={1500}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    // User scrubs to ply 350
    fireEvent.change(screen.getByTestId("live-scrub-slider"), { target: { value: 350 } });
    expect(screen.getByText(/Nước 350 \/ 389/)).toBeInTheDocument();

    // New frames arrive, pushing total to 420 (which trims first 20 frames)
    const newFrames = Array.from({ length: 30 }, (_, i) => ({
      ply: 390 + i,
      seat: "B" as const,
      state: sampleStateB,
    }));

    getLiveFramesSpy.mockResolvedValueOnce({
      matchId: "m-trim",
      status: "running",
      terminal: false,
      attemptNo: 1,
      currentPly: 419,
      reset: false,
      frames: newFrames,
    });

    await act(async () => {
      vi.advanceTimersByTime(1500);
      await Promise.resolve();
    });

    // Buffer capped to MAX_BUFFERED_FRAMES (400)
    expect(screen.getByText(new RegExp(`${MAX_BUFFERED_FRAMES} plies`))).toBeInTheDocument();

    // User's view is preserved on ply 350!
    expect(screen.getByText(/Nước 350 \/ 419/)).toBeInTheDocument();
  });

  it("stops polling and renders terminal banner when terminal: true is returned", async () => {
    getLiveFramesSpy.mockResolvedValueOnce({
      matchId: "m-live-done",
      status: "completed",
      terminal: true,
      replayUrl: "/api/arena/v1/matches/m-live-done/replay",
      attemptNo: 1,
      currentPly: 10,
      reset: false,
      frames: [{ ply: 10, seat: "A", state: sampleStateB }],
    });

    getMatchReplaySpy.mockResolvedValueOnce({
      matchId: "m-live-done",
      replayDigest: "sha256:rep",
      completionDigest: "sha256:comp",
      replay: {
        matchId: "m-live-done",
        rulesetId: "ottv2-g-default-v1",
      } as any,
    });

    render(
      <LiveMatchPanel
        gateway={gateway}
        matchId="m-live-done"
        onClose={onClose}
        onStartReplay={onStartReplay}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("live-terminal-banner")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });

    expect(getLiveFramesSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("btn-live-view-replay"));

    await act(async () => {
      await Promise.resolve();
    });

    expect(getMatchReplaySpy).toHaveBeenCalledWith("m-live-done", { signal: expect.any(AbortSignal) });
    expect(onStartReplay).toHaveBeenCalledWith(
      expect.objectContaining({ matchId: "m-live-done" })
    );
  });

  it("stops polling on HTTP 429 when error provides status property instead of statusCode", async () => {
    const errorWithStatus = Object.assign(new Error("Rate limit"), { status: 429 });
    getLiveFramesSpy.mockRejectedValueOnce(errorWithStatus);

    render(
      <LiveMatchPanel
        gateway={gateway}
        matchId="m-429-status"
        onClose={onClose}
        pollIntervalMs={1500}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("live-error-banner")).toHaveTextContent(/429/);
    expect(screen.getByTestId("btn-live-retry")).toBeInTheDocument();
  });

  it("classifies request timeouts, increments error count, and stops after MAX_CONSECUTIVE_ERRORS timeouts", async () => {
    getLiveFramesSpy.mockImplementation((_id, _params, options) => {
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          reject(new Error("Aborted due to timeout"));
        });
      });
    });

    render(
      <LiveMatchPanel
        gateway={gateway}
        matchId="m-timeout-stop"
        onClose={onClose}
        pollIntervalMs={500}
        requestTimeoutMs={100}
      />
    );

    expect(getLiveFramesSpy).toHaveBeenCalledTimes(1);

    for (let i = 1; i <= 5; i++) {
      await act(async () => {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      });

      if (i < 5) {
        expect(screen.getByTestId("live-error-banner")).toHaveTextContent(/quá hạn/i);
        await act(async () => {
          vi.advanceTimersByTime(500);
          await Promise.resolve();
        });
      }
    }

    expect(screen.getByTestId("live-error-banner")).toHaveTextContent(
      /Yêu cầu quá hạn sau 5 lần thử/i
    );
    expect(screen.getByTestId("btn-live-retry")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    expect(getLiveFramesSpy).toHaveBeenCalledTimes(5);
  });

  it("scrubbing and toggling followLatest maintains buffer without re-initializing controller effect", async () => {
    getLiveFramesSpy.mockResolvedValueOnce({
      matchId: "m-no-reset",
      status: "running",
      terminal: false,
      attemptNo: 1,
      currentPly: 2,
      reset: false,
      frames: [
        { ply: 0, seat: null, state: sampleStateA },
        { ply: 1, seat: "A", state: sampleStateB },
        { ply: 2, seat: "B", state: sampleStateA },
      ],
    });

    render(
      <LiveMatchPanel
        gateway={gateway}
        matchId="m-no-reset"
        onClose={onClose}
        pollIntervalMs={1500}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText(/Nước 2 \/ 2/)).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("live-scrub-slider"), { target: { value: 0 } });
    expect(screen.getByText(/Nước 0 \/ 2/)).toBeInTheDocument();

    const followBtn = screen.getByTestId("btn-follow-latest");
    expect(followBtn).not.toBeDisabled();

    fireEvent.click(followBtn);
    expect(screen.getByText(/Nước 2 \/ 2/)).toBeInTheDocument();
    expect(followBtn).toBeDisabled();

    expect(getLiveFramesSpy).toHaveBeenCalledTimes(1);
  });

  it("extracts and displays live clocks on nonzero plies when top-level frame.clock is omitted and only present in frame.state.clock", async () => {
    getLiveFramesSpy.mockResolvedValueOnce({
      matchId: "m-clock-fallback",
      status: "running",
      terminal: false,
      attemptNo: 1,
      currentPly: 5,
      reset: false,
      frames: [
        {
          ply: 5,
          seat: "A",
          move: { from: { x: 4, y: 7 }, to: { x: 4, y: 8 } },
          remainingMs: 45000,
          state: {
            ...sampleStateB,
            clock: {
              remainingMs: { A: 45000, B: 52000 },
              runningSeat: "B",
            },
          },
        },
      ],
    });

    render(
      <LiveMatchPanel
        gateway={gateway}
        matchId="m-clock-fallback"
        onClose={onClose}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("0:45")).toBeInTheDocument();
    expect(screen.getByText("0:52")).toBeInTheDocument();
  });

  it("reports malformed present state as a polling error instead of crashing during hydration", async () => {
    getLiveFramesSpy.mockResolvedValueOnce({
      matchId: "m-malformed-state",
      status: "running",
      terminal: false,
      attemptNo: 1,
      currentPly: 0,
      reset: false,
      frames: [{ ply: 0, seat: null, state: { turn: "A", pieces: [] } }],
    });

    render(
      <LiveMatchPanel
        gateway={gateway}
        matchId="m-malformed-state"
        onClose={onClose}
        pollIntervalMs={1500}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("live-error-banner")).toHaveTextContent(/khung hình trực tiếp/i);
    expect(screen.getByRole("region", { name: /Bảng theo dõi trực tiếp/i })).toBeInTheDocument();
  });

  it("reports a null piece as malformed state instead of crashing during hydration", async () => {
    getLiveFramesSpy.mockResolvedValueOnce({
      matchId: "m-null-piece",
      status: "running",
      terminal: false,
      attemptNo: 1,
      currentPly: 0,
      reset: false,
      frames: [
        {
          ply: 0,
          seat: null,
          state: { ...sampleStateA, pieces: [null] },
        },
      ],
    });

    render(<LiveMatchPanel gateway={gateway} matchId="m-null-piece" onClose={onClose} />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("live-error-banner")).toHaveTextContent(/khung hình trực tiếp/i);
  });

  it("rejects a live response for a different match", async () => {
    getLiveFramesSpy.mockResolvedValueOnce({
      matchId: "other-match",
      status: "running",
      terminal: false,
      attemptNo: 1,
      currentPly: 0,
      reset: false,
      frames: [],
    });

    render(<LiveMatchPanel gateway={gateway} matchId="m-envelope-match" onClose={onClose} />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("live-error-banner")).toHaveTextContent(/khung hình trực tiếp/i);
  });

  it("rejects duplicate or reordered plies instead of accepting ambiguous history", async () => {
    getLiveFramesSpy.mockResolvedValueOnce({
      matchId: "m-envelope-order",
      status: "running",
      terminal: false,
      attemptNo: 1,
      currentPly: 2,
      reset: false,
      frames: [
        { ply: 0, seat: null, state: sampleStateA },
        { ply: 2, seat: "A", state: sampleStateB },
        { ply: 2, seat: "B", state: sampleStateA },
      ],
    });

    render(<LiveMatchPanel gateway={gateway} matchId="m-envelope-order" onClose={onClose} />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("live-error-banner")).toHaveTextContent(/khung hình trực tiếp/i);
    expect(screen.queryByText(/Nước 2 \/ 2/)).not.toBeInTheDocument();
  });

  it("rejects an attempt change unless the response declares a reset", async () => {
    getLiveFramesSpy.mockResolvedValueOnce({
      matchId: "m-envelope-attempt",
      status: "running",
      terminal: false,
      attemptNo: 1,
      currentPly: 0,
      reset: false,
      frames: [{ ply: 0, seat: null, state: sampleStateA }],
    });

    render(<LiveMatchPanel gateway={gateway} matchId="m-envelope-attempt" onClose={onClose} />);

    await act(async () => {
      await Promise.resolve();
    });

    getLiveFramesSpy.mockResolvedValueOnce({
      matchId: "m-envelope-attempt",
      status: "running",
      terminal: false,
      attemptNo: 2,
      currentPly: 0,
      reset: false,
      frames: [{ ply: 0, seat: null, state: sampleStateA }],
    });

    await act(async () => {
      vi.advanceTimersByTime(1500);
      await Promise.resolve();
    });

    expect(screen.getByTestId("live-error-banner")).toHaveTextContent(/khung hình trực tiếp/i);
  });

  it("accepts terminal attempt zero responses", async () => {
    getLiveFramesSpy.mockResolvedValueOnce({
      matchId: "m-terminal-attempt-zero",
      status: "completed",
      terminal: true,
      attemptNo: 0,
      currentPly: 0,
      reset: false,
      frames: [],
    });

    render(<LiveMatchPanel gateway={gateway} matchId="m-terminal-attempt-zero" onClose={onClose} />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("live-terminal-banner")).toBeInTheDocument();
    expect(screen.queryByTestId("live-error-banner")).not.toBeInTheDocument();
  });

  it("keeps historical frames without state renderable", async () => {
    getLiveFramesSpy.mockResolvedValueOnce({
      matchId: "m-history-frame",
      status: "completed",
      terminal: true,
      attemptNo: 0,
      currentPly: 0,
      reset: false,
      frames: [{ ply: 0, seat: null, comment: "historical metadata only" }],
    });

    render(
      <LiveMatchPanel gateway={gateway} matchId="m-history-frame" onClose={onClose} />
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText(/historical metadata only/i)).toBeInTheDocument();
    expect(screen.getByTestId("live-terminal-banner")).toBeInTheDocument();
  });
});
