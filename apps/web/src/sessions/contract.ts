import type { AiLevel } from "../shared/model/aiLevel";
import type {
  DemoScenario,
  GameSnapshot,
  Position,
  Seat,
  SessionErrorView,
} from "../shared/model/game";
import type { PlayhtmlSpectatorAllocation } from "./online/globals";

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
  PublicMatchView,
  ResultReason,
  Seat,
  SessionErrorCode,
  SessionErrorView,
  SessionMode,
  SessionPhase,
  ViewerCapabilities,
  ViewerIdentity,
  WaitingRoomView,
} from "../shared/model/game";
import type {
  AcceptedMoveRecord,
  ArenaMatchResult,
  ReplayDocument,
  ReplayFrame,
  ReplayParticipant,
} from "../../../../packages/arena/src/contracts/index.d.mts";

export type {
  AcceptedMoveRecord,
  ArenaMatchResult,
  CoreState,
  ReplayDocument,
  ReplayFrame,
  ReplayParticipant,
} from "../../../../packages/arena/src/contracts/index.d.mts";

export interface PracticeStart {
  readonly practiceId: string;
  readonly parentMatchId: string;
  readonly parentPly: number;
  readonly rulesetId: string;
  readonly rulesetHash: string;
  readonly engineRevision: string;
  readonly coreState: import("../../../../packages/arena/src/contracts/index.d.mts").CoreState;
}

export type ReplaySpeed = 0.5 | 1 | 2 | 4;

export interface ReplayPlaybackView {
  readonly cursor: number;
  readonly maxCursor: number;
  readonly isPlaying: boolean;
  readonly speed: ReplaySpeed;
  readonly result: ArenaMatchResult | null;
  readonly isAtStart: boolean;
  readonly isAtEnd: boolean;
  readonly currentPly: number;
  readonly totalPlies: number;
  readonly lastMove: AcceptedMoveRecord | null;
  readonly participants?: Record<Seat, ReplayParticipant>;
}

export interface ReplayPlaybackFacade {
  getPlayback(): ReplayPlaybackView;
  seek(cursor: number): void;
  play(): void;
  pause(): void;
  step(direction?: number | "next" | "prev"): void;
  setSpeed(speed: ReplaySpeed): void;
}

export type StartGameOptions =
  | { readonly mode: "demo"; readonly scenario: DemoScenario }
  | { readonly mode: "local"; readonly playerNames: readonly [string, string]; readonly practice?: PracticeStart }
  | { readonly mode: "ai"; readonly playerName: string; readonly humanSeat?: Seat; readonly level?: AiLevel; readonly practice?: PracticeStart }
  | { readonly mode: "online"; readonly intent: "create"; readonly playerName: string }
  | {
      readonly mode: "online";
      readonly intent: "join";
      readonly playerName: string;
      readonly roomId: string;
    }
  | {
      /** Re-enter an unfinished game saved by the previous page load. */
      readonly mode: "online";
      readonly intent: "resume";
      readonly playerName: string;
      readonly allocationId: string;
      readonly resumeCredential: string;
    }
  | {
      readonly mode: "spectator";
      readonly allocation: PlayhtmlSpectatorAllocation;
    }
  | {
      readonly mode: "replay";
      readonly document: ReplayDocument;
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
  dispose(): Promise<void> | void;
}
