import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GameScreen } from "./GameScreen";
import { DemoSession } from "../../sessions/demo/DemoSession";
import { AppProviders } from "../../app/AppProviders";
import * as soundSynthesis from "../../shared/audio/soundSynthesis";

describe("GameScreen", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  it("shows the table HUD, side rail, and leaves local games directly", async () => {
    const user = userEvent.setup();
    const session = new DemoSession("game-active-a");
    const onLobby = vi.fn();
    render(<AppProviders><GameScreen session={session} snapshot={session.getSnapshot()} onLobby={onLobby} /></AppProviders>);

    expect(screen.getByRole("heading", { name: /bàn chơi/i })).toBeInTheDocument();
    expect(screen.getByText("An")).toBeInTheDocument();
    expect(screen.getByText("Bình")).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: /lịch sử nước đi/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /rời bàn/i }));
    expect(onLobby).toHaveBeenCalledTimes(1);
  });

  it("requires confirmation before leaving an online game", async () => {
    const user = userEvent.setup();
    const session = new DemoSession("game-active-a");
    const leave = vi.spyOn(session, "leave");
    const snapshot = { ...session.getSnapshot(), mode: "online" as const, capabilities: { ...session.getSnapshot().capabilities, canLeaveGame: true } };
    vi.spyOn(session, "getSnapshot").mockReturnValue(snapshot);
    render(<AppProviders><GameScreen session={session} snapshot={snapshot} onLobby={vi.fn()} /></AppProviders>);

    await user.click(screen.getByRole("button", { name: /rời bàn/i }));
    expect(leave).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: /rời bàn/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^xác nhận rời bàn$/i }));
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it("renders truth-based HUD values and excludes unsupported actions", () => {
    const session = new DemoSession("game-active-a");
    const snapshot = {
      ...session.getSnapshot(),
      roomId: "room-42",
      connection: "online" as const,
    };
    vi.spyOn(session, "getSnapshot").mockReturnValue(snapshot);
    render(
      <AppProviders>
        <GameScreen session={session} snapshot={snapshot} onLobby={vi.fn()} />
      </AppProviders>,
    );

    expect(screen.getByTestId("room-label")).toHaveTextContent("Phòng room-42");
    expect(screen.getByText("Đã kết nối")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /rời bàn/i })).toBeInTheDocument();

    // Verify mockup-only unsupported actions are not rendered
    expect(screen.queryByRole("button", { name: /xin hòa/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /2d \/ 3d/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cài đặt/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /xin lùi nước/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /đầu hàng/i })).not.toBeInTheDocument();
  });

  it("renders spectators as read-only viewers with neutral labels and exits without leaving", async () => {
    const user = userEvent.setup();
    const session = new DemoSession("spectator-active");
    const leave = vi.spyOn(session, "leave");
    const onLobby = vi.fn();
    render(<AppProviders><GameScreen session={session} snapshot={session.getSnapshot()} onLobby={onLobby} /></AppProviders>);

    expect(screen.getByText("Đang xem trực tiếp")).toBeInTheDocument();
    expect(screen.getByText("12 đang xem")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rời chế độ xem" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Lượt của An");
    expect(screen.queryByText("Đến lượt bạn")).not.toBeInTheDocument();
    expect(screen.queryByText("Đối thủ đang đi")).not.toBeInTheDocument();
    expect(screen.queryByText("Bạn")).not.toBeInTheDocument();
    expect(screen.queryByText("Đối thủ")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Rời chế độ xem" }));
    expect(onLobby).toHaveBeenCalledTimes(1);
    expect(leave).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: /rời bàn/i })).not.toBeInTheDocument();
  });

  it("uses the spectator reconnecting copy", () => {
    const session = new DemoSession("spectator-reconnecting");
    render(<AppProviders><GameScreen session={session} snapshot={session.getSnapshot()} onLobby={vi.fn()} /></AppProviders>);

    expect(screen.getByRole("status")).toHaveTextContent("Đang kết nối lại luồng trực tiếp...");
  });

  it("keeps spectator status neutral while player-only work is pending", () => {
    const session = new DemoSession("spectator-active");
    const snapshot = { ...session.getSnapshot(), pendingMove: true, aiThinking: true };
    vi.spyOn(session, "getSnapshot").mockReturnValue(snapshot);
    render(<AppProviders><GameScreen session={session} snapshot={snapshot} onLobby={vi.fn()} /></AppProviders>);

    expect(screen.getByRole("status")).toHaveTextContent("Lượt của An");
    expect(screen.queryByText("Đang xử lý nước đi…")).not.toBeInTheDocument();
    expect(screen.queryByText("AI đang suy nghĩ…")).not.toBeInTheDocument();
  });

  it("keeps the final spectator board inspectable after closing the neutral result", async () => {
    const user = userEvent.setup();
    const session = new DemoSession("spectator-finished");
    const snapshot = { ...session.getSnapshot(), result: { winner: "A" as const, reason: "goal" as const } };
    vi.spyOn(session, "getSnapshot").mockReturnValue(snapshot);
    render(<AppProviders><GameScreen session={session} snapshot={snapshot} onLobby={vi.fn()} /></AppProviders>);

    expect(screen.getByText("An thắng")).toBeInTheDocument();
    expect(screen.queryByText("Bạn thắng")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Xem bàn" }));
    expect(screen.getAllByRole("button", { name: /^Ô /i })).toHaveLength(81);
  });

  it("provides accessible flip perspective controls via button and keyboard shortcut F", async () => {
    const user = userEvent.setup();
    const session = new DemoSession("game-active-a");
    render(
      <AppProviders>
        <GameScreen session={session} snapshot={session.getSnapshot()} onLobby={vi.fn()} />
      </AppProviders>
    );

    const flipBtn = screen.getByTestId("game-flip-btn");
    expect(flipBtn).toBeInTheDocument();
    expect(flipBtn).toHaveAttribute("aria-pressed", "false");

    const cellsInitial = screen.getAllByRole("button", { name: /^Ô /i });
    expect(cellsInitial[0]).toHaveAttribute("data-testid", "board-cell-A1");

    // Click flip button in top bar
    await user.click(flipBtn);
    expect(flipBtn).toHaveAttribute("aria-pressed", "true");

    const cellsFlipped = screen.getAllByRole("button", { name: /^Ô /i });
    expect(cellsFlipped[0]).toHaveAttribute("data-testid", "board-cell-I9");
    expect(cellsFlipped[0]).toHaveAccessibleName(/^Ô I9/i);

    // Keyboard shortcut F toggles back
    fireEvent.keyDown(window, { key: "f" });
    expect(flipBtn).toHaveAttribute("aria-pressed", "false");

    const cellsRestored = screen.getAllByRole("button", { name: /^Ô /i });
    expect(cellsRestored[0]).toHaveAttribute("data-testid", "board-cell-A1");
  });

  it("provides accessible audio toggle controls via button and keyboard shortcut M", async () => {
    const user = userEvent.setup();
    const session = new DemoSession("game-active-a");
    render(
      <AppProviders>
        <GameScreen session={session} snapshot={session.getSnapshot()} onLobby={vi.fn()} />
      </AppProviders>
    );

    const soundBtn = screen.getByTestId("game-sound-toggle-btn");
    expect(soundBtn).toBeInTheDocument();
    expect(soundBtn).toHaveAttribute("aria-pressed", "false");

    // Click to enable audio
    await user.click(soundBtn);
    expect(soundBtn).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem("ott:audio-enabled")).toBe("true");

    // Shortcut M toggles off
    fireEvent.keyDown(window, { key: "m" });
    expect(soundBtn).toHaveAttribute("aria-pressed", "false");
    expect(localStorage.getItem("ott:audio-enabled")).toBe("false");
  });

  it("disables keyboard shortcuts while leave confirmation dialog is open", async () => {
    const user = userEvent.setup();
    const session = new DemoSession("game-active-a");
    const snapshot = {
      ...session.getSnapshot(),
      mode: "online" as const,
      capabilities: { ...session.getSnapshot().capabilities, canLeaveGame: true },
    };
    vi.spyOn(session, "getSnapshot").mockReturnValue(snapshot);
    render(
      <AppProviders>
        <GameScreen session={session} snapshot={snapshot} onLobby={vi.fn()} />
      </AppProviders>
    );

    const flipBtn = screen.getByTestId("game-flip-btn");
    expect(flipBtn).toHaveAttribute("aria-pressed", "false");

    await user.click(screen.getByRole("button", { name: /rời bàn/i }));
    expect(screen.getByRole("dialog", { name: /rời bàn/i })).toBeInTheDocument();

    // Press 'f' while dialog is open - must not flip
    fireEvent.keyDown(window, { key: "f" });
    expect(flipBtn).toHaveAttribute("aria-pressed", "false");
  });

  it("presents a new capture with a label, tray blink, announcement and readable history, then clears it", async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem("ott:audio-enabled", "true");
      const playSound = vi.spyOn(soundSynthesis, "playSynthesizedSound");
      const session = new DemoSession("game-capture");
      render(<AppProviders><GameScreen session={session} snapshot={session.getSnapshot()} onLobby={vi.fn()} /></AppProviders>);
      expect(screen.queryByTestId("capture-label")).not.toBeInTheDocument();

      await act(async () => {
        await session.move({ x: 1, y: 2 }, { x: 6, y: 5 });
      });

      expect(screen.getByTestId("capture-label")).toHaveTextContent(/ăn 📄 Lá$/);
      expect(within(screen.getByTestId("board-cell-G6")).getByTestId("capture-shatter")).toBeInTheDocument();
      expect(screen.getByTestId("capture-announcement")).toHaveTextContent(/Đỏ ăn Lá Xanh tại G6\.$/);
      expect(within(screen.getByTestId("captured-tray-A")).getByRole("list")).toHaveAccessibleName("Quân đã ăn: 2 Lá");
      expect(screen.getByTestId("captured-tray-A").querySelector("[data-newest='true']")).not.toBeNull();
      expect(within(screen.getByRole("complementary", { name: /lịch sử nước đi/i })).getAllByRole("listitem").at(-1)).toHaveAccessibleName(/^#2 Đỏ · .+ B3→G6 ăn Lá \(Xanh\)$/);
      // Demo sessions are not tied to one seat, so the neutral cue plays.
      expect(playSound).toHaveBeenCalledWith("capture");

      act(() => {
        vi.advanceTimersByTime(900);
      });
      expect(screen.queryByTestId("capture-label")).not.toBeInTheDocument();
      expect(screen.queryByTestId("capture-shatter")).not.toBeInTheDocument();
      expect(screen.getByTestId("captured-tray-A").querySelector("[data-newest='true']")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("plays a loss cue and buzzes when the viewer's piece is captured in an online game", async () => {
    localStorage.setItem("ott:audio-enabled", "true");
    const playSound = vi.spyOn(soundSynthesis, "playSynthesizedSound");
    const vibrate = vi.fn();
    Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
    const session = new DemoSession("game-capture");
    const demoSnapshot = session.getSnapshot.bind(session);
    const asOnline = new WeakMap<object, ReturnType<typeof demoSnapshot>>();
    vi.spyOn(session, "getSnapshot").mockImplementation(() => {
      const base = demoSnapshot();
      if (!asOnline.has(base)) asOnline.set(base, { ...base, mode: "online", viewerSeat: "B", viewer: { role: "player", seat: "B" } });
      return asOnline.get(base)!;
    });
    render(<AppProviders><GameScreen session={session} snapshot={session.getSnapshot()} onLobby={vi.fn()} /></AppProviders>);

    try {
      await act(async () => {
        await session.move({ x: 1, y: 2 }, { x: 6, y: 5 });
      });
      expect(playSound).toHaveBeenCalledWith("captureLoss");
      expect(vibrate).toHaveBeenCalledWith(30);
    } finally {
      Reflect.deleteProperty(navigator, "vibrate");
    }
  });

  it("labels a shared-screen game by seat colour instead of you/opponent or connection state", () => {
    const session = new DemoSession("game-active-a");
    const demo = session.getSnapshot();
    const snapshot = {
      ...demo,
      mode: "local" as const,
      connection: "offline" as const,
      roomId: null,
      turn: "B" as const,
      viewerSeat: "B" as const,
      viewer: { role: "player" as const, seat: "B" as const },
    };
    vi.spyOn(session, "getSnapshot").mockReturnValue(snapshot);
    render(<AppProviders><GameScreen session={session} snapshot={snapshot} onLobby={vi.fn()} /></AppProviders>);

    expect(screen.getByTestId("room-label")).toHaveTextContent("Hai người cùng máy");
    expect(screen.getByText("Chơi trên thiết bị")).toBeInTheDocument();
    expect(screen.queryByText("Ngoại tuyến")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(`Lượt của Xanh (${demo.players.B!.name})`);
    expect(screen.queryByText(/Đến lượt bạn|Đối thủ đang đi/)).not.toBeInTheDocument();
    expect(screen.getByText("Quân Đỏ")).toBeInTheDocument();
    expect(screen.getByText("Quân Xanh")).toBeInTheDocument();
    expect(screen.queryByText(/Đã kết nối|Mất kết nối/)).not.toBeInTheDocument();
  });

  it("names AI tables and keeps the viewer's turn wording", () => {
    const session = new DemoSession("game-active-a");
    const snapshot = { ...session.getSnapshot(), mode: "ai" as const, connection: "offline" as const, roomId: null };
    vi.spyOn(session, "getSnapshot").mockReturnValue(snapshot);
    render(<AppProviders><GameScreen session={session} snapshot={snapshot} onLobby={vi.fn()} /></AppProviders>);

    expect(screen.getByTestId("room-label")).toHaveTextContent("Đấu với AI");
    expect(screen.getByRole("status")).toHaveTextContent("Đến lượt bạn");
    expect(screen.queryByText(/Đã kết nối|Mất kết nối/)).not.toBeInTheDocument();
  });

  it("flags a disconnected online opponent on its player strip", () => {
    const session = new DemoSession("game-active-a");
    const demo = session.getSnapshot();
    const snapshot = { ...demo, mode: "online" as const, connection: "online" as const, players: { ...demo.players, B: { ...demo.players.B!, connected: false } } };
    vi.spyOn(session, "getSnapshot").mockReturnValue(snapshot);
    render(<AppProviders><GameScreen session={session} snapshot={snapshot} onLobby={vi.fn()} /></AppProviders>);

    const strip = screen.getByRole("region", { name: `Người chơi ${demo.players.B!.name}` });
    expect(strip).toHaveAttribute("data-connected", "false");
    expect(within(strip).getByText("Đối thủ · Mất kết nối")).toBeInTheDocument();
  });

  it("does not play audio on mount for pre-existing historical events", () => {
    localStorage.setItem("ott:audio-enabled", "true");
    const playSound = vi.spyOn(soundSynthesis, "playSynthesizedSound");
    const session = new DemoSession("result-goal");
    render(
      <AppProviders>
        <GameScreen session={session} snapshot={session.getSnapshot()} onLobby={vi.fn()} />
      </AppProviders>
    );

    expect(playSound).not.toHaveBeenCalled();
  });

  it("handles session swaps cleanly: no historical replay, triggers audio/highlight on new events, and preserves monotonicity across event eviction", async () => {
    localStorage.setItem("ott:audio-enabled", "true");
    const playSound = vi.spyOn(soundSynthesis, "playSynthesizedSound");

    // 1. Initial mount with active session: no historical sounds
    const session1 = new DemoSession("game-active-a");
    const { rerender } = render(
      <AppProviders>
        <GameScreen session={session1} snapshot={session1.getSnapshot()} onLobby={vi.fn()} />
      </AppProviders>
    );
    expect(playSound).not.toHaveBeenCalled();

    // 2. Swap to session 2 (finished goal match with terminal events): must NOT replay historical sounds
    const session2 = new DemoSession("result-goal");
    rerender(
      <AppProviders>
        <GameScreen session={session2} snapshot={session2.getSnapshot()} onLobby={vi.fn()} />
      </AppProviders>
    );
    expect(playSound).not.toHaveBeenCalled();

    // 3. Swap to session 3 (active game) and make a real legal move
    const session3 = new DemoSession("game-active-a");
    rerender(
      <AppProviders>
        <GameScreen session={session3} snapshot={session3.getSnapshot()} onLobby={vi.fn()} />
      </AppProviders>
    );
    expect(playSound).not.toHaveBeenCalled();

    // Move A3 to A2 ({ x: 0, y: 2 } to { x: 0, y: 1 })
    const moveResult = await session3.move({ x: 0, y: 2 }, { x: 0, y: 1 });
    expect(moveResult.accepted).toBe(true);

    // New event in session3 triggers sound!
    expect(playSound).toHaveBeenCalledWith("move");

    // Last move highlight is rendered on board
    expect(screen.getByTestId("board-cell-A3")).toHaveAttribute("data-last-move-from", "true");
    expect(screen.getByTestId("board-cell-A2")).toHaveAttribute("data-last-move-to", "true");

    // 4. Test bounded event collection eviction within the same session:
    // If the event collection in the snapshot shrinks or temporarily clears,
    // subsequent renders within the same session must NOT reset tracking downwards
    // and must NOT replay past events when re-presented.
    playSound.mockClear();
    const snapshotWithEvictedEvents = { ...session3.getSnapshot(), events: [] };
    rerender(
      <AppProviders>
        <GameScreen session={session3} snapshot={snapshotWithEvictedEvents} onLobby={vi.fn()} />
      </AppProviders>
    );
    expect(playSound).not.toHaveBeenCalled();

    // Re-render with previous events restored: still no replay
    rerender(
      <AppProviders>
        <GameScreen session={session3} snapshot={session3.getSnapshot()} onLobby={vi.fn()} />
      </AppProviders>
    );
    expect(playSound).not.toHaveBeenCalled();
  });
});
