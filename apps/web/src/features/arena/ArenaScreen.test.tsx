// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ArenaScreen } from "./ArenaScreen";
import { ArenaApiGateway, ArenaApiError, type ArenaCapabilities } from "./ArenaApiGateway";
import { CompetitionApiClient, CompetitionApiError } from "./competitions";
import { createMockCatalog } from "./competitions/competitionTestFixtures";
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

  it("loads capabilities once before authentication and offers a manual retry after offline", async () => {
    const user = userEvent.setup();
    const getCapabilitiesSpy = vi.spyOn(gateway, "getCapabilities")
      .mockRejectedValueOnce(new ArenaApiError("offline", { code: "network_error", statusCode: 0 }))
      .mockResolvedValueOnce({
        executor: "trusted-local-v1",
        trusted: true,
        untrusted: false,
        canSubmitSource: true,
        profiles: ["node", "python"],
        publicRegistration: true
      });

    render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);

    await waitFor(() => expect(screen.getByText(/Arena hiện ngoại tuyến/i)).toBeInTheDocument());
    expect(getCapabilitiesSpy).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /Thử lại/i }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /Đăng ký/i })).toBeInTheDocument());
    expect(getCapabilitiesSpy).toHaveBeenCalledTimes(2);
  });

  it("cancels a stale capabilities response when leaving the screen", async () => {
    let resolveCapabilities!: (value: ArenaCapabilities) => void;
    const capabilities = new Promise<ArenaCapabilities>((resolve) => { resolveCapabilities = resolve; });
    const getCapabilitiesSpy = vi.spyOn(gateway, "getCapabilities").mockReturnValue(capabilities);
    render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);

    await waitFor(() => expect(getCapabilitiesSpy).toHaveBeenCalledTimes(1));
    await userEvent.setup().click(screen.getByRole("button", { name: /Về sảnh/i }));
    resolveCapabilities({ executor: "late", trusted: false, untrusted: true, canSubmitSource: false, profiles: [], publicRegistration: true });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("tab", { name: /Đăng ký/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Đăng ký/i })).not.toBeInTheDocument();
  });

  it("allows user to register with public registration enabled and switches to login", async () => {
    const user = userEvent.setup();
    vi.spyOn(gateway, "getCapabilities").mockResolvedValueOnce({
      executor: "trusted-local-v1",
      trusted: true,
      untrusted: false,
      canSubmitSource: true,
      profiles: ["node", "python"],
      publicRegistration: true
    });

    const registerSpy = vi.spyOn(gateway, "register").mockResolvedValueOnce({
      user: { id: "u-new", username: "new_bot_author", role: "author" }
    });

    render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);

    await waitFor(() => expect(screen.getByRole("tab", { name: /Đăng ký/i })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: /Đăng ký/i }));

    await user.type(screen.getByLabelText(/Tên đăng nhập/i), " New_Bot_Author ");
    await user.type(screen.getByLabelText(/^Mật khẩu$/i), "securepass123");
    await user.type(screen.getByLabelText(/Xác nhận mật khẩu/i), "securepass123");
    await user.click(screen.getByRole("button", { name: /Tạo tài khoản/i }));

    expect(registerSpy).toHaveBeenCalledWith(
      { username: "New_Bot_Author", password: "securepass123" },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );

    await waitFor(() => {
      expect(screen.getByText(/Tài khoản đã tạo/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Tên đăng nhập/i)).toHaveValue("new_bot_author");
      expect(screen.getByRole("button", { name: /Đăng nhập/i })).toBeInTheDocument();
    });
  });

  it("allows login even when Docker container runtime is down", async () => {
    const user = userEvent.setup();
    vi.spyOn(gateway, "getCapabilities").mockResolvedValueOnce({
      executor: "unavailable",
      trusted: false,
      untrusted: false,
      canSubmitSource: false,
      profiles: []
    });
    vi.spyOn(gateway, "login").mockResolvedValueOnce({
      token: "tok-alice",
      user: { id: "u-alice", username: "alice", role: "author" }
    });
    vi.spyOn(gateway, "getMe").mockResolvedValueOnce({
      user: { id: "u-alice", username: "alice", role: "author" },
      canSubmitSource: false
    });

    render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);

    await user.type(screen.getByLabelText(/Tên đăng nhập/i), "alice");
    await user.type(screen.getByLabelText(/Mật khẩu/i), "password123");
    await user.click(screen.getByRole("button", { name: /Đăng nhập/i }));

    await waitFor(() => {
      expect(screen.getByText("alice")).toBeInTheDocument();
      expect(screen.getByText("author")).toBeInTheDocument();
    });
  });

  it("allows registration even when Docker container runtime is unavailable", async () => {
    const user = userEvent.setup();
    vi.spyOn(gateway, "getCapabilities").mockResolvedValueOnce({
      executor: "unavailable",
      trusted: false,
      untrusted: false,
      canSubmitSource: false,
      profiles: [],
      publicRegistration: true
    });

    const registerSpy = vi.spyOn(gateway, "register").mockResolvedValueOnce({
      user: { id: "u-new", username: "docker_down_author", role: "author" }
    });

    render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);

    await waitFor(() => expect(screen.getByRole("tab", { name: /Đăng ký/i })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: /Đăng ký/i }));

    await user.type(screen.getByLabelText(/Tên đăng nhập/i), "docker_down_author");
    await user.type(screen.getByLabelText(/^Mật khẩu$/i), "password123");
    await user.type(screen.getByLabelText(/Xác nhận mật khẩu/i), "password123");
    await user.click(screen.getByRole("button", { name: /Tạo tài khoản/i }));

    expect(registerSpy).toHaveBeenCalledWith(
      { username: "docker_down_author", password: "password123" },
      expect.anything()
    );

    await waitFor(() => {
      expect(screen.getByText(/Tài khoản đã tạo/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Tên đăng nhập/i)).toHaveValue("docker_down_author");
      expect(screen.getByRole("button", { name: /Đăng nhập/i })).toBeInTheDocument();
    });
  });

  it("settles to offline when capability deadline expires even if gateway ignores abort signal", async () => {
    vi.useFakeTimers();
    try {
      let signalReceived: AbortSignal | undefined;
      // Gateway that ignores abort signal and never settles
      vi.spyOn(gateway, "getCapabilities").mockImplementation((options) => {
        signalReceived = options?.signal;
        return new Promise(() => {});
      });

      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);

      expect(screen.getByRole("status")).toHaveTextContent(/Đang kiểm tra Arena\.\.\./i);
      expect(signalReceived?.aborted).toBe(false);

      // Fast forward past 5000ms deadline
      await vi.advanceTimersByTimeAsync(5000);

      // Signal must be aborted by our timeout controller
      expect(signalReceived?.aborted).toBe(true);

      // Offline banner must settle immediately via Promise.race
      expect(screen.getByRole("alert")).toHaveTextContent(/Arena hiện ngoại tuyến, chỉ mở trong phiên demo/i);
      expect(screen.getByRole("button", { name: /Thử lại/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Quay lại sảnh/i })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not classify caller cancellation as offline error", async () => {
    vi.spyOn(gateway, "getCapabilities").mockRejectedValueOnce(
      new ArenaApiError("Yêu cầu đã bị hủy.", { code: "abort_error", statusCode: 0 })
    );

    render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);

    await waitFor(() => {
      expect(screen.queryByText(/Arena hiện ngoại tuyến/i)).not.toBeInTheDocument();
      expect(screen.getByText("Yêu cầu đã bị hủy.")).toBeInTheDocument();
    });
  });

  it("disables auth controls during deferred registration and prevents double-submission", async () => {
    const user = userEvent.setup();
    vi.spyOn(gateway, "getCapabilities").mockResolvedValueOnce({
      executor: "trusted-local-v1",
      trusted: true,
      untrusted: false,
      canSubmitSource: true,
      profiles: ["node", "python"],
      publicRegistration: true
    });

    let resolveRegister!: (val: any) => void;
    const registerPromise = new Promise((resolve) => { resolveRegister = resolve; });
    const registerSpy = vi.spyOn(gateway, "register").mockImplementation(async () => registerPromise as any);

    render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);

    await waitFor(() => expect(screen.getByRole("tab", { name: /Đăng ký/i })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: /Đăng ký/i }));

    const userInput = screen.getByLabelText(/Tên đăng nhập/i);
    const passInput = screen.getByLabelText(/^Mật khẩu$/i);
    const confirmInput = screen.getByLabelText(/Xác nhận mật khẩu/i);
    await user.type(userInput, "deferred_user");
    await user.type(passInput, "pwd12345");
    await user.type(confirmInput, "pwd12345");

    const submitBtn = screen.getByRole("button", { name: /Tạo tài khoản/i });
    await user.click(submitBtn);

    // Controls must be disabled while request is pending
    expect(userInput).toBeDisabled();
    expect(passInput).toBeDisabled();
    expect(confirmInput).toBeDisabled();
    expect(screen.getByRole("button", { name: /Đang xử lý\.\.\./i })).toBeDisabled();

    // Attempt second click while pending
    await user.click(submitBtn);

    // Must only have been called ONCE
    expect(registerSpy).toHaveBeenCalledTimes(1);

    // Resolve deferred register
    resolveRegister({
      user: { id: "u-def", username: "deferred_user", role: "author" }
    });

    await waitFor(() => {
      expect(screen.getByText(/Tài khoản đã tạo/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Đăng nhập/i })).toBeInTheDocument();
    });
  });

  it("handles cancelled registration without displaying error or changing mode", async () => {
    const user = userEvent.setup();
    vi.spyOn(gateway, "getCapabilities").mockResolvedValueOnce({
      executor: "trusted-local-v1",
      trusted: true,
      untrusted: false,
      canSubmitSource: true,
      profiles: ["node", "python"],
      publicRegistration: true
    });
    vi.spyOn(gateway, "getLeaderboard").mockResolvedValueOnce({ ladderId: "ladder-main", total: 0, ratings: [] });

    vi.spyOn(gateway, "register").mockRejectedValueOnce(
      new ArenaApiError("Yêu cầu đã bị hủy.", { code: "abort_error", statusCode: 0 })
    );

    render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);

    await waitFor(() => expect(screen.getByRole("tab", { name: /Đăng ký/i })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: /Đăng ký/i }));

    await user.type(screen.getByLabelText(/Tên đăng nhập/i), "cancel_user");
    await user.type(screen.getByLabelText(/^Mật khẩu$/i), "pwd12345");
    await user.type(screen.getByLabelText(/Xác nhận mật khẩu/i), "pwd12345");
    await user.click(screen.getByRole("button", { name: /Tạo tài khoản/i }));

    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Tạo tài khoản/i })).toBeInTheDocument();
      expect(screen.getByLabelText(/Tên đăng nhập/i)).toBeEnabled();
      expect(screen.getByLabelText(/Tên đăng nhập/i)).toHaveValue("cancel_user");
    });
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

      const readyVersionsContainer = screen.getByTestId("tournament-ready-versions");
      const checkboxes = within(readyVersionsContainer).getAllByRole("checkbox");
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

    it("aborts in-flight register and ignores late response if user returns to lobby", async () => {
      const user = userEvent.setup();
      vi.spyOn(gateway, "getCapabilities").mockResolvedValueOnce({
        executor: "trusted-local-v1",
        trusted: true,
        untrusted: false,
        canSubmitSource: true,
        profiles: ["node", "python"],
        publicRegistration: true
      });

      let resolveRegister!: (val: any) => void;
      const pendingRegister = new Promise((resolve) => { resolveRegister = resolve; });
      let receivedSignal: AbortSignal | undefined;

      vi.spyOn(gateway, "register").mockImplementation(async (_creds, options) => {
        receivedSignal = options?.signal;
        return pendingRegister as any;
      });

      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);

      await waitFor(() => expect(screen.getByRole("tab", { name: /Đăng ký/i })).toBeInTheDocument());
      await user.click(screen.getByRole("tab", { name: /Đăng ký/i }));

      await user.type(screen.getByLabelText(/Tên đăng nhập/i), "stale_author");
      await user.type(screen.getByLabelText(/^Mật khẩu$/i), "pwd123");
      await user.type(screen.getByLabelText(/Xác nhận mật khẩu/i), "pwd123");
      await user.click(screen.getByRole("button", { name: /Tạo tài khoản/i }));

      expect(receivedSignal).toBeDefined();
      expect(receivedSignal?.aborted).toBe(false);

      // User navigates back to lobby while registration is in-flight
      await user.click(screen.getByRole("button", { name: /Về sảnh/i }));
      expect(onLobbyMock).toHaveBeenCalled();
      expect(receivedSignal?.aborted).toBe(true);

      // Now resolve late registration
      resolveRegister({
        user: { id: "u-late", username: "stale_author", role: "author" }
      });
      await Promise.resolve();

      // Late response notice must NOT be rendered because session generation changed
      expect(screen.queryByText(/Tài khoản đã tạo/i)).not.toBeInTheDocument();
    });

    it("aborts in-flight register and cleans up pending controllers on unmount", async () => {
      const user = userEvent.setup();
      vi.spyOn(gateway, "getCapabilities").mockResolvedValueOnce({
        executor: "trusted-local-v1",
        trusted: true,
        untrusted: false,
        canSubmitSource: true,
        profiles: ["node", "python"],
        publicRegistration: true
      });

      let resolveRegister!: (val: any) => void;
      const pendingRegister = new Promise((resolve) => { resolveRegister = resolve; });
      let receivedSignal: AbortSignal | undefined;

      vi.spyOn(gateway, "register").mockImplementation(async (_creds, options) => {
        receivedSignal = options?.signal;
        return pendingRegister as any;
      });

      const { unmount } = render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);

      await waitFor(() => expect(screen.getByRole("tab", { name: /Đăng ký/i })).toBeInTheDocument());
      await user.click(screen.getByRole("tab", { name: /Đăng ký/i }));

      await user.type(screen.getByLabelText(/Tên đăng nhập/i), "unmount_user");
      await user.type(screen.getByLabelText(/^Mật khẩu$/i), "pwd123");
      await user.type(screen.getByLabelText(/Xác nhận mật khẩu/i), "pwd123");
      await user.click(screen.getByRole("button", { name: /Tạo tài khoản/i }));

      expect(receivedSignal?.aborted).toBe(false);

      unmount();
      expect(receivedSignal?.aborted).toBe(true);
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

  describe("Draft Workbench & Live Match Spectating Integration", () => {
    it("renders DraftPreviewPanel in the Bots tab when a bot is selected", async () => {
      const user = userEvent.setup();
      vi.spyOn(gateway, "getMe").mockResolvedValue({
        user: { id: "u-admin", username: "admin", role: "admin" },
        canSubmitSource: true
      });
      gateway.setToken("admin-tok");

      vi.spyOn(gateway, "listBots").mockResolvedValue({
        bots: [{ id: "bot-1", ownerId: "u-admin", name: "AlphaBot", status: "active", createdAt: "2026-10-15T00:00:00Z" }],
        total: 1,
        limit: 20,
        offset: 0
      });
      vi.spyOn(gateway, "listBotVersions").mockResolvedValue({ versions: [] });

      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);
      await user.click(screen.getByRole("tab", { name: /Quản lý Bot/i }));

      await waitFor(() => {
        expect(screen.getByTestId("draft-preview-panel")).toBeInTheDocument();
      });
      expect(screen.getByText(/Thử nghiệm Bot \(Draft Workbench\)/i)).toBeInTheDocument();
    });

    it("renders Xem trực tiếp button for active matches and opens LiveMatchPanel", async () => {
      const user = userEvent.setup();
      vi.spyOn(gateway, "getMe").mockResolvedValue({
        user: { id: "u-spectator", username: "spec", role: "spectator" },
        canSubmitSource: false
      });
      gateway.setToken("spec-tok");

      vi.spyOn(gateway, "listMatches").mockResolvedValue({
        matches: [
          {
            id: "m-active-1",
            kind: "ranked",
            status: "active",
            createdAt: "2026-10-15T00:00:00Z",
          },
          {
            id: "m-completed-2",
            kind: "practice",
            status: "completed",
            createdAt: "2026-10-15T00:00:00Z",
          }
        ],
        total: 2,
        limit: 20,
        offset: 0
      });

      vi.spyOn(gateway, "getLiveFrames").mockResolvedValue({
        matchId: "m-active-1",
        status: "running",
        terminal: false,
        attemptNo: 1,
        currentPly: 0,
        reset: false,
        frames: []
      });

      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);
      await user.click(screen.getByRole("tab", { name: /Trận đấu/i }));

      await waitFor(() => {
        expect(screen.getByTestId("match-live-m-active-1")).toBeInTheDocument();
      });
      expect(screen.queryByTestId("match-live-m-completed-2")).not.toBeInTheDocument();

      await user.click(screen.getByTestId("match-live-m-active-1"));

      await waitFor(() => {
        expect(screen.getByTestId("live-match-panel")).toBeInTheDocument();
      });
      expect(screen.getByText(/Theo dõi trực tiếp: m-active-1/i)).toBeInTheDocument();
    });

    it("invoking Ctrl+Enter inside BotSourceEditor triggers draft run without submitting upload version form", async () => {
      const user = userEvent.setup();
      vi.spyOn(gateway, "getMe").mockResolvedValue({
        user: { id: "u-admin", username: "admin", role: "admin" },
        canSubmitSource: true,
      });
      gateway.setToken("admin-tok");

      vi.spyOn(gateway, "listBots").mockResolvedValue({
        bots: [{ id: "bot-1", ownerId: "u-admin", name: "AlphaBot", status: "active", createdAt: "2026-10-15T00:00:00Z" }],
        total: 1,
        limit: 20,
        offset: 0,
      });
      vi.spyOn(gateway, "listBotVersions").mockResolvedValue({ versions: [] });

      const runDraftSpy = vi.spyOn(gateway, "runDraft").mockResolvedValue({
        status: "success",
        isolation: "trusted-process",
        compile: { status: "ok", logs: "Compile OK" },
        execution: { legal: true, elapsedMs: 12 },
      });
      const uploadVersionSpy = vi.spyOn(gateway, "uploadBotVersion");

      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);
      await user.click(screen.getByRole("tab", { name: /Quản lý Bot/i }));

      await waitFor(() => {
        expect(screen.getByLabelText("Mã nguồn bot")).toBeInTheDocument();
      });

      const textarea = screen.getByLabelText("Mã nguồn bot");
      fireEvent.change(textarea, { target: { value: "const myMove = { from: { x: 4, y: 7 }, to: { x: 4, y: 8 } };" } });

      // Press Ctrl+Enter inside the editor textarea
      fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

      await waitFor(() => {
        expect(runDraftSpy).toHaveBeenCalledWith(
          "bot-1",
          expect.objectContaining({
            source: expect.stringContaining("const myMove"),
          }),
          expect.any(Object)
        );
      });

      // Crucial: uploadBotVersion must NOT have been called!
      expect(uploadVersionSpy).not.toHaveBeenCalled();
    });
  });

  describe("Accessibility & Session Invalidation", () => {
    it("exposes accessible role alert when login fails", async () => {
      const user = userEvent.setup();
      vi.spyOn(gateway, "login").mockRejectedValueOnce(new Error("Tên đăng nhập hoặc mật khẩu không đúng"));
      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);

      const userInput = screen.getByLabelText(/Tên đăng nhập/i);
      const passInput = screen.getByLabelText(/Mật khẩu/i);
      await user.type(userInput, "alice");
      await user.type(passInput, "wrongpass");
      await user.click(screen.getByRole("button", { name: /Đăng nhập/i }));

      await waitFor(() => {
        const alert = screen.getByTestId("login-error-alert");
        expect(alert).toHaveAttribute("role", "alert");
        expect(alert).toHaveTextContent("Tên đăng nhập hoặc mật khẩu không đúng");
      });
    });

    it("invalidates session from CompetitionPortal HTTP 401 callback while preserving unsaved editor draft", async () => {
      const user = userEvent.setup();
      vi.spyOn(gateway, "getMe").mockResolvedValue({
        user: { id: "u-author", username: "author", role: "author" },
        canSubmitSource: true,
      });
      gateway.setToken("active-author-tok");

      vi.spyOn(gateway, "listBots").mockResolvedValue({
        bots: [{ id: "b-1", ownerId: "u-author", name: "MyBot", status: "active", createdAt: "2026-10-14T00:00:00Z" }],
        total: 1,
        limit: 20,
        offset: 0,
      });
      vi.spyOn(gateway, "listBotVersions").mockResolvedValue({ versions: [] });

      // Spy on CompetitionApiClient to trigger HTTP 401
      vi.spyOn(CompetitionApiClient.prototype, "listCompetitions").mockRejectedValue(
        new CompetitionApiError("Phiên làm việc hết hạn", {
          code: "UNAUTHORIZED",
          statusCode: 401,
        })
      );
      vi.spyOn(CompetitionApiClient.prototype, "getCatalog").mockResolvedValue(createMockCatalog());

      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);

      // Switch to bot management tab and type unsaved draft code into editor
      await user.click(screen.getByRole("tab", { name: /Quản lý Bot/i }));
      await waitFor(() => {
        expect(screen.getByLabelText("Mã nguồn bot")).toBeInTheDocument();
      });
      const textarea = screen.getByLabelText("Mã nguồn bot");
      fireEvent.change(textarea, { target: { value: "const preservedDraftCode = 9999;" } });

      // Switch to competitions tab, which will trigger the 401
      await user.click(screen.getByRole("tab", { name: /Sự kiện thi đấu/i }));

      // Verify session is invalidated: gateway token cleared, user logged out
      await waitFor(() => {
        expect(gateway.getToken()).toBeNull();
        expect(screen.getByRole("button", { name: /Đăng nhập/i })).toBeInTheDocument();
      });

      // Switch back to bot tab and verify unsaved draft remains preserved
      await user.click(screen.getByRole("tab", { name: /Quản lý Bot/i }));
      expect((screen.getByLabelText("Mã nguồn bot") as HTMLTextAreaElement).value).toBe("const preservedDraftCode = 9999;");
    });

    it("does not clear fresh session if 401 callback has stale superseded token", async () => {
      const user = userEvent.setup();
      vi.spyOn(gateway, "getMe").mockResolvedValue({
        user: { id: "u-author", username: "author", role: "author" },
        canSubmitSource: true,
      });
      gateway.setToken("fresh-token-456");

      vi.spyOn(gateway, "listBots").mockResolvedValue({
        bots: [{ id: "b-1", ownerId: "u-author", name: "MyBot", status: "active", createdAt: "2026-10-14T00:00:00Z" }],
        total: 1,
        limit: 20,
        offset: 0,
      });
      vi.spyOn(gateway, "listBotVersions").mockResolvedValue({ versions: [] });

      // When listCompetitions rejects, it throws with stale sessionGeneration or stale token
      const gatewayWithGen = gateway as { getSessionGeneration?(): number };
      const staleGen = typeof gatewayWithGen.getSessionGeneration === "function" ? 9999 : undefined;
      vi.spyOn(CompetitionApiClient.prototype, "listCompetitions").mockRejectedValue(
        new CompetitionApiError("Old session expired", {
          code: "UNAUTHORIZED",
          statusCode: 401,
          token: "stale-token-123",
          sessionGeneration: staleGen,
        })
      );
      vi.spyOn(CompetitionApiClient.prototype, "getCatalog").mockResolvedValue(createMockCatalog());

      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Đăng xuất/i })).toBeInTheDocument();
      });

      // Switch to competitions tab, triggering the 401 with stale token "stale-token-123"
      await user.click(screen.getByRole("tab", { name: /Sự kiện thi đấu/i }));

      // Wait a tick to ensure any async error processing has run
      await waitFor(() => {
        expect(screen.getByText("Old session expired")).toBeInTheDocument();
      });

      // Crucial: fresh session must NOT have been invalidated!
      expect(gateway.getToken()).toBe("fresh-token-456");
      expect(screen.getByRole("button", { name: /Đăng xuất/i })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Đăng nhập/i })).not.toBeInTheDocument();
    });
  });

  describe("Guest Public Browsing & Capability/Auth Gating", () => {
    it("allows guest public browsing across leaderboard, matches, and tournaments without auth headers", async () => {
      const user = userEvent.setup();
      vi.spyOn(gateway, "getLeaderboard").mockResolvedValueOnce({
        ladderId: "ladder-main",
        total: 1,
        ratings: [
          { rank: 1, botId: "bot-1", botName: "PublicBot", ownerId: "u-1", rating: 1500, ratedGames: 10, wins: 5, draws: 2, losses: 3 },
        ],
      });
      vi.spyOn(gateway, "listMatches").mockResolvedValueOnce({
        matches: [
          { id: "m-1", kind: "ranked", status: "completed", createdAt: "2026-10-16T00:00:00Z" },
        ],
        total: 1,
        limit: 20,
        offset: 0,
      });
      vi.spyOn(gateway, "listTournaments").mockResolvedValueOnce({
        tournaments: [
          { id: "tourn-public", name: "Public Open", status: "pending", pointScheme: "standard", ranked: true, createdAt: "2026-10-16T00:00:00Z" },
        ],
        total: 1,
      });
      vi.spyOn(gateway, "getTournament").mockResolvedValueOnce({
        tournament: { id: "tourn-main", name: "Main Tourney", status: "active", pointScheme: "standard", ranked: true, createdAt: "2026-10-16T00:00:00Z" },
        standings: [],
        matches: [],
      });
      const listBotsSpy = vi.spyOn(gateway, "listBots");

      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);

      // Leaderboard loads publicly
      await waitFor(() => {
        expect(screen.getByText("PublicBot")).toBeInTheDocument();
      });
      expect(screen.queryByText(/Missing Authorization header/i)).not.toBeInTheDocument();

      // Switch to Matches
      await user.click(screen.getByRole("tab", { name: /Trận đấu/i }));
      await waitFor(() => {
        expect(screen.getByText("m-1")).toBeInTheDocument();
      });

      // Switch to Tournaments
      await user.click(screen.getByRole("tab", { name: /Giải đấu/i }));
      await waitFor(() => {
        expect(screen.getByText("Public Open")).toBeInTheDocument();
      });
      // Guest should NOT have triggered listBots
      expect(listBotsSpy).not.toHaveBeenCalled();

      // Switch to Bots as guest -> shows login CTA, does NOT call listBots
      await user.click(screen.getByRole("tab", { name: /Quản lý Bot/i }));
      await waitFor(() => {
        expect(screen.getByTestId("bots-guest-cta")).toHaveTextContent(/Vui lòng đăng nhập để tạo và quản lý bot/i);
        expect(screen.getByTestId("upload-login-banner")).toHaveTextContent(/Vui lòng đăng nhập để nộp phiên bản mã nguồn/i);
      });
      expect(screen.queryByText(/Task 19/i)).not.toBeInTheDocument();
    });

    it("allows author to submit container version when capability allows", async () => {
      gateway.setToken("tok-author");
      vi.spyOn(gateway, "getMe").mockResolvedValue({
        user: { id: "u-author", username: "author", role: "author" },
        canSubmitSource: true,
      });
      vi.spyOn(gateway, "listBots").mockResolvedValue({
        bots: [{ id: "b-author-1", ownerId: "u-author", name: "AuthorBot", status: "active", createdAt: "2026-10-15T00:00:00Z" }],
        total: 1,
        limit: 20,
        offset: 0,
      });
      vi.spyOn(gateway, "listBotVersions").mockResolvedValue({ versions: [] });

      const user = userEvent.setup();
      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);

      await user.click(screen.getByRole("tab", { name: /Quản lý Bot/i }));
      await waitFor(() => {
        expect(screen.getByText("AuthorBot")).toBeInTheDocument();
      });

      // Crucial: No restriction banner should be present for author with container capability
      expect(screen.queryByTestId("upload-trusted_admin-banner")).not.toBeInTheDocument();
      expect(screen.queryByTestId("upload-container_unavailable-banner")).not.toBeInTheDocument();
      expect(screen.queryByText(/Task 19/i)).not.toBeInTheDocument();

      // Select and submit button enabled once code is present
      const profileSelect = screen.getByLabelText(/Môi trường thực thi/i);
      expect(profileSelect).not.toBeDisabled();
    });

    it("displays true trusted admin restriction message when container execution is not configured", async () => {
      gateway.setToken("tok-author");
      vi.spyOn(gateway, "getCapabilities").mockResolvedValue({
        executor: "trusted-local-v1",
        trusted: true,
        untrusted: false,
        canSubmitSource: false,
        profiles: ["node", "python"],
        localDemoContainers: false,
      });
      vi.spyOn(gateway, "getMe").mockResolvedValue({
        user: { id: "u-author", username: "author", role: "author" },
        canSubmitSource: false,
      });
      vi.spyOn(gateway, "listBots").mockResolvedValue({
        bots: [{ id: "b-author-1", ownerId: "u-author", name: "AuthorBot", status: "active", createdAt: "2026-10-15T00:00:00Z" }],
        total: 1,
        limit: 20,
        offset: 0,
      });
      vi.spyOn(gateway, "listBotVersions").mockResolvedValue({ versions: [] });

      const user = userEvent.setup();
      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);

      await user.click(screen.getByRole("tab", { name: /Quản lý Bot/i }));
      await waitFor(() => {
        expect(screen.getByTestId("upload-trusted_admin-banner")).toHaveTextContent(
          /Hệ thống đang ở chế độ Trusted\. Chỉ quản trị viên mới có quyền nộp mã nguồn bot\./i
        );
      });
      expect(screen.queryByText(/Task 19/i)).not.toBeInTheDocument();
    });

    it("displays distinct container unavailable message when Docker runtime is unavailable", async () => {
      gateway.setToken("tok-author");
      vi.spyOn(gateway, "getCapabilities").mockResolvedValue({
        executor: "container-executor",
        trusted: false,
        untrusted: true,
        canSubmitSource: false,
        profiles: ["node", "python"],
        localDemoContainers: true,
        localDocker: { available: false, reason: "docker_daemon_unavailable" },
      });
      vi.spyOn(gateway, "getMe").mockResolvedValue({
        user: { id: "u-author", username: "author", role: "author" },
        canSubmitSource: false,
      });
      vi.spyOn(gateway, "listBots").mockResolvedValue({
        bots: [{ id: "b-author-1", ownerId: "u-author", name: "AuthorBot", status: "active", createdAt: "2026-10-15T00:00:00Z" }],
        total: 1,
        limit: 20,
        offset: 0,
      });
      vi.spyOn(gateway, "listBotVersions").mockResolvedValue({ versions: [] });

      const user = userEvent.setup();
      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);

      await user.click(screen.getByRole("tab", { name: /Quản lý Bot/i }));
      await waitFor(() => {
        expect(screen.getByTestId("upload-container_unavailable-banner")).toHaveTextContent(
          /Môi trường thực thi container hiện không khả dụng/i
        );
      });
      expect(screen.queryByText(/Task 19/i)).not.toBeInTheDocument();
    });
  });

  describe("Tournament Pending & Start Contract", () => {
    it("renders Bắt đầu ngay checkbox (default true) and supports creating pending tournament", async () => {
      gateway.setToken("tok-admin");
      vi.spyOn(gateway, "getMe").mockResolvedValue({
        user: { id: "u-admin", username: "admin", role: "admin" },
        canSubmitSource: true,
      });
      vi.spyOn(gateway, "listTournaments").mockResolvedValue({ tournaments: [], total: 0 });
      vi.spyOn(gateway, "getTournament").mockResolvedValue({
        tournament: { id: "tourn-main", name: "Main", status: "active", pointScheme: "standard", ranked: true, createdAt: "2026-10-16T00:00:00Z" },
        standings: [],
        matches: [],
      });
      vi.spyOn(gateway, "listBots").mockResolvedValue({
        bots: [
          { id: "b-1", ownerId: "u-admin", name: "Bot1", status: "active", createdAt: "2026-10-16T00:00:00Z" },
          { id: "b-2", ownerId: "u-admin", name: "Bot2", status: "active", createdAt: "2026-10-16T00:00:00Z" },
        ],
        total: 2,
        limit: 20,
        offset: 0,
      });
      vi.spyOn(gateway, "listBotVersions")
        .mockResolvedValueOnce({ versions: [{ id: "v-1", botId: "b-1", versionNo: 1, buildStatus: "ready", sourceDigest: "d1", profileId: "node", profileRevision: "rev1", createdAt: "2026-10-16T00:00:00Z" }] })
        .mockResolvedValueOnce({ versions: [{ id: "v-2", botId: "b-2", versionNo: 1, buildStatus: "ready", sourceDigest: "d2", profileId: "node", profileRevision: "rev1", createdAt: "2026-10-16T00:00:00Z" }] });

      const createSpy = vi.spyOn(gateway, "createTournament").mockResolvedValue({
        tournament: { id: "tourn-pending-1", name: "Autumn Cup", status: "pending", pointScheme: "standard", ranked: true, createdAt: "2026-10-16T00:00:00Z" },
        matchesCount: 0,
      });

      const user = userEvent.setup();
      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);

      await user.click(screen.getByRole("tab", { name: /Giải đấu/i }));

      await waitFor(() => {
        expect(screen.getByText("Tạo giải đấu mới (Admin)")).toBeInTheDocument();
      });

      const startImmediatelyCheckbox = screen.getByTestId("tournament-start-immediately-checkbox") as HTMLInputElement;
      expect(startImmediatelyCheckbox.checked).toBe(true);

      // Uncheck "Bắt đầu ngay" to test pending creation
      await user.click(startImmediatelyCheckbox);
      expect(startImmediatelyCheckbox.checked).toBe(false);

      // Fill tournament name and select 2 bots
      await user.type(screen.getByLabelText(/Tên giải đấu/i), "Autumn Cup");
      await user.click(screen.getByLabelText(/Bot1/i));
      await user.click(screen.getByLabelText(/Bot2/i));

      await user.click(screen.getByRole("button", { name: /Tạo giải đấu/i }));

      await waitFor(() => {
        expect(createSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "Autumn Cup",
            startImmediately: false,
            entries: expect.arrayContaining([
              { botVersionId: "v-1" },
              { botVersionId: "v-2" },
            ]),
          }),
          expect.anything()
        );
      });
    });

    it("renders Bắt đầu giải action for admin on pending tournament with matches.length===0 and starts it", async () => {
      gateway.setToken("tok-admin");
      vi.spyOn(gateway, "getMe").mockResolvedValue({
        user: { id: "u-admin", username: "admin", role: "admin" },
        canSubmitSource: true,
      });
      vi.spyOn(gateway, "listTournaments").mockResolvedValue({
        tournaments: [
          { id: "tourn-pending-1", name: "Pending Cup", status: "pending", pointScheme: "standard", ranked: true, createdAt: "2026-10-16T00:00:00Z" },
        ],
        total: 1,
      });
      vi.spyOn(gateway, "getTournament").mockResolvedValue({
        tournament: { id: "tourn-pending-1", name: "Pending Cup", status: "pending", pointScheme: "standard", ranked: true, createdAt: "2026-10-16T00:00:00Z" },
        standings: [],
        matches: [],
      });
      vi.spyOn(gateway, "listBots").mockResolvedValue({ bots: [], total: 0, limit: 20, offset: 0 });

      const startSpy = vi.spyOn(gateway, "startTournament").mockResolvedValue({
        tournament: { id: "tourn-pending-1", name: "Pending Cup", status: "active", totalMatches: 2 },
      });

      const user = userEvent.setup();
      render(<ArenaScreen gateway={gateway} onLobby={onLobbyMock} onStartReplay={onStartReplayMock} />);

      await user.click(screen.getByRole("tab", { name: /Giải đấu/i }));

      await waitFor(() => {
        expect(screen.getByTestId("start-tournament-btn")).toBeInTheDocument();
      });

      await user.click(screen.getByTestId("start-tournament-btn"));

      await waitFor(() => {
        expect(startSpy).toHaveBeenCalledWith("tourn-pending-1", expect.anything());
      });
    });
  });
});
