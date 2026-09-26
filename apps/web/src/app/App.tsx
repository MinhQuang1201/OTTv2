import { useEffect, useReducer, useRef, useState } from "react";
import type { DemoScenario, GameSession, GameResultView, GameSnapshot, SessionErrorView } from "../sessions/contract";
import { DemoSession } from "../sessions/demo/DemoSession";
import { useSessionSnapshot } from "../sessions/useSessionSnapshot";
import { ScenarioSwitcher } from "../demo/ScenarioSwitcher";
import { DEFAULT_DEMO_SCENARIO, isDemoScenario, useDemoScenario } from "../demo/useDemoScenario";
import { Panel } from "../shared/ui/Panel";
import { Spinner } from "../shared/ui/Spinner";
import { LobbyScreen } from "../features/lobby/LobbyScreen";
import { GameScreen } from "../features/game/GameScreen";
import { LocalSession } from "../sessions/local/LocalSession";
import { AppProviders } from "./AppProviders";
import { ScreenBoundary } from "./ScreenBoundary";
import styles from "./app.module.css";

export type AppState =
  | { readonly status: "boot"; readonly generation: number }
  | { readonly status: "lobby"; readonly generation: number; readonly session: GameSession; readonly snapshot: GameSnapshot; readonly scenario: DemoScenario }
  | { readonly status: "preparing"; readonly generation: number; readonly session: GameSession; readonly snapshot: GameSnapshot; readonly scenario: DemoScenario }
  | { readonly status: "playing"; readonly generation: number; readonly session: GameSession; readonly snapshot: GameSnapshot; readonly scenario: DemoScenario }
  | { readonly status: "finished"; readonly generation: number; readonly session: GameSession; readonly snapshot: GameSnapshot & { readonly result: GameResultView }; readonly scenario: DemoScenario }
  | { readonly status: "error"; readonly generation: number; readonly session: GameSession | null; readonly snapshot: GameSnapshot | null; readonly error: SessionErrorView; readonly scenario: DemoScenario };

export type SessionFactory = (scenario: DemoScenario) => GameSession;

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
  readonly onStateChange?: (state: AppState) => void;
}

export function App({ initialScenario, sessionFactory = createDemoSession, onStateChange }: AppProps) {
  const demo = useDemoScenario(initialScenario);
  const [restartToken, setRestartToken] = useState(0);
  const [appState, dispatch] = useReducer(appStateReducer, { status: "boot", generation: 0 });
  const sessionFactoryRef = useRef<SessionFactory>(sessionFactory);
  const generationRef = useRef(0);
  const [activeSession, setActiveSession] = useState<{ readonly session: GameSession; readonly scenario: DemoScenario; readonly generation: number } | null>(null);
  const observedSnapshot = useSessionSnapshot(activeSession?.session ?? null);

  useEffect(() => {
    sessionFactoryRef.current = sessionFactory;
  }, [sessionFactory]);

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

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    let active = true;
    let session: GameSession | null = null;
    dispatch({ type: "boot", generation });
    try {
      session = sessionFactoryRef.current(demo.scenario);
      setActiveSession({ session, scenario: demo.scenario, generation });
      void session.start({ mode: "demo", scenario: demo.scenario }).catch((error: unknown) => {
        if (!active || generationRef.current !== generation) return;
        let snapshot: GameSnapshot | null = null;
        try { snapshot = session?.getSnapshot() ?? null; } catch { /* retain the safe error state */ }
        dispatch({ type: "error", generation, session, snapshot, error: safeSessionError(error), scenario: demo.scenario });
      });
    } catch (error) {
      if (active && generationRef.current === generation) dispatch({ type: "error", generation, session, snapshot: null, error: safeSessionError(error), scenario: demo.scenario });
    }
    return () => {
      active = false;
      generationRef.current += 1;
      setActiveSession((current) => current?.generation === generation ? null : current);
      session?.dispose();
    };
  }, [demo.scenario, restartToken]);

  const onLobby = () => {
    setRestartToken((value) => value + 1);
    demo.setScenario("lobby-default");
  };
  const onRetry = () => setRestartToken((value) => value + 1);
  const onStartLocal = (names: [string, string]) => {
    activeSession?.session.dispose();
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const session = new LocalSession();
    dispatch({ type: "boot", generation });
    setActiveSession({ session, scenario: "game-active-a", generation });
    void session.start({ mode: "local", playerNames: names }).catch((error: unknown) => {
      if (generationRef.current !== generation) return;
      dispatch({ type: "error", generation, session, snapshot: null, error: safeSessionError(error), scenario: "game-active-a" });
    });
  };

  return (
    <AppProviders>
      <main className={styles.app} aria-label="OTTv2">
        <header className={styles.header}>
          <p className={styles.brand}>OTTv2</p>
          {demo.enabled ? <div className={styles.demoTools}><ScenarioSwitcher scenario={demo.scenario} onScenarioChange={demo.setScenario} /></div> : null}
        </header>
        <div className={styles.content}>
          <div className={styles.state} data-testid="app-state" data-state={appState.status}>
            <ScreenBoundary
              error={appState.status === "error" ? appState.error : null}
              resetKey={`${demo.scenario}:${appState.status}:${activeSession?.generation ?? 0}:${restartToken}`}
              onRetry={onRetry}
              onLobby={onLobby}
            >
              <AppScreen
                state={appState}
                onLobby={onLobby}
                onStartLocal={onStartLocal}
                onStartAi={() => demo.setScenario("game-ai-thinking")}
                onCreateOnline={() => demo.setScenario("game-waiting")}
                onJoinOnline={() => demo.setScenario("game-active-a")}
              />
            </ScreenBoundary>
          </div>
        </div>
      </main>
    </AppProviders>
  );
}

function AppScreen({ state, onLobby, onStartLocal, onStartAi, onCreateOnline, onJoinOnline }: {
  readonly state: AppState;
  readonly onLobby: () => void;
  readonly onStartLocal: (names: [string, string]) => void;
  readonly onStartAi: (name: string) => void;
  readonly onCreateOnline: (name: string) => void;
  readonly onJoinOnline: (name: string, roomId: string) => void;
}) {
  if (state.status === "boot") return <Panel className={styles.screen}><Spinner label="Đang khởi động" /></Panel>;
  if (state.status === "error") return null;
  if (state.status === "preparing") return <LobbyScreen
    onlineAvailability="connecting"
    waitingRooms={{ status: "loading" }}
    onStartLocal={onStartLocal}
    onStartAi={onStartAi}
    onCreateOnline={onCreateOnline}
    onJoinOnline={onJoinOnline}
  />;
  if (state.status === "lobby") return <LobbyScreen
    onlineAvailability={state.snapshot.connection === "unavailable" ? "unavailable" : state.snapshot.connection === "connecting" ? "connecting" : "online"}
    waitingRooms={state.snapshot.connection === "unavailable" ? { status: "unavailable", message: "Online hiện không khả dụng." } : { status: "ready", rooms: state.snapshot.waitingRooms ?? [] }}
    onStartLocal={onStartLocal}
    onStartAi={onStartAi}
    onCreateOnline={onCreateOnline}
    onJoinOnline={onJoinOnline}
  />;
  if (state.status === "playing" || state.status === "finished") return <GameScreen session={state.session} snapshot={state.snapshot} onLobby={onLobby} />;
  return <PlaceholderScreen heading="Kết quả" state={state} detail="Màn hình kết quả đang chuẩn bị." />;
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
