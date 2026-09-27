import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicMatchView } from "../../shared/model/game";
import { PublicMatchList, type PublicMatchListState } from "./PublicMatchList";

afterEach(() => cleanup());

const matches: readonly PublicMatchView[] = [{
  allocationId: "allocation-7",
  roomId: "room-7",
  status: "playing",
  players: {
    A: { seat: "A", name: "An", connected: true, remainingMs: 540_000 },
    B: { seat: "B", name: "Bình", connected: false, remainingMs: 510_000 },
  },
  spectatorCount: 12,
  serverNow: 1_790_000_000_000,
  runningSeat: "A",
}];

describe("PublicMatchList", () => {
  it("renders active games separately with public match details and a watch action", () => {
    render(<PublicMatchList state={{ status: "ready", matches }} onWatch={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Trận đang diễn ra" })).toBeInTheDocument();
    expect(screen.getByText("An")).toBeInTheDocument();
    expect(screen.getByText("Bình")).toBeInTheDocument();
    expect(screen.getByLabelText("Thời gian còn lại của An: 09:00")).toBeInTheDocument();
    expect(screen.getByLabelText("Thời gian còn lại của Bình: 08:30")).toBeInTheDocument();
    expect(screen.getByText("Đã kết nối")).toBeInTheDocument();
    expect(screen.getByText("Mất kết nối")).toBeInTheDocument();
    expect(screen.getByText("12 người xem")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Xem trận.*An.*Bình/i })).toBeInTheDocument();
  });

  it("emits only the public match identity and never the player name", async () => {
    const user = userEvent.setup();
    const onWatch = vi.fn();
    render(<PublicMatchList state={{ status: "ready", matches }} onWatch={onWatch} />);

    await user.click(screen.getByRole("button", { name: /Xem trận.*An.*Bình/i }));

    expect(onWatch).toHaveBeenCalledWith({ allocationId: "allocation-7", roomId: "room-7" });
    expect(onWatch).not.toHaveBeenCalledWith(expect.objectContaining({ playerName: expect.anything() }));
  });

  it.each([
    ["loading", { status: "loading" } as PublicMatchListState, "Đang tải trận đang diễn ra…"],
    ["unavailable", { status: "unavailable", message: "Danh sách trận đang diễn ra hiện không khả dụng." } as PublicMatchListState, "Danh sách trận đang diễn ra hiện không khả dụng."],
    ["error", { status: "error", message: "Không thể tải trận đang diễn ra." } as PublicMatchListState, "Không thể tải trận đang diễn ra."],
    ["empty", { status: "ready", matches: [] } as PublicMatchListState, /Chưa có trận đang diễn ra/i],
  ])("renders the %s public-match state", (_name, state, text) => {
    render(<PublicMatchList state={state} onWatch={vi.fn()} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});
