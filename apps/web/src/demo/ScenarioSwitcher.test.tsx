import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScenarioSwitcher } from "./ScenarioSwitcher";

describe("ScenarioSwitcher", () => {
  afterEach(cleanup);
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
});
