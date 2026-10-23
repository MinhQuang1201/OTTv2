import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotCupApiError, BotCupApiGateway } from "./BotCupApiGateway";
import { BOT_CUP_ERROR_MESSAGES, botCupErrorMessage, errorField } from "./botCupMessages";
import { bannerLine } from "./botCupFormat";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("BotCupApiGateway", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("calls the same-origin API with the session cookie and JSON bodies", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { handle: "alpha", status: "pending_captain", otpSentTo: "26****01@vnu.edu.vn" }));
    const gateway = new BotCupApiGateway();
    const input = { kind: "solo" as const, handle: "alpha", displayName: "Alpha", password: "long-password-1", consent: true, showName: true, turnstileToken: "t", captain: { fullName: "A B", mssv: "26020101" } };
    await expect(gateway.register(input)).resolves.toEqual({ handle: "alpha", status: "pending_captain", otpSentTo: "26****01@vnu.edu.vn" });
    expect(fetchMock).toHaveBeenCalledWith("/api/t/register", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }));
  });

  it("encodes path parameters", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await new BotCupApiGateway({ baseUrl: "https://x.test/api/t/" }).removeMember("26/02");
    expect(fetchMock.mock.calls[0][0]).toBe("https://x.test/api/t/team/members/26%2F02");
  });

  it("turns API errors into BotCupApiError with code, field and retry time", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: "mssv_invalid", field: "captain.mssv" }));
    const error = await new BotCupApiGateway().register({} as never).catch((cause) => cause);
    expect(error).toBeInstanceOf(BotCupApiError);
    expect(error).toMatchObject({ status: 400, code: "mssv_invalid", field: "captain.mssv" });
    expect(errorField(error)).toBe("mssv");

    fetchMock.mockResolvedValueOnce(jsonResponse(423, { error: "login_locked", retryAfterMs: 125_000 }));
    const locked = await new BotCupApiGateway().login("a", "b", "c").catch((cause) => cause);
    expect(botCupErrorMessage(locked)).toBe("Đăng nhập sai quá nhiều lần. Thử lại sau 3 phút.");
  });

  it("reports network failures and non-JSON errors without raw text", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const offline = await new BotCupApiGateway().getEvent().catch((cause) => cause);
    expect(offline).toMatchObject({ status: 0, code: "network_error" });

    fetchMock.mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 502 }));
    const gatewayError = await new BotCupApiGateway().getEvent().catch((cause) => cause);
    expect(gatewayError).toMatchObject({ status: 502, code: "internal_error" });
    expect(botCupErrorMessage(gatewayError)).toBe(BOT_CUP_ERROR_MESSAGES.internal_error);
  });

  it("treats 401 on /me as signed out", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "unauthorized" }));
    await expect(new BotCupApiGateway().me()).resolves.toBeNull();
  });
});

describe("Bot Cup messages", () => {
  // Reads the API sources so a new error code cannot ship without a message.
  it("has a Vietnamese message for every error code the API can return", () => {
    const sources = Object.values(import.meta.glob<string>("../../../../bot-cup-api/src/*.mjs", { query: "?raw", import: "default", eager: true })).join("\n");
    const core = Object.values(import.meta.glob<string>("../../../../../packages/bot-cup-core/src/*.mjs", { query: "?raw", import: "default", eager: true })).join("\n");
    expect(sources).toContain("createBotCupApi");
    expect(core).toContain("checkStudent");
    const codes = new Set<string>();
    for (const match of sources.matchAll(/HttpError\(\d+,\s*"([a-z_]+)"/g)) codes.add(match[1]);
    for (const match of sources.matchAll(/error: "([a-z_]+)"/g)) codes.add(match[1]);
    for (const match of (sources + core).matchAll(/"((?:mssv|email|handle|display_name|full_name|password|otp|login|invite|submission|practice)_[a-z_]+)"/g)) codes.add(match[1]);
    for (const match of sources.matchAll(/\["[^"]+", "([a-z_]+)"\]/g)) codes.add(match[1]);
    for (const match of core.matchAll(/return "([a-z_]+)";/g)) codes.add(match[1]);
    expect(codes.size).toBeGreaterThan(20);
    const missing = [...codes].filter((code) => !(code in BOT_CUP_ERROR_MESSAGES) && !["ok"].includes(code));
    expect(missing).toEqual([]);
  });
});

describe("bannerLine", () => {
  const event = {
    registrationOpensAt: Date.UTC(2026, 10, 30, 0), registrationClosesAt: Date.UTC(2026, 11, 4, 17),
    codeFreezeAt: Date.UTC(2026, 11, 6, 17), finalsAt: Date.UTC(2026, 11, 10, 2),
  } as never;
  it("names the next milestone", () => {
    expect(bannerLine(null, 0)).toMatch(/Giải đấu lập trình bot/);
    expect(bannerLine(event, Date.UTC(2026, 10, 1))).toMatch(/^Mở đăng ký /);
    expect(bannerLine(event, Date.UTC(2026, 11, 1))).toMatch(/^Đang mở đăng ký · hạn chót /);
    expect(bannerLine(event, Date.UTC(2026, 11, 5))).toMatch(/^Khóa code /);
    expect(bannerLine(event, Date.UTC(2026, 11, 8))).toMatch(/^Chung kết /);
    expect(bannerLine(event, Date.UTC(2026, 11, 20))).toBe("Xem kết quả giải đấu");
  });
});
