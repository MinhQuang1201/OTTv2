// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplaySession } from "../../sessions/replay/ReplaySession";
import { ReplayScreen } from "./ReplayScreen";
import deterministicFixture from "../../../../../tests/fixtures/arena/replays/deterministic-match.json";
import forfeitFixture from "../../../../../tests/fixtures/arena/replays/forfeit-ply0.json";
import type { ReplayDocument } from "../../../../../packages/arena/src/contracts/index.d.mts";

describe("ReplayScreen", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  async function createStartedSession(fixture: unknown) {
    const session = new ReplaySession();
    await session.start({ mode: "replay", document: fixture as ReplayDocument });
    return session;
  }

  it("renders all 81 accessible board cells reusing the existing Board component", async () => {
    const session = await createStartedSession(deterministicFixture);
    const onLobby = vi.fn();

    render(<ReplayScreen session={session} snapshot={session.getSnapshot()} onLobby={onLobby} />);

    // Exactly 81 board cells coordinate-aware
    const cells = screen.getAllByRole("button", { name: /^Ô /i });
    expect(cells).toHaveLength(81);
    // Board is read-only
    expect(cells.every((cell) => (cell as HTMLButtonElement).disabled)).toBe(true);
  });

  it("renders timeline controls with accessible slider aria-valuetext 'Nước k trên N'", async () => {
    const session = await createStartedSession(deterministicFixture);
    render(<ReplayScreen session={session} snapshot={session.getSnapshot()} onLobby={vi.fn()} />);

    const slider = screen.getByRole("slider", { name: /thời gian|nước đi/i });
    expect(slider).toBeInTheDocument();
    expect(slider).toHaveAttribute("aria-valuetext", "Nước 0 trên 19");
    expect(slider).toHaveAttribute("min", "0");
    expect(slider).toHaveAttribute("max", "19");
    expect(slider).toHaveAttribute("aria-valuenow", "0");

    expect(screen.getByRole("button", { name: /phát/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /lùi/i })).toBeDisabled(); // at start
    expect(screen.getByRole("button", { name: /tiến/i })).not.toBeDisabled();
  });

  it("seeking the timeline updates the cursor, board, and accessible slider value", async () => {
    const session = await createStartedSession(deterministicFixture);
    render(<ReplayScreen session={session} snapshot={session.getSnapshot()} onLobby={vi.fn()} />);

    const slider = screen.getByRole("slider", { name: /thời gian|nước đi/i });
    fireEvent.change(slider, { target: { value: "5" } });

    expect(slider).toHaveAttribute("aria-valuetext", "Nước 5 trên 19");
    expect(slider).toHaveAttribute("aria-valuenow", "5");
    expect(session.getPlayback().cursor).toBe(5);
  });

  it("stepping forward and backward increments and decrements the cursor", async () => {
    const user = userEvent.setup();
    const session = await createStartedSession(deterministicFixture);
    render(<ReplayScreen session={session} snapshot={session.getSnapshot()} onLobby={vi.fn()} />);

    const nextBtn = screen.getByRole("button", { name: /tiến/i });
    await user.click(nextBtn);

    expect(session.getPlayback().cursor).toBe(1);
    const slider = screen.getByRole("slider", { name: /thời gian|nước đi/i });
    expect(slider).toHaveAttribute("aria-valuetext", "Nước 1 trên 19");

    const prevBtn = screen.getByRole("button", { name: /lùi/i });
    expect(prevBtn).not.toBeDisabled();
    await user.click(prevBtn);

    expect(session.getPlayback().cursor).toBe(0);
  });

  it("adjusts playback speed when speed buttons are clicked", async () => {
    const user = userEvent.setup();
    const session = await createStartedSession(deterministicFixture);
    render(<ReplayScreen session={session} snapshot={session.getSnapshot()} onLobby={vi.fn()} />);

    const speed2x = screen.getByRole("button", { name: /2x/i });
    await user.click(speed2x);

    expect(session.getPlayback().speed).toBe(2);
    expect(speed2x).toHaveAttribute("aria-pressed", "true");
  });

  it("displays ArenaResultSummary at terminal cursor and removes it when seeking back", async () => {
    const session = await createStartedSession(deterministicFixture);
    render(<ReplayScreen session={session} snapshot={session.getSnapshot()} onLobby={vi.fn()} />);

    // Initially at ply 0 (non-terminal) -> summary overlay is not present
    expect(screen.queryByRole("region", { name: /kết quả trận đấu/i })).not.toBeInTheDocument();

    // Seek to terminal ply 19
    const slider = screen.getByRole("slider", { name: /thời gian|nước đi/i });
    fireEvent.change(slider, { target: { value: "19" } });

    // Terminal summary overlay appears
    const summary = screen.getByRole("region", { name: /kết quả trận đấu/i });
    expect(summary).toBeInTheDocument();
    expect(summary).toHaveTextContent(/thắng/i);
    expect(summary).toHaveTextContent(/19/);

    // Seeking back removes overlay
    fireEvent.change(slider, { target: { value: "18" } });
    expect(screen.queryByRole("region", { name: /kết quả trận đấu/i })).not.toBeInTheDocument();
  });

  it("handles ply 0 forfeit replay correctly showing forfeit summary", async () => {
    const session = await createStartedSession(forfeitFixture);
    render(<ReplayScreen session={session} snapshot={session.getSnapshot()} onLobby={vi.fn()} />);

    const slider = screen.getByRole("slider", { name: /thời gian|nước đi/i });
    expect(slider).toHaveAttribute("aria-valuetext", "Nước 0 trên 0");

    // At ply 0 terminal forfeit -> summary overlay is present immediately
    const summary = screen.getByRole("region", { name: /kết quả trận đấu/i });
    expect(summary).toBeInTheDocument();
    expect(summary).toHaveTextContent(/xử thua|bỏ cuộc|thua/i);
  });

  it("calls onLobby when the lobby button is clicked", async () => {
    const user = userEvent.setup();
    const session = await createStartedSession(deterministicFixture);
    const onLobby = vi.fn();
    render(<ReplayScreen session={session} snapshot={session.getSnapshot()} onLobby={onLobby} />);

    const lobbyBtn = screen.getByRole("button", { name: /về sảnh|sảnh/i });
    await user.click(lobbyBtn);
    expect(onLobby).toHaveBeenCalledTimes(1);
  });

  it("offers download of the original finalized replay document", async () => {
    const user = userEvent.setup();
    const session = await createStartedSession(deterministicFixture);
    const createObjectURL = vi.fn().mockReturnValue("blob:mock-url");
    const revokeObjectURL = vi.fn();
    window.URL.createObjectURL = createObjectURL;
    window.URL.revokeObjectURL = revokeObjectURL;

    render(<ReplayScreen session={session} snapshot={session.getSnapshot()} onLobby={vi.fn()} />);

    const exportBtn = screen.getByTestId("replay-export-btn");
    expect(exportBtn).toBeInTheDocument();
    await user.click(exportBtn);

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it("displays matchId, rulesetId, engineRevision, and participant bot version and profile in metadata", async () => {
    const fixtureWithVersions: ReplayDocument = {
      ...deterministicFixture as unknown as ReplayDocument,
      matchId: "match-spec-999",
      rulesetId: "ottv2-g-default-v1",
      engineRevision: "sha256:engine-v1.2.3",
      participants: {
        A: { botId: "bot-alpha", name: "AlphaBot", botVersionId: "1.0.4", profileId: "aggressive" },
        B: { botId: "bot-beta", name: "BetaBot", botVersionId: "2.1.0", profileId: "defensive" },
      },
    };
    const session = await createStartedSession(fixtureWithVersions);
    render(<ReplayScreen session={session} snapshot={session.getSnapshot()} onLobby={vi.fn()} />);

    expect(screen.getByText("match-spec-999")).toBeInTheDocument();
    expect(screen.getByText("ottv2-g-default-v1")).toBeInTheDocument();
    expect(screen.getByText("sha256:engine-v1.2.3")).toBeInTheDocument();
    expect(screen.getByText(/AlphaBot.*1\.0\.4.*aggressive/i)).toBeInTheDocument();
    expect(screen.getByText(/BetaBot.*2\.1\.0.*defensive/i)).toBeInTheDocument();
  });

  it("renders enabled fork practice controls at mid-game and invokes onForkPractice callback", async () => {
    const user = userEvent.setup();
    const fixtureWithCurrentEngine = {
      ...deterministicFixture,
      engineRevision: "sha256:d9cec0298cf11aba83a986223446ad220ec2c390a2b4e63906b4218681a5d164",
    };
    const session = await createStartedSession(fixtureWithCurrentEngine);
    session.seek(5);
    const onForkPractice = vi.fn();

    render(
      <ReplayScreen
        session={session}
        snapshot={session.getSnapshot()}
        onLobby={vi.fn()}
        onForkPractice={onForkPractice}
      />
    );

    const forkLocalBtn = screen.getByTestId("replay-fork-local-btn");
    const forkAiBtn = screen.getByTestId("replay-fork-ai-btn");

    expect(forkLocalBtn).toBeEnabled();
    expect(forkAiBtn).toBeEnabled();

    await user.click(forkAiBtn);
    expect(onForkPractice).toHaveBeenCalledTimes(1);
    expect(onForkPractice).toHaveBeenCalledWith("ai", expect.objectContaining({
      parentMatchId: "match-det-001",
      parentPly: 5,
      engineRevision: "sha256:d9cec0298cf11aba83a986223446ad220ec2c390a2b4e63906b4218681a5d164",
      coreState: expect.objectContaining({ turn: "B" }),
    }));

    await user.click(forkLocalBtn);
    expect(onForkPractice).toHaveBeenCalledTimes(2);
    expect(onForkPractice).toHaveBeenCalledWith("local", expect.objectContaining({
      parentMatchId: "match-det-001",
      parentPly: 5,
    }));
  });

  it("disables fork practice controls at terminal ply or when engineRevision is unsupported", async () => {
    // 1. Unsupported engine revision (default deterministicFixture has test-engine-rev)
    const sessionUnsupported = await createStartedSession(deterministicFixture);
    sessionUnsupported.seek(5);
    const { rerender } = render(
      <ReplayScreen
        session={sessionUnsupported}
        snapshot={sessionUnsupported.getSnapshot()}
        onLobby={vi.fn()}
        onForkPractice={vi.fn()}
      />
    );
    expect(screen.getByTestId("replay-fork-ai-btn")).toBeDisabled();
    expect(screen.getByTestId("replay-fork-local-btn")).toBeDisabled();

    // 2. Terminal ply with supported engine
    const fixtureWithCurrentEngine = {
      ...deterministicFixture,
      engineRevision: "sha256:d9cec0298cf11aba83a986223446ad220ec2c390a2b4e63906b4218681a5d164",
    };
    const sessionTerminal = await createStartedSession(fixtureWithCurrentEngine);
    sessionTerminal.seek(19); // terminal goal win ply

    rerender(
      <ReplayScreen
        session={sessionTerminal}
        snapshot={sessionTerminal.getSnapshot()}
        onLobby={vi.fn()}
        onForkPractice={vi.fn()}
      />
    );
    expect(screen.getByTestId("replay-fork-ai-btn")).toBeDisabled();
    expect(screen.getByTestId("replay-fork-local-btn")).toBeDisabled();
  });

  it("preserves original document against deep practice mutations", async () => {
    const user = userEvent.setup();
    const fixtureWithCurrentEngine = {
      ...deterministicFixture,
      engineRevision: "sha256:d9cec0298cf11aba83a986223446ad220ec2c390a2b4e63906b4218681a5d164",
    };
    const session = await createStartedSession(fixtureWithCurrentEngine);
    session.seek(5);
    let capturedPractice: any = null;
    const onForkPractice = vi.fn((_mode, practice) => {
      capturedPractice = practice;
    });

    render(
      <ReplayScreen
        session={session}
        snapshot={session.getSnapshot()}
        onLobby={vi.fn()}
        onForkPractice={onForkPractice}
      />
    );

    const forkLocalBtn = screen.getByTestId("replay-fork-local-btn");
    await user.click(forkLocalBtn);
    expect(capturedPractice).not.toBeNull();

    // Mutate practice core state
    capturedPractice.coreState.pieces.length = 0;
    capturedPractice.coreState.clock.remainingMs.A = 12345;
    capturedPractice.coreState.winner = "A";

    // Original session document remains completely intact
    const docAfter = session.getDocument();
    expect(docAfter?.frames[5].coreState.pieces.length).toBe(
      deterministicFixture.frames[5].coreState.pieces.length
    );
    expect(docAfter?.frames[5].coreState.clock.remainingMs.A).toBe(
      deterministicFixture.frames[5].coreState.clock.remainingMs.A
    );
    expect(docAfter?.result.winner).toBe(deterministicFixture.result.winner);
  });
});
