import type { ChangeEvent } from "react";
import type { DemoScenario } from "../sessions/contract";
import { DEMO_SCENARIOS, isDemoScenario } from "./useDemoScenario";

export interface ScenarioSwitcherProps {
  readonly scenario: DemoScenario;
  readonly onScenarioChange: (scenario: DemoScenario) => void;
}

export function ScenarioSwitcher({ scenario, onScenarioChange }: ScenarioSwitcherProps) {
  if (!import.meta.env.DEV) return null;
  const selected = isDemoScenario(scenario) ? scenario : "lobby-default";
  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.currentTarget.value;
    onScenarioChange(isDemoScenario(value) ? value : "lobby-default");
  };

  return (
    <label>
      Kịch bản demo
      <select aria-label="Kịch bản demo" value={selected} onChange={handleChange}>
        {DEMO_SCENARIOS.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}
