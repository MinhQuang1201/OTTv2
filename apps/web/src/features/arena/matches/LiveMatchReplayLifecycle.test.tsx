import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArenaApiGateway } from "../ArenaApiGateway";
import { LiveMatchPanel } from "./LiveMatchPanel";
import * as replayImport from "../../replay/replayImport";

const liveResponse = {
  matchId: "match-a",
  status: "completed" as const,
  terminal: true,
  attemptNo: 1,
  currentPly: 0,
  reset: false,
  frames: [],
};

const replayResponse = { replay: {} } as any;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("LiveMatchPanel replay lifecycle", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("does not start a replay when an in-flight load resolves after unmount", async () => {
    const gateway = new ArenaApiGateway({ baseUrl: "http://127.0.0.1:8787/api/arena/v1" });
    const replayRequest = deferred<typeof replayResponse>();
    let replaySignal: AbortSignal | undefined;
    const getLiveFrames = vi.spyOn(gateway, "getLiveFrames").mockResolvedValue(liveResponse);
    const getMatchReplay = vi.spyOn(gateway, "getMatchReplay").mockImplementation((_matchId, options) => {
      replaySignal = options?.signal;
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      return replayRequest.promise;
    });
    const onStartReplay = vi.fn();

    const { unmount } = render(
      <LiveMatchPanel gateway={gateway} matchId="match-a" onClose={vi.fn()} onStartReplay={onStartReplay} />
    );
    await act(async () => {});
    fireEvent.click(screen.getByTestId("btn-live-view-replay"));
    expect(getMatchReplay).toHaveBeenCalledWith("match-a", { signal: expect.any(AbortSignal) });

    unmount();
    await act(async () => {
      replayRequest.resolve(replayResponse);
      await replayRequest.promise;
    });

    expect(onStartReplay).not.toHaveBeenCalled();
    expect(replaySignal?.aborted).toBe(true);
    expect(getLiveFrames).toHaveBeenCalled();
  });

  it("does not download an old match replay after switching matches", async () => {
    const gateway = new ArenaApiGateway({ baseUrl: "http://127.0.0.1:8787/api/arena/v1" });
    const replayRequest = deferred<typeof replayResponse>();
    let replaySignal: AbortSignal | undefined;
    vi.spyOn(gateway, "getLiveFrames").mockResolvedValue(liveResponse);
    vi.spyOn(gateway, "getMatchReplay").mockImplementation((_matchId, options) => {
      replaySignal = options?.signal;
      return replayRequest.promise;
    });
    const downloadReplayDocument = vi.spyOn(replayImport, "downloadReplayDocument").mockImplementation(() => undefined);
    const { rerender } = render(<LiveMatchPanel gateway={gateway} matchId="match-a" onClose={vi.fn()} />);

    await act(async () => {});
    fireEvent.click(screen.getByTestId("btn-live-download-replay"));
    rerender(<LiveMatchPanel gateway={gateway} matchId="match-b" onClose={vi.fn()} />);

    await act(async () => {
      replayRequest.resolve(replayResponse);
      await replayRequest.promise;
    });

    expect(downloadReplayDocument).not.toHaveBeenCalled();
    expect(replaySignal?.aborted).toBe(true);
  });
});
