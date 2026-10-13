import type { JournalPort } from "../ports/index.d.mts";
import type {
  ReplayInit,
  AcceptedMoveInput,
  TechnicalEventInput,
  ArenaMatchResult,
  CoreState,
  ReplayDocument
} from "../contracts/index.d.mts";

export interface ReplayJournalInstance extends JournalPort {
  getDocument(): ReplayDocument | null;
}

export declare function createReplayJournal(): ReplayJournalInstance;

export declare class ReplayJournal implements ReplayJournalInstance {
  init(input: ReplayInit): void;
  acceptedMove(input: AcceptedMoveInput): void;
  technicalEvent(input: TechnicalEventInput): void;
  finish(result: ArenaMatchResult, terminalState: CoreState): ReplayDocument;
  getDocument(): ReplayDocument | null;
}
