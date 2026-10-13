import type { ArenaMatchResult, ReplayDocument, Seat } from "../../../../../packages/arena/src/contracts/index.d.mts";
import { validateReplayDocument } from "../../../../../packages/arena/src/contracts/index.mjs";

export type ArenaUserRole = "admin" | "author" | "spectator";

export type ArenaMatchStatus = "pending" | "active" | "completed" | "cancelled" | "error";
export type ArenaTournamentStatus = "pending" | "active" | "completed" | "cancelled";
export type ArenaBotStatus = "active" | "suspended" | "deleted";
export type ArenaBuildStatus = "pending" | "building" | "ready" | "failed";

export interface ArenaUser {
  readonly id: string;
  readonly username: string;
  readonly role: ArenaUserRole;
}

export interface ArenaLoginResult {
  readonly token: string;
  readonly user: ArenaUser;
  readonly expiresAt?: string;
}

export interface ArenaUserProfile {
  readonly user: ArenaUser;
  readonly canSubmitSource: boolean;
}

export interface ArenaCapabilities {
  readonly executor: string;
  readonly trusted: boolean;
  readonly untrusted: boolean;
  readonly canSubmitSource: boolean;
  readonly profiles: readonly string[];
}

export interface ArenaBot {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly status: ArenaBotStatus;
  readonly createdAt: string;
}

export interface ArenaBotListResponse {
  readonly bots: readonly ArenaBot[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface ArenaBotVersion {
  readonly id: string;
  readonly botId: string;
  readonly versionNo: number;
  readonly sourceDigest: string;
  readonly profileId: string;
  readonly profileRevision?: string;
  readonly buildStatus: ArenaBuildStatus;
  readonly artifactDigest?: string | null;
  readonly buildLog?: string | null;
  readonly createdAt: string;
}

export interface ArenaBotVersionListResponse {
  readonly versions: readonly ArenaBotVersion[];
}

export interface ArenaBotVersionUploadResult {
  readonly version: ArenaBotVersion;
  readonly job?: {
    readonly id: string;
    readonly kind: string;
    readonly status: string;
  } | null;
}

export interface ArenaMatchParticipant {
  readonly match_id?: string;
  readonly matchId?: string;
  readonly seat: Seat | "A" | "B";
  readonly bot_id?: string;
  readonly botId?: string;
  readonly bot_version_id?: string;
  readonly botVersionId?: string;
  readonly artifact_digest?: string;
  readonly artifactDigest?: string;
  readonly profile_id?: string;
  readonly profileId?: string;
  readonly profile_revision?: string;
  readonly profileRevision?: string;
}

export interface ArenaMatchSummary {
  readonly id: string;
  readonly kind: "ranked" | "practice";
  readonly ladderId?: string;
  readonly status: ArenaMatchStatus;
  readonly tournamentId?: string | null;
  readonly scheduleIndex?: number | null;
  readonly settledAt?: string | null;
  readonly settlementSeq?: number | null;
  readonly createdAt: string;
  readonly participants?: Record<string, ArenaMatchParticipant> | readonly ArenaMatchParticipant[];
  readonly result?: ArenaMatchResult | null;
}

export interface ArenaMatchDetails extends ArenaMatchSummary {
  readonly participants?: Record<string, ArenaMatchParticipant> | readonly ArenaMatchParticipant[];
  readonly result?: ArenaMatchResult | null;
}

export interface ArenaMatchListResponse {
  readonly matches: readonly ArenaMatchSummary[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface ArenaMatchReplayResponse {
  readonly matchId: string;
  readonly replayDigest: string;
  readonly completionDigest: string;
  readonly replay: ReplayDocument;
}

export interface ArenaTournamentSummary {
  readonly id: string;
  readonly name: string;
  readonly status: ArenaTournamentStatus;
  readonly pointScheme: string;
  readonly ranked: boolean;
  readonly createdAt: string;
}

export interface ArenaTournamentStanding {
  readonly botId: string;
  readonly botName?: string;
  readonly points: number;
  readonly matchesPlayed: number;
  readonly wins: number;
  readonly draws: number;
  readonly losses: number;
  readonly rank?: number;
}

export interface ArenaTournamentDetailsResponse {
  readonly tournament: ArenaTournamentSummary;
  readonly standings: readonly ArenaTournamentStanding[];
  readonly matches: ReadonlyArray<{
    readonly id: string;
    readonly scheduleIndex: number;
    readonly kind: string;
    readonly status: ArenaMatchStatus | string;
    readonly settledAt?: string | null;
  }>;
}

export interface ArenaCreateTournamentResponse {
  readonly tournament: ArenaTournamentSummary;
  readonly matchesCount: number;
}

export interface ArenaLeaderboardRating {
  readonly rank: number;
  readonly botId: string;
  readonly botName: string;
  readonly ownerId: string;
  readonly rating: number;
  readonly ratedGames: number;
  readonly wins: number;
  readonly draws: number;
  readonly losses: number;
  readonly updatedAt?: string;
}

export interface ArenaLeaderboardResponse {
  readonly ladderId: string;
  readonly total: number;
  readonly ratings: readonly ArenaLeaderboardRating[];
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly idempotencyKey?: string;
}

export class ArenaApiError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly requestId?: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: { code: string; statusCode: number; requestId?: string; details?: Record<string, unknown> }) {
    super(message);
    this.name = "ArenaApiError";
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.requestId = options.requestId;
    this.details = options.details;
  }
}

export interface ArenaApiGatewayOptions {
  readonly baseUrl?: string;
}

function normalizeBaseUrl(url?: string): string {
  if (!url || typeof url !== "string") return "";
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (trimmed.includes("/api/arena/v1")) return trimmed;
  return `${trimmed}/api/arena/v1`;
}

function generateIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class ArenaApiGateway {
  private baseUrl: string;
  private token: string | null = null;

  constructor(options: ArenaApiGatewayOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
  }

  setBaseUrl(url: string): void {
    this.baseUrl = normalizeBaseUrl(url);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  setToken(token: string | null): void {
    this.token = token && typeof token === "string" && token.trim().length > 0 ? token.trim() : null;
  }

  getToken(): string | null {
    return this.token;
  }

  isAuthenticated(): boolean {
    return this.token !== null;
  }

  private async request<T>(
    endpoint: string,
    method: "GET" | "POST",
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
    const headers: Record<string, string> = {};

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    if (options.idempotencyKey) {
      headers["Idempotency-Key"] = options.idempotencyKey;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: options.signal,
      });
    } catch (err: unknown) {
      const error = err as Error;
      if (error?.name === "AbortError" || options.signal?.aborted) {
        throw new ArenaApiError(error?.message || "Yêu cầu đã bị hủy.", {
          code: "abort_error",
          statusCode: 0,
        });
      }
      throw new ArenaApiError(error?.message || "Không thể kết nối đến máy chủ Arena.", {
        code: "network_error",
        statusCode: 0,
      });
    }

    if (!response.ok) {
      let errorBody: any = null;
      try {
        errorBody = await response.json();
      } catch {
        // Not a JSON response
      }

      const backendError = errorBody?.error;
      const code = backendError?.code || (response.status === 401 ? "auth_failed" : response.status === 403 ? "forbidden" : response.status === 404 ? "not_found" : response.status === 409 ? "conflict" : "api_error");
      const message = backendError?.message || `Máy chủ phản hồi với mã lỗi HTTP ${response.status}`;
      const requestId = backendError?.requestId || response.headers.get("x-request-id") || undefined;
      const details = backendError?.details || undefined;

      throw new ArenaApiError(message, {
        code,
        statusCode: response.status,
        requestId,
        details,
      });
    }

    if (response.status === 204) {
      return undefined as unknown as T;
    }

    try {
      return (await response.json()) as T;
    } catch (err: unknown) {
      throw new ArenaApiError("Không thể phân giải phản hồi từ máy chủ.", {
        code: "invalid_response",
        statusCode: response.status,
      });
    }
  }

  async getCapabilities(options?: RequestOptions): Promise<ArenaCapabilities> {
    return this.request<ArenaCapabilities>("/capabilities", "GET", undefined, options);
  }

  async login(credentials: { username: string; password: string }, options?: RequestOptions): Promise<ArenaLoginResult> {
    const result = await this.request<ArenaLoginResult>("/auth/login", "POST", credentials, options);
    this.setToken(result.token);
    return result;
  }

  async logout(options?: RequestOptions): Promise<void> {
    try {
      if (this.token) {
        await this.request<{ ok: boolean }>("/auth/logout", "POST", {}, options);
      }
    } finally {
      this.setToken(null);
    }
  }

  async getMe(options?: RequestOptions): Promise<ArenaUserProfile> {
    return this.request<ArenaUserProfile>("/me", "GET", undefined, options);
  }

  async listBots(options: { limit?: number; offset?: number } & RequestOptions = {}): Promise<ArenaBotListResponse> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.offset !== undefined) params.set("offset", String(options.offset));
    const qs = params.toString();
    return this.request<ArenaBotListResponse>(`/bots${qs ? `?${qs}` : ""}`, "GET", undefined, options);
  }

  async createBot(data: { name: string; id?: string }, options: RequestOptions = {}): Promise<ArenaBot> {
    const idempotencyKey = options.idempotencyKey || generateIdempotencyKey();
    const res = await this.request<{ bot: ArenaBot }>("/bots", "POST", data, {
      ...options,
      idempotencyKey,
    });
    return res.bot;
  }

  async listBotVersions(botId: string, options?: RequestOptions): Promise<ArenaBotVersionListResponse> {
    return this.request<ArenaBotVersionListResponse>(`/bots/${encodeURIComponent(botId)}/versions`, "GET", undefined, options);
  }

  async uploadBotVersion(
    botId: string,
    data: { source: string; profileId: string },
    options: RequestOptions = {}
  ): Promise<ArenaBotVersionUploadResult> {
    const idempotencyKey = options.idempotencyKey || generateIdempotencyKey();
    return this.request<ArenaBotVersionUploadResult>(
      `/bots/${encodeURIComponent(botId)}/versions`,
      "POST",
      data,
      {
        ...options,
        idempotencyKey,
      }
    );
  }

  async listMatches(
    options: {
      ladderId?: string;
      status?: string;
      kind?: string;
      tournamentId?: string;
      limit?: number;
      offset?: number;
    } & RequestOptions = {}
  ): Promise<ArenaMatchListResponse> {
    const params = new URLSearchParams();
    if (options.ladderId) params.set("ladderId", options.ladderId);
    if (options.status) params.set("status", options.status);
    if (options.kind) params.set("kind", options.kind);
    if (options.tournamentId) params.set("tournamentId", options.tournamentId);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.offset !== undefined) params.set("offset", String(options.offset));
    const qs = params.toString();
    return this.request<ArenaMatchListResponse>(`/matches${qs ? `?${qs}` : ""}`, "GET", undefined, options);
  }

  async getMatch(matchId: string, options?: RequestOptions): Promise<ArenaMatchDetails> {
    const res = await this.request<{ match: ArenaMatchDetails }>(
      `/matches/${encodeURIComponent(matchId)}`,
      "GET",
      undefined,
      options
    );
    return res.match;
  }

  async getMatchReplay(matchId: string, options?: RequestOptions): Promise<ArenaMatchReplayResponse> {
    const res = await this.request<ArenaMatchReplayResponse>(
      `/matches/${encodeURIComponent(matchId)}/replay`,
      "GET",
      undefined,
      options
    );
    const validation = validateReplayDocument(res?.replay);
    if (!validation.ok) {
      const msg = `Dữ liệu replay không hợp lệ: ${validation.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`;
      throw new ArenaApiError(msg, {
        code: "invalid_replay",
        statusCode: 200,
        details: { errors: validation.errors },
      });
    }
    return res;
  }

  async listTournaments(options?: RequestOptions): Promise<readonly ArenaTournamentSummary[]> {
    // Note: Tournaments endpoint list or single
    return [];
  }

  async createTournament(
    data: {
      name: string;
      entries: ReadonlyArray<{ botVersionId: string; botId?: string }>;
      ladderId?: string;
      ranked?: boolean;
    },
    options: RequestOptions = {}
  ): Promise<ArenaCreateTournamentResponse> {
    const idempotencyKey = options.idempotencyKey || generateIdempotencyKey();
    return this.request<ArenaCreateTournamentResponse>("/tournaments", "POST", data, {
      ...options,
      idempotencyKey,
    });
  }

  async getTournament(tournamentId: string, options?: RequestOptions): Promise<ArenaTournamentDetailsResponse> {
    return this.request<ArenaTournamentDetailsResponse>(
      `/tournaments/${encodeURIComponent(tournamentId)}`,
      "GET",
      undefined,
      options
    );
  }

  async getLeaderboard(ladderId = "ladder-main", options?: RequestOptions): Promise<ArenaLeaderboardResponse> {
    const params = new URLSearchParams({ ladderId });
    return this.request<ArenaLeaderboardResponse>(`/leaderboard?${params.toString()}`, "GET", undefined, options);
  }
}
