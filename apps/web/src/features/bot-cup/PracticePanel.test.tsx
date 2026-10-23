// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotCupApiError, type BotCupApiGateway, type Leaderboard, type MatchView, type MyMatches } from "./BotCupApiGateway";
import { LeaderboardPanel } from "./LeaderboardPanel";
import { PracticePanel } from "./PracticePanel";
import { resultLabel } from "./matchFormat";

const NOW = Date.UTC(2026, 11, 1, 3, 0);
const opponents = [{ id: "easy", name: "AI Dễ" }, { id: "hard", name: "AI Khó" }];

function match(overrides: Partial<MatchView> = {}): MatchView {
  return {
    id: "m1", stage: "practice", round: null, gameIndex: 0, mapId: "classic", status: "finished",
    seats: { A: { kind: "team", name: "Đội Alpha", version: 1 }, B: { kind: "house", name: "AI Khó", house: "hard" } },
    mySeat: "A", outcome: "win", winner: "A", reason: "goal", plies: 31, createdAt: NOW, finishedAt: NOW, ...overrides,
  };
}

function data(matches: MatchView[], usedToday = 0): MyMatches {
  return { matches, practice: { gamesPerDay: 20, usedToday, opponents, maps: ["classic", "flanks", "center"] } };
}

function gatewayWith(overrides: Record<string, unknown>) {
  return overrides as unknown as BotCupApiGateway;
}

describe("PracticePanel", () => {
  afterEach(cleanup);

  it("asks for two games against the chosen house bot and map", async () => {
    const user = userEvent.setup();
    const listMatches = vi.fn().mockResolvedValueOnce(data([])).mockResolvedValueOnce(data([match({ status: "queued", outcome: null, winner: null, reason: null, plies: null })], 2));
    const requestPractice = vi.fn().mockResolvedValue({ matches: [] });
    render(<PracticePanel gateway={gatewayWith({ listMatches, requestPractice })} onSignedOut={vi.fn()} />);

    await screen.findByText("Chưa có trận nào.");
    await user.selectOptions(screen.getByLabelText("Đối thủ"), "hard");
    await user.selectOptions(screen.getByLabelText("Bản đồ"), "flanks");
    await user.click(screen.getByRole("button", { name: "Đấu 2 ván" }));
    expect(requestPractice).toHaveBeenCalledWith("hard", "flanks");
    expect(await screen.findByText(/Đã xếp 2 ván luyện tập/)).toBeInTheDocument();
    expect(screen.getByText("Đang chờ máy chấm")).toBeInTheDocument();
    expect(screen.getByText("Hôm nay: 2/20 ván.")).toBeInTheDocument();
  });

  it("explains a refused request in Vietnamese", async () => {
    const user = userEvent.setup();
    const listMatches = vi.fn().mockResolvedValue(data([], 20));
    const requestPractice = vi.fn().mockRejectedValue(new BotCupApiError(409, "practice_not_ready"));
    render(<PracticePanel gateway={gatewayWith({ listMatches, requestPractice })} onSignedOut={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Đấu 2 ván" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Bản thi đấu chưa qua kiểm tra");
  });

  it("opens a finished game's replay and shows only the team's own stderr", async () => {
    const user = userEvent.setup();
    const replay = { schemaVersion: 1 };
    const onOpenReplay = vi.fn();
    const gateway = gatewayWith({
      listMatches: vi.fn().mockResolvedValue(data([match(), match({ id: "m2", mySeat: "B", winner: "A", outcome: "forfeit", reason: "turn_timeout" })])),
      getMatchReplay: vi.fn().mockResolvedValue({ replay, sha256: "x" }),
      getMatch: vi.fn().mockResolvedValue({ match: { ...match({ id: "m2", mySeat: "B" }), stderr: { B: "depth 3\n" } } }),
    });
    render(<PracticePanel gateway={gateway} onSignedOut={vi.fn()} onOpenReplay={onOpenReplay} />);
    const items = await screen.findAllByRole("listitem");
    expect(within(items[0]).getByText("Thắng · vào ô thắng")).toBeInTheDocument();
    expect(within(items[1]).getByText("Thua · bot quá giờ một nước")).toBeInTheDocument();
    await user.click(within(items[0]).getByRole("button", { name: "Xem replay" }));
    expect(onOpenReplay).toHaveBeenCalledWith(replay);
    await user.click(within(items[1]).getByRole("button", { name: "Log stderr" }));
    expect(await screen.findByText("depth 3")).toBeInTheDocument();
  });

  it("labels results from the team's side", () => {
    expect(resultLabel({ status: "finished", outcome: "forfeit", winner: "A", reason: "illegal_move", mySeat: "A" })).toBe("Thắng · đối thủ nước không hợp lệ");
    expect(resultLabel({ status: "finished", outcome: "draw", winner: null, reason: "max_plies", mySeat: "B" })).toBe("Hòa · đủ 300 nước");
    expect(resultLabel({ status: "finished", outcome: "win", winner: "B", reason: "elimination", mySeat: null })).toBe("Xanh thắng · tiêu diệt hết quân");
    expect(resultLabel({ status: "failed", outcome: null, winner: null, reason: null, mySeat: "A" })).toMatch(/Lỗi máy chấm/);
  });
});

describe("LeaderboardPanel", () => {
  afterEach(cleanup);

  it("shows each team's points per house bot", async () => {
    const board: Leaderboard = {
      opponents,
      rows: [
        { rank: 1, displayName: "Đội Beta", games: 4, points: 2.5, opponents: { easy: { played: 2, points: 2 }, hard: { played: 2, points: 0.5 } } },
        { rank: 2, displayName: "Đội Alpha", games: 2, points: 2, opponents: { easy: { played: 2, points: 2 }, hard: { played: 0, points: 0 } } },
      ],
      updatedAt: NOW,
    };
    render(<LeaderboardPanel gateway={gatewayWith({ getLeaderboard: vi.fn().mockResolvedValue(board) })} />);
    const rows = await screen.findAllByRole("row");
    expect(within(rows[0]).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["#", "Đội", "AI Dễ", "AI Khó", "Số ván"]);
    expect(within(rows[1]).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["1", "2/2", "0,5/2", "4"]);
    expect(within(rows[2]).getByRole("rowheader")).toHaveTextContent("Đội Alpha");
    expect(within(rows[2]).getAllByRole("cell")[2]).toHaveTextContent("—");
  });

  it("says so when nobody has practised yet", async () => {
    render(<LeaderboardPanel gateway={gatewayWith({ getLeaderboard: vi.fn().mockResolvedValue({ opponents, rows: [], updatedAt: NOW }) })} />);
    expect(await screen.findByText("Chưa có đội nào đấu luyện tập.")).toBeInTheDocument();
  });
});
