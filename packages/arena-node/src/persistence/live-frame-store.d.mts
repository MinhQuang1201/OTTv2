/**
 * packages/arena-node/src/persistence/live-frame-store.d.mts
 */

import type { Database } from "better-sqlite3";

export interface LiveFrameRecord {
  ply: number;
  seat?: "A" | "B" | null;
  move?: object | null;
  clock?: object;
  state?: object;
  [key: string]: unknown;
}

export interface LiveFramesQueryResult {
  matchId: string;
  status: string;
  terminal: boolean;
  replayUrl?: string | null;
  attemptNo: number;
  afterPly: number;
  lastReturnedPly: number;
  currentPly: number;
  reset: boolean;
  frames: LiveFrameRecord[];
}

export interface LiveFrameStoreOptions {
  maxRetainedFramesPerMatch?: number;
}

export interface LiveFrameStore {
  recordFrame(params: {
    matchId: string;
    attemptNo: number;
    leaseToken?: string | null;
    ply: number;
    seat?: "A" | "B" | null;
    move?: object | null;
    frame: object;
  }): void;

  getLiveFrames(params: {
    matchId: string;
    afterPly?: number;
    attemptNo?: number | null;
    limit?: number;
  }): LiveFramesQueryResult | null;

  pruneLiveFrames(matchId: string): void;
}

export declare class FencedLiveFrameError extends Error {
  readonly code: string;
  constructor(message: string, code?: string);
}

export declare function createLiveFrameStore(
  db: Database,
  options?: LiveFrameStoreOptions
): LiveFrameStore;
