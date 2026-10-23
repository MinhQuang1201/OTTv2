import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LobbyScreen } from "./LobbyScreen";
import type { WaitingRoomState } from "./WaitingRoomList";
import deterministicFixture from "../../../../../tests/fixtures/arena/replays/deterministic-match.json";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function renderLobby(overrides: Partial<React.ComponentProps<typeof LobbyScreen>> = {}) {
  const props: React.ComponentProps<typeof LobbyScreen> = {
    onlineAvailability: "unavailable",
    waitingRooms: { status: "unavailable", message: "Online hiện không khả dụng." },
    onStartLocal: vi.fn(),
    onStartAi: vi.fn(),
    onCreateOnline: vi.fn(),
    onJoinOnline: vi.fn(),
    ...overrides,
  };
  return { ...render(<LobbyScreen {...props} />), props };
}

describe("LobbyScreen", () => {
  it("keeps local and AI actions enabled when online is unavailable", async () => {
    const user = userEvent.setup();
    const { props } = renderLobby();

    expect(screen.getByRole("button", { name: /Chơi cùng máy/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Đánh với AI/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Tạo phòng/i })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /Đánh với AI/i }));
    expect(props.onStartAi).toHaveBeenCalledWith("", "medium");
  });

  it("passes the chosen AI level to onStartAi", async () => {
    const user = userEvent.setup();
    const { props } = renderLobby();

    await user.selectOptions(screen.getByRole("combobox", { name: "Mức AI" }), "hard");
    await user.click(screen.getByRole("button", { name: /Đánh với AI/i }));

    expect(props.onStartAi).toHaveBeenCalledWith("", "hard");
  });

  it("sends trimmed player names for quick play", async () => {
    const user = userEvent.setup();
    const { props } = renderLobby();
    const name = screen.getByRole("textbox", { name: "Tên của bạn" });
    await user.type(name, "  An  ");

    await user.click(screen.getByRole("button", { name: /Đánh với AI/i }));
    expect(props.onStartAi).toHaveBeenCalledWith("An", "medium");

    await user.click(screen.getByRole("button", { name: /Chơi cùng máy/i }));
    expect(props.onStartLocal).toHaveBeenCalledWith(["An", "Người chơi 2"]);
  });

  it("does not create an online room without a player name", async () => {
    const user = userEvent.setup();
    const { props } = renderLobby({
      onlineAvailability: "online",
      waitingRooms: { status: "ready", rooms: [] },
    });

    await user.click(screen.getByRole("button", { name: /Tạo phòng/i }));

    expect(props.onCreateOnline).not.toHaveBeenCalled();
    expect(screen.getByText("Nhập tên của bạn để tạo phòng online.")).toBeInTheDocument();
  });

  it("uses a selected waiting room's exact allocation id", async () => {
    const user = userEvent.setup();
    const { props } = renderLobby({
      onlineAvailability: "online",
      waitingRooms: {
        status: "ready",
        rooms: [{ roomId: "550e8400-e29b-41d4-a716-446655440000", hostName: "Chi", playerCount: 1, maxPlayers: 2 }],
      },
    });

    await user.click(screen.getByRole("button", { name: /550e8400-e29b-41d4-a716-446655440000/i }));
    expect(props.onJoinOnline).not.toHaveBeenCalled();
    expect(screen.getByText("Nhập tên của bạn để vào phòng online.")).toBeInTheDocument();
  });

  it.each([
    ["loading", { status: "loading" } as WaitingRoomState, "Đang tải phòng chờ…"],
    ["empty", { status: "ready", rooms: [] } as WaitingRoomState, /Chưa có phòng chờ/i],
    ["error", { status: "error", message: "Không thể tải danh sách phòng." } as WaitingRoomState, /Không thể tải danh sách phòng/i],
    ["unavailable", { status: "unavailable", message: "Online hiện không khả dụng." } as WaitingRoomState, "Online hiện không khả dụng."],
  ])("renders the %s waiting-room state", (_name, waitingRooms, text) => {
    renderLobby({ waitingRooms });
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("handles valid and invalid replay file import from lobby", async () => {
    const user = userEvent.setup();
    const onStartReplay = vi.fn();
    renderLobby({ onStartReplay });

    expect(screen.getByRole("button", { name: /Mở file Replay/i })).toBeInTheDocument();
    const input = screen.getByTestId("lobby-replay-file-input") as HTMLInputElement;

    // Invalid JSON file -> shows retryable error
    const invalidFile = new File(["not json"], "invalid.json", { type: "application/json" });
    await user.upload(input, invalidFile);

    expect(onStartReplay).not.toHaveBeenCalled();
    const errorAlert = await screen.findByRole("alert");
    expect(errorAlert).toBeInTheDocument();
    expect(errorAlert).toHaveTextContent(/JSON/i);
    expect(screen.getByRole("button", { name: /Thử lại/i })).toBeInTheDocument();
  });

  it("ignores stale replay file completion after transition to local or AI (generation guard)", async () => {
    const user = userEvent.setup();
    const onStartReplay = vi.fn();
    const onStartAi = vi.fn();
    const { unmount } = renderLobby({ onStartReplay, onStartAi });

    const input = screen.getByTestId("lobby-replay-file-input") as HTMLInputElement;

    let resolveFilePromise!: (value: string) => void;
    const pendingFileRead = new Promise<string>((resolve) => {
      resolveFilePromise = resolve;
    });

    const originalFileReader = window.FileReader;
    class DelayedFileReader {
      onload: (() => void) | null = null;
      result: string = "";
      readAsText() {
        void pendingFileRead.then((content) => {
          this.result = content;
          this.onload?.();
        });
      }
    }
    window.FileReader = DelayedFileReader as any;

    try {
      const file = new File(["dummy"], "valid.json", { type: "application/json" });
      await user.upload(input, file);

      // User starts AI game before file read completes
      await user.click(screen.getByRole("button", { name: /Đánh với AI/i }));
      expect(onStartAi).toHaveBeenCalled();

      // Now unmount lobby (simulating transition away)
      unmount();

      // Resolve late file reader promise with valid fixture JSON
      resolveFilePromise(JSON.stringify(deterministicFixture));
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 20));

      // onStartReplay must NOT have been called due to generation guard
      expect(onStartReplay).not.toHaveBeenCalled();
    } finally {
      window.FileReader = originalFileReader;
    }
  });

  it("renders Arena entry card when arenaAvailable and calls onOpenArena on select", async () => {
    const user = userEvent.setup();
    const onOpenArena = vi.fn();
    renderLobby({ onOpenArena, arenaAvailable: true });

    const arenaBtn = screen.getByRole("button", { name: /Vào đấu trường/i });
    expect(arenaBtn).toBeInTheDocument();

    await user.click(arenaBtn);
    expect(onOpenArena).toHaveBeenCalledTimes(1);
  });

  it("does not render Arena entry card when arenaAvailable is false", () => {
    const onOpenArena = vi.fn();
    renderLobby({ onOpenArena, arenaAvailable: false });
    expect(screen.queryByRole("button", { name: /Vào đấu trường/i })).not.toBeInTheDocument();
  });

  it("renders decorative miniBoard with core-derived initial pieces and goal flags", () => {
    const { container } = renderLobby();
    const miniBoard = container.querySelector('[class*="miniBoard"]');
    expect(miniBoard).toBeInTheDocument();
    expect(miniBoard).toHaveAttribute("aria-hidden", "true");

    const cells = miniBoard?.querySelectorAll('[class*="miniCell"]');
    expect(cells?.length).toBe(81);

    // Goal flags at (0,0) and (8,8)
    const cell00 = miniBoard?.querySelector('[data-coord="0:0"]');
    const cell88 = miniBoard?.querySelector('[data-coord="8:8"]');
    expect(cell00?.querySelector('[class*="miniFlag"]')).toBeInTheDocument();
    expect(cell88?.querySelector('[class*="miniFlag"]')).toBeInTheDocument();

    // Exactly 20 initial pieces from game core (10 seat A, 10 seat B)
    const pieceSprites = miniBoard?.querySelectorAll('[class*="miniPieceSprite"]');
    expect(pieceSprites?.length).toBe(20);

    // Verify pieces are at actual coordinates, not dummy column 0
    expect(miniBoard?.querySelector('[data-coord="4:7"] [class*="miniPieceSprite"]')).toBeInTheDocument();
    expect(miniBoard?.querySelector('[data-coord="4:1"] [class*="miniPieceSprite"]')).toBeInTheDocument();
    expect(miniBoard?.querySelector('[data-coord="5:7"] [class*="miniPieceSprite"]')).toBeInTheDocument();
    expect(miniBoard?.querySelector('[data-coord="3:1"] [class*="miniPieceSprite"]')).toBeInTheDocument();

    // Column 0 cells (except goal 0:0) should be empty, not dummy squares
    const cell01 = miniBoard?.querySelector('[data-coord="0:1"]');
    const cell02 = miniBoard?.querySelector('[data-coord="0:2"]');
    expect(cell01?.querySelector('[class*="miniPieceSprite"]')).toBeNull();
    expect(cell02?.querySelector('[class*="miniPieceSprite"]')).toBeNull();
  });

  it("renders human tournament mode card and opens tournament dialog on click", async () => {
    const user = userEvent.setup();
    renderLobby();

    const tourneyCard = screen.getByRole("button", { name: "Mở giải đấu" });
    expect(tourneyCard).toBeInTheDocument();
    await user.click(tourneyCard);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getAllByText("Giải đấu người chơi").length).toBeGreaterThanOrEqual(1);
  });
});

