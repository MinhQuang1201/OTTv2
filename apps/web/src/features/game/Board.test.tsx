import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Board } from "./Board";
import { DemoSession } from "../../sessions/demo/DemoSession";
import type { PieceView } from "../../shared/model/game";

const piece = (id: string, seat: "A" | "B", type: "dam" | "la" | "keo", x: number, y: number): PieceView => ({ id, seat, type, position: { x, y } });

describe("Board", () => {
  afterEach(() => cleanup());
  it("renders 81 coordinate-aware buttons and resolves legal moves", async () => {
    const user = userEvent.setup();
    const session = new DemoSession("game-active-a");
    const getLegalMoves = vi.spyOn(session, "getLegalMoves");
    const onMove = vi.fn();
    render(<Board session={session} snapshot={session.getSnapshot()} onMove={onMove} />);

    expect(screen.getAllByRole("button", { name: /ô [A-I][1-9]/i })).toHaveLength(81);
    await user.click(screen.getByRole("button", { name: /ô A3.*Lá.*Người A/i }));
    expect(screen.getByRole("button", { name: /ô A2.*nước hợp lệ/i })).toBeInTheDocument();
    expect(getLegalMoves).toHaveBeenCalledWith({ x: 0, y: 2 });
    await user.click(screen.getByRole("button", { name: /ô A2.*nước hợp lệ/i }));
    expect(onMove).toHaveBeenCalledWith({ x: 0, y: 2 }, { x: 0, y: 1 });
  });

  it("disables input while waiting, pending, reconnecting, or AI thinking", () => {
    const session = new DemoSession("game-active-a");
    const snapshot = session.getSnapshot();
    const { rerender } = render(<Board session={session} snapshot={{ ...snapshot, pendingMove: true }} />);
    expect(screen.getByTestId("board-cell-A3")).toBeDisabled();
    rerender(<Board session={session} snapshot={{ ...snapshot, connection: "reconnecting" }} />);
    expect(screen.getByTestId("board-cell-A3")).toBeDisabled();
    rerender(<Board session={session} snapshot={{ ...snapshot, aiThinking: true }} />);
    expect(screen.getByTestId("board-cell-A3")).toBeDisabled();
    rerender(<Board session={session} snapshot={{ ...snapshot, phase: "waiting", turn: null }} />);
    expect(screen.getByTestId("board-cell-A3")).toBeDisabled();
  });

  it("keeps spectator and null-viewer boards read-only without calling session APIs", async () => {
    const user = userEvent.setup();
    const session = new DemoSession("spectator-active");
    const getLegalMoves = vi.spyOn(session, "getLegalMoves");
    const move = vi.spyOn(session, "move");
    const snapshot = session.getSnapshot();
    const { rerender } = render(<Board session={session} snapshot={snapshot} />);

    expect(screen.getAllByRole("button", { name: /^Ô /i })).toHaveLength(81);
    expect(screen.getAllByRole("button").every((cell) => (cell as HTMLButtonElement).disabled)).toBe(true);
    const cell = screen.getByTestId("board-cell-A3");
    await user.click(cell);
    await user.pointer({ target: cell, keys: "[TouchA]" });
    await user.keyboard("{Enter}");
    expect(getLegalMoves).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();

    rerender(<Board session={session} snapshot={{ ...snapshot, viewer: null, viewerSeat: null, phase: "idle" }} />);
    expect(screen.getByTestId("board-cell-A3")).toBeDisabled();

    rerender(<Board session={session} snapshot={{
      ...snapshot,
      capabilities: { canMove: false, canLeaveGame: false, canSpectate: false },
    }} />);
    expect(screen.getByTestId("board-cell-A3")).toBeDisabled();
    await user.click(screen.getByTestId("board-cell-A3"));
    expect(getLegalMoves).not.toHaveBeenCalled();
  });

  it("keeps a player viewer read-only when move capability is disabled", async () => {
    const user = userEvent.setup();
    const session = new DemoSession("game-active-a");
    const getLegalMoves = vi.spyOn(session, "getLegalMoves");
    const move = vi.spyOn(session, "move");
    const snapshot = session.getSnapshot();
    const restrictedSnapshot = {
      ...snapshot,
      viewer: { role: "player" as const, seat: "A" as const },
      viewerSeat: "A" as const,
      capabilities: { canMove: false, canLeaveGame: false, canSpectate: false },
    };
    render(<Board session={session} snapshot={restrictedSnapshot} />);

    const cells = screen.getAllByRole("button", { name: /^Ô /i });
    expect(cells).toHaveLength(81);
    expect(cells.every((cell) => (cell as HTMLButtonElement).disabled)).toBe(true);
    await user.click(screen.getByTestId("board-cell-A3"));
    await user.keyboard("{Enter}");
    expect(getLegalMoves).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
  });

  it("keeps a null-viewer error board disabled without crashing", async () => {
    const user = userEvent.setup();
    const session = new DemoSession("game-active-a");
    const getLegalMoves = vi.spyOn(session, "getLegalMoves");
    const move = vi.spyOn(session, "move");
    const snapshot = session.getSnapshot();
    const errorSnapshot = {
      ...snapshot,
      phase: "error" as const,
      viewer: null,
      viewerSeat: null,
      capabilities: { canMove: false, canLeaveGame: false, canSpectate: false },
      error: { code: "session_failed" as const, message: "Không thể đồng bộ ván đấu.", retryable: true },
    };
    render(<Board session={session} snapshot={errorSnapshot} />);

    const cells = screen.getAllByRole("button", { name: /^Ô /i });
    expect(cells).toHaveLength(81);
    expect(cells.every((cell) => (cell as HTMLButtonElement).disabled)).toBe(true);
    await user.click(screen.getByTestId("board-cell-A3"));
    expect(getLegalMoves).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
  });

  it("clears a player selection when move capability is revoked", async () => {
    const user = userEvent.setup();
    const session = new DemoSession("game-active-a");
    const snapshot = session.getSnapshot();
    const { rerender } = render(<Board session={session} snapshot={snapshot} />);

    await user.click(screen.getByTestId("board-cell-A3"));
    expect(screen.getByTestId("board-cell-A3")).toHaveAttribute("aria-pressed", "true");

    rerender(<Board session={session} snapshot={{ ...snapshot, viewer: { role: "player", seat: "A" } }} />);
    expect(screen.getByTestId("board-cell-A3")).toHaveAttribute("aria-pressed", "true");

    rerender(<Board session={session} snapshot={{
      ...snapshot,
      viewer: { role: "spectator" },
      viewerSeat: null,
      capabilities: { canMove: false, canLeaveGame: false, canSpectate: true },
    }} />);
    expect(screen.getByTestId("board-cell-A3")).toHaveAttribute("aria-pressed", "false");
  });

  it("flips visual perspective to seat B while preserving all 81 canonical coordinate names", () => {
    const session = new DemoSession("spectator-active");
    const snapshot = session.getSnapshot();
    render(<Board session={session} snapshot={snapshot} perspective="B" />);

    const cells = screen.getAllByRole("button", { name: /^Ô /i });
    expect(cells).toHaveLength(81);

    // In perspective B, the first rendered cell is canonical I9 (x=8, y=8)
    expect(cells[0]).toHaveAttribute("data-x", "8");
    expect(cells[0]).toHaveAttribute("data-y", "8");
    expect(cells[0]).toHaveAttribute("data-testid", "board-cell-I9");
    expect(cells[0]).toHaveAccessibleName(/^Ô I9/i);

    // The last rendered cell is canonical A1 (x=0, y=0)
    expect(cells[80]).toHaveAttribute("data-x", "0");
    expect(cells[80]).toHaveAttribute("data-y", "0");
    expect(cells[80]).toHaveAttribute("data-testid", "board-cell-A1");
    expect(cells[80]).toHaveAccessibleName(/^Ô A1/i);
  });

  it("applies move and capture decoration attributes without altering cell interaction", () => {
    const session = new DemoSession("spectator-active");
    const snapshot = session.getSnapshot();
    render(
      <Board
        session={session}
        snapshot={snapshot}
        highlightMove={{ from: { x: 0, y: 2 }, to: { x: 0, y: 1 } }}
        lastCapture={{ x: 0, y: 1 }}
      />
    );

    const fromCell = screen.getByTestId("board-cell-A3");
    const toCell = screen.getByTestId("board-cell-A2");

    expect(fromCell).toHaveAttribute("data-last-move-from", "true");
    expect(toCell).toHaveAttribute("data-last-move-to", "true");
    expect(toCell).toHaveAttribute("data-last-capture", "true");
    expect(toCell.getAttribute("aria-label")).toContain("vừa ăn quân");
  });

  it("marks and explains neighbouring squares the selected piece cannot enter", async () => {
    const user = userEvent.setup();
    const session = new DemoSession("game-active-a");
    const snapshot = {
      ...session.getSnapshot(),
      board: [piece("A-la-0", "A", "la", 4, 4), piece("B-keo-0", "B", "keo", 4, 3), piece("B-la-0", "B", "la", 5, 5), piece("B-dam-0", "B", "dam", 3, 3)],
    };
    vi.spyOn(session, "getLegalMoves").mockReturnValue([{ x: 3, y: 3 }]);
    const move = vi.spyOn(session, "move");
    const onBlocked = vi.fn();
    render(<Board session={session} snapshot={snapshot} onBlocked={onBlocked} />);

    await user.click(screen.getByTestId("board-cell-E5"));
    const blockedCell = screen.getByTestId("board-cell-E4");
    expect(blockedCell).toHaveAttribute("title", "Lá thua Kéo");
    expect(blockedCell).toHaveAccessibleName(/bị chặn: Lá thua Kéo/);
    expect(screen.getByTestId("board-cell-F6")).toHaveAttribute("title", "Lá gặp Lá");
    expect(screen.getByTestId("board-cell-D4")).not.toHaveAttribute("title");
    expect(screen.getAllByTestId("blocked-lock")).toHaveLength(2);

    await user.click(blockedCell);
    expect(onBlocked).toHaveBeenCalledWith(expect.objectContaining({ message: "Lá thua Kéo — không đi vào ô này được." }));
    expect(move).not.toHaveBeenCalled();
    expect(screen.getByTestId("board-cell-E5")).toHaveAttribute("aria-pressed", "true");
  });

  it("shows the capture label and shatters the captured piece on the capture square", () => {
    const session = new DemoSession("spectator-active");
    render(
      <Board
        session={session}
        snapshot={session.getSnapshot()}
        captureEffect={{ id: 7, at: { x: 5, y: 2 }, attacker: { seat: "B", type: "keo" }, captured: { seat: "A", type: "la" } }}
      />,
    );

    expect(screen.getByTestId("capture-label")).toHaveTextContent("✂ Kéo ăn 📄 Lá");
    const shatter = within(screen.getByTestId("board-cell-F3")).getByTestId("capture-shatter");
    expect(shatter.children).toHaveLength(9);
    expect(screen.getAllByTestId("capture-shatter")).toHaveLength(1);
  });

  describe("piece slide", () => {
    const originalAnimate = Element.prototype.animate;
    const originalMatchMedia = window.matchMedia;
    afterEach(() => {
      Element.prototype.animate = originalAnimate;
      window.matchMedia = originalMatchMedia;
      vi.restoreAllMocks();
    });

    const setup = (reducedMotion: boolean) => {
      const animate = vi.fn(() => ({ addEventListener: vi.fn() }) as unknown as Animation);
      Element.prototype.animate = animate;
      window.matchMedia = vi.fn(() => ({ matches: reducedMotion }) as MediaQueryList);
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        const x = Number(this.dataset.x ?? 0);
        const y = Number(this.dataset.y ?? 0);
        return { left: x * 40, top: y * 40, width: 40, height: 40, right: x * 40 + 40, bottom: y * 40 + 40, x: x * 40, y: y * 40, toJSON: () => ({}) } as DOMRect;
      });
      const session = new DemoSession("spectator-active");
      const base = session.getSnapshot();
      const before = { ...base, board: [piece("A-la-0", "A", "la", 4, 4), piece("B-keo-0", "B", "keo", 7, 7)] };
      const after = { ...base, board: [piece("A-la-0", "A", "la", 4, 3), piece("B-keo-0", "B", "keo", 7, 7)] };
      return { animate, session, before, after };
    };

    it("slides a piece that moved one square from its old cell", () => {
      const { animate, session, before, after } = setup(false);
      const { rerender } = render(<Board session={session} snapshot={before} />);
      rerender(<Board session={session} snapshot={after} />);

      expect(animate).toHaveBeenCalledTimes(1);
      expect(animate.mock.contexts[0]).toHaveAttribute("data-piece-id", "A-la-0");
      expect((animate.mock.calls[0] as unknown[])[0]).toEqual([{ transform: "translate(0px, 40px)" }, { transform: "translate(0, 0)" }]);

      rerender(<Board session={session} snapshot={before} perspective="B" />);
      expect(animate).toHaveBeenCalledTimes(1);
    });

    it("cancels a running slide when the board flips right after the move", () => {
      const { animate, session, before, after } = setup(false);
      const cancel = vi.fn();
      animate.mockReturnValue({ addEventListener: vi.fn(), cancel } as unknown as Animation);
      const { rerender } = render(<Board session={session} snapshot={before} />);
      rerender(<Board session={session} snapshot={after} />);
      rerender(<Board session={session} snapshot={after} perspective="B" />);
      expect(cancel).toHaveBeenCalledTimes(1);
    });

    it("draws moves without motion when the user prefers reduced motion", () => {
      const { animate, session, before, after } = setup(true);
      const { rerender } = render(<Board session={session} snapshot={before} />);
      rerender(<Board session={session} snapshot={after} />);
      expect(animate).not.toHaveBeenCalled();
    });
  });

  it("applies per-seat selection styling when piece is selected by seat B", async () => {
    const user = userEvent.setup();
    const session = new DemoSession("game-active-a");
    const snapshot = {
      ...session.getSnapshot(),
      turn: "B" as const,
      viewer: { role: "player" as const, seat: "B" as const },
      viewerSeat: "B" as const,
    };
    vi.spyOn(session, "getSnapshot").mockReturnValue(snapshot);
    render(<Board session={session} snapshot={snapshot} />);

    // In game-active-a, B has piece at I7 (x=8, y=6)
    const cellI7 = screen.getByTestId("board-cell-I7");
    await user.click(cellI7);

    expect(cellI7).toHaveAttribute("aria-pressed", "true");
    expect(cellI7).toHaveAttribute("data-selected-seat", "B");
  });
});
