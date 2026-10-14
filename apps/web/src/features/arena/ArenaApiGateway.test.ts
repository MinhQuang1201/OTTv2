import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ArenaApiGateway, ArenaApiError } from "./ArenaApiGateway";
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
  });
});
