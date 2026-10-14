import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "./ThemeToggle";
import { THEME_STORAGE_KEY } from "../theme/theme";

describe("ThemeToggle component", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
  });

  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
  });

  it("renders with accessible action label and reflects active state", () => {
    render(<ThemeToggle theme="light" onToggle={() => undefined} />);
    const button = screen.getByRole("button", { name: /Chuyển sang giao diện tối/i });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-pressed", "false");
  });

  it("reflects dark mode accessible label and pressed attribute", () => {
    render(<ThemeToggle theme="dark" onToggle={() => undefined} />);
    const button = screen.getByRole("button", { name: /Chuyển sang giao diện sáng/i });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("invokes onToggle callback with next theme when controlled", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<ThemeToggle theme="light" onToggle={onToggle} />);

    const button = screen.getByRole("button", { name: /Chuyển sang giao diện tối/i });
    await user.click(button);
    expect(onToggle).toHaveBeenCalledWith("dark");
  });

  it("toggles theme and updates document attributes and localStorage when uncontrolled", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    // Starts light by default
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-label", "Chuyển sang giao diện tối");

    // Click to toggle to dark
    await user.click(button);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(button).toHaveAttribute("aria-label", "Chuyển sang giao diện sáng");

    // Click again to toggle back to light
    await user.click(button);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(button).toHaveAttribute("aria-label", "Chuyển sang giao diện tối");
  });

  it("renders optional text label when showLabel is enabled", () => {
    render(<ThemeToggle theme="light" showLabel onToggle={() => undefined} />);
    expect(screen.getByText("Sáng")).toBeInTheDocument();

    cleanup();
    render(<ThemeToggle theme="dark" showLabel onToggle={() => undefined} />);
    expect(screen.getByText("Tối")).toBeInTheDocument();
  });

  it("renders and toggles safely even when window.localStorage getter throws SecurityError", async () => {
    const user = userEvent.setup();
    const originalProperty = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Storage restricted", "SecurityError");
      },
      configurable: true,
    });

    try {
      expect(() => render(<ThemeToggle />)).not.toThrow();
      const button = screen.getByRole("button", { name: /Chuyển sang giao diện tối/i });
      expect(button).toBeInTheDocument();

      await user.click(button);
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
      expect(button).toHaveAttribute("aria-label", "Chuyển sang giao diện sáng");
    } finally {
      if (originalProperty) {
        Object.defineProperty(window, "localStorage", originalProperty);
      }
    }
  });
});
