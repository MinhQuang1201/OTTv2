import { forwardRef, useEffect, useId, useRef, type HTMLAttributes, type ReactNode } from "react";
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
  ...props
}: DialogProps, forwardedRef) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div className={styles.dialogBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        {...props}
        ref={forwardedRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : ariaLabel ?? nativeAriaLabel}
        className={[styles.dialog, className].filter(Boolean).join(" ")}
        onKeyDown={(event) => { if (event.key === "Escape") onClose(); props.onKeyDown?.(event); }}
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
