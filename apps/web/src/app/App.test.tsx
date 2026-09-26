import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, createDemoSession, safeSessionError, type AppState, type SessionFactory } from "./App";
import { ScreenBoundary } from "./ScreenBoundary";
import type { GameSession, GameSnapshot } from "../sessions/contract";
import { DemoSession } from "../sessions/demo/DemoSession";

describe("App shell lifecycle", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function Exploder({ broken }: { broken: boolean }) {
    if (broken) throw new Error("secret raw exception");
    return <p>recovered screen</p>;
  }

  function fakeSession() {
    let snapshot = new DemoSession("lobby-default").getSnapshot();
    const listeners = new Set<() => void>();
    const controls = {
      dispose: vi.fn(),
      transition(next: Partial<GameSnapshot>) {
        snapshot = { ...snapshot, ...next };
        listeners.forEach((listener) => listener());
      },
    };
    const session: GameSession = {
      getSnapshot: () => snapshot,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      start: async () => undefined,
      getLegalMoves: () => [],
      move: async () => ({ accepted: false, error: { code: "invalid_move", message: "Không hợp lệ.", retryable: false } }),
      leave: async () => undefined,
      dispose: controls.dispose,
    };
    return { session, controls };
  }
  it("creates a real demo session and renders the lobby state", () => {
    const session = createDemoSession("lobby-default");

    expect(session).toBeInstanceOf(DemoSession);
    render(<App initialScenario="lobby-default" />);

    expect(screen.getByRole("main", { name: /OTTv2/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Sảnh/i })).toBeInTheDocument();
    expect(screen.getByText("lobby-default", { selector: "dd" })).toBeInTheDocument();
  });

  it.each([
    ["lobby-online-connecting", /Đang chuẩn bị/i, "preparing"],
    ["lobby-online-unavailable", /Sảnh/i, "lobby"],
    ["game-active-a", /Bàn chơi/i, "playing"],
    ["result-goal", /Kết quả/i, "finished"],
  ] as const)("routes %s to the %s screen", (scenario, heading, state) => {
    render(<App initialScenario={scenario} />);

    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByTestId("app-state")).toHaveAttribute(
      "data-state",
      state,
    );
  });

  it("keeps an unavailable online lobby usable instead of showing the error boundary", () => {
    render(<App initialScenario="lobby-online-unavailable" />);

    expect(screen.getByRole("heading", { name: /Sảnh/i })).toBeInTheDocument();
    expect(screen.getByText("unavailable", { selector: "dd" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Đã xảy ra sự cố/i })).not.toBeInTheDocument();
  });

  it("shows a safe retryable error and recovers to the lobby", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<App initialScenario="game-recoverable-error" />);

    expect(screen.getByRole("heading", { name: /Đã xảy ra sự cố/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Thử lại/i })).toBeInTheDocument();
    expect(screen.queryByText(/session_failed/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Về sảnh/i }));
    expect(screen.getByRole("heading", { name: /Sảnh/i })).toBeInTheDocument();
  });

  it("disposes sessions when replacing one and returning to the lobby", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const sessions: Array<ReturnType<typeof fakeSession>> = [];
    const factory: SessionFactory = (scenario) => {
      void scenario;
      const value = fakeSession();
      sessions.push(value);
      return value.session;
    };
    render(<App initialScenario="lobby-default" sessionFactory={factory} />);

    await user.selectOptions(screen.getByRole("combobox", { name: /Kịch bản demo/i }), "game-active-a");

    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.controls.dispose).toHaveBeenCalledTimes(1);
    sessions[0]!.controls.transition({ phase: "error", error: { code: "session_failed", message: "stale", retryable: true } });
    expect(screen.getByTestId("app-state")).toHaveAttribute("data-state", "lobby");

    sessions[1]!.controls.transition({
      phase: "error",
      error: { code: "session_failed", message: "Không thể đồng bộ.", retryable: true },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /Về sảnh/i })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Về sảnh/i }));
    expect(sessions[1]!.controls.dispose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: /Sảnh/i })).toBeInTheDocument();
  });

  it("exposes the public lifecycle sequence from a fake session", async () => {
    const value = fakeSession();
    const states: AppState["status"][] = [];
    render(<App initialScenario="lobby-default" sessionFactory={() => value.session} onStateChange={(state) => states.push(state.status)} />);
    await waitFor(() => expect(states).toContain("lobby"));
    value.controls.transition({ phase: "preparing", connection: "connecting" });
    await waitFor(() => expect(screen.getByTestId("app-state")).toHaveAttribute("data-state", "preparing"));
    value.controls.transition({ phase: "playing", connection: "online", turn: "A" });
    await waitFor(() => expect(screen.getByTestId("app-state")).toHaveAttribute("data-state", "playing"));
    value.controls.transition({ phase: "finished", turn: null, result: { winner: "A", reason: "goal" } });
    await waitFor(() => expect(screen.getByTestId("app-state")).toHaveAttribute("data-state", "finished"));
    expect(states).toEqual(["boot", "lobby", "preparing", "playing", "finished"]);
  });

  it("invokes retry for a retryable boundary error", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const onRetry = vi.fn();
    render(<ScreenBoundary error={{ code: "session_failed", message: "Tạm thời lỗi.", retryable: true }} onRetry={onRetry} onLobby={vi.fn()}><div>screen</div></ScreenBoundary>);
    await user.click(screen.getByRole("button", { name: /Thử lại/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("resets a caught boundary when the active screen changes", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { rerender } = render(<ScreenBoundary resetKey="one" onLobby={vi.fn()}><Exploder broken /></ScreenBoundary>);
    expect(screen.getByRole("heading", { name: /Đã xảy ra sự cố/i })).toBeInTheDocument();
    expect(screen.queryByText(/secret raw exception/i)).not.toBeInTheDocument();

    rerender(<ScreenBoundary resetKey="two" onLobby={vi.fn()}><Exploder broken={false} /></ScreenBoundary>);
    await waitFor(() => expect(screen.getByText("recovered screen")).toBeInTheDocument());
    consoleError.mockRestore();
  });

  it("does not offer retry for non-retryable errors while keeping lobby recovery", () => {
    render(<ScreenBoundary error={{ code: "online_unavailable", message: "Online chưa sẵn sàng.", retryable: false }} onRetry={vi.fn()} onLobby={vi.fn()}><div>screen</div></ScreenBoundary>);

    expect(screen.queryByRole("button", { name: /Thử lại/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Về sảnh/i })).toBeInTheDocument();
  });

  it("normalizes unknown and thrown session errors without exposing exception text", () => {
    expect(safeSessionError(new Error("database password"))).toEqual({ code: "session_failed", message: "Không thể xử lý phiên chơi.", retryable: false });
    expect(safeSessionError({ code: "unknown_code", message: "raw details", retryable: true })).toEqual({ code: "session_failed", message: "Không thể xử lý phiên chơi.", retryable: false });
    expect(safeSessionError({ code: "invalid_move", message: "Nước đi không hợp lệ.", retryable: false })).toEqual({ code: "invalid_move", message: "Nước đi không hợp lệ.", retryable: false });
  });

  it("falls back safely when the requested scenario is invalid", () => {
    render(<App initialScenario={"not-a-scenario" as never} />);

    expect(screen.getByRole("heading", { name: /Sảnh/i })).toBeInTheDocument();
  });
});
