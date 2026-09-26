import { forwardRef } from "react";
import styles from "./ui.module.css";
import { Button } from "./Button";
import type { Toast } from "./useToasts";

export interface ToastRegionProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
  className?: string;
}

export const ToastRegion = forwardRef<HTMLDivElement, ToastRegionProps>(function ToastRegion({ toasts, onDismiss, className }, ref) {
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
    <div ref={ref} className={[styles.toastRegion, className].filter(Boolean).join(" ")} aria-label="Notifications">
      {normalToasts.length ? <div role="status" aria-live="polite" aria-atomic="false">{normalToasts.map(renderToast)}</div> : null}
      {errorToasts.length ? <div role="alert" aria-live="assertive" aria-atomic="false">{errorToasts.map(renderToast)}</div> : null}
    </div>
  );
});
