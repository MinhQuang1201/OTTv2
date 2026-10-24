// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotCupApiError, type BotCupApiGateway, type BotCupEvent, type TeamView } from "./BotCupApiGateway";
import { BotCupBanner } from "./BotCupBanner";
import { BotCupScreen } from "./BotCupScreen";
import { NO_TURNSTILE_TOKEN } from "./TurnstileWidget";

const NOW = Date.now();
function makeEvent(overrides: Partial<BotCupEvent> = {}): BotCupEvent {
  return {
    id: "ev", name: "OTT Bot Cup Thử", mode: "demo", phase: "registration", registrationOpen: true,
    registrationOpensAt: NOW - 86_400_000, registrationClosesAt: NOW + 86_400_000, practiceOpensAt: null, codeFreezeAt: null, finalsAt: null,
    eligibility: { mssvDigits: 8, mssvPrefix: null, emailDomain: "vnu.edu.vn", allowExternalEmail: true },
    turnstileSiteKey: null, serverTime: NOW, ...overrides,
  };
}

const soloTeam: TeamView = {
  handle: "alpha", displayName: "Đội Alpha", kind: "solo", status: "active", createdAt: NOW, activeAt: NOW,
  members: [{ mssv: "26020101", fullName: "Nguyễn Văn A", email: "26****01@vnu.edu.vn", role: "captain", status: "confirmed", showName: true }],
};

function fakeGateway(overrides: Partial<Record<keyof BotCupApiGateway, unknown>> = {}) {
  const gateway = {
    getEvent: vi.fn().mockResolvedValue(makeEvent()),
    me: vi.fn().mockResolvedValue(null),
    register: vi.fn(),
    verifyRegistration: vi.fn(),
    resendRegistration: vi.fn(),
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue({ ok: true }),
    addMember: vi.fn(),
    removeMember: vi.fn(),
    resendInvite: vi.fn(),
    previewInvite: vi.fn(),
    acceptInvite: vi.fn(),
    requestPasswordReset: vi.fn(),
    confirmPasswordReset: vi.fn(),
    changePassword: vi.fn(),
    revokeAllSessions: vi.fn(),
    listSubmissions: vi.fn().mockResolvedValue({
      submissions: [], finalSubmissionId: null, finalChosen: false,
      window: { open: false, reason: "submissions_not_open", practiceOpensAt: null, codeFreezeAt: null, finalLocked: false },
      quota: { perDay: 10, usedToday: 0, resetsAt: NOW, maxVersions: 200, total: 0 }, maxBytes: 204800,
    }),
    uploadSubmission: vi.fn(),
    getSubmission: vi.fn(),
    listMatches: vi.fn().mockResolvedValue({ matches: [], practice: { gamesPerDay: 20, usedToday: 0, opponents: [{ id: "easy", name: "AI Dễ" }], maps: ["classic"] } }),
    requestPractice: vi.fn(),
    getMatch: vi.fn(),
    getMatchReplay: vi.fn(),
    getAnnouncements: vi.fn().mockResolvedValue({ announcements: [] }),
    getLeaderboard: vi.fn().mockResolvedValue({ opponents: [], rows: [], updatedAt: NOW }),
    chooseFinalSubmission: vi.fn(),
    submissionSourceUrl: vi.fn((id: string) => `/api/t/submissions/${id}/source`),
    ...overrides,
  };
  return gateway as unknown as BotCupApiGateway & Record<string, ReturnType<typeof vi.fn>>;
}

async function fillRegistration(user: ReturnType<typeof userEvent.setup>, { mssv = "21020999" } = {}) {
  await user.type(screen.getByLabelText("Tên hiển thị"), "Đội Alpha");
  await user.type(screen.getByLabelText("Tên đăng nhập"), "Alpha");
  await user.type(screen.getByLabelText("Mật khẩu"), "long-password-1");
  await user.type(screen.getByLabelText("Nhập lại mật khẩu"), "long-password-1");
  await user.type(screen.getByLabelText("Họ và tên"), "Nguyễn Văn A");
  await user.type(screen.getByLabelText("MSSV"), mssv);
  await user.click(screen.getByRole("checkbox", { name: /Tôi đồng ý/ }));
}

describe("BotCupScreen", () => {
  afterEach(cleanup);

  it("registers a solo team, verifies the OTP and shows the team page", async () => {
    const user = userEvent.setup();
    const gateway = fakeGateway({
      register: vi.fn().mockResolvedValue({ handle: "alpha", status: "pending_captain", otpSentTo: "21****99@vnu.edu.vn" }),
      verifyRegistration: vi.fn().mockResolvedValue(soloTeam),
    });
    render(<BotCupScreen gateway={gateway} onLobby={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Đăng ký tham gia" })).toBeInTheDocument();
    expect(screen.getByText(/sinh viên mọi khóa/)).toBeInTheDocument();
    await fillRegistration(user);
    await user.click(screen.getByRole("button", { name: "Đăng ký và nhận mã" }));

    expect(gateway.register).toHaveBeenCalledWith({
      kind: "solo", handle: "alpha", displayName: "Đội Alpha", password: "long-password-1", consent: true, showName: true,
      turnstileToken: NO_TURNSTILE_TOKEN, captain: { fullName: "Nguyễn Văn A", mssv: "21020999" },
    });
    expect(await screen.findByText("21****99@vnu.edu.vn")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Mã xác minh"), "123456");
    await user.click(screen.getByRole("button", { name: "Xác minh" }));

    expect(gateway.verifyRegistration).toHaveBeenCalledWith("alpha", "123456");
    expect(await screen.findByRole("heading", { name: "Đội Alpha" })).toBeInTheDocument();
    expect(screen.getByText("Đã đủ điều kiện")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Đội của tôi" })).toHaveAttribute("aria-pressed", "true");
  });

  it("checks the MSSV before sending and applies the production cohort rule", async () => {
    const user = userEvent.setup();
    const gateway = fakeGateway({
      getEvent: vi.fn().mockResolvedValue(makeEvent({ mode: "production", eligibility: { mssvDigits: 8, mssvPrefix: "26", emailDomain: "vnu.edu.vn", allowExternalEmail: false } })),
    });
    render(<BotCupScreen gateway={gateway} onLobby={vi.fn()} />);
    await screen.findByRole("heading", { name: "Đăng ký tham gia" });
    expect(screen.queryByLabelText(/Email nhận mã/)).not.toBeInTheDocument();
    await fillRegistration(user, { mssv: "25020999" });
    await user.click(screen.getByRole("button", { name: "Đăng ký và nhận mã" }));
    expect(screen.getByText("Giải này chỉ dành cho sinh viên K71 (MSSV bắt đầu bằng 26).")).toBeInTheDocument();
    expect(gateway.register).not.toHaveBeenCalled();
  });

  it("shows a server error next to the field it is about", async () => {
    const user = userEvent.setup();
    const gateway = fakeGateway({ register: vi.fn().mockRejectedValue(new BotCupApiError(409, "handle_taken")) });
    render(<BotCupScreen gateway={gateway} onLobby={vi.fn()} />);
    await screen.findByRole("heading", { name: "Đăng ký tham gia" });
    await fillRegistration(user);
    await user.click(screen.getByRole("button", { name: "Đăng ký và nhận mã" }));
    expect(await screen.findByText("Tên đăng nhập đã có đội dùng.")).toBeInTheDocument();
    expect(screen.getByLabelText("Tên đăng nhập")).toHaveAttribute("aria-invalid", "true");
  });

  it("logs in and sends an unverified team to the OTP step", async () => {
    const user = userEvent.setup();
    const gateway = fakeGateway({ login: vi.fn().mockRejectedValue(new BotCupApiError(403, "verification_required")) });
    render(<BotCupScreen gateway={gateway} onLobby={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Đăng nhập" }));
    await user.type(screen.getByLabelText("Tên đăng nhập"), "alpha");
    await user.type(screen.getByLabelText("Mật khẩu"), "long-password-1");
    await user.click(screen.getAllByRole("button", { name: "Đăng nhập" }).at(-1)!);
    expect(gateway.login).toHaveBeenCalledWith("alpha", "long-password-1", NO_TURNSTILE_TOKEN);
    expect(await screen.findByRole("heading", { name: "Nhập mã xác minh" })).toBeInTheDocument();
  });

  it("accepts an invite only with consent", async () => {
    const user = userEvent.setup();
    const gateway = fakeGateway({
      previewInvite: vi.fn().mockResolvedValue({ eventName: "OTT Bot Cup Thử", teamName: "Đội Beta", fullName: "Trần B", email: "26****02@vnu.edu.vn", registrationOpen: true }),
      acceptInvite: vi.fn().mockResolvedValue({ teamName: "Đội Beta", status: "active" }),
    });
    const token = "a".repeat(43);
    render(<BotCupScreen gateway={gateway} onLobby={vi.fn()} inviteToken={token} />);
    expect(await screen.findByText("Đội Beta")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Xác nhận tham gia" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/cần đồng ý/);
    expect(gateway.acceptInvite).not.toHaveBeenCalled();
    await user.click(screen.getByRole("checkbox", { name: /Tôi đồng ý/ }));
    await user.click(screen.getByRole("button", { name: "Xác nhận tham gia" }));
    expect(gateway.acceptInvite).toHaveBeenCalledWith(token, true, true);
    expect(await screen.findByText(/đã xác nhận tham gia đội "Đội Beta"/)).toBeInTheDocument();
  });

  it("rejects a malformed invite token without calling the API", async () => {
    const gateway = fakeGateway();
    render(<BotCupScreen gateway={gateway} onLobby={vi.fn()} inviteToken="bad" />);
    expect(await screen.findByText("Lời mời không hợp lệ hoặc đã bị huỷ.")).toBeInTheDocument();
    expect(gateway.previewInvite).not.toHaveBeenCalled();
  });

  it("shows the API failure in Vietnamese and retries", async () => {
    const user = userEvent.setup();
    const gateway = fakeGateway({ getEvent: vi.fn().mockRejectedValueOnce(new BotCupApiError(0, "network_error")).mockResolvedValue(makeEvent()) });
    render(<BotCupScreen gateway={gateway} onLobby={vi.fn()} />);
    expect(await screen.findByText(/Không kết nối được máy chủ giải đấu/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Thử lại" }));
    expect(await screen.findByRole("heading", { name: "Đăng ký tham gia" })).toBeInTheDocument();
  });

  it("invites a member from the team page of a group", async () => {
    const user = userEvent.setup();
    const group: TeamView = { ...soloTeam, kind: "group", status: "pending_members" };
    const withInvite: TeamView = { ...group, members: [...group.members, { mssv: "26020102", fullName: "Trần B", email: "26****02@vnu.edu.vn", role: "member", status: "pending", showName: false }] };
    const gateway = fakeGateway({ me: vi.fn().mockResolvedValue(group), addMember: vi.fn().mockResolvedValue(withInvite) });
    render(<BotCupScreen gateway={gateway} onLobby={vi.fn()} />);
    expect(await screen.findByText(/Mời thêm 1–2 thành viên/)).toBeInTheDocument();
    const form = screen.getByRole("form", { name: "Mời thành viên" });
    await user.type(within(form).getByLabelText("Họ và tên"), "Trần B");
    await user.type(within(form).getByLabelText("MSSV"), "26020102");
    await user.click(within(form).getByRole("button", { name: "Gửi lời mời" }));
    expect(gateway.addMember).toHaveBeenCalledWith({ fullName: "Trần B", mssv: "26020102" });
    expect(await screen.findByText("Đã gửi lời mời tới Trần B.")).toBeInTheDocument();
    expect(screen.getByText("Chờ xác nhận")).toBeInTheDocument();
  });
});

describe("BotCupBanner", () => {
  afterEach(cleanup);

  it("is one named button that opens the event", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const gateway = fakeGateway();
    render(<BotCupBanner gateway={gateway} onOpen={onOpen} />);
    const banner = await screen.findByRole("button", { name: /OTT Bot Cup Thử: Đang mở đăng ký/ });
    await user.click(banner);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("still opens the event when the API is down", async () => {
    const gateway = fakeGateway({ getEvent: vi.fn().mockRejectedValue(new BotCupApiError(0, "network_error")) });
    render(<BotCupBanner gateway={gateway} onOpen={vi.fn()} />);
    await waitFor(() => expect(gateway.getEvent).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: /OTT Bot Cup: Giải đấu lập trình bot/ })).toBeInTheDocument();
  });
});
