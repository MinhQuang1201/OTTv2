// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { CompetitionApiClient, CompetitionApiError } from "./CompetitionApiClient";
import type { Competition, CompetitionEntry } from "./types";

describe("CompetitionApiClient", () => {
  let mockGateway: { getBaseUrl: () => string; getToken: () => string | null };
  let client: CompetitionApiClient;

  beforeEach(() => {
    mockGateway = {
      getBaseUrl: () => "http://127.0.0.1:8787/api/arena/v1",
      getToken: () => "test-token-123",
    };
    client = new CompetitionApiClient(mockGateway);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists competitions with authorization header", async () => {
    const fakeList: Competition[] = [
      {
        id: "c-1",
        name: "Spring Championship",
        phase: "registration",
        capacity: 16,
        ranked: true,
        createdAt: "2026-10-15T00:00:00Z",
      },
    ];

    (fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ competitions: fakeList }),
    });

    const result = await client.listCompetitions();
    expect(result).toEqual(fakeList);

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/api/arena/v1/competitions",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token-123",
        }),
      })
    );
  });

  it("creates competition with JSON body and returns created object", async () => {
    const created: Competition = {
      id: "c-new",
      name: "New League",
      phase: "registration",
      capacity: 8,
      ranked: true,
      createdAt: "2026-10-15T00:00:00Z",
    };

    (fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ competition: created }),
    });

    const res = await client.createCompetition({ name: "New League", capacity: 8, ranked: true });
    expect(res).toEqual(created);

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/api/arena/v1/competitions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer test-token-123",
        }),
        body: JSON.stringify({ name: "New League", capacity: 8, ranked: true }),
      })
    );
  });

  it("gets competition detail with entries", async () => {
    const detail = {
      competition: {
        id: "c-1",
        name: "Cup",
        phase: "preparation" as const,
        createdAt: "2026-10-15T00:00:00Z",
      },
      entries: [
        {
          userId: "u-1",
          username: "alice",
          status: "accepted" as const,
          botId: null,
          botName: null,
          botVersionId: null,
          versionNo: null,
          buildStatus: null,
        },
      ],
    };

    (fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => detail,
    });

    const res = await client.getCompetition("c-1");
    expect(res).toEqual(detail);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/api/arena/v1/competitions/c-1",
      expect.anything()
    );
  });

  it("registers for competition", async () => {
    const entry: CompetitionEntry = {
      userId: "u-2",
      username: "bob",
      status: "pending",
      botId: null,
      botName: null,
      botVersionId: null,
      versionNo: null,
      buildStatus: null,
    };

    (fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ entry }),
    });

    const res = await client.registerForCompetition("c-1");
    expect(res).toEqual(entry);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/api/arena/v1/competitions/c-1/register",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("reviews entry with accepted boolean", async () => {
    const reviewed: CompetitionEntry = {
      userId: "u-2",
      username: "bob",
      status: "accepted",
      botId: null,
      botName: null,
      botVersionId: null,
      versionNo: null,
      buildStatus: null,
    };

    (fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ entry: reviewed }),
    });

    const res = await client.reviewEntry("c-1", "u-2", true);
    expect(res).toEqual(reviewed);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/api/arena/v1/competitions/c-1/entries/u-2/review",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ accepted: true }),
      })
    );
  });

  it("submits bot version", async () => {
    const submitted: CompetitionEntry = {
      userId: "u-2",
      username: "bob",
      status: "accepted",
      botId: "bot-b",
      botName: "BobBot",
      botVersionId: "v-ready-1",
      versionNo: 2,
      buildStatus: "ready",
    };

    (fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ entry: submitted }),
    });

    const res = await client.submitBotVersion("c-1", "v-ready-1");
    expect(res).toEqual(submitted);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/api/arena/v1/competitions/c-1/submission",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ botVersionId: "v-ready-1" }),
      })
    );
  });

  it("advances phase with expectedPhase", async () => {
    const advanced: Competition = {
      id: "c-1",
      name: "Cup",
      phase: "preparation",
      createdAt: "2026-10-15T00:00:00Z",
    };

    (fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ competition: advanced }),
    });

    const res = await client.advancePhase("c-1", "preparation");
    expect(res).toEqual(advanced);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/api/arena/v1/competitions/c-1/advance",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ expectedPhase: "preparation" }),
      })
    );
  });

  it("parses and throws CompetitionApiError on backend error response", async () => {
    (fetch as any).mockResolvedValue({
      ok: false,
      status: 409,
      headers: { get: () => "req-999" },
      json: async () => ({
        error: {
          code: "phase_mismatch",
          message: "Cannot advance phase until all accepted entries submit a READY bot version",
          requestId: "req-999",
        },
      }),
    });

    await expect(client.advancePhase("c-1", "locked")).rejects.toThrow(CompetitionApiError);
    await expect(client.advancePhase("c-1", "locked")).rejects.toMatchObject({
      code: "phase_mismatch",
      statusCode: 409,
      requestId: "req-999",
    });
  });

  it("retries errored match on running competition with correct URL and empty body", async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    const res = await client.retryMatch("c-running-1", 3);
    expect(res).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/api/arena/v1/competitions/c-running-1/matches/3/retry",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token-123",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({}),
      })
    );
  });

  it("gets catalog from remote endpoint successfully", async () => {
    const fakeCatalog = {
      maps: [{ id: "classic", revision: 1, name: "Classic", description: "Default map" }],
      formats: [{ id: "double-round-robin", name: "Double Round-Robin", description: "DRR" }],
      modes: [{ id: "ranked", name: "Ranked" }],
      defaults: { mapId: "classic", formatId: "double-round-robin", mode: "ranked" },
    };

    (fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => fakeCatalog,
    });

    const res = await client.getCatalog();
    expect(res).toEqual(fakeCatalog);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/api/arena/v1/competition-catalog",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("throws CompetitionApiError when remote catalog endpoint fails without static fallback", async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: { code: "not_found", message: "Catalog not found" } }),
    });

    await expect(client.getCatalog()).rejects.toThrow(CompetitionApiError);
  });

  it("creates extended competition with formatId, mapId, roundCount, and mode", async () => {
    const createdWithConfig: Competition = {
      id: "c-ext-1",
      name: "Swiss Championship",
      phase: "registration",
      capacity: 32,
      ranked: true,
      createdAt: "2026-10-15T00:00:00Z",
      configuration: {
        formatId: "swiss",
        mapId: "flanks",
        mapRevision: 1,
        mode: "ranked",
        roundCount: 5,
      },
    };

    (fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ competition: createdWithConfig }),
    });

    const payload = {
      name: "Swiss Championship",
      capacity: 32,
      ranked: true,
      formatId: "swiss",
      mapId: "flanks",
      roundCount: 5,
      mode: "ranked" as const,
    };

    const res = await client.createCompetition(payload);
    expect(res).toEqual(createdWithConfig);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/api/arena/v1/competitions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(payload),
      })
    );
  });

  it("advances next round passing expectedRound in body", async () => {
    const updatedComp: Competition = {
      id: "c-running-1",
      name: "Ongoing Event",
      phase: "running",
      createdAt: "2026-10-15T00:00:00Z",
      configuration: {
        formatId: "swiss",
        mapId: "classic",
        mode: "ranked",
        currentRound: 2,
        roundCount: 5,
      },
    };

    (fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ competition: updatedComp }),
    });

    const res = await client.nextRound("c-running-1", 2);
    expect(res.competition.configuration?.currentRound).toBe(2);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/api/arena/v1/competitions/c-running-1/next-round",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ expectedRound: 2 }),
      })
    );
  });

  it("maps abort error correctly", async () => {
    const abortErr = new Error("Abort");
    abortErr.name = "AbortError";
    (fetch as any).mockRejectedValueOnce(abortErr);

    await expect(client.listCompetitions()).rejects.toMatchObject({
      code: "abort_error",
      statusCode: 0,
    });
  });

  it("generates fallback idempotency key when crypto.randomUUID is unavailable", async () => {
    const originalCrypto = globalThis.crypto;
    // Simulate non-secure context where crypto.randomUUID is undefined
    const cryptoWithoutUUID = { ...originalCrypto, randomUUID: undefined };
    Object.defineProperty(globalThis, "crypto", {
      value: cryptoWithoutUUID,
      configurable: true,
      writable: true,
    });

    try {
      (fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          competition: { id: "c-fallback", name: "Fallback Test", phase: "registration", createdAt: "2026-10-15T00:00:00Z" },
        }),
      });

      const comp = await client.createCompetition({ name: "Fallback Test" });
      expect(comp.id).toBe("c-fallback");
      const lastCall = (fetch as any).mock.calls[(fetch as any).mock.calls.length - 1];
      const sentHeaders = lastCall[1].headers;
      const sentKey = sentHeaders["Idempotency-Key"];
      expect(sentKey).toBeDefined();
      expect(sentKey).toMatch(/^idem-\d+-[a-z0-9]+$/);
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        value: originalCrypto,
        configurable: true,
        writable: true,
      });
    }
  });

  it("keeps identity data private and does not leak bearer token into Error serialization", () => {
    const error = new CompetitionApiError("Unauthorized test", {
      code: "UNAUTHORIZED",
      statusCode: 401,
      sessionGeneration: 3,
      token: "secret-bearer-token-12345",
    });

    expect(error.sessionGeneration).toBe(3);
    // Token is non-enumerable and never serialized
    expect(Object.keys(error)).not.toContain("token");
    expect(JSON.stringify(error)).not.toContain("secret-bearer-token-12345");
  });
});
