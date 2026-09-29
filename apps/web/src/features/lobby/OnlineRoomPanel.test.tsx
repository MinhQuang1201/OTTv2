// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
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
    render(<OnlineRoomPanel availability="unavailable" waitingRooms={waitingRooms} publicMatches={{ status: "ready", matches: [] }} onCreate={vi.fn()} onJoin={onJoin} />);

    const roomButton = screen.getByRole("button", { name: /allocation-7/i });
    expect(roomButton).toBeDisabled();
    await user.click(roomButton);
    expect(onJoin).not.toHaveBeenCalled();
  });

  it("disables active-match watching while online is unavailable", () => {
    render(<OnlineRoomPanel availability="unavailable" publicMatches={{ status: "ready", matches: [{
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
    }] }} onWatch={vi.fn()} onCreate={vi.fn()} onJoin={vi.fn()} />);

    expect(screen.getByRole("button", { name: /Xem trận.*An.*Bình/i })).toBeDisabled();
  });

  it("allows active-match watching in demo mode while online is unavailable", async () => {
    const user = userEvent.setup();
    const onWatch = vi.fn();
    render(<OnlineRoomPanel availability="unavailable" allowDemoWatch publicMatches={{ status: "ready", matches: [{
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
    }] }} onWatch={onWatch} onCreate={vi.fn()} onJoin={vi.fn()} />);

    const watchButton = screen.getByRole("button", { name: /Xem trận.*An.*Bình/i });
    expect(watchButton).not.toBeDisabled();
    await user.click(watchButton);
    expect(onWatch).toHaveBeenCalledWith({ allocationId: "allocation-7", roomId: "room-7" });
  });

  it("leaves room creation and waiting-room selection disabled even when allowDemoWatch is true", () => {
    render(<OnlineRoomPanel availability="unavailable" allowDemoWatch waitingRooms={{
      status: "ready",
      rooms: [{ roomId: "room-1", hostName: "Host", playerCount: 1, maxPlayers: 2 }],
    }} onCreate={vi.fn()} onJoin={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Tạo phòng" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Vào phòng" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /room-1/i })).toBeDisabled();
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
