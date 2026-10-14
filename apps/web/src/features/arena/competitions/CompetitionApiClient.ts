import type {
  Competition,
  CompetitionDetailResponse,
  CompetitionEntry,
  CompetitionListResponse,
  CompetitionPhase,
  CreateCompetitionRequest,
  RetryMatchResponse,
} from "./types";

export interface GatewayTokenProvider {
  getBaseUrl(): string;
  getToken(): string | null;
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly idempotencyKey?: string;
}

export class CompetitionApiError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly requestId?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    options: {
      code: string;
      statusCode: number;
      requestId?: string;
      details?: Record<string, unknown>;
    }
  ) {
    super(message);
    this.name = "CompetitionApiError";
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.requestId = options.requestId;
    this.details = options.details;
  }
}

export class CompetitionApiClient {
  constructor(private readonly gateway: GatewayTokenProvider) {}

  private async request<T>(
    endpoint: string,
    method: "GET" | "POST",
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<T> {
    const baseUrl = this.gateway.getBaseUrl();
    const cleanEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    const url = `${baseUrl}${cleanEndpoint}`;
    const headers: Record<string, string> = {};

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const token = this.gateway.getToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
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
        throw new CompetitionApiError(error?.message || "Yêu cầu đã bị hủy.", {
          code: "abort_error",
          statusCode: 0,
        });
      }
      throw new CompetitionApiError(error?.message || "Không thể kết nối đến máy chủ Arena.", {
        code: "network_error",
        statusCode: 0,
      });
    }

    if (!response.ok) {
      let errorBody: any = null;
      try {
        errorBody = await response.json();
      } catch {
        // Non-JSON response
      }

      const backendError = errorBody?.error;
      const code =
        backendError?.code ||
        (response.status === 401
          ? "auth_failed"
          : response.status === 403
          ? "forbidden"
          : response.status === 404
          ? "not_found"
          : response.status === 409
          ? "conflict"
          : response.status === 422
          ? "unprocessable_entity"
          : "api_error");
      const message = backendError?.message || `Máy chủ phản hồi với mã lỗi HTTP ${response.status}`;
      const requestId = backendError?.requestId || response.headers.get("x-request-id") || undefined;
      const details = backendError?.details || undefined;

      throw new CompetitionApiError(message, {
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
    } catch {
      throw new CompetitionApiError("Không thể phân giải phản hồi từ máy chủ.", {
        code: "invalid_response",
        statusCode: response.status,
      });
    }
  }

  async listCompetitions(options?: RequestOptions): Promise<readonly Competition[]> {
    const res = await this.request<CompetitionListResponse>("/competitions", "GET", undefined, options);
    return res.competitions || [];
  }

  async createCompetition(data: CreateCompetitionRequest, options?: RequestOptions): Promise<Competition> {
    const res = await this.request<{ competition: Competition }>("/competitions", "POST", data, {
      ...options,
      idempotencyKey: options?.idempotencyKey ?? crypto.randomUUID(),
    });
    return res.competition;
  }

  async getCompetition(id: string, options?: RequestOptions): Promise<CompetitionDetailResponse> {
    return this.request<CompetitionDetailResponse>(
      `/competitions/${encodeURIComponent(id)}`,
      "GET",
      undefined,
      options
    );
  }

  async registerForCompetition(id: string, options?: RequestOptions): Promise<CompetitionEntry> {
    const res = await this.request<{ entry: CompetitionEntry }>(
      `/competitions/${encodeURIComponent(id)}/register`,
      "POST",
      {},
      options
    );
    return res.entry;
  }

  async reviewEntry(
    competitionId: string,
    userId: string,
    accepted: boolean,
    options?: RequestOptions
  ): Promise<CompetitionEntry> {
    const res = await this.request<{ entry: CompetitionEntry }>(
      `/competitions/${encodeURIComponent(competitionId)}/entries/${encodeURIComponent(userId)}/review`,
      "POST",
      { accepted },
      options
    );
    return res.entry;
  }

  async submitBotVersion(
    competitionId: string,
    botVersionId: string,
    options?: RequestOptions
  ): Promise<CompetitionEntry> {
    const res = await this.request<{ entry: CompetitionEntry }>(
      `/competitions/${encodeURIComponent(competitionId)}/submission`,
      "POST",
      { botVersionId },
      options
    );
    return res.entry;
  }

  async advancePhase(
    competitionId: string,
    expectedPhase: CompetitionPhase,
    options?: RequestOptions
  ): Promise<Competition> {
    const res = await this.request<{ competition: Competition }>(
      `/competitions/${encodeURIComponent(competitionId)}/advance`,
      "POST",
      { expectedPhase },
      options
    );
    return res.competition;
  }

  async retryMatch(
    competitionId: string,
    scheduleIndex: number,
    options?: RequestOptions
  ): Promise<RetryMatchResponse> {
    return this.request<RetryMatchResponse>(
      `/competitions/${encodeURIComponent(competitionId)}/matches/${encodeURIComponent(scheduleIndex)}/retry`,
      "POST",
      {},
      options
    );
  }
}

