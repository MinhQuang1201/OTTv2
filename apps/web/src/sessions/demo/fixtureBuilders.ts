import type {
  GameEventView,
  GameSnapshot,
  PieceType,
  PieceView,
  PlayerView,
  Position,
  Seat,
} from "../../shared/model/game";

/** Freeze fixture graphs so a component cannot accidentally mutate demo state. */
export function freezeFixture<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeFixture(child);
    }
    Object.freeze(value);
  } else if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeFixture(child);
    }
  }
  return value;
}

export function makePiece(piece: PieceView): PieceView;
export function makePiece(id: string, seat: Seat, type: PieceType, position: Position): PieceView;
export function makePiece(
  pieceOrId: PieceView | string,
  seat?: Seat,
  type?: PieceType,
  position?: Position,
): PieceView {
  const piece = typeof pieceOrId === "string"
    ? { id: pieceOrId, seat: seat as Seat, type: type as PieceType, position: position as Position }
    : pieceOrId;
  return freezeFixture({
    id: piece.id,
    seat: piece.seat,
    type: piece.type,
    position: freezeFixture({ ...piece.position }),
  });
}

export function makePlayer(player: PlayerView): PlayerView;
export function makePlayer(
  seat: Seat,
  name?: string,
  overrides?: Partial<Omit<PlayerView, "seat" | "name">>,
): PlayerView;
export function makePlayer(
  playerOrSeat: PlayerView | Seat,
  name?: string,
  overrides: Partial<Omit<PlayerView, "seat" | "name">> = {},
): PlayerView {
  const playerSeat = typeof playerOrSeat === "string" ? playerOrSeat : playerOrSeat.seat;
  const playerName = typeof playerOrSeat === "string"
    ? name ?? (playerSeat === "A" ? "Người chơi Đỏ" : "Người chơi Xanh")
    : playerOrSeat.name;
  const playerOverrides = typeof playerOrSeat === "string" ? overrides : playerOrSeat;
  return freezeFixture({
    seat: playerSeat,
    name: playerName,
    connected: true,
    remainingMs: 10 * 60 * 1000,
    counts: { dam: 3, la: 3, keo: 3 },
    ...playerOverrides,
  });
}

export function makeEvent<T extends GameEventView>(event: T): T {
  return freezeFixture({ ...event } as T);
}

const emptySnapshot: GameSnapshot = {
  mode: "demo",
  phase: "idle",
  boardRevision: 0,
  viewerSeat: null,
  turn: null,
  board: [],
  players: {},
  connection: "offline",
  pendingMove: false,
  aiThinking: false,
  roomId: null,
  waitingRooms: [],
  result: null,
  events: [],
  error: null,
};

export function makeSnapshot(overrides: Partial<GameSnapshot> = {}): GameSnapshot {
  return freezeFixture({
    ...emptySnapshot,
    ...overrides,
    board: overrides.board ?? emptySnapshot.board,
    players: overrides.players ?? emptySnapshot.players,
    events: overrides.events ?? emptySnapshot.events,
  });
}
