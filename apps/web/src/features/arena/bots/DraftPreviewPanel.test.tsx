import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ArenaApiGateway, ArenaApiError, type ArenaBotVersion } from "../ArenaApiGateway";
import { DraftPreviewPanel } from "./DraftPreviewPanel";

describe("DraftPreviewPanel", () => {
  let gateway: ArenaApiGateway;
  let runDraftSpy: MockInstance;

  const mockSavedVersions: readonly ArenaBotVersion[] = [
    {
      id: "v-1",
      botId: "bot-test",
      versionNo: 1,
      sourceDigest: "sha256:1111222233334444",
      profileId: "node",
      buildStatus: "ready",
      createdAt: "2026-10-15T00:00:00Z",
    },
    {
      id: "v-2",
      botId: "bot-test",
      versionNo: 2,
      sourceDigest: "sha256:5555666677778888",
      profileId: "node",
      buildStatus: "failed",
      createdAt: "2026-10-15T01:00:00Z",
    },
  ];

  beforeEach(() => {
    gateway = new ArenaApiGateway({ baseUrl: "http://127.0.0.1:8787/api/arena/v1" });
    runDraftSpy = vi.spyOn(gateway, "runDraft");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders ephemeral draft view by default with map selection and run button", () => {
    render(
      <DraftPreviewPanel
        gateway={gateway}
        botId="bot-test"
        currentSource="const a = 1;"
        currentProfileId="node"
        savedVersions={mockSavedVersions}
        availableProfiles={["node", "python"]}
      />
    );

    expect(screen.getByRole("region", { name: /Khung chạy thử nghiệm nháp bot/i })).toBeInTheDocument();
    expect(screen.getByTestId("draft-map-select")).toBeInTheDocument();
    expect(screen.getByTestId("btn-run-draft")).toBeEnabled();
    expect(screen.getByText(/Chế độ Sandbox/i)).toBeInTheDocument();
  });

  it("disables run button when source is empty", () => {
    render(
      <DraftPreviewPanel
        gateway={gateway}
        botId="bot-test"
        currentSource="   "
        currentProfileId="node"
        savedVersions={mockSavedVersions}
        availableProfiles={["node", "python"]}
      />
    );

    expect(screen.getByTestId("btn-run-draft")).toBeDisabled();
  });

  it("displays danger banner and disables run button when source exceeds 256 KiB", () => {
    const hugeSource = "x".repeat(262145);
    render(
      <DraftPreviewPanel
        gateway={gateway}
        botId="bot-test"
        currentSource={hugeSource}
        currentProfileId="node"
        savedVersions={mockSavedVersions}
        availableProfiles={["node", "python"]}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/vượt quá giới hạn tối đa cho phép/i);
    expect(screen.getByTestId("btn-run-draft")).toBeDisabled();
  });

  it("runs draft successfully and renders diagnostics including coordinates and next state", async () => {
    runDraftSpy.mockResolvedValueOnce({
      status: "success",
      isolation: "container",
      compile: { status: "ok", logs: "" },
      execution: {
        legal: true,
        move: { from: { x: 4, y: 7 }, to: { x: 4, y: 8 } },
        comment: "opening pawn push",
        elapsedMs: 34,
      },
      nextState: { turn: "B", pieces: [] },
    });

    render(
      <DraftPreviewPanel
        gateway={gateway}
        botId="bot-test"
        currentSource="console.log('hi');"
        currentProfileId="node"
        savedVersions={mockSavedVersions}
        availableProfiles={["node", "python"]}
      />
    );

    fireEvent.click(screen.getByTestId("btn-run-draft"));

    await waitFor(() => {
      expect(screen.getByTestId("draft-diagnostics-card")).toBeInTheDocument();
    });

    expect(runDraftSpy).toHaveBeenCalledWith(
      "bot-test",
      {
        source: "console.log('hi');",
        profileId: "node",
        mapId: "classic",
      },
      expect.any(Object)
    );

    expect(screen.getByText(/Nước đi hợp lệ/i)).toBeInTheDocument();
    expect(screen.getByText(/Cách ly: OCI Container/i)).toBeInTheDocument();
    expect(screen.getByText(/\(4, 7\) → \(4, 8\)/)).toBeInTheDocument();
    expect(screen.getByText(/34 ms/)).toBeInTheDocument();
    expect(screen.getByText(/"opening pawn push"/)).toBeInTheDocument();
    expect(screen.getByTestId("draft-next-state-summary")).toBeInTheDocument();
  });

  it("triggers draft execution via Ctrl+Enter keyboard shortcut", async () => {
    runDraftSpy.mockResolvedValueOnce({
      status: "success",
      isolation: "trusted-process",
      compile: { status: "ok", logs: "" },
      execution: { legal: true, elapsedMs: 12 },
    });

    render(
      <DraftPreviewPanel
        gateway={gateway}
        botId="bot-test"
        currentSource="const bot = {};"
        currentProfileId="node"
        savedVersions={mockSavedVersions}
        availableProfiles={["node", "python"]}
      />
    );

    const panel = screen.getByTestId("draft-preview-panel");
    fireEvent.keyDown(panel, { key: "Enter", ctrlKey: true });

    await waitFor(() => {
      expect(runDraftSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("displays compiler logs and error badge on compile_error status", async () => {
    runDraftSpy.mockResolvedValueOnce({
      status: "compile_error",
      isolation: "container",
      compile: {
        status: "failed",
        logs: "SyntaxError: Unexpected token ')'\n    at eval",
      },
    });

    render(
      <DraftPreviewPanel
        gateway={gateway}
        botId="bot-test"
        currentSource="broken syntax ))"
        currentProfileId="node"
        savedVersions={mockSavedVersions}
        availableProfiles={["node", "python"]}
      />
    );

    fireEvent.click(screen.getByTestId("btn-run-draft"));

    await waitFor(() => {
      expect(screen.getByTestId("draft-compile-logs")).toBeInTheDocument();
    });

    expect(screen.getByText(/Lỗi biên dịch \/ Cú pháp/i)).toBeInTheDocument();
    expect(screen.getByText(/SyntaxError: Unexpected token '\)'/)).toBeInTheDocument();
  });

  it("displays execution error banner when execution_error status is returned", async () => {
    runDraftSpy.mockResolvedValueOnce({
      status: "execution_error",
      isolation: "container",
      execution: {
        legal: false,
        error: "turn_timeout: bot did not respond within 1500ms",
      },
    });

    render(
      <DraftPreviewPanel
        gateway={gateway}
        botId="bot-test"
        currentSource="while(true){}"
        currentProfileId="node"
        savedVersions={mockSavedVersions}
        availableProfiles={["node", "python"]}
      />
    );

    fireEvent.click(screen.getByTestId("btn-run-draft"));

    await waitFor(() => {
      expect(screen.getByTestId("draft-execution-error")).toBeInTheDocument();
    });

    expect(screen.getByText(/turn_timeout: bot did not respond within 1500ms/)).toBeInTheDocument();
  });

  it("displays visible capability failure alert when 503 ISOLATION_UNAVAILABLE occurs", async () => {
    runDraftSpy.mockRejectedValueOnce(
      new ArenaApiError("Container isolation runtime is unavailable", {
        code: "ISOLATION_UNAVAILABLE",
        statusCode: 503,
      })
    );

    render(
      <DraftPreviewPanel
        gateway={gateway}
        botId="bot-test"
        currentSource="valid code"
        currentProfileId="node"
        savedVersions={mockSavedVersions}
        availableProfiles={["node", "python"]}
      />
    );

    fireEvent.click(screen.getByTestId("btn-run-draft"));

    await waitFor(() => {
      expect(screen.getByTestId("draft-error-banner")).toBeInTheDocument();
    });

    expect(screen.getByText(/Lỗi năng lực máy chủ/i)).toBeInTheDocument();
    expect(screen.getByText(/Container isolation runtime is unavailable/i)).toBeInTheDocument();
  });

  it("toggles between Ephemeral Draft and Saved Versions view", () => {
    render(
      <DraftPreviewPanel
        gateway={gateway}
        botId="bot-test"
        currentSource="valid code"
        currentProfileId="node"
        savedVersions={mockSavedVersions}
        availableProfiles={["node", "python"]}
      />
    );

    // Initial state: ephemeral
    expect(screen.getByTestId("btn-run-draft")).toBeInTheDocument();
    expect(screen.queryByTestId("saved-versions-view")).not.toBeInTheDocument();

    // Click saved versions toggle
    fireEvent.click(screen.getByTestId("toggle-mode-saved"));

    expect(screen.getByTestId("saved-versions-view")).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(screen.getByText("v2")).toBeInTheDocument();
    expect(screen.queryByTestId("btn-run-draft")).not.toBeInTheDocument();

    // Click back to ephemeral
    fireEvent.click(screen.getByTestId("toggle-mode-ephemeral"));
    expect(screen.getByTestId("btn-run-draft")).toBeInTheDocument();
  });

  it("surfaces trusted-mode security notice when container isolation is not present in capabilities", () => {
    render(
      <DraftPreviewPanel
        gateway={gateway}
        botId="bot-test"
        currentSource="valid code"
        currentProfileId="node"
        savedVersions={mockSavedVersions}
        availableProfiles={["node", "python"]}
        capabilities={{
          executor: "trusted-local-v1",
          trusted: true,
          untrusted: false,
          canSubmitSource: false,
          profiles: ["node", "python"],
        }}
      />
    );

    expect(screen.getByTestId("trusted-mode-notice")).toBeInTheDocument();
    expect(screen.getByTestId("trusted-mode-notice")).toHaveTextContent(
      /môi trường cách ly OCI container chưa kích hoạt/i
    );
  });

  it("accurately badges trusted-process isolation without claiming OCI container isolation", async () => {
    runDraftSpy.mockResolvedValueOnce({
      status: "success",
      isolation: "trusted-process",
      compile: { status: "ok", logs: "" },
      execution: { legal: true, elapsedMs: 15 },
    });

    render(
      <DraftPreviewPanel
        gateway={gateway}
        botId="bot-test"
        currentSource="valid code"
        currentProfileId="node"
        savedVersions={mockSavedVersions}
        availableProfiles={["node", "python"]}
      />
    );

    fireEvent.click(screen.getByTestId("btn-run-draft"));

    await waitFor(() => {
      expect(screen.getByTestId("draft-diagnostics-card")).toBeInTheDocument();
    });

    expect(
      screen.getByText(/Tiến trình nội bộ \(Trusted Process — không phải container OCI\)/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/Cách ly: OCI Container/i)).not.toBeInTheDocument();
  });

  it("handles result with status: 'unavailable' by displaying fail-closed alert", async () => {
    runDraftSpy.mockResolvedValueOnce({
      status: "unavailable",
      error: "Container isolation runtime is unavailable; draft execution requires a verified OCI container environment.",
    });

    render(
      <DraftPreviewPanel
        gateway={gateway}
        botId="bot-test"
        currentSource="valid code"
        currentProfileId="node"
        savedVersions={mockSavedVersions}
        availableProfiles={["node", "python"]}
      />
    );

    fireEvent.click(screen.getByTestId("btn-run-draft"));

    await waitFor(() => {
      expect(screen.getByTestId("draft-error-banner")).toBeInTheDocument();
    });

    expect(screen.getByText(/Lỗi năng lực máy chủ/i)).toBeInTheDocument();
    expect(screen.getByText(/Container isolation runtime is unavailable/i)).toBeInTheDocument();
  });
});
