/**
 * Client for the Bot Cup registration API (apps/bot-cup-api), reached same-origin at /api/t through the Vercel
 * rewrite (and the Vite dev proxy). The session lives in an HttpOnly cookie, so this client holds no token.
 */

export type TeamKind = "solo" | "group";
export type TeamStatus = "pending_captain" | "pending_members" | "active";
export type MemberStatus = "pending" | "confirmed";

export interface BotCupEvent {
  readonly id: string;
  readonly name: string;
  readonly mode: "demo" | "production";
  readonly phase: string;
  readonly registrationOpen: boolean;
  readonly registrationOpensAt: number;
  readonly registrationClosesAt: number;
  readonly practiceOpensAt: number | null;
  readonly codeFreezeAt: number | null;
  readonly finalsAt: number | null;
  readonly eligibility: {
    readonly mssvDigits: number;
    readonly mssvPrefix: string | null;
    readonly emailDomain: string;
    readonly allowExternalEmail: boolean;
  };
  readonly turnstileSiteKey: string | null;
  readonly serverTime: number;
}

export interface TeamMember {
  readonly mssv: string;
  readonly fullName: string;
  readonly email: string;
  readonly role: "captain" | "member";
  readonly status: MemberStatus;
  readonly showName: boolean;
}

export interface TeamView {
  readonly handle: string;
  readonly displayName: string;
  readonly kind: TeamKind;
  readonly status: TeamStatus;
  readonly createdAt: number;
  readonly activeAt: number | null;
  readonly disqualified?: boolean;
  readonly dqReason?: string | null;
  readonly members: readonly TeamMember[];
}

export interface RegisterInput {
  readonly kind: TeamKind;
  readonly handle: string;
  readonly displayName: string;
  readonly password: string;
  readonly consent: boolean;
  readonly showName: boolean;
  readonly turnstileToken: string;
  readonly captain: { readonly fullName: string; readonly mssv: string; readonly email?: string };
}

export interface InvitePreview {
  readonly eventName: string;
  readonly teamName: string;
  readonly fullName: string;
  readonly email: string;
  readonly registrationOpen: boolean;
}

export type SubmissionStatus = "checking" | "ready" | "build_failed" | "smoke_failed";

export interface Submission {
  readonly id: string;
  readonly version: number;
  readonly language: "python" | "node";
  readonly filename: string;
  readonly size: number;
  readonly sha256: string;
  readonly origin: "upload" | "github";
  readonly status: SubmissionStatus;
  readonly createdAt: number;
}

export interface SubmissionsView {
  readonly submissions: readonly Submission[];
  readonly finalSubmissionId: string | null;
  readonly finalChosen: boolean;
  readonly window: {
    readonly open: boolean;
    readonly reason: string | null;
    readonly practiceOpensAt: number | null;
    readonly codeFreezeAt: number | null;
    readonly finalLocked: boolean;
  };
  readonly quota: { readonly perDay: number; readonly usedToday: number; readonly resetsAt: number; readonly maxVersions: number; readonly total: number };
  readonly maxBytes: number;
}

export interface SmokeGame {
  readonly id: string;
  readonly mapId: string;
  readonly seat: "A" | "B";
  readonly opponent: string | null;
  readonly status: MatchStatus;
  readonly outcome: MatchOutcome | null;
  readonly winner: "A" | "B" | null;
  readonly reason: string | null;
  readonly plies: number | null;
  readonly stderr: string | null;
}

export interface SubmissionDetail extends Submission {
  readonly checkLog: string | null;
  readonly smoke: readonly SmokeGame[];
}

export type MatchStatus = "queued" | "running" | "finished" | "failed" | "cancelled";
export type MatchOutcome = "win" | "draw" | "forfeit";
export type MatchStage = "smoke" | "practice" | "gate" | "round_robin" | "swiss" | "knockout";

export interface MatchSeat {
  readonly kind: "team" | "house";
  readonly name: string;
  readonly version?: number;
  readonly house?: string;
}

export interface MatchView {
  readonly id: string;
  readonly stage: MatchStage;
  readonly round: number | null;
  readonly gameIndex: number;
  readonly mapId: string;
  readonly status: MatchStatus;
  readonly seats: { readonly A: MatchSeat; readonly B: MatchSeat };
  readonly mySeat: "A" | "B" | null;
  readonly outcome: MatchOutcome | null;
  readonly winner: "A" | "B" | null;
  readonly reason: string | null;
  readonly plies: number | null;
  readonly createdAt: number;
  readonly finishedAt: number | null;
}

export interface MyMatches {
  readonly matches: readonly MatchView[];
  readonly practice: {
    readonly gamesPerDay: number;
    readonly usedToday: number;
    readonly opponents: ReadonlyArray<{ readonly id: string; readonly name: string }>;
    readonly maps: readonly string[];
  };
}

export interface LeaderboardRow {
  readonly rank: number;
  readonly displayName: string;
  readonly games: number;
  readonly points: number;
  readonly opponents: Readonly<Record<string, { readonly played: number; readonly points: number }>>;
}

export interface Leaderboard {
  readonly opponents: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly rows: readonly LeaderboardRow[];
  readonly updatedAt: number;
}

export interface Announcement {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly publishedAt: number;
}

export class BotCupApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly field?: string,
    readonly retryAfterMs?: number,
  ) {
    super(code);
    this.name = "BotCupApiError";
  }
}

export const DEFAULT_BOT_CUP_API_BASE = "/api/t";

export class BotCupApiGateway {
  private readonly baseUrl: string;

  constructor({ baseUrl = DEFAULT_BOT_CUP_API_BASE }: { readonly baseUrl?: string } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  getEvent(signal?: AbortSignal): Promise<BotCupEvent> {
    return this.request("GET", "/event", undefined, signal);
  }

  register(input: RegisterInput): Promise<{ readonly handle: string; readonly status: TeamStatus; readonly otpSentTo: string }> {
    return this.request("POST", "/register", input);
  }

  verifyRegistration(handle: string, otp: string): Promise<TeamView> {
    return this.request("POST", "/register/verify", { handle, otp });
  }

  resendRegistration(handle: string, turnstileToken: string): Promise<{ readonly otpSentTo: string }> {
    return this.request("POST", "/register/resend", { handle, turnstileToken });
  }

  login(handle: string, password: string, turnstileToken: string): Promise<TeamView> {
    return this.request("POST", "/login", { handle, password, turnstileToken });
  }

  logout(): Promise<{ readonly ok: true }> {
    return this.request("POST", "/logout", {});
  }

  /** The signed-in team, or null when there is no valid session. */
  async me(signal?: AbortSignal): Promise<TeamView | null> {
    try {
      return await this.request<TeamView>("GET", "/me", undefined, signal);
    } catch (error) {
      if (error instanceof BotCupApiError && error.status === 401) return null;
      throw error;
    }
  }

  addMember(member: { readonly fullName: string; readonly mssv: string; readonly email?: string }): Promise<TeamView> {
    return this.request("POST", "/team/members", member);
  }

  removeMember(mssv: string): Promise<TeamView> {
    return this.request("DELETE", `/team/members/${encodeURIComponent(mssv)}`);
  }

  resendInvite(mssv: string): Promise<{ readonly sentTo: string }> {
    return this.request("POST", `/team/members/${encodeURIComponent(mssv)}/resend`, {});
  }

  previewInvite(token: string): Promise<InvitePreview> {
    return this.request("GET", `/invites/${encodeURIComponent(token)}`);
  }

  acceptInvite(token: string, consent: boolean, showName: boolean): Promise<{ readonly teamName: string; readonly status: TeamStatus }> {
    return this.request("POST", "/invites/accept", { token, consent, showName });
  }

  requestPasswordReset(handle: string, turnstileToken: string, mssv?: string): Promise<{ readonly otpSentTo: string }> {
    return this.request("POST", "/password/reset/request", { handle, turnstileToken, ...(mssv ? { mssv } : {}) });
  }

  confirmPasswordReset(handle: string, otp: string, newPassword: string): Promise<{ readonly ok: true }> {
    return this.request("POST", "/password/reset/confirm", { handle, otp, newPassword });
  }

  changePassword(currentPassword: string, newPassword: string): Promise<{ readonly ok: true }> {
    return this.request("POST", "/password/change", { currentPassword, newPassword });
  }

  revokeAllSessions(): Promise<{ readonly ok: true }> {
    return this.request("POST", "/sessions/revoke-all", {});
  }

  listSubmissions(signal?: AbortSignal): Promise<SubmissionsView> {
    return this.request("GET", "/submissions", undefined, signal);
  }

  uploadSubmission(file: File): Promise<{ readonly submission: Submission }> {
    const form = new FormData();
    form.append("file", file, file.name);
    return this.request("POST", "/submissions", form);
  }

  /** `null` goes back to "the newest eligible version". */
  chooseFinalSubmission(submissionId: string | null): Promise<SubmissionsView> {
    return this.request("PUT", "/team/final-submission", { submissionId });
  }

  getSubmission(submissionId: string): Promise<{ readonly submission: SubmissionDetail }> {
    return this.request("GET", `/submissions/${encodeURIComponent(submissionId)}`);
  }

  requestPractice(opponent: string, mapId: string): Promise<{ readonly matches: readonly MatchView[] }> {
    return this.request("POST", "/practice", { opponent, mapId });
  }

  listMatches(signal?: AbortSignal): Promise<MyMatches> {
    return this.request("GET", "/matches", undefined, signal);
  }

  getMatch(matchId: string): Promise<{ readonly match: MatchView & { readonly stderr: Readonly<Record<string, string>> } }> {
    return this.request("GET", `/matches/${encodeURIComponent(matchId)}`);
  }

  /** The game as an Arena replay document, for the replay viewer. */
  getMatchReplay(matchId: string): Promise<{ readonly replay: unknown; readonly sha256: string }> {
    return this.request("GET", `/matches/${encodeURIComponent(matchId)}/replay`);
  }

  getLeaderboard(signal?: AbortSignal): Promise<Leaderboard> {
    return this.request("GET", "/leaderboard", undefined, signal);
  }

  getAnnouncements(signal?: AbortSignal): Promise<{ readonly announcements: readonly Announcement[] }> {
    return this.request("GET", "/announcements", undefined, signal);
  }

  /** Same-origin link that downloads the team's own source of one version. */
  submissionSourceUrl(submissionId: string): string {
    return `${this.baseUrl}/submissions/${encodeURIComponent(submissionId)}/source`;
  }

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    const multipart = typeof FormData !== "undefined" && body instanceof FormData;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        credentials: "same-origin",
        // The browser sets the multipart boundary itself.
        headers: body === undefined || multipart ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : multipart ? (body as FormData) : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") throw error;
      throw new BotCupApiError(0, "network_error");
    }
    let payload: Record<string, unknown> = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const code = typeof payload.error === "string" ? payload.error : "internal_error";
      const field = typeof payload.field === "string" ? payload.field : undefined;
      const retryAfterMs = typeof payload.retryAfterMs === "number" ? payload.retryAfterMs : undefined;
      throw new BotCupApiError(response.status, code, field, retryAfterMs);
    }
    return payload as T;
  }
}
