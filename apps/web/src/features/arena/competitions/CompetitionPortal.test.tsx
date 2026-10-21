// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { CompetitionPortal } from "./CompetitionPortal";
import { CompetitionApiClient, CompetitionApiError } from "./CompetitionApiClient";
import { ArenaApiGateway, type ArenaUserProfile } from "../ArenaApiGateway";
import type { Competition, CompetitionDetailResponse, CompetitionEntry } from "./types";
import { createMockCatalog } from "./competitionTestFixtures";

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
    vi.spyOn(client, "getCatalog").mockResolvedValue(createMockCatalog());
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

    it("notifies onUnauthorized with opaque session identifier when API returns HTTP 401", async () => {
      const onUnauthorizedMock = vi.fn();
      gateway.setToken("expired-token-xyz");
      const gatewayWithGen = gateway as { getSessionGeneration?(): number };
      const currentGen =
        typeof gatewayWithGen.getSessionGeneration === "function"
          ? gatewayWithGen.getSessionGeneration()
          : gateway.getToken();
      vi.spyOn(client, "listCompetitions").mockRejectedValueOnce(
        new CompetitionApiError("Authentication required", {
          code: "UNAUTHORIZED",
          statusCode: 401,
          token: "expired-token-xyz",
          sessionGeneration: typeof gatewayWithGen.getSessionGeneration === "function" ? (currentGen as number) : undefined,
        })
      );

      render(
        <CompetitionPortal
          gateway={gateway}
          client={client}
          userProfile={authorProfile}
          onUnauthorized={onUnauthorizedMock}
        />
      );

      await waitFor(() => {
        expect(onUnauthorizedMock).toHaveBeenCalledWith(currentGen);
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

      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Winter Cup",
          description: "Cold battles",
          capacity: 8,
          ranked: true,
          formatId: "double-round-robin",
          mapId: "classic",
          mode: "ranked",
        })
      );

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

      expect(advanceSpy).toHaveBeenCalledWith("comp-ready", "registration");
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

  describe("Bot Filtering, Pagination & Stale Selection", () => {
    it("filters opponent bots and inactive bots before calling listBotVersions", async () => {
      const prepComp: Competition = {
        id: "comp-prep",
        name: "Preparation Cup",
        phase: "preparation",
        capacity: 8,
        ranked: true,
        tournamentId: null,
        createdAt: "2026-10-15T00:00:00Z",
      };

      const entries: CompetitionEntry[] = [
        { userId: "u-author-1", username: "alice", status: "accepted", botId: null, botName: null, botVersionId: null, versionNo: null, buildStatus: null },
      ];

      vi.spyOn(client, "listCompetitions").mockResolvedValueOnce([prepComp]);
      vi.spyOn(client, "getCompetition").mockResolvedValueOnce({ competition: prepComp, entries });

      // listBots returns 3 bots: 1 owned active, 1 owned inactive/suspended, 1 opponent bot
      vi.spyOn(gateway, "listBots").mockResolvedValueOnce({
        bots: [
          { id: "bot-owned-1", ownerId: "u-author-1", name: "MyBot", status: "active", createdAt: "" },
          { id: "bot-owned-inactive", ownerId: "u-author-1", name: "OldBot", status: "suspended", createdAt: "" },
          { id: "bot-opponent", ownerId: "u-opponent-9", name: "EnemyBot", status: "active", createdAt: "" },
        ],
        total: 3,
        limit: 50,
        offset: 0,
      });

      const listVersionsSpy = vi.spyOn(gateway, "listBotVersions").mockResolvedValueOnce({
        versions: [
          {
            id: "ver-ready-1",
            botId: "bot-owned-1",
            versionNo: 1,
            sourceDigest: "d1",
            profileId: "profile-node",
            buildStatus: "ready",
            createdAt: "",
          },
        ],
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
        expect(screen.getByRole("combobox", { name: /Chọn phiên bản bot READY của bạn/i })).toBeInTheDocument();
      });

      // listBotVersions must ONLY be called for bot-owned-1
      expect(listVersionsSpy).toHaveBeenCalledTimes(1);
      expect(listVersionsSpy).toHaveBeenCalledWith("bot-owned-1", expect.anything());
      expect(listVersionsSpy).not.toHaveBeenCalledWith("bot-opponent", expect.anything());
      expect(listVersionsSpy).not.toHaveBeenCalledWith("bot-owned-inactive", expect.anything());
    });

    it("paginates listBots so own bot on page 2 is discovered", async () => {
      const prepComp: Competition = {
        id: "comp-prep",
        name: "Prep Cup",
        phase: "preparation",
        capacity: 8,
        ranked: true,
        tournamentId: null,
        createdAt: "2026-10-15T00:00:00Z",
      };

      vi.spyOn(client, "listCompetitions").mockResolvedValueOnce([prepComp]);
      vi.spyOn(client, "getCompetition").mockResolvedValueOnce({
        competition: prepComp,
        entries: [{ userId: "u-author-1", username: "alice", status: "accepted", botId: null, botName: null, botVersionId: null, versionNo: null, buildStatus: null }],
      });

      // Page 1: only opponents (50 bots), total 51
      const listBotsSpy = vi.spyOn(gateway, "listBots")
        .mockResolvedValueOnce({
          bots: Array.from({ length: 50 }, (_, i) => ({
            id: `bot-other-${i}`,
            ownerId: `u-other-${i}`,
            name: `OtherBot${i}`,
            status: "active",
            createdAt: "",
          })),
          total: 51,
          limit: 50,
          offset: 0,
        })
        // Page 2: author's bot
        .mockResolvedValueOnce({
          bots: [
            { id: "bot-p2-owned", ownerId: "u-author-1", name: "PageTwoBot", status: "active", createdAt: "" },
          ],
          total: 51,
          limit: 50,
          offset: 50,
        });

      const listVersionsSpy = vi.spyOn(gateway, "listBotVersions").mockResolvedValueOnce({
        versions: [
          { id: "ver-p2", botId: "bot-p2-owned", versionNo: 2, sourceDigest: "d2", profileId: "node", buildStatus: "ready", createdAt: "" },
        ],
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
        expect(screen.getByRole("combobox", { name: /Chọn phiên bản bot READY của bạn/i })).toBeInTheDocument();
      });

      expect(listBotsSpy).toHaveBeenCalledTimes(2);
      expect(listVersionsSpy).toHaveBeenCalledWith("bot-p2-owned", expect.anything());
      expect(screen.getByText(/PageTwoBot \(v2/i)).toBeInTheDocument();
    });

    it("prevents stale detail responses from overwriting newer selection", async () => {
      const user = userEvent.setup();
      const compA: Competition = { id: "comp-a", name: "Alpha League", phase: "registration", tournamentId: null, createdAt: "" };
      const compB: Competition = { id: "comp-b", name: "Beta League", phase: "registration", tournamentId: null, createdAt: "" };

      vi.spyOn(client, "listCompetitions").mockResolvedValue([compA, compB]);

      let resolveA!: (val: any) => void;
      const promiseA = new Promise((resolve) => {
        resolveA = resolve;
      });

      let resolveB!: (val: any) => void;
      const promiseB = new Promise((resolve) => {
        resolveB = resolve;
      });

      vi.spyOn(client, "getCompetition").mockImplementation((id) => {
        if (id === "comp-a") return promiseA as any;
        if (id === "comp-b") return promiseB as any;
        return Promise.reject(new Error("unknown"));
      });

      render(
        <CompetitionPortal
          gateway={gateway}
          client={client}
          userProfile={authorProfile}
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("listitem", { name: /Sự kiện Alpha League/i })).toBeInTheDocument();
        expect(screen.getByRole("listitem", { name: /Sự kiện Beta League/i })).toBeInTheDocument();
      });

      // User switches to Beta League before Alpha League resolves
      await user.click(screen.getByRole("listitem", { name: /Sự kiện Beta League/i }));

      // Beta League resolves first
      resolveB({
        competition: compB,
        entries: [{ userId: "u-2", username: "beta-user", status: "accepted", botId: null, botName: null, botVersionId: null, versionNo: null, buildStatus: null }],
      });

      await waitFor(() => {
        expect(screen.getByTestId("competition-detail")).toHaveTextContent("Beta League");
      });

      // Now late Alpha League resolves
      resolveA({
        competition: compA,
        entries: [{ userId: "u-1", username: "alpha-user", status: "accepted", botId: null, botName: null, botVersionId: null, versionNo: null, buildStatus: null }],
      });

      // Assert that Beta League is still the displayed detail, NOT overwritten by Alpha
      expect(screen.getByTestId("competition-detail")).toHaveTextContent("Beta League");
      expect(screen.queryByText("alpha-user")).not.toBeInTheDocument();
    });
  });

  describe("Linked Tournament & Match Error Retry", () => {
    it("renders standings and matches, allows admin to retry errored match on running event", async () => {
      const user = userEvent.setup();
      const runningComp: Competition = {
        id: "comp-running",
        name: "Pro Arena Running",
        phase: "running",
        tournamentId: "tourn-live-1",
        createdAt: "2026-10-15T00:00:00Z",
      };

      vi.spyOn(client, "listCompetitions").mockResolvedValueOnce([runningComp]);
      vi.spyOn(client, "getCompetition").mockResolvedValueOnce({
        competition: runningComp,
        entries: [],
      });

      const getTournamentSpy = vi.spyOn(gateway, "getTournament").mockResolvedValue({
        tournament: {
          id: "tourn-live-1",
          name: "Pro Tournament",
          status: "active",
          pointScheme: "standard",
          ranked: true,
          createdAt: "2026-10-15T00:00:00Z",
        },
        standings: [
          { botId: "bot-1", botName: "AlphaBot", points: 3, matchesPlayed: 1, wins: 1, draws: 0, losses: 0, rank: 1 },
          { botId: "bot-2", botName: "BetaBot", points: 0, matchesPlayed: 1, wins: 0, draws: 0, losses: 1, rank: 2 },
        ],
        matches: [
          { id: "m-1", scheduleIndex: 1, kind: "ranked", status: "completed", settledAt: "2026-10-15T00:10:00Z" },
          { id: "m-2", scheduleIndex: 2, kind: "ranked", status: "error", settledAt: null },
        ],
      });

      const retrySpy = vi.spyOn(client, "retryMatch").mockResolvedValueOnce({ ok: true });

      render(
        <CompetitionPortal
          gateway={gateway}
          client={client}
          userProfile={adminProfile}
          onNavigateTournament={onNavigateTournamentMock}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId("linked-tournament-panel")).toBeInTheDocument();
      });

      // Check standings rendered
      expect(screen.getByText("AlphaBot")).toBeInTheDocument();
      expect(screen.getByText("BetaBot")).toBeInTheDocument();

      // Check errored match warning
      expect(screen.getByTestId("errored-matches-alert")).toBeInTheDocument();

      // Find retry match button for scheduleIndex 2
      const retryBtn = screen.getByTestId("retry-match-btn-2");
      expect(retryBtn).toBeInTheDocument();
      await user.click(retryBtn);

      expect(retrySpy).toHaveBeenCalledWith("comp-running", 2);

      // Verify tournament was refreshed
      await waitFor(() => {
        expect(getTournamentSpy).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe("Capacity Validation", () => {
    it("validates capacity between 2 and 128 when creating an event", async () => {
      const user = userEvent.setup();
      vi.spyOn(client, "listCompetitions").mockResolvedValue([]);
      const createSpy = vi.spyOn(client, "createCompetition");

      render(
        <CompetitionPortal
          gateway={gateway}
          client={client}
          userProfile={adminProfile}
        />
      );

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Tạo sự kiện mới" })).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: "Tạo sự kiện mới" }));

      // Enter name and capacity < 2
      await user.type(screen.getByLabelText("Tên sự kiện"), "Mini Cup");
      await user.type(screen.getByLabelText(/Số lượng tối đa/i), "1");

      await user.click(screen.getByRole("button", { name: "Xác nhận tạo sự kiện" }));

      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent("Sức chứa giải đấu phải là số nguyên từ 2 đến 128 bot.");
      });
      expect(createSpy).not.toHaveBeenCalled();

      // Enter capacity > 128
      await user.clear(screen.getByLabelText(/Số lượng tối đa/i));
      await user.type(screen.getByLabelText(/Số lượng tối đa/i), "200");

      await user.click(screen.getByRole("button", { name: "Xác nhận tạo sự kiện" }));

      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent("Sức chứa giải đấu phải là số nguyên từ 2 đến 128 bot.");
      });
      expect(createSpy).not.toHaveBeenCalled();
    });
  });

  describe("Extended Rounds, Maps and Modes Integration", () => {
    it("renders CompetitionRounds and configuration view for extended competition", async () => {
      const extComp = {
        id: "c-ext-99",
        name: "Swiss Extended Championship",
        phase: "running" as const,
        tournamentId: "t-ext-1",
        createdAt: "2026-10-15T00:00:00Z",
        configuration: {
          formatId: "swiss",
          mapId: "flanks",
          mode: "ranked" as const,
          roundCount: 4,
          currentRound: 2,
        },
      };

      vi.spyOn(client, "listCompetitions").mockResolvedValue([extComp]);
      vi.spyOn(client, "getCompetition").mockResolvedValue({
        competition: extComp,
        entries: [],
        configuration: extComp.configuration,
        rounds: [
          {
            roundNumber: 1,
            tournamentId: "t-round-1",
            status: "completed",
            pairings: [{ scheduleIndex: 0, botAId: "bot-1", botBId: "bot-2" }],
          },
          {
            roundNumber: 2,
            tournamentId: "t-round-2",
            status: "running",
            pairings: [{ scheduleIndex: 0, botAId: "bot-1", botBId: "bot-3" }],
          },
        ],
        standings: [
          { botId: "bot-1", points: 3, played: 1, wins: 1, draws: 0, losses: 0, byeCount: 0 },
        ],
      });

      render(
        <CompetitionPortal
          gateway={gateway}
          client={client}
          userProfile={adminProfile}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId("competition-configuration-view")).toBeInTheDocument();
        expect(screen.getByTestId("competition-rounds-panel")).toBeInTheDocument();
      });

      expect(screen.getByText("Hệ Thụy Sĩ (Swiss System)")).toBeInTheDocument();
      expect(screen.getByText("Hai cánh (Flanks)")).toBeInTheDocument();
      expect(screen.getByText("Tiến độ vòng đấu: Vòng 2 / 4")).toBeInTheDocument();
    });

    it("retains legacy Linked Tournament UI when competition has no configuration", async () => {
      const legacyComp = {
        id: "c-legacy-1",
        name: "Legacy Direct Tournament Event",
        phase: "running" as const,
        tournamentId: "t-legacy-direct",
        createdAt: "2026-10-15T00:00:00Z",
      };

      vi.spyOn(client, "listCompetitions").mockResolvedValue([legacyComp]);
      vi.spyOn(client, "getCompetition").mockResolvedValue({
        competition: legacyComp,
        entries: [],
      });
      vi.spyOn(gateway, "getTournament").mockResolvedValue({
        tournament: { id: "t-legacy-direct", name: "Legacy Tourn", status: "active", createdAt: "2026-10-15" } as any,
        standings: [],
        matches: [],
      });

      render(
        <CompetitionPortal
          gateway={gateway}
          client={client}
          userProfile={adminProfile}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId("linked-tournament-panel")).toBeInTheDocument();
      });

      // No extended configuration view or rounds panel
      expect(screen.queryByTestId("competition-configuration-view")).not.toBeInTheDocument();
      expect(screen.queryByTestId("competition-rounds-panel")).not.toBeInTheDocument();
    });

    it("displays visible error alert, disables create submission when getCatalog fails, and recovers on retry", async () => {
      const user = userEvent.setup();
      vi.spyOn(client, "listCompetitions").mockResolvedValue(sampleCompetitions);
      vi.spyOn(client, "getCompetition").mockResolvedValue({
        competition: sampleCompetitions[0],
        entries: [],
      });

      // Initially catalog fails to load
      vi.spyOn(client, "getCatalog")
        .mockRejectedValueOnce(new Error("Lỗi kết nối /competition-catalog 500"))
        .mockResolvedValue(createMockCatalog());

      render(
        <CompetitionPortal
          gateway={gateway}
          client={client}
          userProfile={adminProfile}
        />
      );

      // Open create form
      const openCreateBtn = await screen.findByRole("button", { name: /Tạo sự kiện mới/i });
      await user.click(openCreateBtn);

      // Verify visible error alert is shown
      await waitFor(() => {
        expect(screen.getByTestId("catalog-error-alert")).toBeInTheDocument();
      });
      expect(screen.getByTestId("catalog-error-alert")).toHaveTextContent("Lỗi kết nối /competition-catalog 500");

      // Verify create submission button is disabled
      const submitBtn = screen.getByTestId("submit-create-competition-btn");
      expect(submitBtn).toBeDisabled();

      // Extended configuration inputs must NOT be rendered with fake data
      expect(screen.queryByTestId("competition-configuration-edit")).not.toBeInTheDocument();

      // Click retry button
      const retryBtn = screen.getByTestId("retry-catalog-btn");
      await user.click(retryBtn);

      // Verify error clears, configuration inputs appear, and submit button can be enabled
      await waitFor(() => {
        expect(screen.queryByTestId("catalog-error-alert")).not.toBeInTheDocument();
        expect(screen.getByTestId("competition-configuration-edit")).toBeInTheDocument();
      });

      const nameInput = screen.getByLabelText(/Tên sự kiện/i);
      await user.type(nameInput, "New Grand Prix");
      expect(submitBtn).toBeEnabled();
    });
  });
});

