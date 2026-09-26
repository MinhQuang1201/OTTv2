import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App, createDemoSession, type SessionFactory } from "./App";
import { DemoSession } from "../sessions/demo/DemoSession";

describe("App shell lifecycle", () => {
  afterEach(cleanup);
  it("creates a real demo session and renders the lobby state", () => {
    const session = createDemoSession("lobby-default");

    expect(session).toBeInstanceOf(DemoSession);
    render(<App initialScenario="lobby-default" />);

    expect(screen.getByRole("main", { name: /OTTv2/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Sảnh/i })).toBeInTheDocument();
    expect(screen.getByText("lobby-default", { selector: "dd" })).toBeInTheDocument();
  });

  it.each([
    ["lobby-online-connecting", /Đang chuẩn bị/i],
    ["game-active-a", /Bàn chơi/i],
    ["result-goal", /Kết quả/i],
  ] as const)("routes %s to the %s screen", (scenario, heading) => {
    render(<App initialScenario={scenario} />);

    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByTestId("app-state")).toHaveAttribute(
      "data-state",
      scenario.startsWith("lobby-") ? "preparing" : scenario.startsWith("game-") ? "playing" : "finished",
    );
  });

  it("shows a safe retryable error and recovers to the lobby", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    render(<App initialScenario="game-recoverable-error" />);

    expect(screen.getByRole("heading", { name: /Đã xảy ra sự cố/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Thử lại/i })).toBeInTheDocument();
    expect(screen.queryByText(/session_failed/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Về sảnh/i }));
    expect(screen.getByRole("heading", { name: /Sảnh/i })).toBeInTheDocument();
  });

  it("disposes the previous session when the selected scenario changes", async () => {
    const user = (await import("@testing-library/user-event")).default.setup();
    const sessions: DemoSession[] = [];
    const factory: SessionFactory = (scenario) => {
      const session = new DemoSession(scenario);
      sessions.push(session);
      return session;
    };
    render(<App initialScenario="lobby-default" sessionFactory={factory} />);

    await user.selectOptions(screen.getByRole("combobox", { name: /Kịch bản demo/i }), "game-active-a");

    expect(sessions).toHaveLength(2);
    expect(screen.getByRole("heading", { name: /Bàn chơi/i })).toBeInTheDocument();
    expect(sessions[0]!.getLegalMoves({ x: 0, y: 2 })).toEqual([]);
  });

  it("falls back safely when the requested scenario is invalid", () => {
    render(<App initialScenario={"not-a-scenario" as never} />);

    expect(screen.getByRole("heading", { name: /Sảnh/i })).toBeInTheDocument();
  });
});
