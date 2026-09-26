import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PieceIcon } from "./PieceIcon";

describe("PieceIcon", () => {
  afterEach(() => cleanup());

  it.each([
    ["dam", "Đấm"],
    ["la", "Lá"],
    ["keo", "Kéo"],
  ] as const)("exposes the canonical %s label", (type, label) => {
    render(<PieceIcon type={type} />);
    expect(screen.getByRole("img", { name: label })).toBeInTheDocument();
  });

  it("hides a decorative icon from assistive technology", () => {
    const { container } = render(<PieceIcon type="dam" decorative />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("uses a supplied title for a meaningful icon", () => {
    render(<PieceIcon type="keo" title="Kéo piece" />);
    expect(screen.getByRole("img", { name: "Kéo piece" })).toBeInTheDocument();
  });
});
