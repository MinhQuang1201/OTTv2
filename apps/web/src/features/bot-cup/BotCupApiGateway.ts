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

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
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
