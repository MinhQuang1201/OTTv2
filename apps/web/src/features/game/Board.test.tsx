import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Board } from "./Board";
import { DemoSession } from "../../sessions/demo/DemoSession";

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
});
