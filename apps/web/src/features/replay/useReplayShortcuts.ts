import { useEffect } from "react";

export interface ReplayShortcutsOptions {
  readonly onStepPrev?: () => void;
  readonly onStepNext?: () => void;
  readonly onTogglePlay?: () => void;
  readonly onSeekStart?: () => void;
  readonly onSeekEnd?: () => void;
  readonly onFlipPerspective?: () => void;
  readonly onToggleSound?: () => void;
  readonly enabled?: boolean;
}

/**
 * Checks if the event target is an interactive input/editor element
 * where typing should never trigger navigation shortcuts.
 */
export function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }

  if (
    target.isContentEditable ||
    target.contentEditable === "true" ||
    target.getAttribute("contenteditable") === "true" ||
    target.getAttribute("contenteditable") === ""
  ) {
    return true;
  }

  if (target.closest("input, textarea, select, [contenteditable='true'], .monaco-editor, [data-prevent-shortcuts]")) {
    return true;
  }

  return false;
}

export function useReplayShortcuts({
  onStepPrev,
  onStepNext,
  onTogglePlay,
  onSeekStart,
  onSeekEnd,
  onFlipPerspective,
  onToggleSound,
  enabled = true,
}: ReplayShortcutsOptions): void {
  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(event: KeyboardEvent) {
      // Ignore when typing inside input/textarea/select/monaco/contenteditable
      if (isEditableElement(event.target)) {
        return;
      }

      // Ignore any combinations with modifier keys (Ctrl, Alt, Meta, Shift)
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
        return;
      }

      switch (event.key) {
        case "ArrowLeft":
          if (onStepPrev) {
            event.preventDefault();
            onStepPrev();
          }
          break;

        case "ArrowRight":
          if (onStepNext) {
            event.preventDefault();
            onStepNext();
          }
          break;

        case " ":
        case "Spacebar":
          if (event.target instanceof HTMLElement && event.target.closest("button")) {
            return;
          }
          if (onTogglePlay) {
            event.preventDefault();
            onTogglePlay();
          }
          break;

        case "Home":
          if (onSeekStart) {
            event.preventDefault();
            onSeekStart();
          }
          break;

        case "End":
          if (onSeekEnd) {
            event.preventDefault();
            onSeekEnd();
          }
          break;

        case "f":
        case "F":
          if (onFlipPerspective) {
            event.preventDefault();
            onFlipPerspective();
          }
          break;

        case "m":
        case "M":
          if (onToggleSound) {
            event.preventDefault();
            onToggleSound();
          }
          break;

        default:
          break;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    enabled,
    onStepPrev,
    onStepNext,
    onTogglePlay,
    onSeekStart,
    onSeekEnd,
    onFlipPerspective,
    onToggleSound,
  ]);
}
