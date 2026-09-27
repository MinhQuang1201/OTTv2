import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LobbyScreen } from "../features/lobby/LobbyScreen";
import { GameScreen } from "../features/game/GameScreen";
import { ResultDialog } from "../features/result/ResultDialog";
import { DemoSession } from "../sessions/demo/DemoSession";
import { AppProviders } from "../app/AppProviders";

afterEach(() => cleanup());

function renderLobby() {
  return render(
    <LobbyScreen
      onlineAvailability="unavailable"
      waitingRooms={{ status: "unavailable", message: "Online hiện không khả dụng." }}
      onStartLocal={vi.fn()}
      onStartAi={vi.fn()}
      onCreateOnline={vi.fn()}
      onJoinOnline={vi.fn()}
    />,
  );
}

function renderGame() {
  const session = new DemoSession("game-active-a");
  render(
    <AppProviders>
      <GameScreen session={session} snapshot={session.getSnapshot()} onLobby={vi.fn()} />
    </AppProviders>,
  );
  return session;
}

describe("cross-screen accessibility contract", () => {
  it("gives the lobby one named landmark, one heading, and labeled form controls", () => {
    renderLobby();

    expect(screen.getByRole("region", { name: "OTTv2" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "Tên của bạn" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Chơi cùng máy/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Đánh với AI/i })).toBeInTheDocument();
  });

  it("exposes the game status as text and renders all 81 keyboard-operable board buttons", async () => {
    const user = userEvent.setup();
    renderGame();

    expect(screen.getByRole("main", { name: /bàn chơi/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: /bàn chơi/i })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/đến lượt bạn|đối thủ đang đi/i);

    const cells = screen.getAllByRole("button", { name: /^Ô /i });
    expect(cells).toHaveLength(81);
    expect(cells.every((cell) => cell.getAttribute("aria-label"))).toBe(true);

    const firstEnabledCell = cells.find((cell) => !cell.hasAttribute("disabled"));
    expect(firstEnabledCell).toBeDefined();
    firstEnabledCell?.focus();
    await user.keyboard(" ");
    expect(document.activeElement).toBe(firstEnabledCell);
  });

  it("moves focus into the result dialog and keeps keyboard focus inside it", async () => {
    const user = userEvent.setup();
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.textContent = "Mở kết quả";
    document.body.append(trigger);
    trigger.focus();

    render(
      <ResultDialog
        open
        result={{ winner: "A", reason: "goal" }}
        viewerSeat="A"
        playerNames={{ A: "An", B: "Bình" }}
        onClose={vi.fn()}
        onLobby={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Kết quả" });
    const close = screen.getByRole("button", { name: "Đóng kết quả" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(document.activeElement).toBe(close);

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Về sảnh" }));
    await user.tab();
    expect(document.activeElement).toBe(close);
  });

});
