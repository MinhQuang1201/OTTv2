import { useEffect, useState } from "react";
import type { DemoScenario, GameSession, GameSnapshot, SessionErrorView } from "../sessions/contract";
import { DemoSession } from "../sessions/demo/DemoSession";
import { ScenarioSwitcher } from "../demo/ScenarioSwitcher";
import { DEFAULT_DEMO_SCENARIO, isDemoScenario, useDemoScenario } from "../demo/useDemoScenario";
import { Panel } from "../shared/ui/Panel";
import { Spinner } from "../shared/ui/Spinner";
import { AppProviders } from "./AppProviders";
import { ScreenBoundary } from "./ScreenBoundary";
import styles from "./app.module.css";

export type AppState =
  | { readonly status: "boot" }
  | { readonly status: "lobby"; readonly session: GameSession; readonly snapshot: GameSnapshot; readonly scenario: DemoScenario }
  | { readonly status: "preparing"; readonly session: GameSession; readonly snapshot: GameSnapshot; readonly scenario: DemoScenario }
  | { readonly status: "playing"; readonly session: GameSession; readonly snapshot: GameSnapshot; readonly scenario: DemoScenario }
  | { readonly status: "finished"; readonly session: GameSession; readonly snapshot: GameSnapshot; readonly scenario: DemoScenario }
  | { readonly status: "error"; readonly session: GameSession | null; readonly snapshot: GameSnapshot | null; readonly error: SessionErrorView; readonly scenario: DemoScenario };

export type SessionFactory = (scenario: DemoScenario) => GameSession;

export function createDemoSession(scenario: DemoScenario): GameSession {
  return new DemoSession(isDemoScenario(scenario) ? scenario : DEFAULT_DEMO_SCENARIO);
}

function safeSessionError(error: unknown): SessionErrorView {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const candidate = error as Partial<SessionErrorView>;
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return { code: candidate.code as SessionErrorView["code"], message: candidate.message, retryable: candidate.retryable === true };
    }
  }
  return { code: "session_failed", message: "Không thể hiển thị màn hình này.", retryable: false };
}

function stateForSnapshot(session: GameSession, scenario: DemoScenario, snapshot: GameSnapshot): AppState {
  if (snapshot.error) return { status: "error", session, snapshot, error: snapshot.error, scenario };
  if (snapshot.result || snapshot.phase === "finished" || scenario.startsWith("result-")) return { status: "finished", session, snapshot, scenario };
  if (scenario.startsWith("lobby-")) {
    return snapshot.phase === "preparing"
      ? { status: "preparing", session, snapshot, scenario }
      : { status: "lobby", session, snapshot, scenario };
  }
  if (scenario.startsWith("game-")) return { status: "playing", session, snapshot, scenario };
  return { status: "lobby", session, snapshot, scenario };
}

export interface AppProps {
  readonly initialScenario?: unknown;
  readonly sessionFactory?: SessionFactory;
}

export function App({ initialScenario, sessionFactory = createDemoSession }: AppProps) {
  const demo = useDemoScenario(initialScenario);
  const [restartToken, setRestartToken] = useState(0);
  const [appState, setAppState] = useState<AppState>({ status: "boot" });

  useEffect(() => {
    let active = true;
    let session: GameSession | null = null;
    let unsubscribe: () => void = () => undefined;
    try {
      session = sessionFactory(demo.scenario);
      const publish = () => {
        if (!active || !session) return;
        try {
          setAppState(stateForSnapshot(session, demo.scenario, session.getSnapshot()));
        } catch (error) {
          if (active) setAppState({ status: "error", session, snapshot: null, error: safeSessionError(error), scenario: demo.scenario });
        }
      };
      unsubscribe = session.subscribe(publish);
      publish();
      void session.start({ mode: "demo", scenario: demo.scenario }).catch((error: unknown) => {
        if (active) setAppState({ status: "error", session, snapshot: session?.getSnapshot() ?? null, error: safeSessionError(error), scenario: demo.scenario });
      });
    } catch (error) {
      if (active) setAppState({ status: "error", session, snapshot: null, error: safeSessionError(error), scenario: demo.scenario });
    }
    return () => {
      active = false;
      unsubscribe();
      session?.dispose();
    };
  }, [demo.scenario, restartToken, sessionFactory]);

  const onLobby = () => {
    setRestartToken((value) => value + 1);
    demo.setScenario("lobby-default");
  };
  const onRetry = () => setRestartToken((value) => value + 1);

  return (
    <AppProviders>
      <main className={styles.app} aria-label="OTTv2">
        <header className={styles.header}>
          <p className={styles.brand}>OTTv2</p>
          {demo.enabled ? <div className={styles.demoTools}><ScenarioSwitcher scenario={demo.scenario} onScenarioChange={demo.setScenario} /></div> : null}
        </header>
        <div className={styles.content}>
          <div className={styles.state} data-testid="app-state" data-state={appState.status}>
            <ScreenBoundary error={appState.status === "error" ? appState.error : null} onRetry={onRetry} onLobby={onLobby}>
              <AppScreen state={appState} />
            </ScreenBoundary>
          </div>
        </div>
      </main>
    </AppProviders>
  );
}

function AppScreen({ state }: { readonly state: AppState }) {
  if (state.status === "boot") return <Panel className={styles.screen}><Spinner label="Đang khởi động" /></Panel>;
  if (state.status === "error") return null;
  if (state.status === "preparing") return <PlaceholderScreen heading="Đang chuẩn bị" state={state} detail="Đang kết nối phiên demo." />;
  if (state.status === "lobby") return <PlaceholderScreen heading="Sảnh" state={state} detail="Chọn một phòng hoặc bắt đầu ván mới." />;
  if (state.status === "playing") return <PlaceholderScreen heading="Bàn chơi" state={state} detail="Bàn cờ và điều khiển ván chơi sẽ được Task 7 thay thế." />;
  return <PlaceholderScreen heading="Kết quả" state={state} detail="Màn hình kết quả sẽ được Task 7 thay thế." />;
}

function PlaceholderScreen({ heading, detail, state }: { readonly heading: string; readonly detail: string; readonly state: Exclude<AppState, { status: "boot" } | { status: "error" }> }) {
  return (
    <Panel className={styles.screen}>
      <h1>{heading}</h1>
      <p>{detail} <em>(điểm ghép tạm thời cho Task 6/7)</em></p>
      <dl>
        <dt>Kịch bản</dt><dd>{state.scenario}</dd>
        <dt>Trạng thái phiên</dt><dd>{state.snapshot.phase}</dd>
        <dt>Chế độ</dt><dd>{state.snapshot.mode}</dd>
      </dl>
    </Panel>
  );
}
