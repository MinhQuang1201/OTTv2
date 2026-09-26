import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("renders the OTTv2 application landmark", () => {
    render(<App />);
    expect(screen.getByRole("main", { name: /OTTv2/i })).toBeInTheDocument();
  });
});
