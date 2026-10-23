// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HumanTournamentDialog } from "./HumanTournamentDialog";
import type { HumanTournamentSummary } from "./types";

afterEach(() => cleanup());

describe("HumanTournamentDialog", () => {
  it("renders when open and closes on close button click", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<HumanTournamentDialog isOpen={true} onClose={onClose} onJoinMatch={vi.fn()} />);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Giải đấu người chơi")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Đóng" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape even when focus stayed outside the dialog", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<HumanTournamentDialog isOpen={true} onClose={onClose} onJoinMatch={vi.fn()} />);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape while closed", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<HumanTournamentDialog isOpen={false} onClose={onClose} onJoinMatch={vi.fn()} />);

    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not render when closed", () => {
    const { container } = render(<HumanTournamentDialog isOpen={false} onClose={vi.fn()} onJoinMatch={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("submits valid invite token or alias to onJoinMatch", async () => {
    const user = userEvent.setup();
    const onJoinMatch = vi.fn();
    render(<HumanTournamentDialog isOpen={true} onClose={vi.fn()} onJoinMatch={onJoinMatch} />);

    const input = screen.getByRole("textbox", { name: "Mã lời mời hoặc bí danh phòng" });
    await user.type(input, "  K7N-M4P  ");
    await user.click(screen.getByRole("button", { name: "Vào trận đấu" }));

    expect(onJoinMatch).toHaveBeenCalledWith("K7N-M4P");
  });

  it("ignores tournament details that resolve after the dialog is closed and reopened", async () => {
    const user = userEvent.setup();
    let resolveDetails!: (details: HumanTournamentSummary) => void;
    const mockGateway = {
      available: true,
      getTournamentDetails: vi.fn(() => new Promise<HumanTournamentSummary>((resolve) => {
        resolveDetails = resolve;
      })),
    };
    const reopenedGateway = { ...mockGateway };
    const tournament: HumanTournamentSummary = {
      tournamentId: "tourn-stale",
      name: "Giải cũ",
      organizer: { organizerId: "org-1", name: "Trọng tài" },
      formatId: "swiss",
      status: "registration",
      currentRoundNumber: 0,
      roundCount: 3,
      participantCount: 0,
      currentRoundMatches: [],
      standings: [],
      completedAt: null,
    };
    const reopenedTournament = { ...tournament, tournamentId: "tourn-new", name: "Giải mới" };

    const view = render(
      <HumanTournamentDialog
        isOpen={true}
        onClose={vi.fn()}
        onJoinMatch={vi.fn()}
        gateway={mockGateway as any}
      />
    );

    await user.type(screen.getByRole("textbox", { name: "Mã lời mời hoặc bí danh phòng" }), "tourn-stale");
    await user.click(screen.getByRole("button", { name: "Vào trận đấu" }));
    view.rerender(
      <HumanTournamentDialog
        isOpen={false}
        onClose={vi.fn()}
        onJoinMatch={vi.fn()}
        gateway={reopenedGateway as any}
        tournament={reopenedTournament}
      />
    );
    view.rerender(
      <HumanTournamentDialog
        isOpen={true}
        onClose={vi.fn()}
        onJoinMatch={vi.fn()}
        gateway={reopenedGateway as any}
        tournament={reopenedTournament}
      />
    );

    resolveDetails(tournament);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("Giải cũ")).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Bảng xếp hạng" }));
    expect(screen.getByText("Giải mới")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Bảng xếp hạng" })).toHaveAttribute("aria-selected", "true");
  });

  it("shows standings and current round matches on the view tab", async () => {
    const user = userEvent.setup();
    const sampleTournament: HumanTournamentSummary = {
      tournamentId: "t-1",
      name: "Cúp Oẳn Tù Tì",
      organizer: { organizerId: "org-1", name: "Trọng tài" },
      formatId: "swiss",
      status: "in_progress",
      currentRoundNumber: 1,
      roundCount: 3,
      participantCount: 2,
      currentRoundMatches: [
        {
          matchId: "m-1",
          roundNumber: 1,
          scheduleIndex: 0,
          participantA: { id: "p-1", name: "An" },
          participantB: { id: "p-2", name: "Bình" },
          status: "scheduled",
          result: null,
          winnerParticipantId: null,
          alias: "K7N-M4P",
          allocationId: "alloc-1",
        },
      ],
      standings: [
        {
          rank: 1,
          participantId: "p-1",
          name: "An",
          status: "active",
          matchesPlayed: 1,
          wins: 1,
          losses: 0,
          draws: 0,
          byes: 0,
          points: 1,
          buchholz: 0,
          sonnebornBerger: 0,
        },
      ],
      completedAt: null,
    };

    render(
      <HumanTournamentDialog
        isOpen={true}
        onClose={vi.fn()}
        onJoinMatch={vi.fn()}
        tournament={sampleTournament}
      />
    );

    await user.click(screen.getByRole("tab", { name: "Bảng xếp hạng" }));
    expect(screen.getByText("Cúp Oẳn Tù Tì")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getAllByText("An").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("vs")).toBeInTheDocument();
    expect(screen.getByText("Bình")).toBeInTheDocument();
  });

  it("creates a tournament through gateway with authentic server credentials", async () => {
    const user = userEvent.setup();
    const mockGateway = {
      available: true,
      createTournament: vi.fn().mockResolvedValueOnce({
        tournamentId: "tourn-auth-123",
        organizerSecret: "org_sec_authoritative_token",
        name: "Giải Mùa Thu",
        formatId: "swiss",
      }),
    };

    render(
      <HumanTournamentDialog
        isOpen={true}
        onClose={vi.fn()}
        onJoinMatch={vi.fn()}
        gateway={mockGateway as any}
      />
    );

    await user.click(screen.getByRole("tab", { name: "Tổ chức & Điều hành" }));

    const nameInput = screen.getByRole("textbox", { name: "Tên giải đấu" });
    await user.type(nameInput, "Giải Mùa Thu");

    const createBtn = screen.getByRole("button", { name: "Tạo giải đấu" });
    await user.click(createBtn);

    expect(mockGateway.createTournament).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Giải Mùa Thu",
        formatId: "swiss",
      })
    );

    expect(await screen.findByText(/Giải đấu đã tạo thành công trên máy chủ/)).toBeInTheDocument();
    expect(screen.getByText("tourn-auth-123")).toBeInTheDocument();
    expect(screen.getByText("org_sec_authoritative_token")).toBeInTheDocument();
  });

  it("registers a player and obtains authentic participant credentials", async () => {
    const user = userEvent.setup();
    const mockGateway = {
      available: true,
      registerTournamentPlayer: vi.fn().mockResolvedValueOnce({
        tournamentId: "tourn-auth-123",
        participantId: "p_1234",
        participantSecret: "p_sec_authoritative_token",
        name: "Chi",
      }),
    };

    render(
      <HumanTournamentDialog
        isOpen={true}
        onClose={vi.fn()}
        onJoinMatch={vi.fn()}
        gateway={mockGateway as any}
      />
    );

    await user.click(screen.getByRole("tab", { name: "Đăng ký thi đấu" }));

    const idInput = screen.getByRole("textbox", { name: "Mã giải đấu" });
    await user.type(idInput, "tourn-auth-123");

    const nameInput = screen.getByRole("textbox", { name: "Tên của bạn trong giải" });
    await user.clear(nameInput);
    await user.type(nameInput, "Chi");

    await user.click(screen.getByRole("button", { name: "Xác nhận đăng ký" }));

    expect(mockGateway.registerTournamentPlayer).toHaveBeenCalledWith({
      tournamentId: "tourn-auth-123",
      name: "Chi",
    });

    expect(await screen.findByText(/Đăng ký thi đấu thành công/)).toBeInTheDocument();
    expect(screen.getByText("p_sec_authoritative_token")).toBeInTheDocument();
  });

  it("syncs authoritative match result from worker game DO outcome", async () => {
    const user = userEvent.setup();
    const mockGateway = {
      available: true,
      getTournamentDetails: vi.fn().mockResolvedValue({
        tournamentId: "tourn-1",
        name: "Cúp Oẳn Tù Tì",
        organizer: { organizerId: "org-1", name: "Trọng tài" },
        formatId: "swiss",
        status: "in_progress",
        currentRoundNumber: 1,
        roundCount: 3,
        participantCount: 2,
        currentRoundMatches: [
          {
            matchId: "m-1",
            roundNumber: 1,
            scheduleIndex: 0,
            participantA: { id: "p-1", name: "An" },
            participantB: { id: "p-2", name: "Bình" },
            status: "completed",
            result: "win_a",
            winnerParticipantId: "p-1",
            alias: "K7N-M4P",
            allocationId: "alloc-1",
          },
        ],
        standings: [],
        completedAt: null,
      }),
      syncTournamentMatch: vi.fn().mockResolvedValueOnce({
        match: { matchId: "m-1", status: "completed", result: "win_a", winnerParticipantId: "p-1" },
        canAdvance: true,
      }),
    };

    const initialTournament: HumanTournamentSummary = {
      tournamentId: "tourn-1",
      name: "Cúp Oẳn Tù Tì",
      organizer: { organizerId: "org-1", name: "Trọng tài" },
      formatId: "swiss",
      status: "in_progress",
      currentRoundNumber: 1,
      roundCount: 3,
      participantCount: 2,
      currentRoundMatches: [
        {
          matchId: "m-1",
          roundNumber: 1,
          scheduleIndex: 0,
          participantA: { id: "p-1", name: "An" },
          participantB: { id: "p-2", name: "Bình" },
          status: "in_progress",
          result: null,
          winnerParticipantId: null,
          alias: "K7N-M4P",
          allocationId: "alloc-1",
        },
      ],
      standings: [],
      completedAt: null,
    };

    render(
      <HumanTournamentDialog
        isOpen={true}
        onClose={vi.fn()}
        onJoinMatch={vi.fn()}
        gateway={mockGateway as any}
        tournament={initialTournament}
      />
    );

    await user.click(screen.getByRole("tab", { name: "Bảng xếp hạng" }));
    const syncBtn = screen.getByRole("button", { name: "Đồng bộ" });
    await user.click(syncBtn);

    expect(mockGateway.syncTournamentMatch).toHaveBeenCalledWith({
      tournamentId: "tourn-1",
      matchId: "m-1",
    });

    expect(await screen.findByText(/Trận m-1 đã đồng bộ kết quả thành công/)).toBeInTheDocument();
  });

  it("uses the entered participant ID when returning participant B has a different lobby name", async () => {
    const user = userEvent.setup();
    const mockGateway = {
      available: true,
      getTournamentMatchAccess: vi.fn().mockResolvedValueOnce({ inviteToken: "inv-participant-b" }),
    };
    const tournament: HumanTournamentSummary = {
      tournamentId: "tourn-returning",
      name: "Giải trở lại",
      organizer: { organizerId: "org-1", name: "Trọng tài" },
      formatId: "swiss",
      status: "in_progress",
      currentRoundNumber: 1,
      roundCount: 3,
      participantCount: 2,
      currentRoundMatches: [{
        matchId: "m-returning",
        roundNumber: 1,
        scheduleIndex: 0,
        participantA: { id: "p-seat-a", name: "An" },
        participantB: { id: "p-seat-b", name: "Tên hiển thị mới" },
        status: "scheduled",
        result: null,
        winnerParticipantId: null,
        alias: "RET-123",
        allocationId: "alloc-returning",
      }],
      standings: [{
        rank: 1,
        participantId: "p-seat-b",
        name: "Tên hiển thị mới",
        status: "active",
        matchesPlayed: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        byes: 0,
        points: 0,
        buchholz: 0,
        sonnebornBerger: 0,
      }],
      completedAt: null,
    };

    render(
      <HumanTournamentDialog
        isOpen={true}
        onClose={vi.fn()}
        playerName="Tên cũ trong lobby"
        onJoinMatch={vi.fn()}
        gateway={mockGateway as any}
        tournament={tournament}
      />
    );

    await user.click(screen.getByRole("tab", { name: "Bảng xếp hạng" }));
    await user.type(screen.getByRole("textbox", { name: "Mã người chơi của bạn" }), "p-seat-b");
    await user.type(screen.getByRole("textbox", { name: "Mã bí mật người chơi của bạn (để vào phòng đấu chỉ định)" }), "secret-b");
    await user.click(screen.getByRole("button", { name: "Vào trận" }));

    expect(mockGateway.getTournamentMatchAccess).toHaveBeenCalledWith({
      tournamentId: "tourn-returning",
      matchId: "m-returning",
      participantId: "p-seat-b",
      participantSecret: "secret-b",
    });
  });
});
