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
    expect(props.onStartAi).toHaveBeenCalledWith("");
  });

  it("sends trimmed player names for quick play", async () => {
    const user = userEvent.setup();
    const { props } = renderLobby();
    const name = screen.getByRole("textbox", { name: "Tên của bạn" });
    await user.type(name, "  An  ");

    await user.click(screen.getByRole("button", { name: /Đánh với AI/i }));
    expect(props.onStartAi).toHaveBeenCalledWith("An");

    await user.click(screen.getByRole("button", { name: /Chơi cùng máy/i }));
    expect(props.onStartLocal).toHaveBeenCalledWith(["An", "Đối thủ"]);
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
});
