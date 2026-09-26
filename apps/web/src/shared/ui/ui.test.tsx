import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { TextField } from "./TextField";
import { ToastRegion } from "./ToastRegion";
import { useToasts } from "./useToasts";
import mainSource from "../../main.tsx?raw";

describe("shared UI primitives", () => {
  afterEach(() => cleanup());

  it("keeps a disabled button semantically disabled and out of keyboard focus", async () => {
    const user = userEvent.setup();
    render(<Button disabled>Submit move</Button>);

    const button = screen.getByRole("button", { name: "Submit move" });
    expect(button).toBeDisabled();
    await user.tab();
    expect(button).not.toHaveFocus();
  });

  it("loads theme styles in reset, tokens, global order", () => {
    expect(mainSource.indexOf('"./shared/theme/reset.css"')).toBeLessThan(mainSource.indexOf('"./shared/theme/tokens.css"'));
    expect(mainSource.indexOf('"./shared/theme/tokens.css"')).toBeLessThan(mainSource.indexOf('"./shared/theme/global.css"'));
  });

  it("associates the field label and error with the input", () => {
    render(
      <TextField
        label="Room name"
        value=""
        onChange={() => undefined}
        error="Room name is required"
      />,
    );

    const input = screen.getByRole("textbox", { name: "Room name" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Room name is required");
  });

  it("labels the dialog and moves focus into it when opened", async () => {
    render(
      <Dialog open title="Confirm move" onClose={() => undefined}>
        <p>Move this piece?</p>
      </Dialog>,
    );

    const dialog = screen.getByRole("dialog", { name: "Confirm move" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: /close/i })).toHaveFocus();
  });

  it("keeps normal toasts polite and actionable errors assertive", () => {
    render(
      <ToastRegion
        toasts={[
          { id: "normal", message: "Move sent", tone: "info" },
          { id: "error", message: "Connection lost", tone: "error" },
        ]}
        onDismiss={() => undefined}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Move sent");
    expect(screen.getByRole("alert")).toHaveTextContent("Connection lost");
  });

  it("forwards native div props and refs on the toast region", () => {
    const regionRef = { current: null as HTMLDivElement | null };
    render(
      <ToastRegion
        ref={regionRef}
        aria-label="Game notifications"
        data-testid="toast-region"
        style={{ insetInlineEnd: "12px" }}
        toasts={[]}
        onDismiss={() => undefined}
      />,
    );

    expect(screen.getByTestId("toast-region")).toHaveAttribute("aria-label", "Game notifications");
    expect(screen.getByTestId("toast-region")).toHaveStyle({ insetInlineEnd: "12px" });
    expect(regionRef.current).toBe(screen.getByTestId("toast-region"));
  });

  it("preserves a native dialog aria-label when no title or ariaLabel is provided", () => {
    render(
      <Dialog open aria-label="Move confirmation" onClose={() => undefined}>
        <p>Move this piece?</p>
      </Dialog>,
    );

    expect(screen.getByRole("dialog", { name: "Move confirmation" })).toBeInTheDocument();
  });

  it("bounds toast history and removes a toast after its lifetime", () => {
    vi.useFakeTimers();

    function Harness() {
      const { toasts, pushToast } = useToasts({ maxToasts: 2, duration: 2200 });
      useEffect(() => {
        pushToast("First");
        pushToast("Second");
        pushToast("Third");
      }, [pushToast]);
      return <ToastRegion toasts={toasts} onDismiss={() => undefined} />;
    }

    render(<Harness />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Second");
    expect(status).toHaveTextContent("Third");
    expect(screen.queryByText("First")).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2200);
    });
    expect(screen.queryByText("Third")).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});
