import { cleanup, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScenarioSwitcher } from "./ScenarioSwitcher";
import { readDemoScenario, useDemoScenario } from "./useDemoScenario";

describe("ScenarioSwitcher", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });
  it("publishes a selected demo scenario", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ScenarioSwitcher scenario="lobby-default" onScenarioChange={onChange} />);

    await user.selectOptions(screen.getByRole("combobox", { name: /Kịch bản demo/i }), "result-goal");

    expect(onChange).toHaveBeenCalledWith("result-goal");
  });

  it("does not render an invalid selected scenario", () => {
    render(<ScenarioSwitcher scenario={"unknown" as never} onScenarioChange={vi.fn()} />);

    expect(screen.getByRole("combobox", { name: /Kịch bản demo/i })).toHaveValue("lobby-default");
  });

  it("parses valid development queries and safely falls back for invalid values", () => {
    expect(readDemoScenario("?demo=game-active-a")).toBe("game-active-a");
    expect(readDemoScenario("?demo=not-a-scenario")).toBe("lobby-default");
  });

  it("gates query scenarios when the build is not development", () => {
    vi.stubEnv("DEV", false);

    expect(readDemoScenario("?demo=result-goal")).toBe("lobby-default");
    const { result } = renderHook(() => useDemoScenario());
    expect(result.current.enabled).toBe(false);
    expect(result.current.scenario).toBe("lobby-default");
  });
});
