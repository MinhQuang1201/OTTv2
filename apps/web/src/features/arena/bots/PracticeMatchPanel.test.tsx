// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
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
        total: 2,
        limit: 50,
        offset: 0,
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
      listReadyBotVersions: vi.fn().mockImplementation((botId: string) => {
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

  it("discovers own bot beyond page 1 via bounded pagination", async () => {
    // Page 1 contains 50 rival bots; page 2 contains user's own bot
    const page1Bots = Array.from({ length: 50 }, (_, i) => ({
      id: `bot-rival-${i}`,
      name: `RivalBot_${i}`,
      ownerId: "user-rival",
      status: "active",
    }));

    const page2Bots = [
      { id: "bot-mine-p2", name: "DeepMineBot", ownerId: "user-p2", status: "active" },
    ];

    (mockGateway.listBots as any).mockImplementation((opts: any) => {
      if (opts.offset === 0) {
        return Promise.resolve({ bots: page1Bots, total: 51, limit: 50, offset: 0 });
      }
      return Promise.resolve({ bots: page2Bots, total: 51, limit: 50, offset: 50 });
    });

    (mockGateway.listReadyBotVersions as any).mockImplementation((botId: string) => {
      if (botId === "bot-mine-p2") {
        return Promise.resolve({
          versions: [
            { id: "ver-deep-1", botId, versionNo: 1, profileId: "controlled-node", buildStatus: "ready" },
          ],
        });
      }
      return Promise.resolve({ versions: [] });
    });

    render(
      <PracticeMatchPanel
        gateway={mockGateway as ArenaApiGateway}
        userId="user-p2"
        userRole="author"
      />
    );

    await waitFor(() => {
      expect(screen.getByText("DeepMineBot (v1 · controlled-node)")).toBeInTheDocument();
    });

    const selectA = screen.getByRole("combobox", { name: /phiên bản bot seat a/i }) as HTMLSelectElement;
    expect(selectA.value).toBe("ver-deep-1");
  });

  it("filters out inactive bots even if they have ready versions", async () => {
    (mockGateway.listBots as any).mockResolvedValueOnce({
      bots: [
        { id: "bot-active", name: "ActiveBot", ownerId: "user-123", status: "active" },
        { id: "bot-archived", name: "ArchivedBot", ownerId: "user-123", status: "archived" },
        { id: "bot-disabled", name: "DisabledBot", ownerId: "user-999", status: "disabled" },
      ],
      total: 3,
      limit: 50,
      offset: 0,
    });

    (mockGateway.listReadyBotVersions as any).mockImplementation((botId: string) => {
      return Promise.resolve({
        versions: [
          { id: `ver-${botId}`, botId, versionNo: 1, profileId: "controlled-node", buildStatus: "ready" },
        ],
      });
    });

    render(
      <PracticeMatchPanel
        gateway={mockGateway as ArenaApiGateway}
        userId="user-123"
        userRole="author"
      />
    );

    await waitFor(() => {
      expect(screen.getByText("ActiveBot (v1 · controlled-node)")).toBeInTheDocument();
    });

    // Neither archived nor disabled bot should be listed
    expect(screen.queryByText(/ArchivedBot/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/DisabledBot/i)).not.toBeInTheDocument();
  });

  it("resets stale selection when previously selected version is absent on refresh", async () => {
    const { rerender } = render(
      <PracticeMatchPanel
        gateway={mockGateway as ArenaApiGateway}
        userId="user-123"
        userRole="author"
      />
    );

    await waitFor(() => {
      const selectA = screen.getByRole("combobox", { name: /phiên bản bot seat a/i }) as HTMLSelectElement;
      expect(selectA.value).toBe("ver-mine-1");
    });

    // Now bot-mine deletes ver-mine-1 and has ver-mine-updated only
    (mockGateway.listReadyBotVersions as any).mockImplementation((botId: string) => {
      if (botId === "bot-mine") {
        return Promise.resolve({
          versions: [
            { id: "ver-mine-updated", botId, versionNo: 2, profileId: "controlled-node", buildStatus: "ready" },
          ],
        });
      }
      return Promise.resolve({ versions: [] });
    });

    const refreshBtn = screen.getByRole("button", { name: /làm mới danh sách/i });
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      const selectA = screen.getByRole("combobox", { name: /phiên bản bot seat a/i }) as HTMLSelectElement;
      // Stale selection ver-mine-1 must be reset to ver-mine-updated
      expect(selectA.value).toBe("ver-mine-updated");
    });
  });

  it("prohibits spectator role from submitting practice matches", async () => {
    render(
      <PracticeMatchPanel
        gateway={mockGateway as ArenaApiGateway}
        userId="user-spec"
        userRole="spectator"
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/Vai trò Khán giả \(spectator\) chỉ có quyền theo dõi/i)).toBeInTheDocument();
    });

    const startBtn = screen.getByRole("button", { name: /bắt đầu trận đấu tập/i });
    expect(startBtn).toBeDisabled();

    fireEvent.click(startBtn);
    expect(mockGateway.createPracticeMatch).not.toHaveBeenCalled();
  });

  it("visibly displays errors when bot version retrieval fails", async () => {
    (mockGateway.listReadyBotVersions as any).mockRejectedValueOnce(
      new Error("Failed to load versions from DB")
    );

    render(
      <PracticeMatchPanel
        gateway={mockGateway as ArenaApiGateway}
        userId="user-123"
        userRole="author"
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByText(/Không thể tải phiên bản cho.*bot/i)).toBeInTheDocument();
    });
  });

  it("allows author to select opponent bot ready version for Seat B and creates match", async () => {
    render(
      <PracticeMatchPanel
        gateway={mockGateway as ArenaApiGateway}
        userId="user-123"
        userRole="author"
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: /phiên bản bot seat b/i })).toBeInTheDocument();
    });

    const selectB = screen.getByRole("combobox", { name: /phiên bản bot seat b/i }) as HTMLSelectElement;
    fireEvent.change(selectB, { target: { value: "ver-other-1" } });
    expect(selectB.value).toBe("ver-other-1");

    const startBtn = screen.getByRole("button", { name: /bắt đầu trận đấu tập/i });
    fireEvent.click(startBtn);

    await waitFor(() => {
      expect(mockGateway.createPracticeMatch).toHaveBeenCalledWith({
        participants: {
          A: { botVersionId: "ver-mine-1" },
          B: { botVersionId: "ver-other-1" },
        },
      });
    });
  });

  it("aborts in-flight request on rapid refresh and ignores stale out-of-order sequence", async () => {
    let callCount = 0;
    const signals: AbortSignal[] = [];

    (mockGateway.listBots as any).mockImplementation((opts: any) => {
      callCount++;
      if (opts.signal) signals.push(opts.signal);
      if (callCount === 1) {
        // First call: delayed response with bot-slow
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              bots: [{ id: "bot-slow", name: "SlowBot", ownerId: "user-123", status: "active" }],
              total: 1,
              limit: 50,
              offset: 0,
            });
          }, 50);
        });
      }
      // Second call: fast response with bot-fast owned by user-456
      return Promise.resolve({
        bots: [{ id: "bot-fast", name: "FastBot", ownerId: "user-456", status: "active" }],
        total: 1,
        limit: 50,
        offset: 0,
      });
    });

    (mockGateway.listReadyBotVersions as any).mockImplementation((botId: string) => {
      return Promise.resolve({
        versions: [
          { id: `ver-${botId}`, botId, versionNo: 1, profileId: "controlled-node", buildStatus: "ready" },
        ],
      });
    });

    const { rerender } = render(
      <PracticeMatchPanel
        gateway={mockGateway as ArenaApiGateway}
        userId="user-123"
        userRole="author"
      />
    );

    // Rerender with different userId while first request is in-flight
    rerender(
      <PracticeMatchPanel
        gateway={mockGateway as ArenaApiGateway}
        userId="user-456"
        userRole="author"
      />
    );

    // FastBot (from second call) should appear and stay in the document
    await waitFor(() => {
      expect(screen.getByText("FastBot (v1 · controlled-node)")).toBeInTheDocument();
    });

    // The first signal should have been aborted
    expect(signals[0]?.aborted).toBe(true);

    // Wait for the delayed first call to resolve, ensure SlowBot does NOT overwrite FastBot
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(screen.getByText("FastBot (v1 · controlled-node)")).toBeInTheDocument();
    expect(screen.queryByText("SlowBot (v1 · controlled-node)")).not.toBeInTheDocument();
  });
});
