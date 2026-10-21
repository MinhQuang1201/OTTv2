// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { GameSession } from "../sessions/contract";
import { DemoSession } from "../sessions/demo/DemoSession";
import type { OnlineLobbyGateway } from "../sessions/online/OnlineLobbyGateway";
import type { PendingOnlineGame, ResumeStore } from "../sessions/online/resumeStore";

const saved: PendingOnlineGame = { allocationId: "alloc-1", room: "ott-alloc-1", seat: "B", resumeCredential: "cred-1", alias: "K7N-M4P", playerName: "Bình", savedAt: Date.now() };

function memoryStore(initial: PendingOnlineGame | null): ResumeStore & { value: PendingOnlineGame | null } {
  return { value: initial, read() { return this.value; }, write(game) { this.value = game; }, clear() { this.value = null; } };
}

function fakeOnlineSession() {
  const snapshot = new DemoSession("lobby-default").getSnapshot();
  const start = vi.fn(async () => undefined);
  const session: GameSession = {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    start,
    getLegalMoves: () => [],
    move: async () => ({ accepted: true }),
    leave: async () => undefined,
    dispose: vi.fn(),
  };
  return { session, start };
}

const gateway = { available: true, listRooms: vi.fn(async () => ({ available: true, rooms: [] })) } as unknown as OnlineLobbyGateway;

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("App online recovery", () => {
  it("offers an unfinished game in the lobby and re-enters it with the saved credential", async () => {
    const user = userEvent.setup();
    const online = fakeOnlineSession();
    const onlineSessionFactory = vi.fn(() => online.session);
    render(<App initialScenario="lobby-default" demoEnabled={false} onlineGateway={gateway} onlineSessionFactory={onlineSessionFactory} resumeStore={memoryStore(saved)} />);

    const card = await screen.findByRole("region", { name: "Ván online đang dở" });
    expect(card).toHaveTextContent("Phòng K7N-M4P");
    expect(card).toHaveTextContent("Xanh (B)");
    await user.click(screen.getByRole("button", { name: "Vào lại" }));

    await waitFor(() => expect(online.start).toHaveBeenCalledWith({ mode: "online", intent: "resume", playerName: "Bình", allocationId: "alloc-1", resumeCredential: "cred-1" }));
  });

  it("lets the player discard the unfinished game", async () => {
    const user = userEvent.setup();
    const store = memoryStore(saved);
    render(<App initialScenario="lobby-default" demoEnabled={false} onlineGateway={gateway} onlineSessionFactory={vi.fn()} resumeStore={store} />);

    await user.click(await screen.findByRole("button", { name: "Bỏ" }));
    expect(store.value).toBeNull();
    expect(screen.queryByRole("region", { name: "Ván online đang dở" })).not.toBeInTheDocument();
  });

  it("pre-fills the room code from an invite link and removes it from the address bar", async () => {
    window.history.replaceState(null, "", "/?join=K7N-M4P");
    render(<App initialScenario="lobby-default" demoEnabled={false} onlineGateway={gateway} onlineSessionFactory={vi.fn()} resumeStore={memoryStore(null)} />);

    expect(await screen.findByRole("textbox", { name: "Mã phòng" })).toHaveValue("K7N-M4P");
    expect(window.location.search).toBe("");
  });
});
