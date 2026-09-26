import { forwardRef, useEffect, useId, useImperativeHandle, useRef, type HTMLAttributes, type ReactNode } from "react";
import styles from "./ui.module.css";
import { Button } from "./Button";

export interface DialogProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  open: boolean;
  title?: ReactNode;
  ariaLabel?: string;
  closeLabel?: string;
  onClose: () => void;
  children: ReactNode;
}

export const Dialog = forwardRef<HTMLDivElement, DialogProps>(function Dialog({
  open,
  title,
  ariaLabel,
  closeLabel = "Close dialog",
  onClose,
  children,
  className,
  "aria-label": nativeAriaLabel,
  "aria-labelledby": nativeAriaLabelledBy,
  ...props
}: DialogProps, forwardedRef) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousActiveRef = useRef<HTMLElement | null>(null);

  useImperativeHandle(forwardedRef, () => dialogRef.current as HTMLDivElement, []);

  useEffect(() => {
    if (!open) {
      previousActiveRef.current?.focus();
      previousActiveRef.current = null;
      return;
    }

    previousActiveRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();

    return () => {
      if (previousActiveRef.current?.isConnected && dialogRef.current?.contains(document.activeElement)) {
        previousActiveRef.current.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className={styles.dialogBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        {...props}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : nativeAriaLabelledBy}
        aria-label={title ? undefined : ariaLabel ?? nativeAriaLabel ?? "Dialog"}
        className={[styles.dialog, className].filter(Boolean).join(" ")}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }

          if (event.key === "Tab") {
            const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ) ?? []);
            const activeElement = document.activeElement;
            const currentIndex = focusable.indexOf(activeElement as HTMLElement);

            if (focusable.length === 0) {
              event.preventDefault();
            } else if (event.shiftKey && (currentIndex <= 0 || currentIndex === -1)) {
              event.preventDefault();
              focusable[focusable.length - 1].focus();
            } else if (!event.shiftKey && (currentIndex === focusable.length - 1 || currentIndex === -1)) {
              event.preventDefault();
              focusable[0].focus();
            }
          }

          props.onKeyDown?.(event);
        }}
      >
        <header className={styles.dialogHeader}>
          {title ? <h2 className={styles.dialogTitle} id={titleId}>{title}</h2> : <span />}
          <Button ref={closeRef} className={styles.dialogClose} variant="quiet" onClick={onClose} aria-label={closeLabel}>×</Button>
        </header>
        {children}
      </div>
    </div>
  );
});
