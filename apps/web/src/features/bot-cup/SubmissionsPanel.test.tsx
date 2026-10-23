// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotCupApiError, type BotCupApiGateway, type BotCupEvent, type Submission, type SubmissionsView, type TeamView } from "./BotCupApiGateway";
import { SubmissionsPanel } from "./SubmissionsPanel";

const NOW = Date.UTC(2026, 11, 1, 3, 0);
const event = {
  id: "ev", name: "Cup", mode: "demo", phase: "practice", registrationOpen: true, registrationOpensAt: 0, registrationClosesAt: NOW * 2,
  practiceOpensAt: NOW - 1000, codeFreezeAt: NOW + 86_400_000, finalsAt: null,
  eligibility: { mssvDigits: 8, mssvPrefix: null, emailDomain: "vnu.edu.vn", allowExternalEmail: true }, turnstileSiteKey: null, serverTime: NOW,
} as BotCupEvent;
const team = {
  handle: "alpha", displayName: "Alpha", kind: "solo", status: "active", createdAt: 0, activeAt: 0,
  members: [],
} as unknown as TeamView;

function submission(version: number, overrides: Partial<Submission> = {}): Submission {
  return {
    id: `s${version}`, version, language: "python", filename: "bot.py", size: 2048, sha256: `${version}`.repeat(64).slice(0, 64),
    origin: "upload", status: "checking", createdAt: NOW, ...overrides,
  };
}

function view(overrides: Partial<SubmissionsView> = {}): SubmissionsView {
  return {
    submissions: [], finalSubmissionId: null, finalChosen: false,
    window: { open: true, reason: null, practiceOpensAt: NOW - 1000, codeFreezeAt: NOW + 86_400_000, finalLocked: false },
    quota: { perDay: 10, usedToday: 0, resetsAt: NOW, maxVersions: 200, total: 0 }, maxBytes: 204800, ...overrides,
  };
}

interface Mocks {
  readonly listSubmissions: ReturnType<typeof vi.fn>;
  readonly uploadSubmission: ReturnType<typeof vi.fn>;
  readonly chooseFinalSubmission: ReturnType<typeof vi.fn>;
}

function gatewayWith(initial: SubmissionsView): Omit<BotCupApiGateway, keyof Mocks> & Mocks {
  const mocks = {
    listSubmissions: vi.fn().mockResolvedValue(initial),
    uploadSubmission: vi.fn(),
    chooseFinalSubmission: vi.fn(),
    submissionSourceUrl: (id: string) => `/api/t/submissions/${id}/source`,
  };
  return mocks as unknown as Omit<BotCupApiGateway, keyof Mocks> & Mocks;
}

const asGateway = (gateway: ReturnType<typeof gatewayWith>) => gateway as unknown as BotCupApiGateway;

describe("SubmissionsPanel", () => {
  afterEach(cleanup);

  it("uploads a bot file and shows the new version with its SHA-256 receipt", async () => {
    const user = userEvent.setup();
    const uploaded = submission(1);
    const gateway = gatewayWith(view());
    gateway.uploadSubmission.mockResolvedValue({ submission: uploaded });
    gateway.listSubmissions
      .mockResolvedValueOnce(view())
      .mockResolvedValueOnce(view({ submissions: [uploaded], finalSubmissionId: uploaded.id, quota: { perDay: 10, usedToday: 1, resetsAt: NOW, maxVersions: 200, total: 1 } }));
    render(<SubmissionsPanel gateway={asGateway(gateway)} event={event} team={team} onSignedOut={vi.fn()} />);

    expect(await screen.findByText("Đội chưa nộp phiên bản nào.")).toBeInTheDocument();
    const file = new File(["print(1)\n"], "bot.py", { type: "text/x-python" });
    await user.upload(screen.getByLabelText("File bot"), file);
    await user.click(screen.getByRole("button", { name: "Nộp bài" }));

    expect(gateway.uploadSubmission).toHaveBeenCalledWith(file);
    expect(await screen.findByRole("status")).toHaveTextContent(`Đã nhận phiên bản 1. SHA-256: ${uploaded.sha256}`);
    const list = screen.getByRole("list", { name: "Các phiên bản đã nộp" });
    expect(within(list).getByText("Bản thi đấu")).toBeInTheDocument();
    expect(within(list).getByText("Chờ kiểm tra")).toBeInTheDocument();
    expect(within(list).getByRole("link", { name: "Tải mã" })).toHaveAttribute("href", "/api/t/submissions/s1/source");
    expect(screen.getByText("Hôm nay đã nộp 1/10.")).toBeInTheDocument();
  });

  it("checks the file before sending it", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const gateway = gatewayWith(view());
    render(<SubmissionsPanel gateway={asGateway(gateway)} event={event} team={team} onSignedOut={vi.fn()} />);
    await screen.findByText("Đội chưa nộp phiên bản nào.");
    await user.upload(screen.getByLabelText("File bot"), new File(["x"], "bot.cpp"));
    await user.click(screen.getByRole("button", { name: "Nộp bài" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Chỉ nhận một file \.py/);
    await user.upload(screen.getByLabelText("File bot"), new File(["#".repeat(200 * 1024 + 1)], "big.py"));
    await user.click(screen.getByRole("button", { name: "Nộp bài" }));
    expect(screen.getByRole("alert")).toHaveTextContent("File quá 200 KB.");
    expect(gateway.uploadSubmission).not.toHaveBeenCalled();
  });

  it("shows the API's reason in Vietnamese when an upload is refused", async () => {
    const user = userEvent.setup();
    const gateway = gatewayWith(view());
    gateway.uploadSubmission.mockRejectedValue(new BotCupApiError(429, "submission_daily_limit"));
    render(<SubmissionsPanel gateway={asGateway(gateway)} event={event} team={team} onSignedOut={vi.fn()} />);
    await screen.findByText("Đội chưa nộp phiên bản nào.");
    await user.upload(screen.getByLabelText("File bot"), new File(["print(1)"], "bot.py"));
    await user.click(screen.getByRole("button", { name: "Nộp bài" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Đội đã nộp đủ 10 lần hôm nay");
  });

  it("chooses another version as the final submission, but not a failed one", async () => {
    const user = userEvent.setup();
    const v1 = submission(1, { status: "ready" });
    const v2 = submission(2);
    const v3 = submission(3, { status: "build_failed" });
    const initial = view({ submissions: [v3, v2, v1], finalSubmissionId: v2.id });
    const gateway = gatewayWith(initial);
    gateway.chooseFinalSubmission.mockResolvedValue({ ...initial, finalSubmissionId: v1.id, finalChosen: true });
    render(<SubmissionsPanel gateway={asGateway(gateway)} event={event} team={team} onSignedOut={vi.fn()} />);

    const items = await screen.findAllByRole("listitem");
    expect(within(items[0]).getByText("Lỗi cú pháp")).toBeInTheDocument();
    expect(within(items[0]).queryByRole("button", { name: "Chọn làm Bản thi đấu" })).toBeNull();
    expect(within(items[1]).getByText("Bản thi đấu")).toBeInTheDocument();
    await user.click(within(items[2]).getByRole("button", { name: "Chọn làm Bản thi đấu" }));
    expect(gateway.chooseFinalSubmission).toHaveBeenCalledWith("s1");
    expect(await screen.findByText("Bản thi đấu: phiên bản 1.")).toBeInTheDocument();
    expect(within(screen.getAllByRole("listitem")[2]).getByText("Bản thi đấu")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dùng phiên bản mới nhất" })).toBeInTheDocument();
  });

  it("explains a closed window and hides the upload form after code freeze", async () => {
    const frozen = view({
      submissions: [submission(1)], finalSubmissionId: "s1",
      window: { open: false, reason: "code_frozen", practiceOpensAt: 0, codeFreezeAt: NOW - 1, finalLocked: true },
    });
    render(<SubmissionsPanel gateway={asGateway(gatewayWith(frozen))} event={event} team={team} onSignedOut={vi.fn()} />);
    expect(await screen.findByText(/Đã khóa code/)).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Nộp bài" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Chọn làm Bản thi đấu" })).toBeNull();
  });

  it("does not load submissions for a team that is not active yet", () => {
    const gateway = gatewayWith(view());
    render(<SubmissionsPanel gateway={asGateway(gateway)} event={event} team={{ ...team, status: "pending_members" }} onSignedOut={vi.fn()} />);
    expect(gateway.listSubmissions).not.toHaveBeenCalled();
    expect(screen.getByText(/đội đã đủ thành viên xác nhận/)).toBeInTheDocument();
  });

  it("signs out when the session has expired", async () => {
    const onSignedOut = vi.fn();
    const gateway = gatewayWith(view());
    gateway.listSubmissions.mockRejectedValue(new BotCupApiError(401, "unauthorized"));
    render(<SubmissionsPanel gateway={asGateway(gateway)} event={event} team={team} onSignedOut={onSignedOut} />);
    await vi.waitFor(() => expect(onSignedOut).toHaveBeenCalled());
  });
});
