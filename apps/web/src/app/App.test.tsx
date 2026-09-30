// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, createDemoSession, safeSessionError, type AppState, type SessionFactory } from "./App";
import { ScreenBoundary } from "./ScreenBoundary";
import type { GameSession, GameSnapshot } from "../sessions/contract";
import { DemoSession } from "../sessions/demo/DemoSession";
import type { OnlineLobbyGateway } from "../sessions/online/OnlineLobbyGateway";
import type { DemoScenario } from "../shared/model/game";
import { AppLifecycleCoordinator } from "./AppLifecycleCoordinator";

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

  it("allows the deterministic demo watch action even when production online is unavailable", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const onWatchMatch = vi.fn();
    render(<App initialScenario="spectator-list" onWatchMatch={onWatchMatch} />);

    const watchButton = screen.getByRole("button", { name: /Xem trận.*An.*Bình/i });
    expect(watchButton).not.toBeDisabled();
    await user.click(watchButton);

    expect(onWatchMatch).toHaveBeenCalledWith({ allocationId: "DEMO-ALLOCATION-42", roomId: "DEMO-42" });
  });

  it("passes only the selected public match identity to the watch callback", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const onWatchMatch = vi.fn();
    render(<App initialScenario="spectator-list" onWatchMatch={onWatchMatch} />);

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

    await user.type(screen.getByRole("textbox", { name: "Tên của bạn" }), "An");
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

    await user.type(screen.getByRole("textbox", { name: "Tên của bạn" }), "An");
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
    await waitFor(() => expect(states).toEqual(["boot", "lobby", "preparing", "playing", "finished"]));
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

  it("serializes lobby-to-game-to-lobby transitions and awaits disposal", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const eventLog: string[] = [];
    let sessionCount = 0;

    const factory: SessionFactory = () => {
      const id = ++sessionCount;
      eventLog.push(`create-lobby-${id}`);
      const snapshot = new DemoSession("lobby-default").getSnapshot();
      return {
        getSnapshot: () => snapshot,
        subscribe: () => () => undefined,
        start: async () => { eventLog.push(`start-lobby-${id}`); },
        getLegalMoves: () => [],
        move: async () => ({ accepted: false, error: { code: "invalid_move", message: "err", retryable: false } }),
        leave: async () => undefined,
        dispose: async () => {
          eventLog.push(`dispose-start-lobby-${id}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
          eventLog.push(`dispose-end-lobby-${id}`);
        },
      };
    };

    render(<App initialScenario="lobby-default" sessionFactory={factory} />);
    expect(eventLog).toContain("create-lobby-1");

    await user.click(screen.getByRole("button", { name: /Chơi cùng máy/i }));
    await waitFor(() => expect(screen.getByTestId("app-state")).toHaveAttribute("data-state", "playing"));
    expect(eventLog).toContain("dispose-end-lobby-1");

    await user.click(screen.getByRole("button", { name: /Rời bàn/i }));
    await waitFor(() => expect(screen.getByTestId("app-state")).toHaveAttribute("data-state", "lobby"));
    expect(eventLog).toContain("create-lobby-2");
  });

  it("awaits async spectator session disposal before transitioning to lobby", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    let spectatorDisposeAwaited = false;
    let lobbyCreatedAfterSpectatorDisposed = false;

    const spectatorDispose = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      spectatorDisposeAwaited = true;
    });

    const spectatorSnapshot = {
      ...new DemoSession("spectator-active").getSnapshot(),
      viewer: { role: "spectator" as const },
      capabilities: { canMove: false, canLeaveGame: false, canSpectate: true },
    };

    const spectatorSession: GameSession = {
      getSnapshot: () => spectatorSnapshot,
      subscribe: () => () => undefined,
      start: async () => undefined,
      getLegalMoves: () => [],
      move: async () => ({ accepted: false, error: { code: "invalid_move", message: "err", retryable: false } }),
      leave: async () => undefined,
      dispose: spectatorDispose,
    };

    const sessionFactory: SessionFactory = (scenario) => {
      if (scenario === "lobby-default" && spectatorDispose.mock.calls.length > 0) {
        lobbyCreatedAfterSpectatorDisposed = spectatorDisposeAwaited;
      }
      if (scenario === "spectator-active") {
        return spectatorSession;
      }
      return new DemoSession(scenario);
    };

    render(<App initialScenario="lobby-default" sessionFactory={sessionFactory} />);

    await user.selectOptions(screen.getByRole("combobox", { name: /Kịch bản demo/i }), "spectator-active");
    await waitFor(() => expect(screen.getByRole("heading", { name: /Bàn chơi/i })).toBeInTheDocument());

    await user.selectOptions(screen.getByRole("combobox", { name: /Kịch bản demo/i }), "lobby-default");
    await waitFor(() => expect(screen.getByRole("heading", { name: /OTTv2/i })).toBeInTheDocument());

    expect(spectatorDispose).toHaveBeenCalledTimes(1);
    expect(lobbyCreatedAfterSpectatorDisposed).toBe(true);
  });

  it("serializes rapid session transitions without coexisting providers", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const disposalAwaitedOrder: string[] = [];
    const activeSessions = new Set<string>();

    const makeSession = (id: string, delayMs = 15): GameSession => {
      const snapshot = new DemoSession("lobby-default").getSnapshot();
      return {
        getSnapshot: () => snapshot,
        subscribe: () => () => undefined,
        start: async () => {
          activeSessions.add(id);
        },
        getLegalMoves: () => [],
        move: async () => ({ accepted: false, error: { code: "invalid_move", message: "err", retryable: false } }),
        leave: async () => undefined,
        dispose: async () => {
          await new Promise((r) => setTimeout(r, delayMs));
          activeSessions.delete(id);
          disposalAwaitedOrder.push(id);
        },
      };
    };

    const sessionFactory: SessionFactory = (scenario) => makeSession(scenario);

    render(<App initialScenario="lobby-default" sessionFactory={sessionFactory} />);

    const select = screen.getByRole("combobox", { name: /Kịch bản demo/i });
    await user.selectOptions(select, "game-active-a");
    await user.selectOptions(select, "game-ai-thinking");
    await user.selectOptions(select, "lobby-default");

    await waitFor(() => {
      expect(disposalAwaitedOrder).toContain("lobby-default");
    });

    expect(activeSessions.size).toBeLessThanOrEqual(1);
  });

  it("serializes session replacement when earlier disposal is held unresolved while multiple transitions arrive", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const activeSessions = new Set<string>();
    const disposedSessions = new Set<string>();
    let resolveInitialDisposal!: () => void;
    const initialDisposalPromise = new Promise<void>((r) => {
      resolveInitialDisposal = r;
    });

    const sessionFactory: SessionFactory = (scenario) => {
      const snapshot = new DemoSession("lobby-default").getSnapshot();
      return {
        getSnapshot: () => snapshot,
        subscribe: () => () => undefined,
        start: async () => {
          activeSessions.add(scenario);
        },
        getLegalMoves: () => [],
        move: async () => ({ accepted: false, error: { code: "invalid_move", message: "err", retryable: false } }),
        leave: async () => undefined,
        dispose: async () => {
          if (scenario === "lobby-default") {
            await initialDisposalPromise;
          }
          activeSessions.delete(scenario);
          disposedSessions.add(scenario);
        },
      };
    };

    render(<App initialScenario="lobby-default" sessionFactory={sessionFactory} />);

    // Initial session is running
    expect(activeSessions.has("lobby-default")).toBe(true);

    const select = screen.getByRole("combobox", { name: /Kịch bản demo/i });
    // Queue rapid transitions while lobby-default disposal is unresolved
    await user.selectOptions(select, "game-active-a");
    await user.selectOptions(select, "game-ai-thinking");
    await user.selectOptions(select, "game-reconnecting");

    // While initial disposal is held, no second session should be running
    expect(activeSessions.size).toBe(1);
    expect(activeSessions.has("lobby-default")).toBe(true);
    expect(activeSessions.has("game-reconnecting")).toBe(false);

    // Now resolve initial disposal
    resolveInitialDisposal();

    // After queue drains, only the final generation (game-reconnecting) should be active
    await waitFor(() => {
      expect(activeSessions.has("game-reconnecting")).toBe(true);
    });

    expect(activeSessions.size).toBe(1);
    expect(disposedSessions.has("lobby-default")).toBe(true);
  });

  it("disposes the currently active session on unmount using activeSessionRef", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const onlineSessionDisposed = vi.fn();
    const snapshot = new DemoSession("lobby-default").getSnapshot();
    const onlineSession: GameSession = {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
      start: async () => undefined,
      getLegalMoves: () => [],
      move: async () => ({ accepted: false, error: { code: "invalid_move", message: "err", retryable: false } }),
      leave: async () => undefined,
      dispose: onlineSessionDisposed,
    };
    const onlineSessionFactory = vi.fn(() => onlineSession);
    const gateway = { available: true, listRooms: vi.fn(async () => ({ available: true, rooms: [] })) } as unknown as OnlineLobbyGateway;

    const { unmount } = render(
      <App initialScenario="lobby-default" onlineGateway={gateway} onlineSessionFactory={onlineSessionFactory} />
    );

    await user.type(screen.getByRole("textbox", { name: "Tên của bạn" }), "An");
    await user.click(screen.getByRole("button", { name: /Tạo phòng/i }));
    await waitFor(() => expect(onlineSessionFactory).toHaveBeenCalledTimes(1));

    unmount();

    await waitFor(() => expect(onlineSessionDisposed).toHaveBeenCalledTimes(1));
  });

  it("respects single-provider boundary: does not poll listActiveMatches when Task 7 is blocked", async () => {
    const listActiveMatches = vi.fn();
    const gateway = {
      available: true,
      listRooms: vi.fn(async () => ({ available: true, rooms: [] })),
      listActiveMatches,
    } as unknown as OnlineLobbyGateway;

    render(<App initialScenario="lobby-default" onlineGateway={gateway} />);

    expect(screen.getByText("Danh sách trận đang diễn ra hiện không khả dụng.")).toBeInTheDocument();
    expect(listActiveMatches).not.toHaveBeenCalled();
  });

  it("survives StrictMode effect replay and disposes the runtime only on real unmount", async () => {
    const runtime = {
      bootstrap: vi.fn(async () => undefined),
      connectionFactory: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    const onlineSessionFactory = vi.fn(() => fakeSession().session);
    const gateway = { available: true, listRooms: vi.fn(async () => ({ available: true, rooms: [] })) } as unknown as OnlineLobbyGateway;
    const { unmount } = render(
      <StrictMode>
        <App initialScenario="lobby-default" runtime={runtime} onlineGateway={gateway} onlineSessionFactory={onlineSessionFactory} />
      </StrictMode>,
    );

    await waitFor(() => expect(screen.getByTestId("app-state")).toHaveAttribute("data-state", "lobby"));
    expect(runtime.dispose).not.toHaveBeenCalled();
    const user = (await import("@testing-library/user-event")).default.setup();
    await user.type(screen.getByRole("textbox", { name: "Tên của bạn" }), "An");
    await user.click(screen.getByRole("button", { name: /Tạo phòng/i }));
    await waitFor(() => expect(onlineSessionFactory).toHaveBeenCalledTimes(1));

    unmount();
    await waitFor(() => expect(runtime.dispose).toHaveBeenCalledTimes(1));
  });

  it("replaces a runtime owner after commit without stranding the previous owner", async () => {
    const firstRuntime = { bootstrap: vi.fn(), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) };
    const secondRuntime = { bootstrap: vi.fn(), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) };
    const gateway = { available: false, listRooms: vi.fn(async () => ({ available: false, rooms: [] })) } as unknown as OnlineLobbyGateway;
    const view = render(<App initialScenario="lobby-default" runtime={firstRuntime} onlineGateway={gateway} />);

    view.rerender(<App initialScenario="lobby-default" runtime={secondRuntime} onlineGateway={gateway} />);

    await waitFor(() => expect(firstRuntime.dispose).toHaveBeenCalledTimes(1));
    expect(secondRuntime.dispose).not.toHaveBeenCalled();
    view.unmount();
  });

  it("closes the lobby stream before requesting a spectator ticket and passes the exact allocation to the session", async () => {
    const events: string[] = [];
    const allocation = Object.freeze({ allocationId: "alloc-1", room: "room-1", ticket: "ticket-1" });
    const stream = {
      start: vi.fn(async () => { events.push("stream-start"); }),
      dispose: vi.fn(async () => { events.push("stream-dispose"); }),
      subscribe: vi.fn(() => () => undefined),
      getSnapshot: vi.fn(() => ({ status: "ready", matches: [], catalogRevision: 1 })),
    };
    const session = fakeSession();
    session.session.start = vi.fn(async (options) => {
      events.push("session-start");
      expect(options).toEqual({ mode: "spectator", allocation });
      expect((options as { readonly allocation: unknown }).allocation).toBe(allocation);
    });
    const runtime = { bootstrap: vi.fn(), connectionFactory: vi.fn(), dispose: vi.fn(async () => { events.push("runtime-dispose"); }) };
    const coordinator = new AppLifecycleCoordinator({
      runtime: runtime as any,
      gateway: { getSpectatorTicket: vi.fn(async () => { events.push("ticket"); return allocation; }) } as any,
      createLobbyStream: () => stream as any,
    });

    await coordinator.transition({
      factory: () => fakeSession().session,
      options: { mode: "demo", scenario: "lobby-default" },
      openLobbyStream: true,
      onSession: () => undefined,
      onLobbyStream: () => undefined,
    });
    await coordinator.transition({
      factory: () => session.session,
      options: { mode: "spectator", allocationId: "alloc-1", roomId: "room-1" },
      onSession: (next) => expect(next).toBe(session.session),
      onLobbyStream: () => undefined,
    });

    expect(events.indexOf("stream-dispose")).toBeLessThan(events.indexOf("ticket"));
    expect(events.indexOf("ticket")).toBeLessThan(events.indexOf("session-start"));
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
    expect(stream.dispose).toHaveBeenCalledTimes(1);
  });

  it("reopens the lobby stream when the spectator ticket fails and ignores stale transition callbacks", async () => {
    const callbacks: string[] = [];
    const streams = [0, 1].map(() => ({
      start: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
      subscribe: vi.fn(() => () => undefined),
      getSnapshot: vi.fn(() => ({ status: "ready", matches: [], catalogRevision: 1 })),
    }));
    const coordinator = new AppLifecycleCoordinator({
      runtime: { bootstrap: vi.fn(), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) } as any,
      gateway: { getSpectatorTicket: vi.fn(async () => { throw new Error("ticket failed"); }) } as any,
      createLobbyStream: () => streams.shift() as any,
    });

    await coordinator.transition({
      factory: () => fakeSession().session,
      options: { mode: "demo", scenario: "lobby-default" },
      openLobbyStream: true,
      onSession: () => callbacks.push("old-session"),
      onLobbyStream: () => callbacks.push("old-stream"),
    });
    const staleTransition = coordinator.transition({
      factory: () => fakeSession().session,
      options: { mode: "spectator", allocationId: "alloc-1", roomId: "room-1" },
      onSession: () => callbacks.push("stale-session"),
      onLobbyStream: () => callbacks.push("reopened-stream"),
    });
    const currentTransition = coordinator.transition({
      factory: () => fakeSession().session,
      options: { mode: "demo", scenario: "lobby-default" },
      openLobbyStream: true,
      onSession: () => callbacks.push("current-session"),
      onLobbyStream: () => callbacks.push("current-stream"),
    });

    await Promise.all([staleTransition, currentTransition]);
    expect(callbacks).not.toContain("stale-session");
    expect(callbacks).not.toContain("reopened-stream");
    expect(callbacks).toContain("current-session");
    expect(callbacks).toContain("current-stream");
  });

  it("reopens a fresh lobby stream after a current spectator ticket failure", async () => {
    const firstStream = {
      start: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
      subscribe: vi.fn(() => () => undefined),
      getSnapshot: vi.fn(() => ({ status: "ready", matches: [], catalogRevision: 1 })),
    };
    const reopenedStream = {
      start: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
      subscribe: vi.fn(() => () => undefined),
      getSnapshot: vi.fn(() => ({ status: "ready", matches: [], catalogRevision: 2 })),
    };
    const lobbySession = fakeSession().session;
    const spectatorFactory = vi.fn(() => fakeSession().session);
    let streamCount = 0;
    const coordinator = new AppLifecycleCoordinator({
      runtime: { bootstrap: vi.fn(), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) } as any,
      gateway: { getSpectatorTicket: vi.fn(async () => { throw new Error("ticket failed"); }) } as any,
      createLobbyStream: () => streamCount++ === 0 ? firstStream as any : reopenedStream as any,
    });

    await coordinator.transition({
      factory: () => lobbySession,
      options: { mode: "demo", scenario: "lobby-default" },
      openLobbyStream: true,
      onSession: () => undefined,
      onLobbyStream: () => undefined,
    });
    await coordinator.transition({
      factory: spectatorFactory,
      options: { mode: "spectator", allocationId: "alloc-1", roomId: "room-1" },
      lobby: {
        factory: () => lobbySession,
        options: { mode: "demo", scenario: "lobby-default" },
      },
      onSession: () => undefined,
      onLobbyStream: () => undefined,
    });

    expect(firstStream.dispose).toHaveBeenCalledTimes(1);
    expect(reopenedStream.start).toHaveBeenCalledTimes(1);
    expect(spectatorFactory).not.toHaveBeenCalled();
  });

  it("fails closed when a transition supplies an unvalidated spectator allocation", async () => {
    const sessionFactory = vi.fn(() => fakeSession().session);
    const getSpectatorTicket = vi.fn(async () => ({
      allocationId: "alloc-1",
      room: "room-1",
      ticket: "ticket-1",
    }));
    const coordinator = new AppLifecycleCoordinator({
      runtime: { bootstrap: vi.fn(), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) } as any,
      gateway: { getSpectatorTicket } as any,
      createLobbyStream: () => ({
        start: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined),
        subscribe: vi.fn(() => () => undefined),
        getSnapshot: vi.fn(() => ({ status: "unavailable", matches: [], catalogRevision: -1 })),
      }) as any,
    });

    await coordinator.transition({
      factory: sessionFactory,
      options: { mode: "spectator", allocation: { allocationId: "alloc-1", room: "room-1" } } as any,
      onSession: () => undefined,
      onLobbyStream: () => undefined,
    });

    expect(getSpectatorTicket).not.toHaveBeenCalled();
    expect(sessionFactory).not.toHaveBeenCalled();
  });

  it("does not create fallback lobby providers after a stale ticket failure", async () => {
    let rejectTicket!: (error: Error) => void;
    const getSpectatorTicket = vi.fn(() => new Promise<never>((_, reject) => { rejectTicket = reject; }));
    const lobbyFactory = vi.fn(() => fakeSession().session);
    const createLobbyStream = vi.fn(() => ({
      start: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
      subscribe: vi.fn(() => () => undefined),
      getSnapshot: vi.fn(() => ({ status: "ready", matches: [], catalogRevision: 1 })),
    })) as any;
    const coordinator = new AppLifecycleCoordinator({
      runtime: { bootstrap: vi.fn(), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) } as any,
      gateway: { getSpectatorTicket } as any,
      createLobbyStream,
    });
    const transition = coordinator.transition({
      factory: () => { throw new Error("stale spectator factory must not run"); },
      options: { mode: "spectator", allocationId: "alloc-1", roomId: "room-1" },
      lobby: {
        factory: lobbyFactory,
        options: { mode: "demo", scenario: "lobby-default" },
      },
      onSession: () => undefined,
      onLobbyStream: () => undefined,
    });

    await Promise.resolve();
    const disposal = coordinator.dispose();
    rejectTicket(new Error("stale ticket failure"));
    await Promise.all([transition, disposal]);

    expect(lobbyFactory).not.toHaveBeenCalled();
    expect(createLobbyStream).not.toHaveBeenCalled();
  });

  it("does not let a hung spectator ticket block a newer transition or dispose", async () => {
    let resolveTicket!: (value: unknown) => void;
    const ticket = new Promise((resolve) => { resolveTicket = resolve; });
    const spectatorFactory = vi.fn(() => fakeSession().session);
    const replacementFactory = vi.fn(() => fakeSession().session);
    const coordinator = new AppLifecycleCoordinator({
      runtime: { bootstrap: vi.fn(), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) } as any,
      gateway: { getSpectatorTicket: vi.fn(() => ticket) } as any,
      createLobbyStream: () => { throw new Error("not used"); },
    });

    const spectatorTransition = coordinator.transition({
      factory: spectatorFactory,
      options: { mode: "spectator", allocationId: "alloc-1", roomId: "room-1" },
      onSession: () => undefined,
      onLobbyStream: () => undefined,
    });
    await Promise.resolve();
    const replacementTransition = coordinator.transition({
      factory: replacementFactory,
      options: { mode: "demo", scenario: "lobby-default" },
      onSession: () => undefined,
      onLobbyStream: () => undefined,
    });

    await replacementTransition;
    expect(replacementFactory).toHaveBeenCalledTimes(1);
    await coordinator.dispose();
    resolveTicket({ allocationId: "alloc-1", room: "room-1", ticket: "late-ticket" });
    await spectatorTransition;
    expect(spectatorFactory).not.toHaveBeenCalled();
  });

  it("does not let a hung session start block a newer transition or disposal", async () => {
    let resolveHungStart!: () => void;
    const hungStart = new Promise<void>((resolve) => { resolveHungStart = resolve; });
    const started: string[] = [];
    let sessionCount = 0;
    const makeSession = (name: string): GameSession => ({
      getSnapshot: () => new DemoSession("lobby-default").getSnapshot(),
      subscribe: () => () => undefined,
      start: async () => {
        started.push(name);
        if (name === "hung") await hungStart;
      },
      getLegalMoves: () => [],
      move: async () => ({ accepted: false, error: { code: "invalid_move", message: "err", retryable: false } }),
      leave: async () => undefined,
      dispose: vi.fn(async () => undefined),
    });
    const coordinator = new AppLifecycleCoordinator({
      runtime: { bootstrap: vi.fn(), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) } as any,
      gateway: {} as any,
      createLobbyStream: () => { throw new Error("not used"); },
    });

    const first = coordinator.transition({
      factory: () => makeSession(sessionCount++ === 0 ? "hung" : "replacement"),
      options: { mode: "demo", scenario: "lobby-default" },
      onSession: () => undefined,
      onLobbyStream: () => undefined,
    });
    await Promise.resolve();
    const second = coordinator.transition({
      factory: () => makeSession("replacement-2"),
      options: { mode: "demo", scenario: "game-active-a" },
      onSession: () => undefined,
      onLobbyStream: () => undefined,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(started).toContain("replacement-2");
    } finally {
      resolveHungStart();
      await Promise.all([first, second, coordinator.dispose()]);
    }
  });

  it("does not let a hung lobby stream start block a newer transition", async () => {
    let resolveStreamStart!: () => void;
    const hungStreamStart = new Promise<void>((resolve) => { resolveStreamStart = resolve; });
    const streams = [
      {
        start: vi.fn(() => hungStreamStart),
        dispose: vi.fn(async () => undefined),
        subscribe: vi.fn(() => () => undefined),
        getSnapshot: vi.fn(() => ({ status: "loading", matches: [], catalogRevision: -1 })),
      },
      {
        start: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined),
        subscribe: vi.fn(() => () => undefined),
        getSnapshot: vi.fn(() => ({ status: "ready", matches: [], catalogRevision: 1 })),
      },
    ];
    const started: string[] = [];
    const coordinator = new AppLifecycleCoordinator({
      runtime: { bootstrap: vi.fn(), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) } as any,
      gateway: {} as any,
      createLobbyStream: () => streams.shift() as any,
    });

    const first = coordinator.transition({
      factory: () => fakeSession().session,
      options: { mode: "demo", scenario: "lobby-default" },
      openLobbyStream: true,
      onSession: () => { started.push("first"); },
      onLobbyStream: () => undefined,
    });
    await Promise.resolve();
    const second = coordinator.transition({
      factory: () => fakeSession().session,
      options: { mode: "demo", scenario: "game-active-a" },
      onSession: () => { started.push("second"); },
      onLobbyStream: () => undefined,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(started).toContain("second");
    } finally {
      resolveStreamStart();
      await Promise.all([first, second, coordinator.dispose()]);
    }
  });

  it("disposes failed session and stream ownership after reporting errors", async () => {
    const runtime = { bootstrap: vi.fn(), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) };
    const session = fakeSession();
    const sessionError = new Error("session start failed");
    session.session.start = vi.fn(async () => { throw sessionError; });
    const stream = {
      start: vi.fn(async () => { throw new Error("stream start failed"); }),
      dispose: vi.fn(async () => undefined),
      subscribe: vi.fn(() => () => undefined),
      getSnapshot: vi.fn(() => ({ status: "loading", matches: [], catalogRevision: -1 })),
    };
    const errors: unknown[] = [];
    const coordinator = new AppLifecycleCoordinator({
      runtime: runtime as any,
      gateway: {} as any,
      createLobbyStream: () => stream as any,
    });

    await coordinator.transition({
      factory: () => session.session,
      options: { mode: "online", intent: "create", playerName: "A" },
      onSession: () => undefined,
      onLobbyStream: () => undefined,
      onError: (cause) => errors.push(cause),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors).toContain(sessionError);
    expect(session.controls.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.dispose).toHaveBeenCalledTimes(1);

    const streamErrors: unknown[] = [];
    await coordinator.transition({
      factory: () => fakeSession().session,
      options: { mode: "demo", scenario: "lobby-default" },
      openLobbyStream: true,
      onSession: () => undefined,
      onLobbyStream: () => undefined,
      onError: (cause) => streamErrors.push(cause),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(streamErrors[0]).toBeInstanceOf(Error);
    expect(stream.dispose).toHaveBeenCalledTimes(1);
  });

  it("does not let an older start failure dispose a reused session owner", async () => {
    let rejectFirstStart!: (cause: Error) => void;
    const session = fakeSession();
    session.session.start = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectFirstStart = reject; }))
      .mockResolvedValueOnce(undefined);
    const coordinator = new AppLifecycleCoordinator({
      runtime: { bootstrap: vi.fn(), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) } as any,
      gateway: {} as any,
      createLobbyStream: () => { throw new Error("not used"); },
    });

    const first = coordinator.transition({ factory: () => session.session, options: { mode: "demo", scenario: "lobby-default" }, onSession: () => undefined, onLobbyStream: () => undefined });
    await Promise.resolve();
    await coordinator.transition({ factory: () => session.session, options: { mode: "demo", scenario: "game-active-a" }, onSession: () => undefined, onLobbyStream: () => undefined });
    session.controls.dispose.mockClear();
    rejectFirstStart(new Error("stale start failure"));
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.controls.dispose).not.toHaveBeenCalled();
  });

  it("waits for stale owner disposal before reusing the same session", async () => {
    let rejectFirstStart!: (cause: Error) => void;
    let resolveDispose!: () => void;
    const session = fakeSession();
    session.session.start = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectFirstStart = reject; }))
      .mockResolvedValue(undefined);
    session.session.dispose = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveDispose = resolve; }))
      .mockResolvedValue(undefined);
    const coordinator = new AppLifecycleCoordinator({
      runtime: { bootstrap: vi.fn(), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) } as any,
      gateway: {} as any,
      createLobbyStream: () => { throw new Error("not used"); },
    });

    const first = coordinator.transition({
      factory: () => session.session,
      options: { mode: "online", intent: "create", playerName: "A" },
      onSession: () => undefined,
      onLobbyStream: () => undefined,
    });
    await first;
    rejectFirstStart(new Error("stale start failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.session.dispose).toHaveBeenCalledTimes(1);

    const second = coordinator.transition({
      factory: () => session.session,
      options: { mode: "online", intent: "create", playerName: "B" },
      onSession: () => undefined,
      onLobbyStream: () => undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.session.start).toHaveBeenCalledTimes(1);

    resolveDispose();
    await second;
    expect(session.session.start).toHaveBeenCalledTimes(2);
    await coordinator.dispose();
  });

  it("does not let an older stream start failure dispose a reused stream owner", async () => {
    let rejectFirstStart!: (cause: Error) => void;
    const stream = {
      start: vi.fn()
        .mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectFirstStart = reject; }))
        .mockResolvedValueOnce(undefined),
      dispose: vi.fn(async () => undefined),
      subscribe: vi.fn(() => () => undefined),
      getSnapshot: vi.fn(() => ({ status: "loading", matches: [], catalogRevision: -1 })),
    };
    const coordinator = new AppLifecycleCoordinator({
      runtime: { bootstrap: vi.fn(), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) } as any,
      gateway: {} as any,
      createLobbyStream: () => stream as any,
    });

    const first = coordinator.transition({ factory: () => fakeSession().session, options: { mode: "demo", scenario: "lobby-default" }, openLobbyStream: true, onSession: () => undefined, onLobbyStream: () => undefined });
    await Promise.resolve();
    await coordinator.transition({ factory: () => fakeSession().session, options: { mode: "demo", scenario: "game-active-a" }, openLobbyStream: true, onSession: () => undefined, onLobbyStream: () => undefined });
    stream.dispose.mockClear();
    rejectFirstStart(new Error("stale stream failure"));
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stream.dispose).not.toHaveBeenCalled();
  });

  it("passes a non-owning runtime facade to custom lobby streams", async () => {
    const runtime = { bootstrap: vi.fn(), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) };
    let streamRuntime: any;
    const stream = {
      start: vi.fn(async () => undefined),
      dispose: vi.fn(async () => { await streamRuntime.dispose(); }),
      subscribe: vi.fn(() => () => undefined),
      getSnapshot: vi.fn(() => ({ status: "ready", matches: [], catalogRevision: 1 })),
    };
    const coordinator = new AppLifecycleCoordinator({
      runtime: runtime as any,
      gateway: {} as any,
      createLobbyStream: (owner) => { streamRuntime = owner; return stream as any; },
    });

    await coordinator.transition({
      factory: () => fakeSession().session,
      options: { mode: "demo", scenario: "lobby-default" },
      openLobbyStream: true,
      onSession: () => undefined,
      onLobbyStream: () => undefined,
    });
    await coordinator.dispose();

    expect(stream.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });

  it("uses updated gateway and lobby stream dependencies for later transitions", async () => {
    const runtime = { bootstrap: vi.fn(), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) };
    const firstGateway = { getSpectatorTicket: vi.fn(async () => { throw new Error("stale gateway"); }) };
    const secondGateway = { getSpectatorTicket: vi.fn(async () => ({ allocationId: "alloc-1", room: "room-1", ticket: "ticket-1" })) };
    const firstStream = { start: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined), subscribe: vi.fn(() => () => undefined), getSnapshot: vi.fn(() => ({ status: "ready", matches: [], catalogRevision: 1 })) };
    const secondStream = { start: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined), subscribe: vi.fn(() => () => undefined), getSnapshot: vi.fn(() => ({ status: "ready", matches: [], catalogRevision: 2 })) };
    const firstFactory = vi.fn(() => firstStream as any);
    const secondFactory = vi.fn(() => secondStream as any);
    const startedOptions: unknown[] = [];
    const session = fakeSession().session;
    session.start = vi.fn(async (options) => { startedOptions.push(options); });
    const coordinator = new AppLifecycleCoordinator({ runtime: runtime as any, gateway: firstGateway as any, createLobbyStream: firstFactory });
    coordinator.updateDependencies({ runtime, gateway: secondGateway as any, createLobbyStream: secondFactory });

    await coordinator.transition({
      factory: () => session,
      options: { mode: "spectator", allocationId: "alloc-1", roomId: "room-1" },
      onSession: () => undefined,
      onLobbyStream: () => undefined,
    });
    await coordinator.transition({
      factory: () => fakeSession().session,
      options: { mode: "demo", scenario: "lobby-default" },
      openLobbyStream: true,
      onSession: () => undefined,
      onLobbyStream: () => undefined,
    });

    expect(firstGateway.getSpectatorTicket).not.toHaveBeenCalled();
    expect(secondGateway.getSpectatorTicket).toHaveBeenCalledWith("alloc-1");
    expect(startedOptions[0]).toEqual({ mode: "spectator", allocation: { allocationId: "alloc-1", room: "room-1", ticket: "ticket-1" } });
    expect(firstFactory).not.toHaveBeenCalled();
    expect(secondFactory).toHaveBeenCalledTimes(1);
  });

  it("does not retire the currently selected runtime during A-to-B-to-A replacement", async () => {
    const runtimeA = { bootstrap: vi.fn(), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) };
    const runtimeB = { bootstrap: vi.fn(), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) };
    const coordinator = new AppLifecycleCoordinator({ runtime: runtimeA as any, gateway: {} as any, createLobbyStream: () => { throw new Error("not used"); } });

    coordinator.updateDependencies({ runtime: runtimeB as any, gateway: {} as any, createLobbyStream: () => { throw new Error("not used"); } });
    coordinator.updateDependencies({ runtime: runtimeA as any, gateway: {} as any, createLobbyStream: () => { throw new Error("not used"); } });
    await coordinator.transition({ factory: () => fakeSession().session, options: { mode: "demo", scenario: "lobby-default" }, onSession: () => undefined, onLobbyStream: () => undefined });

    expect(runtimeA.dispose).not.toHaveBeenCalled();
    expect(runtimeB.dispose).toHaveBeenCalledTimes(1);
    await coordinator.dispose();
  });

  it("disposes an idle runtime after dependency replacement", async () => {
    const runtimeA = { bootstrap: vi.fn(), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) };
    const runtimeB = { bootstrap: vi.fn(), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) };
    const coordinator = new AppLifecycleCoordinator({ runtime: runtimeA as any, gateway: {} as any, createLobbyStream: () => { throw new Error("not used"); } });

    coordinator.updateDependencies({ runtime: runtimeB as any, gateway: {} as any, createLobbyStream: () => { throw new Error("not used"); } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtimeA.dispose).toHaveBeenCalledTimes(1);
    expect(runtimeB.dispose).not.toHaveBeenCalled();
    await coordinator.dispose();
  });

  it("waits for an in-flight runtime retirement before reusing that runtime", async () => {
    let resolveDispose!: () => void;
    const retirement = new Promise<void>((resolve) => { resolveDispose = resolve; });
    const runtimeA = { bootstrap: vi.fn(), connectionFactory: vi.fn(), dispose: vi.fn(() => retirement) };
    const runtimeB = { bootstrap: vi.fn(), connectionFactory: vi.fn(), dispose: vi.fn(async () => undefined) };
    const started: string[] = [];
    const session = fakeSession();
    session.session.start = vi.fn(async () => { started.push("started"); });
    const coordinator = new AppLifecycleCoordinator({ runtime: runtimeA as any, gateway: {} as any, createLobbyStream: () => { throw new Error("not used"); } });

    coordinator.updateDependencies({ runtime: runtimeB as any, gateway: {} as any, createLobbyStream: () => { throw new Error("not used"); } });
    await Promise.resolve();
    expect(runtimeA.dispose).toHaveBeenCalledTimes(1);

    coordinator.updateDependencies({ runtime: runtimeA as any, gateway: {} as any, createLobbyStream: () => { throw new Error("not used"); } });
    const transition = coordinator.transition({
      factory: () => session.session,
      options: { mode: "online", intent: "create", playerName: "An" },
      onSession: () => undefined,
      onLobbyStream: () => undefined,
    });
    await Promise.resolve();
    expect(started).toEqual([]);

    resolveDispose();
    await transition;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["started"]);
    await coordinator.dispose();
  });
});
