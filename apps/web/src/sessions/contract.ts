import type {
  DemoScenario,
  GameSnapshot,
  Position,
  Seat,
  SessionErrorView,
} from "../shared/model/game";

export type {
  ConnectionState,
  DemoScenario,
  GameEventView,
  GameResultView,
  GameSnapshot,
  PieceType,
  PieceView,
  PlayerView,
  Position,
  ResultReason,
  Seat,
  SessionErrorCode,
  SessionErrorView,
  SessionMode,
  SessionPhase,
} from "../shared/model/game";

export type StartGameOptions =
  | { readonly mode: "demo"; readonly scenario: DemoScenario }
  | { readonly mode: "local"; readonly playerNames: readonly [string, string] }
  | { readonly mode: "ai"; readonly playerName: string; readonly humanSeat?: Seat }
  | { readonly mode: "online"; readonly intent: "create"; readonly playerName: string }
  | {
      readonly mode: "online";
      readonly intent: "join";
      readonly playerName: string;
      readonly roomId: string;
    };

export type MoveResult =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly error: SessionErrorView };

export interface GameSession {
  getSnapshot(): GameSnapshot;
  subscribe(listener: () => void): () => void;
  start(options: StartGameOptions): Promise<void>;
  getLegalMoves(from: Position): readonly Position[];
  move(from: Position, to: Position): Promise<MoveResult>;
  leave(): Promise<void>;
  dispose(): void;
}
