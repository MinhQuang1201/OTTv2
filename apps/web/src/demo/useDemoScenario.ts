import { useCallback, useState } from "react";
import type { DemoScenario } from "../sessions/contract";
import { DEMO_SCENARIOS, isDemoScenario } from "../sessions/demo/scenarios";

export const DEFAULT_DEMO_SCENARIO: DemoScenario = "lobby-default";

export function readDemoScenario(search = typeof window === "undefined" ? "" : window.location.search): DemoScenario {
  if (!import.meta.env.DEV) return DEFAULT_DEMO_SCENARIO;
  const value = new URLSearchParams(search).get("demo");
  return isDemoScenario(value) ? value : DEFAULT_DEMO_SCENARIO;
}

export interface DemoScenarioState {
  readonly enabled: boolean;
  readonly scenario: DemoScenario;
  readonly setScenario: (scenario: DemoScenario) => void;
}

export function useDemoScenario(initialScenario?: unknown): DemoScenarioState {
  const enabled = import.meta.env.DEV;
  const [scenario, setScenarioState] = useState<DemoScenario>(() =>
    initialScenario === undefined
      ? readDemoScenario()
      : isDemoScenario(initialScenario) ? initialScenario : DEFAULT_DEMO_SCENARIO,
  );
  const setScenario = useCallback((nextScenario: DemoScenario) => {
    const next = isDemoScenario(nextScenario) ? nextScenario : DEFAULT_DEMO_SCENARIO;
    setScenarioState(next);
    if (enabled && typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("demo", next);
      window.history.replaceState(window.history.state, "", url);
    }
  }, [enabled]);

  return { enabled, scenario, setScenario };
}

export { DEMO_SCENARIOS, isDemoScenario };
