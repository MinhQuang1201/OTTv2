// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompetitionRounds } from "./CompetitionRounds";
import type { CompetitionAggregateStanding, CompetitionRoundItem } from "./types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CompetitionRounds", () => {
  const mockRounds: CompetitionRoundItem[] = [
    {
      roundNumber: 1,
      tournamentId: "tourn-round-1",
      status: "completed",
      byes: ["bot-odd-bye"],
      warnings: [],
      pairings: [
        { scheduleIndex: 0, botAId: "bot-alpha", botBId: "bot-beta" },
        { scheduleIndex: 1, botAId: "bot-gamma", botBId: "bot-delta" },
      ],
    },
    {
      roundNumber: 2,
      tournamentId: "tourn-round-2",
      status: "running",
      byes: [],
      warnings: ["Tái đấu bắt buộc do thiếu ứng viên khả dụng"],
      pairings: [
        { scheduleIndex: 0, botAId: "bot-alpha", botBId: "bot-gamma" },
        { scheduleIndex: 1, botAId: "bot-beta", botBId: "bot-delta" },
      ],
    },
  ];

  const mockStandings: CompetitionAggregateStanding[] = [
    { botId: "bot-alpha", botName: "AlphaBot", points: 6, played: 2, wins: 2, draws: 0, losses: 0, byeCount: 0, seatBalance: 0, rank: 1 },
    { botId: "bot-odd-bye", botName: "OddBot", points: 3, played: 1, wins: 0, draws: 0, losses: 1, byeCount: 1, seatBalance: 1, rank: 2 },
    { botId: "bot-beta", botName: "BetaBot", points: 3, played: 2, wins: 1, draws: 0, losses: 1, byeCount: 0, seatBalance: -1, rank: 3 },
  ];

  it("renders round tabs, displays active round details and switches between rounds", () => {
    render(
      <CompetitionRounds
        competitionId="comp-1"
        phase="running"
        configuration={{
          formatId: "swiss",
          mapId: "classic",
          mode: "ranked",
          currentRound: 2,
          roundCount: 4,
        }}
        rounds={mockRounds}
        standings={mockStandings}
        isAdmin={true}
        actionLoading={false}
        onNextRound={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    // Initial selected round is Round 2 (currentRound)
    expect(screen.getByText("Tiến độ vòng đấu: Vòng 2 / 4")).toBeInTheDocument();
    expect(screen.getByText(/Chi tiết Vòng 2 — Giải đấu:/i)).toBeInTheDocument();
    expect(screen.getByText("Tái đấu bắt buộc do thiếu ứng viên khả dụng")).toBeInTheDocument();

    // Click tab for Round 1
    const tabRound1 = screen.getByRole("tab", { name: /Vòng 1/i });
    fireEvent.click(tabRound1);

    expect(screen.getByText(/Chi tiết Vòng 1 — Giải đấu:/i)).toBeInTheDocument();
    expect(screen.getByRole("status", { name: /danh sách bot nhận điểm miễn đấu/i })).toHaveTextContent(/Bot.*bot-odd-bye.*\(\+3 điểm\)/i);
  });

  it.each(["single-round-robin", "double-round-robin"] as const)("shows a zero-point rest for %s", (formatId) => {
    render(
      <CompetitionRounds
        competitionId="comp-rest"
        phase="running"
        configuration={{ formatId, mapId: "classic", mode: "ranked", currentRound: 1, roundCount: 3 }}
        rounds={[mockRounds[0]]}
        isAdmin={false}
        actionLoading={false}
        onNextRound={vi.fn()}
        onRefresh={vi.fn()}
      />
    );
    const rest = screen.getByRole("status", { name: /danh sách bot nhận điểm miễn đấu/i });
    expect(rest).toHaveTextContent("Nghỉ vòng:");
    expect(rest).toHaveTextContent("(0 điểm)");
    expect(rest).not.toHaveTextContent("+3 điểm");
  });

  it("renders aggregate standings table with points, wins, and byes", () => {
    render(
      <CompetitionRounds
        competitionId="comp-1"
        phase="running"
        configuration={{
          formatId: "swiss",
          mapId: "classic",
          mode: "ranked",
          currentRound: 1,
          roundCount: 3,
        }}
        rounds={mockRounds}
        standings={mockStandings}
        isAdmin={false}
        actionLoading={false}
        onNextRound={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.getByText("Bảng xếp hạng tổng hợp (3 bot)")).toBeInTheDocument();
    expect(screen.getByText("AlphaBot")).toBeInTheDocument();
    expect(screen.getByText("OddBot")).toBeInTheDocument();
    expect(screen.getByText("BetaBot")).toBeInTheDocument();

    const standingsTable = screen.getByRole("table", { name: /bảng xếp hạng tổng hợp/i });
    const rows = within(standingsTable).getAllByRole("row");

    // Row 0 is header; Row 1 is AlphaBot (rank 1)
    const alphaCells = within(rows[1]).getAllByRole("cell");
    expect(alphaCells[0]).toHaveTextContent("#1");
    expect(alphaCells[1]).toHaveTextContent("AlphaBot");
    expect(alphaCells[2]).toHaveTextContent("6");
    expect(alphaCells[3]).toHaveTextContent("2"); // played cell
    expect(alphaCells[4]).toHaveTextContent("2"); // wins cell
    expect(alphaCells[5]).toHaveTextContent("0"); // draws cell
    expect(alphaCells[6]).toHaveTextContent("0"); // losses cell
    expect(alphaCells[7]).toHaveTextContent("0"); // byeCount cell

    // Row 2 is OddBot (rank 2) with a nonzero bye
    const oddCells = within(rows[2]).getAllByRole("cell");
    expect(oddCells[0]).toHaveTextContent("#2");
    expect(oddCells[1]).toHaveTextContent("OddBot");
    expect(oddCells[2]).toHaveTextContent("3");
    expect(oddCells[3]).toHaveTextContent("1"); // played cell
    expect(oddCells[4]).toHaveTextContent("0"); // wins cell
    expect(oddCells[5]).toHaveTextContent("0"); // draws cell
    expect(oddCells[6]).toHaveTextContent("1"); // losses cell
    expect(oddCells[7]).toHaveTextContent("1"); // nonzero byeCount cell
  });

  it("disables Next Round button when current round is not yet completed", () => {
    const onNextRound = vi.fn();
    render(
      <CompetitionRounds
        competitionId="comp-1"
        phase="running"
        configuration={{
          formatId: "swiss",
          mapId: "classic",
          mode: "ranked",
          currentRound: 2, // round 2 is 'running', not 'completed'
          roundCount: 4,
        }}
        rounds={mockRounds}
        standings={mockStandings}
        isAdmin={true}
        actionLoading={false}
        onNextRound={onNextRound}
        onRefresh={vi.fn()}
      />
    );

    const nextBtn = screen.getByRole("button", { name: /bắt đầu vòng 3/i });
    expect(nextBtn).toBeDisabled();

    fireEvent.click(nextBtn);
    expect(onNextRound).not.toHaveBeenCalled();
    expect(screen.getByText(/Vòng 2 đang diễn ra hoặc chưa hoàn tất/i)).toBeInTheDocument();
  });

  it("enables Next Round button and sends the current round as the CAS expectedRound", async () => {
    const onNextRound = vi.fn().mockResolvedValue(undefined);
    // When round 2 is completed:
    const completedRounds: CompetitionRoundItem[] = [
      mockRounds[0],
      { ...mockRounds[1], status: "completed" },
    ];

    render(
      <CompetitionRounds
        competitionId="comp-1"
        phase="running"
        configuration={{
          formatId: "swiss",
          mapId: "classic",
          mode: "ranked",
          currentRound: 2,
          roundCount: 4,
        }}
        rounds={completedRounds}
        standings={mockStandings}
        isAdmin={true}
        actionLoading={false}
        onNextRound={onNextRound}
        onRefresh={vi.fn()}
      />
    );

    const nextBtn = screen.getByRole("button", { name: /bắt đầu vòng 3/i });
    expect(nextBtn).toBeEnabled();

    fireEvent.click(nextBtn);
    await waitFor(() => {
      expect(onNextRound).toHaveBeenCalledWith(2);
    });
  });

  it("displays completed message instead of Next Round button when final round is reached", () => {
    render(
      <CompetitionRounds
        competitionId="comp-1"
        phase="running"
        configuration={{
          formatId: "swiss",
          mapId: "classic",
          mode: "ranked",
          currentRound: 4, // final round
          roundCount: 4,
        }}
        rounds={[...mockRounds, { roundNumber: 3, tournamentId: "t-3", status: "completed" }, { roundNumber: 4, tournamentId: "t-4", status: "completed" }]}
        standings={mockStandings}
        isAdmin={true}
        actionLoading={false}
        onNextRound={vi.fn()}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.queryByRole("button", { name: /bắt đầu vòng 5/i })).not.toBeInTheDocument();
    expect(screen.getByText("Đã hoàn tất các vòng")).toBeInTheDocument();
  });

  it("triggers onRefresh callback when refresh button is clicked", () => {
    const onRefresh = vi.fn();
    render(
      <CompetitionRounds
        competitionId="comp-1"
        phase="running"
        configuration={{
          formatId: "double-round-robin",
          mapId: "classic",
          mode: "ranked",
          currentRound: 1,
        }}
        rounds={mockRounds}
        isAdmin={false}
        actionLoading={false}
        onNextRound={vi.fn()}
        onRefresh={onRefresh}
      />
    );

    const refreshBtn = screen.getByRole("button", { name: /làm mới tiến độ vòng đấu/i });
    fireEvent.click(refreshBtn);
    expect(onRefresh).toHaveBeenCalled();
  });
});
