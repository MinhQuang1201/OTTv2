import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicMatchView } from "../../shared/model/game";
import styles from "../lobby/lobby.module.css";
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

  it("filters malformed and duplicate runtime matches into a safe empty state", () => {
    const malformed = [
      { allocationId: "missing-players", roomId: "room-1", status: "playing" },
      { allocationId: "negative-viewers", roomId: "room-2", status: "playing", players: {}, spectatorCount: -1 },
      { allocationId: "not-playing", roomId: "room-3", status: "finished", players: {}, spectatorCount: 0 },
    ];

    render(<PublicMatchList state={{ status: "ready", matches: malformed as unknown as readonly PublicMatchView[] }} onWatch={vi.fn()} />);

    expect(screen.getByText("Chưa có trận đang diễn ra.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Xem trận/i })).not.toBeInTheDocument();
  });

  it("deduplicates valid matches by allocation and room identity", () => {
    const duplicateAllocation = { ...matches[0], roomId: "room-8" };
    const duplicateRoom = { ...matches[0], allocationId: "allocation-8" };
    render(<PublicMatchList state={{ status: "ready", matches: [matches[0]!, duplicateAllocation, duplicateRoom] }} onWatch={vi.fn()} />);

    expect(screen.getAllByRole("button", { name: /Xem trận/i })).toHaveLength(1);
  });

  it("uses a working match-button class and unique heading ids per instance", () => {
    render(
      <>
        <PublicMatchList state={{ status: "ready", matches }} onWatch={vi.fn()} />
        <PublicMatchList state={{ status: "ready", matches }} onWatch={vi.fn()} />
      </>,
    );

    const sections = screen.getAllByTestId("public-match-list");
    const headings = screen.getAllByRole("heading", { name: "Trận đang diễn ra" });
    expect(headings[0]).toHaveAttribute("id");
    expect(headings[0]!.id).not.toBe(headings[1]!.id);
    expect(sections[0]).toHaveAttribute("aria-labelledby", headings[0]!.id);
    expect(sections[1]).toHaveAttribute("aria-labelledby", headings[1]!.id);
    expect(screen.getAllByRole("button", { name: /Xem trận/i })[0]).toHaveClass(styles.matchWatchButton);
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
