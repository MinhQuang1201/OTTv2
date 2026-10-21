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

export interface ArenaRegistrationResult {
  readonly user: ArenaUser;
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
  readonly publicRegistration?: boolean;
  readonly localDemoContainers?: boolean;
  readonly localDocker?: { readonly available: boolean; readonly reason?: string } | null;
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

export interface ArenaReadyBotVersion {
  readonly id: string;
  readonly botId: string;
  readonly versionNo: number;
  readonly profileId: string;
  readonly buildStatus: "ready";
  readonly createdAt: string;
}

export interface ArenaReadyBotVersionListResponse {
  readonly versions: readonly ArenaReadyBotVersion[];
}

export interface ArenaBotVersionUploadResult {
  readonly version: ArenaBotVersion;
  readonly job?: {
    readonly id: string;
    readonly kind: string;
    readonly status: string;
  } | null;
}

export type DraftIsolationMode = "container" | "trusted-process";

export interface DraftCompileResult {
  readonly status: "ok" | "failed";
  readonly logs: string;
}

export interface DraftExecutionResult {
  readonly legal?: boolean;
  readonly move?: {
    readonly from: { readonly x: number; readonly y: number };
    readonly to: { readonly x: number; readonly y: number };
  };
  readonly comment?: string | null;
  readonly elapsedMs?: number;
  readonly error?: string;
}

export interface DraftRunResult {
  readonly status: "success" | "compile_error" | "execution_error" | "unavailable";
  readonly isolation?: DraftIsolationMode;
  readonly error?: string;
  readonly details?: Record<string, unknown>;
  readonly compile?: DraftCompileResult;
  readonly execution?: DraftExecutionResult;
  readonly nextState?: object;
}

export interface LiveFrameRecord {
  readonly ply: number;
  readonly seat?: Seat | "A" | "B" | null;
  readonly move?: {
    readonly from: { readonly x: number; readonly y: number };
    readonly to: { readonly x: number; readonly y: number };
  } | null;
  readonly capturedPieceId?: string | null;
  readonly capturedPieceType?: string | null;
  readonly elapsedMs?: number;
  readonly remainingMs?: number;
  readonly comment?: string | null;
  readonly clock?: {
    readonly remainingMs?: { readonly A?: number; readonly B?: number };
    readonly runningSeat?: Seat | "A" | "B" | null;
    readonly [key: string]: unknown;
  } | object;
  readonly state?: {
    readonly turn?: string | null;
    readonly winner?: string | null;
    readonly reason?: string | null;
    readonly pieces?: readonly any[];
    readonly clock?: any;
    readonly [key: string]: unknown;
  } | object;
  readonly [key: string]: unknown;
}

export interface LiveFramesQueryResult {
  readonly matchId: string;
  readonly status: string;
  readonly terminal: boolean;
  readonly replayUrl?: string | null;
  readonly attemptNo: number;
  readonly currentPly: number;
  readonly reset: boolean;
  readonly frames: readonly LiveFrameRecord[];
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

export interface ArenaCreatePracticeMatchResponse {
  readonly match: {
    readonly id: string;
    readonly kind: "practice" | "ranked";
    readonly ladderId: string;
    readonly status: ArenaMatchStatus;
    readonly participants: {
      readonly A: ArenaMatchParticipant;
      readonly B: ArenaMatchParticipant;
    } | readonly ArenaMatchParticipant[];
  };
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

export interface ArenaStartTournamentResponse {
  readonly tournament: {
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly totalMatches?: number;
  };
}

export interface ArenaListTournamentsResponse {
  readonly tournaments: readonly ArenaTournamentSummary[];
  readonly total: number;
  readonly limit?: number;
  readonly offset?: number;
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
  readonly discoveryEndpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly discoveryTimeoutMs?: number;
}

export const DEFAULT_DISCOVERY_TIMEOUT_MS = 5000;

export interface ArenaDiscoveryResult {
  readonly arenaApiEndpoint: string | null;
  readonly updatedAt?: string | null;
}

const DISCOVERED_ENDPOINT_RAW_REGEX =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com\/api\/arena\/v1$/i;

export function validateDiscoveredArenaEndpoint(endpoint: unknown): string {
  if (typeof endpoint !== "string") {
    throw new ArenaApiError("Discovered Arena endpoint must be a string", {
      code: "invalid_discovery_endpoint",
      statusCode: 502,
    });
  }
  const trimmed = endpoint.trim();
  if (!trimmed) {
    throw new ArenaApiError("Discovered Arena endpoint is empty", {
      code: "invalid_discovery_endpoint",
      statusCode: 502,
    });
  }
  if (!DISCOVERED_ENDPOINT_RAW_REGEX.test(trimmed)) {
    throw new ArenaApiError("Discovered Arena endpoint format is invalid", {
      code: "invalid_discovery_endpoint",
      statusCode: 502,
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ArenaApiError("Discovered Arena endpoint is not a valid URL", {
      code: "invalid_discovery_endpoint",
      statusCode: 502,
    });
  }

  if (parsed.protocol !== "https:") {
    throw new ArenaApiError("Discovered Arena endpoint must use https:", {
      code: "invalid_discovery_endpoint",
      statusCode: 502,
    });
  }

  if (parsed.username || parsed.password) {
    throw new ArenaApiError("Discovered Arena endpoint must not contain credentials", {
      code: "invalid_discovery_endpoint",
      statusCode: 502,
    });
  }

  if (parsed.port !== "") {
    throw new ArenaApiError("Discovered Arena endpoint must not contain an explicit port", {
      code: "invalid_discovery_endpoint",
      statusCode: 502,
    });
  }

  if (parsed.search !== "") {
    throw new ArenaApiError("Discovered Arena endpoint must not contain query parameters", {
      code: "invalid_discovery_endpoint",
      statusCode: 502,
    });
  }

  if (parsed.hash !== "") {
    throw new ArenaApiError("Discovered Arena endpoint must not contain a fragment", {
      code: "invalid_discovery_endpoint",
      statusCode: 502,
    });
  }

  const hostname = parsed.hostname.toLowerCase();
  const match = hostname.match(/^([a-z0-9-]+)\.trycloudflare\.com$/);
  if (!match || !match[1] || match[1].startsWith("-") || match[1].endsWith("-")) {
    throw new ArenaApiError("Discovered Arena endpoint must be a single-label *.trycloudflare.com hostname", {
      code: "invalid_discovery_endpoint",
      statusCode: 502,
    });
  }

  if (parsed.pathname !== "/api/arena/v1") {
    throw new ArenaApiError("Discovered Arena endpoint must have exact path /api/arena/v1", {
      code: "invalid_discovery_endpoint",
      statusCode: 502,
    });
  }

  return `https://${hostname}/api/arena/v1`;
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
  private discoveryEndpoint: string | null = null;
  private fetchImpl?: typeof fetch;
  private discoveryTimeoutMs: number;

  private token: string | null = null;

  constructor(options: ArenaApiGatewayOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.discoveryEndpoint =
      options.discoveryEndpoint &&
      typeof options.discoveryEndpoint === "string" &&
      options.discoveryEndpoint.trim().length > 0
        ? options.discoveryEndpoint.trim()
        : null;
    this.fetchImpl = options.fetchImpl;
    this.discoveryTimeoutMs =
      options.discoveryTimeoutMs && options.discoveryTimeoutMs > 0
        ? options.discoveryTimeoutMs
        : DEFAULT_DISCOVERY_TIMEOUT_MS;
  }

  setBaseUrl(url: string): void {
    this.baseUrl = normalizeBaseUrl(url);

  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  setDiscoveryEndpoint(url?: string | null): void {
    this.discoveryEndpoint =
      url && typeof url === "string" && url.trim().length > 0 ? url.trim() : null;

  }

  getDiscoveryEndpoint(): string | null {
    return this.discoveryEndpoint;
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

  private getFetch(): typeof fetch {
    return this.fetchImpl ?? globalThis.fetch;
  }

  async resolveEndpoint(options: RequestOptions = {}): Promise<string> {
    return this.resolveBaseUrl(options.signal);
  }

  private async discoverEndpoint(signal?: AbortSignal): Promise<string> {
    if (!this.discoveryEndpoint) {
      throw new ArenaApiError("Arena discovery endpoint is not configured", {
        code: "discovery_not_configured",
        statusCode: 0,
      });
    }

    const fetchFn = this.getFetch();
    const controller = new AbortController();
    let didTimeout = false;
    const timeoutId = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, this.discoveryTimeoutMs);

    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeoutId);
        controller.abort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    let response: Response;
    try {
      response = await fetchFn(this.discoveryEndpoint, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
    } catch (err: unknown) {
      const error = err as Error;
      if (signal?.aborted) {
        throw new ArenaApiError(error?.message || "Yêu cầu đã bị hủy.", {
          code: "abort_error",
          statusCode: 0,
        });
      }
      if (didTimeout) {
        throw new ArenaApiError("Quá thời gian kết nối đến dịch vụ discovery Arena.", {
          code: "discovery_timeout",
          statusCode: 504,
        });
      }
      throw new ArenaApiError(error?.message || "Không thể kết nối đến dịch vụ discovery Arena.", {
        code: "discovery_network_error",
        statusCode: 503,
      });
    } finally {
      clearTimeout(timeoutId);
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    }

    if (!response.ok) {
      throw new ArenaApiError(`Dịch vụ discovery Arena trả về mã lỗi HTTP ${response.status}`, {
        code: "discovery_failed",
        statusCode: response.status >= 500 ? 503 : response.status,
      });
    }

    let payload: any;
    try {
      payload = await response.json();
    } catch {
      throw new ArenaApiError("Không thể phân giải phản hồi từ dịch vụ discovery Arena.", {
        code: "invalid_discovery_response",
        statusCode: 502,
      });
    }

    if (!payload || typeof payload !== "object") {
      throw new ArenaApiError("Phản hồi discovery không hợp lệ.", {
        code: "invalid_discovery_response",
        statusCode: 502,
      });
    }

    const candidate = payload.arenaApiEndpoint;
    if (!candidate) {
      throw new ArenaApiError("Arena hiện ngoại tuyến, không có endpoint khả dụng từ discovery.", {
        code: "arena_endpoint_unavailable",
        statusCode: 503,
      });
    }

    const validated = validateDiscoveredArenaEndpoint(candidate);
    return validated;
  }

  private async resolveBaseUrl(signal?: AbortSignal): Promise<string> {
    if (this.discoveryEndpoint) {
      const endpoint = await this.discoverEndpoint(signal);

      return endpoint;
    }

    if (!this.baseUrl) {
      throw new ArenaApiError("Arena API endpoint is not configured", {
        code: "not_configured",
        statusCode: 0,
      });
    }


    return this.baseUrl;
  }

  private assertAllowedOrigin(targetUrl: string): void {
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      throw new ArenaApiError("Target URL is not a valid URL", {
        code: "invalid_origin",
        statusCode: 0,
      });
    }

    if (this.discoveryEndpoint) {
      const hostname = parsed.hostname.toLowerCase();
      const match = hostname.match(/^([a-z0-9-]+)\.trycloudflare\.com$/);
      if (parsed.protocol !== "https:" || !match || !match[1] || match[1].startsWith("-") || match[1].endsWith("-")) {
        throw new ArenaApiError("Cannot send request to unvalidated origin in discovery mode", {
          code: "unvalidated_origin",
          statusCode: 0,
        });
      }
    } else {
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new ArenaApiError("Target origin protocol must be http or https", {
          code: "unvalidated_origin",
          statusCode: 0,
        });
      }
      if (parsed.username || parsed.password) {
        throw new ArenaApiError("Target origin must not contain credentials", {
          code: "unvalidated_origin",
          statusCode: 0,
        });
      }
    }
  }

  private async request<T>(
    endpoint: string,
    method: "GET" | "POST",
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<T> {
    const resolvedBase = await this.resolveBaseUrl(options.signal);
    this.assertAllowedOrigin(resolvedBase);

    const url = `${resolvedBase}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
    this.assertAllowedOrigin(url);
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
      const fetchFn = this.getFetch();
      response = await fetchFn(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: "error",
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

  async register(
    credentials: { username: string; password: string },
    options?: RequestOptions
  ): Promise<ArenaRegistrationResult> {
    return this.request<ArenaRegistrationResult>("/auth/register", "POST", credentials, options);
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

  async listReadyBotVersions(botId: string, options?: RequestOptions): Promise<ArenaReadyBotVersionListResponse> {
    return this.request<ArenaReadyBotVersionListResponse>(
      `/bots/${encodeURIComponent(botId)}/ready-versions`,
      "GET",
      undefined,
      options
    );
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

  async runDraft(
    botId: string,
    data: { source: string; profileId: string; mapId?: string },
    options: RequestOptions = {}
  ): Promise<DraftRunResult> {
    return this.request<DraftRunResult>(
      `/bots/${encodeURIComponent(botId)}/draft/run`,
      "POST",
      data,
      options
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

  async createPracticeMatch(
    data: {
      participants: {
        A: { botVersionId: string };
        B: { botVersionId: string };
      };
      ladderId?: string;
    },
    options: RequestOptions = {}
  ): Promise<ArenaCreatePracticeMatchResponse> {
    const idempotencyKey = options.idempotencyKey || generateIdempotencyKey();
    const payload = {
      kind: "practice",
      ladderId: data.ladderId || "ladder-main",
      participants: data.participants,
    };
    return this.request<ArenaCreatePracticeMatchResponse>("/matches", "POST", payload, {
      ...options,
      idempotencyKey,
    });
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

  async getLiveFrames(
    matchId: string,
    params: { afterPly?: number; attemptNo?: number | null; limit?: number } = {},
    options: RequestOptions = {}
  ): Promise<LiveFramesQueryResult> {
    const searchParams = new URLSearchParams();
    if (params.afterPly !== undefined) {
      searchParams.set("afterPly", String(params.afterPly));
    }
    if (params.attemptNo !== undefined && params.attemptNo !== null) {
      searchParams.set("attemptNo", String(params.attemptNo));
    }
    if (params.limit !== undefined) {
      searchParams.set("limit", String(params.limit));
    }
    const qs = searchParams.toString();
    return this.request<LiveFramesQueryResult>(
      `/matches/${encodeURIComponent(matchId)}/live${qs ? `?${qs}` : ""}`,
      "GET",
      undefined,
      options
    );
  }

  async listTournaments(options?: RequestOptions): Promise<ArenaListTournamentsResponse> {
    // Note: Tournaments endpoint list or single
    return this.request<ArenaListTournamentsResponse>("/tournaments", "GET", undefined, options);
  }

  async createTournament(
    data: {
      name: string;
      entries: ReadonlyArray<{ botVersionId: string; botId?: string }>;
      ladderId?: string;
      ranked?: boolean;
      startImmediately?: boolean;
    },
    options: RequestOptions = {}
  ): Promise<ArenaCreateTournamentResponse> {
    const idempotencyKey = options.idempotencyKey || generateIdempotencyKey();
    return this.request<ArenaCreateTournamentResponse>("/tournaments", "POST", data, {
      ...options,
      idempotencyKey,
    });
  }

  async startTournament(
    tournamentId: string,
    options: RequestOptions = {}
  ): Promise<ArenaStartTournamentResponse> {
    const idempotencyKey = options.idempotencyKey || generateIdempotencyKey();
    return this.request<ArenaStartTournamentResponse>(
      `/tournaments/${encodeURIComponent(tournamentId)}/start`,
      "POST",
      {},
      {
        ...options,
        idempotencyKey,
      }
    );
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
