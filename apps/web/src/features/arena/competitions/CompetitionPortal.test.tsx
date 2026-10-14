// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { CompetitionPortal } from "./CompetitionPortal";
import { CompetitionApiClient, CompetitionApiError } from "./CompetitionApiClient";
import { ArenaApiGateway, type ArenaUserProfile } from "../ArenaApiGateway";
import type { Competition, CompetitionDetailResponse, CompetitionEntry } from "./types";

describe("CompetitionPortal", () => {
  let gateway: ArenaApiGateway;
  let client: CompetitionApiClient;
  const onNavigateTournamentMock = vi.fn();

  const authorProfile: ArenaUserProfile = {
    user: { id: "u-author-1", username: "alice", role: "author" },
    canSubmitSource: true,
  };

  const adminProfile: ArenaUserProfile = {
    user: { id: "u-admin-1", username: "organizer", role: "admin" },
    canSubmitSource: true,
  };

  const sampleCompetitions: Competition[] = [
    {
      id: "comp-1",
      name: "Spring Championship 2026",
      description: "Annual bot chess championship",
      phase: "registration",
      capacity: 16,
      ranked: true,
      tournamentId: null,
      createdAt: "2026-10-15T00:00:00Z",
    },
    {
      id: "comp-2",
      name: "Practice Blitz",
      description: "Quick round robin",
      phase: "running",
      capacity: 4,
      ranked: false,
      tournamentId: "tourn-blitz-99",
      createdAt: "2026-10-14T00:00:00Z",
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    gateway = new ArenaApiGateway({ baseUrl: "http://127.0.0.1:8787/api/arena/v1" });
    client = new CompetitionApiClient(gateway);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe("List, Empty, Loading & Error States", () => {
    it("renders competition list and selects first item by default", async () => {
      vi.spyOn(client, "listCompetitions").mockResolvedValueOnce(sampleCompetitions);
      vi.spyOn(client, "getCompetition").mockResolvedValueOnce({
        competition: sampleCompetitions[0],
        entries: [],
      });

      render(
        <CompetitionPortal
          gateway={gateway}
          client={client}
          userProfile={authorProfile}
          onNavigateTournament={onNavigateTournamentMock}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Spring Championship 2026")).toBeInTheDocument();
        expect(screen.getByText("Practice Blitz")).toBeInTheDocument();
      });

      // Detail shows first selected competition
      await waitFor(() => {
        expect(screen.getByTestId("competition-detail")).toHaveTextContent("Spring Championship 2026");
        expect(screen.getByTestId("competition-detail")).toHaveTextContent("Annual bot chess championship");
      });
    });

    it("displays empty state when no competitions exist", async () => {
      vi.spyOn(client, "listCompetitions").mockResolvedValueOnce([]);

      render(
        <CompetitionPortal
          gateway={gateway}
          client={client}
          userProfile={authorProfile}
          onNavigateTournament={onNavigateTournamentMock}
        />
      );

      await waitFor(() => {
        expect(screen.getByText(/Chưa có sự kiện thi đấu nào/i)).toBeInTheDocument();
      });
    });

    it("displays error banner and retries when clicking Thử lại", async () => {
      const user = userEvent.setup();
      vi.spyOn(client, "listCompetitions")
        .mockRejectedValueOnce(new Error("Lỗi mạng"))
        .mockResolvedValue(sampleCompetitions);
      vi.spyOn(client, "getCompetition").mockResolvedValue({
        competition: sampleCompetitions[0],
        entries: [],
      });

      render(
        <CompetitionPortal
          gateway={gateway}
          client={client}
          userProfile={authorProfile}
          onNavigateTournament={onNavigateTournamentMock}
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent("Lỗi mạng");
      });

      const retryBtn = screen.getByRole("button", { name: /Thử lại/i });
      await user.click(retryBtn);

      await waitFor(() => {
        expect(screen.getByRole("listitem", { name: /Sự kiện Spring Championship 2026/i })).toBeInTheDocument();
      });
    });
  });

  describe("Admin Event Creation", () => {
    it("shows create event button only for admin, allows submitting form", async () => {
      const user = userEvent.setup();
      vi.spyOn(client, "listCompetitions").mockResolvedValueOnce(sampleCompetitions);
      vi.spyOn(client, "getCompetition").mockResolvedValue({
        competition: sampleCompetitions[0],
        entries: [],
      });

      const newComp: Competition = {
        id: "comp-3",
        name: "Winter Cup",
        description: "Cold battles",
        phase: "registration",
        capacity: 8,
        ranked: true,
        tournamentId: null,
        createdAt: "2026-10-15T01:00:00Z",
      };
      const createSpy = vi.spyOn(client, "createCompetition").mockResolvedValueOnce(newComp);

      const { rerender } = render(
        <CompetitionPortal
          gateway={gateway}
          client={client}
          userProfile={authorProfile}
          onNavigateTournament={onNavigateTournamentMock}
        />
      );

      // Author should NOT see create event button
      expect(screen.queryByRole("button", { name: /Tạo sự kiện mới/i })).not.toBeInTheDocument();

      // Rerender with admin
      rerender(
        <CompetitionPortal
          gateway={gateway}
          client={client}
          userProfile={adminProfile}
          onNavigateTournament={onNavigateTournamentMock}
        />
      );

      const openCreateBtn = screen.getByRole("button", { name: /Tạo sự kiện mới/i });
      expect(openCreateBtn).toBeInTheDocument();
      await user.click(openCreateBtn);

      expect(screen.getByTestId("create-competition-form")).toBeInTheDocument();

      const nameInput = screen.getByLabelText(/Tên sự kiện/i);
      const descInput = screen.getByLabelText(/Mô tả sự kiện/i);
      const capInput = screen.getByLabelText(/Số lượng tối đa/i);

      await user.type(nameInput, "Winter Cup");
      await user.type(descInput, "Cold battles");
      await user.type(capInput, "8");

      vi.spyOn(client, "listCompetitions").mockResolvedValueOnce([...sampleCompetitions, newComp]);

      const submitBtn = screen.getByRole("button", { name: /Xác nhận tạo sự kiện/i });
      await user.click(submitBtn);

      expect(createSpy).toHaveBeenCalledWith({
        name: "Winter Cup",
        description: "Cold battles",
        capacity: 8,
        ranked: true,
      });

      await waitFor(() => {
        expect(screen.getByRole("status")).toHaveTextContent(/Tạo sự kiện "Winter Cup" thành công/i);
      });
    });
  });

  describe("Author Registration Flow", () => {
    it("allows author to register in registration phase and shows pending status", async () => {
      const user = userEvent.setup();
      vi.spyOn(client, "listCompetitions").mockResolvedValueOnce(sampleCompetitions);

      // Initially no entries
      vi.spyOn(client, "getCompetition")
        .mockResolvedValueOnce({
          competition: sampleCompetitions[0],
          entries: [],
        })
        .mockResolvedValueOnce({
          competition: sampleCompetitions[0],
          entries: [
            {
              userId: "u-author-1",
              username: "alice",
              status: "pending",
              botId: null,
              botName: null,
              botVersionId: null,
              versionNo: null,
              buildStatus: null,
            },
          ],
        });

      const registerSpy = vi.spyOn(client, "registerForCompetition").mockResolvedValueOnce({
        userId: "u-author-1",
        username: "alice",
        status: "pending",
        botId: null,
        botName: null,
        botVersionId: null,
        versionNo: null,
        buildStatus: null,
      });

      render(
        <CompetitionPortal
          gateway={gateway}
          client={client}
          userProfile={authorProfile}
          onNavigateTournament={onNavigateTournamentMock}
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Đăng ký tham gia/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /Đăng ký tham gia/i }));

      expect(registerSpy).toHaveBeenCalledWith("comp-1");

      await waitFor(() => {
        expect(screen.getByRole("status")).toHaveTextContent(/Đăng ký tham gia thành công/i);
        expect(screen.getByText(/Đang chờ duyệt/i)).toBeInTheDocument();
      });
    });
  });

  describe("Admin Admission Review Controls", () => {
    it("allows admin to accept or decline pending entries", async () => {
      const user = userEvent.setup();
      const entries: CompetitionEntry[] = [
        {
          userId: "u-author-1",
          username: "alice",
          status: "pending",
          botId: null,
          botName: null,
          botVersionId: null,
          versionNo: null,
          buildStatus: null,
        },
      ];

      vi.spyOn(client, "listCompetitions").mockResolvedValueOnce(sampleCompetitions);
      vi.spyOn(client, "getCompetition")
        .mockResolvedValueOnce({
          competition: sampleCompetitions[0],
          entries,
        })
        .mockResolvedValueOnce({
          competition: sampleCompetitions[0],
          entries: [
            {
              ...entries[0],
              status: "accepted",
            },
          ],
        });

      const reviewSpy = vi.spyOn(client, "reviewEntry").mockResolvedValueOnce({
        ...entries[0],
        status: "accepted",
      });

      render(
        <CompetitionPortal
          gateway={gateway}
          client={client}
          userProfile={adminProfile}
          onNavigateTournament={onNavigateTournamentMock}
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Duyệt alice/i })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Từ chối alice/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /Duyệt alice/i }));

      expect(reviewSpy).toHaveBeenCalledWith("comp-1", "u-author-1", true);

      await waitFor(() => {
        expect(screen.getByRole("status")).toHaveTextContent(/Đã duyệt người tham gia/i);
      });
    });
  });

  describe("Author Bot Version Selection & Submission", () => {
    it("loads owned ready bots and allows submitting ready version in preparation phase", async () => {
      const user = userEvent.setup();
      const prepComp: Competition = {
        id: "comp-prep",
        name: "Prep Cup",
        phase: "preparation",
        capacity: 4,
        ranked: true,
        tournamentId: null,
        createdAt: "2026-10-15T00:00:00Z",
      };

      const acceptedEntry: CompetitionEntry = {
        userId: "u-author-1",
        username: "alice",
        status: "accepted",
        botId: null,
        botName: null,
        botVersionId: null,
        versionNo: null,
        buildStatus: null,
      };

      vi.spyOn(client, "listCompetitions").mockResolvedValueOnce([prepComp]);
      vi.spyOn(client, "getCompetition")
        .mockResolvedValueOnce({
          competition: prepComp,
          entries: [acceptedEntry],
        })
        .mockResolvedValueOnce({
          competition: prepComp,
          entries: [
            {
              ...acceptedEntry,
              botId: "bot-alpha",
              botName: "AlphaBot",
              botVersionId: "ver-ready-1",
              versionNo: 1,
              buildStatus: "ready",
            },
          ],
        });

      // Mock gateway bot listings for author
      vi.spyOn(gateway, "listBots").mockResolvedValueOnce({
        bots: [{ id: "bot-alpha", ownerId: "u-author-1", name: "AlphaBot", status: "active", createdAt: "2026-10-14T00:00:00Z" }],
        total: 1,
        limit: 20,
        offset: 0,
      });

      vi.spyOn(gateway, "listBotVersions").mockResolvedValueOnce({
        versions: [
          {
            id: "ver-ready-1",
            botId: "bot-alpha",
            versionNo: 1,
            sourceDigest: "sha:1",
            profileId: "controlled-node",
            buildStatus: "ready",
            createdAt: "2026-10-14T00:00:00Z",
          },
          {
            id: "ver-building",
            botId: "bot-alpha",
            versionNo: 2,
            sourceDigest: "sha:2",
            profileId: "controlled-node",
            buildStatus: "building",
            createdAt: "2026-10-14T00:00:00Z",
          },
        ],
      });

      const submitBotSpy = vi.spyOn(client, "submitBotVersion").mockResolvedValueOnce({
        ...acceptedEntry,
        botId: "bot-alpha",
        botName: "AlphaBot",
        botVersionId: "ver-ready-1",
        versionNo: 1,
        buildStatus: "ready",
      });

      render(
        <CompetitionPortal
          gateway={gateway}
          client={client}
          userProfile={authorProfile}
          onNavigateTournament={onNavigateTournamentMock}
        />
      );

      await waitFor(() => {
        expect(screen.getByLabelText(/Chọn phiên bản bot READY của bạn/i)).toBeInTheDocument();
        expect(screen.getByRole("option", { name: /AlphaBot/i })).toBeInTheDocument();
      });

      const submitBtn = screen.getByRole("button", { name: /Xác nhận nộp bot/i });
      await user.click(submitBtn);

      expect(submitBotSpy).toHaveBeenCalledWith("comp-prep", "ver-ready-1");

      await waitFor(() => {
        expect(screen.getByRole("status")).toHaveTextContent(/Nộp phiên bản bot thành công/i);
      });
    });
  });

  describe("Admin Phase Advancement & Error Handling", () => {
    it("advances phase when conditions met", async () => {
      const user = userEvent.setup();
      const readyComp: Competition = {
        id: "comp-ready",
        name: "Ready Cup",
        phase: "registration",
        capacity: 4,
        ranked: true,
        tournamentId: null,
        createdAt: "2026-10-15T00:00:00Z",
      };

      const entries: CompetitionEntry[] = [
        { userId: "u-1", username: "p1", status: "accepted", botId: null, botName: null, botVersionId: null, versionNo: null, buildStatus: null },
        { userId: "u-2", username: "p2", status: "accepted", botId: null, botName: null, botVersionId: null, versionNo: null, buildStatus: null },
      ];

      vi.spyOn(client, "listCompetitions").mockResolvedValue([readyComp]);
      vi.spyOn(client, "getCompetition").mockResolvedValue({
        competition: readyComp,
        entries,
      });

      const advanceSpy = vi.spyOn(client, "advancePhase").mockResolvedValueOnce({
        ...readyComp,
        phase: "preparation",
      });

      render(
        <CompetitionPortal
          gateway={gateway}
          client={client}
          userProfile={adminProfile}
          onNavigateTournament={onNavigateTournamentMock}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId("admin-advance-box")).toBeInTheDocument();
      });

      const advanceBtn = screen.getByRole("button", { name: /Chuyển sang: Chuẩn bị bot \(preparation\)/i });
      expect(advanceBtn).toBeEnabled();
      await user.click(advanceBtn);

      expect(advanceSpy).toHaveBeenCalledWith("comp-ready", "preparation");
    });

    it("displays error banner when advancePhase fails with 409 conflict", async () => {
      const user = userEvent.setup();
      const readyComp: Competition = {
        id: "comp-ready",
        name: "Ready Cup",
        phase: "registration",
        capacity: 4,
        ranked: true,
        tournamentId: null,
        createdAt: "2026-10-15T00:00:00Z",
      };

      const entries: CompetitionEntry[] = [
        { userId: "u-1", username: "p1", status: "accepted", botId: null, botName: null, botVersionId: null, versionNo: null, buildStatus: null },
        { userId: "u-2", username: "p2", status: "accepted", botId: null, botName: null, botVersionId: null, versionNo: null, buildStatus: null },
      ];

      vi.spyOn(client, "listCompetitions").mockResolvedValue([readyComp]);
      vi.spyOn(client, "getCompetition").mockResolvedValue({
        competition: readyComp,
        entries,
      });

      vi.spyOn(client, "advancePhase").mockRejectedValueOnce(
        new CompetitionApiError("Cannot advance: unresolved pending entries remain", {
          code: "conflict",
          statusCode: 409,
        })
      );

      render(
        <CompetitionPortal
          gateway={gateway}
          client={client}
          userProfile={adminProfile}
          onNavigateTournament={onNavigateTournamentMock}
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Chuyển sang: Chuẩn bị bot \(preparation\)/i })).toBeEnabled();
      });

      await user.click(screen.getByRole("button", { name: /Chuyển sang: Chuẩn bị bot \(preparation\)/i }));

      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent("Cannot advance: unresolved pending entries remain");
      });
    });
  });

  describe("Tournament Link & Navigation", () => {
    it("calls onNavigateTournament when clicking linked tournament button", async () => {
      const user = userEvent.setup();
      const runningComp = sampleCompetitions[1]; // has tournamentId: 'tourn-blitz-99'

      vi.spyOn(client, "listCompetitions").mockResolvedValueOnce(sampleCompetitions);
      vi.spyOn(client, "getCompetition").mockResolvedValueOnce({
        competition: runningComp,
        entries: [],
      });

      render(
        <CompetitionPortal
          gateway={gateway}
          client={client}
          userProfile={authorProfile}
          onNavigateTournament={onNavigateTournamentMock}
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("listitem", { name: /Sự kiện Practice Blitz/i })).toBeInTheDocument();
      });

      // Click second competition from list
      const practiceItem = screen.getByRole("listitem", { name: /Sự kiện Practice Blitz/i });
      await user.click(practiceItem);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Xem giải đấu liên kết tourn-blitz-99/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /Xem giải đấu liên kết tourn-blitz-99/i }));

      expect(onNavigateTournamentMock).toHaveBeenCalledWith("tourn-blitz-99");
    });
  });
});
