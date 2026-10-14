import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArenaApiGateway } from "../ArenaApiGateway";
import { PracticeMatchPanel } from "./PracticeMatchPanel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PracticeMatchPanel", () => {
  let mockGateway: Partial<ArenaApiGateway>;

  beforeEach(() => {
    mockGateway = {
      listBots: vi.fn().mockResolvedValue({
        bots: [
          { id: "bot-mine", name: "MyBot", ownerId: "user-123", status: "active" },
          { id: "bot-other", name: "RivalBot", ownerId: "user-999", status: "active" },
        ],
      }),
      listBotVersions: vi.fn().mockImplementation((botId: string) => {
        if (botId === "bot-mine") {
          return Promise.resolve({
            versions: [
              {
                id: "ver-mine-1",
                botId: "bot-mine",
                versionNo: 1,
                profileId: "controlled-node",
                buildStatus: "ready",
              },
              {
                id: "ver-mine-2",
                botId: "bot-mine",
                versionNo: 2,
                profileId: "controlled-node",
                buildStatus: "building", // not ready
              },
            ],
          });
        }
        if (botId === "bot-other") {
          return Promise.resolve({
            versions: [
              {
                id: "ver-other-1",
                botId: "bot-other",
                versionNo: 1,
                profileId: "python-v1",
                buildStatus: "ready",
              },
            ],
          });
        }
        return Promise.resolve({ versions: [] });
      }),
      createPracticeMatch: vi.fn().mockResolvedValue({
        match: {
          id: "match-prac-777",
          kind: "practice",
          ladderId: "ladder-main",
          status: "pending",
          participants: {
            A: { seat: "A", botVersionId: "ver-mine-1" },
            B: { seat: "B", botVersionId: "ver-other-1" },
          },
        },
      }),
    };
  });

  it("renders loading spinner initially, then populates ready bot versions", async () => {
    render(
      <PracticeMatchPanel
        gateway={mockGateway as ArenaApiGateway}
        userId="user-123"
        userRole="author"
      />
    );

    // After resolution
    await waitFor(() => {
      expect(screen.getByText("MyBot (v1 · controlled-node)")).toBeInTheDocument();
    });

    expect(screen.getByText("Seat A")).toBeInTheDocument();
    expect(screen.getByText("Seat B")).toBeInTheDocument();
  });

  it("restricts Seat A options to owned READY versions for authors", async () => {
    render(
      <PracticeMatchPanel
        gateway={mockGateway as ArenaApiGateway}
        userId="user-123"
        userRole="author"
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: /phiên bản bot seat a/i })).toBeInTheDocument();
    });

    const selectA = screen.getByRole("combobox", { name: /phiên bản bot seat a/i }) as HTMLSelectElement;
    const selectB = screen.getByRole("combobox", { name: /phiên bản bot seat b/i }) as HTMLSelectElement;

    // Seat A only contains MyBot (owned), not RivalBot
    const optionsA = Array.from(selectA.options).map((o) => o.value);
    expect(optionsA).toEqual(["ver-mine-1"]);

    // Seat B contains both MyBot and RivalBot
    const optionsB = Array.from(selectB.options).map((o) => o.value);
    expect(optionsB).toContain("ver-mine-1");
    expect(optionsB).toContain("ver-other-1");
  });

  it("allows admins to select any READY version for Seat A", async () => {
    render(
      <PracticeMatchPanel
        gateway={mockGateway as ArenaApiGateway}
        userId="user-admin"
        userRole="admin"
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: /phiên bản bot seat a/i })).toBeInTheDocument();
    });

    const selectA = screen.getByRole("combobox", { name: /phiên bản bot seat a/i }) as HTMLSelectElement;
    const optionsA = Array.from(selectA.options).map((o) => o.value);

    // Admin can choose ver-mine-1 or ver-other-1 for Seat A
    expect(optionsA).toContain("ver-mine-1");
    expect(optionsA).toContain("ver-other-1");
  });

  it("creates practice match successfully and invokes onCreated callback", async () => {
    const onCreated = vi.fn();
    render(
      <PracticeMatchPanel
        gateway={mockGateway as ArenaApiGateway}
        userId="user-123"
        userRole="author"
        onCreated={onCreated}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /bắt đầu trận đấu tập/i })).toBeEnabled();
    });

    const startBtn = screen.getByRole("button", { name: /bắt đầu trận đấu tập/i });
    fireEvent.click(startBtn);

    await waitFor(() => {
      expect(mockGateway.createPracticeMatch).toHaveBeenCalledWith({
        participants: {
          A: { botVersionId: "ver-mine-1" },
          B: { botVersionId: "ver-other-1" },
        },
      });
      expect(onCreated).toHaveBeenCalledWith("match-prac-777");
    });

    expect(screen.getByRole("status")).toHaveTextContent(/Đã tạo trận đấu tập thành công: match-prac-777/i);
  });

  it("displays error banner when match creation fails", async () => {
    (mockGateway.createPracticeMatch as any).mockRejectedValueOnce(
      new Error("Bot version is not ready for practice")
    );

    render(
      <PracticeMatchPanel
        gateway={mockGateway as ArenaApiGateway}
        userId="user-123"
        userRole="author"
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /bắt đầu trận đấu tập/i })).toBeEnabled();
    });

    const startBtn = screen.getByRole("button", { name: /bắt đầu trận đấu tập/i });
    fireEvent.click(startBtn);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Bot version is not ready for practice");
    });
  });

  it("renders empty state when author owns no READY versions", async () => {
    // User 9999 has no bots
    render(
      <PracticeMatchPanel
        gateway={mockGateway as ArenaApiGateway}
        userId="user-9999"
        userRole="author"
      />
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Bạn chưa sở hữu phiên bản bot nào ở trạng thái READY/i)
      ).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: /bắt đầu trận đấu tập/i })).not.toBeInTheDocument();
  });
});
