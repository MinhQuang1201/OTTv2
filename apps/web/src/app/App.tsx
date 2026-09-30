import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { DemoScenario, GameSession, GameResultView, GameSnapshot, SessionErrorView, StartGameOptions } from "../sessions/contract";
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
import { OnlineSession } from "../sessions/online/OnlineSession";
import { SpectatorSession } from "../sessions/spectator/SpectatorSession";
import { OnlineLobbyGateway } from "../sessions/online/OnlineLobbyGateway";
import { OnlineLobbyStream, type OnlineLobbyStreamSnapshot } from "../sessions/online/OnlineLobbyStream";
import { createRuntimeBridge, type RuntimeBridge } from "../sessions/online/runtimeBridge";
import { AppProviders } from "./AppProviders";
import { ScreenBoundary } from "./ScreenBoundary";
import { AppLifecycleCoordinator, type AppLifecycleOptions } from "./AppLifecycleCoordinator";
import styles from "./app.module.css";
import type { PublicMatchIdentity, PublicMatchListState } from "../features/spectator/PublicMatchList";

const defaultOnlineGateway = new OnlineLobbyGateway();

export type AppState =
  | { readonly status: "boot"; readonly generation: number }
  | { readonly status: "lobby"; readonly generation: number; readonly session: GameSession; readonly snapshot: GameSnapshot; readonly scenario: DemoScenario }
  | { readonly status: "preparing"; readonly generation: number; readonly session: GameSession; readonly snapshot: GameSnapshot; readonly scenario: DemoScenario }
  | { readonly status: "playing"; readonly generation: number; readonly session: GameSession; readonly snapshot: GameSnapshot; readonly scenario: DemoScenario }
  | { readonly status: "finished"; readonly generation: number; readonly session: GameSession; readonly snapshot: GameSnapshot & { readonly result: GameResultView }; readonly scenario: DemoScenario }
  | { readonly status: "error"; readonly generation: number; readonly session: GameSession | null; readonly snapshot: GameSnapshot | null; readonly error: SessionErrorView; readonly scenario: DemoScenario };

export type SessionFactory = (scenario: DemoScenario) => GameSession;
export type OnlineSessionFactory = () => GameSession;
export type SpectatorSessionFactory = () => GameSession;
export type OnlineLobbyStreamFactory = (runtime: RuntimeBridge) => OnlineLobbyStream;

export function createDemoSession(scenario: DemoScenario): GameSession {
  return new DemoSession(isDemoScenario(scenario) ? scenario : DEFAULT_DEMO_SCENARIO);
}

const SESSION_ERROR_CODES: ReadonlySet<SessionErrorView["code"]> = new Set([
  "invalid_input", "invalid_move", "online_unavailable", "connection_failed",
  "reconnect_failed", "room_unavailable", "session_failed",
]);
const GENERIC_SESSION_ERROR = "Không thể xử lý phiên chơi.";

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
  | { readonly type: "snapshot"; readonly generation: number; readonly session: GameSession; readonly scenario: DemoScenario; readonly snapshot: GameSnapshot }
  | { readonly type: "error"; readonly generation: number; readonly session: GameSession | null; readonly snapshot: GameSnapshot | null; readonly scenario: DemoScenario; readonly error: SessionErrorView };

function appStateReducer(_state: AppState, action: LifecycleAction): AppState {
  if (action.generation < _state.generation) return _state;
  if (action.type === "boot") return _state.status === "boot" ? _state : { status: "boot", generation: action.generation };
  if (action.type === "error") return { status: "error", generation: action.generation, session: action.session, snapshot: action.snapshot, error: action.error, scenario: action.scenario };
  return stateForSnapshot(action.session, action.scenario, action.snapshot, action.generation);
}

export interface AppProps {
  readonly initialScenario?: unknown;
  readonly sessionFactory?: SessionFactory;
  readonly onlineGateway?: OnlineLobbyGateway;
  readonly onlineSessionFactory?: OnlineSessionFactory;
  readonly spectatorSessionFactory?: SpectatorSessionFactory;
  readonly runtime?: RuntimeBridge;
  readonly onlineLobbyStreamFactory?: OnlineLobbyStreamFactory;
  readonly onStateChange?: (state: AppState) => void;
  readonly onWatchMatch?: (identity: PublicMatchIdentity) => void;
}

export function App({ initialScenario, sessionFactory = createDemoSession, onlineGateway = defaultOnlineGateway, onlineSessionFactory, spectatorSessionFactory, runtime: runtimeDependency, onlineLobbyStreamFactory, onStateChange, onWatchMatch = () => undefined }: AppProps) {
  const demo = useDemoScenario(initialScenario);
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
  const createLobbyStream = (runtime: RuntimeBridge) => (onlineLobbyStreamFactory ?? ((owner) => new OnlineLobbyStream({ runtime: owner, disposeRuntime: false })))(runtime);
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
  const observedSnapshot = useSessionSnapshot(activeSession?.session ?? null);

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
  }, [runtimeDependency, onlineGateway, onlineLobbyStreamFactory]);

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

  useEffect(() => {
    if (demo.enabled) {
      setWaitingRooms({ status: "ready", rooms: [] });
      return;
    }
    if (!onlineGateway.available) {
      setWaitingRooms({ status: "unavailable", message: "Online hiện không khả dụng." });
      return;
    }
    let active = true;
    setWaitingRooms({ status: "loading" });
    void onlineGateway.listRooms().then((result) => {
      if (active) setWaitingRooms({ status: "ready", rooms: result.rooms });
    }).catch(() => {
      if (active) setWaitingRooms({ status: "error", message: "Không thể tải danh sách phòng." });
    });
    return () => { active = false; };
  }, [demo.enabled, demo.scenario, onlineGateway]);

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
      openLobbyStream: openLobbyStream && !demo.enabled,
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
  }, []);

  useEffect(() => {
    transitionTo(
      () => sessionFactoryRef.current(demo.scenario),
      { mode: "demo", scenario: demo.scenario },
      demo.scenario,
      true,
    );
  }, [demo.scenario, restartToken, transitionTo]);

  const onLobby = () => {
    setRestartToken((value) => value + 1);
    demo.setScenario("lobby-default");
  };
  const onRetry = () => setRestartToken((value) => value + 1);
  const onStartLocal = (names: [string, string]) => {
    transitionTo(() => new LocalSession(), { mode: "local", playerNames: names }, "game-active-a");
  };
  const onStartAi = (playerName: string) => {
    transitionTo(() => new AiSession(), { mode: "ai", playerName }, "game-ai-thinking");
  };
  const startOnline = (options: Extract<StartGameOptions, { mode: "online" }>) => {
    transitionTo(createOnlineSession, options, "game-waiting");
  };
  const startSpectator = (identity: PublicMatchIdentity) => {
    onWatchMatch(identity);
    if (demo.enabled) return;
    transitionTo(createSpectatorSession, { mode: "spectator", allocationId: identity.allocationId, roomId: identity.roomId }, "spectator-active");
  };

  return (
    <AppProviders>
      <main className={styles.app} aria-label="OTTv2">
        <header className={styles.header}>
          <p className={styles.brand}>OTTv2</p>
          {demo.enabled ? <span aria-label="Demo">Demo</span> : null}
          {demo.enabled ? <div className={styles.demoTools}><ScenarioSwitcher scenario={demo.scenario} onScenarioChange={demo.setScenario} /></div> : null}
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
                onCreateOnline={(name) => startOnline({ mode: "online", intent: "create", playerName: name })}
                onJoinOnline={(name, roomId) => startOnline({ mode: "online", intent: "join", playerName: name, roomId })}
                waitingRooms={waitingRooms}
                lobbyStream={lobbyStreamSnapshot}
                onlineAvailable={onlineGateway.available}
                demoEnabled={demo.enabled}
                onWatchMatch={startSpectator}
              />
            </ScreenBoundary>
          </div>
        </div>
      </main>
    </AppProviders>
  );
}

function AppScreen({ state, onLobby, onStartLocal, onStartAi, onCreateOnline, onJoinOnline, waitingRooms, lobbyStream, onlineAvailable, demoEnabled, onWatchMatch }: {
  readonly state: AppState;
  readonly onLobby: () => void;
  readonly onStartLocal: (names: [string, string]) => void;
  readonly onStartAi: (name: string) => void;
  readonly onCreateOnline: (name: string) => void;
  readonly onJoinOnline: (name: string, roomId: string) => void;
  readonly waitingRooms: { status: "loading" | "ready" | "unavailable" | "error"; rooms?: readonly import("../shared/model/game").WaitingRoomView[]; message?: string };
  readonly lobbyStream: OnlineLobbyStreamSnapshot | null;
  readonly onlineAvailable: boolean;
  readonly demoEnabled: boolean;
  readonly onWatchMatch: (identity: PublicMatchIdentity) => void;
}) {
  if (state.status === "boot") return <Panel className={styles.screen}><Spinner label="Đang khởi động" /></Panel>;
  if (state.status === "error" && state.error.code === "room_unavailable" && state.snapshot?.viewer?.role === "spectator") return (
    <Panel className={styles.screen} role="alert">
      <h1>Trận đấu không còn khả dụng</h1>
      <p>{state.error.message}</p>
      <Button variant="secondary" onClick={onLobby}>Về sảnh</Button>
    </Panel>
  );
  if (state.status === "error") return null;
  if (state.status === "preparing") return <LobbyScreen
    onlineAvailability={onlineAvailable ? "connecting" : "unavailable"}
    waitingRooms={waitingRooms.status === "ready" ? { status: "ready", rooms: waitingRooms.rooms ?? [] } : waitingRooms.status === "error" ? { status: "error", message: waitingRooms.message ?? "Không thể tải danh sách phòng." } : waitingRooms.status === "unavailable" ? { status: "unavailable", message: waitingRooms.message ?? "Online hiện không khả dụng." } : { status: "loading" }}
    publicMatches={publicMatchState(state.snapshot, demoEnabled, state.scenario, lobbyStream)}
    allowDemoWatch={demoEnabled && state.scenario === "spectator-list"}
    onStartLocal={onStartLocal}
    onStartAi={onStartAi}
    onCreateOnline={onCreateOnline}
    onJoinOnline={onJoinOnline}
    onWatchMatch={onWatchMatch}
  />;
  if (state.status === "lobby") return <LobbyScreen
    onlineAvailability={!onlineAvailable ? "unavailable" : state.snapshot.connection === "connecting" ? "connecting" : "online"}
    waitingRooms={waitingRooms.status === "ready" ? { status: "ready", rooms: waitingRooms.rooms ?? state.snapshot.waitingRooms ?? [] } : waitingRooms.status === "error" ? { status: "error", message: waitingRooms.message ?? "Không thể tải danh sách phòng." } : waitingRooms.status === "unavailable" ? { status: "unavailable", message: waitingRooms.message ?? "Online hiện không khả dụng." } : { status: "loading" }}
    publicMatches={publicMatchState(state.snapshot, demoEnabled, state.scenario, lobbyStream)}
    allowDemoWatch={demoEnabled && state.scenario === "spectator-list"}
    onStartLocal={onStartLocal}
    onStartAi={onStartAi}
    onCreateOnline={onCreateOnline}
    onJoinOnline={onJoinOnline}
    onWatchMatch={onWatchMatch}
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
function publicMatchState(snapshot: GameSnapshot, demoEnabled: boolean, scenario: DemoScenario, lobbyStream: OnlineLobbyStreamSnapshot | null): PublicMatchListState {
  if (demoEnabled && scenario === "spectator-list") return { status: "ready", matches: snapshot.publicMatches ?? [] };
  if (!demoEnabled && lobbyStream) {
    if (lobbyStream.status === "ready") return { status: "ready", matches: lobbyStream.matches };
    if (lobbyStream.status === "loading" || lobbyStream.status === "reconnecting") return { status: "loading" };
    if (lobbyStream.status === "error") return { status: "error", message: lobbyStream.message ?? "Online lobby stream gặp lỗi." };
    return { status: "unavailable", message: lobbyStream.message ?? "Danh sách trận đang diễn ra hiện không khả dụng." };
  }
  return { status: "unavailable", message: "Danh sách trận đang diễn ra hiện không khả dụng." };
}

function PlaceholderScreen({ heading, detail, state }: { readonly heading: string; readonly detail: string; readonly state: Exclude<AppState, { status: "boot" } | { status: "error" }> }) {
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
