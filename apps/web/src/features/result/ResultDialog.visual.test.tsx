import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResultDialog } from "./ResultDialog";

describe("ResultDialog visual contracts", () => {
  afterEach(() => cleanup());

  it("exposes data-outcome='win' for viewer victory and retains valid actions", () => {
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

    const outcomeEl = screen.getByTestId("result-dialog-outcome");
    expect(outcomeEl).toHaveAttribute("data-outcome", "win");
    expect(screen.getByRole("button", { name: "Xem bàn" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Về sảnh" })).toBeInTheDocument();

    // Verify unavailable mock-only actions are absent
    expect(screen.queryByRole("button", { name: /đấu lại|rematch/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /phân tích/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/elo/i)).not.toBeInTheDocument();
  });

  it("exposes data-outcome='loss' for viewer defeat", () => {
    render(
      <ResultDialog
        open
        result={{ winner: "B", reason: "elimination" }}
        viewerSeat="A"
        playerNames={{ A: "An", B: "Bình" }}
        onClose={vi.fn()}
        onLobby={vi.fn()}
      />,
    );

    const outcomeEl = screen.getByTestId("result-dialog-outcome");
    expect(outcomeEl).toHaveAttribute("data-outcome", "loss");
  });

  it("exposes data-outcome='neutral' when there is no viewer seat", () => {
    render(
      <ResultDialog
        open
        result={{ winner: "A", reason: "timeout" }}
        viewerSeat={null}
        playerNames={{ A: "An", B: "Bình" }}
        onClose={vi.fn()}
        onLobby={vi.fn()}
      />,
    );

    const outcomeEl = screen.getByTestId("result-dialog-outcome");
    expect(outcomeEl).toHaveAttribute("data-outcome", "neutral");
  });
});
