import type {
  DemoScenario,
  GameEventView,
  GameSession,
  GameSnapshot,
  MoveResult,
  Position,
  Seat,
  StartGameOptions,
} from "../contract";
import { makeEvent, makeSnapshot } from "./fixtureBuilders";
import { createScenarioFixture, DEMO_SCENARIOS, type DemoMove } from "./scenarios";

const samePosition = (a: Position, b: Position) => a.x === b.x && a.y === b.y;
const sameMove = (a: DemoMove, from: Position, to: Position) => samePosition(a.from, from) && samePosition(a.to, to);

export class DemoSession implements GameSession {
  private snapshot: GameSnapshot;
  private scenario: DemoScenario;
  private nextEventId: number;
  private readonly listeners = new Set<() => void>();
  private disposed = false;
  private allowedMoves: readonly DemoMove[];

  constructor(scenario: DemoScenario) {
    if (!DEMO_SCENARIOS.includes(scenario)) throw new Error(`Unknown demo scenario: ${scenario}`);
    this.scenario = scenario;
    const fixture = createScenarioFixture(scenario);
    this.snapshot = fixture.snapshot;
    this.allowedMoves = fixture.moves;
    this.nextEventId = Math.max(0, ...this.snapshot.events.map((event) => event.id)) + 1;
  }

  getSnapshot(): GameSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(options: StartGameOptions): Promise<void> {
    if (this.disposed || options.mode !== "demo") return;
    if (options.scenario === this.scenario) return;
    const fixture = createScenarioFixture(options.scenario);
    const events = fixture.snapshot.events.map((event) => this.withNextEventId(event));
    this.scenario = options.scenario;
    this.allowedMoves = fixture.moves;
    this.snapshot = makeSnapshot({ ...fixture.snapshot, events });
    this.publish();
  }

  getLegalMoves(from: Position): readonly Position[] {
    return this.allowedMoves.filter((move) => samePosition(move.from, from)).map((move) => ({ ...move.to }));
  }

  async move(from: Position, to: Position): Promise<MoveResult> {
    if (this.disposed) return { accepted: false, error: { code: "session_failed", message: "Phiên chơi đã kết thúc.", retryable: false } };
    const rejected = createScenarioFixture(this.scenario).rejectMoves.some((move) => sameMove(move, from, to));
    const moveDefinition = this.allowedMoves.find((move) => sameMove(move, from, to));
    if (rejected || !moveDefinition) {
      return { accepted: false, error: { code: "invalid_move", message: "Nước đi không hợp lệ.", retryable: false } };
    }
    const piece = this.snapshot.board.find(({ position }) => samePosition(position, from));
    if (!piece) return { accepted: false, error: { code: "invalid_input", message: "Không tìm thấy quân cờ.", retryable: false } };
    const event = this.eventForMove(moveDefinition, piece.id);
    const board = this.snapshot.board.map((candidate) => candidate.id === piece.id
      ? { ...candidate, position: { ...to } }
      : candidate);
    const nextBoard = moveDefinition.eventType === "capture"
      ? board.filter((candidate) => candidate.id !== "B-la-1")
      : board;
    const nextTurn: Seat | null = this.snapshot.turn === "A" ? "B" : "A";
    this.snapshot = makeSnapshot({
      ...this.snapshot,
      board: nextBoard,
      turn: nextTurn,
      pendingMove: false,
      boardRevision: this.snapshot.boardRevision + 1,
      events: [...this.snapshot.events, event],
    });
    this.nextEventId = event.id + 1;
    this.publish();
    return { accepted: true };
  }

  async leave(): Promise<void> {
    if (this.disposed || this.snapshot.result) return;
    const event = makeEvent({ id: this.nextEventId++, type: "win", winner: "B", reason: "leave" });
    this.snapshot = makeSnapshot({
      ...this.snapshot,
      phase: "finished",
      turn: null,
      result: { winner: "B", reason: "leave" },
      boardRevision: this.snapshot.boardRevision + 1,
      events: [...this.snapshot.events, event],
    });
    this.publish();
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private eventForMove(move: DemoMove, pieceId: string): GameEventView {
    const id = this.nextEventId++;
    if (move.eventType === "capture") {
      return makeEvent({ id, type: "capture", pieceId, capturedId: "B-la-1", from: move.from, to: move.to });
    }
    if (move.eventType === "strike_loss") {
      return makeEvent({ id, type: "strike_loss", pieceId, byId: "B-la-1", from: move.from, to: move.to });
    }
    return makeEvent({ id, type: "move", pieceId, from: move.from, to: move.to });
  }

  private withNextEventId(event: GameEventView): GameEventView {
    return makeEvent({ ...event, id: this.nextEventId++ } as GameEventView);
  }

  private publish(): void {
    if (this.disposed) return;
    for (const listener of [...this.listeners]) listener();
  }
}
