import { Suspense, lazy, useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { DemoScenario, GameSession, GameResultView, GameSnapshot, PracticeStart, SessionErrorView, StartGameOptions } from "../sessions/contract";
import { DemoSession } from "../sessions/demo/DemoSession";
import { useSessionSnapshot } from "../sessions/useSessionSnapshot";
import { ScenarioSwitcher } from "../demo/ScenarioSwitcher";
import { DEFAULT_DEMO_SCENARIO, isDemoScenario, useDemoScenario } from "../demo/useDemoScenario";
import { Panel } from "../shared/ui/Panel";
import { Spinner } from "../shared/ui/Spinner";
import { Button } from "../shared/ui/Button";
import { LobbyScreen } from "../features/lobby/LobbyScreen";
import { GameScreen } from "../features/game/GameScreen";
import { LocalSession } from "../sessions/local/LocalSession";
import { AiSession } from "../sessions/ai/AiSession";
import { DEFAULT_AI_LEVEL, type AiLevel } from "../shared/model/aiLevel";
import { OnlineSession } from "../sessions/online/OnlineSession";
import { SpectatorSession } from "../sessions/spectator/SpectatorSession";
import { ReplaySession } from "../sessions/replay/ReplaySession";
import type { ReplayDocument } from "../../../../packages/arena/src/contracts/index.d.mts";
import { OnlineLobbyGateway } from "../sessions/online/OnlineLobbyGateway";
import { OnlineLobbyStream, type OnlineLobbyStreamSnapshot } from "../sessions/online/OnlineLobbyStream";
import { createRuntimeBridge, type RuntimeBridge } from "../sessions/online/runtimeBridge";
import { resumeStore as defaultResumeStore, type PendingOnlineGame, type ResumeStore } from "../sessions/online/resumeStore";
import { joinCodeFromUrl } from "../sessions/online/roomCode";
import { ArenaApiGateway } from "../features/arena/ArenaApiGateway";
import { isArenaAvailable, isSpectatorEnabled, resolveArenaDiscoveryEndpoint, resolveArenaEndpoint } from "../runtime-config";
import { AppProviders } from "./AppProviders";
import { ScreenBoundary } from "./ScreenBoundary";
import { AppLifecycleCoordinator, type AppLifecycleOptions } from "./AppLifecycleCoordinator";
import { ThemeToggle } from "../shared/ui/ThemeToggle";
import styles from "./app.module.css";
import type { PublicMatchIdentity, PublicMatchListState } from "../features/spectator/PublicMatchList";

const defaultOnlineGateway = new OnlineLobbyGateway();

// Arena and replay are opened by few players; keep them out of the first download.
const ArenaScreen = lazy(() => import("../features/arena/ArenaScreen").then((module) => ({ default: module.ArenaScreen })));
const ReplayScreen = lazy(() => import("../features/replay/ReplayScreen").then((module) => ({ default: module.ReplayScreen })));
const screenFallback = <Panel className={styles.screen}><Spinner label="Đang tải" /></Panel>;

export type AppState =
  | { readonly status: "boot"; readonly generation: number }
  | { readonly status: "lobby"; readonly generation: number; readonly session: GameSession; readonly snapshot: GameSnapshot; readonly scenario: DemoScenario }
  | { readonly status: "preparing"; readonly generation: number; readonly session: GameSession; readonly snapshot: GameSnapshot; readonly scenario: DemoScenario }
  | { readonly status: "playing"; readonly generation: number; readonly session: GameSession; readonly snapshot: GameSnapshot; readonly scenario: DemoScenario }
  | { readonly status: "finished"; readonly generation: number; readonly session: GameSession; readonly snapshot: GameSnapshot & { readonly result?: GameResultView | null }; readonly scenario: DemoScenario }
  | { readonly status: "arena"; readonly generation: number }
  | { readonly status: "error"; readonly generation: number; readonly session: GameSession | null; readonly snapshot: GameSnapshot | null; readonly error: SessionErrorView; readonly scenario: DemoScenario };

export type SessionFactory = (scenario: DemoScenario) => GameSession;
export type OnlineSessionFactory = () => GameSession;
export type SpectatorSessionFactory = () => GameSession;
export type ReplaySessionFactory = () => GameSession;
export type OnlineLobbyStreamFactory = (runtime: RuntimeBridge) => OnlineLobbyStream;

export function createDemoSession(scenario: DemoScenario): GameSession {
  return new DemoSession(isDemoScenario(scenario) ? scenario : DEFAULT_DEMO_SCENARIO);
}

const SESSION_ERROR_CODES: ReadonlySet<SessionErrorView["code"]> = new Set([
  "invalid_input", "invalid_move", "online_unavailable", "connection_failed",
  "reconnect_failed", "room_unavailable", "session_failed",
]);
const GENERIC_SESSION_ERROR = "Không thể xử lý phiên chơi.";
/** Waiting rooms have no push channel; the lobby re-reads them at this pace while it is visible. */
export const WAITING_ROOMS_REFRESH_MS = 10_000;

export function safeSessionError(error: unknown): SessionErrorView {
  const isPlainObject = error !== null && typeof error === "object" && !(
    error instanceof Error
  ) && (Object.getPrototypeOf(error) === Object.prototype || Object.getPrototypeOf(error) === null);
  if (isPlainObject && "code" in error && "message" in error) {
    const candidate = error as Partial<SessionErrorView>;
    if (typeof candidate.code === "string" && SESSION_ERROR_CODES.has(candidate.code as SessionErrorView["code"]) && typeof candidate.message === "string" && typeof candidate.retryable === "boolean") {
      return { code: candidate.code as SessionErrorView["code"], message: candidate.message, retryable: candidate.retryable === true };
    }
  }
  return { code: "session_failed", message: GENERIC_SESSION_ERROR, retryable: false };
}

function stateForSnapshot(session: GameSession, scenario: DemoScenario, snapshot: GameSnapshot, generation: number): AppState {
  if (snapshot.mode === "replay") {
    if (snapshot.phase === "error") {
      return { status: "error", generation, session, snapshot, error: snapshot.error ? safeSessionError(snapshot.error) : { code: "session_failed", message: "Không thể xử lý phiên replay.", retryable: true }, scenario };
    }
    if (snapshot.phase === "finished") {
      return { status: "finished", generation, session, snapshot, scenario };
    }
    return { status: "playing", generation, session, snapshot, scenario };
  }
  if (snapshot.phase === "finished") {
    if (snapshot.result) return { status: "finished", generation, session, snapshot: snapshot as GameSnapshot & { readonly result: GameResultView }, scenario };
    return { status: "error", generation, session, snapshot, error: { code: "session_failed", message: "Kết quả ván chơi không hợp lệ.", retryable: false }, scenario };
  }
  // Idle/preparing are lobby lifecycle phases. This intentionally keeps an unavailable
  // online lobby usable while still surfacing errors emitted during an active game.
  if (snapshot.phase === "idle") return { status: "lobby", generation, session, snapshot, scenario };
  if (snapshot.phase === "preparing") return { status: "preparing", generation, session, snapshot, scenario };
  if (snapshot.phase === "error") {
    return { status: "error", generation, session, snapshot, error: snapshot.error ? safeSessionError(snapshot.error) : { code: "session_failed", message: "Không thể đồng bộ ván chơi.", retryable: true }, scenario };
  }
  return { status: "playing", generation, session, snapshot, scenario };
}

type LifecycleAction =
  | { readonly type: "boot"; readonly generation: number }
  | { readonly type: "arena"; readonly generation: number }
  | { readonly type: "snapshot"; readonly generation: number; readonly session: GameSession; readonly scenario: DemoScenario; readonly snapshot: GameSnapshot }
  | { readonly type: "error"; readonly generation: number; readonly session: GameSession | null; readonly snapshot: GameSnapshot | null; readonly scenario: DemoScenario; readonly error: SessionErrorView };

function appStateReducer(_state: AppState, action: LifecycleAction): AppState {
  if (action.generation < _state.generation) return _state;
  if (action.type === "boot") return _state.status === "boot" ? _state : { status: "boot", generation: action.generation };
  if (action.type === "arena") return { status: "arena", generation: action.generation };
  if (action.type === "error") return { status: "error", generation: action.generation, session: action.session, snapshot: action.snapshot, error: action.error, scenario: action.scenario };
  return stateForSnapshot(action.session, action.scenario, action.snapshot, action.generation);
}

export interface AppProps {
  readonly initialScenario?: unknown;
  readonly sessionFactory?: SessionFactory;
  readonly onlineGateway?: OnlineLobbyGateway;
  readonly onlineSessionFactory?: OnlineSessionFactory;
  readonly spectatorSessionFactory?: SpectatorSessionFactory;
  readonly replaySessionFactory?: ReplaySessionFactory;
  readonly arenaGateway?: ArenaApiGateway;
  readonly arenaAvailable?: boolean;
  readonly runtime?: RuntimeBridge;
  readonly onlineLobbyStreamFactory?: OnlineLobbyStreamFactory;
  readonly spectatorEnabled?: boolean;
  readonly demoEnabled?: boolean;
  readonly onStateChange?: (state: AppState) => void;
  readonly onWatchMatch?: (identity: PublicMatchIdentity) => void;
  readonly resumeStore?: ResumeStore;
}

/** Reads `?join=` once and drops it from the address bar so a reload does not re-join. */
function takeJoinCodeFromLocation(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const code = joinCodeFromUrl(window.location.search);
  if (!code) return undefined;
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("join");
    window.history.replaceState(window.history.state, "", url.toString());
  } catch { /* keep the code even if the URL cannot be rewritten */ }
  return code;
}

export function App({ initialScenario, sessionFactory = createDemoSession, onlineGateway = defaultOnlineGateway, onlineSessionFactory, spectatorSessionFactory, replaySessionFactory, arenaGateway, arenaAvailable, runtime: runtimeDependency, onlineLobbyStreamFactory, spectatorEnabled, demoEnabled, onStateChange, onWatchMatch = () => undefined, resumeStore = defaultResumeStore }: AppProps) {
  const demo = useDemoScenario(initialScenario);
  const isDemo = demoEnabled ?? demo.enabled;
  const effectiveSpectatorEnabled = spectatorEnabled ?? isSpectatorEnabled();
  const [restartToken, setRestartToken] = useState(0);
  const [appState, dispatch] = useReducer(appStateReducer, { status: "boot", generation: 0 });
  const sessionFactoryRef = useRef<SessionFactory>(sessionFactory);
  const generationRef = useRef(0);
  const activeSessionRef = useRef<GameSession | null>(null);
  const isMountedRef = useRef(true);
  const lobbyStreamUnsubscribeRef = useRef<(() => void) | null>(null);
  const lifecycleTokenRef = useRef(0);
  const [initialRuntimeOwner] = useState<RuntimeBridge>(() => runtimeDependency ?? createRuntimeBridge());
  const runtimeDependencyRef = useRef(runtimeDependency);
  const runtimeOwnerRef = useRef<RuntimeBridge>(initialRuntimeOwner);
  const coordinatorRef = useRef<AppLifecycleCoordinator | null>(null);
  const createLobbyStream = (runtime: RuntimeBridge) => (onlineLobbyStreamFactory ?? ((owner) => new OnlineLobbyStream({ runtime: owner, disposeRuntime: false, enabled: effectiveSpectatorEnabled })))(runtime);
  if (!coordinatorRef.current) {
    coordinatorRef.current = new AppLifecycleCoordinator({
      runtime: initialRuntimeOwner,
      gateway: onlineGateway,
      createLobbyStream,
    });
  }
  const [activeSession, setActiveSession] = useState<{ readonly session: GameSession; readonly scenario: DemoScenario; readonly generation: number } | null>(null);
  const [lobbyStreamSnapshot, setLobbyStreamSnapshot] = useState<OnlineLobbyStreamSnapshot | null>(null);
  const [waitingRooms, setWaitingRooms] = useState<{ status: "loading" | "ready" | "unavailable" | "error"; rooms?: readonly import("../shared/model/game").WaitingRoomView[]; message?: string }>({ status: "loading" });
  const createOnlineSession = onlineSessionFactory ?? (() => new OnlineSession({ gateway: onlineGateway, runtime: runtimeOwnerRef.current, disposeRuntime: false }));
  const createSpectatorSession = spectatorSessionFactory ?? (() => new SpectatorSession({ gateway: onlineGateway, runtime: runtimeOwnerRef.current, disposeRuntime: false }));
  const createReplaySession = replaySessionFactory ?? (() => new ReplaySession());
  const observedSnapshot = useSessionSnapshot(activeSession?.session ?? null);
  const [pendingGame, setPendingGame] = useState<PendingOnlineGame | null>(() => resumeStore.read());
  const [initialRoomCode] = useState(takeJoinCodeFromLocation);

  // Re-read on every return to the lobby: a game may have finished, been left or been saved meanwhile.
  useEffect(() => {
    if (appState.status === "lobby") setPendingGame(resumeStore.read());
  }, [appState.status, resumeStore]);

  useEffect(() => {
    sessionFactoryRef.current = sessionFactory;
  }, [sessionFactory]);

  useEffect(() => {
    if (runtimeDependencyRef.current !== runtimeDependency) {
      runtimeDependencyRef.current = runtimeDependency;
      runtimeOwnerRef.current = runtimeDependency ?? createRuntimeBridge();
    }
    coordinatorRef.current?.updateDependencies({
      runtime: runtimeOwnerRef.current,
      gateway: onlineGateway,
      createLobbyStream,
    });
  }, [runtimeDependency, onlineGateway, onlineLobbyStreamFactory, effectiveSpectatorEnabled]);

  // The coordinator is the only owner allowed to release the shared runtime.
  useEffect(() => {
    const lifecycleToken = ++lifecycleTokenRef.current;
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      generationRef.current += 1;
      activeSessionRef.current = null;
      lobbyStreamUnsubscribeRef.current?.();
      lobbyStreamUnsubscribeRef.current = null;
      queueMicrotask(() => {
        if (lifecycleTokenRef.current !== lifecycleToken) return;
        void coordinatorRef.current?.dispose().catch(() => undefined);
      });
    };
  }, []);

  const onLobbyScreen = appState.status === "lobby";
  const pollWaitingRooms = onLobbyScreen && !isDemo && onlineGateway.available;
  // A waiting room leaves the list when its game starts, and the public catalog announces exactly that.
  const knownMatchSet = lobbyStreamSnapshot && lobbyStreamSnapshot.catalogRevision >= 0
    ? lobbyStreamSnapshot.matches.map((match) => match.allocationId).sort().join(",")
    : null;
  const lastMatchSetRef = useRef<string | null>(null);
  const [waitingRoomsRefresh, setWaitingRoomsRefresh] = useState(0);

  useEffect(() => {
    if (isDemo) {
      setWaitingRooms({ status: "ready", rooms: [] });
      return;
    }
    if (!onlineGateway.available) {
      setWaitingRooms({ status: "unavailable", message: "Online hiện không khả dụng." });
      return;
    }
    if (!onLobbyScreen) return;
    let active = true;
    // A background refresh keeps the last list on screen instead of flashing the loading state.
    setWaitingRooms((current) => current.status === "ready" ? current : { status: "loading" });
    void onlineGateway.listRooms().then((result) => {
      if (active) setWaitingRooms({ status: "ready", rooms: result.rooms });
    }).catch(() => {
      if (active) setWaitingRooms((current) => current.status === "ready" ? current : { status: "error", message: "Không thể tải danh sách phòng." });
    });
    return () => { active = false; };
  }, [isDemo, demo.scenario, onlineGateway, onLobbyScreen, waitingRoomsRefresh]);

  useEffect(() => {
    const previous = lastMatchSetRef.current;
    lastMatchSetRef.current = knownMatchSet;
    // The first catalog only confirms what the lobby read on entry; reading again at once would
    // trip the Lobby's 40 ms per-client burst limit.
    if (!pollWaitingRooms || knownMatchSet === null || previous === null || previous === knownMatchSet) return;
    // Every lobby viewer hears the catalog at the same moment; spread their reads so players
    // behind one IP do not collide either.
    const timer = window.setTimeout(() => setWaitingRoomsRefresh((value) => value + 1), 250 + Math.random() * 1000);
    return () => window.clearTimeout(timer);
  }, [knownMatchSet, pollWaitingRooms]);

  useEffect(() => {
    if (!pollWaitingRooms) return;
    const refresh = () => {
      if (document.visibilityState === "visible") setWaitingRoomsRefresh((value) => value + 1);
    };
    const timer = window.setInterval(refresh, WAITING_ROOMS_REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [pollWaitingRooms]);

  useEffect(() => {
    onStateChange?.(appState);
  }, [appState, onStateChange]);

  useEffect(() => {
    if (!activeSession || generationRef.current !== activeSession.generation) return;
    // useSessionSnapshot owns the subscription; read the current session snapshot
    // after it signals a render so a queued update from a prior session is ignored.
    try {
      dispatch({
        type: "snapshot",
        generation: activeSession.generation,
        session: activeSession.session,
        scenario: activeSession.scenario,
        snapshot: activeSession.session.getSnapshot(),
      });
    } catch (error) {
      if (generationRef.current === activeSession.generation) {
        dispatch({ type: "error", generation: activeSession.generation, session: activeSession.session, snapshot: null, scenario: activeSession.scenario, error: safeSessionError(error) });
      }
    }
  }, [activeSession, observedSnapshot]);

  const transitionTo = useCallback((
    factory: () => GameSession,
    options: AppLifecycleOptions,
    scenario: DemoScenario,
    openLobbyStream = false,
  ) => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    dispatch({ type: "boot", generation });
    setActiveSession(null);
    lobbyStreamUnsubscribeRef.current?.();
    lobbyStreamUnsubscribeRef.current = null;
    setLobbyStreamSnapshot(null);

    const coordinator = coordinatorRef.current;
    if (!coordinator) return;
    const bindLobbyStream = (stream: OnlineLobbyStream | null, _streamGeneration: number) => {
      if (!isMountedRef.current || generationRef.current !== generation) return;
      lobbyStreamUnsubscribeRef.current?.();
      lobbyStreamUnsubscribeRef.current = null;
      setLobbyStreamSnapshot(stream?.getSnapshot() ?? null);
      if (stream) {
        lobbyStreamUnsubscribeRef.current = stream.subscribe(() => {
          if (!isMountedRef.current || generationRef.current !== generation) return;
          setLobbyStreamSnapshot(stream.getSnapshot());
        });
      }
    };
    const lobbyTransition = {
      factory: () => sessionFactoryRef.current(DEFAULT_DEMO_SCENARIO),
      options: { mode: "demo" as const, scenario: DEFAULT_DEMO_SCENARIO },
      onSession: (session: GameSession) => {
        if (!isMountedRef.current || generationRef.current !== generation) return;
        activeSessionRef.current = session;
        setActiveSession({ session, scenario: DEFAULT_DEMO_SCENARIO, generation });
      },
    };

    void coordinator.transition({
      factory,
      options,
      openLobbyStream: openLobbyStream && !isDemo && effectiveSpectatorEnabled,
      lobby: options.mode === "spectator" ? lobbyTransition : undefined,
      onSession: (session) => {
        if (!isMountedRef.current || generationRef.current !== generation) return;
        activeSessionRef.current = session;
        setActiveSession({ session, scenario, generation });
      },
      onLobbyStream: bindLobbyStream,
      onError: (cause, session) => {
        if (!isMountedRef.current || generationRef.current !== generation) return;
        let snapshot: GameSnapshot | null = null;
        try { snapshot = session?.getSnapshot() ?? null; } catch { /* retain safe error */ }
        dispatch({ type: "error", generation, session, snapshot, scenario, error: safeSessionError(cause) });
      },
    }).catch(() => undefined);
  }, [effectiveSpectatorEnabled, isDemo]);

  useEffect(() => {
    transitionTo(
      () => sessionFactoryRef.current(demo.scenario),
      { mode: "demo", scenario: demo.scenario },
      demo.scenario,
      true,
    );
  }, [demo.scenario, restartToken, transitionTo]);

  const aiLevelRef = useRef<AiLevel>(DEFAULT_AI_LEVEL);
  const onLobby = () => {
    setRestartToken((value) => value + 1);
    demo.setScenario("lobby-default");
  };
  const onRetry = () => setRestartToken((value) => value + 1);
  const onStartLocal = (names: [string, string]) => {
    transitionTo(() => new LocalSession(), { mode: "local", playerNames: names }, "game-active-a");
  };
  const onStartAi = (playerName: string, level: AiLevel) => {
    aiLevelRef.current = level;
    transitionTo(() => new AiSession(), { mode: "ai", playerName, level }, "game-ai-thinking");
  };
  const startOnline = (options: Extract<StartGameOptions, { mode: "online" }>) => {
    transitionTo(createOnlineSession, options, "game-waiting");
  };
  const onResumeOnline = () => {
    const game = resumeStore.read();
    setPendingGame(game);
    if (!game) return;
    startOnline({ mode: "online", intent: "resume", playerName: game.playerName, allocationId: game.allocationId, resumeCredential: game.resumeCredential });
  };
  const onDiscardResume = () => {
    resumeStore.clear();
    setPendingGame(null);
  };
  const startSpectator = (identity: PublicMatchIdentity) => {
    onWatchMatch(identity);
    if (isDemo || !effectiveSpectatorEnabled) return;
    transitionTo(createSpectatorSession, { mode: "spectator", allocationId: identity.allocationId, roomId: identity.roomId }, "spectator-active");
  };
  const onStartReplay = (document: ReplayDocument) => {
    transitionTo(createReplaySession, { mode: "replay", document }, "game-active-a");
  };
  const onForkPractice = (mode: "local" | "ai", practice: PracticeStart) => {
    if (mode === "local") {
      transitionTo(() => new LocalSession(), { mode: "local", playerNames: ["Người chơi Đỏ", "Người chơi Xanh"], practice }, "game-active-a");
    } else {
      transitionTo(() => new AiSession(), { mode: "ai", playerName: "Người chơi", practice, level: aiLevelRef.current }, "game-ai-thinking");
    }
  };

  const effectiveArenaAvailable = arenaAvailable ?? isArenaAvailable();
  const [arenaGatewayInstance] = useState(
    () =>
      arenaGateway ??
      new ArenaApiGateway({
        baseUrl: resolveArenaEndpoint(),
        discoveryEndpoint: resolveArenaDiscoveryEndpoint(),
      }),
  );
  const effectiveArenaGateway = arenaGateway ?? arenaGatewayInstance;

  const onOpenArena = () => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    dispatch({ type: "arena", generation });
    setActiveSession(null);
    lobbyStreamUnsubscribeRef.current?.();
    lobbyStreamUnsubscribeRef.current = null;
    setLobbyStreamSnapshot(null);
    void coordinatorRef.current?.releaseCurrentSession().catch(() => undefined);
  };

  return (
    <AppProviders>
      <main className={styles.app} aria-label="OTTv2">
        <header className={styles.header}>
          <p className={styles.brand}>OTTv2</p>
          {demo.enabled ? <span aria-label="Demo">Demo</span> : null}
          <div className={styles.headerControls}>
            {demo.enabled ? <div className={styles.demoTools}><ScenarioSwitcher scenario={demo.scenario} onScenarioChange={demo.setScenario} /></div> : null}
            <ThemeToggle />
          </div>
        </header>
        <div className={styles.content}>
          <div className={styles.state} data-testid="app-state" data-state={appState.status}>
            <ScreenBoundary
              error={appState.status === "error" && !(appState.error.code === "room_unavailable" && appState.snapshot?.viewer?.role === "spectator") ? appState.error : null}
              resetKey={`${demo.scenario}:${appState.status}:${activeSession?.generation ?? 0}:${restartToken}`}
              onRetry={onRetry}
              onLobby={onLobby}
            >
              <AppScreen
                state={appState}
                onLobby={onLobby}
                onStartLocal={onStartLocal}
                onStartAi={onStartAi}
                onStartReplay={onStartReplay}
                onForkPractice={onForkPractice}
                onCreateOnline={(name) => startOnline({ mode: "online", intent: "create", playerName: name })}
                onJoinOnline={(name, roomId) => startOnline({ mode: "online", intent: "join", playerName: name, roomId })}
                waitingRooms={waitingRooms}
                lobbyStream={lobbyStreamSnapshot}
                onlineAvailable={onlineGateway.available}
                demoEnabled={isDemo}
                spectatorEnabled={effectiveSpectatorEnabled}
                onWatchMatch={startSpectator}
                arenaGateway={effectiveArenaGateway}
                arenaAvailable={effectiveArenaAvailable}
                onOpenArena={onOpenArena}
                onlineGateway={onlineGateway}
                pendingGame={isDemo || !onlineGateway.available ? null : pendingGame}
                onResumeOnline={onResumeOnline}
                onDiscardResume={onDiscardResume}
                initialRoomCode={initialRoomCode}
              />
            </ScreenBoundary>
          </div>
        </div>
      </main>
    </AppProviders>
  );
}

function AppScreen({ state, onLobby, onStartLocal, onStartAi, onStartReplay, onForkPractice, onCreateOnline, onJoinOnline, waitingRooms, lobbyStream, onlineAvailable, demoEnabled, spectatorEnabled, onWatchMatch, arenaGateway, arenaAvailable, onOpenArena, onlineGateway, pendingGame, onResumeOnline, onDiscardResume, initialRoomCode }: {
  readonly state: AppState;
  readonly onLobby: () => void;
  readonly onStartLocal: (names: [string, string]) => void;
  readonly onStartAi: (name: string, level: AiLevel) => void;
  readonly onStartReplay: (document: ReplayDocument) => void;
  readonly onForkPractice: (mode: "local" | "ai", practice: PracticeStart) => void;
  readonly onCreateOnline: (name: string) => void;
  readonly onJoinOnline: (name: string, roomId: string) => void;
  readonly waitingRooms: { status: "loading" | "ready" | "unavailable" | "error"; rooms?: readonly import("../shared/model/game").WaitingRoomView[]; message?: string };
  readonly lobbyStream: OnlineLobbyStreamSnapshot | null;
  readonly onlineAvailable: boolean;
  readonly demoEnabled: boolean;
  readonly spectatorEnabled?: boolean;
  readonly onWatchMatch: (identity: PublicMatchIdentity) => void;
  readonly arenaGateway: ArenaApiGateway;
  readonly arenaAvailable: boolean;
  readonly onOpenArena: () => void;
  readonly onlineGateway?: OnlineLobbyGateway;
  readonly pendingGame: PendingOnlineGame | null;
  readonly onResumeOnline: () => void;
  readonly onDiscardResume: () => void;
  readonly initialRoomCode?: string;
}) {
  const resumeProps = {
    pendingGame: pendingGame ? { alias: pendingGame.alias, seat: pendingGame.seat } : null,
    onResumeOnline,
    onDiscardResume,
    initialRoomCode,
  };
  if (state.status === "boot") return <Panel className={styles.screen}><Spinner label="Đang khởi động" /></Panel>;
  if (state.status === "error" && state.error.code === "room_unavailable" && state.snapshot?.viewer?.role === "spectator") return (
    <Panel className={styles.screen} role="alert">
      <h1>Trận đấu không còn khả dụng</h1>
      <p>{state.error.message}</p>
      <Button variant="secondary" onClick={onLobby}>Về sảnh</Button>
    </Panel>
  );
  if (state.status === "error") return null;

  if (state.status === "arena") {
    return <Suspense fallback={screenFallback}><ArenaScreen gateway={arenaGateway} onLobby={onLobby} onStartReplay={onStartReplay} /></Suspense>;
  }

  // Replay mode MUST route BEFORE phase checks; never render GameScreen or live ResultDialog
  if (state.snapshot?.mode === "replay" && state.session) {
    return <Suspense fallback={screenFallback}><ReplayScreen session={state.session} snapshot={state.snapshot} onLobby={onLobby} onForkPractice={onForkPractice} /></Suspense>;
  }

  if (state.status === "preparing") return <LobbyScreen
    onlineAvailability={onlineAvailable ? "connecting" : "unavailable"}
    waitingRooms={waitingRooms.status === "ready" ? { status: "ready", rooms: waitingRooms.rooms ?? [] } : waitingRooms.status === "error" ? { status: "error", message: waitingRooms.message ?? "Không thể tải danh sách phòng." } : waitingRooms.status === "unavailable" ? { status: "unavailable", message: waitingRooms.message ?? "Online hiện không khả dụng." } : { status: "loading" }}
    publicMatches={publicMatchState(state.snapshot, demoEnabled, state.scenario, lobbyStream, spectatorEnabled)}
    allowDemoWatch={demoEnabled && state.scenario === "spectator-list"}
    onStartLocal={onStartLocal}
    onStartAi={onStartAi}
    onStartReplay={onStartReplay}
    onCreateOnline={onCreateOnline}
    onJoinOnline={onJoinOnline}
    onWatchMatch={onWatchMatch}
    onOpenArena={onOpenArena}
    arenaAvailable={arenaAvailable}
    onlineGateway={onlineGateway}
    {...resumeProps}
    onCancelConnecting={onLobby}
  />;
  if (state.status === "lobby") return <LobbyScreen
    onlineAvailability={!onlineAvailable ? "unavailable" : state.snapshot.connection === "connecting" ? "connecting" : "online"}
    waitingRooms={waitingRooms.status === "ready" ? { status: "ready", rooms: waitingRooms.rooms ?? state.snapshot.waitingRooms ?? [] } : waitingRooms.status === "error" ? { status: "error", message: waitingRooms.message ?? "Không thể tải danh sách phòng." } : waitingRooms.status === "unavailable" ? { status: "unavailable", message: waitingRooms.message ?? "Online hiện không khả dụng." } : { status: "loading" }}
    publicMatches={publicMatchState(state.snapshot, demoEnabled, state.scenario, lobbyStream, spectatorEnabled)}
    allowDemoWatch={demoEnabled && state.scenario === "spectator-list"}
    onStartLocal={onStartLocal}
    onStartAi={onStartAi}
    onStartReplay={onStartReplay}
    onCreateOnline={onCreateOnline}
    onJoinOnline={onJoinOnline}
    onWatchMatch={onWatchMatch}
    onOpenArena={onOpenArena}
    arenaAvailable={arenaAvailable}
    onlineGateway={onlineGateway}
    {...resumeProps}
  />;
  if (state.status === "playing" || state.status === "finished") return <GameScreen session={state.session} snapshot={state.snapshot} onLobby={onLobby} />;
  return <PlaceholderScreen heading="Kết quả" state={state} detail="Màn hình kết quả đang chuẩn bị." />;
}

/**
 * Resolves the public match list state for the lobby.
 *
 * In demo mode under the "spectator-list" scenario, active match fixtures are supplied by the demo snapshot.
 * In production (outside deterministic demos), active matches come only from the
 * coordinator-owned single-provider lobby stream. No control endpoint polling is used.
 */
function publicMatchState(snapshot: GameSnapshot, demoEnabled: boolean, scenario: DemoScenario, lobbyStream: OnlineLobbyStreamSnapshot | null, spectatorEnabled = false): PublicMatchListState {
  if (demoEnabled && scenario === "spectator-list") return { status: "ready", matches: snapshot.publicMatches ?? [] };
  if (!spectatorEnabled) {
    return { status: "unavailable", message: "Danh sách trận đang diễn ra hiện không khả dụng." };
  }
  if (!demoEnabled && lobbyStream) {
    // The stream turns ready once subscribed; until the first catalog arrives it knows of no matches yet.
    if (lobbyStream.status === "ready" && lobbyStream.catalogRevision < 0) return { status: "loading" };
    if (lobbyStream.status === "ready") return { status: "ready", matches: lobbyStream.matches };
    if (lobbyStream.status === "loading" || lobbyStream.status === "reconnecting") return { status: "loading" };
    if (lobbyStream.status === "error") return { status: "error", message: lobbyStream.message ?? "Online lobby stream gặp lỗi." };
    return { status: "unavailable", message: lobbyStream.message ?? "Danh sách trận đang diễn ra hiện không khả dụng." };
  }
  // The lobby renders before the coordinator binds its stream; a failed stream ends in the error screen instead.
  if (!demoEnabled) return { status: "loading" };
  return { status: "unavailable", message: "Danh sách trận đang diễn ra hiện không khả dụng." };
}

function PlaceholderScreen({ heading, detail, state }: { readonly heading: string; readonly detail: string; readonly state: Exclude<AppState, { status: "boot" } | { status: "error" } | { status: "arena" }> }) {
  return (
    <Panel className={styles.screen}>
      <h1>{heading}</h1>
      <p>{detail}</p>
      <dl>
        <dt>Kịch bản</dt><dd>{state.scenario}</dd>
        <dt>Trạng thái phiên</dt><dd>{state.snapshot.phase}</dd>
        <dt>Kết nối</dt><dd data-connection={state.snapshot.connection}>{state.snapshot.connection}</dd>
        <dt>Chế độ</dt><dd>{state.snapshot.mode}</dd>
      </dl>
    </Panel>
  );
}
