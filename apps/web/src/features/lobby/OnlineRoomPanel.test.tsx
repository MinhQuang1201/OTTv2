import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnlineRoomPanel } from "./OnlineRoomPanel";
import type { WaitingRoomState } from "./WaitingRoomList";

afterEach(() => cleanup());

describe("OnlineRoomPanel", () => {
  it("requires a nonempty room id before joining", async () => {
    const user = userEvent.setup();
    const onJoin = vi.fn();
    render(<OnlineRoomPanel availability="online" onCreate={vi.fn()} onJoin={onJoin} />);

    await user.click(screen.getByRole("button", { name: "Vào phòng" }));
    expect(screen.getByText("Nhập mã phòng để tham gia.")).toBeInTheDocument();
    expect(onJoin).not.toHaveBeenCalled();
  });

  it("trims names and room ids before creating or joining", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const onJoin = vi.fn();
    render(<OnlineRoomPanel availability="online" onCreate={onCreate} onJoin={onJoin} />);

    await user.type(screen.getByRole("textbox", { name: "Tên của bạn" }), "  Bình ");
    await user.click(screen.getByRole("button", { name: "Tạo phòng" }));
    expect(onCreate).toHaveBeenCalledWith("Bình");

    await user.type(screen.getByRole("textbox", { name: "Mã phòng" }), "  room-7  ");
    await user.click(screen.getByRole("button", { name: "Vào phòng" }));
    expect(onJoin).toHaveBeenCalledWith("Bình", "room-7");
  });
  it("disables waiting-room selection while online is unavailable", async () => {
    const user = userEvent.setup();
    const onJoin = vi.fn();
    const waitingRooms: WaitingRoomState = {
      status: "ready",
      rooms: [{ roomId: "allocation-7", hostName: "Host", playerCount: 1, maxPlayers: 2 }],
    };
    render(<OnlineRoomPanel availability="unavailable" waitingRooms={waitingRooms} onCreate={vi.fn()} onJoin={onJoin} />);

    const roomButton = screen.getByRole("button", { name: /allocation-7/i });
    expect(roomButton).toBeDisabled();
    await user.click(roomButton);
    expect(onJoin).not.toHaveBeenCalled();
  });
});
