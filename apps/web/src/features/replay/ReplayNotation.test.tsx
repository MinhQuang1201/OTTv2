// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplayNotation } from "./ReplayNotation";
import deterministicFixture from "../../../../../tests/fixtures/arena/replays/deterministic-match.json";
import type { ReplayDocument } from "../../sessions/contract";

describe("ReplayNotation", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders cumulative move table, highlights active ply, and protects future moves from spoilers", async () => {
    const user = userEvent.setup();
    const onSeek = vi.fn();
    const doc = deterministicFixture as unknown as ReplayDocument;

    render(<ReplayNotation document={doc} activePly={1} onSeek={onSeek} />);

    // Renders table headers
    expect(screen.getByText("Biên bản nước đi")).toBeInTheDocument();
    expect(screen.getByText("Lượt")).toBeInTheDocument();
    expect(screen.getByText("Bên A")).toBeInTheDocument();
    expect(screen.getByText("Bên B")).toBeInTheDocument();

    // Past/active move (ply 1) is fully revealed with piece and coordinates
    const ply1Btn = screen.getByTestId("replay-ply-item-1");
    expect(ply1Btn).toBeInTheDocument();
    expect(ply1Btn).toHaveAttribute("aria-current", "step");
    expect(ply1Btn.textContent).toMatch(/^[ĐLK] [A-I][1-9]-[A-I][1-9]/);

    // Future move (ply 2) is spoiler-protected: does NOT reveal destination or captures
    const ply2Btn = screen.getByTestId("replay-ply-item-2");
    expect(ply2Btn).toBeInTheDocument();
    expect(ply2Btn).not.toHaveAttribute("aria-current");
    expect(ply2Btn.textContent).toBe("Nước 2");

    // Click spoiler toggle to reveal all future moves
    const spoilerToggle = screen.getByTestId("replay-notation-spoiler-toggle");
    await user.click(spoilerToggle);
    expect(ply2Btn.textContent).toMatch(/^[ĐLK] [A-I][1-9]-[A-I][1-9]/);
  });

  it("invokes onSeek when move button is clicked", async () => {
    const user = userEvent.setup();
    const onSeek = vi.fn();
    const doc = deterministicFixture as unknown as ReplayDocument;

    render(<ReplayNotation document={doc} activePly={0} onSeek={onSeek} />);

    const ply2Btn = screen.getByTestId("replay-ply-item-2");
    await user.click(ply2Btn);

    expect(onSeek).toHaveBeenCalledWith(2);
  });

  it("renders initial start button and seeks to ply 0 when clicked", async () => {
    const user = userEvent.setup();
    const onSeek = vi.fn();
    const doc = deterministicFixture as unknown as ReplayDocument;

    render(<ReplayNotation document={doc} activePly={5} onSeek={onSeek} />);

    const startBtn = screen.getByTestId("replay-ply-item-0");
    expect(startBtn).toBeInTheDocument();
    expect(startBtn).not.toHaveAttribute("aria-current");

    await user.click(startBtn);
    expect(onSeek).toHaveBeenCalledWith(0);
  });

  it("does not invent default 'dam' when moved piece is unknown", () => {
    const customDoc: ReplayDocument = {
      ...deterministicFixture,
      initialCoreState: {
        ...deterministicFixture.initialCoreState,
        pieces: [],
      },
      frames: [
        {
          ply: 0,
          coreState: { ...deterministicFixture.initialCoreState, pieces: [] },
          lastMove: null,
        },
        {
          ply: 1,
          coreState: { ...deterministicFixture.initialCoreState, pieces: [] },
          lastMove: {
            seat: "A",
            pieceId: "unknown-piece-id",
            from: { x: 1, y: 1 },
            to: { x: 1, y: 2 },
            capturedPieceId: null,
            capturedPieceType: null,
            elapsedMs: 50,
            remainingMs: 10000,
            events: [],
          },
        },
      ],
    } as unknown as ReplayDocument;

    render(<ReplayNotation document={customDoc} activePly={1} onSeek={vi.fn()} />);

    const ply1Btn = screen.getByTestId("replay-ply-item-1");
    // Should render coordinates B2-B3 without inventing "Đ" or "Đấm"
    expect(ply1Btn.textContent).toBe("B2-B3");
    expect(ply1Btn.textContent).not.toContain("Đ");
  });

  it("renders empty state message when document has no frames", () => {
    const emptyDoc = {
      ...deterministicFixture,
      frames: [],
    } as unknown as ReplayDocument;

    render(<ReplayNotation document={emptyDoc} activePly={0} onSeek={vi.fn()} />);

    expect(screen.getByText("Không có nước đi nào trong ván này.")).toBeInTheDocument();
  });

  it("scrolls active move within the notation container without calling scrollIntoView on ancestor elements", () => {
    const doc = deterministicFixture as unknown as ReplayDocument;
    const scrollIntoViewSpy = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoViewSpy;

    const { rerender } = render(<ReplayNotation document={doc} activePly={0} onSeek={vi.fn()} />);

    // Advance ply
    rerender(<ReplayNotation document={doc} activePly={1} onSeek={vi.fn()} />);

    // Must NOT call scrollIntoView because scrollIntoView causes ancestor window scrolling
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
  });

  it("scrolls active row into container viewport using boundingClientRect geometry contract", () => {
    const doc = deterministicFixture as unknown as ReplayDocument;
    const { rerender } = render(<ReplayNotation document={doc} activePly={0} onSeek={vi.fn()} />);

    const listEl = screen.getByRole("region", { name: "Danh sách nước đi" });
    Object.defineProperty(listEl, "clientHeight", { value: 200, configurable: true });
    listEl.scrollTop = 0;

    vi.spyOn(listEl, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 300,
      left: 0,
      right: 200,
      height: 200,
      width: 200,
      x: 0,
      y: 100,
      toJSON: () => {},
    });

    // Mock active element below visible container (relativeBottom = 280 > visibleBottom 200)
    const ply1Btn = screen.getByTestId("replay-ply-item-1");
    vi.spyOn(ply1Btn, "getBoundingClientRect").mockReturnValue({
      top: 350,
      bottom: 380,
      left: 0,
      right: 100,
      height: 30,
      width: 100,
      x: 0,
      y: 350,
      toJSON: () => {},
    });

    rerender(<ReplayNotation document={doc} activePly={1} onSeek={vi.fn()} />);

    // Expected new scrollTop: relativeBottom (280) - clientHeight (200) = 80
    expect(listEl.scrollTop).toBe(80);

    // Now test scrolling back up when item is above viewport (relativeTop = 20 < visibleTop 80)
    const startBtn = screen.getByTestId("replay-ply-item-0");
    vi.spyOn(startBtn, "getBoundingClientRect").mockReturnValue({
      top: 40,
      bottom: 70,
      left: 0,
      right: 100,
      height: 30,
      width: 100,
      x: 0,
      y: 40,
      toJSON: () => {},
    });

    rerender(<ReplayNotation document={doc} activePly={0} onSeek={vi.fn()} />);

    // Expected new scrollTop: relativeTop = 20
    expect(listEl.scrollTop).toBe(20);
  });
});
