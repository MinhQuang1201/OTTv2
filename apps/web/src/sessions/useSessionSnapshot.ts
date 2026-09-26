import { useMemo, useSyncExternalStore } from "react";

import type { GameSnapshot } from "../shared/model/game";
import type { GameSession } from "./contract";

const EMPTY_SNAPSHOT: GameSnapshot = {
  mode: "local",
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
  result: null,
  events: [],
  error: null,
};

const noopSubscribe = (_listener: () => void): (() => void) => () => undefined;
const emptySnapshot = (): GameSnapshot => EMPTY_SNAPSHOT;

export function useSessionSnapshot(session: GameSession | null): GameSnapshot {
  const subscribe = useMemo(
    () => (session ? session.subscribe.bind(session) : noopSubscribe),
    [session],
  );
  const getSnapshot = useMemo(
    () => (session ? session.getSnapshot.bind(session) : emptySnapshot),
    [session],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
