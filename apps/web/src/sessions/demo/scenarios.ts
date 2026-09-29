import type {
  DemoScenario,
  GameEventView,
  GameSnapshot,
  Position,
  Seat,
} from "../../shared/model/game";
import { freezeFixture, makeEvent, makePiece, makePlayer, makeSnapshot } from "./fixtureBuilders";

export const DEMO_SCENARIOS = Object.freeze([
  "lobby-default",
  "lobby-online-unavailable",
  "lobby-online-connecting",
  "lobby-rooms",
  "game-waiting",
  "game-active-a",
  "game-piece-selected",
  "game-move-rejected",
  "game-capture",
  "game-strike-loss",
  "game-ai-thinking",
  "game-reconnecting",
  "game-clock-warning",
  "game-recoverable-error",
  "result-goal",
  "result-elimination",
  "result-no-moves",
  "result-timeout",
  "result-disconnect-timeout",
  "result-leave",
  "spectator-list",
  "spectator-active",
  "spectator-reconnecting",
  "spectator-finished",
  "spectator-room-gone",
] as const);

export function isDemoScenario(value: unknown): value is DemoScenario {
  return typeof value === "string" && (DEMO_SCENARIOS as readonly string[]).includes(value);
}

export interface DemoMove {
  readonly from: Position;
  readonly to: Position;
  readonly eventType?: "move" | "capture" | "strike_loss";
}

export interface DemoScenarioFixture {
  readonly snapshot: GameSnapshot;
  readonly moves: readonly DemoMove[];
  readonly rejectMoves: readonly DemoMove[];
}

const A_SETUP = [
  ["la", 0, 2], ["dam", 1, 2], ["keo", 2, 2],
  ["dam", 0, 3], ["keo", 1, 3], ["la", 2, 3],
  ["keo", 0, 4], ["la", 1, 4], ["dam", 2, 4],
] as const;

const TYPES = ["dam", "la", "keo"] as const;

function canonicalBoard() {
  const counters: Record<Seat, Record<(typeof TYPES)[number], number>> = {
    A: { dam: 0, la: 0, keo: 0 },
    B: { dam: 0, la: 0, keo: 0 },
  };
  const pieces = [];
  for (const seat of ["A", "B"] as const) {
    for (const [type, x, y] of A_SETUP) {
      const pieceType = type as (typeof TYPES)[number];
      const ordinal = counters[seat][pieceType]++;
      pieces.push(makePiece(
        `${seat}-${pieceType}-${ordinal}`,
        seat,
        pieceType,
        seat === "A" ? { x, y } : { x: 8 - x, y: 8 - y },
      ));
    }
  }
  return pieces;
}

const CANONICAL_BOARD = canonicalBoard();

function pieceAt(position: Position) {
  return CANONICAL_BOARD.find((piece) => piece.position.x === position.x && piece.position.y === position.y);
}

function players(overrides: Partial<Record<Seat, Partial<Parameters<typeof makePlayer>[2]>>> = {}) {
  return {
    A: makePlayer("A", "An", overrides.A),
    B: makePlayer("B", "Bình", overrides.B),
  };
}

const MOVE: DemoMove = { from: { x: 0, y: 2 }, to: { x: 0, y: 1 } };
const REJECTED_MOVE: DemoMove = { from: { x: 0, y: 2 }, to: { x: 0, y: 1 } };

function eventFor(scenario: DemoScenario): GameEventView | null {
  if (scenario === "game-capture") {
    const attacker = pieceAt({ x: 1, y: 2 });
    const defender = pieceAt({ x: 6, y: 5 });
    return makeEvent({
      id: 1,
      type: "capture",
      pieceId: attacker?.id ?? "A-dam-0",
      capturedId: defender?.id ?? "B-la-1",
      from: { x: 1, y: 2 },
      to: { x: 6, y: 5 },
    });
  }
  if (scenario === "game-strike-loss") {
    const attacker = pieceAt({ x: 1, y: 2 });
    const defender = pieceAt({ x: 6, y: 5 });
    return makeEvent({
      id: 1,
      type: "strike_loss",
      pieceId: attacker?.id ?? "A-dam-0",
      byId: defender?.id ?? "B-la-1",
      from: { x: 1, y: 2 },
      to: { x: 6, y: 5 },
    });
  }
  const reasons: Record<DemoScenario, { winner: Seat; reason: "goal" | "elimination" | "no_moves" | "timeout" | "disconnect_timeout" | "leave" } | undefined> = {
    "lobby-default": undefined, "lobby-online-unavailable": undefined,
    "lobby-online-connecting": undefined, "lobby-rooms": undefined,
    "game-waiting": undefined, "game-active-a": undefined,
    "game-piece-selected": undefined, "game-move-rejected": undefined,
    "game-capture": undefined, "game-strike-loss": undefined,
    "game-ai-thinking": undefined, "game-reconnecting": undefined,
    "game-clock-warning": undefined, "game-recoverable-error": undefined,
    "result-goal": { winner: "A", reason: "goal" },
    "result-elimination": { winner: "A", reason: "elimination" },
    "result-no-moves": { winner: "B", reason: "no_moves" },
    "result-timeout": { winner: "B", reason: "timeout" },
    "result-disconnect-timeout": { winner: "B", reason: "disconnect_timeout" },
    "result-leave": { winner: "B", reason: "leave" },
    "spectator-list": undefined, "spectator-active": undefined,
    "spectator-reconnecting": undefined, "spectator-finished": { winner: "A", reason: "goal" },
    "spectator-room-gone": undefined,
  };
  const result = reasons[scenario];
  return result ? makeEvent({ id: 1, type: "win", ...result }) : null;
}

export function createScenarioFixture(scenario: DemoScenario): DemoScenarioFixture {
  if (!isDemoScenario(scenario)) throw new Error(`Unknown demo scenario: ${String(scenario)}`);
  const isLobby = scenario.startsWith("lobby-");
  const isResult = scenario.startsWith("result-");
  const isSpectator = scenario.startsWith("spectator-");
  const isSpectatorList = scenario === "spectator-list";
  const isSpectatorFinished = scenario === "spectator-finished";
  const isRoomGone = scenario === "spectator-room-gone";
  const event = eventFor(scenario);
  const result = isSpectatorFinished
    ? { winner: "A" as const, reason: "goal" as const }
    : event?.type === "win" ? { winner: event.winner, reason: event.reason } : null;
  const warning = scenario === "game-clock-warning";
  const reconnecting = scenario === "game-reconnecting" || scenario === "spectator-reconnecting";
  const error = scenario === "lobby-online-unavailable"
    ? { code: "online_unavailable" as const, message: "Chơi online hiện không khả dụng.", retryable: false }
    : scenario === "game-recoverable-error"
      ? { code: "session_failed" as const, message: "Không thể đồng bộ ván đấu.", retryable: true }
      : isRoomGone
        ? { code: "room_unavailable" as const, message: "Trận đấu không còn khả dụng", retryable: false }
      : null;
  const waitingRooms = scenario === "lobby-rooms"
    ? [
        { roomId: "DEMO-17", hostName: "Chi", playerCount: 1, maxPlayers: 2 },
        { roomId: "DEMO-23", hostName: "Dũng", playerCount: 1, maxPlayers: 2 },
      ]
    : [];
  const snapshot = makeSnapshot({
    mode: "demo",
    phase: isRoomGone ? "error" : isResult || isSpectatorFinished ? "finished" : isLobby || isSpectatorList ? (scenario === "lobby-online-connecting" ? "preparing" : "idle") : scenario === "game-waiting" ? "waiting" : scenario === "game-recoverable-error" ? "error" : "playing",
    boardRevision: isResult || isSpectatorFinished ? 2 : isLobby || isSpectatorList || scenario === "game-waiting" ? 0 : 1,
    viewer: isSpectator ? { role: "spectator" } : undefined,
    viewerSeat: isSpectator ? null : isLobby || isSpectatorList || isRoomGone ? null : "A",
    capabilities: isSpectator ? { canMove: false, canLeaveGame: false, canSpectate: true } : undefined,
    spectatorCount: isSpectator ? 12 : 0,
    turn: isLobby || isSpectatorList || scenario === "game-waiting" || isResult || isSpectatorFinished || isRoomGone ? null : "A",
    board: CANONICAL_BOARD,
    players: players({
      A: { remainingMs: warning ? 35_000 : 10 * 60 * 1000 },
      B: { connected: !reconnecting },
    }),
    connection: scenario === "lobby-online-unavailable" ? "unavailable" : scenario === "lobby-online-connecting" ? "connecting" : isRoomGone ? "unavailable" : reconnecting ? "reconnecting" : "online",
    pendingMove: false,
    aiThinking: scenario === "game-ai-thinking",
    roomId: isLobby || isSpectatorList || isRoomGone ? null : "DEMO-42",
    waitingRooms,
    publicMatches: isSpectatorList ? [{
      allocationId: "DEMO-ALLOCATION-42",
      roomId: "DEMO-42",
      status: "playing",
      players: {
        A: { seat: "A", name: "An", connected: true, remainingMs: 540_000 },
        B: { seat: "B", name: "Bình", connected: true, remainingMs: 510_000 },
      },
      spectatorCount: 12,
      serverNow: 1_790_000_000_000,
      runningSeat: "A",
    }] : [],
    result,
    events: event ? [event] : [],
    error,
  });
  return freezeFixture({
    snapshot,
    moves: isLobby || isResult || isSpectator || scenario === "game-waiting"
      ? []
      : scenario === "game-move-rejected"
        ? [REJECTED_MOVE]
        : scenario === "game-capture"
          ? [{ from: { x: 1, y: 2 }, to: { x: 6, y: 5 }, eventType: "capture" }]
          : scenario === "game-strike-loss"
            ? [{ from: { x: 1, y: 2 }, to: { x: 6, y: 5 }, eventType: "strike_loss" }]
            : [MOVE],
    rejectMoves: scenario === "game-move-rejected" ? [REJECTED_MOVE] : [],
  });
}
