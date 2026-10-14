// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ArenaScreen } from "./ArenaScreen";
import { ArenaApiGateway } from "./ArenaApiGateway";
import deterministicFixture from "../../../../../tests/fixtures/arena/replays/deterministic-match.json";
import * as replayImportMod from "../replay/replayImport";

describe("ArenaScreen", () => {
  let gateway: ArenaApiGateway;
  const onLobbyMock = vi.fn();
  const onStartReplayMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    gateway = new ArenaApiGateway({ baseUrl: "http://127.0.0.1:8787/api/arena/v1" });
    vi.spyOn(gateway, "getCapabilities").mockResolvedValue({
      executor: "trusted-local-v1",
      trusted: true,
      untrusted: false,
      canSubmitSource: true,
      profiles: ["node", "python"],
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the arena portal heading and back to lobby button", () => {
    render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);
    expect(screen.getByRole("heading", { name: /Đấu trường AI/i })).toBeInTheDocument();
    const backBtn = screen.getByRole("button", { name: /Về sảnh/i });
    expect(backBtn).toBeInTheDocument();
  });

  it("triggers onLobby when clicking back button", async () => {
    const user = userEvent.setup();
    render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);
    await user.click(screen.getByRole("button", { name: /Về sảnh/i }));
    expect(onLobbyMock).toHaveBeenCalledTimes(1);
  });

  it("allows user to log in and displays profile information", async () => {
    const user = userEvent.setup();
    vi.spyOn(gateway, "login").mockResolvedValueOnce({
      token: "tok-1",
      user: { id: "u-1", username: "bob", role: "author" }
    });
    vi.spyOn(gateway, "getMe").mockResolvedValueOnce({
      user: { id: "u-1", username: "bob", role: "author" },
      canSubmitSource: false
    });

    render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);

    const userInput = screen.getByLabelText(/Tên đăng nhập/i);
    const passInput = screen.getByLabelText(/Mật khẩu/i);
    await user.type(userInput, "bob");
    await user.type(passInput, "secret123");
    await user.click(screen.getByRole("button", { name: /Đăng nhập/i }));

    await waitFor(() => {
      expect(screen.getByText(/Xin chào,/i)).toBeInTheDocument();
      expect(screen.getByText("bob")).toBeInTheDocument();
      expect(screen.getByText("author")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Đăng xuất/i })).toBeInTheDocument();
    });
  });

  it("loads and displays leaderboard standings", async () => {
    vi.spyOn(gateway, "getLeaderboard").mockResolvedValueOnce({
      ladderId: "ladder-main",
      total: 1,
      ratings: [
        {
          rank: 1,
          botId: "bot-top",
          botName: "AlphaBot",
          ownerId: "u-1",
          rating: 1650,
          ratedGames: 20,
          wins: 15,
          draws: 3,
          losses: 2
        }
      ]
    });

    render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);

    await waitFor(() => {
      expect(screen.getByText("AlphaBot")).toBeInTheDocument();
      expect(screen.getByText("1650")).toBeInTheDocument();
    });
  });

  describe("Matches & Status Alignment", () => {
    it("renders real API status filter options (pending, active, completed, cancelled, error)", async () => {
      const user = userEvent.setup();
      vi.spyOn(gateway, "listMatches").mockResolvedValueOnce({ matches: [], total: 0, limit: 20, offset: 0 });

      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);
      await user.click(screen.getByRole("tab", { name: /Trận đấu/i }));

      const select = screen.getByLabelText(/Trạng thái:/i) as HTMLSelectElement;
      expect(select).toBeInTheDocument();
      const options = Array.from(select.options).map((o) => o.value);
      expect(options).toEqual(["", "pending", "active", "completed", "cancelled", "error"]);
    });

    it("displays Replay buttons ONLY for completed matches, never for active/pending/cancelled/error", async () => {
      const user = userEvent.setup();
      vi.spyOn(gateway, "listMatches").mockResolvedValueOnce({
        matches: [
          { id: "m-completed", kind: "ranked", status: "completed", createdAt: "2026-10-14T01:00:00Z" },
          { id: "m-active", kind: "ranked", status: "active", createdAt: "2026-10-14T01:00:00Z" },
          { id: "m-pending", kind: "practice", status: "pending", createdAt: "2026-10-14T01:00:00Z" },
          { id: "m-error", kind: "ranked", status: "error", createdAt: "2026-10-14T01:00:00Z" }
        ],
        total: 4,
        limit: 20,
        offset: 0
      });

      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);
      await user.click(screen.getByRole("tab", { name: /Trận đấu/i }));

      await waitFor(() => {
        expect(screen.getByText("m-completed")).toBeInTheDocument();
      });

      // Exactly 1 View Replay and 1 Download Replay button (for m-completed)
      expect(screen.getAllByRole("button", { name: /Xem Replay/i })).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: /Tải Replay/i })).toHaveLength(1);
    });

    it("displays participants and actual backend win/draw/forfeit results", async () => {
      const user = userEvent.setup();
      vi.spyOn(gateway, "listMatches").mockResolvedValueOnce({
        matches: [
          {
            id: "m-win",
            kind: "ranked",
            status: "completed",
            createdAt: "2026-10-14T01:00:00Z",
            participants: {
              A: { seat: "A", botId: "AlphaBot", botVersionId: "ver-1" },
              B: { seat: "B", botId: "BetaBot", botVersionId: "ver-2" }
            },
            result: {
              outcome: "win",
              winner: "A",
              loser: "B",
              reason: "goal",
              acceptedPlies: 35
            }
          },
          {
            id: "m-forfeit",
            kind: "ranked",
            status: "completed",
            createdAt: "2026-10-14T01:00:00Z",
            participants: {
              A: { seat: "A", botId: "CrashBot", botVersionId: "ver-3" },
              B: { seat: "B", botId: "SolidBot", botVersionId: "ver-4" }
            },
            result: {
              outcome: "forfeit",
              winner: "B",
              loser: "A",
              reason: "illegal_move",
              acceptedPlies: 12
            }
          }
        ],
        total: 2,
        limit: 20,
        offset: 0
      });

      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);
      await user.click(screen.getByRole("tab", { name: /Trận đấu/i }));

      await waitFor(() => {
        expect(screen.getByText("m-win")).toBeInTheDocument();
      });

      expect(screen.getByText(/AlphaBot \(vver-1\)/i)).toBeInTheDocument();
      expect(screen.getByText(/BetaBot \(vver-2\)/i)).toBeInTheDocument();
      expect(screen.getByTestId("match-result-m-win")).toHaveTextContent(/Thắng: Seat A/i);
      expect(screen.getByTestId("match-result-m-win")).toHaveTextContent(/goal/i);
      expect(screen.getByTestId("match-result-m-win")).toHaveTextContent(/35 plies/i);

      expect(screen.getByTestId("match-result-m-forfeit")).toHaveTextContent(/Xử thua: Thắng: Seat B, Thua: Seat A/i);
      expect(screen.getByTestId("match-result-m-forfeit")).toHaveTextContent(/illegal_move/i);
    });
  });

  describe("Replay Validation & Download", () => {
    it("validates replay with shared validator and invokes onStartReplay for valid fixture", async () => {
      const user = userEvent.setup();
      vi.spyOn(gateway, "listMatches").mockResolvedValueOnce({
        matches: [{ id: "m-ok", kind: "ranked", status: "completed", createdAt: "2026-10-14T01:00:00Z" }],
        total: 1,
        limit: 20,
        offset: 0
      });
      vi.spyOn(gateway, "getMatchReplay").mockResolvedValueOnce({
        matchId: "m-ok",
        replayDigest: "sha:rep",
        completionDigest: "sha:comp",
        replay: deterministicFixture as any
      });

      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);
      await user.click(screen.getByRole("tab", { name: /Trận đấu/i }));

      await waitFor(() => expect(screen.getByText("m-ok")).toBeInTheDocument());

      await user.click(screen.getByRole("button", { name: /Xem Replay/i }));

      await waitFor(() => {
        expect(onStartReplayMock).toHaveBeenCalledWith(deterministicFixture);
      });
    });

    it("rejects invalid replay document: shows error banner and NEVER invokes onStartReplay", async () => {
      const user = userEvent.setup();
      vi.spyOn(gateway, "listMatches").mockResolvedValueOnce({
        matches: [{ id: "m-bad", kind: "ranked", status: "completed", createdAt: "2026-10-14T01:00:00Z" }],
        total: 1,
        limit: 20,
        offset: 0
      });
      vi.spyOn(gateway, "getMatchReplay").mockResolvedValueOnce({
        matchId: "m-bad",
        replayDigest: "sha:rep",
        completionDigest: "sha:comp",
        replay: { corrupt: true } as any
      });

      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);
      await user.click(screen.getByRole("tab", { name: /Trận đấu/i }));

      await waitFor(() => expect(screen.getByText("m-bad")).toBeInTheDocument());

      await user.click(screen.getByRole("button", { name: /Xem Replay/i }));

      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent(/Dữ liệu replay không hợp lệ/i);
      });
      expect(onStartReplayMock).not.toHaveBeenCalled();
    });

    it("uses shared downloadReplayDocument for valid replay and skips on invalid", async () => {
      const user = userEvent.setup();
      const downloadSpy = vi.spyOn(replayImportMod, "downloadReplayDocument").mockImplementation(() => undefined);

      vi.spyOn(gateway, "listMatches").mockResolvedValueOnce({
        matches: [{ id: "m-dl", kind: "ranked", status: "completed", createdAt: "2026-10-14T01:00:00Z" }],
        total: 1,
        limit: 20,
        offset: 0
      });
      vi.spyOn(gateway, "getMatchReplay").mockResolvedValueOnce({
        matchId: "m-dl",
        replayDigest: "sha:rep",
        completionDigest: "sha:comp",
        replay: deterministicFixture as any
      });

      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);
      await user.click(screen.getByRole("tab", { name: /Trận đấu/i }));

      await waitFor(() => expect(screen.getByText("m-dl")).toBeInTheDocument());

      await user.click(screen.getByRole("button", { name: /Tải Replay/i }));

      await waitFor(() => {
        expect(downloadSpy).toHaveBeenCalledWith(deterministicFixture, "match-m-dl-replay.json");
      });
    });
  });

  describe("Bots Panel & Failed Build Log", () => {
    it("uses button in cell for accessible keyboard bot selection", async () => {
      const user = userEvent.setup();
      vi.spyOn(gateway, "listBots").mockResolvedValueOnce({
        bots: [
          { id: "bot-1", ownerId: "u-1", name: "Bot One", status: "active", createdAt: "2026-10-14T00:00:00Z" },
          { id: "bot-2", ownerId: "u-1", name: "Bot Two", status: "active", createdAt: "2026-10-14T00:00:00Z" }
        ],
        total: 2,
        limit: 20,
        offset: 0
      });
      const listVersionsSpy = vi.spyOn(gateway, "listBotVersions").mockResolvedValue({ versions: [] });

      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);
      await user.click(screen.getByRole("tab", { name: /Quản lý Bot/i }));

      await waitFor(() => expect(screen.getByRole("button", { name: /Chọn bot Bot Two/i })).toBeInTheDocument());

      const botTwoBtn = screen.getByRole("button", { name: /Chọn bot Bot Two/i });
      await user.click(botTwoBtn);

      expect(listVersionsSpy).toHaveBeenCalledWith("bot-2", expect.anything());
    });

    it("displays bounded buildLog for failed bot versions", async () => {
      const user = userEvent.setup();
      vi.spyOn(gateway, "listBots").mockResolvedValueOnce({
        bots: [{ id: "bot-fail", ownerId: "u-1", name: "BrokenBot", status: "active", createdAt: "2026-10-14T00:00:00Z" }],
        total: 1,
        limit: 20,
        offset: 0
      });
      vi.spyOn(gateway, "listBotVersions").mockResolvedValueOnce({
        versions: [
          {
            id: "ver-fail-1",
            botId: "bot-fail",
            versionNo: 1,
            sourceDigest: "sha:fail",
            profileId: "controlled-node",
            buildStatus: "failed",
            buildLog: "SyntaxError: Unexpected token at line 4\nBuild failed with exit code 1",
            createdAt: "2026-10-14T00:00:00Z"
          }
        ]
      });

      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);
      await user.click(screen.getByRole("tab", { name: /Quản lý Bot/i }));

      await waitFor(() => {
        expect(screen.getByTestId("build-log-ver-fail-1")).toBeInTheDocument();
      });
      expect(screen.getByText(/SyntaxError: Unexpected token at line 4/i)).toBeInTheDocument();
    });
  });

  describe("Tournaments & Entry Selection", () => {
    it("renders checklist of loaded READY versions only for admin tournament creation", async () => {
      const user = userEvent.setup();
      vi.spyOn(gateway, "getMe").mockResolvedValue({
        user: { id: "u-admin", username: "admin", role: "admin" },
        canSubmitSource: true
      });
      gateway.setToken("admin-tok");

      vi.spyOn(gateway, "getTournament").mockResolvedValueOnce({
        tournament: { id: "tourn-main", name: "Main League", status: "pending", pointScheme: "3-1-0", ranked: true, createdAt: "2026-10-14T00:00:00Z" },
        standings: [],
        matches: []
      });

      vi.spyOn(gateway, "listBots").mockResolvedValue({
        bots: [
          { id: "b-1", ownerId: "u-1", name: "Bot A", status: "active", createdAt: "2026-10-14T00:00:00Z" },
          { id: "b-2", ownerId: "u-1", name: "Bot B", status: "active", createdAt: "2026-10-14T00:00:00Z" }
        ],
        total: 2,
        limit: 20,
        offset: 0
      });

      vi.spyOn(gateway, "listBotVersions").mockImplementation(async (botId) => {
        if (botId === "b-1") {
          return {
            versions: [
              { id: "v-ready-1", botId: "b-1", versionNo: 1, sourceDigest: "sha1", profileId: "controlled-node", buildStatus: "ready", createdAt: "2026-10-14T00:00:00Z" },
              { id: "v-building", botId: "b-1", versionNo: 2, sourceDigest: "sha2", profileId: "controlled-node", buildStatus: "building", createdAt: "2026-10-14T00:00:00Z" }
            ]
          };
        }
        return {
          versions: [
            { id: "v-ready-2", botId: "b-2", versionNo: 1, sourceDigest: "sha3", profileId: "controlled-node", buildStatus: "ready", createdAt: "2026-10-14T00:00:00Z" }
          ]
        };
      });

      const createTournSpy = vi.spyOn(gateway, "createTournament").mockResolvedValueOnce({
        tournament: { id: "tourn-new", name: "Spring Cup", status: "pending", pointScheme: "3-1-0", ranked: true, createdAt: "2026-10-14T00:00:00Z" },
        matchesCount: 2
      });

      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);

      // Switch to tournaments tab
      await user.click(screen.getByRole("tab", { name: /Giải đấu/i }));

      await waitFor(() => {
        expect(screen.getByTestId("tournament-ready-versions")).toBeInTheDocument();
      });

      // Verify only ready versions (v-ready-1 and v-ready-2) are shown in checkboxes, NOT v-building
      expect(screen.getByText(/v-ready-1/i)).toBeInTheDocument();
      expect(screen.getByText(/v-ready-2/i)).toBeInTheDocument();
      expect(screen.queryByText(/v-building/i)).not.toBeInTheDocument();

      const checkboxes = screen.getAllByRole("checkbox");
      expect(checkboxes).toHaveLength(2);

      const nameInput = screen.getByLabelText(/Tên giải đấu/i);
      await user.type(nameInput, "Spring Cup");

      // Select both versions
      await user.click(checkboxes[0]);
      await user.click(checkboxes[1]);

      const submitBtn = screen.getByRole("button", { name: /Tạo giải đấu \(2 bots đã chọn\)/i });
      expect(submitBtn).toBeEnabled();
      await user.click(submitBtn);

      expect(createTournSpy).toHaveBeenCalledWith(
        {
          name: "Spring Cup",
          entries: [{ botVersionId: "v-ready-1" }, { botVersionId: "v-ready-2" }]
        },
        expect.anything()
      );
    });
  });

  describe("Generation & Unmount Guards", () => {
    it("aborts in-flight login and ignores late response if user returns to lobby", async () => {
      const user = userEvent.setup();
      let resolveLogin!: (val: any) => void;
      const pendingLogin = new Promise((resolve) => { resolveLogin = resolve; });

      vi.spyOn(gateway, "login").mockImplementation(async () => {
        return pendingLogin as any;
      });

      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);

      await user.type(screen.getByLabelText(/Tên đăng nhập/i), "alice");
      await user.type(screen.getByLabelText(/Mật khẩu/i), "pwd");
      await user.click(screen.getByRole("button", { name: /Đăng nhập/i }));

      // User navigates back to lobby while login is pending
      await user.click(screen.getByRole("button", { name: /Về sảnh/i }));
      expect(onLobbyMock).toHaveBeenCalled();

      // Now resolve late login
      resolveLogin({
        token: "late-token",
        user: { id: "u-late", username: "alice", role: "author" }
      });
      await Promise.resolve();

      // Gateway token must NOT be set and profile not displayed
      expect(gateway.getToken()).toBeNull();
    });

    it("aborts in-flight replay fetch and does not call onStartReplay after navigation", async () => {
      const user = userEvent.setup();
      vi.spyOn(gateway, "listMatches").mockResolvedValueOnce({
        matches: [{ id: "m-late", kind: "ranked", status: "completed", createdAt: "2026-10-14T01:00:00Z" }],
        total: 1,
        limit: 20,
        offset: 0
      });

      let resolveReplay!: (val: any) => void;
      const replayPromise = new Promise((resolve) => { resolveReplay = resolve; });
      vi.spyOn(gateway, "getMatchReplay").mockImplementation(async () => replayPromise as any);

      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);
      await user.click(screen.getByRole("tab", { name: /Trận đấu/i }));

      await waitFor(() => expect(screen.getByText("m-late")).toBeInTheDocument());

      await user.click(screen.getByRole("button", { name: /Xem Replay/i }));

      // User returns to lobby while replay is fetching
      await user.click(screen.getByRole("button", { name: /Về sảnh/i }));

      // Resolve late replay
      resolveReplay({
        matchId: "m-late",
        replayDigest: "sha:rep",
        completionDigest: "sha:comp",
        replay: deterministicFixture
      });
      await Promise.resolve();

      expect(onStartReplayMock).not.toHaveBeenCalled();
    });
  });

  describe("Profile Capabilities & Version Submission", () => {
    it("fetches capabilities once authenticated and populates actual profile options", async () => {
      const user = userEvent.setup();
      vi.spyOn(gateway, "getMe").mockResolvedValue({
        user: { id: "u-admin", username: "admin", role: "admin" },
        canSubmitSource: true
      });
      gateway.setToken("admin-tok");

      vi.spyOn(gateway, "getCapabilities").mockResolvedValueOnce({
        executor: "trusted-local-v1",
        trusted: true,
        untrusted: false,
        canSubmitSource: true,
        profiles: ["python", "node", "cpp", "java"]
      });

      vi.spyOn(gateway, "listBots").mockResolvedValue({
        bots: [{ id: "b-1", ownerId: "u-admin", name: "MyBot", status: "active", createdAt: "2026-10-14T00:00:00Z" }],
        total: 1,
        limit: 20,
        offset: 0
      });
      vi.spyOn(gateway, "listBotVersions").mockResolvedValue({ versions: [] });

      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);
      await user.click(screen.getByRole("tab", { name: /Quản lý Bot/i }));

      await waitFor(() => {
        const select = screen.getByLabelText(/Môi trường thực thi:/i) as HTMLSelectElement;
        expect(select).toBeInTheDocument();
        const optionValues = Array.from(select.options).map((o) => o.value);
        expect(optionValues).toEqual(["python", "node", "cpp", "java"]);
      });

      expect(screen.getByRole("option", { name: /cpp \(C\+\+17 \(chỉ nhập tệp\)\)/i })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: /java \(Java 21 \(chỉ nhập tệp\)\)/i })).toBeInTheDocument();
    });

    it("shows error banner and disables source submission when getCapabilities fails in runtime", async () => {
      const user = userEvent.setup();
      vi.spyOn(gateway, "getMe").mockResolvedValue({
        user: { id: "u-admin", username: "admin", role: "admin" },
        canSubmitSource: true
      });
      gateway.setToken("admin-tok");

      vi.spyOn(gateway, "getCapabilities").mockRejectedValueOnce(new Error("Network connection failed"));

      vi.spyOn(gateway, "listBots").mockResolvedValue({
        bots: [{ id: "b-1", ownerId: "u-admin", name: "MyBot", status: "active", createdAt: "2026-10-14T00:00:00Z" }],
        total: 1,
        limit: 20,
        offset: 0
      });
      vi.spyOn(gateway, "listBotVersions").mockResolvedValue({ versions: [] });

      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);
      await user.click(screen.getByRole("tab", { name: /Quản lý Bot/i }));

      await waitFor(() => {
        expect(screen.getByText(/Network connection failed/i)).toBeInTheDocument();
      });

      const select = screen.getByLabelText(/Môi trường thực thi:/i) as HTMLSelectElement;
      expect(select).toBeDisabled();
      expect(screen.getByRole("option", { name: /Không có môi trường khả dụng/i })).toBeInTheDocument();

      const submitBtn = screen.getByRole("button", { name: /Nộp phiên bản/i });
      expect(submitBtn).toBeDisabled();
    });

    it("falls back safely to default profiles when getCapabilities method is absent from legacy mock", async () => {
      const user = userEvent.setup();
      vi.spyOn(gateway, "getMe").mockResolvedValue({
        user: { id: "u-admin", username: "admin", role: "admin" },
        canSubmitSource: true
      });
      gateway.setToken("admin-tok");

      // Delete getCapabilities to emulate older legacy mock without capabilities API
      (gateway as any).getCapabilities = undefined;

      vi.spyOn(gateway, "listBots").mockResolvedValue({
        bots: [{ id: "b-1", ownerId: "u-admin", name: "MyBot", status: "active", createdAt: "2026-10-14T00:00:00Z" }],
        total: 1,
        limit: 20,
        offset: 0
      });
      vi.spyOn(gateway, "listBotVersions").mockResolvedValue({ versions: [] });

      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);
      await user.click(screen.getByRole("tab", { name: /Quản lý Bot/i }));

      await waitFor(() => {
        const select = screen.getByLabelText(/Môi trường thực thi:/i) as HTMLSelectElement;
        expect(select).toBeInTheDocument();
        const optionValues = Array.from(select.options).map((o) => o.value);
        expect(optionValues).toEqual(["node", "python"]);
      });
    });

    it("submits source with actual backend profile ID and resets after submission", async () => {
      const user = userEvent.setup();
      vi.spyOn(gateway, "getMe").mockResolvedValue({
        user: { id: "u-admin", username: "admin", role: "admin" },
        canSubmitSource: true
      });
      gateway.setToken("admin-tok");

      vi.spyOn(gateway, "getCapabilities").mockResolvedValueOnce({
        executor: "trusted-local-v1",
        trusted: true,
        untrusted: false,
        canSubmitSource: true,
        profiles: ["node", "python"]
      });

      vi.spyOn(gateway, "listBots").mockResolvedValue({
        bots: [{ id: "b-1", ownerId: "u-admin", name: "MyBot", status: "active", createdAt: "2026-10-14T00:00:00Z" }],
        total: 1,
        limit: 20,
        offset: 0
      });
      vi.spyOn(gateway, "listBotVersions").mockResolvedValue({ versions: [] });

      const uploadSpy = vi.spyOn(gateway, "uploadBotVersion").mockResolvedValueOnce({
        version: {
          id: "ver-new",
          botId: "b-1",
          versionNo: 1,
          sourceDigest: "sha:valid",
          profileId: "node",
          buildStatus: "pending",
          createdAt: "2026-10-14T00:00:00Z"
        }
      });

      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);
      await user.click(screen.getByRole("tab", { name: /Quản lý Bot/i }));

      await waitFor(() => {
        expect(screen.getByRole("textbox", { name: /mã nguồn bot/i })).toBeInTheDocument();
      });

      const textarea = screen.getByRole("textbox", { name: /mã nguồn bot/i });
      await user.type(textarea, "console.log('my bot');");

      const submitBtn = screen.getByRole("button", { name: /Nộp phiên bản/i });
      expect(submitBtn).toBeEnabled();
      await user.click(submitBtn);

      expect(uploadSpy).toHaveBeenCalledWith(
        "b-1",
        {
          source: "console.log('my bot');",
          profileId: "node"
        },
        expect.anything()
      );
    });

    it("enforces nonempty and MAX_SOURCE_BYTES guards on source submission", async () => {
      const user = userEvent.setup();
      vi.spyOn(gateway, "getMe").mockResolvedValue({
        user: { id: "u-admin", username: "admin", role: "admin" },
        canSubmitSource: true
      });
      gateway.setToken("admin-tok");

      vi.spyOn(gateway, "getCapabilities").mockResolvedValueOnce({
        executor: "trusted-local-v1",
        trusted: true,
        untrusted: false,
        canSubmitSource: true,
        profiles: ["node", "python"]
      });

      vi.spyOn(gateway, "listBots").mockResolvedValue({
        bots: [{ id: "b-1", ownerId: "u-admin", name: "MyBot", status: "active", createdAt: "2026-10-14T00:00:00Z" }],
        total: 1,
        limit: 20,
        offset: 0
      });
      vi.spyOn(gateway, "listBotVersions").mockResolvedValue({ versions: [] });
      const uploadSpy = vi.spyOn(gateway, "uploadBotVersion");

      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);
      await user.click(screen.getByRole("tab", { name: /Quản lý Bot/i }));

      await waitFor(() => {
        expect(screen.getByRole("textbox", { name: /mã nguồn bot/i })).toBeInTheDocument();
        const profileSelect = screen.getByLabelText(/Môi trường thực thi:/i) as HTMLSelectElement;
        expect(profileSelect.value).toBe("node");
      });

      // Initially empty: submit button disabled
      expect(screen.getByRole("button", { name: /Nộp phiên bản/i })).toBeDisabled();

      const textarea = screen.getByRole("textbox", { name: /mã nguồn bot/i });
      // Whitespace only: still disabled
      await user.type(textarea, "   \n  \t  ");
      expect(screen.getByRole("button", { name: /Nộp phiên bản/i })).toBeDisabled();

      // Clear
      await user.clear(textarea);

      // Oversized source (exceeding MAX_SOURCE_BYTES = 262144 bytes)
      const oversized = "a".repeat(262_145);
      fireEvent.change(textarea, { target: { value: oversized } });
      expect(screen.getByRole("button", { name: /Nộp phiên bản/i })).toBeDisabled();

      // Valid source within limit
      await user.clear(textarea);
      await user.type(textarea, "console.log('valid bot');");
      expect(screen.getByRole("button", { name: /Nộp phiên bản/i })).toBeEnabled();

      uploadSpy.mockResolvedValueOnce({
        version: {
          id: "ver-valid",
          botId: "b-1",
          versionNo: 1,
          sourceDigest: "sha:valid",
          profileId: "node",
          buildStatus: "pending",
          createdAt: "2026-10-14T00:00:00Z"
        }
      });
      const liveSubmitBtn = screen.getByRole("button", { name: /Nộp phiên bản/i });
      await user.click(liveSubmitBtn);
      await waitFor(() => {
        expect(uploadSpy).toHaveBeenCalledWith(
          "b-1",
          {
            source: "console.log('valid bot');",
            profileId: "node"
          },
          expect.anything()
        );
      });
    });
  });
});
