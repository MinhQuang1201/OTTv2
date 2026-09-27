import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ResultDialog } from "./ResultDialog";

describe("ResultDialog", () => {
  afterEach(() => cleanup());
  it.each([
    ["goal", "Bạn thắng"],
    ["elimination", "Bạn thua"],
    ["no_moves", "Bình thắng"],
    ["timeout", "Bình thắng"],
    ["disconnect_timeout", "Bình thắng"],
    ["leave", "Bình thắng"],
  ] as const)("renders the normalized %s result", (reason, title) => {
    const viewerSeat = reason === "no_moves" || reason === "timeout" || reason === "disconnect_timeout" || reason === "leave" ? null : "A";
    render(<ResultDialog open result={{ winner: reason === "goal" ? "A" : "B", reason }} viewerSeat={viewerSeat} playerNames={{ A: "An", B: "Bình" }} onClose={() => undefined} onLobby={() => undefined} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(title)).toBeInTheDocument();
  });
});
