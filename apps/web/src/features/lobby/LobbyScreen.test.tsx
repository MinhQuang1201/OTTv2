import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LobbyScreen } from "./LobbyScreen";
import type { WaitingRoomState } from "./WaitingRoomList";

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
    expect(props.onJoinOnline).toHaveBeenCalledWith("", "550e8400-e29b-41d4-a716-446655440000");
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
});
