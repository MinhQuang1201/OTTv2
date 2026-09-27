import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, createDemoSession, safeSessionError, type AppState, type SessionFactory } from "./App";
import { ScreenBoundary } from "./ScreenBoundary";
import type { GameSession, GameSnapshot } from "../sessions/contract";
import { DemoSession } from "../sessions/demo/DemoSession";
import type { OnlineLobbyGateway } from "../sessions/online/OnlineLobbyGateway";
import type { DemoScenario } from "../shared/model/game";

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
      throwOnRead: false,
      transition(next: Partial<GameSnapshot>) {
        snapshot = { ...snapshot, ...next };
        listeners.forEach((listener) => listener());
      },
    };
    const session: GameSession = {
      getSnapshot: () => {
        if (controls.throwOnRead) throw new Error("raw snapshot secret");
        return snapshot;
      },
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
    expect(screen.getByRole("heading", { name: /OTTv2/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Kịch bản demo/i })).toHaveValue("lobby-default");
  });

  it.each([
    ["lobby-online-connecting", /OTTv2/i, "preparing"],
    ["lobby-online-unavailable", /OTTv2/i, "lobby"],
    ["game-active-a", /Bàn chơi/i, "playing"],
    ["result-goal", /Kết quả/i, "finished"],
    ["spectator-list", /OTTv2/i, "lobby"],
    ["spectator-active", /Bàn chơi/i, "playing"],
    ["spectator-reconnecting", /Bàn chơi/i, "playing"],
    ["spectator-finished", /Bàn chơi/i, "finished"],
    ["spectator-room-gone", /Trận đấu không còn khả dụng/i, "error"],
  ] as const)("routes %s to the %s screen", (scenario, heading, state) => {
    render(<App initialScenario={scenario} />);

    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByTestId("app-state")).toHaveAttribute(
      "data-state",
      state,
    );
  });

  it.each([
    ["spectator-list", "lobby", true],
    ["spectator-active", "playing", true],
    ["spectator-reconnecting", "playing", true],
    ["spectator-finished", "finished", true],
    ["spectator-room-gone", "error", false],
  ] as const)("exposes the typed App state for %s", async (scenario: DemoScenario, status, hasSpectatorViewer) => {
    const states: AppState[] = [];
    render(<App initialScenario={scenario} onStateChange={(state) => states.push(state)} />);

    await waitFor(() => expect(states.at(-1)?.status).toBe(status));
    const state = states.at(-1)!;
    if (hasSpectatorViewer) {
      if (state.status === "lobby" || state.status === "playing" || state.status === "finished") {
        expect(state.snapshot.viewer).toEqual({ role: "spectator" });
        expect(state.snapshot.viewerSeat).toBeNull();
        expect(state.snapshot.capabilities).toEqual({ canMove: false, canLeaveGame: false, canSpectate: true });
        expect(state.snapshot.spectatorCount).toBe(12);
      }
    }
    if (scenario === "spectator-list" && state.status === "lobby") {
      expect(state.snapshot.publicMatches).toHaveLength(1);
    }
    if (scenario === "spectator-room-gone" && state.status === "error") {
      expect(state.status).toBe("error");
      expect(state.error.code).toBe("room_unavailable");
      expect(screen.getByRole("heading", { name: "Trận đấu không còn khả dụng" })).toBeInTheDocument();
    }
  });

  it("labels spectator demos and does not discover online rooms", () => {
    const gateway = {
      available: true,
      listRooms: vi.fn(async () => ({ available: true, rooms: [] })),
    } as unknown as OnlineLobbyGateway;

    render(<App initialScenario="spectator-list" onlineGateway={gateway} />);

    expect(screen.getByText("Demo")).toBeInTheDocument();
    expect(gateway.listRooms).not.toHaveBeenCalled();
  });

  it("renders the spectator-list active match section from the demo snapshot", () => {
    render(<App initialScenario="spectator-list" />);

    expect(screen.getByRole("heading", { name: "Trận đang diễn ra" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Xem trận.*An.*Bình/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Phòng đang chờ" })).toBeInTheDocument();
  });

  it("keeps active-match discovery unavailable for blocked production lobby state", () => {
    render(<App initialScenario="lobby-default" onlineGateway={{ available: true, listRooms: vi.fn(async () => ({ available: true, rooms: [] })) } as unknown as OnlineLobbyGateway} />);

    expect(screen.getByText("Danh sách trận đang diễn ra hiện không khả dụng.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Xem trận/i })).not.toBeInTheDocument();
  });

  it("disables the demo watch action when online is unavailable", () => {
    render(<App initialScenario="spectator-list" />);

    expect(screen.getByRole("button", { name: /Xem trận.*An.*Bình/i })).toBeDisabled();
  });

  it("passes only the selected public match identity to the watch callback", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const onWatchMatch = vi.fn();
    render(<App initialScenario="spectator-list" onWatchMatch={onWatchMatch} onlineGateway={{ available: true, listRooms: vi.fn(async () => ({ available: true, rooms: [] })) } as unknown as OnlineLobbyGateway} />);

    await user.click(screen.getByRole("button", { name: /Xem trận.*An.*Bình/i }));

    expect(onWatchMatch).toHaveBeenCalledWith({ allocationId: "DEMO-ALLOCATION-42", roomId: "DEMO-42" });
  });

  it("shows a room-unavailable spectator message with a direct lobby path", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<App initialScenario="spectator-room-gone" />);

    expect(screen.getByRole("heading", { name: "Trận đấu không còn khả dụng" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Về sảnh/i }));
    expect(screen.getByRole("heading", { name: /OTTv2/i })).toBeInTheDocument();
  });

  it("refreshes spectator fixtures locally when switching scenarios", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const gateway = {
      available: true,
      listRooms: vi.fn(async () => ({ available: true, rooms: [] })),
    } as unknown as OnlineLobbyGateway;
    const onlineSessionFactory = vi.fn();
    render(<App initialScenario="spectator-list" onlineGateway={gateway} onlineSessionFactory={onlineSessionFactory} />);

    await user.selectOptions(screen.getByRole("combobox", { name: /Kịch bản demo/i }), "spectator-active");

    expect(await screen.findByRole("heading", { name: /Bàn chơi/i })).toBeInTheDocument();
    expect(gateway.listRooms).not.toHaveBeenCalled();
    expect(onlineSessionFactory).not.toHaveBeenCalled();
  });

  it.each([
    "spectator-list",
    "spectator-active",
    "spectator-reconnecting",
    "spectator-finished",
    "spectator-room-gone",
  ] as const)("keeps %s isolated from online discovery and sessions", async (scenario) => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const gateway = {
      available: true,
      listRooms: vi.fn(async () => ({ available: true, rooms: [] })),
    } as unknown as OnlineLobbyGateway;
    const onlineSessionFactory = vi.fn();
    const sessionFactory = vi.fn((next: DemoScenario) => createDemoSession(next));
    render(<App initialScenario={scenario} onlineGateway={gateway} onlineSessionFactory={onlineSessionFactory} sessionFactory={sessionFactory} />);

    await user.selectOptions(screen.getByRole("combobox", { name: /Kịch bản demo/i }), "lobby-default");

    expect(gateway.listRooms).not.toHaveBeenCalled();
    expect(onlineSessionFactory).not.toHaveBeenCalled();
    expect(sessionFactory).toHaveBeenCalledWith(scenario);
    expect(sessionFactory).toHaveBeenCalledWith("lobby-default");
    expect(screen.getByRole("heading", { name: /OTTv2/i })).toBeInTheDocument();
  });

  it("keeps generic online room_unavailable errors on the player error path", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const onlineSession = fakeSession();
    const onlineSessionFactory = vi.fn(() => onlineSession.session);
    const gateway = { available: true, listRooms: vi.fn(async () => ({ available: true, rooms: [] })) } as unknown as OnlineLobbyGateway;
    render(<App initialScenario="lobby-default" onlineGateway={gateway} onlineSessionFactory={onlineSessionFactory} />);

    await user.click(screen.getByRole("button", { name: /Tạo phòng/i }));
    await waitFor(() => expect(onlineSessionFactory).toHaveBeenCalledTimes(1));
    onlineSession.controls.transition({
      phase: "error",
      error: { code: "room_unavailable", message: "Phòng online không còn khả dụng.", retryable: true },
    });

    expect(await screen.findByRole("heading", { name: /Đã xảy ra sự cố/i })).toBeInTheDocument();
    expect(screen.getByText("Phòng online không còn khả dụng.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Trận đấu không còn khả dụng" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Thử lại/i })).toBeInTheDocument();
  });

  it("keeps an unavailable online lobby usable instead of showing the error boundary", () => {
    render(<App initialScenario="lobby-online-unavailable" />);

    expect(screen.getByRole("heading", { name: /OTTv2/i })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/không khả dụng/i);
    expect(screen.queryByRole("heading", { name: /Đã xảy ra sự cố/i })).not.toBeInTheDocument();
  });

  it("starts same-device play through LocalSession", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<App initialScenario="lobby-default" />);

    await user.click(screen.getByRole("button", { name: /Chơi cùng máy/i }));
    await waitFor(() => expect(screen.getByTestId("app-state")).toHaveAttribute("data-state", "playing"));
    expect(screen.getByRole("heading", { name: /Bàn chơi/i })).toBeInTheDocument();
  });

  it("starts AI play through AiSession", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<App initialScenario="lobby-default" />);

    await user.click(screen.getByRole("button", { name: /Đánh với AI/i }));
    await waitFor(() => expect(screen.getByTestId("app-state")).toHaveAttribute("data-state", "playing"));
    expect(screen.getByText("Máy")).toBeInTheDocument();
    expect(screen.getByText(/Đến lượt bạn/i)).toBeInTheDocument();
  });

  it("delegates online create to an OnlineSession instead of switching demo scenarios", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const gateway = {
      available: true,
      listRooms: vi.fn(async () => ({ available: true, rooms: [] })),
    } as unknown as OnlineLobbyGateway;
    const onlineSession = fakeSession();
    const onlineSessionFactory = vi.fn(() => onlineSession.session);
    render(<App initialScenario="lobby-default" onlineGateway={gateway} onlineSessionFactory={onlineSessionFactory} />);

    await user.click(screen.getByRole("button", { name: /Tạo phòng/i }));
    expect(onlineSessionFactory).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("app-state")).toHaveAttribute("data-state", "lobby");
    expect(gateway.listRooms).not.toHaveBeenCalled();
  });

  it("shows a safe retryable error and recovers to the lobby", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<App initialScenario="game-recoverable-error" />);

    expect(screen.getByRole("heading", { name: /Đã xảy ra sự cố/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Thử lại/i })).toBeInTheDocument();
    expect(screen.queryByText(/session_failed/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Về sảnh/i }));
    expect(screen.getByRole("heading", { name: /OTTv2/i })).toBeInTheDocument();
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
    expect(screen.getByRole("heading", { name: /OTTv2/i })).toBeInTheDocument();
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
    const crafted = Object.assign(new Error("crafted secret"), { code: "session_failed", retryable: true });
    expect(safeSessionError(crafted)).toEqual({ code: "session_failed", message: "Không thể xử lý phiên chơi.", retryable: false });
    expect(safeSessionError({ code: "unknown_code", message: "raw details", retryable: true })).toEqual({ code: "session_failed", message: "Không thể xử lý phiên chơi.", retryable: false });
    expect(safeSessionError({ code: "invalid_move", message: "Nước đi không hợp lệ.", retryable: false })).toEqual({ code: "invalid_move", message: "Nước đi không hợp lệ.", retryable: false });
  });

  it("turns an active session snapshot read failure into a safe error state", async () => {
    const value = fakeSession();
    value.controls.throwOnRead = true;
    render(<App initialScenario="game-active-a" sessionFactory={() => value.session} />);

    await waitFor(() => expect(screen.getByRole("heading", { name: /Đã xảy ra sự cố/i })).toBeInTheDocument());
    expect(screen.queryByText(/raw snapshot secret/i)).not.toBeInTheDocument();
  });

  it("falls back safely when the requested scenario is invalid", () => {
    render(<App initialScenario={"not-a-scenario" as never} />);

    expect(screen.getByRole("heading", { name: /OTTv2/i })).toBeInTheDocument();
  });
});
