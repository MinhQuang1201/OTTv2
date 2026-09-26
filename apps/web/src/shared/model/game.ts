/** The two player seats in a game. */
export type Seat = "A" | "B";

/** Canonical piece kinds used by the game rules. */
export type PieceType = "dam" | "la" | "keo";

/** A zero-based position on the 9x9 board. */
export interface Position {
  readonly x: number;
  readonly y: number;
}

export interface PieceView {
  readonly id: string;
  readonly seat: Seat;
  readonly type: PieceType;
  readonly position: Position;
}

export interface PlayerView {
  readonly seat: Seat;
  readonly name: string;
  readonly connected: boolean;
  readonly remainingMs: number;
  readonly counts: Readonly<Record<PieceType, number>>;
}

export type ResultReason =
  | "goal"
  | "elimination"
  | "no_moves"
  | "timeout"
  | "disconnect_timeout"
  | "leave";

export interface GameResultView {
  readonly winner: Seat | null;
  readonly reason: ResultReason;
}

export type SessionMode = "demo" | "local" | "ai" | "online";

export type SessionPhase =
  | "idle"
  | "preparing"
  | "waiting"
  | "playing"
  | "finished"
  | "error";

export type ConnectionState =
  | "offline"
  | "connecting"
  | "online"
  | "reconnecting"
  | "unavailable";

export type GameEventView =
  | {
      readonly id: number;
      readonly type: "move";
      readonly pieceId: string;
      readonly from: Position;
      readonly to: Position;
    }
  | {
      readonly id: number;
      readonly type: "capture";
      readonly pieceId: string;
      readonly capturedId: string;
      readonly from: Position;
      readonly to: Position;
    }
  | {
      readonly id: number;
      readonly type: "strike_loss";
      readonly pieceId: string;
      readonly byId: string;
      readonly from: Position;
      readonly to: Position;
    }
  | {
      readonly id: number;
      readonly type: "win";
      readonly winner: Seat;
      readonly reason: ResultReason;
    };

export type SessionErrorCode =
  | "invalid_input"
  | "invalid_move"
  | "online_unavailable"
  | "connection_failed"
  | "reconnect_failed"
  | "room_unavailable"
  | "session_failed";

export interface SessionErrorView {
  readonly code: SessionErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export interface WaitingRoomView {
  readonly roomId: string;
  readonly hostName: string;
  readonly playerCount: number;
  readonly maxPlayers: number;
}

/** A scenario key used by the development-only deterministic demo session. */
export type DemoScenario =
  | "lobby-default"
  | "lobby-online-unavailable"
  | "lobby-online-connecting"
  | "lobby-rooms"
  | "game-waiting"
  | "game-active-a"
  | "game-piece-selected"
  | "game-move-rejected"
  | "game-capture"
  | "game-strike-loss"
  | "game-ai-thinking"
  | "game-reconnecting"
  | "game-clock-warning"
  | "game-recoverable-error"
  | "result-goal"
  | "result-elimination"
  | "result-no-moves"
  | "result-timeout"
  | "result-disconnect-timeout"
  | "result-leave";

export interface GameSnapshot {
  readonly mode: SessionMode;
  readonly phase: SessionPhase;
  /** Increments only when board occupancy, turn, or terminal state changes. */
  readonly boardRevision: number;
  readonly viewerSeat: Seat | null;
  readonly turn: Seat | null;
  readonly board: readonly PieceView[];
  readonly players: Partial<Record<Seat, PlayerView>>;
  readonly connection: ConnectionState;
  readonly pendingMove: boolean;
  readonly aiThinking: boolean;
  readonly roomId: string | null;
  readonly waitingRooms?: readonly WaitingRoomView[];
  readonly result: GameResultView | null;
  readonly events: readonly GameEventView[];
  readonly error: SessionErrorView | null;
}
