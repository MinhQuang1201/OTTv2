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
    const onMove = vi.fn();
    render(<Board session={session} snapshot={session.getSnapshot()} onMove={onMove} />);

    expect(screen.getAllByRole("button", { name: /ô [A-I][1-9]/i })).toHaveLength(81);
    await user.click(screen.getByRole("button", { name: /ô A3.*Lá.*Người A/i }));
    expect(screen.getByRole("button", { name: /ô A2.*nước hợp lệ/i })).toBeInTheDocument();
    expect(session.getLegalMoves).toBeDefined();
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
});
