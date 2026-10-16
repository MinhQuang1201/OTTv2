import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ArenaApiGateway, ArenaApiError, validateDiscoveredArenaEndpoint } from "./ArenaApiGateway";
import deterministicFixture from "../../../../../tests/fixtures/arena/replays/deterministic-match.json";

describe("ArenaApiGateway", () => {
  const baseUrl = "http://127.0.0.1:8787/api/arena/v1";
  let gateway: ArenaApiGateway;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    gateway = new ArenaApiGateway({ baseUrl });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("Token Management & Privacy", () => {
    it("manages Bearer token strictly in memory without storage leakage", () => {
      const setLocalSpy = vi.spyOn(Storage.prototype, "setItem");
      expect(gateway.isAuthenticated()).toBe(false);
      expect(gateway.getToken()).toBeNull();

      gateway.setToken("test-token-123");
      expect(gateway.isAuthenticated()).toBe(true);
      expect(gateway.getToken()).toBe("test-token-123");

      gateway.setToken(null);
      expect(gateway.isAuthenticated()).toBe(false);
      expect(gateway.getToken()).toBeNull();

      expect(setLocalSpy).not.toHaveBeenCalled();
    });
  });

  describe("Authentication API", () => {
    it("registers without setting or sending a bearer token", async () => {
      gateway.setToken("existing-token");
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ user: { id: "u-new", username: "demo_user", role: "author" } })
      });

      const result = await gateway.register(
        { username: "demo_user", password: "password123" },
        { signal: new AbortController().signal }
      );

      expect(result.user).toEqual({ id: "u-new", username: "demo_user", role: "author" });
      expect(gateway.getToken()).toBe("existing-token");
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:8787/api/arena/v1/auth/register",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer existing-token" },
          body: JSON.stringify({ username: "demo_user", password: "password123" })
        })
      );
    });

    it("preserves backend registration error codes", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 409,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ error: { code: "USERNAME_TAKEN", message: "Username already exists" } })
      });

      await expect(gateway.register({ username: "demo_user", password: "password123" })).rejects.toMatchObject({
        code: "USERNAME_TAKEN",
        statusCode: 409
      });
    });

    it("maps disabled registration error code", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ error: { code: "REGISTRATION_DISABLED", message: "Public registration is disabled" } })
      });

      await expect(gateway.register({ username: "demo_user", password: "password123" })).rejects.toMatchObject({
        code: "REGISTRATION_DISABLED",
        statusCode: 404
      });
    });

    it("maps registration network error when fetch fails", async () => {
      fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

      await expect(gateway.register({ username: "demo_user", password: "password123" })).rejects.toMatchObject({
        code: "network_error",
        statusCode: 0
      });
    });

    it("logs in successfully and captures token in memory", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          token: "jwt-token-abc",
          user: { id: "u-1", username: "alice", role: "author" },
          expiresAt: "2026-10-15T00:00:00Z"
        })
      });

      const result = await gateway.login({ username: "alice", password: "password123" });
      expect(result.token).toBe("jwt-token-abc");
      expect(result.user.username).toBe("alice");
      expect(gateway.getToken()).toBe("jwt-token-abc");
      expect(gateway.isAuthenticated()).toBe(true);

      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:8787/api/arena/v1/auth/login",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json"
          }),
          body: JSON.stringify({ username: "alice", password: "password123" })
        })
      );
    });

    it("logs out and clears token from memory", async () => {
      gateway.setToken("active-token");
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ ok: true })
      });

      await gateway.logout();
      expect(gateway.getToken()).toBeNull();
      expect(gateway.isAuthenticated()).toBe(false);

      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:8787/api/arena/v1/auth/logout",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer active-token"
          })
        })
      );
    });

    it("clears token even if logout request fails", async () => {
      gateway.setToken("active-token");
      fetchMock.mockRejectedValueOnce(new Error("Network failed"));

      await expect(gateway.logout()).rejects.toThrow();
      expect(gateway.getToken()).toBeNull();
      expect(gateway.isAuthenticated()).toBe(false);
    });
  });

  describe("API Endpoints & Contracts", () => {
    it("gets capabilities without requiring auth token", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          executor: "trusted-local-v1",
          trusted: true,
          untrusted: false,
          canSubmitSource: false,
          profiles: ["controlled-node", "python-v1"]
        })
      });

      const caps = await gateway.getCapabilities();
      expect(caps.executor).toBe("trusted-local-v1");
      expect(caps.canSubmitSource).toBe(false);
      expect(caps.profiles).toEqual(["controlled-node", "python-v1"]);
    });

    it("gets current user profile via /me", async () => {
      gateway.setToken("token-xyz");
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          user: { id: "u-2", username: "admin", role: "admin" },
          canSubmitSource: true
        })
      });

      const me = await gateway.getMe();
      expect(me.user.role).toBe("admin");
      expect(me.canSubmitSource).toBe(true);
    });

    it("lists bots with pagination", async () => {
      gateway.setToken("token-xyz");
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          bots: [
            { id: "bot-1", ownerId: "u-1", name: "ChampionBot", status: "active", createdAt: "2026-10-14T00:00:00Z" }
          ],
          total: 1,
          limit: 20,
          offset: 0
        })
      });

      const res = await gateway.listBots({ limit: 20, offset: 0 });
      expect(res.bots).toHaveLength(1);
      expect(res.bots[0].name).toBe("ChampionBot");
    });

    it("creates a bot with Idempotency-Key", async () => {
      gateway.setToken("token-xyz");
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          bot: { id: "bot-2", ownerId: "u-1", name: "RunnerBot", status: "active", createdAt: "2026-10-14T00:00:00Z" }
        })
      });

      const bot = await gateway.createBot({ name: "RunnerBot" }, { idempotencyKey: "idem-bot-123" });
      expect(bot.id).toBe("bot-2");
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:8787/api/arena/v1/bots",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Idempotency-Key": "idem-bot-123"
          })
        })
      );
    });

    it("lists bot versions", async () => {
      gateway.setToken("token-xyz");
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          versions: [
            {
              id: "v-1",
              botId: "bot-1",
              versionNo: 1,
              sourceDigest: "sha256:abc",
              profileId: "controlled-node",
              buildStatus: "ready",
              createdAt: "2026-10-14T00:00:00Z"
            }
          ]
        })
      });

      const res = await gateway.listBotVersions("bot-1");
      expect(res.versions).toHaveLength(1);
      expect(res.versions[0].buildStatus).toBe("ready");
    });

    it("lists ready bot versions via /ready-versions with public metadata", async () => {
      gateway.setToken("token-xyz");
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          versions: [
            {
              id: "v-ready-1",
              botId: "bot-opponent",
              versionNo: 2,
              profileId: "controlled-node",
              buildStatus: "ready",
              createdAt: "2026-10-14T00:00:00Z"
            }
          ]
        })
      });

      const res = await gateway.listReadyBotVersions("bot-opponent");
      expect(res.versions).toHaveLength(1);
      expect(res.versions[0].id).toBe("v-ready-1");
      expect(res.versions[0].botId).toBe("bot-opponent");
      expect(res.versions[0].buildStatus).toBe("ready");
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:8787/api/arena/v1/bots/bot-opponent/ready-versions",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("uploads bot version with Idempotency-Key", async () => {
      gateway.setToken("token-xyz");
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          version: {
            id: "v-2",
            botId: "bot-1",
            versionNo: 2,
            sourceDigest: "sha256:def",
            profileId: "controlled-node",
            buildStatus: "pending",
            createdAt: "2026-10-14T00:00:00Z"
          },
          job: { id: "job-1", kind: "build", status: "queued" }
        })
      });

      const res = await gateway.uploadBotVersion(
        "bot-1",
        { source: "export function getMove() {}", profileId: "controlled-node" },
        { idempotencyKey: "idem-ver-456" }
      );
      expect(res.version.versionNo).toBe(2);
      expect(res.job?.id).toBe("job-1");
    });

    it("creates practice match with kind practice and idempotency key", async () => {
      gateway.setToken("token-xyz");
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          match: {
            id: "match-prac-1",
            kind: "practice",
            ladderId: "ladder-main",
            status: "pending",
            participants: {
              A: { seat: "A", botVersionId: "v-1" },
              B: { seat: "B", botVersionId: "v-2" }
            }
          }
        })
      });

      const res = await gateway.createPracticeMatch(
        {
          participants: {
            A: { botVersionId: "v-1" },
            B: { botVersionId: "v-2" }
          }
        },
        { idempotencyKey: "idem-prac-1" }
      );

      expect(res.match.id).toBe("match-prac-1");
      expect(res.match.kind).toBe("practice");
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/matches"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Idempotency-Key": "idem-prac-1",
            "Content-Type": "application/json"
          }),
          body: JSON.stringify({
            kind: "practice",
            ladderId: "ladder-main",
            participants: {
              A: { botVersionId: "v-1" },
              B: { botVersionId: "v-2" }
            }
          })
        })
      );
    });

    it("retrieves leaderboard with ladderId parameter", async () => {
      gateway.setToken("token-xyz");
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          ladderId: "ladder-main",
          total: 1,
          ratings: [
            {
              rank: 1,
              botId: "bot-1",
              botName: "ChampionBot",
              ownerId: "u-1",
              rating: 1500,
              ratedGames: 10,
              wins: 8,
              draws: 1,
              losses: 1
            }
          ]
        })
      });

      const board = await gateway.getLeaderboard("ladder-main");
      expect(board.ratings).toHaveLength(1);
      expect(board.ratings[0].botName).toBe("ChampionBot");
      expect(board.ratings[0].rank).toBe(1);
    });

    it("retrieves match replay document and validates it with shared validator", async () => {
      gateway.setToken("token-xyz");
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          matchId: "m-1",
          replayDigest: "sha256:rep123",
          completionDigest: "sha256:comp123",
          replay: deterministicFixture
        })
      });

      const res = await gateway.getMatchReplay("m-1");
      expect(res.matchId).toBe("m-1");
      expect(res.replay.matchId).toBe(deterministicFixture.matchId);
    });

    it("throws ArenaApiError with code invalid_replay when replay document fails validation", async () => {
      gateway.setToken("token-xyz");
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          matchId: "m-1",
          replayDigest: "sha256:rep123",
          completionDigest: "sha256:comp123",
          replay: { broken: "not a replay" }
        })
      });

      await expect(gateway.getMatchReplay("m-1")).rejects.toThrow(ArenaApiError);
      try {
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            matchId: "m-1",
            replayDigest: "sha256:rep123",
            completionDigest: "sha256:comp123",
            replay: { broken: "not a replay" }
          })
        });
        await gateway.getMatchReplay("m-1");
      } catch (err: any) {
        expect(err.code).toBe("invalid_replay");
      }
    });

    it("runs draft execution and returns referee diagnostics", async () => {
      gateway.setToken("token-xyz");
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          status: "success",
          isolation: "container",
          compile: { status: "ok", logs: "" },
          execution: {
            legal: true,
            move: { from: { x: 4, y: 7 }, to: { x: 4, y: 8 } },
            comment: "draft test move",
            elapsedMs: 25
          },
          nextState: { turn: "B", pieces: [] }
        })
      });

      const res = await gateway.runDraft("bot-1", {
        source: "some bot code",
        profileId: "node",
        mapId: "classic"
      });

      expect(res.status).toBe("success");
      expect(res.isolation).toBe("container");
      expect(res.execution?.legal).toBe(true);
      expect(res.execution?.move?.to.y).toBe(8);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:8787/api/arena/v1/bots/bot-1/draft/run",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer token-xyz",
            "Content-Type": "application/json"
          }),
          body: JSON.stringify({
            source: "some bot code",
            profileId: "node",
            mapId: "classic"
          })
        })
      );
    });

    it("fetches incremental live frames with afterPly and attemptNo query parameters", async () => {
      gateway.setToken("token-xyz");
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          matchId: "m-live-1",
          status: "running",
          terminal: false,
          attemptNo: 1,
          currentPly: 2,
          reset: false,
          frames: [
            { ply: 1, seat: "A", move: { from: { x: 4, y: 7 }, to: { x: 4, y: 8 } } },
            { ply: 2, seat: "B", move: { from: { x: 4, y: 1 }, to: { x: 4, y: 2 } } }
          ]
        })
      });

      const res = await gateway.getLiveFrames("m-live-1", {
        afterPly: 0,
        attemptNo: 1,
        limit: 50
      });

      expect(res.matchId).toBe("m-live-1");
      expect(res.status).toBe("running");
      expect(res.frames).toHaveLength(2);
      expect(res.reset).toBe(false);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:8787/api/arena/v1/matches/m-live-1/live?afterPly=0&attemptNo=1&limit=50",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: "Bearer token-xyz"
          })
        })
      );
    });

    it("receives reset: true from live frames endpoint when worker resets attempt", async () => {
      gateway.setToken("token-xyz");
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          matchId: "m-live-1",
          status: "running",
          terminal: false,
          attemptNo: 2,
          currentPly: 0,
          reset: true,
          frames: [{ ply: 0, seat: null, move: null }]
        })
      });

      const res = await gateway.getLiveFrames("m-live-1", { afterPly: 5, attemptNo: 1 });
      expect(res.reset).toBe(true);
      expect(res.attemptNo).toBe(2);
      expect(res.frames).toHaveLength(1);
    });

    it("receives terminal: true and replayUrl when match finalized and pruned", async () => {
      gateway.setToken("token-xyz");
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          matchId: "m-live-1",
          status: "completed",
          terminal: true,
          replayUrl: "/api/arena/v1/matches/m-live-1/replay",
          attemptNo: 0,
          currentPly: 0,
          reset: false,
          frames: []
        })
      });

      const res = await gateway.getLiveFrames("m-live-1", { afterPly: 10 });
      expect(res.terminal).toBe(true);
      expect(res.status).toBe("completed");
      expect(res.replayUrl).toBe("/api/arena/v1/matches/m-live-1/replay");
    });
  });

  describe("Error Mapping & Taxonomy", () => {
    it("parses structured backend errors into ArenaApiError", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          error: {
            code: "SOURCE_SUBMISSION_DISABLED",
            message: "Source submission is disabled in trusted mode",
            requestId: "req-err-1",
            details: { canSubmitSource: false }
          }
        })
      });

      await expect(gateway.uploadBotVersion("bot-1", { source: "test", profileId: "p-1" }))
        .rejects.toThrow(ArenaApiError);

      try {
        fetchMock.mockResolvedValueOnce({
          ok: false,
          status: 403,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            error: {
              code: "SOURCE_SUBMISSION_DISABLED",
              message: "Source submission is disabled in trusted mode",
              requestId: "req-err-1",
              details: { canSubmitSource: false }
            }
          })
        });
        await gateway.uploadBotVersion("bot-1", { source: "test", profileId: "p-1" });
      } catch (err: any) {
        expect(err).toBeInstanceOf(ArenaApiError);
        expect(err.code).toBe("SOURCE_SUBMISSION_DISABLED");
        expect(err.statusCode).toBe(403);
        expect(err.requestId).toBe("req-err-1");
        expect(err.details).toEqual({ canSubmitSource: false });
      }
    });

    it("maps abort signal to abort_error code", async () => {
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";
      fetchMock.mockRejectedValueOnce(abortError);

      const controller = new AbortController();
      controller.abort();

      try {
        await gateway.getLeaderboard("ladder-main", { signal: controller.signal });
        expect.unreachable("Should have thrown");
      } catch (err: any) {
        expect(err).toBeInstanceOf(ArenaApiError);
        expect(err.code).toBe("abort_error");
      }
    });

    it("maps network failures to network_error code", async () => {
      fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

      try {
        await gateway.listBots();
        expect.unreachable("Should have thrown");
      } catch (err: any) {
        expect(err).toBeInstanceOf(ArenaApiError);
        expect(err.code).toBe("network_error");
        expect(err.statusCode).toBe(0);
      }
    });

    it("lists public tournaments without authorization when unauthenticated", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          tournaments: [
            { id: "tourn-1", name: "Spring 2026", status: "pending", pointScheme: "standard", ranked: true, createdAt: "2026-10-16T00:00:00Z" }
          ],
          total: 1
        })
      });

      const res = await gateway.listTournaments();
      expect(res.tournaments).toHaveLength(1);
      expect(res.tournaments[0].id).toBe("tourn-1");
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:8787/api/arena/v1/tournaments",
        expect.objectContaining({
          method: "GET"
        })
      );
    });

    it("starts a tournament via admin start endpoint with idempotency key", async () => {
      gateway.setToken("admin-tok");
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          tournament: { id: "tourn-1", name: "Spring 2026", status: "running", totalMatches: 6 }
        })
      });

      const res = await gateway.startTournament("tourn-1");
      expect(res.tournament.status).toBe("running");
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:8787/api/arena/v1/tournaments/tourn-1/start",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer admin-tok",
            "Idempotency-Key": expect.any(String)
          })
        })
      );
    });
  });

  describe("Discovery Runtime Contract & Feature Verification", () => {
    describe("validateDiscoveredArenaEndpoint", () => {
      it("accepts valid single-label https *.trycloudflare.com exact /api/arena/v1", () => {
        const valid = "https://proposition-lot-love-volunteers.trycloudflare.com/api/arena/v1";
        expect(validateDiscoveredArenaEndpoint(valid)).toBe(valid);
        expect(validateDiscoveredArenaEndpoint("https://my-tunnel-123.trycloudflare.com/api/arena/v1")).toBe(
          "https://my-tunnel-123.trycloudflare.com/api/arena/v1"
        );
      });

      it("rejects non-https protocols", () => {
        expect(() => validateDiscoveredArenaEndpoint("http://my-tunnel.trycloudflare.com/api/arena/v1")).toThrow(
          ArenaApiError
        );
      });

      it("rejects URLs containing credentials", () => {
        expect(() =>
          validateDiscoveredArenaEndpoint("https://user:pass@my-tunnel.trycloudflare.com/api/arena/v1")
        ).toThrow(ArenaApiError);
      });

      it("rejects explicit ports including default 443", () => {
        expect(() =>
          validateDiscoveredArenaEndpoint("https://my-tunnel.trycloudflare.com:8443/api/arena/v1")
        ).toThrow(ArenaApiError);
        expect(() =>
          validateDiscoveredArenaEndpoint("https://my-tunnel.trycloudflare.com:443/api/arena/v1")
        ).toThrow(ArenaApiError);
      });

      it("rejects normalized dot segments in pathname", () => {
        expect(() =>
          validateDiscoveredArenaEndpoint("https://my-tunnel.trycloudflare.com/api/arena/../arena/v1")
        ).toThrow(ArenaApiError);
        expect(() =>
          validateDiscoveredArenaEndpoint("https://my-tunnel.trycloudflare.com/api/arena/./v1")
        ).toThrow(ArenaApiError);
      });

      it("rejects query parameters and fragments", () => {
        expect(() =>
          validateDiscoveredArenaEndpoint("https://my-tunnel.trycloudflare.com/api/arena/v1?token=123")
        ).toThrow(ArenaApiError);
        expect(() =>
          validateDiscoveredArenaEndpoint("https://my-tunnel.trycloudflare.com/api/arena/v1#section")
        ).toThrow(ArenaApiError);
      });

      it("rejects multi-label subdomains", () => {
        expect(() =>
          validateDiscoveredArenaEndpoint("https://nested.tunnel.trycloudflare.com/api/arena/v1")
        ).toThrow(ArenaApiError);
      });

      it("rejects base domain without subdomain", () => {
        expect(() => validateDiscoveredArenaEndpoint("https://trycloudflare.com/api/arena/v1")).toThrow(
          ArenaApiError
        );
      });

      it("rejects non-trycloudflare domains", () => {
        expect(() => validateDiscoveredArenaEndpoint("https://evil.example.com/api/arena/v1")).toThrow(
          ArenaApiError
        );
      });

      it("rejects inexact pathnames", () => {
        expect(() => validateDiscoveredArenaEndpoint("https://my-tunnel.trycloudflare.com/api/arena/v2")).toThrow(
          ArenaApiError
        );
        expect(() => validateDiscoveredArenaEndpoint("https://my-tunnel.trycloudflare.com/")).toThrow(
          ArenaApiError
        );
        expect(() => validateDiscoveredArenaEndpoint("https://my-tunnel.trycloudflare.com/api/arena/v1/extra")).toThrow(
          ArenaApiError
        );
      });

      it("rejects non-string or empty inputs", () => {
        expect(() => validateDiscoveredArenaEndpoint(null)).toThrow(ArenaApiError);
        expect(() => validateDiscoveredArenaEndpoint("")).toThrow(ArenaApiError);
        expect(() => validateDiscoveredArenaEndpoint(12345)).toThrow(ArenaApiError);
      });
    });

    describe("Gateway Discovery Resolution", () => {
      const discoveryEndpoint = "https://discovery.worker.example/api/arena/endpoint";
      const validTunnelUrl = "https://my-tunnel-123.trycloudflare.com/api/arena/v1";

      it("successfully discovers endpoint and executes request with cache no-store", async () => {
        const discoveryGateway = new ArenaApiGateway({ discoveryEndpoint, baseUrl: "http://127.0.0.1:3001/api/arena/v1" });

        // First fetch: discovery call
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ arenaApiEndpoint: validTunnelUrl, updatedAt: "2026-10-16T00:00:00Z" }),
        });

        // Second fetch: actual capabilities API call against discovered URL
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            executor: "trusted-local-v1",
            trusted: true,
            untrusted: false,
            canSubmitSource: false,
            profiles: ["node", "python"],
          }),
        });

        const caps = await discoveryGateway.getCapabilities();
        expect(caps.executor).toBe("trusted-local-v1");

        // Verify discovery call contract: GET, cache no-store, bounded signal
        expect(fetchMock).toHaveBeenNthCalledWith(
          1,
          discoveryEndpoint,
          expect.objectContaining({
            method: "GET",
            cache: "no-store",
            redirect: "error",
            headers: expect.objectContaining({
              "Accept": "application/json",

            }),
          })
        );

        // Verify API request was routed to discovered endpoint, NOT baseUrl
        expect(fetchMock).toHaveBeenNthCalledWith(
          2,
          `${validTunnelUrl}/capabilities`,
          expect.objectContaining({
            method: "GET",
            redirect: "error",
          })
        );
      });

      it("fails clearly when discovery returns null and does NOT silently fall back to baked baseUrl", async () => {
        const discoveryGateway = new ArenaApiGateway({
          discoveryEndpoint,
          baseUrl: "http://127.0.0.1:3001/api/arena/v1", // Baked API
        });

        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ arenaApiEndpoint: null, updatedAt: null }),
        });

        try {
          await discoveryGateway.getCapabilities();
          expect.unreachable("Should have thrown");
        } catch (err: any) {
          expect(err).toBeInstanceOf(ArenaApiError);
          expect(err.code).toBe("arena_endpoint_unavailable");
          expect(err.statusCode).toBe(503);
        }

        // Must NOT call baked baseUrl
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith(discoveryEndpoint, expect.anything());
      });

      it("fails clearly when discovery endpoint returns HTTP error", async () => {
        const discoveryGateway = new ArenaApiGateway({ discoveryEndpoint });

        fetchMock.mockResolvedValueOnce({
          ok: false,
          status: 503,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ error: "Service unavailable" }),
        });

        await expect(discoveryGateway.getCapabilities()).rejects.toMatchObject({
          code: "discovery_failed",
          statusCode: 503,
        });
      });

      it("fails clearly on discovery network error", async () => {
        const discoveryGateway = new ArenaApiGateway({ discoveryEndpoint });

        fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch discovery"));

        await expect(discoveryGateway.getCapabilities()).rejects.toMatchObject({
          code: "discovery_network_error",
          statusCode: 503,
        });
      });

      it("fails clearly when discovery returns invalid endpoint shape", async () => {
        const discoveryGateway = new ArenaApiGateway({ discoveryEndpoint });

        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ arenaApiEndpoint: "http://insecure-tunnel.trycloudflare.com/api/arena/v1" }),
        });

        await expect(discoveryGateway.getCapabilities()).rejects.toMatchObject({
          code: "invalid_discovery_endpoint",
          statusCode: 502,
        });
      });

      it("re-resolves on subsequent requests without stale cache and adapts to endpoint change", async () => {
        const discoveryGateway = new ArenaApiGateway({ discoveryEndpoint });
        discoveryGateway.setToken("session-bearer-secret-token");

        const tunnelUrl1 = "https://tunnel-instance-1.trycloudflare.com/api/arena/v1";
        const tunnelUrl2 = "https://tunnel-instance-2.trycloudflare.com/api/arena/v1";

        // Request 1: resolves tunnel 1
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ arenaApiEndpoint: tunnelUrl1 }),
        });
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ bots: [], total: 0 }),
        });

        await discoveryGateway.listBots();
        expect(fetchMock).toHaveBeenNthCalledWith(
          2,
          `${tunnelUrl1}/bots`,
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: "Bearer session-bearer-secret-token",
            }),
          })
        );

        // Endpoint change: tunnel restarted, discovery now returns tunnel 2
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ arenaApiEndpoint: tunnelUrl2 }),
        });
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ bots: [], total: 0 }),
        });

        await discoveryGateway.listBots();

        // Must preserve session bearer token across URL change without clearing it
        expect(discoveryGateway.getToken()).toBe("session-bearer-secret-token");
        expect(fetchMock).toHaveBeenNthCalledWith(
          4,
          `${tunnelUrl2}/bots`,
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: "Bearer session-bearer-secret-token",
            }),
          })
        );
      });

      it("maintains normal static compatibility when discoveryEndpoint is not set", async () => {
        const staticGateway = new ArenaApiGateway({ baseUrl: "http://127.0.0.1:3001/api/arena/v1" });

        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            executor: "trusted-local-v1",
            trusted: true,
            untrusted: false,
            canSubmitSource: false,
            profiles: ["node"],
          }),
        });

        const caps = await staticGateway.getCapabilities();
        expect(caps.executor).toBe("trusted-local-v1");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith(
          "http://127.0.0.1:3001/api/arena/v1/capabilities",
          expect.anything()
        );
      });

      it("allows updating discovery endpoint dynamically", () => {
        const dynamicGateway = new ArenaApiGateway();
        expect(dynamicGateway.getDiscoveryEndpoint()).toBeNull();

        dynamicGateway.setDiscoveryEndpoint("https://new-discovery.example/endpoint");
        expect(dynamicGateway.getDiscoveryEndpoint()).toBe("https://new-discovery.example/endpoint");

        dynamicGateway.setDiscoveryEndpoint(null);
        expect(dynamicGateway.getDiscoveryEndpoint()).toBeNull();
      });
    });
  });
});
