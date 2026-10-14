import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PixelSprite } from "./PixelSprite";

describe("PixelSprite", () => {
  afterEach(() => cleanup());

  it.each([
    ["dam", "Đấm"],
    ["rock", "Đấm"],
    ["la", "Lá"],
    ["paper", "Lá"],
    ["keo", "Kéo"],
    ["scissors", "Kéo"],
    ["bot", "Robot"],
    ["trophy", "Cúp"],
    ["flag", "Cờ"],
    ["sun", "Giao diện sáng"],
    ["moon", "Giao diện tối"],
  ] as const)("renders accessible title for kind %s", (kind, defaultTitle) => {
    render(<PixelSprite kind={kind} />);
    expect(screen.getByRole("img", { name: defaultTitle })).toBeInTheDocument();
  });

  it("hides decorative sprite from assistive technology", () => {
    const { container } = render(<PixelSprite kind="bot" decorative />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("supports custom title and aria-label", () => {
    render(<PixelSprite kind="trophy" title="Quán quân giải đấu" />);
    expect(screen.getByRole("img", { name: "Quán quân giải đấu" })).toBeInTheDocument();

    cleanup();
    render(<PixelSprite kind="sun" aria-label="Bật chế độ ban ngày" />);
    expect(screen.getByRole("img", { name: "Bật chế độ ban ngày" })).toBeInTheDocument();
  });

  it("forwards SVG ref and applies crispEdges shape rendering", () => {
    const ref = { current: null as SVGSVGElement | null };
    render(<PixelSprite ref={ref} kind="flag" seat="A" />);
    expect(ref.current).toBeInstanceOf(SVGSVGElement);
    expect(ref.current).toHaveAttribute("shape-rendering", "crispEdges");
    expect(ref.current).toHaveAttribute("viewBox", "0 0 16 16");
  });

  it("renders seat-specific colors preserving A red and B blue", () => {
    const { container: containerA } = render(<PixelSprite kind="flag" seat="A" decorative />);
    const rectsA = containerA.querySelectorAll("rect");
    expect(rectsA.length).toBeGreaterThan(0);
    // Flag cloth has seat A color
    expect(rectsA[1]).toHaveAttribute("fill", "var(--ui-seat-a, #c83232)");

    const { container: containerB } = render(<PixelSprite kind="flag" seat="B" decorative />);
    const rectsB = containerB.querySelectorAll("rect");
    expect(rectsB[1]).toHaveAttribute("fill", "var(--ui-seat-b, #2364aa)");
  });
});
