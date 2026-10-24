// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import deterministicFixture from "../../../../../tests/fixtures/arena/replays/deterministic-match.json";
import type { BotCupApiGateway, KnockoutPairing, TournamentView } from "./BotCupApiGateway";
import { ProjectorScreen } from "./ProjectorScreen";

const game = (id: string, gameIndex: number, red: "a" | "b", status: "finished" | "queued" = "finished") => ({
  id, mapId: ["classic", "flanks", "center"][Math.floor(gameIndex / 2) % 3], gameIndex, status, outcome: status === "finished" ? "win" as const : null,
  winner: status === "finished" ? "A" as const : null, reason: status === "finished" ? "goal" : null, red,
});

function pairing(slot: string, red: string, blue: string, round = 1): KnockoutPairing {
  return { round, slot, red, blue, seeds: [1, 4], points: [3, 2], tiebreaks: 0, winner: null, decidedBySeed: false, games: [game(`${slot}-0`, 0, "a"), game(`${slot}-1`, 1, "b"), game(`${slot}-2`, 2, "a", "queued")] };
}

const view: TournamentView = {
  phase: "knockout", documents: [], standings: { format: "round_robin", rows: [] },
  knockout: [pairing("SF1", "Đội An", "Đội Dũng"), pairing("SF2", "Đội Bình", "Đội Chi")],
};

function gatewayWith(overrides: Record<string, unknown> = {}) {
  return {
    getTournament: vi.fn().mockResolvedValue(view),
    getMatchReplay: vi.fn().mockResolvedValue({ replay: structuredClone(deterministicFixture), sha256: "x" }),
    ...overrides,
  } as unknown as BotCupApiGateway & { getMatchReplay: ReturnType<typeof vi.fn> };
}

describe("ProjectorScreen", () => {
  afterEach(cleanup);

  it("shows the pairing score, both teams and the current game on a large board", async () => {
    const gateway = gatewayWith();
    render(<ProjectorScreen gateway={gateway} onExit={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Bán kết 1" })).toBeInTheDocument();
    const scoreboard = screen.getByLabelText("Tỉ số cặp đấu");
    expect(scoreboard).toHaveTextContent("Đội An");
    expect(scoreboard).toHaveTextContent("3 – 2");
    expect(scoreboard).toHaveTextContent("Đội Dũng");
    expect(await screen.findByText("Đỏ: Đội An")).toBeInTheDocument();
    expect(await screen.findByLabelText("Bảng điều khiển xem lại trận đấu")).toBeInTheDocument();
    expect(gateway.getMatchReplay).toHaveBeenCalledWith("SF1-0");
    // Board cells are accessible (81 squares).
    expect(screen.getAllByRole("button", { name: /^Ô /i })).toHaveLength(81);
  });

  it("lets the MC change game, pairing and speed from the keyboard", async () => {
    const gateway = gatewayWith();
    render(<ProjectorScreen gateway={gateway} onExit={vi.fn()} />);
    await screen.findByLabelText("Bảng điều khiển xem lại trận đấu");
    await act(async () => { fireEvent.keyDown(window, { key: "n" }); });
    expect(await screen.findByText("Đỏ: Đội Dũng")).toBeInTheDocument();
    expect(gateway.getMatchReplay).toHaveBeenLastCalledWith("SF1-1");
    const list = screen.getByLabelText("Các ván của cặp");
    expect(within(list).getAllByRole("listitem")[1]).toHaveAttribute("aria-current", "true");

    await act(async () => { fireEvent.keyDown(window, { key: "+" }); });
    expect(screen.getByText(/tốc độ \(2×\)/)).toBeInTheDocument();
    await act(async () => { fireEvent.keyDown(window, { key: "-" }); fireEvent.keyDown(window, { key: "-" }); });
    expect(screen.getByText(/tốc độ \(0.5×\)/)).toBeInTheDocument();

    await act(async () => { fireEvent.keyDown(window, { key: "]" }); });
    expect(await screen.findByRole("heading", { name: "Bán kết 2" })).toBeInTheDocument();
    expect(gateway.getMatchReplay).toHaveBeenLastCalledWith("SF2-0");

    // A game that has not been played shows no board.
    await act(async () => { fireEvent.keyDown(window, { key: "n" }); fireEvent.keyDown(window, { key: "n" }); });
    expect(await screen.findByText("Ván này chưa đấu xong.")).toBeInTheDocument();
  });

  it("says so when there is no knockout yet, and refuses a replay that is not valid", async () => {
    const empty = gatewayWith({ getTournament: vi.fn().mockResolvedValue({ ...view, knockout: [] }) });
    render(<ProjectorScreen gateway={empty} onExit={vi.fn()} />);
    expect(await screen.findByText(/chưa có ván loại trực tiếp/)).toBeInTheDocument();
    cleanup();

    const broken = gatewayWith({ getMatchReplay: vi.fn().mockResolvedValue({ replay: { not: "a replay" }, sha256: "x" }) });
    render(<ProjectorScreen gateway={broken} onExit={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Replay của ván này không hợp lệ.");
  });
});
