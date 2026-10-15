// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isEditableElement, useReplayShortcuts } from "./useReplayShortcuts";

describe("useReplayShortcuts", () => {
  afterEach(() => {
    cleanup();
  });

  it("identifies editable elements correctly", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const select = document.createElement("select");
    const div = document.createElement("div");
    const editableDiv = document.createElement("div");
    editableDiv.contentEditable = "true";

    const monacoParent = document.createElement("div");
    monacoParent.className = "monaco-editor";
    const monacoChild = document.createElement("span");
    monacoParent.appendChild(monacoChild);

    expect(isEditableElement(input)).toBe(true);
    expect(isEditableElement(textarea)).toBe(true);
    expect(isEditableElement(select)).toBe(true);
    expect(isEditableElement(editableDiv)).toBe(true);
    expect(isEditableElement(monacoChild)).toBe(true);
    expect(isEditableElement(div)).toBe(false);
    expect(isEditableElement(null)).toBe(false);
  });

  it("handles valid keyboard shortcuts", () => {
    const onStepPrev = vi.fn();
    const onStepNext = vi.fn();
    const onTogglePlay = vi.fn();
    const onSeekStart = vi.fn();
    const onSeekEnd = vi.fn();
    const onFlipPerspective = vi.fn();
    const onToggleSound = vi.fn();

    renderHook(() =>
      useReplayShortcuts({
        onStepPrev,
        onStepNext,
        onTogglePlay,
        onSeekStart,
        onSeekEnd,
        onFlipPerspective,
        onToggleSound,
      })
    );

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(onStepPrev).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(onStepNext).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    expect(onTogglePlay).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
    expect(onSeekStart).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));
    expect(onSeekEnd).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f" }));
    expect(onFlipPerspective).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "m" }));
    expect(onToggleSound).toHaveBeenCalledTimes(1);
  });

  it("ignores keyboard shortcuts when modifier keys are pressed", () => {
    const onStepPrev = vi.fn();
    const onStepNext = vi.fn();
    const onTogglePlay = vi.fn();

    renderHook(() =>
      useReplayShortcuts({
        onStepPrev,
        onStepNext,
        onTogglePlay,
        onSeekStart: vi.fn(),
        onSeekEnd: vi.fn(),
      })
    );

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", metaKey: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true }));

    expect(onStepPrev).not.toHaveBeenCalled();
    expect(onStepNext).not.toHaveBeenCalled();
    expect(onTogglePlay).not.toHaveBeenCalled();
  });

  it("ignores keyboard shortcuts when target is an input or editor element", () => {
    const onStepPrev = vi.fn();
    const onTogglePlay = vi.fn();

    renderHook(() =>
      useReplayShortcuts({
        onStepPrev,
        onStepNext: vi.fn(),
        onTogglePlay,
        onSeekStart: vi.fn(),
        onSeekEnd: vi.fn(),
      })
    );

    const input = document.createElement("input");
    document.body.appendChild(input);

    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true });
    input.dispatchEvent(event);

    expect(onTogglePlay).not.toHaveBeenCalled();

    document.body.removeChild(input);
  });

  it("does not hijack Space when focus is on a button element", () => {
    const onTogglePlay = vi.fn();

    renderHook(() =>
      useReplayShortcuts({
        onTogglePlay,
      })
    );

    const button = document.createElement("button");
    document.body.appendChild(button);

    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    button.dispatchEvent(event);

    expect(onTogglePlay).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);

    document.body.removeChild(button);
  });

  it("does not hijack Space when target is a child inside a button element", () => {
    const onTogglePlay = vi.fn();

    renderHook(() =>
      useReplayShortcuts({
        onTogglePlay,
      })
    );

    const button = document.createElement("button");
    const span = document.createElement("span");
    button.appendChild(span);
    document.body.appendChild(button);

    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    span.dispatchEvent(event);

    expect(onTogglePlay).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);

    document.body.removeChild(button);
  });
});
