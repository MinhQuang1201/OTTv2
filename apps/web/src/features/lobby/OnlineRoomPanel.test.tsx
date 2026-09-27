import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnlineRoomPanel } from "./OnlineRoomPanel";
import type { WaitingRoomState } from "./WaitingRoomList";
import type { PublicMatchListState } from "../spectator/PublicMatchList";

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

  it("keeps active matches separate and watches without submitting the player name", async () => {
    const user = userEvent.setup();
    const onWatch = vi.fn();
    const publicMatches: PublicMatchListState = {
      status: "ready",
      matches: [{
        allocationId: "allocation-7",
        roomId: "room-7",
        status: "playing",
        players: {
          A: { seat: "A", name: "An", connected: true, remainingMs: 540_000 },
          B: { seat: "B", name: "Bình", connected: true, remainingMs: 510_000 },
        },
        spectatorCount: 3,
        serverNow: 1_790_000_000_000,
        runningSeat: "A",
      }],
    };
    render(<OnlineRoomPanel availability="online" playerName="Tên không được gửi" publicMatches={publicMatches} onWatch={onWatch} onCreate={vi.fn()} onJoin={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Phòng đang chờ" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Trận đang diễn ra" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Xem trận.*An.*Bình/i }));

    expect(onWatch).toHaveBeenCalledWith({ allocationId: "allocation-7", roomId: "room-7" });
    expect(onWatch).not.toHaveBeenCalledWith(expect.objectContaining({ playerName: expect.anything() }));
  });
});
