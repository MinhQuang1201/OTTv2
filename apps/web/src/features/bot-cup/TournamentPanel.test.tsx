// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotCupApiError, type BotCupApiGateway, type TournamentView } from "./BotCupApiGateway";
import { TournamentPanel } from "./TournamentPanel";

const NOW = Date.UTC(2026, 11, 9, 3, 0);
const SHA = "a".repeat(64);

function gatewayWith(overrides: Record<string, unknown>) {
  return { resultDocumentUrl: (stage: string) => `/api/t/results/${stage}`, ...overrides } as unknown as BotCupApiGateway;
}

const view: TournamentView = {
  phase: "knockout",
  documents: [{ stage: "sealed", sha256: SHA, publishedAt: NOW }, { stage: "qualifying", sha256: "b".repeat(64), publishedAt: NOW }],
  standings: { format: "round_robin", rows: [
    { rank: 1, displayName: "Đội Alpha", points: 12, wins: 20, games: 24, sb: 30 },
    { rank: 2, displayName: "Đội Beta", points: 7.5, wins: 14, games: 24, sb: 18 },
  ] },
  knockout: [{
    round: 1, slot: "SF1", red: "Đội Alpha", blue: "Đội Delta", seeds: [1, 4], points: [3, 3], tiebreaks: 1, winner: null, decidedBySeed: false,
    games: [
      { id: "g1", mapId: "classic", gameIndex: 0, status: "finished", outcome: "win", winner: "A", reason: "goal", red: "a" },
      { id: "g2", mapId: "classic", gameIndex: 1, status: "finished", outcome: "win", winner: "A", reason: "elimination", red: "b" },
      { id: "g7", mapId: "flanks", gameIndex: 6, status: "queued", outcome: null, winner: null, reason: null, red: "a" },
    ],
  }],
};

describe("TournamentPanel", () => {
  afterEach(cleanup);

  it("shows the phase, published documents, standings and the bracket with replays", async () => {
    const user = userEvent.setup();
    const onOpenReplay = vi.fn();
    const getMatchReplay = vi.fn().mockResolvedValue({ replay: { kind: "doc" }, sha256: "x" });
    render(<TournamentPanel gateway={gatewayWith({ getTournament: vi.fn().mockResolvedValue(view), getMatchReplay })} signedIn={false} onOpenReplay={onOpenReplay} />);

    expect(await screen.findByText("Đang đấu loại trực tiếp")).toBeInTheDocument();
    expect(screen.getByText(SHA)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Tải JSON" })[0]).toHaveAttribute("href", "/api/t/results/sealed");
    const table = screen.getByRole("table");
    expect(within(table).getByRole("rowheader", { name: "Đội Beta" }).closest("tr")).toHaveTextContent("7,5");
    expect(screen.getByText("Bán kết 1: Đội Alpha (1) 3 – 3 Đội Delta (4)")).toBeInTheDocument();
    // Game 2: Delta held Red (seat A) and won.
    expect(screen.getByText("Ván 2 · Classic · Đỏ Đội Delta · Đội Delta thắng (tiêu diệt hết quân)")).toBeInTheDocument();
    expect(screen.getByText("Ván 7 · Flanks · Đỏ Đội Alpha · đang chờ")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Xem replay" })).toHaveLength(2);
    await user.click(screen.getAllByRole("button", { name: "Xem replay" })[0]);
    expect(getMatchReplay).toHaveBeenCalledWith("g1");
    expect(onOpenReplay).toHaveBeenCalledWith({ kind: "doc" });
    expect(screen.queryByRole("form", { name: "Gửi khiếu nại" })).not.toBeInTheDocument();
  });

  it("checks a document's SHA-256 in the browser", async () => {
    const user = userEvent.setup();
    const verifyResultDocument = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    render(<TournamentPanel gateway={gatewayWith({ getTournament: vi.fn().mockResolvedValue(view), verifyResultDocument })} signedIn={false} />);
    const buttons = await screen.findAllByRole("button", { name: "Kiểm tra SHA-256" });
    await user.click(buttons[0]);
    expect(verifyResultDocument).toHaveBeenCalledWith("sealed", SHA);
    expect(await screen.findByText("Khớp: tài liệu chưa bị sửa.")).toBeInTheDocument();
    await user.click(buttons[1]);
    expect(await screen.findByText("KHÔNG khớp. Hãy báo BTC.")).toBeInTheDocument();
  });

  it("lets a signed-in team appeal a published stage and shows the answer", async () => {
    const user = userEvent.setup();
    const answered = { id: "p1", stage: "qualifying", matchId: null, body: "Ván 3 bị lỗi máy chấm.", status: "answered", response: "Đã xem replay.", createdAt: NOW, answeredAt: NOW };
    const listAppeals = vi.fn().mockResolvedValueOnce({ appeals: [] }).mockResolvedValueOnce({ appeals: [answered] });
    const createAppeal = vi.fn().mockResolvedValue({ id: "p1", status: "open" });
    render(<TournamentPanel gateway={gatewayWith({ getTournament: vi.fn().mockResolvedValue(view), listAppeals, createAppeal })} signedIn />);

    const form = await screen.findByRole("form", { name: "Gửi khiếu nại" });
    // Only stages with published results can be appealed; "sealed" is not an appeal stage.
    expect(within(form).getAllByRole("option").map((option) => option.textContent)).toEqual(["Kết quả vòng loại"]);
    await user.type(within(form).getByLabelText("Nội dung (10–2000 ký tự)"), "Ván 3 bị lỗi máy chấm.");
    await user.click(within(form).getByRole("button", { name: "Gửi khiếu nại" }));
    expect(createAppeal).toHaveBeenCalledWith("qualifying", "Ván 3 bị lỗi máy chấm.", undefined);
    expect(await screen.findByText("Đã gửi khiếu nại. BTC sẽ trả lời tại đây.")).toBeInTheDocument();
    expect(screen.getByText("Đã xem replay.")).toBeInTheDocument();
  });

  it("explains a refused appeal in Vietnamese", async () => {
    const user = userEvent.setup();
    const createAppeal = vi.fn().mockRejectedValue(new BotCupApiError(409, "appeal_window_closed"));
    render(<TournamentPanel gateway={gatewayWith({ getTournament: vi.fn().mockResolvedValue(view), listAppeals: vi.fn().mockResolvedValue({ appeals: [] }), createAppeal })} signedIn />);
    const form = await screen.findByRole("form", { name: "Gửi khiếu nại" });
    await user.type(within(form).getByLabelText("Nội dung (10–2000 ký tự)"), "Khiếu nại quá hạn rồi.");
    await user.click(within(form).getByRole("button", { name: "Gửi khiếu nại" }));
    expect(await screen.findByText("Ngoài thời hạn khiếu nại của giai đoạn này.")).toBeInTheDocument();
  });
});
