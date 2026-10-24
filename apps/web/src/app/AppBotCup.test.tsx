// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, type AppState } from "./App";
import type { BotCupApiGateway } from "../features/bot-cup/BotCupApiGateway";

const NOW = Date.now();

function fakeBotCupGateway() {
  return {
    getEvent: vi.fn().mockResolvedValue({
      id: "ev", name: "OTT Bot Cup Thử", mode: "demo", phase: "registration", registrationOpen: true,
      registrationOpensAt: NOW - 1000, registrationClosesAt: NOW + 86_400_000, practiceOpensAt: null, codeFreezeAt: null, finalsAt: null,
      eligibility: { mssvDigits: 8, mssvPrefix: null, emailDomain: "vnu.edu.vn", allowExternalEmail: true },
      turnstileSiteKey: null, serverTime: NOW,
    }),
    me: vi.fn().mockResolvedValue(null),
    getAnnouncements: vi.fn().mockResolvedValue({ announcements: [] }),
    previewInvite: vi.fn().mockResolvedValue({ eventName: "OTT Bot Cup Thử", teamName: "Đội Beta", fullName: "Trần B", email: "26****02@vnu.edu.vn", registrationOpen: true }),
  } as unknown as BotCupApiGateway & Record<string, ReturnType<typeof vi.fn>>;
}

describe("App Bot Cup route", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/");
  });

  it("opens the event from the lobby banner and returns to the lobby", async () => {
    const user = userEvent.setup();
    const states: AppState[] = [];
    render(<App initialScenario="lobby-default" botCupEnabled botCupGateway={fakeBotCupGateway()} onStateChange={(state) => states.push(state)} />);

    await user.click(await screen.findByRole("button", { name: /OTT Bot Cup Thử: Đang mở đăng ký/ }));
    expect(await screen.findByRole("heading", { name: "Đăng ký tham gia" })).toBeInTheDocument();
    expect(states.at(-1)?.status).toBe("botCup");
    expect(new URLSearchParams(window.location.search).get("view")).toBe("bot-cup");

    await user.click(screen.getByRole("button", { name: "Về sảnh" }));
    await waitFor(() => expect(states.at(-1)?.status).toBe("lobby"));
    expect(new URLSearchParams(window.location.search).has("view")).toBe(false);
  });

  it("follows an invite link straight to the invite and drops the token from the address bar", async () => {
    const token = "b".repeat(43);
    window.history.replaceState(null, "", `/?view=bot-cup&invite=${token}`);
    const gateway = fakeBotCupGateway();
    render(<App initialScenario="lobby-default" botCupEnabled botCupGateway={gateway} />);

    expect(await screen.findByText("Đội Beta")).toBeInTheDocument();
    expect(gateway.previewInvite).toHaveBeenCalledWith(token);
    expect(window.location.search).toBe("?view=bot-cup");
  });

  it("opens the finals projector from ?view=bot-cup&screen=projector and leaves it for the lobby", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/?view=bot-cup&screen=projector");
    const gateway = fakeBotCupGateway();
    gateway.getTournament = vi.fn().mockResolvedValue({ phase: "knockout", documents: [], standings: { format: null, rows: [] }, knockout: [] });
    render(<App initialScenario="lobby-default" botCupEnabled botCupGateway={gateway} />);

    expect(await screen.findByRole("region", { name: "Trình chiếu chung kết OTT Bot Cup" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Thoát" }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).has("view")).toBe(false));
    expect(new URLSearchParams(window.location.search).has("screen")).toBe(false);
  });

  it("shows no banner when the Bot Cup is off", async () => {
    render(<App initialScenario="lobby-default" botCupEnabled={false} botCupGateway={fakeBotCupGateway()} />);
    expect(await screen.findByRole("heading", { name: /OTTv2/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /OTT Bot Cup/ })).not.toBeInTheDocument();
  });
});
