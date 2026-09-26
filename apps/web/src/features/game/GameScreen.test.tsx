import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GameScreen } from "./GameScreen";
import { DemoSession } from "../../sessions/demo/DemoSession";
import { AppProviders } from "../../app/AppProviders";

describe("GameScreen", () => {
  afterEach(() => cleanup());
  it("shows the table HUD, side rail, and leaves local games directly", async () => {
    const user = userEvent.setup();
    const session = new DemoSession("game-active-a");
    const onLobby = vi.fn();
    render(<AppProviders><GameScreen session={session} snapshot={session.getSnapshot()} onLobby={onLobby} /></AppProviders>);

    expect(screen.getByRole("heading", { name: /bàn chơi/i })).toBeInTheDocument();
    expect(screen.getByText("An")).toBeInTheDocument();
    expect(screen.getByText("Bình")).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: /lịch sử nước đi/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /rời bàn/i }));
    expect(onLobby).toHaveBeenCalledTimes(1);
  });

  it("requires confirmation before leaving an online game", async () => {
    const user = userEvent.setup();
    const session = new DemoSession("game-active-a");
    const leave = vi.spyOn(session, "leave");
    const snapshot = { ...session.getSnapshot(), mode: "online" as const };
    vi.spyOn(session, "getSnapshot").mockReturnValue(snapshot);
    render(<AppProviders><GameScreen session={session} snapshot={snapshot} onLobby={vi.fn()} /></AppProviders>);

    await user.click(screen.getByRole("button", { name: /rời bàn/i }));
    expect(leave).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: /rời bàn/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^xác nhận rời bàn$/i }));
    expect(leave).toHaveBeenCalledTimes(1);
  });
});
