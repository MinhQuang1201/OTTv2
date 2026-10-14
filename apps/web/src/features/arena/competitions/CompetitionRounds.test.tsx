// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    { botId: "bot-alpha", botName: "AlphaBot", points: 6, matchesPlayed: 2, wins: 2, draws: 0, losses: 0, byes: 0, rank: 1 },
    { botId: "bot-odd-bye", botName: "OddBot", points: 3, matchesPlayed: 1, wins: 0, draws: 0, losses: 1, byes: 1, rank: 2 },
    { botId: "bot-beta", botName: "BetaBot", points: 3, matchesPlayed: 2, wins: 1, draws: 0, losses: 1, byes: 0, rank: 3 },
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

  it("enables Next Round button and calls onNextRound with expectedRound when current round is completed", async () => {
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
      expect(onNextRound).toHaveBeenCalledWith(3);
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
