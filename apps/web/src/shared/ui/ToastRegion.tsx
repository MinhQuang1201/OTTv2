import { forwardRef, type HTMLAttributes } from "react";
import styles from "./ui.module.css";
import { Button } from "./Button";
import type { Toast } from "./useToasts";

export interface ToastRegionProps extends HTMLAttributes<HTMLDivElement> {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

export const ToastRegion = forwardRef<HTMLDivElement, ToastRegionProps>(function ToastRegion({ toasts, onDismiss, className, "aria-label": ariaLabel = "Notifications", ...props }, ref) {
  const normalToasts = toasts.filter((toast) => toast.tone !== "error");
  const errorToasts = toasts.filter((toast) => toast.tone === "error");
  const renderToast = (toast: Toast) => (
    <div key={toast.id} className={[styles.toast, toast.tone === "error" ? styles.toastError : ""].filter(Boolean).join(" ")}>
      <span className={styles.toastMessage}>{toast.message}</span>
      <Button variant="quiet" onClick={() => onDismiss(toast.id)} aria-label={`Dismiss notification: ${toast.message}`}>
        <span aria-hidden="true">×</span>
      </Button>
    </div>
  );

  return (
    <div {...props} ref={ref} className={[styles.toastRegion, className].filter(Boolean).join(" ")} aria-label={ariaLabel}>
      {normalToasts.length ? <div role="status" aria-live="polite" aria-atomic="false">{normalToasts.map(renderToast)}</div> : null}
      {errorToasts.length ? <div role="alert" aria-live="assertive" aria-atomic="false">{errorToasts.map(renderToast)}</div> : null}
    </div>
  );
});
